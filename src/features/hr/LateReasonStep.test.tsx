// @vitest-environment jsdom
//
// Unit tests for the copy and a11y of the late-reason overlay itself, kept
// separate from HrAttendance.late-reason.test.tsx (which drives it through
// the full clock-in flow) since these are pure rendering concerns of the
// step component in isolation.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { LateReasonStep } from './LateReasonStep'
import { LATE_REASON_MAX_LENGTH } from '../../shared/lib/lateReason'

afterEach(() => cleanup())

const noop = () => {}

describe('LateReasonStep copy and accessibility', () => {
  it('does not pluralise a single minute', () => {
    render(
      <LateReasonStep lateMinutes={1} shiftStart="9:30am" thresholdMinutes={15} saving={false} error={null} onSubmit={noop} />
    )
    expect(screen.getByText('You are 1 minute late for your 9:30am shift')).toBeTruthy()
  })

  it('pluralises more than one minute', () => {
    render(
      <LateReasonStep lateMinutes={12} shiftStart="9:30am" thresholdMinutes={15} saving={false} error={null} onSubmit={noop} />
    )
    expect(screen.getByText('You are 12 minutes late for your 9:30am shift')).toBeTruthy()
  })

  it('gives the dialog an accessible name pointing at the heading it already renders', () => {
    render(
      <LateReasonStep lateMinutes={12} shiftStart="9:30am" thresholdMinutes={15} saving={false} error={null} onSubmit={noop} />
    )
    // aria-modal="true" with no name is invisible to a screen reader user
    // deciding which of several open dialogs this is — getByRole with `name`
    // only matches when aria-labelledby correctly resolves to visible text.
    expect(screen.getByRole('dialog', { name: /12 minutes late for your 9:30am shift/i })).toBeTruthy()
  })
})

// attendance_late_reason_length_check rejects anything over 500 chars at the
// database, with a raw Postgres error surfacing on screen and no way to
// retry into success. These pin the client-side guard that keeps that write
// from ever being attempted.
describe('LateReasonStep character limit', () => {
  it('carries a maxLength on the textarea matching the database limit', () => {
    render(
      <LateReasonStep lateMinutes={40} shiftStart="9:30am" thresholdMinutes={15} saving={false} error={null} onSubmit={noop} />
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.maxLength).toBe(LATE_REASON_MAX_LENGTH)
  })

  it('does not let typed text pass the character limit', () => {
    render(
      <LateReasonStep lateMinutes={40} shiftStart="9:30am" thresholdMinutes={15} saving={false} error={null} onSubmit={noop} />
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'a'.repeat(LATE_REASON_MAX_LENGTH + 1) } })
    expect(textarea.value.length).toBe(LATE_REASON_MAX_LENGTH)
    expect(screen.getByText(`${LATE_REASON_MAX_LENGTH}/${LATE_REASON_MAX_LENGTH}`)).toBeTruthy()
  })

  it('shows a running character count as the reason is typed', () => {
    render(
      <LateReasonStep lateMinutes={40} shiftStart="9:30am" thresholdMinutes={15} saving={false} error={null} onSubmit={noop} />
    )
    expect(screen.getByText(`0/${LATE_REASON_MAX_LENGTH}`)).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a'.repeat(20) } })
    expect(screen.getByText(`20/${LATE_REASON_MAX_LENGTH}`)).toBeTruthy()
  })

  it('accepts a reason exactly at the character limit', () => {
    const onSubmit = vi.fn()
    render(
      <LateReasonStep lateMinutes={40} shiftStart="9:30am" thresholdMinutes={15} saving={false} error={null} onSubmit={onSubmit} />
    )
    fireEvent.click(screen.getByText('Traffic jam'))
    const note = 'a'.repeat(LATE_REASON_MAX_LENGTH)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: note } })
    expect(screen.getByText(`${LATE_REASON_MAX_LENGTH}/${LATE_REASON_MAX_LENGTH}`)).toBeTruthy()
    const submit = screen.getByRole('button', { name: /Submit/i })
    expect(submit.hasAttribute('disabled')).toBe(false)
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledWith({ code: 'traffic', note })
  })
})
