import { describe, expect, it } from 'vitest'
import { addTableAction, friendlyDbMessage, openBillMessage, renameConflict } from './tableAdmin'

const active = [{ id: 'a', label: 'T1' }, { id: 'b', label: 'T2' }]

describe('tableAdmin', () => {
  it('addTableAction', () => {
    expect(addTableAction('T1', active, false)).toBe('exists')
    expect(addTableAction('T9', active, true)).toBe('reactivate')
    expect(addTableAction('T9', active, false)).toBe('insert')
  })
  it('renameConflict', () => {
    expect(renameConflict('T2', 'a', active, false)).toBe('Another table is already called T2.')
    expect(renameConflict('T1', 'a', active, false)).toBeNull()
    expect(renameConflict('T9', 'a', active, true)).toBe('Another table is already called T9.')
    expect(renameConflict('T9', 'a', active, false)).toBeNull()
  })
  it('messages', () => {
    expect(openBillMessage('T3', 'B-12')).toBe('Table T3 has an open bill (B-12) — close it before removing the table.')
    expect(friendlyDbMessage('duplicate key value violates unique constraint "x"')).toBe('That label is already used by another table.')
    expect(friendlyDbMessage('boom')).toBe('boom')
  })
})
