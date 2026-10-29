import { describe, it, expect } from 'vitest'
import { validateFeedbackDraft, isAcceptablePhoto } from './validate'
import type { FeedbackDraft } from './validate'

const jpg = { size: 1000, type: 'image/jpeg' }
const ok: FeedbackDraft = { category: 'system', message: 'Leave page is blank', photos: [], anonymous: false }

describe('validateFeedbackDraft', () => {
  it('合法草稿没有错误', () => {
    expect(validateFeedbackDraft(ok)).toEqual([])
  })

  it('必须选分类', () => {
    expect(validateFeedbackDraft({ ...ok, category: null })).toContain('Choose a category.')
  })

  it('空白内容算没写', () => {
    expect(validateFeedbackDraft({ ...ok, message: '   \n ' })).toContain('Write a message.')
  })

  it('超过 2000 字被拦', () => {
    expect(validateFeedbackDraft({ ...ok, message: 'a'.repeat(2001) }))
      .toContain('Message must be 2000 characters or fewer.')
    expect(validateFeedbackDraft({ ...ok, message: 'a'.repeat(2000) })).toEqual([])
  })

  it('最多 3 张照片', () => {
    expect(validateFeedbackDraft({ ...ok, photos: [jpg, jpg, jpg, jpg] })).toContain('Add up to 3 photos.')
    expect(validateFeedbackDraft({ ...ok, photos: [jpg, jpg, jpg] })).toEqual([])
  })

  it('照片必须是 5 MB 以下的图片', () => {
    expect(validateFeedbackDraft({ ...ok, photos: [{ size: 6_000_000, type: 'image/jpeg' }] }))
      .toContain('Photos must be images under 5 MB.')
    expect(validateFeedbackDraft({ ...ok, photos: [{ size: 10, type: 'application/pdf' }] }))
      .toContain('Photos must be images under 5 MB.')
  })

  it('只有 Workplace 可以匿名', () => {
    expect(validateFeedbackDraft({ ...ok, anonymous: true })).toContain('Only Workplace feedback can be anonymous.')
    expect(validateFeedbackDraft({ ...ok, category: 'workplace', anonymous: true })).toEqual([])
  })

  it('匿名不能带照片', () => {
    expect(validateFeedbackDraft({ ...ok, category: 'workplace', anonymous: true, photos: [jpg] }))
      .toContain("Photos can't be attached to anonymous feedback.")
  })
})

describe('isAcceptablePhoto', () => {
  it('正好 5 MB 可以,多 1 byte 不行', () => {
    expect(isAcceptablePhoto({ size: 5_242_880, type: 'image/png' })).toBe(true)
    expect(isAcceptablePhoto({ size: 5_242_881, type: 'image/png' })).toBe(false)
  })

  it('只接受 bucket 允许的图片类型', () => {
    expect(isAcceptablePhoto({ size: 1000, type: 'image/svg+xml' })).toBe(false)
    expect(isAcceptablePhoto({ size: 1000, type: 'image/avif' })).toBe(false)
    expect(isAcceptablePhoto({ size: 1000, type: '' })).toBe(false)
    expect(isAcceptablePhoto({ size: 1000, type: 'image/heic' })).toBe(true)
  })
})
