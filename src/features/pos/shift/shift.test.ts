import { describe, expect, it } from 'vitest'
import {
  approvalNote, cashMoveMayBeRecorded, cashMoveProblem, closeShiftError, countProblem, floatProblem, limitProblem, mytTime,
  openBillsWarning, parseCashMoveResult, parseCloseResult, parseShiftList, parseShiftStatus, printedNote, senToText, shiftLabel,
  staleShiftNote, varianceLabel, type ShiftStatus,
} from './shift'

const open = (openedAt: string, now: string): ShiftStatus => ({
  shift: { id: 's1', openedAt, openedByName: 'Aina', openingFloatSen: 10000 }, openBillCount: 0, lastFloatSen: null, now,
})
const report = { summary: {}, sales: {}, cash: {}, payments: [] }

describe('the shift status banner', () => {
  it('says whether a shift is open, in Malaysia time', () => {
    expect(mytTime('2026-10-24T01:02:00.000Z')).toBe('09:02')
    expect(shiftLabel(open('2026-10-24T01:02:00.000Z', '2026-10-24T05:00:00.000Z'))).toBe('Shift open · since 09:02')
    expect(shiftLabel({ shift: null, openBillCount: 0, lastFloatSen: 10000, now: '2026-10-24T05:00:00.000Z' })).toBe('No shift open')
  })
  it('asks for a close once the shift is open more than 20 hours, by the server clock', () => {
    expect(staleShiftNote(open('2026-10-24T01:00:00.000Z', '2026-10-24T21:00:00.000Z'))).toBeNull()        // exactly 20 h
    expect(staleShiftNote(open('2026-10-24T01:00:00.000Z', '2026-10-24T21:00:01.000Z')))
      .toBe('This shift was opened yesterday — close it')
    expect(staleShiftNote({ shift: null, openBillCount: 0, lastFloatSen: null, now: '2026-10-25T01:00:00.000Z' })).toBeNull()
  })
  it('warns at close when bills are still open', () => {
    expect(openBillsWarning(0)).toBeNull()
    expect(openBillsWarning(1)).toBe('1 bill is still open — it stays open for the next shift')
    expect(openBillsWarning(3)).toBe('3 bills are still open — they stay open for the next shift')
  })
})

describe('amount fields', () => {
  it('takes an opening float and a count from RM 0.00 to RM 100000.00', () => {
    expect(floatProblem('100')).toBeNull()
    expect(floatProblem('0')).toBeNull()
    expect(floatProblem('100000.00')).toBeNull()
    expect(floatProblem('')).toBe('Enter the opening float (RM 0.00 to RM 100000.00)')
    expect(floatProblem('-5')).toBe('Enter the opening float (RM 0.00 to RM 100000.00)')
    expect(floatProblem('100000.01')).toBe('Enter the opening float (RM 0.00 to RM 100000.00)')
    expect(countProblem('139.00')).toBeNull()
    expect(countProblem('12.345')).toBe('Enter the counted cash (RM 0.00 to RM 100000.00)')
    expect(countProblem('200000')).toBe('Enter the counted cash (RM 0.00 to RM 100000.00)')
  })
  it('needs an amount from RM 0.01 to RM 100000.00 and a reason for pay in / pay out', () => {
    expect(cashMoveProblem('15', 'Ice')).toBeNull()
    expect(cashMoveProblem('0', 'Ice')).toBe('Enter the amount (RM 0.01 to RM 100000.00)')
    expect(cashMoveProblem('abc', 'Ice')).toBe('Enter the amount (RM 0.01 to RM 100000.00)')
    expect(cashMoveProblem('100000.01', 'Ice')).toBe('Enter the amount (RM 0.01 to RM 100000.00)')
    expect(cashMoveProblem('15', '  ')).toBe('Enter a reason')
    expect(cashMoveProblem('15', 'x'.repeat(201))).toBe('Reason is too long')
  })
  it('keeps the cash variance limit between RM 0 and RM 10000', () => {
    expect(limitProblem('5.00')).toBeNull()
    expect(limitProblem('0')).toBeNull()
    expect(limitProblem('10000.01')).toBe('Enter a cash variance limit between RM 0.00 and RM 10000.00')
    expect(senToText(500)).toBe('5.00')
  })
  it('names a variance as short, over or exact', () => {
    expect(varianceLabel(-615)).toBe('Short RM 6.15')
    expect(varianceLabel(50)).toBe('Over RM 0.50')
    expect(varianceLabel(0)).toBe('Exact')
    expect(printedNote(false)).toBe('Not printed — no receipt printer set')
  })
  it('says why a supervisor approves: this count, or the first one', () => {
    expect(approvalNote({ varianceSen: -615, limitSen: 500 }))
      .toBe('More than RM 5.00 off: a supervisor approves the difference with a reason. If you miscounted, count again — the approval is still needed.')
    expect(approvalNote({ varianceSen: 0, limitSen: 500 })).toBe('A supervisor still approves, because the first count was more than RM 5.00 off.')
    expect(approvalNote({ varianceSen: 500, limitSen: 500 })).toBe('A supervisor still approves, because the first count was more than RM 5.00 off.')
  })
})

describe('refusals', () => {
  it('points to Shifts when the shift closed under another count', () => {
    expect(closeShiftError('This shift is already closed')).toBe('This shift is already closed — a supervisor can open its Z report under Shifts')
    expect(closeShiftError('Wrong PIN — 4 tries left')).toBe('Wrong PIN — 4 tries left')
  })
  it('keeps a pay in / pay out locked only when something may be recorded under its id', () => {
    expect(cashMoveMayBeRecorded('Failed to fetch')).toBe(true)
    expect(cashMoveMayBeRecorded('This was already recorded as Pay in RM 20.00 — close and reopen to record another')).toBe(true)
    expect(cashMoveMayBeRecorded('Open the shift first')).toBe(false)
    expect(cashMoveMayBeRecorded('Wrong PIN — 4 tries left')).toBe(false)
  })
})

describe('server replies', () => {
  it('reads the shift status, without a shift too', () => {
    expect(parseShiftStatus({ shift: null, openBillCount: 2, lastFloatSen: null, now: 'x' }))
      .toEqual({ shift: null, openBillCount: 2, lastFloatSen: null, now: 'x' })
    expect(parseShiftStatus({ shift: { id: 's', openedAt: 'a', openedByName: 'Aina', openingFloatSen: 5000 }, openBillCount: 0, lastFloatSen: 5000, now: 'n' }).shift)
      .toEqual({ id: 's', openedAt: 'a', openedByName: 'Aina', openingFloatSen: 5000 })
    expect(() => parseShiftStatus({ shift: { id: 's' }, openBillCount: 0, now: 'n' })).toThrow('Unexpected reply from the server')
  })
  it('reads a close: closed, needs approval, or the PIN words', () => {
    expect(parseCloseResult({ ok: true, shiftId: 's', report, printed: false })).toEqual({ kind: 'closed', report, printed: false })
    expect(parseCloseResult({ ok: false, needsApproval: true, expectedSen: 14515, varianceSen: -515, limitSen: 500 }))
      .toEqual({ kind: 'needsApproval', expectedSen: 14515, varianceSen: -515, limitSen: 500 })
    expect(() => parseCloseResult({ ok: false, error: 'Wrong PIN — 4 tries left' })).toThrow('Wrong PIN — 4 tries left')
    expect(() => parseCloseResult({ ok: true, printed: true, report: null })).toThrow('Unexpected reply from the server')
  })
  it('reads a cash move and a resend that does not match', () => {
    expect(parseCashMoveResult({ ok: true, id: 'm', kind: 'pay_out', amountSen: 1500 })).toEqual({ id: 'm', kind: 'pay_out', amountSen: 1500 })
    expect(() => parseCashMoveResult({ ok: false, error: 'This was already recorded as Pay in RM 20.00 — close and reopen to record another' }))
      .toThrow('This was already recorded as Pay in RM 20.00')
  })
  it('reads the list of past shifts', () => {
    const row = { id: 's', openedAt: 'a', closedAt: 'b', openedBy: 'Aina', closedBy: null, nettSen: 7565, varianceSen: -615 }
    expect(parseShiftList([row])).toEqual([row])
    expect(() => parseShiftList({})).toThrow('Unexpected reply from the server')
  })
})
