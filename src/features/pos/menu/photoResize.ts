// src/features/pos/menu/photoResize.ts
/** The canvas work of a product photo (browser only, so it is kept apart from the upload
 *  logic, which photoUpload.test.ts tests with this module mocked). */
import { PHOTO_QUALITY, resizeTarget, type PhotoMime } from './photo'

/** Draws the image at most 800 × 1600 px on white, the right way up (EXIF orientation), and
 *  encodes it: WebP where the browser can, else JPEG (Safari's canvas cannot make WebP), both at
 *  quality 0.8. */
export async function resizePhoto(file: Blob): Promise<{ blob: Blob; mime: PhotoMime }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This image could not be read — try a JPEG or PNG')
  }
  try {
    const size = resizeTarget(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot resize photos')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.drawImage(bitmap, 0, 0, size.width, size.height)
    const encode = (type: PhotoMime) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, PHOTO_QUALITY))
    for (const mime of ['image/webp', 'image/jpeg'] as const) {
      const blob = await encode(mime)
      if (blob && blob.type === mime) return { blob, mime }
    }
    throw new Error('This browser cannot make a JPEG or WebP photo')
  } finally {
    bitmap.close()
  }
}
