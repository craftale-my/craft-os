// Receiving / wastage photos live in the private 'receiving-photos' bucket.
// Rows store plain storage paths; the UI reads them through signed URLs
// (see useSignedPhotoUrls). This module is pure so it can be unit-tested.

export const RECEIVING_PHOTOS_BUCKET = 'receiving-photos'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Normalise a stored photo value to a path inside `bucket`.
 *  - empty -> null
 *  - a path -> the path (leading '/' stripped)
 *  - a Supabase storage URL of `bucket` (public / sign / authenticated) -> its path, URL-decoded
 *  - any other http(s) URL (another bucket, external host) -> null: it cannot be signed
 */
export function toStoragePath(
  value: string | null | undefined,
  bucket: string = RECEIVING_PHOTOS_BUCKET,
): string | null {
  const v = value?.trim()
  if (!v) return null

  if (!/^https?:\/\//i.test(v)) {
    const path = v.replace(/^\/+/, '')
    return path || null
  }

  const re = new RegExp(
    `^https?://[^/]+/storage/v1/object/(?:public|sign|authenticated)/${escapeRegExp(bucket)}/([^?#]+)`,
    'i',
  )
  const match = v.match(re)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]) || null
  } catch {
    return match[1]
  }
}
