// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import MemberSheet, { entryText } from './MemberSheet'
import type { Member } from './useMember'
import type { MemberApi, RequestReason, VerifyReason } from './memberApi'

afterEach(() => { cleanup(); vi.useRealTimers() })

const outMember = (over: Partial<Member> = {}): Member => ({
  status: 'out', me: null, token: null, rate: 1,
  refresh: vi.fn(async () => {}), signIn: vi.fn(async () => null), signOut: vi.fn(async () => {}), forget: vi.fn(), ...over,
})
const inMember = (over: Partial<Member> = {}): Member => outMember({
  status: 'in', token: 'tok',
  me: { phoneMasked: '+60 ••• ••6789', points: 120, rate: 1, entries: [
    { at: '2026-11-22T06:00:00Z', branchName: 'Craft Cafe Cheras', points: 42, kind: 'earn' },
    { at: '2026-11-21T06:00:00Z', branchName: null, points: -5, kind: 'refund' },
  ] }, ...over,
})
type Api = Pick<MemberApi, 'requestCode' | 'verifyCode'>
const api = (over: Partial<Api> = {}): Api => ({
  requestCode: vi.fn(async () => ({ ok: true as const })),
  verifyCode: vi.fn(async () => ({ ok: true as const, token: 'tok' })),
  ...over,
})

const typeNumber = (v: string) => fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: v } })
async function toCodeStep(a: Api, member = outMember()) {
  render(<MemberSheet member={member} api={a} tableToken="TABLETOK" onClose={() => {}} />)
  typeNumber('12-345 6789')
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
  await screen.findByRole('heading', { name: 'Enter the code we sent to +60 12-345 6789' })
}

describe('MemberSheet — the number', () => {
  it('fixed +60, numeric keypad, tel-national, the small print', () => {
    render(<MemberSheet member={outMember()} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Collect points with your phone number' })).toBeTruthy()
    expect(screen.getByText('+60')).toBeTruthy()
    const input = screen.getByLabelText('Phone number')
    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input.getAttribute('autocomplete')).toBe('tel-national')
    expect(screen.getByText('We text you a 6-digit code. We only use your number for your points.')).toBeTruthy()
  })
  it('How we use your number opens the notice inside the sheet', () => {
    render(<MemberSheet member={outMember()} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(screen.queryByRole('note')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'How we use your number' }))
    const note = screen.getByRole('note')
    expect(note.textContent).toContain('We keep your phone number, your points and the visits they came from, the type of device you sign in on, and — for two days — the network address used to ask for a code. We use them only to run your points.')
    expect(note.textContent).toContain('To delete your details, ask our staff.')
    expect(note.textContent).not.toMatch(/@|email/i)
  })
  it('a number that is not a Malaysian mobile is refused without a call', () => {
    const a = api()
    render(<MemberSheet member={outMember()} api={a} tableToken="TABLETOK" onClose={() => {}} />)
    typeNumber('3-1234 5678')
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect(screen.getByRole('alert').textContent).toBe('Enter a Malaysian mobile number, like 012-345 6789.')
    expect(a.requestCode).not.toHaveBeenCalled()
  })
  const requestCases: [RequestReason, string][] = [
    ['invalid_phone', 'Enter a Malaysian mobile number, like 012-345 6789.'],
    ['rate', 'Too many tries. Please ask our staff to add your number.'],
    ['busy', 'Sign-in is busy right now. Please ask our staff to add your number.'],
    ['unavailable', 'Sign-in is not available yet.'],
    ['network', 'No connection. Try again.'],
  ]
  it.each(requestCases)('request refused (%s) shows its copy', async (reason, text) => {
    render(<MemberSheet member={outMember()} api={api({ requestCode: vi.fn(async () => ({ ok: false as const, reason })) })} tableToken="TABLETOK" onClose={() => {}} />)
    typeNumber('012-345 6789')
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect((await screen.findByRole('alert')).textContent).toBe(text)
  })
  it('sends the number in E.164', async () => {
    const a = api()
    await toCodeStep(a)
    expect(a.requestCode).toHaveBeenCalledWith('+60123456789', 'TABLETOK')
  })
})

describe('MemberSheet — the code', () => {
  it('one input drawn as six boxes, one-time-code, submits itself at six digits', async () => {
    const a = api()
    const member = outMember()
    await toCodeStep(a, member)
    const input = screen.getByLabelText('6-digit code')
    expect(document.querySelectorAll('input').length).toBe(1)
    expect(screen.getAllByTestId('code-box').length).toBe(6)
    expect(input.getAttribute('autocomplete')).toBe('one-time-code')
    expect(input.getAttribute('inputmode')).toBe('numeric')
    expect(input.getAttribute('maxlength')).toBeNull()               // a paste arrives whole, then the digits are taken
    fireEvent.change(input, { target: { value: '12345' } })
    expect(a.verifyCode).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '123 456' } })      // a paste with a space
    await waitFor(() => expect(a.verifyCode).toHaveBeenCalledWith('+60123456789', '123456'))
    await waitFor(() => expect(member.signIn).toHaveBeenCalledWith('tok'))
    await screen.findByRole('heading', { name: "You're in!" })
  })
  it.each([
    ['a pasted SMS', 'Craft Cafe: your code is 654321. It expires in 5 minutes.'],
    ['spaces and dashes', ' 65-43 21 '],
    ['full-width digits', '６５４３２１'],
    ['more than six digits', '6543219999'],
  ])('%s: the first six digits are the code', async (_name, pasted) => {
    const a = api()
    await toCodeStep(a)
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: pasted } })
    await waitFor(() => expect(a.verifyCode).toHaveBeenCalledWith('+60123456789', '654321'))
  })
  it('after any verify error the code input has focus', async () => {
    for (const reason of ['wrong', 'expired', 'locked', 'network'] as VerifyReason[]) {
      cleanup()
      await toCodeStep(api({ verifyCode: vi.fn(async () => ({ ok: false as const, reason })) }))
      const input = screen.getByLabelText('6-digit code')
      ;(screen.getByRole('button', { name: 'Change number' }) as HTMLButtonElement).focus()
      fireEvent.change(input, { target: { value: '000000' } })
      await screen.findByRole('alert')
      await waitFor(() => expect(document.activeElement).toBe(input))
    }
  })
  const verifyCases: [VerifyReason, string][] = [
    ['wrong', 'That code is not right. Try again.'],
    ['expired', 'That code has expired. Send a new one.'],
    ['locked', 'Too many wrong tries. Send a new code.'],
    ['unavailable', 'Sign-in is not available yet.'],
    ['network', 'No connection. Try again.'],
  ]
  it.each(verifyCases)('verify refused (%s) shows its copy', async (reason, text) => {
    await toCodeStep(api({ verifyCode: vi.fn(async () => ({ ok: false as const, reason })) }))
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '000000' } })
    expect((await screen.findByRole('alert')).textContent).toBe(text)
  })
  it('Send again waits 60 s, then asks for a new code', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const a = api()
    await toCodeStep(a)
    await act(async () => {})                                       // the countdown's interval starts in an effect
    const again = () => screen.getByRole('button', { name: /Send again/ }) as HTMLButtonElement
    expect(again().disabled).toBe(true)
    expect(again().textContent).toBe('Send again in 60 s')
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(again().textContent).toBe('Send again in 30 s')
    await act(async () => { vi.advanceTimersByTime(30_000) })
    expect(again().disabled).toBe(false)
    expect(again().textContent).toBe('Send again')
    fireEvent.click(again())
    await waitFor(() => expect(a.requestCode).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(again().disabled).toBe(true))
  })
  it('Change number goes back to the number, kept', async () => {
    await toCodeStep(api())
    fireEvent.click(screen.getByRole('button', { name: 'Change number' }))
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('12-345 6789')
  })
})

describe('MemberSheet — signed in', () => {
  it('masked number, balance, last entries, how points work, sign out', () => {
    const member = inMember({ rate: 1 })
    const onClose = vi.fn()
    render(<MemberSheet member={member} api={api()} tableToken="TABLETOK" onClose={onClose} />)
    expect(screen.getByText('+60 ••• ••6789')).toBeTruthy()
    expect(screen.getByText('120 points')).toBeTruthy()
    expect(screen.getByText('22 Nov · Craft Cafe Cheras · +42')).toBeTruthy()
    expect(screen.getByText('21 Nov · −5')).toBeTruthy()
    expect(screen.getByText('How points work: 1 point for every RM 1 you pay.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(member.signOut).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
  it('the rate comes from the server', () => {
    render(<MemberSheet member={inMember({ rate: 2 })} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(screen.getByText('How points work: 2 points for every RM 1 you pay.')).toBeTruthy()
  })
  it('shows at most five entries', () => {
    const e = { at: '2026-11-22T06:00:00Z', branchName: 'X', points: 1, kind: 'earn' }
    render(<MemberSheet member={inMember({ me: { phoneMasked: 'm', points: 7, rate: 1, entries: Array(7).fill(e) } })} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(screen.getByRole('list', { name: 'Last entries' }).children.length).toBe(5)
  })
  it('entry dates are Malaysia days', () => {
    expect(entryText({ at: '2026-11-21T17:30:00Z', branchName: 'Craft Cafe Cheras', points: 3, kind: 'earn' })).toBe('22 Nov · Craft Cafe Cheras · +3')
  })
})

describe('MemberSheet — success copy', () => {
  it("You're in!, the balance only, and when points are added — no claim about whose number the bill goes to", async () => {
    const member = outMember({ signIn: vi.fn(async () => null) })
    const { rerender } = render(<MemberSheet member={member} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    typeNumber('12-345 6789')
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '123456' } })
    await screen.findByRole('heading', { name: "You're in!" })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Loading your points…')
    expect(dialog.textContent).toContain('Order from this table and your points are added when the bill is paid.')
    expect(dialog.textContent).not.toMatch(/go to|••/)
    rerender(<MemberSheet member={inMember({ me: { phoneMasked: 'm', points: 0, rate: 1, entries: [] } })} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(screen.getByText('0 points')).toBeTruthy()
    rerender(<MemberSheet member={inMember()} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(screen.getByText('120 points')).toBeTruthy()
  })
  it('no table token: no call, Sign-in is not available', async () => {
    const a = api()
    render(<MemberSheet member={outMember()} api={a} tableToken={null} onClose={() => {}} />)
    typeNumber('12-345 6789')
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in is not available yet.')
    expect(a.requestCode).not.toHaveBeenCalled()
  })
  it('signed in before the balance is back: Loading your points…', () => {
    render(<MemberSheet member={inMember({ me: null })} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Your points' })).toBeTruthy()
    expect(screen.getByText('Loading your points…')).toBeTruthy()
  })
})

describe('MemberSheet — dialog', () => {
  it('a modal dialog labelled by its title on every step, with a Close button', async () => {
    const a = api({ verifyCode: vi.fn(async () => ({ ok: true as const, token: 'tok' })) })
    render(<MemberSheet member={outMember()} api={a} tableToken="TABLETOK" onClose={() => {}} />)
    const d = () => screen.getByRole('dialog', { name: 'Collect points with your phone number' })
    expect(d().getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    typeNumber('12-345 6789')
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect(await screen.findByRole('dialog', { name: 'Enter the code we sent to +60 12-345 6789' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } })
    expect(await screen.findByRole('dialog', { name: "You're in!" })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    cleanup()
    render(<MemberSheet member={inMember()} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Your points' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })
  it('Escape and ✕ close it', () => {
    const onClose = vi.fn()
    render(<MemberSheet member={outMember()} api={api()} tableToken="TABLETOK" onClose={onClose} />)
    fireEvent.keyDown(screen.getByLabelText('Phone number'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
  it('focus moves in on open and back to the strip button on close', () => {
    const strip = document.createElement('button')
    strip.setAttribute('data-member-button', '')
    document.body.appendChild(strip)
    strip.focus()
    const { unmount } = render(<MemberSheet member={outMember()} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByLabelText('Phone number'))
    unmount()
    expect(document.activeElement).toBe(strip)
    strip.remove()
  })
  it('Tab stays inside the dialog', () => {
    render(<MemberSheet member={inMember()} api={api()} tableToken="TABLETOK" onClose={() => {}} />)
    const buttons = screen.getAllByRole('button')
    const first = buttons[0], last = buttons[buttons.length - 1]
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
  it('the busy text is announced politely', async () => {
    let done: (v: { ok: true }) => void = () => {}
    const a = api({ requestCode: vi.fn(() => new Promise<{ ok: true }>((r) => { done = r })) })
    render(<MemberSheet member={outMember()} api={a} tableToken="TABLETOK" onClose={() => {}} />)
    typeNumber('12-345 6789')
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    const live = document.querySelector('[aria-live="polite"]')!
    await waitFor(() => expect(live.textContent).toBe('Sending…'))
    await act(async () => { done({ ok: true }) })
    expect(live.textContent).toBe('')
  })
})
