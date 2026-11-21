// Explicit .ts extensions: the Node print agent loads this file directly (no bundler).

/** The receipt logo as branch_pos_settings.receipt_logo and the receipt payload's header.logo hold it
 *  (W4 spec §3): a 1-bit raster, rows top to bottom, ceil(width / 8) bytes a row, most significant bit =
 *  leftmost dot, 1 = black; width a multiple of 8 up to 384, height up to 240; `data` is base64. */
export interface ReceiptLogo {
  width: number
  height: number
  data: string
}

export const LOGO_MAX_WIDTH = 384
export const LOGO_MAX_HEIGHT = 240

/** Base64 of raw bytes, no line breaks (btoa / atob: the browser and Node 16+ both have them). */
export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
  }
  return btoa(text)
}

export function fromBase64(text: string): Uint8Array {
  const raw = atob(text.replace(/\s+/g, ''))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
