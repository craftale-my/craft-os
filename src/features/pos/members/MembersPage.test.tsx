// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { MemberLedger, MemberPage } from './membersApi'

const h = vi.hoisted(() => ({
  owner: false,
  search: vi.fn(), ledger: vi.fn(), adjust: vi.fn(), del: vi.fn(), settings: vi.fn(), saveSettings: vi.fn(), failures: vi.fn(), resolve: vi.fn(),
}))
vi.mock('../../../shared/lib/permissions', () => ({ useCan: () => ({ can: () => true, isOwner: h.owner }) }))
vi.mock('./membersApi', () => ({
  PAGE_SIZE: 50,
  searchMembers: (q: string, p: number) => h.search(q, p),
  fetchLedger: (id: string) => h.ledger(id),
  adjustPoints: (id: string, n: number, r: string) => h.adjust(id, n, r),
  deleteMember: (id: string) => h.del(id),
  fetchMemberSettings: () => h.settings(),
  saveMemberSettings: (s: unknown) => h.saveSettings(s),
  fetchEarnFailures: () => h.failures(),
  resolveEarnFailure: (id: string) => h.resolve(id),
}))

import MembersPage, { SEARCH_DEBOUNCE_MS } from './MembersPage'

const PAGE: MemberPage = {
  total: 2,
  rows: [
    { id: 'm1', phone: '+60123456789', points: 120, joinedAt: '2026-11-20T02:00:00Z', lastVisitAt: '2026-11-22T10:00:00Z' },
    { id: 'm2', phone: '+601100000201', points: 0, joinedAt: '2026-11-21T02:00:00Z', lastVisitAt: null },
  ],
}
const LEDGER: MemberLedger = {
  member: { ...PAGE.rows[0], deletedAt: null },
  entries: [
    { id: 'e2', at: '2026-11-22T10:00:00Z', kind: 'refund', points: -5, billId: 'b1', billNo: '261122-004', branchName: 'Craft Cafe Cheras', reason: null, staffName: null },
    { id: 'e1', at: '2026-11-22T09:00:00Z', kind: 'earn', points: 125, billId: 'b1', billNo: '261122-004', branchName: 'Craft Cafe Cheras', reason: null, staffName: null },
  ],
}
const SETTINGS = { rate: 1, qrEnabled: true, smsDailyCap: 300, smsSentToday: 4 }

const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
async function openPage() {
  render(<MembersPage />)
  await settle()
}
async function openMember(label = '+60 12-345 6789') {
  fireEvent.click(screen.getByRole('button', { name: label }))
  await settle()
  return screen.getByRole('dialog', { name: `Member ${label}` })
}

beforeEach(() => {
  h.owner = false
  h.search.mockReset().mockResolvedValue(PAGE)
  h.ledger.mockReset().mockResolvedValue(LEDGER)
  h.adjust.mockReset().mockResolvedValue(125)
  h.del.mockReset().mockResolvedValue(undefined)
  h.settings.mockReset().mockResolvedValue(SETTINGS)
  h.saveSettings.mockReset().mockImplementation(async (s: object) => ({ ...SETTINGS, ...s }))
  h.failures.mockReset().mockResolvedValue([])
  h.resolve.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('MembersPage', () => {
  it('loading, then the list: full number, joined, points, last visit', async () => {
    let resolve: (p: MemberPage) => void = () => {}
    h.search.mockReturnValue(new Promise<MemberPage>((r) => { resolve = r }))
    render(<MembersPage />)
    expect(screen.getByText('Loading…')).toBeTruthy()
    await act(async () => { resolve(PAGE) })
    await settle()
    expect(h.search).toHaveBeenCalledWith('', 0)
    const rows = screen.getAllByRole('row')
    expect(within(rows[1]).getByText('+60 12-345 6789')).toBeTruthy()
    expect(rows[1].textContent).toContain('20 Nov 2026')
    expect(rows[1].textContent).toContain('120')
    expect(rows[1].textContent).toContain('22 Nov 2026')
    expect(rows[2].textContent).toContain('—')
    expect(screen.getByText('1–2 of 2')).toBeTruthy()
  })

  it('empty: no members yet; a search with no hit says so', async () => {
    h.search.mockResolvedValue({ total: 0, rows: [] })
    await openPage()
    expect(screen.getByText('No members yet.')).toBeTruthy()
    vi.useFakeTimers()
    fireEvent.change(screen.getByLabelText('Search by phone number'), { target: { value: '99' } })
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    vi.useRealTimers()
    await settle()
    expect(screen.getByText('No member has a number like that.')).toBeTruthy()
  })

  it('the search waits for typing to stop and sends digits only', async () => {
    await openPage()
    vi.useFakeTimers()
    const box = screen.getByLabelText('Search by phone number')
    fireEvent.change(box, { target: { value: '01' } })
    fireEvent.change(box, { target: { value: '012-34' } })
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1) })
    expect(h.search).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(h.search).toHaveBeenLastCalledWith('01234', 0)
    expect(h.search).toHaveBeenCalledTimes(2)
  })

  it('pages 50 at a time', async () => {
    h.search.mockResolvedValue({ total: 120, rows: PAGE.rows })
    await openPage()
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await settle()
    expect(h.search).toHaveBeenLastCalledWith('', 1)
  })

  it('a load error offers Retry', async () => {
    h.search.mockRejectedValueOnce(new Error('You cannot see members.'))
    await openPage()
    expect(screen.getByRole('alert').textContent).toContain('You cannot see members.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(screen.getByText('+60 12-345 6789')).toBeTruthy()
  })

  it('a row opens the ledger: date, outlet, kind, points, bill no., staff', async () => {
    await openPage()
    const panel = await openMember()
    expect(h.ledger).toHaveBeenCalledWith('m1')
    const table = within(panel).getByRole('table', { name: 'Ledger' })
    const rows = within(table).getAllByRole('row')
    expect(rows[1].textContent).toContain('22 Nov 2026, 18:00')
    expect(rows[1].textContent).toContain('Craft Cafe Cheras')
    expect(rows[1].textContent).toContain('Refund')
    expect(rows[1].textContent).toContain('−5')
    expect(rows[2].textContent).toContain('Earned')
    expect(rows[2].textContent).toContain('+125')
    expect(rows[2].textContent).toContain('261122-004')
  })

  it('a manager sees no owner controls', async () => {
    h.failures.mockResolvedValue([{ id: 'f', billId: 'b', billNo: '261122-009', branchName: 'Cheras', error: 'boom', at: '2026-11-22T10:00:00Z' }])
    await openPage()
    const panel = await openMember()
    expect(within(panel).queryByRole('button', { name: 'Adjust points' })).toBeNull()
    expect(within(panel).queryByRole('button', { name: 'Delete member' })).toBeNull()
    expect(screen.queryByText('Earn problems')).toBeNull()
    expect(screen.queryByText('Points per RM 1')).toBeNull()
    expect(h.failures).not.toHaveBeenCalled()
    expect(h.settings).not.toHaveBeenCalled()
  })

  it('the owner: adjust is checked first, then confirmed, then sent', async () => {
    h.owner = true
    await openPage()
    const panel = await openMember()
    const amount = within(panel).getByLabelText('Points (+ or −)')
    const reason = within(panel).getByLabelText('Reason')
    const go = within(panel).getByRole('button', { name: 'Adjust points' })
    fireEvent.click(go)
    expect(within(panel).getByRole('alert').textContent).toBe('Enter a whole number of points, like 20 or -20.')
    fireEvent.change(amount, { target: { value: '0' } })
    fireEvent.click(go)
    expect(within(panel).getByRole('alert').textContent).toBe('Enter a number of points between -100000 and 100000, not 0.')
    fireEvent.change(amount, { target: { value: '5' } })
    fireEvent.click(go)
    expect(within(panel).getByRole('alert').textContent).toBe('A reason is required.')
    expect(h.adjust).not.toHaveBeenCalled()
    fireEvent.change(reason, { target: { value: 'Missed at the counter' } })
    fireEvent.click(go)
    const dialog = screen.getByRole('dialog', { name: 'Adjust points' })
    expect(dialog.textContent).toContain('+5 points for +60 12-345 6789. Reason: Missed at the counter')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adjust points' }))
    await settle()
    expect(h.adjust).toHaveBeenCalledWith('m1', 5, 'Missed at the counter')
    expect(h.ledger).toHaveBeenCalledTimes(2)
  })

  it('the owner: a refused adjust shows the server\'s words', async () => {
    h.owner = true
    h.adjust.mockRejectedValue(new Error('Points cannot go below zero.'))
    await openPage()
    const panel = await openMember()
    fireEvent.change(within(panel).getByLabelText('Points (+ or −)'), { target: { value: '-500' } })
    fireEvent.change(within(panel).getByLabelText('Reason'), { target: { value: 'x' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Adjust points' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Adjust points' })).getByRole('button', { name: 'Adjust points' }))
    await settle()
    expect(within(panel).getByRole('alert').textContent).toBe('Points cannot go below zero.')
  })

  it('the owner: delete asks with the agreed words, then closes the panel and reloads', async () => {
    h.owner = true
    await openPage()
    const panel = await openMember()
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete member' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete this member? Their number is removed; past bills keep their totals.' })
    expect(dialog.textContent).toContain('Delete this member? Their number is removed; past bills keep their totals.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete member' }))
    await settle()
    expect(h.del).toHaveBeenCalledWith('m1')
    expect(screen.queryByRole('dialog', { name: 'Member +60 12-345 6789' })).toBeNull()
    expect(h.search).toHaveBeenCalledTimes(2)
  })

  it('the owner: earn problems at the bottom when there are any, with the hint', async () => {
    h.owner = true
    h.failures.mockResolvedValue([{ id: 'f', billId: 'b', billNo: '261122-009', branchName: 'Cheras', error: 'boom', at: '2026-11-22T10:00:00Z' }])
    await openPage()
    const section = screen.getByRole('region', { name: 'Earn problems' })
    expect(section.textContent).toContain('Use Adjust points to credit these by hand.')
    expect(section.textContent).toContain('261122-009')
    expect(section.textContent).toContain('Cheras')
    expect(section.textContent).toContain('boom')
  })

  it('the owner: Mark done asks first, then the row leaves the list', async () => {
    h.owner = true
    const rows = [
      { id: 'f1', billId: 'b', billNo: '261122-009', branchName: 'Cheras', error: 'boom', at: '2026-11-22T10:00:00Z' },
      { id: 'f2', billId: 'c', billNo: '261122-010', branchName: 'Cheras', error: 'bang', at: '2026-11-22T11:00:00Z' },
    ]
    h.failures.mockResolvedValueOnce(rows).mockResolvedValue([rows[1]])
    await openPage()
    const section = screen.getByRole('region', { name: 'Earn problems' })
    fireEvent.click(within(section).getAllByRole('button', { name: 'Mark done' })[0])
    const dialog = screen.getByRole('dialog', { name: 'Mark this as handled?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(h.resolve).not.toHaveBeenCalled()
    fireEvent.click(within(section).getAllByRole('button', { name: 'Mark done' })[0])
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Mark this as handled?' })).getByRole('button', { name: 'Mark done' }))
    await settle()
    expect(h.resolve).toHaveBeenCalledWith('f1')
    const after = screen.getByRole('region', { name: 'Earn problems' })
    expect(after.textContent).not.toContain('261122-009')
    expect(after.textContent).toContain('261122-010')
  })

  it('the owner: a refused Mark done shows why and keeps the row', async () => {
    h.owner = true
    h.failures.mockResolvedValue([{ id: 'f1', billId: 'b', billNo: '261122-009', branchName: 'Cheras', error: 'boom', at: '2026-11-22T10:00:00Z' }])
    h.resolve.mockRejectedValue(new Error('Only the owner can do this.'))
    await openPage()
    const section = screen.getByRole('region', { name: 'Earn problems' })
    fireEvent.click(within(section).getByRole('button', { name: 'Mark done' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Mark this as handled?' })).getByRole('button', { name: 'Mark done' }))
    await settle()
    expect(within(section).getByRole('alert').textContent).toBe('Only the owner can do this.')
    expect(section.textContent).toContain('261122-009')
  })

  it('a page that comes back empty steps back one page; the pager stays while there are members', async () => {
    h.search.mockImplementation(async (_q: string, p: number) => (p === 0 ? { total: 51, rows: PAGE.rows } : { total: 50, rows: [] }))
    await openPage()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await settle()
    expect(h.search).toHaveBeenCalledWith('', 1)
    expect(h.search).toHaveBeenLastCalledWith('', 0)
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy()
    expect(screen.queryByText('No members yet.')).toBeNull()
  })

  it('a slower answer for an older search never replaces the newer one', async () => {
    await openPage()
    const answers: Record<string, (p: MemberPage) => void> = {}
    h.search.mockImplementation((q: string) => new Promise<MemberPage>((r) => { answers[q] = r }))
    vi.useFakeTimers()
    const box = screen.getByLabelText('Search by phone number')
    fireEvent.change(box, { target: { value: '0123' } })
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    fireEvent.change(box, { target: { value: '0198' } })
    await act(async () => { vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS) })
    vi.useRealTimers()
    await act(async () => { answers['0198']({ total: 1, rows: [{ ...PAGE.rows[1], id: 'new', phone: '+60198000000' }] }) })
    await act(async () => { answers['0123']({ total: 1, rows: [PAGE.rows[0]] }) })
    await settle()
    expect(screen.getByText('+60 19-800 0000')).toBeTruthy()
    expect(screen.queryByText('+60 12-345 6789')).toBeNull()
  })

  it('a tap on the confirm\'s backdrop cancels the confirm and leaves the member panel open', async () => {
    h.owner = true
    await openPage()
    await openMember()
    fireEvent.click(screen.getByRole('button', { name: 'Delete member' }))
    const confirm = screen.getByRole('dialog', { name: 'Delete this member? Their number is removed; past bills keep their totals.' })
    fireEvent.click(confirm.parentElement as HTMLElement)
    expect(screen.queryByRole('dialog', { name: /Delete this member/ })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Member +60 12-345 6789' })).toBeTruthy()
  })

  it('the member panel is not inside the spaced list (its margin pushed the fixed panel down)', async () => {
    await openPage()
    const panel = await openMember()
    let el: HTMLElement | null = panel
    while (el) { expect(el.className ?? '').not.toContain('space-y'); el = el.parentElement }
  })

  it('the owner: the reason stops at 200 characters', async () => {
    h.owner = true
    await openPage()
    const panel = await openMember()
    const reason = within(panel).getByLabelText('Reason') as HTMLInputElement
    expect(reason.maxLength).toBe(200)
    fireEvent.change(within(panel).getByLabelText('Points (+ or −)'), { target: { value: '5' } })
    fireEvent.change(reason, { target: { value: 'x'.repeat(201) } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Adjust points' }))
    expect(within(panel).getByRole('alert').textContent).toBe('Keep the reason to 200 characters.')
    expect(screen.queryByRole('dialog', { name: 'Adjust points' })).toBeNull()
  })

  it('the owner: no earn problems section when the list is empty', async () => {
    h.owner = true
    await openPage()
    expect(screen.queryByRole('region', { name: 'Earn problems' })).toBeNull()
  })

  it('the owner: settings load, are checked, and save with member_settings_set', async () => {
    h.owner = true
    await openPage()
    const section = screen.getByRole('region', { name: 'Member settings' })
    const rate = within(section).getByLabelText('Points per RM 1') as HTMLInputElement
    expect(rate.value).toBe('1')
    expect((within(section).getByRole('switch', { name: 'Members on QR page' }) as HTMLInputElement).checked).toBe(true)
    expect((within(section).getByLabelText('SMS codes per day') as HTMLInputElement).value).toBe('300')
    fireEvent.change(rate, { target: { value: '101' } })
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }))
    expect(within(section).getByRole('alert').textContent).toBe('Points per RM 1 must be a number from 0 to 100.')
    expect(h.saveSettings).not.toHaveBeenCalled()
    fireEvent.change(rate, { target: { value: '2' } })
    fireEvent.click(within(section).getByRole('switch', { name: 'Members on QR page' }))
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }))
    await settle()
    expect(h.saveSettings).toHaveBeenCalledWith({ rate: 2, qrEnabled: false, smsDailyCap: 300 })
    expect(within(section).getByRole('status').textContent).toBe('Saved')
  })
})
