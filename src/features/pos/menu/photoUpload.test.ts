import { beforeEach, describe, expect, it, vi } from 'vitest'

// The storage bucket, the two RPCs and the canvas are stand-ins: what is tested is the order of
// the steps and what is kept or deleted when one of them fails.
const bucket = { upload: vi.fn(), remove: vi.fn(), getPublicUrl: vi.fn() }
vi.mock('../../../shared/lib/supabase', () => ({ supabase: { storage: { from: () => bucket } } }))
const api = { setProductImage: vi.fn(), fetchProductExtras: vi.fn() }
vi.mock('./slotsApi', () => ({
  setProductImage: (...a: unknown[]) => api.setProductImage(...a),
  fetchProductExtras: (...a: unknown[]) => api.fetchProductExtras(...a),
}))
const resizePhoto = vi.fn(async () => ({ blob: new Blob(['w'], { type: 'image/webp' }), mime: 'image/webp' }))
vi.mock('./photoResize', () => ({ resizePhoto: (...a: unknown[]) => resizePhoto(...(a as [])) }))

import { removeProductPhoto, uploadProductPhoto } from './photoUpload'

const PID = '3f2c1e9a-1111-4222-8333-944455566677'
const file = new Blob(['jpeg bytes'], { type: 'image/jpeg' })
const newPath = () => bucket.upload.mock.calls[0][0] as string

beforeEach(() => {
  vi.clearAllMocks()
  bucket.upload.mockResolvedValue({ error: null })
  bucket.remove.mockResolvedValue({ error: null })
})

describe('uploadProductPhoto', () => {
  it('uploads a new file, points the product at it, then deletes the old one', async () => {
    api.setProductImage.mockResolvedValue(`products/${PID}/oldfile1.webp`)
    expect(await uploadProductPhoto(PID, file)).toEqual({ warning: null })
    expect(newPath()).toMatch(new RegExp(`^products/${PID}/[0-9a-f]{32}\\.webp$`))
    expect(api.setProductImage).toHaveBeenCalledWith(PID, newPath())
    expect(bucket.remove).toHaveBeenCalledWith([`products/${PID}/oldfile1.webp`])
  })

  it('refuses a file that is not an image before uploading anything', async () => {
    await expect(uploadProductPhoto(PID, new Blob(['%PDF'], { type: 'application/pdf' }))).rejects.toThrow('Choose an image file')
    expect(bucket.upload).not.toHaveBeenCalled()
  })

  it('pointing failed and the product does not point at the new file: the new file is deleted', async () => {
    api.setProductImage.mockRejectedValue(new Error('Product not found — refresh and try again'))
    api.fetchProductExtras.mockResolvedValue({ imagePath: `products/${PID}/oldfile1.webp`, imageUpdatedAt: null, scheduleIds: [] })
    await expect(uploadProductPhoto(PID, file)).rejects.toThrow('Product not found')
    expect(bucket.remove).toHaveBeenCalledWith([newPath()])
  })

  it('the answer was lost but the product points at the new file: kept, with a warning', async () => {
    api.setProductImage.mockRejectedValue(new Error('Failed to fetch'))
    api.fetchProductExtras.mockImplementation(async () => ({ imagePath: newPath(), imageUpdatedAt: 'now', scheduleIds: [] }))
    expect(await uploadProductPhoto(PID, file)).toEqual({ warning: 'Photo saved, but the old file could not be identified for deletion' })
    expect(bucket.remove).not.toHaveBeenCalled()
  })

  it('pointing failed and the product cannot be read again: nothing is deleted', async () => {
    api.setProductImage.mockRejectedValue(new Error('Failed to fetch'))
    api.fetchProductExtras.mockRejectedValue(new Error('Failed to fetch'))
    await expect(uploadProductPhoto(PID, file)).rejects.toThrow('Failed to fetch')
    expect(bucket.remove).not.toHaveBeenCalled()
  })

  it('the old file cannot be deleted: the photo is saved, with a warning', async () => {
    api.setProductImage.mockResolvedValue(`products/${PID}/oldfile1.webp`)
    bucket.remove.mockResolvedValue({ error: { message: 'timeout' } })
    expect(await uploadProductPhoto(PID, file)).toEqual({ warning: 'Photo saved, but the old file could not be deleted: timeout' })
  })
})

// A 2-frame GIF and an animated WebP header (see photo.test.ts for how they are built).
const ascii = (t: string) => [...t].map((c) => c.charCodeAt(0))
const frame = [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00]
const gif2 = (w: number) => new Uint8Array([...ascii('GIF89a'), w & 0xff, w >> 8, 2, 0, 0, 0, 0, ...frame, ...frame, 0x3b])
const animWebp = new Uint8Array([...ascii('RIFF'), 22, 0, 0, 0, ...ascii('WEBPVP8X'), 10, 0, 0, 0, 0x02, 0, 0, 0, 99, 0, 0, 49, 0, 0])

describe('uploadProductPhoto, animations', () => {
  it('an animated GIF skips the resize and is uploaded as it is, as .gif with its own type', async () => {
    api.setProductImage.mockResolvedValue(null)
    const f = new Blob([gif2(2)], { type: 'image/gif' })
    expect(await uploadProductPhoto(PID, f)).toEqual({ warning: null })
    expect(resizePhoto).not.toHaveBeenCalled()
    expect(newPath()).toMatch(new RegExp(`^products/${PID}/[0-9a-f]{32}\\.gif$`))
    expect(bucket.upload.mock.calls[0][1]).toBe(f)
    expect(bucket.upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/gif' })
    expect(api.setProductImage).toHaveBeenCalledWith(PID, newPath())
  })

  it('an animated WebP is uploaded as it is, as .anim.webp', async () => {
    api.setProductImage.mockResolvedValue(`products/${PID}/oldfile1.webp`)
    await uploadProductPhoto(PID, new Blob([animWebp], { type: 'image/webp' }))
    expect(resizePhoto).not.toHaveBeenCalled()
    expect(newPath()).toMatch(/\.anim\.webp$/)
    expect(bucket.upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/webp' })
    expect(bucket.remove).toHaveBeenCalledWith([`products/${PID}/oldfile1.webp`])
  })

  it('an animation over 1200 px is refused before anything is uploaded', async () => {
    await expect(uploadProductPhoto(PID, new Blob([gif2(1300)], { type: 'image/gif' })))
      .rejects.toThrow('The animation is too wide or tall (at most 1200 px). Export it smaller and try again.')
    expect(bucket.upload).not.toHaveBeenCalled()
  })

  it('an animation over 4 MB is refused before anything is uploaded', async () => {
    const big = new Blob([gif2(2), new Uint8Array(4 * 1024 * 1024)], { type: 'image/gif' })
    await expect(uploadProductPhoto(PID, big)).rejects.toThrow('The animation is too large (at most 4 MB).')
    expect(bucket.upload).not.toHaveBeenCalled()
  })

  it('a still picture still goes through the resize', async () => {
    api.setProductImage.mockResolvedValue(null)
    await uploadProductPhoto(PID, file)
    expect(resizePhoto).toHaveBeenCalledTimes(1)
    expect(bucket.upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/webp' })
  })
})

describe('removeProductPhoto', () => {
  it('takes the photo off the product, then deletes its file', async () => {
    api.setProductImage.mockResolvedValue(`products/${PID}/oldfile1.webp`)
    expect(await removeProductPhoto(PID)).toEqual({ warning: null })
    expect(api.setProductImage).toHaveBeenCalledWith(PID, null)
    expect(bucket.remove).toHaveBeenCalledWith([`products/${PID}/oldfile1.webp`])
  })
})
