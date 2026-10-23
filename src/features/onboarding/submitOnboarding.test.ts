import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  order: [] as string[],
  saveStaffPrivate: vi.fn(),
  staffUpdate: vi.fn(),
  staffResult: { data: [{ id: 'u1' }], error: null as { message: string } | null },
}))

vi.mock('../staff/privateApi', () => ({
  saveStaffPrivate: (...a: unknown[]) => { h.order.push('private'); return h.saveStaffPrivate(...a) },
}))

vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => {
        h.order.push(table); h.staffUpdate(payload)
        const q = { eq: () => q, select: () => Promise.resolve(h.staffResult) }
        return q
      },
    }),
  },
}))

const { submitOnboarding } = await import('./submitOnboarding')

const FORM = {
  branch: 'Cheras', department: 'barista', employmentType: 'full_time', nickname: '',
  fullName: 'Ali Bin Abu', icNumber: '900101-14-5555', address: '1 Jalan Test', gender: 'Male',
  dateOfBirth: '1990-01-01', contactNumber: '012-3456789', workingExperience: 'None', education: 'SPM',
}

beforeEach(() => {
  h.order.length = 0
  h.saveStaffPrivate.mockReset().mockResolvedValue(undefined)
  h.staffUpdate.mockReset()
  h.staffResult = { data: [{ id: 'u1' }], error: null }
})

describe('submitOnboarding', () => {
  it('writes the private row first, then staff', async () => {
    await submitOnboarding('u1', FORM)
    expect(h.order).toEqual(['private', 'staff'])
    expect(h.saveStaffPrivate).toHaveBeenCalledWith('u1', {
      ic_number: '900101-14-5555', address: '1 Jalan Test',
      date_of_birth: '1990-01-01', contact_number: '012-3456789',
    })
  })

  it('never sends private fields to staff, and marks onboarding complete', async () => {
    await submitOnboarding('u1', FORM)
    const payload = h.staffUpdate.mock.calls[0][0] as Record<string, unknown>
    for (const k of ['ic_number', 'address', 'date_of_birth', 'contact_number']) {
      expect(payload).not.toHaveProperty(k)
    }
    expect(payload).toMatchObject({ name: 'Ali Bin Abu', onboarding_completed: true })
  })

  it('does not mark onboarding complete when the private write fails', async () => {
    h.saveStaffPrivate.mockRejectedValue(new Error('Personal details were not saved: x'))
    await expect(submitOnboarding('u1', FORM)).rejects.toThrow('Personal details were not saved')
    expect(h.staffUpdate).not.toHaveBeenCalled()
  })

  it('throws when the staff write is filtered out', async () => {
    h.staffResult = { data: [], error: null }
    await expect(submitOnboarding('u1', FORM)).rejects.toThrow()
  })
})
