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
vi.mock('./photoResize', () => ({ resizePhoto: async () => ({ blob: new Blob(['w'], { type: 'image/webp' }), mime: 'image/webp' }) }))

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

describe('removeProductPhoto', () => {
  it('takes the photo off the product, then deletes its file', async () => {
    api.setProductImage.mockResolvedValue(`products/${PID}/oldfile1.webp`)
    expect(await removeProductPhoto(PID)).toEqual({ warning: null })
    expect(api.setProductImage).toHaveBeenCalledWith(PID, null)
    expect(bucket.remove).toHaveBeenCalledWith([`products/${PID}/oldfile1.webp`])
  })
})
