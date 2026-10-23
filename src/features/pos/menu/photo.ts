// src/features/pos/menu/photo.ts
/** Product photo rules (spec §5), pure so they are tested: what may be picked, how big it is
 *  drawn, where it is stored. photoUpload.ts does the browser work with them. */

export const PHOTO_BUCKET = 'menu-images'
export const PHOTO_MAX_WIDTH = 800
/** a very tall picture is capped too: it would pass the bucket's 2 MB and Safari's canvas limit */
export const PHOTO_MAX_HEIGHT = 1600
export const PHOTO_QUALITY = 0.8
export const PHOTO_MAX_INPUT_BYTES = 10 * 1024 * 1024
export type PhotoMime = 'image/webp' | 'image/jpeg'

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp',
}

/** The image type a file name says ("123.JPG" → image/jpeg); '' when it is not an image name. */
export function imageTypeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return name.includes('.') ? TYPES[ext] ?? '' : ''
}

/** Why a picked file cannot become a product photo, or null. */
export function photoInputProblem(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('image/')) return 'Choose an image file (JPEG, PNG, WebP or HEIC)'
  if (file.size >= PHOTO_MAX_INPUT_BYTES) return 'The photo is too large (at most 10 MB)'
  if (file.size === 0) return 'The photo file is empty'
  return null
}

/** At most 800 px wide and 1600 px high, in proportion; a smaller picture keeps its size. */
export function resizeTarget(
  width: number, height: number, maxWidth = PHOTO_MAX_WIDTH, maxHeight = PHOTO_MAX_HEIGHT,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  if (scale === 1) return { width, height }
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** products/<product id>/<random>.webp|.jpg — the only paths menu_set_product_image accepts. */
export function photoPath(productId: string, mime: PhotoMime, random: string): string {
  const name = random.replace(/[^A-Za-z0-9]/g, '').slice(0, 64)
  if (name.length < 8) throw new Error('A photo name needs at least 8 letters or digits')
  return `products/${productId}/${name}.${mime === 'image/webp' ? 'webp' : 'jpg'}`
}
