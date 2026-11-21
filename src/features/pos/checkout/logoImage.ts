/** The receipt logo, made in the browser when the owner uploads an image (W4 spec §3): scale to fit
 *  384 × 240 dots, grayscale, Floyd–Steinberg dither, pack — rows top to bottom, width / 8 bytes a row,
 *  most significant bit = leftmost dot, 1 = black. Pure: the canvas work is in logoFile.ts. */
import { LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, toBase64, type ReceiptLogo } from '../print/logo'

/** The printed size: never enlarged, the shape kept, the width down to a multiple of 8 (at least 8). */
export function fitLogoSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, LOGO_MAX_WIDTH / width, LOGO_MAX_HEIGHT / height)
  const w = Math.max(8, Math.floor((width * scale) / 8) * 8)
  const h = Math.min(LOGO_MAX_HEIGHT, Math.max(1, Math.round((height * w) / width)))
  return { width: w, height: h }
}

/** RGBA → 0 (black) … 255 (white) per dot; transparency shows white paper. */
export function grayscale(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height)
  for (let i = 0; i < out.length; i++) {
    const lum = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
    const a = rgba[i * 4 + 3] / 255
    out[i] = lum * a + 255 * (1 - a)
  }
  return out
}

/** Floyd–Steinberg: each dot black (1) below 128, its error spread 7/16 right, 3/16 down-left, 5/16 down,
 *  1/16 down-right. */
export function ditherFloydSteinberg(gray: Float32Array, width: number, height: number): Uint8Array {
  const work = Float32Array.from(gray)
  const bits = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const old = work[i]
      const black = old < 128
      bits[i] = black ? 1 : 0
      const err = old - (black ? 0 : 255)
      if (x + 1 < width) work[i + 1] += (err * 7) / 16
      if (y + 1 < height) {
        if (x > 0) work[i + width - 1] += (err * 3) / 16
        work[i + width] += (err * 5) / 16
        if (x + 1 < width) work[i + width + 1] += err / 16
      }
    }
  }
  return bits
}

export function packBits(bits: Uint8Array, width: number, height: number): Uint8Array {
  const row = Math.ceil(width / 8)
  const out = new Uint8Array(row * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bits[y * width + x]) out[y * row + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return out
}

export function unpackBits(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const row = Math.ceil(width / 8)
  const bits = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      bits[y * width + x] = (bytes[y * row + (x >> 3)] >> (7 - (x & 7))) & 1
    }
  }
  return bits
}

/** RGBA pixels already at the printed size (fitLogoSize) → the logo as save_receipt_settings takes it. */
export function makeLogo(rgba: ArrayLike<number>, width: number, height: number): ReceiptLogo {
  const bits = ditherFloydSteinberg(grayscale(rgba, width, height), width, height)
  return { width, height, data: toBase64(packBits(bits, width, height)) }
}
