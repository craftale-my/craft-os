// src/qr/ItemPage.tsx
/** The item page (reference frames 06, 08): a full page in place of the menu — photo, name, description,
 *  the choices as radio / tick rows, Goes well with, remark, quantity, one fixed button. The QR page's own;
 *  the counter keeps LineSheet. Same line rules as the counter (cart.ts). */
import { useState, type ReactNode } from 'react'
import { ChevronLeft, Minus, Plus } from 'lucide-react'
import { defaultLine, formatSen, linePriceSen, toggleOption, validateLine, type OrderLine, type PosProduct } from '../features/pos/order/cart'
import PickPill from '../features/pos/order/PickPill'

const ruleText = (min: number, max: number) =>
  min > 0 ? `Required · choose ${min === max ? min : `${min}–${max}`}` : `Optional · up to ${max}`

export default function ItemPage({ product, initial, from, mostPicked, pairs, busy, error, closed, onBack, onAdd }: {
  product: PosProduct
  /** editing a line of mine: its values (Save, no pairings) */
  initial?: OrderLine
  /** where the page was opened: names the back button */
  from: 'menu' | 'cart'
  /** Most picked (menu picks): group id → option id, marked with a pill — never chosen for the guest */
  mostPicked?: Readonly<Record<string, string>>
  /** Goes well with: products that can be added as they are (itemPairs) */
  pairs: PosProduct[]
  /** the line is being written to the server */
  busy: boolean
  /** why the last Add did not go through */
  error: string | null
  /** W7: past the outlet's last-order time — the button is off and this sentence shows */
  closed: string | null
  onBack: () => void
  /** the line, and the ticked pairings (each to be added as its own line, quantity 1) */
  onAdd: (line: OrderLine, pairings: PosProduct[]) => void
}) {
  const [line, setLine] = useState<OrderLine>(initial ?? defaultLine(product))
  const [touched, setTouched] = useState(initial !== undefined)
  const [ticked, setTicked] = useState<string[]>([])
  const editing = initial !== undefined
  const problem = validateLine(product, line)
  const price = linePriceSen(product, line)
  const shownPairs = editing ? [] : pairs
  const chosenPairs = shownPairs.filter((p) => ticked.includes(p.id))
  const pairsSen = chosenPairs.reduce((s, p) => s + (linePriceSen(p, defaultLine(p)) ?? 0), 0)
  const amount = price === null ? '—' : formatSen(price * line.qty + pairsSen)
  const change = (next: OrderLine) => { setTouched(true); setLine(next) }
  const backLabel = from === 'cart' ? 'Back to cart' : 'Back to menu'
  const backButton = (onPhoto: boolean) => (
    <button type="button" aria-label={backLabel} onClick={onBack}
      className={`flex h-10 w-10 items-center justify-center rounded-full ${onPhoto ? 'absolute left-3 top-3 bg-black/45 text-white backdrop-blur-sm' : 'bg-brown-track text-brown-dark'}`}>
      <ChevronLeft size={24} strokeWidth={2.25} />
    </button>
  )

  return (
    <div className="pb-44">
      {product.imageUrl ? (
        <div className="relative">
          <img src={product.imageUrl} alt="" className="aspect-[4/3] max-h-[40vh] w-full object-cover" />
          {backButton(true)}
        </div>
      ) : <div className="flex h-14 items-center px-3">{backButton(false)}</div>}

      <div className="px-4 pb-5 pt-4">
        <h1 className="text-[26px] font-bold leading-tight text-brown-dark">{product.name}</h1>
        {product.description && <p className="mt-1.5 text-[16px] leading-relaxed text-brown-muted">{product.description}</p>}
      </div>

      {product.variants.length > 1 && (
        <Group id="size" title="Size" rule="Required · choose 1" selected={1}>
          {product.variants.map((v) => (
            <Row key={v.id} type="radio" name="size" checked={line.variantId === v.id} label={v.name} right={formatSen(v.priceSen)}
              onToggle={() => change({ ...line, variantId: v.id })} />
          ))}
        </Group>
      )}

      {product.groups.map((g) => {
        const ids = g.options.map((o) => o.id)
        const radio = g.max === 1
        return (
          <Group key={g.id} id={g.id} title={g.name} rule={ruleText(g.min, g.max)} selected={line.optionIds.filter((x) => ids.includes(x)).length}>
            {g.options.map((o) => (
              <Row key={o.id} type={radio ? 'radio' : 'checkbox'} name={g.id} checked={line.optionIds.includes(o.id)} disabled={!o.available}
                label={<>{o.name}{!o.available && ' (sold out)'}{o.available && mostPicked?.[g.id] === o.id && <PickPill text="Most picked" />}</>}
                right={o.priceDeltaSen > 0 ? `+${formatSen(o.priceDeltaSen)}` : ''}
                onToggle={() => change({ ...line, optionIds: toggleOption(line.optionIds, ids, g.max, o.id) })} />
            ))}
          </Group>
        )
      })}

      {shownPairs.length > 0 && (
        <Group id="pairs" title="Goes well with" rule="Optional" selected={chosenPairs.length}>
          {shownPairs.map((p) => {
            const sen = linePriceSen(p, defaultLine(p)) ?? 0
            return (
              <Row key={p.id} type="checkbox" name="pairs" checked={ticked.includes(p.id)} label={p.name}
                right={<span className="flex items-center gap-3">
                  <span>+{formatSen(sen)}</span>
                  {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" className="h-12 w-12 rounded-lg object-cover" /> : <span className="h-12 w-12" />}
                </span>}
                onToggle={() => setTicked((t) => (t.includes(p.id) ? t.filter((x) => x !== p.id) : [...t, p.id]))} />
            )
          })}
        </Group>
      )}

      <div className="border-t-8 border-brown-track px-4 pt-5">
        <label className="block">
          <span className="text-[17px] font-bold text-brown-dark">Remark (optional)</span>
          <input className="mt-2 w-full rounded-xl border border-border-mid bg-card p-3 text-base" maxLength={120}
            value={line.note ?? ''} onChange={(e) => change({ ...line, note: e.target.value || null })} />
        </label>
        <div className="mt-6 flex items-center justify-center gap-7">
          <button type="button" aria-label="Fewer" disabled={line.qty <= 1} onClick={() => change({ ...line, qty: Math.max(1, line.qty - 1) })}
            className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-brown-btn text-brown-btn disabled:opacity-30"><Minus size={20} strokeWidth={2.5} /></button>
          <span data-testid="qty" className="min-w-8 text-center text-2xl font-semibold text-brown-dark">{line.qty}</span>
          <button type="button" aria-label="More" disabled={line.qty >= 20} onClick={() => change({ ...line, qty: Math.min(20, line.qty + 1) })}
            className="flex h-11 w-11 items-center justify-center rounded-full border-2 border-brown-btn text-brown-btn disabled:opacity-30"><Plus size={20} strokeWidth={2.5} /></button>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-lg border-t border-border bg-cream px-4 pb-4 pt-3">
        {touched && problem && <p className="mb-2 text-sm text-red-700">{problem}</p>}
        {closed && <p className="mb-2 text-sm text-amber-800">{closed}</p>}
        {error && <p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
        <button type="button" disabled={!!problem || busy || !!closed} onClick={() => onAdd(line, chosenPairs)}
          className="min-h-14 w-full rounded-xl bg-brown-btn text-[17px] font-semibold text-white disabled:opacity-40">
          {busy ? (editing ? 'Saving…' : 'Adding…') : editing ? `Save · ${amount}` : `Add ${line.qty} to cart · ${amount}`}
        </button>
      </div>
    </div>
  )
}

function Group({ id, title, rule, selected, children }: { id: string; title: string; rule: string; selected: number; children: ReactNode }) {
  return (
    <div role="group" aria-labelledby={`grp-${id}`} className="border-t-8 border-brown-track px-4 pt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div id={`grp-${id}`} className="text-[19px] font-bold text-brown-dark">{title}</div>
          <div className="mt-0.5 text-[15px] font-semibold text-brown-brand">{rule}</div>
        </div>
        <span className="mt-1 shrink-0 rounded-md bg-brown-track px-2 py-1 text-[13px] font-semibold text-brown-muted">Selected {selected}</span>
      </div>
      <div className="mt-1 pb-2">{children}</div>
    </div>
  )
}

function Row({ type, name, checked, disabled = false, label, right, onToggle }: {
  type: 'radio' | 'checkbox'; name: string; checked: boolean; disabled?: boolean; label: ReactNode; right: ReactNode; onToggle: () => void
}) {
  return (
    <label className={`flex min-h-14 items-center gap-4 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
      {/* onClick, not onChange: a tap on the chosen option of a one-of group clears it (toggleOption) */}
      <input type={type} name={name} checked={checked} disabled={disabled} onClick={onToggle} onChange={() => {}}
        className="h-[22px] w-[22px] shrink-0 accent-[#6B4C35]" />
      <span className="min-w-0 flex-1 text-[16px] text-brown-dark">{label}</span>{' '}
      <span className="shrink-0 text-[15px] text-brown-dark">{right}</span>
    </label>
  )
}
