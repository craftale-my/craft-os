// src/features/pos/order/PosPage.tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { useCan } from '../../../shared/lib/permissions'
import { fetchBranchName } from './posApi'
import PosTill from './PosTill'

/** /pos in Craft OS: the till on the staff login's home branch. It stays until the POS app
 *  replaces it (Sub-plan C3 turns this route into a notice). */
export default function PosPage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const navigate = useNavigate()
  const branchId = staff?.branch_id ?? null
  const [branchName, setBranchName] = useState<string | null>(null)
  useEffect(() => {
    if (branchId) fetchBranchName(branchId).then(setBranchName, () => setBranchName(null))
  }, [branchId])

  if (!staff) return null
  if (!branchId) {
    return <div className="p-8 text-center">Your account has no branch — ask a manager to set it in Team.</div>
  }
  return (
    <PosTill branchId={branchId} branchName={branchName ?? staff.branch ?? 'Branch'} staffId={null} staffName={staff.name}
      can={{ manageMenu: can('manage_menu'), supervise: can('pos_supervise'), settings: can('access_settings') }}
      prints locked={false} myPin onBackOffice={(path) => navigate(path)} onExit={() => navigate('/profile')} />
  )
}
