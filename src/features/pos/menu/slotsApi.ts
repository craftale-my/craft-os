// src/features/pos/menu/slotsApi.ts
/** M3's server calls (supabase/migration-2026-10-24-pos-slots-photos-fn.sql): the Schedules
 *  page, the product editor's Time slots and Photo sections and the import's photo targets.
 *  Every read is one RPC returning one JSON value (no 1000-row cap); every write validates
 *  everything and answers in the words the page shows. All of them need Edit menu. */
import { supabase } from '../../../shared/lib/supabase'
import type { SlotWindow } from './timeSlots'

/** menu_schedule_list: every schedule. */
export interface ScheduleSummary {
  id: string
  name: string
  sortOrder: number
  windows: SlotWindow[]
  /** products on sale that follow it (add-on items are not counted) */
  productCount: number
  /** every product that follows it, switched-off ones and add-on items too (what a delete unlinks) */
  linkCount: number
}
/** menu_schedule_detail */
export interface ScheduleDetail { id: string; name: string; windows: SlotWindow[]; productIds: string[] }
/** menu_save_schedule. `productIds` left out = links kept (an existing schedule). */
export interface SchedulePayload {
  id: string | null
  name: string
  windows: SlotWindow[]
  productIds?: string[]
}
/** menu_product_extras: the product editor's Photo and Time slots sections. */
export interface ProductExtras { imagePath: string | null; imageUpdatedAt: string | null; scheduleIds: string[] }
/** menu_photo_targets: what the import's Photos step matches files against. */
export interface PhotoTarget {
  id: string
  name: string
  feedmeProductId: string | null
  imagePath: string | null
  isActive: boolean
  isAddon: boolean
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export const fetchSchedules = () => rpc<ScheduleSummary[]>('menu_schedule_list')
export const fetchScheduleDetail = (id: string) => rpc<ScheduleDetail>('menu_schedule_detail', { p_schedule_id: id })
export const saveSchedule = (p: SchedulePayload) => rpc<string>('menu_save_schedule', { p })
export const reorderSchedules = (ids: string[]) => rpc<null>('menu_reorder_schedules', { p_ids: ids })
/** Feedme's Delete: the schedule, its windows and its product links go. */
export const deleteSchedule = (id: string) => rpc<null>('menu_delete_schedule', { p_id: id })
export const fetchProductExtras = (productId: string) => rpc<ProductExtras>('menu_product_extras', { p_product_id: productId })
export const setProductSchedules = (productId: string, scheduleIds: string[]) =>
  rpc<null>('menu_set_product_schedules', { p_product_id: productId, p_schedule_ids: scheduleIds })
export const fetchPhotoTargets = () => rpc<PhotoTarget[]>('menu_photo_targets')
/** Returns the path it replaced (delete that file), or null. */
export const setProductImage = (productId: string, path: string | null) =>
  rpc<string | null>('menu_set_product_image', { p_product_id: productId, p_path: path })
