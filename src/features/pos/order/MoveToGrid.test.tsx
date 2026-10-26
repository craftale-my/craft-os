// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import MoveToGrid from './MoveToGrid'
import { TAKEAWAY_NEEDS_OCCUPIED, type MoveTarget } from './moveTargets'

afterEach(cleanup)

const targets: MoveTarget[] = [
  { tableId: 't2', label: 'T2', kind: 'move' },
  { tableId: 't3', label: 'B4', kind: 'merge', intoBillId: 'b3', intoBillNo: '261026-003', totalSen: 10670 },
  { tableId: 't4', label: 'T4', kind: 'refused', reason: TAKEAWAY_NEEDS_OCCUPIED },
]

describe('MoveToGrid', () => {
  it('every table with what it holds; a refused one cannot be tapped', () => {
    const onPick = vi.fn()
    render(<MoveToGrid billNo="261026-001" targets={targets} busy={false} onPick={onPick} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /T2\s*Empty/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /B4\s*RM 106\.70/ }))
    expect(onPick).toHaveBeenCalledWith(targets[1])
    const refused = screen.getByRole('button', { name: /T4/ }) as HTMLButtonElement
    expect(refused.disabled).toBe(true)
    expect(refused.title).toBe(TAKEAWAY_NEEDS_OCCUPIED)
  })

  it('a takeaway bill (no table) is offered as a merge target and can be picked', () => {
    const onPick = vi.fn()
    const takeaway: MoveTarget = { tableId: null, label: 'Takeaway 261026-005', kind: 'merge', intoBillId: 'b5', intoBillNo: '261026-005', totalSen: 2500 }
    render(<MoveToGrid billNo="261026-001" targets={[{ tableId: 't2', label: 'T2', kind: 'move' }, takeaway]} busy={false} onPick={onPick} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Takeaway 261026-005\s*RM 25\.00/ }))
    expect(onPick).toHaveBeenCalledWith(takeaway)
  })
})
