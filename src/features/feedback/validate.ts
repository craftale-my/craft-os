import { ACCEPTED_PHOTO_TYPES, MAX_MESSAGE, MAX_PHOTOS, MAX_PHOTO_BYTES } from './types'
import type { FeedbackCategory } from './types'

type PhotoLike = { size: number; type: string }

export interface FeedbackDraft {
  category: FeedbackCategory | null
  message: string
  photos: PhotoLike[]
  anonymous: boolean
}

export function isAcceptablePhoto(f: PhotoLike): boolean {
  return ACCEPTED_PHOTO_TYPES.includes(f.type) && f.size <= MAX_PHOTO_BYTES
}

/** 提交前的校验。服务器端约束是同一套规则的兜底,不是替代。 */
export function validateFeedbackDraft(d: FeedbackDraft): string[] {
  const errors: string[] = []
  if (!d.category) errors.push('Choose a category.')
  const text = d.message.trim()
  if (text.length === 0) errors.push('Write a message.')
  if (text.length > MAX_MESSAGE) errors.push(`Message must be ${MAX_MESSAGE} characters or fewer.`)
  if (d.photos.length > MAX_PHOTOS) errors.push(`Add up to ${MAX_PHOTOS} photos.`)
  if (d.photos.some(p => !isAcceptablePhoto(p))) errors.push('Photos must be images under 5 MB.')
  if (d.anonymous && d.category !== 'workplace') errors.push('Only Workplace feedback can be anonymous.')
  if (d.anonymous && d.photos.length > 0) errors.push("Photos can't be attached to anonymous feedback.")
  return errors
}
