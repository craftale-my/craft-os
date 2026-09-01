// @vitest-environment jsdom
//
// Unit tests for the copy and a11y of the late-reason overlay itself, kept
// separate from HrAttendance.late-reason.test.tsx (which drives it through
// the full clock-in flow) since these are pure rendering concerns of the
// step component in isolation.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { LateReasonStep } from './LateReasonStep'

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
