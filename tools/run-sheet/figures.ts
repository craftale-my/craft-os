// Writes the simulated business run sheet (docs/pos/2026-10-25-simulated-run-sheet.md) from the
// Demo branch's facts — tools/run-sheet/facts.sql, run read-only on craft-os-dev and saved as JSON —
// with the totals rules of bill.ts, so every expected figure is the POS's own.
// Run: node --experimental-strip-types --no-warnings tools/run-sheet/figures.ts <facts.json> <out.md>
import { writeFileSync } from 'node:fs'
import type { BillTotals } from '../../src/features/pos/checkout/bill.ts'
import {
  billOf, branchSettings, md, methodName, money, optionDelta, pickProduct, readFacts, rm, unitSen,
  type Item, type Product,
} from './facts.ts'

const [factsPath, outPath] = process.argv.slice(2)
if (!factsPath || !outPath) throw new Error('Usage: figures.ts <facts.json> <out.md>')
const facts = readFacts(factsPath)
const pick = (bucket: 'plain' | 'fee' | 'zero' | 'set', i: number, what: string) => pickProduct(facts, bucket, i, what)
const P1 = pick('plain', 0, 'coffee on the takeaway and QR menus (Bar)')
const P5 = pick('plain', 1, 'second coffee on the takeaway and QR menus (Bar)')
const P2 = pick('fee', 0, 'food with a packaging fee (Kitchen)')
const P3 = pick('zero', 0, '0% SST item')
const P4 = pick('set', 0, 'food with a required choice (Kitchen)')
const method = (kinds: string[], what: string) => methodName(facts, kinds, what)
const CASH = method(['cash'], 'cash')
const CARD = method(['card'], 'card')
const QR = method(['duitnow', 'ewallet'], 'DuitNow / e-wallet')
const settings = branchSettings(facts)
const unit = unitSen
const bill = (orderType: 'dine_in' | 'takeaway', table: string | null, items: Item[]): BillTotals => billOf(facts, orderType, table, items)
const totalLine = (t: BillTotals) => [
  `subtotal ${rm(t.subtotalSen)}`,
  ...(t.serviceChargeSen ? [`service charge ${rm(t.serviceChargeSen)}`] : []),
  ...(t.sstSen ? [`SST ${rm(t.sstSen)}`] : []),
  ...(t.takeawayFeeSen ? [`takeaway packaging ${rm(t.takeawayFeeSen)}`] : []),
  `rounding ${rm(t.roundingSen)}`,
  `**total ${rm(t.totalSen)}**`,
].join(' · ')

// ── the bills of the run ────────────────────────────────────────────────────
const t1Counter: Item[] = [{ p: P1, qty: 2, where: 'dine_in' }, { p: P2, qty: 1, where: 'dine_in' }]
const t1Qr: Item[] = [{ p: P5, qty: 1, where: 'qr' }]
const t2Items: Item[] = [{ p: P4, qty: 1, where: 'dine_in' }, { p: P3, qty: 1, where: 'dine_in' }]
const t2AfterVoid: Item[] = [t2Items[0], { ...t2Items[1], voided: true }]
const taItems: Item[] = [{ p: P2, qty: 1, where: 'takeaway' }, { p: P1, qty: 1, where: 'takeaway' }]
const t6Items: Item[] = [{ p: P1, qty: 1, where: 'dine_in' }]
const withBetween = facts.lastClose !== null    // S1 lands in this Z report only when an earlier close exists

const T1a = bill('dine_in', 'T1', t1Counter)
const T1b = bill('dine_in', 'T1', [...t1Counter, ...t1Qr])
const T2a = bill('dine_in', 'T2', t2Items)
const T2b = bill('dine_in', 'T2', t2AfterVoid)
const T5 = bill('dine_in', 'T5', t2AfterVoid)
const TA = bill('takeaway', null, taItems)
const T1m = bill('dine_in', 'T1', [...t1Counter, ...t1Qr, ...taItems])
const T6 = bill('dine_in', 'T6', t6Items)
const T3 = bill('dine_in', 'T3', [{ p: P1, qty: 1, where: 'dine_in' }])
// merged vs apart before rounding: equal, except up to 1 sen per service-charge or SST rate both bills
// share (each rate is rounded once on the whole bill) — the sheet prints any difference
const apartSen = T1b.beforeRoundingSen + TA.beforeRoundingSen
const mergeGap = T1m.beforeRoundingSen - apartSen
const mergeNote = `Before rounding: T1 ${rm(T1b.beforeRoundingSen)} + takeaway ${rm(TA.beforeRoundingSen)} = ${rm(apartSen)}` + (mergeGap === 0
  ? `, the merged bill's own ${rm(T1m.beforeRoundingSen)}.`
  : `; the merged bill is ${rm(T1m.beforeRoundingSen)} — ${rm(Math.abs(mergeGap))} ${mergeGap > 0 ? 'more' : 'less'}, as expected: service charge and SST are rounded once per rate on the whole bill.`)

// ── payments, refund, cash ──────────────────────────────────────────────────
const t5Received = (Math.floor(T5.totalSen / 1000) + 1) * 1000      // the next RM 10 above: there is change
const t5Change = t5Received - T5.totalSen
const t1Card = Math.floor(T1m.totalSen / 2 / 100) * 100
const t1Cash = T1m.totalSen - t1Card
const t1Received = Math.ceil(t1Cash / 1000) * 1000
const t1Change = t1Received - t1Cash
const refund = Math.min(500, T5.totalSen)
const FLOAT = 20000, PAY_IN = 2000, PAY_OUT = 1500
const cashSales = t1Cash + T5.totalSen
const expectedCash = FLOAT + cashSales - refund + PAY_IN - PAY_OUT

// ── the Z report ────────────────────────────────────────────────────────────
const paid = [T1m, T5, T6]
const sum = (f: (t: BillTotals) => number) => paid.reduce((n, t) => n + f(t), 0)
const nett = sum((t) => t.totalSen)
const voidBills = 1 + (withBetween ? 1 : 0) + facts.earlierVoidBills
const voidSen = unit(t2Items[1]) + unit({ p: P1, qty: 1, where: 'dine_in' }) * (withBetween ? 2 : 1) + facts.earlierVoids.valueSen
const counterItems = [...t1Counter, ...taItems, t2Items[0], ...t6Items]
const value = (items: Item[]) => items.reduce((n, i) => n + unit(i) * i.qty, 0)
const products = new Map<string, { qty: number; value: number }>()
for (const i of [...counterItems, ...t1Qr]) {
  const row = products.get(i.p.nameSnapshot) ?? { qty: 0, value: 0 }
  products.set(i.p.nameSnapshot, { qty: row.qty + i.qty, value: row.value + unit(i) * i.qty })
}
const productLines = [...products.entries()]
  .sort((a, b) => b[1].qty - a[1].qty || b[1].value - a[1].value || a[0].localeCompare(b[0]))
  .map(([name, r]) => `${r.qty} ${name} · ${money(r.value)}`)
const payments = [
  { name: CASH, count: 2, amount: cashSales, refunds: 1, refund },
  { name: CARD, count: 1, amount: t1Card, refunds: 0, refund: 0 },
  { name: QR, count: 1, amount: T6.totalSen, refunds: 0, refund: 0 },
].sort((a, b) => a.name.localeCompare(b.name))
const opt = (p: Product) => p.required.map((r) => `${r.group}: ${r.option.name}`).join(', ')
// a product as the cashier orders it: its name, plus its set choice when it has required groups
const withChoice = (p: Product) => (p.required.length > 0 ? `${md(p.nameSnapshot)} (${md(opt(p))})` : md(p.nameSnapshot))
// where a kitchen / bar ticket prints; no route on the product means no ticket at all
const at = (p: Product) => p.printRoute ?? 'no ticket (no printer route)'

const zLines = [
  ['SUMMARY', ''],
  ['Bills', '3'], ['Pax', '4'], ['Nett sales', money(nett)],
  ['Average per bill', money(Math.round(nett / 3))], ['Average per pax', money(Math.round(nett / 4))],
  ['Void bills', String(voidBills)], ['Total void', money(voidSen)], ['Total refund', money(refund)],
  ['SALES SUMMARY', ''],
  ['Gross sales', money(sum((t) => t.subtotalSen))], ['Takeaway fee', money(sum((t) => t.takeawayFeeSen))],
  ['Service charge', money(sum((t) => t.serviceChargeSen))], ['SST', money(sum((t) => t.sstSen))],
  ['Rounding', money(sum((t) => t.roundingSen))], ['Nett sales', money(nett)],
  ['PAYMENTS', ''],
  ...payments.flatMap((p) => [
    [`${p.name} (${p.count})`, money(p.amount)],
    ...(p.refunds ? [[`  Refunds (${p.refunds})`, money(-p.refund)]] : []),
    ['  Net', money(p.amount - p.refund)],
  ]),
  ['ORDER TYPE', ''], ['Dine-in (3)', money(nett)], ['Takeaway (0)', '0.00'],
  ['SOURCE', ''], ['Counter (4 orders)', money(value(counterItems))], ['QR (1 order)', money(value(t1Qr))],
  ['CASH DRAWER', ''],
  ['Opening float', money(FLOAT)], ['Cash sales', money(cashSales)], ['Cash refunds', money(-refund)],
  ['Pay in: Float top-up', money(PAY_IN)], ['Pay out: Ice', money(-PAY_OUT)],
  ['Expected cash', money(expectedCash)], ['Counted cash', money(expectedCash)], ['Variance', '0.00'],
  ['VOIDS SINCE THE LAST CLOSE', ''],
  // the printed report lists every item void first (by time), then the bill voids (by time)
  ...(facts.earlierVoids.items ? [[`(before this run: ${facts.earlierVoids.items} item void(s))`, money(facts.earlierVoids.valueSen)]] : []),
  ...(withBetween ? [[`1 ${P1.nameSnapshot} (T9, step 1)`, money(unit({ p: P1, qty: 1, where: 'dine_in' }))]] : []),
  [`1 ${P3.nameSnapshot} (T2, step 5)`, money(unit(t2Items[1]))],
  [`1 ${P1.nameSnapshot} (T3, step 11)`, money(unit({ p: P1, qty: 1, where: 'dine_in' }))],
  ...(facts.earlierVoidBills ? [[`(before this run: ${facts.earlierVoidBills} bill void(s))`, '']] : []),
  ...(withBetween ? [['Bill (T9) voided, Test bill', '']] : []),
  ['Bill (T3) voided, Customer left', ''],
  ['REFUNDS', ''], [`(T5's bill) ${CASH}, Quality complaint`, money(refund)],
  ['PRODUCT SALES', ''], ...productLines.map((l) => [l, '']),
]

type Step = [string, string, string, string]   // step, who, do, expect
const steps: Step[] = [
  ...(withBetween ? [[
    '1', 'A', `No shift open yet. Table **T9** → 1 × ${md(P1.nameSnapshot)} → Send. Tap the item → Void item, reason "Wrong item keyed", approver + PIN. Then **Void bill**, reason "Test bill" (approver + PIN if the dialog asks).`,
    `VOID ticket for ${md(P1.nameSnapshot)} → ${at(P1)}. T9 is free again. Both voids appear in this shift's Z report (made since the last close).`,
  ] as Step] : []),
  ['2', 'A', `**Open shift**, opening float **RM ${money(FLOAT)}**.`, 'Top bar: "Shift open · since HH:MM".'],
  ['3', 'A + B together', `A: **T1**, pax 2 → 2 × ${md(P1.nameSnapshot)} + 1 × ${md(P2.nameSnapshot)} → Send. B at the same moment: **T2**, pax 1 → 1 × ${withChoice(P4)} + 1 × ${withChoice(P3)} → Send.`,
    `Tickets: ${md(P1.nameSnapshot)}, ${md(P2.nameSnapshot)} → ${at(P1)} / ${at(P2)}; ${md(P4.nameSnapshot)}, ${md(P3.nameSnapshot)} → ${at(P4)} / ${at(P3)}. T1: ${totalLine(T1a)}. T2: ${totalLine(T2a)}.`],
  ['4', 'Phone', `Open **T1**'s QR link → 1 × ${md(P5.nameSnapshot)} → Place order.`,
    `A: T1 marked new; ticket → ${at(P5)}. T1: ${totalLine(T1b)}.`],
  ['5', 'B (A watches T2)', `A opens T2's bill panel. B: T2 → tap ${md(P3.nameSnapshot)} → Void item, reason "Wrong item keyed", approver + PIN.`,
    `A's T2 panel drops the item within 2 s. VOID ticket → ${at(P3)}. T2: ${totalLine(T2b)}.`],
  ['6', 'B', '**Move table** T2 → **T5**.', `T2 free, T5 occupied. T5: ${totalLine(T5)}.`],
  ['7', 'A', `**Takeaway** → 1 × ${md(P2.nameSnapshot)} + 1 × ${md(P1.nameSnapshot)} → Send. Note its bill number.`,
    `Takeaway prices. Takeaway: ${totalLine(TA)}.`],
  ['8', 'A', "T1 → **Merge** → choose the takeaway bill.", `T1 keeps the takeaway's packaging fee: ${totalLine(T1m)}. (${mergeNote})`],
  ['9', 'A + B', `A: T5 → **Checkout** (leave the sheet open). B: T5 → Checkout → ${md(CASH)} → cash received **RM ${money(t5Received)}** → Pay.`,
    `B: change **${rm(t5Change)}**, receipt prints. A's sheet locks with the red note "This bill was paid on another iPad — do not charge the card terminal." — only **Close** works. A taps Close.`],
  ['10', 'A', `T1 → Checkout → ${md(CARD)} **RM ${money(t1Card)}** → Add; ${md(CASH)} **RM ${money(t1Cash)}**, cash received **RM ${money(t1Received)}** → Add → Pay ${rm(T1m.totalSen)}.`,
    `Change **${rm(t1Change)}**; the receipt lists both payments and the takeaway packaging.`],
  ['11', 'A', `**T3** → 1 × ${md(P1.nameSnapshot)} → Send. Then **Void bill**, reason "Customer left", approver + PIN.`,
    `VOID ticket → ${at(P1)}. T3 (${rm(T3.totalSen)}) is voided and free again.`],
  ['12', 'B', `**Today's bills** → T5's bill → **Refund** ${rm(refund)} to ${md(CASH)}, reason "Quality complaint", approver + PIN.`,
    'Refund slip prints; Today\'s bills shows the refund on T5\'s bill.'],
  ['13', 'A', `**Pay in** RM ${money(PAY_IN)}, reason "Float top-up". Then **Pay out** RM ${money(PAY_OUT)}, reason "Ice", approver + PIN.`,
    'Each sheet says it was recorded.'],
  ['14', 'A (offline spell)', `Turn A's Wi-Fi off. **T6**, pax 1 → 1 × ${md(P1.nameSnapshot)} → Send. Wi-Fi on.`,
    `While off: "1 order waiting to send". After: it sends by itself, ticket → ${at(P1)}. T6: ${totalLine(T6)}.`],
  ['15', 'A (unsure reply, on the iPad)', `On iPad A (Safari): T6 → Checkout → ${md(QR)} ${rm(T6.totalSen)} → Add. Wi-Fi off → **Pay**. Wi-Fi on → **Check bill** → **Pay**.`,
    'Off: "Not sure the payment went through…", method buttons, amounts and remove locked, only Try again / Check bill / Back. (Safari reports the dropped request as "Load failed": if the sheet shows "TypeError: Load failed" with the lines unlocked instead, the unsure-reply lock fails on the iPad — fail this step.) Check bill: "The bill is still open — the payment was not recorded. Check the lines and press Pay." Pay: paid, receipt prints.'],
  ['16', 'A', `**Close shift** → count the drawer: enter **RM ${money(expectedCash)}** → Close.`,
    'No open bills warned. Closes at once (variance 0.00). The Z report prints on the receipt printer and shows on screen — compare it with the next section.'],
]

const productRows = [
  ['P1', P1, 'coffee — counter, takeaway and the offline order'], ['P2', P2, 'food with a packaging fee'],
  ['P3', P3, P3.required.length > 0 ? `0% SST — ${opt(P3)}` : '0% SST'],
  ['P4', P4, `food with a required choice — ${opt(P4)}`], ['P5', P5, 'coffee — the QR order'],
] as const
const out = `# Simulated business run — POS pre-pilot (Demo branch)

Date: 2026-10-25 · Project: **craft-os-dev** · Branch: Demo (\`${facts.branchId}\`)

The after-hours script the owner runs on site with two iPads, the ZyWell ZY301 and the print agent,
before the pilot. Every expected figure below was computed by \`tools/run-sheet/figures.ts\` from the
Demo menu on dev with the POS's own totals rules (\`src/features/pos/checkout/bill.ts\`). If a price,
a service-charge rule or a payment method changes, run the query at the end again and regenerate this
sheet. Bill numbers are not known in advance: bills are named by their table.

## Before you start

- iPad **A** (counter) and iPad **B** (floor) on \`/pos\`, signed in as staff of Demo. Someone with
  **Approve POS voids & refunds** and a POS PIN is the approver for every "approver + PIN" below.
- The print agent runs with \`BRANCH_ID=${facts.branchId}\` and a login of Demo staff; the ZY301 is on
  with paper. Receipts go to ${settings.receiptRoute ?? '— no receipt printer set (set one in POS settings first)'}.
- Set a print route (Bar or Kitchen) on /menu for P1–P5 (or their categories' products), then regenerate
  this sheet so the ticket lines name the printer. A product without a route prints no ticket.
- Close any open shift of Demo and pay or void every open bill **before** the facts are read (\`facts.sql\`).
  If you do it afterwards, run \`facts.sql\` again and regenerate this sheet: the expected Z report counts
  the voids since the last close. When the facts were read: shift open **${facts.openShift ? 'yes — close it, then regenerate' : 'no'}**,
  open bills **${facts.openBills}**${facts.openBills ? ' — clear them, then regenerate' : ''}.
- Wrong PINs are counted per **login**: five wrong tries lock that login out of the approver for 10 minutes
  on every iPad signed in with it. Give each cashier their own login on the pilot iPads.
- A phone with a camera for the QR order.
- Cash variance limit RM ${money(settings.cashVarianceLimitSen)}; SST registered: ${settings.sstRegistered ? 'yes' : 'no'};
  cash rounding: ${settings.cashRounding}.

| Code | Product (as on the bill) | Dine-in | Takeaway | QR | SST | Packaging fee | Printer | Used for |
|---|---|---|---|---|---|---|---|---|
${productRows.map(([c, p, why]) => `| ${c} | ${md(p.nameSnapshot)} | ${money(p.dineInSen + optionDelta(p))} | ${p.takeawaySen === null ? '-' : money(p.takeawaySen)} | ${p.qrSen === null ? '-' : money(p.qrSen)} | ${p.sstRateBp / 100}% | ${money(p.takeawayFeeSen)} | ${p.printRoute ?? '-'} | ${md(why)} |`).join('\n')}

Service-charge rules (first match wins): ${facts.rules.length === 0 ? 'none' : facts.rules.map((r) => `${r.rateBp / 100}% on ${r.orderTypes.join(' + ')}${r.tableIds ? ' at some tables' : ''}${r.productIds ? ' for some products' : ''}`).join('; ')}.
Payment methods used: ${md(CASH)} (cash), ${md(CARD)} (card), ${md(QR)} (QR).

## Steps

| Step | Who | Do | Expect |
|---|---|---|---|
${steps.map((s) => `| ${s.join(' | ')} |`).join('\n')}

## Expected Z report

The printed report has these lines (times and names are left out; a value is flush right on paper).
${withBetween ? '' : 'No shift of Demo was ever closed, so the voids of step 1 would not be listed: step 1 is left out.\n'}
| Line | Value |
|---|---|
${zLines.map(([l, v]) => (v === '' && l === l.toUpperCase() ? `| **${md(l)}** | |` : `| ${md(l)} | ${v} |`)).join('\n')}

## Results

| Step | Expected | Seen | Pass / fail |
|---|---|---|---|
${steps.map((s) => `| ${s[0]} | ${s[3]} | | |`).join('\n')}
| Z report | Every line of the section above | | |

## Regenerating this sheet

1. Close any open shift of Demo and clear its open bills first. Then run \`tools/run-sheet/facts.sql\` in
   the SQL editor of **craft-os-dev** (read-only) right before the run, and save its one \`facts\` cell as a
   JSON file. Make no other voids and close no shift on Demo after that — if you do, run it again and
   regenerate.
2. \`node --experimental-strip-types --no-warnings tools/run-sheet/figures.ts <facts.json> docs/pos/2026-10-25-simulated-run-sheet.md\`
`
writeFileSync(outPath, out)
console.log(`wrote ${outPath}: T1 ${rm(T1m.totalSen)}, T5 ${rm(T5.totalSen)}, T6 ${rm(T6.totalSen)}, expected cash ${rm(expectedCash)}`)
