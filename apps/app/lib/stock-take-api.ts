import { apiRequest } from './api'
import type { StockTakeItem, StockTakeView, UploadResult } from './stock-take'
import type { CountEntryInput, ReviewProductLine, StockTakeReviewTotals } from '../../../packages/db/src/stock-take'

export type { ReviewProductLine, StockTakeReviewTotals }

const BASE = '/api/mobile/pharmacy/stock-takes'

export function fetchStockTakes(token: string) {
  return apiRequest<{ open: StockTakeView | null; stockTakes: StockTakeView[]; canManage: boolean }>(BASE, {
    token,
  })
}

export function openStockTake(
  token: string,
  body: { title?: string; scope: 'all' | 'category'; categories?: string[]; blind: boolean; notes?: string },
) {
  return apiRequest<{ stockTake: StockTakeView }>(BASE, { method: 'POST', token, body })
}

export function fetchStockTake(token: string, id: string) {
  return apiRequest<{
    stockTake: StockTakeView
    progress: {
      productsCounted: number
      myProductsCounted: number
      counters: Array<{ profileId: string; products: number; isMe: boolean }>
    }
  }>(`${BASE}/${id}`, { token })
}

export function changeStockTake(token: string, id: string, action: 'close' | 'reopen' | 'cancel') {
  return apiRequest<{ stockTake: StockTakeView }>(`${BASE}/${id}`, {
    method: 'PATCH',
    token,
    body: { action },
  })
}

export function fetchStockTakeItems(token: string, id: string) {
  // A full-store sheet after a Tally import is a couple of thousand items.
  return apiRequest<{ stockTake: StockTakeView; capturedAt: string; items: StockTakeItem[] }>(
    `${BASE}/${id}/items`,
    { token, timeoutMs: 90_000 },
  )
}

export function uploadStockTakeCounts(token: string, id: string, deviceId: string, entries: CountEntryInput[]) {
  return apiRequest<{ ok: boolean; results: UploadResult[] }>(`${BASE}/${id}/counts`, {
    method: 'POST',
    token,
    body: { deviceId, entries },
  })
}

export function fetchStockTakeReview(token: string, id: string) {
  return apiRequest<{
    stockTake: StockTakeView
    totals: StockTakeReviewTotals
    lines: ReviewProductLine[]
    counters: Record<string, string>
  }>(`${BASE}/${id}/review`, { token, timeoutMs: 90_000 })
}

export function setStockTakeRecount(
  token: string,
  id: string,
  body: { productId: string; batchKey: string; overrideQty: number | null; reason?: string },
) {
  return apiRequest<{ ok: boolean }>(`${BASE}/${id}/review`, { method: 'PUT', token, body })
}

export function postStockTake(token: string, id: string) {
  return apiRequest<{ ok: boolean; replay: boolean; summary: Record<string, unknown> }>(`${BASE}/${id}/post`, {
    method: 'POST',
    token,
    timeoutMs: 120_000,
  })
}
