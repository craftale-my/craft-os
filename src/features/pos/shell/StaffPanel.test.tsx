// @vitest-environment jsdom
// The staff panel holds this iPad's one print host and shift bar: closing it must hide them, never
// unmount them (the print host prints browser-route tickets, the shift bar keeps an unsent pay in / out).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'

const life = vi.hoisted(() => ({ mounts: { print: 0, shift: 0 }, unmounts: { print: 0, shift: 0 }, printProps: null as null | Record<string, unknown> }))
vi.mock('../order/PrintHostPanel', () => ({
  default: (props: Record<string, unknown>) => {
    life.printProps = props
    useEffect(() => { life.mounts.print++; return () => { life.unmounts.print++ } }, [])
    return <div data-testid="print-host" />
  },
}))
vi.mock('../shift/ShiftBar', () => ({
  default: () => {
    useEffect(() => { life.mounts.shift++; return () => { life.unmounts.shift++ } }, [])
    return <div data-testid="shift-bar" />
  },
}))

import StaffPanel from './StaffPanel'

beforeEach(() => { life.mounts = { print: 0, shift: 0 }; life.unmounts = { print: 0, shift: 0 }; life.printProps = null })
afterEach(cleanup)

const panel = (open: boolean, onExit = vi.fn(), onPrintProblems = vi.fn()) => (
  <StaffPanel open={open} branchId="br" branchName="Craft Cafe" staffName="Aina" refreshKey={0} liveStatus="live"
    canSupervise={false} prints onShiftChanged={() => {}} onMyPin={() => {}} onClose={() => {}}
    signOff={{ label: 'Exit POS', onClick: onExit }} onPrintProblems={onPrintProblems} />
)

describe('StaffPanel', () => {
  it('closed, it still renders the shift bar and the print host; opening and closing never unmounts them', () => {
    const { rerender } = render(panel(false))
    expect(screen.getByTestId('shift-bar')).toBeTruthy()
    expect(screen.getByTestId('print-host')).toBeTruthy()
    rerender(panel(true))
    rerender(panel(false))
    rerender(panel(true))
    expect(life.mounts).toEqual({ print: 1, shift: 1 })
    expect(life.unmounts).toEqual({ print: 0, shift: 0 })
  })

  it('the print host is inline and reports its problem count up', () => {
    const onPrintProblems = vi.fn()
    render(panel(true, vi.fn(), onPrintProblems))
    expect(life.printProps?.inline).toBe(true)
    ;(life.printProps?.onProblems as (n: number) => void)(2)
    expect(onPrintProblems).toHaveBeenCalledWith(2)
  })

  it('Exit POS goes through onExit (the drafts guard), not a link, and does not say Logout', () => {
    const onExit = vi.fn()
    render(panel(true, onExit))
    expect(screen.queryByText('Logout')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Exit POS' }))
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('on a tablet that does not print: no print host, a note instead', () => {
    render(<StaffPanel open branchId="br" branchName="Craft Cafe" staffName="Aina" refreshKey={0} liveStatus="live"
      canSupervise={false} prints={false} onShiftChanged={() => {}} onClose={() => {}}
      signOff={{ label: 'Lock', onClick: () => {} }} onPrintProblems={() => {}} />)
    expect(screen.queryByTestId('print-host')).toBeNull()
    expect(screen.getByText(/This tablet does not print/)).toBeTruthy()
  })

  it('the POS app: Lock and Unpair this device, no My PIN', () => {
    const onLock = vi.fn()
    const onUnpair = vi.fn()
    render(<StaffPanel open branchId="br" branchName="Craft Cafe" staffName="Aina" refreshKey={0} liveStatus="live"
      canSupervise prints onShiftChanged={() => {}} onClose={() => {}}
      signOff={{ label: 'Lock', onClick: onLock }} onUnpair={onUnpair} onPrintProblems={() => {}} />)
    expect(screen.queryByRole('button', { name: 'My PIN' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Exit POS' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unpair this device' }))
    expect(onLock).toHaveBeenCalledTimes(1)
    expect(onUnpair).toHaveBeenCalledTimes(1)
  })
})
