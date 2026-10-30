// The English Staff Expense Claim for a Taobao purchase, as LHDN / auditors want it:
// claim header, translated item table, totals in CNY and MYR, classification,
// declaration and three signature boxes, then the original Chinese screenshots
// as Appendix A. Layout ported from buildClaimPdf() in the prototype.
import { ascii, money, todayMYT, type TaobaoOrder } from './claimDesk'

export interface ClaimPdfData {
  company: string
  claimRef: string
  claimant: string
  payMethod: string
  seller: string
  orders: TaobaoOrder[]
  rate: number | null
  rateSource: string
  shipping: number
  discount: number
  total: number | null
  myr: number | null
  account: string
  notes: string
}

type Table = { lastAutoTable: { finalY: number } }

export async function buildClaimPdf(c: ClaimPdfData, screenshots: (HTMLImageElement | HTMLCanvasElement)[]): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
  const last = () => (pdf as unknown as Table).lastAutoTable.finalY
  const L = 14
  const brown: [number, number, number] = [107, 76, 53]
  let y = 16

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.text(ascii(c.company || 'CRAFTALE SDN. BHD.'), L, y); y += 7
  pdf.setFontSize(12); pdf.text('STAFF EXPENSE CLAIM - FOREIGN ONLINE PURCHASE', L, y); y += 5
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9); pdf.setTextColor(90)
  pdf.text("Supplier platform: Taobao (Alibaba Group), People's Republic of China. Currency: CNY.", L, y)
  pdf.setTextColor(0); y += 4

  const orderNos = c.orders.map(o => o.orderNo).filter(Boolean)
  const orderDates = [...new Set(c.orders.map(o => o.orderDate).filter(Boolean))]
  autoTable(pdf, {
    startY: y, theme: 'plain', styles: { fontSize: 9, cellPadding: 1.2 }, columnStyles: { 0: { fontStyle: 'bold', cellWidth: 42 } },
    body: [
      ['Claim ref.', ascii(c.claimRef)], ['Claim date', todayMYT()], ['Claimant', ascii(c.claimant || '-')],
      ['Payment method', ascii(c.payMethod || '-')], ['Seller', ascii(c.seller || '-')],
      ['Order No.', ascii(orderNos.join(', ') || '-')], ['Order date', ascii(orderDates.join(', ') || '-')],
      ['Exchange rate', c.rate ? `1 CNY = ${c.rate} MYR (${ascii(c.rateSource || 'BNM')})` : '-'],
    ],
  })
  y = last() + 4

  const items = c.orders.flatMap(o => o.items.map(i => [ascii(o.orderNo ?? ''), ascii(i.descEn ?? ''), String(i.qty ?? ''), money(i.unitPriceCny), money(i.amountCny)]))
  autoTable(pdf, {
    startY: y, head: [['Order No.', 'Description (English translation)', 'Qty', 'Unit (CNY)', 'Amount (CNY)']], body: items,
    styles: { fontSize: 8.5, cellPadding: 1.6 }, headStyles: { fillColor: brown },
    columnStyles: { 0: { cellWidth: 34 }, 2: { halign: 'right', cellWidth: 12 }, 3: { halign: 'right', cellWidth: 24 }, 4: { halign: 'right', cellWidth: 26 } },
  })
  y = last() + 2

  autoTable(pdf, {
    startY: y, theme: 'plain', margin: { left: 110 }, styles: { fontSize: 9, cellPadding: 1.2 }, columnStyles: { 1: { halign: 'right' } },
    body: [
      ['Shipping (CNY)', money(c.shipping)], ['Discount (CNY)', c.discount ? '-' + money(c.discount) : money(0)],
      ['Total paid (CNY)', money(c.total)],
      [{ content: 'Total claim (MYR)', styles: { fontStyle: 'bold' } }, { content: c.myr != null ? money(c.myr) : '-', styles: { fontStyle: 'bold' } }],
    ],
  })
  y = last() + 4

  autoTable(pdf, {
    startY: y, theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.6 }, headStyles: { fillColor: brown },
    head: [['Accounting classification', '']], columnStyles: { 0: { fontStyle: 'bold', cellWidth: 52 } },
    body: [
      ['Document type', 'Staff Expense Claim (reimbursement) - foreign supplier purchase'],
      ['Account', ascii(c.account)],
      ['Payment', 'Staff-paid; to be reimbursed by Payment Voucher'],
      ['e-Invoice', 'Foreign supplier does not issue a Malaysian e-Invoice. Company to issue a self-billed e-Invoice in MyInvois.'],
      ...(c.notes ? [['Notes', ascii(c.notes)]] : []),
    ],
  })
  y = last() + 6

  if (y > 250) { pdf.addPage(); y = 20 }
  pdf.setFontSize(8.5)
  pdf.text(pdf.splitTextToSize('Declaration: I declare that the above purchase was made wholly and exclusively for the business of the company, that it has not been claimed before, and that the attached order records are true copies.', 182), L, y)
  y += 12
  const box = (x: number, label: string) => { pdf.line(x, y + 14, x + 52, y + 14); pdf.text(label, x, y + 18); pdf.text('Date:', x, y + 23) }
  box(L, 'Claimed by'); box(L + 64, 'Approved by'); box(L + 128, 'Verified by (Accounts)')
  pdf.setFontSize(7.5); pdf.setTextColor(110)
  pdf.text(pdf.splitTextToSize('English translation prepared with AI assistance from the original Chinese order records and checked by the claimant. Original screenshots are attached as Appendix A.', 182), L, 287)
  pdf.setTextColor(0)

  // A long phone screenshot squeezed onto one page would be unreadable, so it
  // continues over as many pages as it needs at full page width.
  const W = 182, H = 272
  screenshots.forEach((src, i) => {
    const w0 = src instanceof HTMLImageElement ? src.naturalWidth : src.width
    const h0 = src instanceof HTMLImageElement ? src.naturalHeight : src.height
    const band = Math.round(w0 * (H / W))
    const parts = Math.max(1, Math.ceil(h0 / band - 0.05))
    for (let p = 0; p < parts; p++) {
      const sy = p * band, sh = Math.min(band, h0 - sy)
      const s = Math.min(1, 1400 / w0)
      const cc = document.createElement('canvas')
      cc.width = Math.round(w0 * s); cc.height = Math.max(1, Math.round(sh * s))
      cc.getContext('2d')!.drawImage(src, 0, sy, w0, sh, 0, 0, cc.width, cc.height)
      pdf.addPage(); pdf.setFontSize(9)
      const label = `Appendix A${screenshots.length > 1 ? '.' + (i + 1) : ''}${parts > 1 ? ` (part ${p + 1} of ${parts})` : ''}`
      pdf.text(`${label} - original order record (Chinese)`, L, 10)
      const r = Math.min(W / cc.width, H / cc.height), w = cc.width * r, h = cc.height * r
      pdf.addImage(cc.toDataURL('image/jpeg', 0.82), 'JPEG', (210 - w) / 2, 14, w, h)
    }
  })

  return pdf.output('blob')
}
