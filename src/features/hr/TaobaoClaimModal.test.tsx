// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

const aiRead = vi.fn()
const uploadFile = vi.fn()
vi.mock('../accounts/api', () => ({
  aiRead: (...a: unknown[]) => aiRead(...a),
  uploadFile: (...a: unknown[]) => uploadFile(...a),
  loadAccounts: async () => [{ name: 'Purchases (Cost of Sales)', code: '' }, { name: 'Packaging Materials', code: '610' }],
  loadCompanyName: async () => 'CRAFTALE SDN. BHD.',
}))
const buildClaimPdf = vi.fn(async () => new Blob(['%PDF'], { type: 'application/pdf' }))
vi.mock('../accounts/claimPdf', () => ({ buildClaimPdf: (...a: unknown[]) => buildClaimPdf(...(a as [])) }))
vi.mock('../accounts/imaging', () => ({
  loadImage: async () => ({ naturalWidth: 1080, naturalHeight: 2000 }),
  thumbnail: () => ({ toDataURL: () => 'data:image/jpeg;base64,AA' }),
  canvasForAi: () => [{ media_type: 'image/jpeg', data: 'AA' }],
  downloadBlob: vi.fn(),
}))
const insert = vi.fn(async () => ({ error: null }))
vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    from: () => ({ insert }),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://x/${p}` } }) }) },
  },
}))

const { TaobaoClaimModal } = await import('./TaobaoClaimModal')

afterEach(() => { cleanup(); aiRead.mockReset(); uploadFile.mockReset(); insert.mockClear(); buildClaimPdf.mockClear() })

function setup() {
  const onSubmitted = vi.fn(), onClose = vi.fn()
  const view = render(<TaobaoClaimModal staffId="s1" staffName="Ah Mei" onClose={onClose} onSubmitted={onSubmitted} />)
  const addShot = () => fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['x'], 'order.png', { type: 'image/png' })] },
  })
  return { ...view, addShot, onSubmitted, onClose }
}

const input = (label: string) => screen.getByLabelText(label, { selector: 'input' }) as HTMLInputElement
const byLabelText = (text: string) => {
  const lbl = screen.getAllByText(text).find(el => el.tagName === 'LABEL')!
  return lbl.parentElement!.querySelector('input, select') as HTMLInputElement
}

describe('TaobaoClaimModal', () => {
  it('reads orders with AI and files a CNY claim with the rate, account and self-billed flag', async () => {
    aiRead.mockResolvedValue({ ok: true, data: {
      orders: [{ orderNo: '2849001', orderDate: '2026-10-20', sellerZh: '义乌杯子店', sellerEn: 'Yiwu Cup Store',
        items: [{ descZh: '纸杯', descEn: 'Paper cup 8oz, 1000 pcs', qty: 1, unitPriceCny: 95, amountCny: 95 }],
        shippingCny: 5, discountCny: 0, totalPaidCny: 100 }],
      paymentMethod: 'Alipay', suggestedAccount: 'Packaging Materials', notes: '',
    } })
    uploadFile.mockResolvedValue({ ok: true, data: { bucket: 'claim-receipts', path: 's1/abc.pdf', name: 'x.pdf' } })
    const { addShot, onSubmitted } = setup()
    addShot()
    fireEvent.click(await screen.findByRole('button', { name: /Read & translate with AI/ }))
    await screen.findByDisplayValue('Paper cup 8oz, 1000 pcs')
    expect(aiRead).toHaveBeenCalledWith('taobao', { images: [{ media_type: 'image/jpeg', data: 'AA' }] }, expect.any(Array))
    expect(byLabelText('Seller (English)').value).toBe('Yiwu Cup Store')
    expect(byLabelText('Total paid (CNY)').value).toBe('100')
    await waitFor(() => expect(byLabelText('What was it for? (account)').value).toBe('Packaging Materials'))

    fireEvent.click(screen.getByRole('button', { name: 'Submit Claim' }))
    expect(await screen.findByText(/Enter the exchange rate/)).toBeTruthy()
    expect(insert).not.toHaveBeenCalled()

    fireEvent.change(byLabelText('1 CNY = ? MYR'), { target: { value: '0.62' } })
    expect(screen.getByText('RM 62.00')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Submit Claim' }))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())

    expect(uploadFile).toHaveBeenCalledWith('claim-receipts', 's1', expect.any(File), expect.stringMatching(/^TB-.*_Taobao_AhMei_2026-10-20\.pdf$/))
    const row = (insert.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(row).toMatchObject({
      staff_id: 's1', claim_type: 'supplies', amount: 62, claim_date: '2026-10-20', source: 'taobao', currency: 'CNY',
      foreign_amount: 100, exchange_rate: 0.62, gl_account: 'Packaging Materials', self_billed_status: 'pending',
      pdf_path: 's1/abc.pdf', receipt_url: 'https://x/s1/abc.pdf',
    })
    expect(row.description).toBe('Taobao: Paper cup 8oz, 1000 pcs')
    expect((row.details as Record<string, unknown>).order_nos).toBe('2849001')
    const pdfArgs = (buildClaimPdf.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(pdfArgs).toMatchObject({ claimant: 'Ah Mei', rate: 0.62, total: 100, myr: 62, company: 'CRAFTALE SDN. BHD.' })
  })

  it('falls back to a hand-filled form when AI is not switched on', async () => {
    aiRead.mockResolvedValue({ ok: false, code: 'ai_not_configured', error: 'AI reading is not switched on yet — please fill the form in by hand.' })
    uploadFile.mockResolvedValue({ ok: true, data: { bucket: 'claim-receipts', path: 's1/b.pdf', name: 'b.pdf' } })
    const { addShot, onSubmitted } = setup()
    addShot()
    fireEvent.click(await screen.findByRole('button', { name: /Read & translate with AI/ }))
    expect(await screen.findByText(/not switched on yet/)).toBeTruthy()

    fireEvent.change(input('Item description (English)'), { target: { value: 'Coffee scale' } })
    fireEvent.change(byLabelText('Total paid (CNY)'), { target: { value: '200' } })
    fireEvent.change(byLabelText('1 CNY = ? MYR'), { target: { value: '0.6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Claim' }))
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
    expect(insert.mock.calls[0]).toBeDefined()
    expect((insert.mock.calls[0] as unknown[])[0]).toMatchObject({ amount: 120, foreign_amount: 200, gl_account: 'Purchases (Cost of Sales)' })
  })

  it('needs a screenshot and an English description for every item', async () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: 'Fill in by hand' }))
    fireEvent.change(byLabelText('Total paid (CNY)'), { target: { value: '10' } })
    fireEvent.change(byLabelText('1 CNY = ? MYR'), { target: { value: '0.6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Claim' }))
    expect(await screen.findByText(/Add the order screenshots/)).toBeTruthy()
    expect(insert).not.toHaveBeenCalled()
  })
})
