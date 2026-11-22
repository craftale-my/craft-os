// src/features/pos/menu/photo.ts
/** Product photo rules (spec §5), pure so they are tested: what may be picked, how big it is
 *  drawn, where it is stored. photoUpload.ts does the browser work with them. */

export const PHOTO_BUCKET = 'menu-images'
export const PHOTO_MAX_WIDTH = 800
/** a very tall picture is capped too: it would pass Safari's canvas limit (and the bucket's size limit) */
export const PHOTO_MAX_HEIGHT = 1600
export const PHOTO_QUALITY = 0.8
export const PHOTO_MAX_INPUT_BYTES = 10 * 1024 * 1024
export type PhotoMime = 'image/webp' | 'image/jpeg' | 'image/gif'

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
  if (!file.type.startsWith('image/')) return 'Choose an image file (JPEG, PNG, WebP or GIF; HEIC on Safari only)'
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

/** products/<product id>/<random>.webp|.jpg|.gif|.anim.webp — the only paths menu_set_product_image
 *  accepts. An animated WebP gets .anim.webp: its path is how the QR page tells it from a still one. */
export function photoPath(productId: string, mime: PhotoMime, random: string, animated = false): string {
  const name = random.replace(/[^A-Za-z0-9]/g, '').slice(0, 64)
  if (name.length < 8) throw new Error('A photo name needs at least 8 letters or digits')
  const ext = mime === 'image/gif' ? 'gif' : mime === 'image/jpeg' ? 'jpg' : animated ? 'anim.webp' : 'webp'
  return `products/${productId}/${name}.${ext}`
}

// ── Animated photos (GIF, animated WebP): uploaded as they are, not resized ──────────────────────
export const ANIMATION_MAX_BYTES = 4 * 1024 * 1024           // the bucket's limit
export const ANIMATION_MAX_SIDE = 1200

const startsWith = (b: Uint8Array, at: number, text: string) =>
  b.length >= at + text.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0))
const isGif = (b: Uint8Array) => startsWith(b, 0, 'GIF87a') || startsWith(b, 0, 'GIF89a')
const isVp8x = (b: Uint8Array) => startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP') && startsWith(b, 12, 'VP8X') && b.length >= 30

/** True when the GIF has more than one image (frame). Walks the blocks; a cut-off file counts the
 *  frames it has. */
export function isAnimatedGif(b: Uint8Array): boolean {
  if (!isGif(b) || b.length < 13) return false
  let i = 13
  if (b[10] & 0x80) i += 3 * (2 << (b[10] & 0x07))             // global colour table
  const skipSubBlocks = () => { while (i < b.length && b[i] !== 0) i += b[i] + 1; i++ }
  let frames = 0
  while (i < b.length) {
    const kind = b[i]
    if (kind === 0x21) { i += 2; skipSubBlocks() }               // extension: label, then data sub-blocks
    else if (kind === 0x2c) {                                    // image descriptor
      if (i + 10 > b.length) return false
      if (++frames > 1) return true
      const packed = b[i + 9]
      i += 10
      if (packed & 0x80) i += 3 * (2 << (packed & 0x07))         // local colour table
      i++                                                        // LZW minimum code size
      skipSubBlocks()
    } else return false                                          // trailer (0x3b) or something unreadable
  }
  return false
}

/** True when the WebP's extended header (VP8X) has the ANIM flag. */
export const isAnimatedWebp = (b: Uint8Array): boolean => isVp8x(b) && (b[20] & 0x02) !== 0

/** The GIF's logical screen size, or null when it is not a GIF. */
export function gifSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isGif(b) || b.length < 10) return null
  return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) }
}

/** The canvas size of an extended (VP8X) WebP — every animated one is — or null. */
export function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (!isVp8x(b)) return null
  return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) }
}

/** What an animated file is (its content type and pixel size), or null for a still picture. */
export function sniffAnimation(b: Uint8Array): { mime: 'image/gif' | 'image/webp'; width: number; height: number } | null {
  if (isAnimatedGif(b)) return { mime: 'image/gif', ...gifSize(b)! }
  if (isAnimatedWebp(b)) return { mime: 'image/webp', ...webpSize(b)! }
  return null
}

/** Why an animation cannot be uploaded as it is, or null. */
export function animationProblem(a: { bytes: number; width: number; height: number }): string | null {
  if (a.bytes > ANIMATION_MAX_BYTES) return 'The animation is too large (at most 4 MB). Trim it or lower its size and try again.'
  if (Math.max(a.width, a.height) > ANIMATION_MAX_SIDE) {
    return 'The animation is too wide or tall (at most 1200 px). Export it smaller and try again.'
  }
  return null
}

/** True for a stored animation: a path or URL ending in .gif or .anim.webp (query and hash ignored). */
export function isAnimatedPhoto(pathOrUrl: string | null | undefined): boolean {
  const p = (pathOrUrl ?? '').split(/[?#]/)[0].toLowerCase()
  return p.endsWith('.gif') || p.endsWith('.anim.webp')
}

/** The line under an animation's preview in the editor: "Animated · 2.3 MB" ("· 340 KB" under 1 MB). */
export function animatedLabel(bytes: number | null): string {
  if (bytes === null) return 'Animated'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `Animated · ${mb.toFixed(1)} MB` : `Animated · ${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** The public URL with the time the photo was set as a version (?v=<ms>), so a browser never shows
 *  a cached older picture; unchanged when that time is missing or unreadable. */
export function versionedPhotoUrl(url: string, updatedAt: string | null): string {
  const ms = updatedAt ? Date.parse(updatedAt) : NaN
  if (Number.isNaN(ms)) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${ms}`
}
