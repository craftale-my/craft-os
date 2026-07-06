import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { supabase } from './supabase'
import type { Department, EmploymentType, SystemRole, Capability, SystemRolePermissionRow } from '../types'
import { FALLBACK_DEPARTMENTS, EMPLOYMENT_TYPES, DEFAULT_SYSTEM_ROLE_CAPS, SYSTEM_ROLES } from '../types'

export interface Option { slug: string; name: string }

export type RoleCaps = Record<SystemRole, Partial<Record<Capability, boolean>>>

interface LookupsValue {
  /** All departments incl. inactive (for the Settings management screen). */
  departments: Department[]
  /** Active department options; falls back to the hardcoded list if the table is empty/unavailable. */
  activeDepartments: Option[]
  /** slug → display name (falls back to the slug itself). */
  deptName: (slug: string | null | undefined) => string
  /** Active options plus `currentSlug` if it isn't already active (keeps edit-form selects pre-filled). */
  departmentOptions: (currentSlug?: string | null) => Option[]

  /** All employment types incl. inactive (for the Settings management screen). */
  employmentTypes: EmploymentType[]
  /** Active employment-type names; falls back to the hardcoded list. */
  activeEmploymentTypes: string[]
  /** Active options plus `current` if it isn't already active (keeps edit-form selects pre-filled). */
  employmentTypeOptions: (current?: string | null) => string[]

  /** Effective capability matrix per system role (code defaults merged with Owner's DB overrides). */
  roleCaps: RoleCaps

  loading: boolean
  refresh: () => Promise<void>
}

function buildRoleCaps(rows: SystemRolePermissionRow[]): RoleCaps {
  const byRole = new Map(rows.map(r => [r.system_role, r.permissions ?? {}]))
  const out = {} as RoleCaps
  for (const role of SYSTEM_ROLES) {
    out[role] = { ...DEFAULT_SYSTEM_ROLE_CAPS[role], ...(byRole.get(role) ?? {}) }
  }
  return out
}

const LookupsContext = createContext<LookupsValue | null>(null)

export function LookupsProvider({ children }: { children: ReactNode }) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [employmentTypes, setEmploymentTypes] = useState<EmploymentType[]>([])
  const [roleCaps, setRoleCaps] = useState<RoleCaps>(() => buildRoleCaps([]))
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    // Tolerates the tables not existing yet (pre-migration): data is null → [].
    const [deptRes, empRes, srpRes] = await Promise.all([
      supabase.from('departments').select('*').order('name'),
      supabase.from('employment_types').select('*').order('name'),
      supabase.from('system_role_permissions').select('*'),
    ])
    setDepartments((deptRes.data as Department[]) ?? [])
    setEmploymentTypes((empRes.data as EmploymentType[]) ?? [])
    setRoleCaps(buildRoleCaps((srpRes.data as SystemRolePermissionRow[]) ?? []))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // ── Departments ──
  const activeFromDb: Option[] = departments
    .filter(d => d.status === 'active')
    .map(d => ({ slug: d.slug, name: d.name }))
  const activeDepartments: Option[] = activeFromDb.length ? activeFromDb : FALLBACK_DEPARTMENTS

  const deptName = (slug: string | null | undefined): string => {
    if (!slug) return ''
    const hit = departments.find(d => d.slug === slug) ?? FALLBACK_DEPARTMENTS.find(d => d.slug === slug)
    return hit?.name ?? slug
  }

  const departmentOptions = (currentSlug?: string | null): Option[] => {
    const opts = [...activeDepartments]
    if (currentSlug && !opts.some(o => o.slug === currentSlug)) {
      opts.unshift({ slug: currentSlug, name: deptName(currentSlug) })
    }
    return opts
  }

  // ── Employment types ──
  const activeEmpFromDb = employmentTypes.filter(e => e.status === 'active').map(e => e.name)
  const activeEmploymentTypes: string[] = activeEmpFromDb.length ? activeEmpFromDb : EMPLOYMENT_TYPES

  const employmentTypeOptions = (current?: string | null): string[] => {
    const opts = [...activeEmploymentTypes]
    if (current && !opts.includes(current)) opts.unshift(current)
    return opts
  }

  return (
    <LookupsContext.Provider
      value={{
        departments, activeDepartments, deptName, departmentOptions,
        employmentTypes, activeEmploymentTypes, employmentTypeOptions,
        roleCaps, loading, refresh: load,
      }}
    >
      {children}
    </LookupsContext.Provider>
  )
}

export function useLookups(): LookupsValue {
  const ctx = useContext(LookupsContext)
  if (!ctx) throw new Error('useLookups must be used within LookupsProvider')
  return ctx
}
