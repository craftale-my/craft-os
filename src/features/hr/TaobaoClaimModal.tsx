import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Sparkles, Download, ExternalLink } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { aiRead, loadAccounts, loadCompanyName, uploadFile } from '../accounts/api'
import {
  normaliseTaobao, numOf, round2, taobaoTotals, todayMYT, money, ascii,
  type AccountRow, type TaobaoOrder, type TaobaoRead,
} from '../accounts/claimDesk'
import { buildClaimPdf } from '../accounts/claimPdf'
import { canvasForAi, downloadBlob, loadImage, thumbnail } from '../accounts/imaging'

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const smallInput = 'w-full px-2 py-1.5 rounded-md border border-[#D4C5B0] bg-white text-sm text-brown-dark focus:outline-none focus:ring-2 focus:ring-[#C4813A40]'
const labelCls = 'block text-xs font-semibold text-brown-medium mb-1'

const RATE_KEY = 'claimdesk.cnyRate'
const emptyOrder = (): TaobaoOrder => ({ orderNo: '', orderDate: '', sellerEn: '', items: [{ descEn: '', qty: 1, unitPriceCny: null, amountCny: null }] })

function Shot({ img }: { img: HTMLImageElement }) {
  const url = useMemo(() => thumbnail(img, 220).toDataURL('image/jpeg', 0.7), [img])
  return <img src={url} alt="Order screenshot" className="w-20 h-28 object-cover object-top rounded-md border border-[#E8DDD0] bg-white" />
}

/**
 * Taobao purchase paid by the staff member: screenshots → AI reads and translates
 * the orders → the staff member checks them, enters the CNY→MYR rate → an English
 * Staff Expense Claim PDF (original screenshots as Appendix A) is filed with the claim.
 */
export function TaobaoClaimModal({ staffId, staffName, onClose, onSubmitted }: {
  staffId: string
  staffName: string
  onClose: () => void
  onSubmitted: () => void
}) {
  const [shots, setShots] = useState<HTMLImageElement[]>([])
  const [read, setRead] = useState<TaobaoRead | null>(null)
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [company, setCompany] = useState('')
  const [rate, setRate] = useState(() => { try { return localStorage.getItem(RATE_KEY) ?? '' } catch { return '' } })
  const [rateSource, setRateSource] = useState('Bank Negara Malaysia rate on payment date')
  const [payMethod, setPayMethod] = useState('')
  const [seller, setSeller] = useState('')
  const [shipping, setShipping] = useState('')
  const [discount, setDiscount] = useState('')
  const [total, setTotal] = useState('')
  const [account, setAccount] = useState('Purchases (Cost of Sales)')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState<'' | 'ai' | 'save' | 'pdf'>('')
  const [error, setError] = useState('')
  const [aiNote, setAiNote] = useState('')

  useEffect(() => {
    loadAccounts().then(setAccounts)
    loadCompanyName().then(setCompany)
  }, [])

  const orders = read?.orders ?? []
  const rateN = numOf(rate)
  const totalN = numOf(total)
  const myr = totalN != null && rateN ? round2(totalN * rateN) : null

  function applyRead(r: TaobaoRead) {
    setRead(r)
    const t = taobaoTotals(r.orders)
    setSeller([...new Set(r.orders.map(o => o.sellerEn).filter(Boolean))].join('; '))
    setShipping(t.shipping ? String(t.shipping) : '')
    setDiscount(t.discount ? String(t.discount) : '')
    setTotal(t.total ? String(t.total) : '')
    if (r.paymentMethod && !payMethod) setPayMethod(r.paymentMethod)
    if (r.suggestedAccount && accounts.some(a => a.name === r.suggestedAccount)) setAccount(r.suggestedAccount)
    setNotes(r.notes ?? '')
  }

  async function addShots(files: File[]) {
    setError('')
    const imgs: HTMLImageElement[] = []
    for (const f of files) {
      try { imgs.push(await loadImage(f)) } catch { setError(`Could not read ${f.name}. Use a screenshot (JPG / PNG).`) }
    }
    setShots(s => [...s, ...imgs].slice(0, 6))
  }

  async function readWithAi() {
    setBusy('ai'); setError(''); setAiNote('')
    const images = shots.flatMap(img => canvasForAi(img)).slice(0, 12)
    const r = await aiRead<unknown>('taobao', { images }, accounts.map(a => a.name))
    setBusy('')
    if (!r.ok) {
      setError(r.error)
      if (r.code === 'ai_not_configured' && !read) applyRead({ orders: [emptyOrder()] })
      return
    }
    const n = normaliseTaobao(r.data)
    if (!n.orders.length) {
      setAiNote('No order details were found. Use the order details page (订单详情) screenshot, or fill in by hand.')
      applyRead({ orders: [emptyOrder()] })
      return
    }
    applyRead(n)
    setAiNote('Check every line against the screenshot before submitting.')
  }

  // ── editing ────────────────────────────────────────────────────────────────
  const update = (fn: (o: TaobaoOrder[]) => TaobaoOrder[]) => {
    const next = fn(orders.map(o => ({ ...o, items: o.items.map(i => ({ ...i })) })))
    setRead(r => ({ ...(r ?? { orders: [] }), orders: next }))
    const t = taobaoTotals(next)
    setTotal(t.total ? String(t.total) : '')
  }
  const setOrder = (oi: number, k: keyof TaobaoOrder, v: string) => update(os => { (os[oi] as unknown as Record<string, unknown>)[k] = v; return os })
  const setItem = (oi: number, ii: number, k: 'descEn' | 'qty' | 'unitPriceCny' | 'amountCny', v: string) => update(os => {
    const it = os[oi].items[ii]
    if (k === 'descEn') it.descEn = v
    else {
      it[k] = numOf(v)
      if ((k === 'qty' || k === 'unitPriceCny') && it.qty != null && it.unitPriceCny != null) it.amountCny = round2(it.qty * it.unitPriceCny)
    }
    return os
  })

  function claimData() {
    const dates = orders.map(o => o.orderDate).filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    return {
      company, claimant: staffName, payMethod, seller, orders, rate: rateN, rateSource,
      shipping: numOf(shipping) ?? 0, discount: numOf(discount) ?? 0, total: totalN, myr, account, notes,
      claimDate: dates[dates.length - 1] ?? todayMYT(),
    }
  }

  function validate(): string {
    if (!shots.length) return 'Add the order screenshots — they are attached to the claim as proof.'
    if (!orders.length || orders.every(o => !o.items.length)) return 'Add at least one item.'
    if (orders.some(o => o.items.some(i => !String(i.descEn ?? '').trim()))) return 'Every item needs an English description.'
    if (!rateN || rateN <= 0 || rateN > 5) return 'Enter the exchange rate (1 CNY = ? MYR, e.g. 0.62).'
    if (!totalN || totalN <= 0) return 'Enter the total paid in CNY.'
    return ''
  }

  async function downloadPdf() {
    setBusy('pdf')
    const c = claimData()
    const blob = await buildClaimPdf({ ...c, claimRef: '(draft — not submitted)' }, shots)
    downloadBlob(`Claim_Taobao_${ascii(staffName).replace(/\W+/g, '')}_${c.claimDate}.pdf`, blob)
    setBusy('')
  }

  async function submit() {
    const v = validate()
    if (v) { setError(v); return }
    setBusy('save'); setError('')
    try { localStorage.setItem(RATE_KEY, rate) } catch { /* private mode */ }
    const c = claimData()
    const id = crypto.randomUUID()
    const ref = `TB-${id.slice(0, 8).toUpperCase()}`
    const pdfName = `${ref}_Taobao_${ascii(staffName).replace(/\W+/g, '')}_${c.claimDate}.pdf`
    try {
      const blob = await buildClaimPdf({ ...c, claimRef: ref }, shots)
      const up = await uploadFile('claim-receipts', staffId, new File([blob], pdfName, { type: 'application/pdf' }), pdfName)
      if (!up.ok) throw new Error(`Upload failed: ${up.error}`)
      const pdfPath = up.data.path!
      const items = orders.flatMap(o => o.items.map(i => ({ orderNo: o.orderNo ?? '', descEn: i.descEn ?? '', qty: i.qty ?? null, unitPriceCny: i.unitPriceCny ?? null, amountCny: i.amountCny ?? null })))
      const { error: err } = await supabase.from('claims').insert({
        id,
        staff_id: staffId,
        claim_type: 'supplies',
        amount: c.myr,
        description: `Taobao: ${items.map(i => i.descEn).join('; ')}`.slice(0, 300),
        claim_date: c.claimDate,
        receipt_url: supabase.storage.from('claim-receipts').getPublicUrl(pdfPath).data.publicUrl,
        source: 'taobao',
        currency: 'CNY',
        foreign_amount: c.total,
        exchange_rate: c.rate,
        rate_source: c.rateSource,
        gl_account: c.account,
        self_billed_status: 'pending',
        pdf_path: pdfPath,
        details: {
          ref, seller: c.seller, payment_method: c.payMethod, order_nos: orders.map(o => o.orderNo).filter(Boolean).join(', '),
          shipping_cny: c.shipping, discount_cny: c.discount, items, orders, pdf_name: pdfName, notes: c.notes,
        },
      })
      if (err) throw new Error(err.message)
      onSubmitted()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit the claim.')
    }
    setBusy('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/40 sm:p-4">
      <div className="bg-cream-light sm:rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-full sm:max-h-[92vh]">
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#E8DDD0]">
          <div>
            <h2 className="font-bold text-brown-dark text-lg">Taobao Purchase Claim</h2>
            <p className="text-xs text-brown-faint">Paid with your own money? Upload the order screenshots — an English claim form is made for the accounts.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-brown-faint hover:text-brown-dark text-xl leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-5 overflow-y-auto">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          <section className="space-y-2">
            <p className={labelCls}>1. Order screenshots (order details page works best)</p>
            <div className="flex flex-wrap gap-2 items-center">
              {shots.map((img, i) => (
                <div key={i} className="relative">
                  <Shot img={img} />
                  <button type="button" aria-label="Remove screenshot" onClick={() => setShots(s => s.filter((_, j) => j !== i))}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-white shadow text-bad text-xs">×</button>
                </div>
              ))}
              {shots.length < 6 && (
                <label className="w-20 h-28 rounded-md border-2 border-dashed border-[#D4C5B0] flex flex-col items-center justify-center text-xs text-brown-muted cursor-pointer hover:bg-white">
                  <Plus size={18} />Add
                  <input type="file" accept="image/*" multiple hidden onChange={e => { addShots([...(e.target.files ?? [])]); e.target.value = '' }} />
                </label>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={readWithAi} disabled={!shots.length || busy !== ''}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#C4813A] text-white text-xs font-semibold hover:bg-[#A86C2C] disabled:opacity-50">
                <Sparkles size={14} /> {busy === 'ai' ? 'Reading… (10–60 s)' : read ? 'Read again with AI' : 'Read & translate with AI'}
              </button>
              {!read && (
                <button type="button" onClick={() => applyRead({ orders: [emptyOrder()] })}
                  className="px-3 py-2 rounded-lg border border-[#D4C5B0] text-xs text-brown-medium font-medium hover:bg-[#F5EDE0]">
                  Fill in by hand
                </button>
              )}
            </div>
            {aiNote && <p className="text-xs text-[#A86C2C]">{aiNote}</p>}
          </section>

          {read && (
            <section className="space-y-3">
              <p className={labelCls}>2. Check the English translation</p>
              {orders.map((o, oi) => (
                <div key={oi} className="bg-white rounded-xl border border-[#E8DDD0] p-3 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className={labelCls}>Order No.</label><input className={smallInput} value={o.orderNo ?? ''} onChange={e => setOrder(oi, 'orderNo', e.target.value)} /></div>
                    <div><label className={labelCls}>Order date</label><input type="date" className={smallInput} value={o.orderDate ?? ''} onChange={e => setOrder(oi, 'orderDate', e.target.value)} /></div>
                  </div>
                  {o.sellerZh && <p className="text-[11px] text-brown-faint">Shop: {o.sellerZh}</p>}
                  {o.items.map((it, ii) => (
                    <div key={ii} className="border-t border-[#F0E8DC] pt-2 space-y-1.5">
                      <div className="flex gap-2 items-start">
                        <div className="flex-1">
                          <input aria-label="Item description (English)" placeholder="Item description in English" className={smallInput}
                            value={it.descEn ?? ''} onChange={e => setItem(oi, ii, 'descEn', e.target.value)} />
                          {it.descZh && <p className="text-[11px] text-brown-faint mt-0.5">{it.descZh}</p>}
                        </div>
                        <button type="button" aria-label="Remove item" className="p-1.5 text-bad" onClick={() => update(os => { os[oi].items.splice(ii, 1); return os })}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div><label className="text-[10px] text-brown-faint">Qty</label><input inputMode="decimal" className={smallInput} value={it.qty ?? ''} onChange={e => setItem(oi, ii, 'qty', e.target.value)} /></div>
                        <div><label className="text-[10px] text-brown-faint">Unit CNY</label><input inputMode="decimal" className={smallInput} value={it.unitPriceCny ?? ''} onChange={e => setItem(oi, ii, 'unitPriceCny', e.target.value)} /></div>
                        <div><label className="text-[10px] text-brown-faint">Amount CNY</label><input inputMode="decimal" className={smallInput} value={it.amountCny ?? ''} onChange={e => setItem(oi, ii, 'amountCny', e.target.value)} /></div>
                      </div>
                    </div>
                  ))}
                  <div className="flex justify-between">
                    <button type="button" className="text-xs text-[#A86C2C] font-semibold" onClick={() => update(os => { os[oi].items.push({ descEn: '', qty: 1 }); return os })}>+ Add item</button>
                    {orders.length > 1 && <button type="button" className="text-xs text-bad" onClick={() => update(os => os.filter((_, j) => j !== oi))}>Remove order</button>}
                  </div>
                </div>
              ))}
              <button type="button" className="text-xs text-[#A86C2C] font-semibold" onClick={() => update(os => [...os, emptyOrder()])}>+ Add another order</button>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label className={labelCls}>Seller (English)</label><input className={inputCls} value={seller} onChange={e => setSeller(e.target.value)} /></div>
                <div><label className={labelCls}>Payment method</label><input className={inputCls} placeholder="e.g. Alipay, credit card" value={payMethod} onChange={e => setPayMethod(e.target.value)} /></div>
                <div><label className={labelCls}>Shipping (CNY)</label><input inputMode="decimal" className={inputCls} value={shipping} onChange={e => setShipping(e.target.value)} /></div>
                <div><label className={labelCls}>Discount (CNY)</label><input inputMode="decimal" className={inputCls} value={discount} onChange={e => setDiscount(e.target.value)} /></div>
                <div><label className={labelCls}>Total paid (CNY)</label><input inputMode="decimal" className={inputCls} value={total} onChange={e => setTotal(e.target.value)} /></div>
                <div>
                  <label className={labelCls}>What was it for? (account)</label>
                  <select className={inputCls} value={account} onChange={e => setAccount(e.target.value)}>
                    {accounts.map(a => <option key={a.name} value={a.name}>{a.name}</option>)}
                  </select>
                </div>
              </div>
            </section>
          )}

          {read && (
            <section className="space-y-2">
              <p className={labelCls}>3. Exchange rate</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label className={labelCls}>1 CNY = ? MYR</label><input inputMode="decimal" placeholder="e.g. 0.62" className={inputCls} value={rate} onChange={e => setRate(e.target.value)} /></div>
                <div><label className={labelCls}>Rate source</label><input className={inputCls} value={rateSource} onChange={e => setRateSource(e.target.value)} /></div>
              </div>
              <p className="text-[11px] text-brown-faint">
                Use the rate on the payment date from{' '}
                <a className="underline inline-flex items-center gap-0.5" href="https://www.bnm.gov.my/exchange-rates" target="_blank" rel="noopener noreferrer">BNM Exchange Rates <ExternalLink size={10} /></a>.
              </p>
              <div>
                <label className={labelCls}>Notes</label>
                <textarea rows={2} className={`${inputCls} resize-none`} value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
              <div className="flex items-center justify-between bg-white rounded-xl border border-[#E8DDD0] px-4 py-3">
                <span className="text-sm text-brown-muted">Claim amount</span>
                <span className="text-lg font-bold text-brown-dark">{myr != null ? `RM ${money(myr)}` : '—'}</span>
              </div>
              <p className="text-[11px] text-brown-faint">The company issues a self-billed e-Invoice for this purchase in MyInvois; the accounts team tracks it.</p>
            </section>
          )}
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-[#E8DDD0]">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium font-medium hover:bg-[#F5EDE0] transition-colors">Cancel</button>
          {read && (
            <button onClick={downloadPdf} disabled={busy !== ''} title="Preview the English claim PDF"
              className="px-3 py-2.5 rounded-xl border border-[#D4C5B0] text-sm text-brown-medium hover:bg-[#F5EDE0] disabled:opacity-50">
              <Download size={16} />
            </button>
          )}
          <button onClick={submit} disabled={!read || busy !== ''}
            className="flex-1 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors disabled:opacity-60">
            {busy === 'save' ? 'Submitting…' : 'Submit Claim'}
          </button>
        </div>
      </div>
    </div>
  )
}
