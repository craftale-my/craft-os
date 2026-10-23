import { describe, it, expect } from 'vitest'
import { CAPABILITIES, DEFAULT_SYSTEM_ROLE_CAPS, SYSTEM_ROLES } from './index'

describe('capabilities', () => {
  it('every role has a default for every capability in the matrix', () => {
    for (const role of SYSTEM_ROLES) {
      for (const c of CAPABILITIES) expect(typeof DEFAULT_SYSTEM_ROLE_CAPS[role][c.key], `${role}.${c.key}`).toBe('boolean')
    }
  })

  it('pos_supervise is in the System Roles matrix with its label', () => {
    expect(CAPABILITIES.find((c) => c.key === 'pos_supervise')?.label).toBe('Approve POS voids & refunds')
  })

  it('pos_supervise defaults match has_menu_cap / staff_has_cap in SQL', () => {
    expect(Object.fromEntries(SYSTEM_ROLES.map((r) => [r, DEFAULT_SYSTEM_ROLE_CAPS[r].pos_supervise]))).toEqual({
      owner: true, admin: true, hr: false, manager: true, supervisor: true, staff: false,
    })
  })

  it('manage_menu is in the System Roles matrix as "Edit menu"', () => {
    expect(CAPABILITIES.find((c) => c.key === 'manage_menu')?.label).toBe('Edit menu')
  })

  it('manage_menu defaults match has_menu_cap / staff_has_cap in SQL: owner and admin only', () => {
    expect(Object.fromEntries(SYSTEM_ROLES.map((r) => [r, DEFAULT_SYSTEM_ROLE_CAPS[r].manage_menu]))).toEqual({
      owner: true, admin: true, hr: false, manager: false, supervisor: false, staff: false,
    })
  })
})
