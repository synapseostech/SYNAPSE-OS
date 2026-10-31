export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          tenant_id: string | null
          is_admin: boolean | null
          full_name: string | null
          first_name: string | null
          last_name: string | null
          email: string | null
          role: string
          created_at: string
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id?: string | null
          is_admin?: boolean | null
          full_name?: string | null
          first_name?: string | null
          last_name?: string | null
          email?: string | null
          role?: string
          created_at?: string
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string | null
          is_admin?: boolean | null
          full_name?: string | null
          first_name?: string | null
          last_name?: string | null
          email?: string | null
          role?: string
          created_at?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_products: {
        Row: {
          id: string
          tenant_id: string
          name: string
          description: string | null
          category: string
          sku: string
          barcode: string | null
          price: number
          cost_price: number
          quantity: number
          reorder_level: number
          unit_of_measure: string
          expiry_date: string | null
          manufacturer: string | null
          batch_number: string | null
          is_active: boolean | null
          strength: string | null
          dosage_form: string | null
          active_ingredient: string | null
          generic_name: string | null
          side_effects: string | null
          storage_instructions: string | null
          regulatory_id: string | null
          requires_prescription: boolean | null
          supplier_id: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          name: string
          description?: string | null
          category: string
          sku: string
          barcode?: string | null
          price: number
          cost_price: number
          quantity?: number
          reorder_level?: number
          unit_of_measure: string
          expiry_date?: string | null
          manufacturer?: string | null
          batch_number?: string | null
          is_active?: boolean | null
          strength?: string | null
          dosage_form?: string | null
          active_ingredient?: string | null
          generic_name?: string | null
          side_effects?: string | null
          storage_instructions?: string | null
          regulatory_id?: string | null
          requires_prescription?: boolean | null
          supplier_id?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          name?: string
          description?: string | null
          category?: string
          sku?: string
          barcode?: string | null
          price?: number
          cost_price?: number
          quantity?: number
          reorder_level?: number
          unit_of_measure?: string
          expiry_date?: string | null
          manufacturer?: string | null
          batch_number?: string | null
          is_active?: boolean | null
          strength?: string | null
          dosage_form?: string | null
          active_ingredient?: string | null
          generic_name?: string | null
          side_effects?: string | null
          storage_instructions?: string | null
          regulatory_id?: string | null
          requires_prescription?: boolean | null
          supplier_id?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_product_packages: {
        Row: {
          id: string
          tenant_id: string
          product_id: string
          name: string
          units_per_package: number
          price: number
          is_default: boolean | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          product_id: string
          name: string
          units_per_package: number
          price: number
          is_default?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          product_id?: string
          name?: string
          units_per_package?: number
          price?: number
          is_default?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_product_batches: {
        Row: {
          id: string
          tenant_id: string
          product_id: string
          batch_number: string
          quantity: number
          initial_quantity: number
          expiry_date: string
          received_date: string | null
          cost_price: number
          selling_price: number | null
          is_active: boolean | null
          notes: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          product_id: string
          batch_number: string
          quantity: number
          initial_quantity: number
          expiry_date: string
          received_date?: string | null
          cost_price: number
          selling_price?: number | null
          is_active?: boolean | null
          notes?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          product_id?: string
          batch_number?: string
          quantity?: number
          initial_quantity?: number
          expiry_date?: string
          received_date?: string | null
          cost_price?: number
          selling_price?: number | null
          is_active?: boolean | null
          notes?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_stock_adjustments: {
        Row: {
          id: string
          tenant_id: string
          product_id: string
          quantity: number
          type: string
          reason: string | null
          previous_qty: number
          new_qty: number
          created_by: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          product_id: string
          quantity: number
          type: string
          reason?: string | null
          previous_qty: number
          new_qty: number
          created_by?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          product_id?: string
          quantity?: number
          type?: string
          reason?: string | null
          previous_qty?: number
          new_qty?: number
          created_by?: string | null
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_transactions: {
        Row: {
          id: string
          tenant_id: string
          transaction_no: string
          customer_id: string | null
          client_name: string | null
          client_phone: string | null
          client_address: string | null
          cashier_id: string
          total_amount: number
          discount: number
          tax: number
          net_amount: number
          payment_method: string
          status: string
          notes: string | null
          is_edited: boolean | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          transaction_no: string
          customer_id?: string | null
          client_name?: string | null
          client_phone?: string | null
          client_address?: string | null
          cashier_id: string
          total_amount: number
          discount?: number
          tax?: number
          net_amount: number
          payment_method: string
          status?: string
          notes?: string | null
          is_edited?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          transaction_no?: string
          customer_id?: string | null
          client_name?: string | null
          client_phone?: string | null
          client_address?: string | null
          cashier_id?: string
          total_amount?: number
          discount?: number
          tax?: number
          net_amount?: number
          payment_method?: string
          status?: string
          notes?: string | null
          is_edited?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_transaction_items: {
        Row: {
          id: string
          tenant_id: string
          transaction_id: string
          product_id: string
          batch_id: string | null
          quantity: number
          unit_price: number
          cost_price: number | null
          total_price: number
          package_name: string | null
          package_quantity: number | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          transaction_id: string
          product_id: string
          batch_id?: string | null
          quantity: number
          unit_price: number
          cost_price?: number | null
          total_price: number
          package_name?: string | null
          package_quantity?: number | null
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          transaction_id?: string
          product_id?: string
          batch_id?: string | null
          quantity?: number
          unit_price?: number
          cost_price?: number | null
          total_price?: number
          package_name?: string | null
          package_quantity?: number | null
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_transaction_edits: {
        Row: {
          id: string
          tenant_id: string
          transaction_id: string
          edited_by: string
          reason: string
          previous_data: Json
          new_data: Json
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          transaction_id: string
          edited_by: string
          reason: string
          previous_data: Json
          new_data: Json
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          transaction_id?: string
          edited_by?: string
          reason?: string
          previous_data?: Json
          new_data?: Json
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_customers: {
        Row: {
          id: string
          tenant_id: string
          email: string | null
          name: string
          phone: string | null
          address: string | null
          password_hash: string | null
          is_active: boolean | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          email?: string | null
          name: string
          phone?: string | null
          address?: string | null
          password_hash?: string | null
          is_active?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          email?: string | null
          name?: string
          phone?: string | null
          address?: string | null
          password_hash?: string | null
          is_active?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_clients: {
        Row: {
          id: string
          tenant_id: string
          name: string
          phone: string | null
          address: string | null
          notes: string | null
          last_visit: string | null
          is_active: boolean | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          name: string
          phone?: string | null
          address?: string | null
          notes?: string | null
          last_visit?: string | null
          is_active?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          name?: string
          phone?: string | null
          address?: string | null
          notes?: string | null
          last_visit?: string | null
          is_active?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_suppliers: {
        Row: {
          id: string
          tenant_id: string
          name: string
          email: string | null
          phone: string | null
          address: string | null
          contact_person: string | null
          notes: string | null
          is_active: boolean | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          name: string
          email?: string | null
          phone?: string | null
          address?: string | null
          contact_person?: string | null
          notes?: string | null
          is_active?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          name?: string
          email?: string | null
          phone?: string | null
          address?: string | null
          contact_person?: string | null
          notes?: string | null
          is_active?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_purchase_orders: {
        Row: {
          id: string
          tenant_id: string
          order_no: string
          supplier_id: string
          total_amount: number
          status: string
          notes: string | null
          expected_date: string | null
          email_sent: boolean | null
          email_sent_at: string | null
          created_by: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          order_no: string
          supplier_id: string
          total_amount: number
          status?: string
          notes?: string | null
          expected_date?: string | null
          email_sent?: boolean | null
          email_sent_at?: string | null
          created_by?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          order_no?: string
          supplier_id?: string
          total_amount?: number
          status?: string
          notes?: string | null
          expected_date?: string | null
          email_sent?: boolean | null
          email_sent_at?: string | null
          created_by?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_purchase_order_items: {
        Row: {
          id: string
          tenant_id: string
          purchase_order_id: string
          product_id: string | null
          product_name: string
          quantity: number
          unit_price: number
          total_price: number
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          purchase_order_id: string
          product_id?: string | null
          product_name: string
          quantity: number
          unit_price: number
          total_price: number
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          purchase_order_id?: string
          product_id?: string | null
          product_name?: string
          quantity?: number
          unit_price?: number
          total_price?: number
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_orders: {
        Row: {
          id: string
          tenant_id: string
          order_no: string
          customer_id: string | null
          order_type: string
          total_amount: number
          status: string
          payment_status: string
          notes: string | null
          delivery_address: string | null
          processed_by: string | null
          claimed_by: string | null
          claimed_at: string | null
          is_online_order: boolean | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          order_no: string
          customer_id?: string | null
          order_type?: string
          total_amount: number
          status?: string
          payment_status?: string
          notes?: string | null
          delivery_address?: string | null
          processed_by?: string | null
          claimed_by?: string | null
          claimed_at?: string | null
          is_online_order?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          order_no?: string
          customer_id?: string | null
          order_type?: string
          total_amount?: number
          status?: string
          payment_status?: string
          notes?: string | null
          delivery_address?: string | null
          processed_by?: string | null
          claimed_by?: string | null
          claimed_at?: string | null
          is_online_order?: boolean | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_order_items: {
        Row: {
          id: string
          tenant_id: string
          order_id: string
          product_id: string | null
          product_name: string
          quantity: number
          unit_price: number
          total_price: number
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          order_id: string
          product_id?: string | null
          product_name: string
          quantity: number
          unit_price: number
          total_price: number
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          order_id?: string
          product_id?: string | null
          product_name?: string
          quantity?: number
          unit_price?: number
          total_price?: number
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_audit_logs: {
        Row: {
          id: string
          tenant_id: string
          profile_id: string
          action: string
          entity: string
          entity_id: string | null
          details: string | null
          ip_address: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          profile_id: string
          action: string
          entity: string
          entity_id?: string | null
          details?: string | null
          ip_address?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          profile_id?: string
          action?: string
          entity?: string
          entity_id?: string | null
          details?: string | null
          ip_address?: string | null
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_inquiries: {
        Row: {
          id: string
          tenant_id: string
          profile_id: string | null
          user_email: string
          user_name: string
          type: string
          subject: string
          message: string
          status: string
          admin_response: string | null
          responded_at: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          profile_id?: string | null
          user_email: string
          user_name: string
          type: string
          subject: string
          message: string
          status?: string
          admin_response?: string | null
          responded_at?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          profile_id?: string | null
          user_email?: string
          user_name?: string
          type?: string
          subject?: string
          message?: string
          status?: string
          admin_response?: string | null
          responded_at?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_notifications: {
        Row: {
          id: string
          tenant_id: string
          profile_id: string
          type: string
          title: string
          message: string
          related_id: string | null
          is_read: boolean | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          profile_id: string
          type: string
          title: string
          message: string
          related_id?: string | null
          is_read?: boolean | null
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          profile_id?: string
          type?: string
          title?: string
          message?: string
          related_id?: string | null
          is_read?: boolean | null
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_settings: {
        Row: {
          id: string
          tenant_id: string
          pharmacy_name: string
          location: string | null
          contact: string | null
          email: string | null
          logo: string | null
          footer_text: string | null
          receipt_header: string | null
          receipt_footer: string | null
          tax_rate: number
          currency: string
          low_stock_threshold: number
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          pharmacy_name: string
          location?: string | null
          contact?: string | null
          email?: string | null
          logo?: string | null
          footer_text?: string | null
          receipt_header?: string | null
          receipt_footer?: string | null
          tax_rate?: number
          currency?: string
          low_stock_threshold?: number
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          pharmacy_name?: string
          location?: string | null
          contact?: string | null
          email?: string | null
          logo?: string | null
          footer_text?: string | null
          receipt_header?: string | null
          receipt_footer?: string | null
          tax_rate?: number
          currency?: string
          low_stock_threshold?: number
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_user_settings: {
        Row: {
          id: string
          tenant_id: string
          profile_id: string
          username: string | null
          pharmacy_role: string
          permissions: string[] | null
          must_change_password: boolean | null
          two_factor_enabled: boolean | null
          two_factor_email: string | null
          is_active: boolean | null
          created_by: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          profile_id: string
          username?: string | null
          pharmacy_role: string
          permissions?: string[] | null
          must_change_password?: boolean | null
          two_factor_enabled?: boolean | null
          two_factor_email?: string | null
          is_active?: boolean | null
          created_by?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          profile_id?: string
          username?: string | null
          pharmacy_role?: string
          permissions?: string[] | null
          must_change_password?: boolean | null
          two_factor_enabled?: boolean | null
          two_factor_email?: string | null
          is_active?: boolean | null
          created_by?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      mfa_enrollments: {
        Row: {
          id: string
          user_id: string | null
          secret: string
          verified: boolean | null
          backup_codes: string[] | null
          created_at: string | null
          last_used_at: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          secret: string
          verified?: boolean | null
          backup_codes?: string[] | null
          created_at?: string | null
          last_used_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          secret?: string
          verified?: boolean | null
          backup_codes?: string[] | null
          created_at?: string | null
          last_used_at?: string | null
        }
        Relationships: []
      }
      pharmacy_credit_ledger: {
        Row: {
          id: string
          tenant_id: string
          customer_id: string | null
          transaction_id: string | null
          amount: number
          type: string
          balance_after: number
          due_date: string | null
          notes: string | null
          created_by: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          customer_id?: string | null
          transaction_id?: string | null
          amount: number
          type: string
          balance_after: number
          due_date?: string | null
          notes?: string | null
          created_by?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          customer_id?: string | null
          transaction_id?: string | null
          amount?: number
          type?: string
          balance_after?: number
          due_date?: string | null
          notes?: string | null
          created_by?: string | null
          created_at?: string | null
        }
        Relationships: []
      }
      refill_reminders: {
        Row: {
          id: string
          tenant_id: string
          customer_id: string | null
          drug_name: string
          last_dispensed: string | null
          refill_due_date: string
          interval_days: number | null
          reminder_sent: boolean | null
          last_reminder_sent_at: string | null
          dispensed: boolean | null
          dispensed_at: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          customer_id?: string | null
          drug_name: string
          last_dispensed?: string | null
          refill_due_date: string
          interval_days?: number | null
          reminder_sent?: boolean | null
          last_reminder_sent_at?: string | null
          dispensed?: boolean | null
          dispensed_at?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          customer_id?: string | null
          drug_name?: string
          last_dispensed?: string | null
          refill_due_date?: string
          interval_days?: number | null
          reminder_sent?: boolean | null
          last_reminder_sent_at?: string | null
          dispensed?: boolean | null
          dispensed_at?: string | null
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_staff_permissions: {
        Row: {
          id: string
          tenant_id: string
          staff_id: string
          can_view_inventory: boolean | null
          can_edit_inventory: boolean | null
          can_process_sales: boolean | null
          can_apply_discounts: boolean | null
          can_access_credit_records: boolean | null
          can_approve_stock_adjustments: boolean | null
          can_access_financial_reports: boolean | null
          can_manage_staff: boolean | null
          can_access_settings: boolean | null
          max_discount_percent: number | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          staff_id: string
          can_view_inventory?: boolean | null
          can_edit_inventory?: boolean | null
          can_process_sales?: boolean | null
          can_apply_discounts?: boolean | null
          can_access_credit_records?: boolean | null
          can_approve_stock_adjustments?: boolean | null
          can_access_financial_reports?: boolean | null
          can_manage_staff?: boolean | null
          can_access_settings?: boolean | null
          max_discount_percent?: number | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          staff_id?: string
          can_view_inventory?: boolean | null
          can_edit_inventory?: boolean | null
          can_process_sales?: boolean | null
          can_apply_discounts?: boolean | null
          can_access_credit_records?: boolean | null
          can_approve_stock_adjustments?: boolean | null
          can_access_financial_reports?: boolean | null
          can_manage_staff?: boolean | null
          can_access_settings?: boolean | null
          max_discount_percent?: number | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      pharmacy_expenses: {
        Row: {
          id: string
          tenant_id: string
          category: string
          description: string
          amount: number
          payment_method: string | null
          receipt_url: string | null
          expense_date: string | null
          recorded_by: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          category: string
          description: string
          amount: number
          payment_method?: string | null
          receipt_url?: string | null
          expense_date?: string | null
          recorded_by?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          category?: string
          description?: string
          amount?: number
          payment_method?: string | null
          receipt_url?: string | null
          expense_date?: string | null
          recorded_by?: string | null
          created_at?: string | null
        }
        Relationships: []
      }
      pharmacy_import_sessions: {
        Row: {
          id: string
          tenant_id: string
          source_system: string | null
          file_name: string | null
          file_url: string | null
          status: string | null
          total_rows: number | null
          matched_rows: number | null
          flagged_rows: number | null
          duplicate_rows: number | null
          ai_mapping: Json | null
          ai_summary: string | null
          confirmed_at: string | null
          completed_at: string | null
          error_message: string | null
          created_by: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          source_system?: string | null
          file_name?: string | null
          file_url?: string | null
          status?: string | null
          total_rows?: number | null
          matched_rows?: number | null
          flagged_rows?: number | null
          duplicate_rows?: number | null
          ai_mapping?: Json | null
          ai_summary?: string | null
          confirmed_at?: string | null
          completed_at?: string | null
          error_message?: string | null
          created_by?: string | null
          created_at?: string | null
        }
        Update: {
          id?: string
          tenant_id?: string
          source_system?: string | null
          file_name?: string | null
          file_url?: string | null
          status?: string | null
          total_rows?: number | null
          matched_rows?: number | null
          flagged_rows?: number | null
          duplicate_rows?: number | null
          ai_mapping?: Json | null
          ai_summary?: string | null
          confirmed_at?: string | null
          completed_at?: string | null
          error_message?: string | null
          created_by?: string | null
          created_at?: string | null
        }
        Relationships: []
      }
      body_register: {
        Row: {
          id: string
          tenant_id: string
          body_ref: string | null
          body_name: string | null
          admission_date: string | null
          referred_from: string | null
          condition_on_arrival: string | null
          storage_bay: string | null
          cause_of_death: string | null
          is_forensic: boolean | null
          post_mortem_done: boolean | null
          post_mortem_notes: string | null
          released: boolean | null
          released_to: string | null
          released_relationship: string | null
          released_date: string | null
          id_document_verified: boolean | null
          police_notified: boolean | null
          notes: string | null
          created_by: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          body_ref?: string | null
          body_name?: string | null
          admission_date?: string | null
          referred_from?: string | null
          condition_on_arrival?: string | null
          storage_bay?: string | null
          cause_of_death?: string | null
          is_forensic?: boolean | null
          post_mortem_done?: boolean | null
          post_mortem_notes?: string | null
          released?: boolean | null
          released_to?: string | null
          released_relationship?: string | null
          released_date?: string | null
          id_document_verified?: boolean | null
          police_notified?: boolean | null
          notes?: string | null
          created_by?: string | null
          created_at?: string | null
        }
        Update: Partial<Database["public"]["Tables"]["body_register"]["Insert"]>
        Relationships: []
      }
      visitor_log: {
        Row: {
          id: string
          tenant_id: string
          visitor_name: string
          national_id: string | null
          host_staff_id: string | null
          host_name: string | null
          purpose: string | null
          vehicle_reg: string | null
          time_in: string | null
          time_out: string | null
          badge_number: string | null
          logged_by: string | null
          notes: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          visitor_name: string
          national_id?: string | null
          host_staff_id?: string | null
          host_name?: string | null
          purpose?: string | null
          vehicle_reg?: string | null
          time_in?: string | null
          time_out?: string | null
          badge_number?: string | null
          logged_by?: string | null
          notes?: string | null
        }
        Update: Partial<Database["public"]["Tables"]["visitor_log"]["Insert"]>
        Relationships: []
      }
      housekeeping_tasks: {
        Row: {
          id: string
          tenant_id: string
          area: string
          task_type: string | null
          task_description: string | null
          assigned_to: string | null
          scheduled_time: string | null
          completed: boolean | null
          completed_at: string | null
          verified_by: string | null
          verification_notes: string | null
          notes: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          area: string
          task_type?: string | null
          task_description?: string | null
          assigned_to?: string | null
          scheduled_time?: string | null
          completed?: boolean | null
          completed_at?: string | null
          verified_by?: string | null
          verification_notes?: string | null
          notes?: string | null
          created_at?: string | null
        }
        Update: Partial<Database["public"]["Tables"]["housekeeping_tasks"]["Insert"]>
        Relationships: []
      }
      partograph_records: {
        Row: {
          id: string
          tenant_id: string
          patient_id: string
          admission_time: string | null
          entries: Json
          delivery_time: string | null
          delivery_type: string | null
          birth_weight_grams: number | null
          apgar_1min: number | null
          apgar_5min: number | null
          complications: string | null
          midwife_id: string | null
          doctor_id: string | null
          created_at: string | null
        }
        Insert: {
          id?: string
          tenant_id: string
          patient_id: string
          admission_time?: string | null
          entries?: Json
          delivery_time?: string | null
          delivery_type?: string | null
          birth_weight_grams?: number | null
          apgar_1min?: number | null
          apgar_5min?: number | null
          complications?: string | null
          midwife_id?: string | null
          doctor_id?: string | null
          created_at?: string | null
        }
        Update: Partial<Database["public"]["Tables"]["partograph_records"]["Insert"]>
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (Database["public"]["Tables"] & Database["public"]["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (Database["public"]["Tables"] &
        Database["public"]["Views"])
    ? (Database["public"]["Tables"] &
        Database["public"]["Views"])[PublicTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
    ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer I
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
    ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
        Update: infer I
      }
      ? I
      : never
    : never
