-- Run only against a disposable PostgreSQL database:
-- psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-tests/pharmacy-refund-rpc-rollback.sql
-- The outer transaction is rolled back, including the test trigger and fixtures.

BEGIN;

CREATE FUNCTION public.test_pharmacy_refund_rollback_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'INCREASE'
    AND NEW.reason LIKE '%rollback-after-mutation%'
    AND NEW.product_id = nullif(current_setting('test.rpc_fail_product', true), '')::uuid
  THEN
    RAISE EXCEPTION 'TEST_FORCED_ROLLBACK';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER test_pharmacy_refund_rollback
BEFORE INSERT ON public.pharmacy_stock_adjustments
FOR EACH ROW EXECUTE FUNCTION public.test_pharmacy_refund_rollback_trigger();

DO $test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_actor uuid := gen_random_uuid();
  v_first_product uuid := gen_random_uuid();
  v_second_product uuid := gen_random_uuid();
  v_swap uuid;
  v_first_batch uuid;
  v_second_batch uuid;
  v_sale jsonb;
  v_first_quantity integer;
  v_second_quantity integer;
BEGIN
  IF v_first_product > v_second_product THEN
    v_swap := v_first_product;
    v_first_product := v_second_product;
    v_second_product := v_swap;
  END IF;

  INSERT INTO public.tenants (
    id, slug, name, facility_type, is_synthetic, environment, data_classification
  ) VALUES (
    v_tenant, v_tenant::text, 'RPC rollback test pharmacy',
    'pharmacy', true, 'demo', 'synthetic'
  );
  INSERT INTO public.profiles (
    id, email, full_name, first_name, last_name, role, tenant_id, verification_status
  ) VALUES (
    v_actor, v_actor::text || '@rpc.invalid', 'RPC Rollback Test',
    'RPC', 'Rollback', 'pharmacist', v_tenant, 'verified'
  );
  INSERT INTO public.pharmacy_products (
    id, tenant_id, name, sku, price, cost_price, quantity, is_active
  ) VALUES
    (v_first_product, v_tenant, 'Rollback first product', 'RPC-' || v_first_product::text, 1000, 500, 0, true),
    (v_second_product, v_tenant, 'Rollback second product', 'RPC-' || v_second_product::text, 1000, 500, 0, true);

  SELECT (public.receive_pharmacy_stock(
    v_tenant, v_first_product, 'ROLLBACK-A', 10, '2030-12-31', 500,
    v_actor, 'rpc-rollback-a', 1000
  )->>'batch_id')::uuid INTO v_first_batch;
  SELECT (public.receive_pharmacy_stock(
    v_tenant, v_second_product, 'ROLLBACK-B', 10, '2030-12-31', 500,
    v_actor, 'rpc-rollback-b', 1000
  )->>'batch_id')::uuid INTO v_second_batch;

  SELECT public.complete_pharmacy_sale(
    p_tenant_id => v_tenant,
    p_cashier_id => v_actor,
    p_items => jsonb_build_array(
      jsonb_build_object(
        'product_id', v_first_product, 'batch_id', v_first_batch,
        'quantity', 1, 'unit_price', 1000, 'discount_amount', 0
      ),
      jsonb_build_object(
        'product_id', v_second_product, 'batch_id', v_second_batch,
        'quantity', 1, 'unit_price', 1000, 'discount_amount', 0
      )
    ),
    p_payment_method => 'cash',
    p_discount_total => 0,
    p_tax_amount => 0,
    p_confirmed_by => v_actor,
    p_idempotency_key => gen_random_uuid()::text
  ) INTO v_sale;

  PERFORM set_config('test.rpc_fail_product', v_second_product::text, true);
  BEGIN
    PERFORM public.reverse_pharmacy_sale(
      v_tenant, (v_sale->>'sale_id')::uuid, v_actor,
      'rollback-after-mutation', 'active'
    );
    RAISE EXCEPTION 'EXPECTED_FORCED_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'TEST_FORCED_ROLLBACK' THEN
      RAISE;
    END IF;
  END;

  SELECT quantity INTO v_first_quantity
  FROM public.pharmacy_products WHERE id = v_first_product;
  SELECT quantity INTO v_second_quantity
  FROM public.pharmacy_products WHERE id = v_second_product;
  IF v_first_quantity <> 9 OR v_second_quantity <> 9 THEN
    RAISE EXCEPTION 'ROLLBACK_PRODUCT_STOCK_MISMATCH: %, %',
      v_first_quantity, v_second_quantity;
  END IF;
  IF (SELECT quantity FROM public.pharmacy_product_batches WHERE id = v_first_batch) <> 9
    OR (SELECT quantity FROM public.pharmacy_product_batches WHERE id = v_second_batch) <> 9
  THEN
    RAISE EXCEPTION 'ROLLBACK_BATCH_STOCK_MISMATCH';
  END IF;
  IF (SELECT status FROM public.pharmacy_pos_sales WHERE id = (v_sale->>'sale_id')::uuid) <> 'completed'
    OR (SELECT count(*) FROM public.pharmacy_pos_sale_items
        WHERE sale_id = (v_sale->>'sale_id')::uuid AND stock_decremented) <> 2
  THEN
    RAISE EXCEPTION 'ROLLBACK_SALE_STATE_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pharmacy_stock_adjustments
    WHERE tenant_id = v_tenant AND reason LIKE '%rollback-after-mutation%'
  ) OR EXISTS (
    SELECT 1 FROM public.pharmacy_audit_logs
    WHERE tenant_id = v_tenant AND action = 'REFUND_POS_SALE'
      AND entity_id = v_sale->>'sale_id'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_HISTORY_MISMATCH';
  END IF;

  RAISE NOTICE 'PHARMACY_REFUND_ROLLBACK_OK';
END
$test$;

ROLLBACK;
