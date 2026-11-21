import { useState, useEffect } from 'react'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { seesAllBranches } from '../../shared/lib/procurement'
import type { Branch } from '../../shared/types'

/**
 * Active branches and the selected one, by the Wastage rule: managers choose
 * (defaulting to their own branch), everyone else is fixed to theirs.
 * `initial` (e.g. a ?branch= param) wins for managers when it is active.
 */
export function useBranchPicker(initial?: string | null) {
  const { staff } = useAuth()
  // Procurement follows the DB branch rule, not the All Branches capability.
  const allBranches = seesAllBranches(staff)

  const [branches, setBranches] = useState<Branch[]>([])
  const [branchId, setBranchId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data, error: err } = await supabase
        .from('branches').select('*').eq('is_active', true).order('name')
      if (cancelled) return
      if (err) setError(err.message)
      const active = (data as Branch[]) ?? []
      setBranches(active)
      if (allBranches) {
        const pick = active.find(b => b.id === initial) ?? active.find(b => b.id === staff?.branch_id)
        setBranchId(pick?.id ?? active[0]?.id ?? '')
      } else {
        setBranchId(staff?.branch_id ?? '')
      }
      setLoaded(true)
    }
    load()
    return () => { cancelled = true }
  }, [allBranches, staff?.branch_id, initial])

  return {
    branches,
    branchId,
    setBranchId,
    allBranches,
    loaded,
    error,
    branchName: (id: string) => branches.find(b => b.id === id)?.name ?? 'Unknown branch',
    /** A supervisor whose account has no branch can't see or produce anything. */
    staffHasNoBranch: !allBranches && !staff?.branch_id,
  }
}
