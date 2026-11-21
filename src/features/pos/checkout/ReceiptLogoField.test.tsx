// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ read: vi.fn(), draw: vi.fn() }))
vi.mock('./logoFile', () => ({
  readLogoFile: (f: File) => h.read(f),
  drawLogo: (c: HTMLCanvasElement, l: unknown) => h.draw(c, l),
}))
import ReceiptLogoField from './ReceiptLogoField'

const logo = { width: 16, height: 2, data: '/wAP8A==' }
afterEach(cleanup)
beforeEach(() => { h.read.mockReset(); h.draw.mockReset() })

describe('ReceiptLogoField (W4 spec §3)', () => {
  it('no logo: says so; an uploaded file becomes the logo', async () => {
    const onChange = vi.fn()
    h.read.mockResolvedValue(logo)
    render(<ReceiptLogoField logo={null} onChange={onChange} />)
    expect(screen.getByText('No logo.')).toBeTruthy()
    const file = new File(['x'], 'logo.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [file] } })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(logo))
    expect(h.read).toHaveBeenCalledWith(file)
  })
  it('a logo: its preview as it will print, its size, Change logo and Remove', () => {
    const onChange = vi.fn()
    render(<ReceiptLogoField logo={logo} onChange={onChange} />)
    expect(screen.getByLabelText('Logo preview')).toBeTruthy()
    expect(screen.getByText('16 × 2 dots')).toBeTruthy()
    expect(screen.getByLabelText('Change logo')).toBeTruthy()
    expect(h.draw).toHaveBeenCalledWith(expect.anything(), logo)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
  it('a file that cannot be read: says why, the logo stays', async () => {
    const onChange = vi.fn()
    h.read.mockRejectedValue(new Error('Choose an image file (PNG or JPG).'))
    render(<ReceiptLogoField logo={null} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Upload logo'), { target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } })
    expect((await screen.findByRole('alert')).textContent).toBe('Choose an image file (PNG or JPG).')
    expect(onChange).not.toHaveBeenCalled()
  })
})
