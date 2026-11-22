// @vitest-environment jsdom
/** QrApp with members: the bill is linked after this phone's send, with its guest id, and a link that
 *  fails leaves the Order details view alone. The server is faked at the client. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => {
  const server = { sent: false }
  const menu = {
    tableLabel: 'T1', paused: false, needsPax: false, ordersOpenAt: null, lastOrderAt: null,
    categories: [{ name: 'Coffee', products: [{ id: 'latte', name: 'Latte', description: null, soldOut: false, imagePath: null,
      variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }], groups: [] }] }],
  }
  const line = { id: 'l1', guestId: '11111111-1111-4111-8111-111111111111', guestLabel: 'Eric', guestAvatar: 'a1',
    productId: 'latte', variantId: 'hot', qty: 1, note: null, optionIds: [] }
  const rpc = async (fn: string) => {
    switch (fn) {
      case 'qr_menu': return { data: menu, error: null }
      case 'qr_picks': return { data: null, error: null }
      case 'qr_cart_state': return { data: server.sent ? { version: 'v2', lines: [], lastOrder: 'o1' } : { version: 'v1', lines: [line], lastOrder: null }, error: null }
      case 'qr_cart_send': server.sent = true; return { data: { status: 'sent' }, error: null }
      case 'qr_table_state': return { data: server.sent
        ? { tableLabel: 'T1', billNo: 'B12', pax: null, subtotalSen: 900, items: [{ name: 'Latte', qty: 1, unitPriceSen: 900, mods: [], note: null, voided: false }] }
        : { tableLabel: 'T1', billNo: null, pax: null, subtotalSen: 0, items: [] }, error: null }
      default: return { data: null, error: null }
    }
  }
  const channel = { on: () => channel, subscribe: () => channel, send: async () => 'ok' }
  const memberApi = {
    requestCode: async () => ({ ok: true }),
    verifyCode: async () => ({ ok: true, token: 'mtok' }),
    memberMe: async () => ({ phoneMasked: '+60 ••• ••0101', points: 0, rate: 1, entries: [] }),
    memberSignOut: async () => {},
    memberLinkTable: async (..._a: unknown[]): Promise<unknown> => ({ linked: true, phoneMasked: '+60 ••• ••0101' }),
    memberPublicSettings: async () => ({ qrEnabled: true, rate: 1 }),
  }
  return { server, line, rpc, channel, memberApi }
})

vi.mock('./qrClient', () => ({
  qrClient: {
    rpc: (fn: string) => h.rpc(fn),
    channel: () => h.channel,
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
  },
}))
vi.mock('./member/memberApi', () => ({ memberApi: h.memberApi }))

import QrApp from './QrApp'

beforeEach(() => {
  h.server.sent = false
  localStorage.clear(); sessionStorage.clear()
  localStorage.setItem('qr-guest-TOK', JSON.stringify({ id: h.line.guestId, name: 'Eric', avatar: 'a1' }))
  localStorage.setItem('craft-member-token', 'mtok')
  window.history.replaceState(null, '', '/qr/?t=TOK')
  window.scrollTo = () => {}
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function sendOrder() {
  render(<QrApp />)
  fireEvent.click(await screen.findByRole('button', { name: /^Cart · / }))
  fireEvent.click(await screen.findByRole('button', { name: 'Place order' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Send order for the table' }))
  await screen.findByRole('heading', { name: 'Order sent' })
}

describe('QrApp — members', () => {
  it('shows ★ pts for a signed-in phone, and links the bill after a send with the guest id', async () => {
    const link = vi.spyOn(h.memberApi, 'memberLinkTable')
    render(<QrApp />)
    expect(await screen.findByText('★ 0 pts')).toBeTruthy()
    cleanup()
    await sendOrder()
    await waitFor(() => expect(link).toHaveBeenCalledWith('TOK', 'mtok', h.line.guestId))
    expect(await screen.findByText('Points from this bill go to your number.')).toBeTruthy()
    expect(await screen.findByText("You'll earn points when this bill is paid at the counter.")).toBeTruthy()
  })
  it('a link that fails leaves the sent view as it is', async () => {
    const link = vi.spyOn(h.memberApi, 'memberLinkTable').mockRejectedValue(new Error('offline'))
    await sendOrder()
    await waitFor(() => expect(link).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByRole('heading', { name: 'Order sent' })).toBeTruthy()
    expect(screen.queryByText("You'll earn points when this bill is paid at the counter.")).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
