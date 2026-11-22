import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  reply: { data: null as unknown, error: null as { message: string } | null },
  calls: [] as [string, unknown][],
}))
vi.mock('../../../shared/lib/supabase', () => ({
  supabase: { rpc: (fn: string, args: unknown) => { h.calls.push([fn, args]); return Promise.resolve(h.reply) } },
}))

import { clearBillMember, fetchBillMember, memberLine, pointsWord, setBillMember } from './billMember'

describe('billMember', () => {
  beforeEach(() => { h.reply = { data: null, error: null }; h.calls = [] })

  it('the column line and the points word', () => {
    expect(memberLine('+60123456789')).toBe('Member ••6789')
    expect(pointsWord(1)).toBe('1 point')
    expect(pointsWord(120)).toBe('120 points')
  })
  it('pos_bill_member: null without a member, the member with earned after', async () => {
    expect(await fetchBillMember('b1')).toBeNull()
    expect(h.calls[0]).toEqual(['pos_bill_member', { p_bill_id: 'b1' }])
    h.reply = { data: { memberId: 'm', phone: '+60123456789', phoneMasked: '+60 ••• ••6789', points: 42, earned: 42 }, error: null }
    expect(await fetchBillMember('b1')).toEqual({ memberId: 'm', phone: '+60123456789', points: 42, earned: 42 })
    h.reply = { data: { memberId: 'm', phone: '+60123456789', points: 0, earned: null }, error: null }
    expect((await fetchBillMember('b1'))?.earned).toBeNull()
  })
  it('pos_bill_set_member: isNew comes through; a refusal keeps the server\'s words', async () => {
    h.reply = { data: { memberId: 'm', phone: '+601100000201', phoneMasked: 'x', isNew: true, points: 0 }, error: null }
    expect(await setBillMember('b1', '+601100000201')).toEqual({ memberId: 'm', phone: '+601100000201', points: 0, isNew: true })
    expect(h.calls[0]).toEqual(['pos_bill_set_member', { p_bill_id: 'b1', p_phone: '+601100000201' }])
    h.reply = { data: null, error: { message: 'Enter a Malaysian mobile number, e.g. 012-345 6789.' } }
    await expect(setBillMember('b1', 'x')).rejects.toThrow('Enter a Malaysian mobile number, e.g. 012-345 6789.')
  })
  it('pos_bill_clear_member', async () => {
    await clearBillMember('b1')
    expect(h.calls[0]).toEqual(['pos_bill_clear_member', { p_bill_id: 'b1' }])
  })
})
