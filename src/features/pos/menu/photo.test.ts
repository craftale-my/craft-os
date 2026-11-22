import { describe, expect, it } from 'vitest'
import {
  mayBeAnimated,
  ANIMATION_MAX_BYTES, animatedLabel, animationProblem, gifSize, isAnimatedGif, isAnimatedPhoto, isAnimatedWebp, sniffAnimation, webpSize,
  PHOTO_MAX_HEIGHT, PHOTO_MAX_INPUT_BYTES, PHOTO_MAX_WIDTH, PHOTO_QUALITY, imageTypeFromName, photoInputProblem, photoPath, resizeTarget,
  versionedPhotoUrl,
} from './photo'

describe('photo rules', () => {
  it('uses the spec parameters: 800 px wide, quality 0.8, input under 10 MB', () => {
    expect(PHOTO_MAX_WIDTH).toBe(800)
    expect(PHOTO_MAX_HEIGHT).toBe(1600)
    expect(PHOTO_QUALITY).toBe(0.8)
    expect(PHOTO_MAX_INPUT_BYTES).toBe(10 * 1024 * 1024)
  })
  it('accepts an image under 10 MB only', () => {
    expect(photoInputProblem({ type: 'image/jpeg', size: 2_000_000 })).toBeNull()
    expect(photoInputProblem({ type: 'image/png', size: PHOTO_MAX_INPUT_BYTES - 1 })).toBeNull()
    expect(photoInputProblem({ type: 'image/png', size: PHOTO_MAX_INPUT_BYTES })).toBe('The photo is too large (at most 10 MB)')
    expect(photoInputProblem({ type: 'application/pdf', size: 10 })).toBe('Choose an image file (JPEG, PNG, WebP or GIF; HEIC on Safari only)')
    expect(photoInputProblem({ type: '', size: 10 })).toBe('Choose an image file (JPEG, PNG, WebP or GIF; HEIC on Safari only)')
    expect(photoInputProblem({ type: 'image/webp', size: 0 })).toBe('The photo file is empty')
  })
  it('scales down to 800 px wide (and 1600 px high) in proportion, never up', () => {
    expect(resizeTarget(800, 6000)).toEqual({ width: 213, height: 1600 })
    expect(resizeTarget(3000, 9000)).toEqual({ width: 533, height: 1600 })
    expect(resizeTarget(4032, 3024)).toEqual({ width: 800, height: 600 })
    expect(resizeTarget(1000, 1500)).toEqual({ width: 800, height: 1200 })
    expect(resizeTarget(1601, 3)).toEqual({ width: 800, height: 1 })
    expect(resizeTarget(640, 480)).toEqual({ width: 640, height: 480 })
    expect(resizeTarget(800, 800)).toEqual({ width: 800, height: 800 })
  })
  it('stores under products/<product id>/ with a random name', () => {
    const id = '3f2c1e9a-1111-4222-8333-944455566677'
    expect(photoPath(id, 'image/webp', 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff'))
      .toBe(`products/${id}/a1b2c3d4e5f647118899aabbccddeeff.webp`)
    expect(photoPath(id, 'image/jpeg', 'abcdefgh')).toBe(`products/${id}/abcdefgh.jpg`)
    expect(() => photoPath(id, 'image/jpeg', 'abc')).toThrow('A photo name needs at least 8 letters or digits')
  })
  it('reads the image type from a file name', () => {
    expect(imageTypeFromName('8812.JPG')).toBe('image/jpeg')
    expect(imageTypeFromName('8812.jpeg')).toBe('image/jpeg')
    expect(imageTypeFromName('8812.png')).toBe('image/png')
    expect(imageTypeFromName('8812.webp')).toBe('image/webp')
    expect(imageTypeFromName('8812.gif')).toBe('image/gif')
    expect(imageTypeFromName('notes.txt')).toBe('')
    expect(imageTypeFromName('8812')).toBe('')
  })
  it('versions a photo URL by when the photo was set, so a cached older picture never shows', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/menu-images/products/p/abcdefgh.webp'
    const ms = Date.parse('2026-10-25T03:00:00.123Z')
    expect(versionedPhotoUrl(url, '2026-10-25T03:00:00.123456+00:00')).toBe(`${url}?v=${ms}`)
    expect(versionedPhotoUrl(`${url}?a=1`, '2026-10-25T03:00:00.123Z')).toBe(`${url}?a=1&v=${ms}`)
    expect(versionedPhotoUrl(url, null)).toBe(url)
    expect(versionedPhotoUrl(url, 'not a date')).toBe(url)
  })
})

// ── Animated photos (spec 2026-11-22-menu-animated-photos §5): tiny hand-built files ──
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
/** A GIF of `frames` 1-colour frames; a global colour table, a Netscape loop block and a frame
 *  delay block, and a local colour table on the second frame, so the walk must skip each kind. */
function gif(width: number, height: number, frames: number): Uint8Array {
  const out = [...ascii('GIF89a'), ...le16(width), ...le16(height), 0x80, 0, 0, 0, 0, 0, 255, 255, 255]
  if (frames > 1) out.push(0x21, 0xff, 0x0b, ...ascii('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00)
  for (let i = 0; i < frames; i++) {
    out.push(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00)                          // 100 ms
    out.push(0x2c, ...le16(0), ...le16(0), ...le16(width), ...le16(height), i === 1 ? 0x80 : 0x00)
    if (i === 1) out.push(0, 0, 0, 255, 0, 0)                                          // local colour table
    out.push(0x02, 0x02, 0x44, 0x01, 0x00)                                             // LZW data
  }
  out.push(0x3b)
  return new Uint8Array(out)
}
/** A WebP with an extended (VP8X) header: flags 0x02 = animated, 0x10 = alpha. */
function webpX(width: number, height: number, flags: number): Uint8Array {
  const body = [...ascii('WEBP'), ...ascii('VP8X'), ...le32(10), flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])
}
const simpleWebp = new Uint8Array([...ascii('RIFF'), ...le32(12), ...ascii('WEBP'), ...ascii('VP8 '), 0, 0, 0, 0])

describe('animated photos', () => {
  it('a GIF is animated when it has more than one frame', () => {
    expect(isAnimatedGif(gif(2, 3, 1))).toBe(false)
    expect(isAnimatedGif(gif(2, 3, 2))).toBe(true)
    expect(isAnimatedGif(gif(2, 3, 5))).toBe(true)
    expect(isAnimatedGif(gif(2, 3, 2).slice(0, 30))).toBe(false)                     // cut before the second frame
    expect(isAnimatedGif(simpleWebp)).toBe(false)
    expect(isAnimatedGif(new Uint8Array())).toBe(false)
  })
  it('a WebP is animated when its VP8X header has the ANIM flag', () => {
    expect(isAnimatedWebp(webpX(640, 480, 0x02))).toBe(true)
    expect(isAnimatedWebp(webpX(640, 480, 0x12))).toBe(true)
    expect(isAnimatedWebp(webpX(640, 480, 0x10))).toBe(false)
    expect(isAnimatedWebp(simpleWebp)).toBe(false)
    expect(isAnimatedWebp(gif(2, 3, 2))).toBe(false)
  })
  it('reads the pixel size from the header', () => {
    expect(gifSize(gif(600, 1300, 2))).toEqual({ width: 600, height: 1300 })
    expect(gifSize(simpleWebp)).toBeNull()
    expect(webpSize(webpX(1200, 1, 0x02))).toEqual({ width: 1200, height: 1 })
    expect(webpSize(webpX(70000, 2, 0x02))).toEqual({ width: 70000, height: 2 })
    expect(webpSize(simpleWebp)).toBeNull()
  })
  it('sniffs an animation and its type; a still GIF or WebP is not one', () => {
    expect(sniffAnimation(gif(300, 200, 2))).toEqual({ mime: 'image/gif', width: 300, height: 200 })
    expect(sniffAnimation(webpX(640, 480, 0x02))).toEqual({ mime: 'image/webp', width: 640, height: 480 })
    expect(sniffAnimation(gif(300, 200, 1))).toBeNull()
    expect(sniffAnimation(webpX(640, 480, 0x10))).toBeNull()
    expect(sniffAnimation(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull()       // a JPEG
  })
  it('refuses an animation over 4 MB or over 1200 px on its longer side', () => {
    expect(ANIMATION_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(animationProblem({ bytes: ANIMATION_MAX_BYTES, width: 1200, height: 1200 })).toBeNull()
    expect(animationProblem({ bytes: ANIMATION_MAX_BYTES + 1, width: 600, height: 600 }))
      .toBe('The animation is too large (at most 4 MB). Trim it or lower its size and try again.')
    expect(animationProblem({ bytes: 1000, width: 1201, height: 10 }))
      .toBe('The animation is too wide or tall (at most 1200 px). Export it smaller and try again.')
    expect(animationProblem({ bytes: 1000, width: 10, height: 1201 }))
      .toBe('The animation is too wide or tall (at most 1200 px). Export it smaller and try again.')
  })
  it('stores a GIF as .gif and an animated WebP as .anim.webp', () => {
    const id = '3f2c1e9a-1111-4222-8333-944455566677'
    expect(photoPath(id, 'image/gif', 'abcdefgh', true)).toBe(`products/${id}/abcdefgh.gif`)
    expect(photoPath(id, 'image/webp', 'abcdefgh', true)).toBe(`products/${id}/abcdefgh.anim.webp`)
    expect(photoPath(id, 'image/webp', 'abcdefgh')).toBe(`products/${id}/abcdefgh.webp`)
  })
  it('tells an animated photo by its path or URL', () => {
    expect(isAnimatedPhoto('products/p/abcdefgh.gif')).toBe(true)
    expect(isAnimatedPhoto('https://x/menu-images/products/p/abcdefgh.anim.webp?v=123')).toBe(true)
    expect(isAnimatedPhoto('https://x/menu-images/products/p/abcdefgh.GIF#x')).toBe(true)
    expect(isAnimatedPhoto('https://x/menu-images/products/p/abcdefgh.webp?v=1.gif')).toBe(false)
    expect(isAnimatedPhoto('products/p/abcdefgh.jpg')).toBe(false)
    expect(isAnimatedPhoto(null)).toBe(false)
  })
  it('labels an animation with its size', () => {
    expect(animatedLabel(2.3 * 1024 * 1024)).toBe('Animated · 2.3 MB')
    expect(animatedLabel(1024 * 1024)).toBe('Animated · 1.0 MB')
    expect(animatedLabel(340 * 1024)).toBe('Animated · 340 KB')
    expect(animatedLabel(null)).toBe('Animated')
  })
})

describe('GIF edge cases (review)', () => {
  // header + 1×1 logical screen, no colour table
  const head = (w: number, h: number) => [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]
  const frame = (w: number, h: number) => [0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2, 1, 0, 0]
  it('skips a stray zero byte between frames', () => {
    expect(isAnimatedGif(new Uint8Array([...head(1, 1), ...frame(1, 1), 0x00, ...frame(1, 1), 0x3b]))).toBe(true)
  })
  it('takes the largest frame when the screen size understates it', () => {
    expect(gifSize(new Uint8Array([...head(0, 0), ...frame(4000, 30), ...frame(20, 2000), 0x3b]))).toEqual({ width: 4000, height: 2000 })
  })
  it('only GIF and WebP heads are worth reading whole', () => {
    const t = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))
    expect(mayBeAnimated(t('GIF89a'))).toBe(true)
    expect(mayBeAnimated(t('RIFFxxxxWEBPVP8 '))).toBe(true)
    expect(mayBeAnimated(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false)
  })
})
