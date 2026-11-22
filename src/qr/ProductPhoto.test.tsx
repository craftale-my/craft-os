// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { PosProduct } from '../features/pos/order/cart'
import { ProductPhoto } from './qrParts'
import MenuGrid from './MenuGrid'
import MenuList from './MenuList'
import ItemPage from './ItemPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The phone's "reduce motion" setting, as matchMedia reports it. */
const reducedMotion = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({
  matches: on && q.includes('prefers-reduced-motion: reduce'), media: q,
  addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
}))

const GIF = 'https://x/menu-images/products/p/abcdefgh.gif?v=1'
const ANIM = 'https://x/menu-images/products/p/abcdefgh.anim.webp?v=1'
const STILL = 'https://x/menu-images/products/p/abcdefgh.webp?v=1'

describe('ProductPhoto', () => {
  it('shows any photo, animated or not, when motion is not reduced', () => {
    reducedMotion(false)
    for (const src of [GIF, ANIM, STILL]) {
      const { container } = render(<ProductPhoto src={src} className="h-24 w-24" />)
      expect(container.querySelector('img')?.getAttribute('src')).toBe(src)
      expect(container.querySelector('img')?.getAttribute('loading')).toBe('lazy')
      cleanup()
    }
  })
  it('with reduced motion, an animation becomes the quiet placeholder; a still photo stays', () => {
    reducedMotion(true)
    for (const src of [GIF, ANIM]) {
      const { container } = render(<ProductPhoto src={src} className="h-24 w-24" />)
      expect(container.querySelector('img')).toBeNull()
      expect(container.firstElementChild?.className).toContain('h-24 w-24')
      expect(container.firstElementChild?.className).toContain('bg-border')
      cleanup()
    }
    const { container } = render(<ProductPhoto src={STILL} className="h-24 w-24" />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(STILL)
  })
  it('works where the browser has no matchMedia (it plays)', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { container } = render(<ProductPhoto src={GIF} className="h-24 w-24" />)
    expect(container.querySelector('img')).not.toBeNull()
  })
})

const prod = (over: Partial<PosProduct>): PosProduct => ({
  id: 'latte', name: 'Latte', description: null, soldOut: false,
  variants: [{ id: 'v', name: 'V', priceSen: 1200, isBase: true }], groups: [], ...over,
})

describe('reduced motion on the QR pages', () => {
  it('the grid and the list show no animation; the item page hero still plays', () => {
    reducedMotion(true)
    const latte = prod({ imageUrl: GIF })
    const lists = { products: [latte], popularIds: new Set<string>(), units: new Map<string, number>(), onOpen: () => {} }
    expect(render(<MenuGrid {...lists} />).container.querySelector('img')).toBeNull()
    cleanup()
    expect(render(<MenuList {...lists} />).container.querySelector('img')).toBeNull()
    cleanup()
    const { container } = render(<ItemPage product={latte} from="menu" pairs={[]} busy={false} error={null} closed={null} onBack={() => {}} onAdd={() => {}} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(GIF)
  })
})
