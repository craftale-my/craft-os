import { describe, it, expect } from 'vitest'
import { matchBranchId, type BranchRow } from './branches'

const BRANCHES: BranchRow[] = [
  { id: 'old-cheras', name: 'Cheras', is_active: false },
  { id: 'cheras', name: 'Cheras', is_active: true },
  { id: 'puchong', name: 'Puchong', is_active: true },
  { id: 'kepong', name: ' Kepong ', is_active: true },
]

describe('matchBranchId', () => {
  it('maps the long staff labels to their branch', () => {
    expect(matchBranchId('Cheras (Taman Connaught)', BRANCHES)).toBe('cheras')
    expect(matchBranchId('Puchong (Bandar Puteri)', BRANCHES)).toBe('puchong')
    expect(matchBranchId('Kepong (Taman Usahawan)', BRANCHES)).toBe('kepong')
  })

  it('accepts the bare branch name, ignoring case', () => {
    expect(matchBranchId('puchong', BRANCHES)).toBe('puchong')
  })

  it('prefers the active row when names repeat', () => {
    expect(matchBranchId('Cheras', BRANCHES)).toBe('cheras')
  })

  it('returns null for Other, empty, and unknown labels', () => {
    expect(matchBranchId('Other', BRANCHES)).toBeNull()
    expect(matchBranchId('', BRANCHES)).toBeNull()
    expect(matchBranchId(null, BRANCHES)).toBeNull()
    expect(matchBranchId('Che', BRANCHES)).toBeNull()
  })
})
