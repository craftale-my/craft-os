import { describe, expect, it } from 'vitest'
import {
  ALL_DAY, bearer, buildMenu, issueToken, matchRoute, menuItemIds, parseIntegrationStatus, parseMenuSyncState,
  parseOauthRequest, parseOrderState, parseSubmitOrder, sameText, TOKEN_TTL_S, verifyToken, type MenuSource,
} from './logic'

describe('matchRoute', () => {
  it('maps the paths Grab is given, as Supabase passes them', () => {
    expect(matchRoute('POST', '/grab/oauth/token')).toBe('oauth')
    expect(matchRoute('GET', '/functions/v1/grab/menu')).toBe('menu')
    expect(matchRoute('POST', '/grab/orders')).toBe('submit_order')
    expect(matchRoute('PUT', '/grab/order/state/')).toBe('order_state')
    expect(matchRoute('POST', '/grab/order/state')).toBe('order_state')
    expect(matchRoute('POST', '/grab/menu/sync-state')).toBe('menu_sync_state')
    expect(matchRoute('POST', '/grab/integration-status')).toBe('integration_status')
    expect(matchRoute('POST', '/grab/admin')).toBe('admin')
  })
  it('refuses other paths and methods', () => {
    expect(matchRoute('GET', '/grab')).toBe('not_found')
    expect(matchRoute('GET', '/grab/nope')).toBe('not_found')
    expect(matchRoute('POST', '/grab/menu')).toBe('method_not_allowed')
    expect(matchRoute('GET', '/grab/orders')).toBe('method_not_allowed')
  })
})

describe('tokens we issue to Grab', () => {
  const now = 1_800_000_000
  it('verify until expiry with the same secret only', async () => {
    const { token, expiresIn } = await issueToken('s3cret', now)
    expect(expiresIn).toBe(TOKEN_TTL_S)
    expect(token).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+$/)
    expect(await verifyToken('s3cret', token, now + 10)).toBe(true)
    expect(await verifyToken('s3cret', token, now + TOKEN_TTL_S)).toBe(false)
    expect(await verifyToken('other', token, now + 10)).toBe(false)
  })
  it('a changed expiry or signature fails', async () => {
    const { token } = await issueToken('s3cret', now)
    const [, exp, sig] = token.split('.')
    expect(await verifyToken('s3cret', `v1.${Number(exp) + 999}.${sig}`, now)).toBe(false)
    expect(await verifyToken('s3cret', `v1.${exp}.${sig.slice(0, -1)}A`, now)).toBe(false)
    expect(await verifyToken('s3cret', 'garbage', now)).toBe(false)
  })
  it('bearer and sameText', () => {
    expect(bearer('Bearer abc.def')).toBe('abc.def')
    expect(bearer('bearer x')).toBe('x')
    expect(bearer('Basic x')).toBeNull()
    expect(bearer(null)).toBeNull()
    expect(sameText('abc', 'abc')).toBe(true)
    expect(sameText('abc', 'abd')).toBe(false)
    expect(sameText('abc', 'abcd')).toBe(false)
  })
})

describe('parseOauthRequest', () => {
  it('reads JSON (Grab) and form bodies', () => {
    const want = { clientId: 'id', clientSecret: 'sec', grantType: 'client_credentials' }
    expect(parseOauthRequest('application/json', JSON.stringify({ client_id: 'id', client_secret: 'sec', grant_type: 'client_credentials', scope: 'x' }))).toEqual(want)
    expect(parseOauthRequest('application/x-www-form-urlencoded', 'client_id=id&client_secret=sec&grant_type=client_credentials')).toEqual(want)
  })
  it('null without credentials or with a broken body', () => {
    expect(parseOauthRequest('application/json', '{"client_id":"id"}')).toBeNull()
    expect(parseOauthRequest('application/json', 'not json')).toBeNull()
  })
})

const SOURCE: MenuSource = {
  merchantId: '1-CYNGRUNGSBCCC', branchId: 'branch-1', catalogId: 'cat-grab', isActive: true,
  products: [
    {
      id: 'p-latte', name: 'Coffee Latte', description: ' Double shot ', categoryId: 'c-coffee', categoryName: 'Coffee', categorySort: 1, sort: 1,
      soldOut: false,
      variants: [{ id: 'v-hot', name: 'HOT', priceSen: 1200, isBase: false }, { id: 'v-cold', name: 'COLD', priceSen: 1300, isBase: false }],
      groups: [
        { id: 'g-milk', name: 'Milk', min: 0, max: 1, options: [
          { id: 'o-oat', name: 'Oat', priceDeltaSen: 250, available: false },
          { id: 'o-soy', name: 'Soy', priceDeltaSen: 150, available: true },
        ] },
        { id: 'g-empty', name: 'Nothing left', min: 1, max: 1, options: [] },
      ],
    },
    {
      id: 'p-tea', name: 'Teh Tarik', description: null, categoryId: 'c-coffee', categoryName: 'Coffee', categorySort: 1, sort: 2,
      soldOut: true, variants: [{ id: 'v-tea', name: 'Teh Tarik', priceSen: 950, isBase: true }], groups: [],
    },
    {
      id: 'p-cake', name: 'Cake', description: '', categoryId: 'c-cake', categoryName: 'Cakes', categorySort: 2, sort: 1,
      soldOut: false, variants: [{ id: 'v-cake', name: 'Slice', priceSen: 1000, isBase: false }],
      groups: [{ id: 'g-pick', name: 'Pick two', min: 3, max: 5, options: [
        { id: 'o-a', name: 'A', priceDeltaSen: 0, available: true }, { id: 'o-b', name: 'B', priceDeltaSen: 0, available: true },
      ] }],
    },
    { id: 'p-none', name: 'Unpriced', description: null, categoryId: 'c-x', categoryName: 'X', categorySort: 3, sort: 1, soldOut: false, variants: null, groups: [] },
  ],
}

describe('buildMenu', () => {
  const { menu, warnings } = buildMenu(SOURCE)

  it('the store, MYR in sen and one all-day selling time', () => {
    expect(menu.merchantID).toBe('1-CYNGRUNGSBCCC')
    expect(menu.partnerMerchantID).toBe('branch-1')
    expect(menu.currency).toEqual({ code: 'MYR', symbol: 'RM', exponent: 2 })
    expect(menu.sellingTimes).toHaveLength(1)
    expect(menu.sellingTimes[0].id).toBe(ALL_DAY)
    expect(Object.values(menu.sellingTimes[0].serviceHours).every((h) => h.openPeriodType === 'OpenAllDay')).toBe(true)
    expect(warnings).toEqual([])
  })

  it('one item per variant; one-variant products keep their own name', () => {
    expect(menu.categories.map((c: any) => [c.id, c.sequence, c.sellingTimeID])).toEqual([['c-coffee', 1, ALL_DAY], ['c-cake', 2, ALL_DAY]])
    expect(menu.categories[0].items.map((i: any) => [i.id, i.name, i.price, i.availableStatus, i.sequence])).toEqual([
      ['v-hot', 'Coffee Latte (HOT)', 1200, 'AVAILABLE', 1],
      ['v-cold', 'Coffee Latte (COLD)', 1300, 'AVAILABLE', 2],
      ['v-tea', 'Teh Tarik', 950, 'UNAVAILABLE', 3],
    ])
    expect(menu.categories[0].items[0].description).toBe('Double shot')
    expect('description' in menu.categories[0].items[2]).toBe(false)
    expect(menu.categories[1].items[0].name).toBe('Cake')
  })

  it('modifier groups: empty ones dropped, sold-out options unavailable, ranges within the options', () => {
    const groups = menu.categories[0].items[0].modifierGroups
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ id: 'g-milk', availableStatus: 'AVAILABLE', selectionRangeMin: 0, selectionRangeMax: 1 })
    expect(groups[0].modifiers.map((m: any) => [m.id, m.price, m.availableStatus])).toEqual([['o-oat', 250, 'UNAVAILABLE'], ['o-soy', 150, 'AVAILABLE']])
    expect(menu.categories[1].items[0].modifierGroups[0]).toMatchObject({ selectionRangeMin: 2, selectionRangeMax: 2 })
  })

  it('warns past Grab limits instead of cutting', () => {
    const many: MenuSource = {
      ...SOURCE,
      products: Array.from({ length: 301 }, (_, i) => ({
        id: `p${i}`, name: `P${i}`, description: null, categoryId: 'c', categoryName: 'Big', categorySort: 1, sort: i,
        soldOut: false, variants: [{ id: `v${i}`, name: 'x', priceSen: 100, isBase: true }], groups: [],
      })),
    }
    const r = buildMenu(many)
    expect(r.menu.categories[0].items).toHaveLength(301)
    expect(r.warnings).toEqual(['Big: 301 items (Grab allows 300)'])
  })

  it('menuItemIds lists every priced variant', () => {
    expect([...menuItemIds(SOURCE)].sort()).toEqual(['v-cake', 'v-cold', 'v-hot', 'v-tea'])
  })
})

// Shaped after the SubmitOrderRequest example in Grab's spec
const ORDER = {
  orderID: '123-CYNKLPCVRN5', shortOrderNumber: 'GF-123', merchantID: '1-CYNGRUNGSBCCC', partnerMerchantID: 'branch-1',
  paymentType: 'CASHLESS', cutlery: true, orderTime: '2026-11-01T03:04:05Z', scheduledTime: '',
  currency: { code: 'MYR', symbol: 'RM', exponent: 2 },
  featureFlags: { orderAcceptedType: 'MANUAL', orderType: 'DeliveredByGrab' },
  items: [{ id: 'v-hot', grabItemID: 'MYITE2023#1', quantity: 2, price: 1325, tax: 150, modifiers: [{ id: 'o-soy', price: 159, tax: 9, quantity: 1 }] }],
  price: { subtotal: 2650, tax: 150, total: 2650 },
}

describe('parseSubmitOrder', () => {
  it('a valid order becomes a grab_orders row and its item ids', () => {
    const r = parseSubmitOrder(ORDER)
    expect(r).toEqual({
      ok: true,
      row: {
        grab_order_id: '123-CYNKLPCVRN5', merchant_id: '1-CYNGRUNGSBCCC', short_order_number: 'GF-123',
        order_type: 'DeliveredByGrab', accepted_type: 'MANUAL', payment_type: 'CASHLESS',
        subtotal_sen: 2650, total_sen: 2650, cutlery: true, order_time: '2026-11-01T03:04:05.000Z', scheduled_time: null,
      },
      itemIds: ['v-hot'],
    })
  })
  it('refuses what the row cannot hold', () => {
    const bad = (patch: object) => parseSubmitOrder({ ...ORDER, ...patch })
    expect(bad({ orderID: '' })).toEqual({ ok: false, error: 'orderID is required' })
    expect(bad({ paymentType: 'CARD' })).toMatchObject({ ok: false })
    expect(bad({ featureFlags: { orderType: 'TakeAway' } })).toMatchObject({ ok: false })
    expect(bad({ orderTime: 'yesterday' })).toMatchObject({ ok: false })
    expect(bad({ currency: { code: 'SGD' } })).toEqual({ ok: false, error: 'currency SGD is not MYR' })
    expect(bad({ price: { subtotal: 26.5 } })).toMatchObject({ ok: false })
    expect(bad({ items: [] })).toMatchObject({ ok: false })
    expect(bad({ items: [{ id: 'v-hot', quantity: 0, price: 100 }] })).toMatchObject({ ok: false })
    expect(parseSubmitOrder(null)).toMatchObject({ ok: false })
  })
})

describe('the other webhooks', () => {
  it('order state', () => {
    expect(parseOrderState({ orderID: 'o1', merchantID: 'm1', state: 'DRIVER_ALLOCATED', driverETA: 300 }))
      .toEqual({ ok: true, orderId: 'o1', merchantId: 'm1', state: 'DRIVER_ALLOCATED' })
    expect(parseOrderState({ orderID: 'o1', merchantID: 'm1', state: 'EATEN' })).toMatchObject({ ok: false })
    expect(parseOrderState({ merchantID: 'm1', state: 'DELIVERED' })).toMatchObject({ ok: false })
  })
  it('menu sync state', () => {
    expect(parseMenuSyncState({ requestID: 'r', merchantID: 'm1', jobID: 'j1', status: 'FAILED', errors: ['bad price', 3] }))
      .toEqual({ ok: true, merchantId: 'm1', jobId: 'j1', status: 'FAILED', errors: ['bad price'] })
    expect(parseMenuSyncState({ merchantID: 'm1', status: 'DONE' })).toMatchObject({ ok: false })
  })
  it('integration status', () => {
    expect(parseIntegrationStatus({ partnerMerchantID: 'b', grabMerchantID: 'm1', integrationStatus: 'ACTIVE' }))
      .toEqual({ ok: true, merchantId: 'm1', status: 'ACTIVE' })
    expect(parseIntegrationStatus({ grabMerchantID: 'm1', integrationStatus: 'ON' })).toMatchObject({ ok: false })
  })
})
