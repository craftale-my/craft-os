// src/features/pos/menu/photoUpload.ts
/** The browser side of product photos: resize, upload, point the product at the new file,
 *  delete the old one (spec §5). Used by the product editor's Photo section and the
 *  import's Photos step. The rules themselves are in photo.ts, the canvas work in photoResize.ts. */
import { supabase } from '../../../shared/lib/supabase'
import { fetchProductExtras, setProductImage } from './slotsApi'
import { PHOTO_BUCKET, photoInputProblem, photoPath } from './photo'
import { resizePhoto } from './photoResize'

export const publicPhotoUrl = (path: string): string => supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl

/** Resizes and uploads a new file, points the product at it, then deletes the file it replaced.
 *  Returns a warning when only that last clean-up failed (the photo itself is saved).
 *  If pointing the product at the new file seems to fail, the answer may just have been lost:
 *  the product is read again, and the new file is deleted only when the product certainly does
 *  not point at it — a file left unused is harmless, a product pointing at a deleted file is not. */
export async function uploadProductPhoto(productId: string, file: Blob): Promise<{ warning: string | null }> {
  const problem = photoInputProblem(file)
  if (problem) throw new Error(problem)
  const { blob, mime } = await resizePhoto(file)
  const path = photoPath(productId, mime, crypto.randomUUID())
  const bucket = supabase.storage.from(PHOTO_BUCKET)
  const up = await bucket.upload(path, blob, { contentType: mime, cacheControl: '31536000', upsert: false })
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`)
  let old: string | null
  try {
    old = await setProductImage(productId, path)
  } catch (e) {
    let now: string | null | undefined                            // undefined = could not be read again
    try { now = (await fetchProductExtras(productId)).imagePath } catch { now = undefined }
    if (now === path) return { warning: 'Photo saved, but the old file could not be identified for deletion' }
    if (now !== undefined) await bucket.remove([path])           // the product keeps its old photo; the new file goes
    throw e
  }
  if (!old) return { warning: null }
  const rm = await bucket.remove([old])
  return { warning: rm.error ? `Photo saved, but the old file could not be deleted: ${rm.error.message}` : null }
}

/** Takes the photo off the product, then deletes its file. */
export async function removeProductPhoto(productId: string): Promise<{ warning: string | null }> {
  const old = await setProductImage(productId, null)
  if (!old) return { warning: null }
  const rm = await supabase.storage.from(PHOTO_BUCKET).remove([old])
  return { warning: rm.error ? `Photo removed, but its file could not be deleted: ${rm.error.message}` : null }
}
