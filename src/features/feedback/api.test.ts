import { describe, it, expect, vi, beforeEach } from 'vitest'

// 不 mock 的话 vitest 会读 .env.local 连真库。
const upload = vi.fn()
const remove = vi.fn()
const rpc = vi.fn()
vi.mock('../../shared/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a), remove: (...a: unknown[]) => remove(...a) }) },
  },
}))

const { submitFeedback, feedbackContext } = await import('./api')

const photo = (name: string) => new File(['x'], name, { type: 'image/jpeg' })
const base = {
  category: 'product_quality' as const,
  message: 'Milk smells off',
  branch: 'Cheras (Taman Connaught)',
  anonymous: false,
  photos: [] as File[],
  pagePath: '/profile',
  context: { appVersion: 'test' },
}

beforeEach(() => {
  upload.mockReset().mockResolvedValue({ error: null })
  remove.mockReset().mockResolvedValue({ error: null })
  rpc.mockReset().mockResolvedValue({ error: null })
})

describe('submitFeedback', () => {
  it('先传照片再调 RPC,路径挂在反馈 id 下', async () => {
    const res = await submitFeedback({ ...base, photos: [photo('a.JPG'), photo('b.png')] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(upload.mock.calls.map(c => c[0])).toEqual([`${res.id}/1.jpg`, `${res.id}/2.png`])
    expect(rpc).toHaveBeenCalledWith('submit_feedback', expect.objectContaining({
      p_id: res.id,
      p_category: 'product_quality',
      p_photo_paths: [`${res.id}/1.jpg`, `${res.id}/2.png`],
      p_anonymous: false,
    }))
  })

  it('RPC 失败时删掉已传照片并回报服务器信息', async () => {
    rpc.mockResolvedValue({ error: { message: 'Only active staff can send feedback.' } })
    const res = await submitFeedback({ ...base, photos: [photo('a.jpg')] })
    expect(res).toEqual({ ok: false, reason: 'Only active staff can send feedback.' })
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0][0]).toHaveLength(1)
  })

  it('照片上传失败时不调 RPC,并清掉前面传成功的', async () => {
    upload.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'boom' } })
    const res = await submitFeedback({ ...base, photos: [photo('a.jpg'), photo('b.jpg')] })
    expect(res).toEqual({ ok: false, reason: "Couldn't upload photo. Try again." })
    expect(rpc).not.toHaveBeenCalled()
    expect(remove.mock.calls[0][0]).toHaveLength(1)
  })

  it('匿名时一张照片都不传', async () => {
    await submitFeedback({ ...base, category: 'workplace', anonymous: true, photos: [photo('a.jpg')] })
    expect(upload).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('submit_feedback', expect.objectContaining({ p_photo_paths: [], p_anonymous: true }))
  })
})

describe('feedbackContext', () => {
  it('带上版本与 userAgent,报错信息截到 500 字', () => {
    const ctx = feedbackContext('e'.repeat(600))
    expect(ctx.appVersion).toBeTypeOf('string')
    expect(ctx.userAgent).toBeTypeOf('string')
    expect(ctx.errorMessage).toHaveLength(500)
    expect(feedbackContext()).not.toHaveProperty('errorMessage')
  })
})
