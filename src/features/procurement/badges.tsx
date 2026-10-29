import { RECIPE_VERSION_STATUS_LABELS } from '../../shared/lib/procurement'
import type { RecipeVersionStatus } from '../../shared/lib/procurement'

/** Amber pill for a receipt (or PO) where more arrived than was outstanding. */
export function OverDeliveredBadge() {
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#B4630920] text-[#B46309] whitespace-nowrap">
      Over-delivered
    </span>
  )
}

/** Blue pill for an internal PO (a transfer from HQ, not a supplier order). */
export function InternalBadge() {
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#2E6E9E20] text-[#2E6E9E] whitespace-nowrap">
      Internal
    </span>
  )
}

/** Small tag for a semi-finished (prep batch) item. */
export function SemiFinishedBadge() {
  return (
    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#7A5C9E20] text-[#6B4F8C] whitespace-nowrap">
      Semi-finished
    </span>
  )
}

/** Pill with a recipe version status (Current / Scheduled / Superseded / …). */
export function RecipeStatusBadge({ status }: { status: RecipeVersionStatus }) {
  const tone = status === 'current'
    ? 'bg-[#3D7A5020] text-[#3D7A50]'
    : status === 'scheduled'
    ? 'bg-[#2E6E9E20] text-[#2E6E9E]'
    : status === 'unverified'
    ? 'bg-[#B4630920] text-[#B46309]'
    : 'bg-[#8B735520] text-[#8B7355]'
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${tone}`}>
      {RECIPE_VERSION_STATUS_LABELS[status]}
    </span>
  )
}

/** Pill with a transfer status label (Awaiting shipment / In transit / …). */
export function TransferStatusBadge({ label }: { label: string }) {
  const tone = label === 'In transit'
    ? 'bg-[#2E6E9E20] text-[#2E6E9E]'
    : label === 'Received with loss'
    ? 'bg-[#9E4A3020] text-[#9E4A30]'
    : label === 'Received'
    ? 'bg-[#3D7A5020] text-[#3D7A50]'
    : 'bg-[#C4813A20] text-[#C4813A]'
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${tone}`}>
      {label}
    </span>
  )
}
