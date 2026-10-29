// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { OrgPerson } from './orgTree'

const p = (id: string, over: Partial<OrgPerson> = {}): OrgPerson => ({
  id, name: id, nickname: null, avatar: null, rank: 'junior', system_role: 'staff',
  job_title: null, branch: null, department: null, supervisor_id: null, ...over,
})

// Boss (owner) → Mei (manager) → Sam (supervisor) → Eve (junior, the viewer)
// Ula and Una have no supervisor; Ulf reports to Ula.
const ROWS: OrgPerson[] = [
  p('boss', { name: 'Boss', system_role: 'owner', rank: 'manager' }),
  p('mei', { name: 'Mei', rank: 'manager', supervisor_id: 'boss' }),
  p('sam', { name: 'Sam', rank: 'supervisor', supervisor_id: 'mei' }),
  p('eve', { name: 'Eve', supervisor_id: 'sam' }),
  p('ula', { name: 'Ula', rank: 'senior' }),
  p('ulf', { name: 'Ulf', supervisor_id: 'ula' }),
  p('una', { name: 'Una' }),
]

const h = vi.hoisted(() => ({
  me: null as { id: string; rank: string } | null,
  rows: [] as unknown[],
  updates: [] as { staffId: string; supervisorId: string }[],
}))

vi.mock('./api', () => ({
  fetchOrgChart: () => Promise.resolve(h.rows.slice()),
  assignSupervisor: (staffId: string, supervisorId: string) => {
    h.updates.push({ staffId, supervisorId })
    return Promise.resolve({ ok: true })
  },
}))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ staff: h.me }) }))
vi.mock('../../shared/lib/lookups', () => ({ useLookups: () => ({ deptName: (s: string) => s }) }))

const { default: OrgChartPage } = await import('./OrgChart')

function renderPage() {
  return render(<MemoryRouter><OrgChartPage /></MemoryRouter>)
}

beforeEach(() => { h.rows = ROWS; h.updates.length = 0 })
afterEach(cleanup)

describe('OrgChartPage — staff viewer', () => {
  beforeEach(() => { h.me = { id: 'eve', rank: 'junior' } })

  it('shows the viewer their reporting line up to the owner', async () => {
    renderPage()
    const line = await screen.findByRole('list', { name: 'My reporting line' })
    expect(within(line).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'You', 'SamDirect', 'Mei', 'Boss',
    ])
  })

  it('opens the viewer’s own branch and marks their card', async () => {
    renderPage()
    const card = await screen.findByTestId('org-card-eve')
    expect(within(card).getByText('You')).toBeTruthy()
  })

  it('does not show the unassigned banner to non-managers', async () => {
    renderPage()
    await screen.findByTestId('org-card-boss')
    expect(screen.queryByText(/have no supervisor/)).toBeNull()
  })

  it('still shows unconnected people to everyone, below the main tree', async () => {
    renderPage()
    expect(await screen.findByText('Not connected to the owner yet')).toBeTruthy()
    expect(screen.getByTestId('org-card-ula')).toBeTruthy()
  })
})

describe('OrgChartPage — manager viewer', () => {
  beforeEach(() => { h.me = { id: 'mei', rank: 'manager' } })

  it('counts people with no supervisor', async () => {
    renderPage()
    expect(await screen.findByText('2 staff have no supervisor')).toBeTruthy()
  })

  it('assigns a supervisor from the list and excludes self and own reports', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /have no supervisor/ }))
    const select = screen.getByLabelText('Supervisor for Ula') as HTMLSelectElement
    const values = Array.from(select.options).map(o => o.value)
    expect(values).not.toContain('ula')
    expect(values).not.toContain('ulf')
    expect(values).toContain('sam')
    fireEvent.change(select, { target: { value: 'sam' } })
    await waitFor(() => expect(h.updates).toEqual([{ staffId: 'ula', supervisorId: 'sam' }]))
  })
})

describe('OrgChartPage — compact layout', () => {
  // Mei has one report with a team of their own (Sam) and three without
  // (the kitchen crew). Only the people without reports stack.
  const WIDE: OrgPerson[] = [
    p('boss', { name: 'Boss', system_role: 'owner', rank: 'manager' }),
    p('mei', { name: 'Mei', rank: 'manager', supervisor_id: 'boss' }),
    p('sam', { name: 'Sam', rank: 'supervisor', supervisor_id: 'mei' }),
    p('eve', { name: 'Eve', supervisor_id: 'sam' }),
    p('k1', { name: 'Kai', supervisor_id: 'mei' }),
    p('k2', { name: 'Kim', supervisor_id: 'mei' }),
    p('k3', { name: 'Kit', supervisor_id: 'mei' }),
  ]

  beforeEach(() => { h.rows = WIDE; h.me = { id: 'eve', rank: 'junior' } })

  it('stacks reports who have no team of their own into one column', async () => {
    renderPage()
    const stack = await screen.findByTestId('org-stack-mei')
    const ids = within(stack).getAllByTestId(/^org-card-/).map(el => el.dataset.testid)
    expect(ids).toEqual(['org-card-k1', 'org-card-k2', 'org-card-k3'])
  })

  it('keeps reports who lead a team in the branching row, outside the stack', async () => {
    renderPage()
    const stack = await screen.findByTestId('org-stack-mei')
    expect(within(stack).queryByTestId('org-card-sam')).toBeNull()
    expect(screen.getByTestId('org-card-sam')).toBeTruthy()
  })

  it('stacks a supervisor whose reports are all individual staff', async () => {
    renderPage()
    const stack = await screen.findByTestId('org-stack-sam')
    expect(within(stack).getByTestId('org-card-eve')).toBeTruthy()
    expect(within(screen.getByTestId('org-card-eve')).getByText('You')).toBeTruthy()
  })
})
