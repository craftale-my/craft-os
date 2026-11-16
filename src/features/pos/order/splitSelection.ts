// src/features/pos/order/splitSelection.ts
/** Split / Move items (docs/superpowers/specs/2026-11-16-pos-split-bill-design.md §3.2): which units of
 *  a bill's live lines are picked. Pure. The server prices and checks every pick (pos_split_totals);
 *  the client never computes the part's money. */
import type { BillItemRow } from './posApi'

/** One entry of p_items: an order item and how many of its units. */
export interface SplitItem { itemId: string; qty: number }
/** A live line of the bill, as the picker lists it. */
export interface SplitLine { id: string; name: string; mods: string[]; note: string | null; qty: number; amountSen: number }
/** item id → units picked; a line that is not in it has none picked. */
export type Picked = Readonly<Record<string, number>>
/** move_items' answer. */
export interface MoveItemsResult { targetBillId: string; targetBillNo: string; movedUnits: number }

export const SPLIT_ACTION_LABEL = 'Split / Move items'
export const SPLIT_OFFLINE = 'Split needs a connection'
export const MOVE_NEEDS_NO_DISCOUNT = 'Remove the bill discount before moving items'
export const BILL_CHANGED_ITEMS = 'The bill changed. Check the items again.'
/** "2 of 3": a stepper's units picked of the line's units. */
export const ofLabel = (k: number, q: number): string => `${k} of ${q}`
export const movedNotice = (units: number, table: string): string => `Moved ${units} item${units === 1 ? '' : 's'} to ${table}`
/** "Table T5 · Split", "Takeaway 261116-004 · Split". */
export const splitTitle = (title: string): string => `${title} · Split`
/** Split / Move items is offered from two live units up (spec §3.1). */
export const canSplit = (liveUnitCount: number): boolean => liveUnitCount >= 2

/** The live lines in bill order (fetchBillItems already sorts them). */
export function splitLines(items: BillItemRow[]): SplitLine[] {
  return items.filter((i) => i.voided_at === null).map((i) => ({
    id: i.id, name: i.name_snapshot, mods: i.modifiers_snapshot.map((m) => m.name), note: i.note, qty: i.qty,
    amountSen: i.unit_price_sen * i.qty,
  }))
}

export const liveUnits = (lines: SplitLine[]): number => lines.reduce((n, l) => n + l.qty, 0)

/** A line's pick set to qty, kept within 0…the line's qty; an unknown line changes nothing. */
export function setQty(p: Picked, lines: SplitLine[], id: string, qty: number): Picked {
  const line = lines.find((l) => l.id === id)
  if (!line) return p
  const q = Math.max(0, Math.min(line.qty, Math.trunc(qty)))
  const next: Record<string, number> = { ...p }
  if (q === 0) delete next[id]
  else next[id] = q
  return next
}

export const selectAll = (lines: SplitLine[]): Picked => Object.fromEntries(lines.map((l) => [l.id, l.qty]))
export const pickedUnits = (p: Picked): number => Object.values(p).reduce((n, q) => n + q, 0)

/** Every unit of every live line: Pay selected and Move to table then run the whole-bill flows. */
export function everythingSelected(p: Picked, lines: SplitLine[]): boolean {
  return lines.length > 0 && lines.every((l) => (p[l.id] ?? 0) === l.qty)
}

/** p_items for pos_split_totals / checkout_items / move_items: picked lines in bill order. */
export function toSplitItems(p: Picked, lines: SplitLine[]): SplitItem[] {
  return lines.flatMap((l) => ((p[l.id] ?? 0) > 0 ? [{ itemId: l.id, qty: p[l.id] }] : []))
}

/** The pick after the bill was read again: lines that are gone are dropped, a smaller line caps its pick. */
export function prune(p: Picked, lines: SplitLine[]): Picked {
  const out: Record<string, number> = {}
  for (const l of lines) {
    const q = Math.min(p[l.id] ?? 0, l.qty)
    if (q > 0) out[l.id] = q
  }
  return out
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Throws "Unexpected reply from the server" for anything that is not move_items' shape. */
export function parseMoveItemsResult(data: unknown): MoveItemsResult {
  if (!isObj(data) || typeof data.targetBillId !== 'string' || typeof data.targetBillNo !== 'string' || typeof data.movedUnits !== 'number') {
    throw new Error('Unexpected reply from the server')
  }
  return { targetBillId: data.targetBillId, targetBillNo: data.targetBillNo, movedUnits: data.movedUnits }
}
