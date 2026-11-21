// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ template: vi.fn(), open: vi.fn() }))
vi.mock('../checkout/checkoutApi', () => ({ fetchReasonTemplate: (b: string, a: string) => h.template(b, a) }))
vi.mock('./shiftApi', () => ({ openDrawer: (id: string, reason: string) => h.open(id, reason) }))
import OpenDrawerDialog from './OpenDrawerDialog'

afterEach(cleanup)
beforeEach(() => {
  h.template.mockReset().mockResolvedValue(null)
  h.open.mockReset().mockResolvedValue(undefined)
})
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

describe('OpenDrawerDialog (W4 spec §5)', () => {
  it('offers the three default reasons; a reason is needed', async () => {
    render(<OpenDrawerDialog branchId="br" onClose={() => {}} />)
    for (const r of ['Give change', 'Check the cash', 'Swap a note']) expect(screen.getByRole('button', { name: r })).toBeTruthy()
    await waitFor(() => expect(h.template).toHaveBeenCalledWith('br', 'open_drawer'))
    press('Open drawer')
    expect(await screen.findByText('Choose a reason')).toBeTruthy()
    expect(h.open).not.toHaveBeenCalled()
  })
  it('opens with the chosen reason and says so; Done closes', async () => {
    const onClose = vi.fn()
    render(<OpenDrawerDialog branchId="br" onClose={onClose} />)
    press('Give change')
    press('Open drawer')
    expect(await screen.findByText('Drawer opened.')).toBeTruthy()
    expect(h.open).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/), 'Give change')
    press('Done')
    expect(onClose).toHaveBeenCalled()
  })
  it("the outlet's template replaces the defaults; a typed reason when Other is allowed", async () => {
    h.template.mockResolvedValue({ reasons: ['Float check'], compulsory: true, allowOther: true })
    render(<OpenDrawerDialog branchId="br" onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Float check' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Give change' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Customer asked for coins' } })
    press('Open drawer')
    await waitFor(() => expect(h.open).toHaveBeenCalledWith(expect.any(String), 'Customer asked for coins'))
  })
  it('shows the server refusal', async () => {
    h.open.mockRejectedValue(new Error('Open a shift first.'))
    render(<OpenDrawerDialog branchId="br" onClose={() => {}} />)
    press('Swap a note')
    press('Open drawer')
    expect(await screen.findByText('Open a shift first.')).toBeTruthy()
    expect(screen.queryByText('Drawer opened.')).toBeNull()
  })
  it('a retry after a lost reply sends the same id (the server kicks once)', async () => {
    h.open.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce(undefined)
    render(<OpenDrawerDialog branchId="br" onClose={() => {}} />)
    press('Check the cash')
    press('Open drawer')
    expect(await screen.findByText('Failed to fetch')).toBeTruthy()
    press('Open drawer')
    expect(await screen.findByText('Drawer opened.')).toBeTruthy()
    expect(h.open.mock.calls[1][0]).toBe(h.open.mock.calls[0][0])
  })
})
