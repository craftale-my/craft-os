// Browser-only image work for Claim Desk: phone-photo clean-up, A4 PDFs,
// and shrinking images before they go to the AI. Ported from the prototype.
import { slicePlan } from './claimDesk'

export type ScanMode = 'doc' | 'bw' | 'color'

export interface ScanPage {
  img: HTMLImageElement | HTMLCanvasElement
  rot: number
  mode: ScanMode
}

export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image')) }
    img.src = url
  })
}

const dims = (src: HTMLImageElement | HTMLCanvasElement) =>
  src instanceof HTMLImageElement ? { w: src.naturalWidth || src.width, h: src.naturalHeight || src.height } : { w: src.width, h: src.height }

/**
 * Rotate, then (unless mode = color) estimate the paper background from a blurred
 * copy and divide it out — that removes phone shadows — and stretch the contrast.
 * 'bw' thresholds to pure black and white.
 */
export function processPage(p: ScanPage): HTMLCanvasElement {
  const max = 2000
  let { w, h } = dims(p.img)
  const s = Math.min(1, max / Math.max(w, h))
  w = Math.round(w * s); h = Math.round(h * s)
  const swap = p.rot % 180 !== 0
  const c = document.createElement('canvas')
  c.width = swap ? h : w; c.height = swap ? w : h
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
  g.translate(c.width / 2, c.height / 2); g.rotate(p.rot * Math.PI / 180); g.drawImage(p.img, -w / 2, -h / 2, w, h)
  g.setTransform(1, 0, 0, 1, 0, 0)
  if (p.mode === 'color') return c

  const sw = Math.max(8, Math.round(c.width / 28)), sh = Math.max(8, Math.round(c.height / 28))
  const t = document.createElement('canvas'); t.width = sw; t.height = sh
  const tg = t.getContext('2d')!; tg.imageSmoothingQuality = 'high'; tg.drawImage(c, 0, 0, sw, sh)
  const b = document.createElement('canvas'); b.width = c.width; b.height = c.height
  const bgc = b.getContext('2d', { willReadFrequently: true })!; bgc.imageSmoothingQuality = 'high'; bgc.drawImage(t, 0, 0, c.width, c.height)
  const bg = bgc.getImageData(0, 0, c.width, c.height).data
  const img = g.getImageData(0, 0, c.width, c.height), a = img.data, n = a.length / 4
  const lum = new Float32Array(n); const hist = new Uint32Array(256)
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const y = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]
    const by = Math.max(24, 0.299 * bg[i] + 0.587 * bg[i + 1] + 0.114 * bg[i + 2])
    const v = Math.min(255, (y / by) * 235); lum[j] = v; hist[v | 0]++
  }
  const pct = (q: number) => { let acc = 0; const lim = n * q; for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= lim) return k } return 255 }
  const lo = pct(0.01), hi = Math.max(lo + 20, pct(0.6))
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    let v = (lum[j] - lo) / (hi - lo); v = v < 0 ? 0 : v > 1 ? 1 : v
    v = p.mode === 'bw' ? (v > 0.62 ? 1 : 0) : v * v * (3 - 2 * v)
    a[i] = a[i + 1] = a[i + 2] = v * 255
  }
  g.putImageData(img, 0, 0)
  return c
}

/** Each canvas centred on its own A4 page with a 6 mm margin. */
export async function canvasesToPdf(canvases: HTMLCanvasElement[]): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' })
  canvases.forEach((c, i) => {
    if (i) pdf.addPage()
    const m = 6, W = 210 - 2 * m, H = 297 - 2 * m, r = Math.min(W / c.width, H / c.height), w = c.width * r, h = c.height * r
    pdf.addImage(c.toDataURL('image/jpeg', 0.82), 'JPEG', (210 - w) / 2, (297 - h) / 2, w, h)
  })
  return pdf.output('blob')
}

export interface AiImage { media_type: 'image/jpeg'; data: string }

const toBase64Jpeg = (c: HTMLCanvasElement, q = 0.82) => c.toDataURL('image/jpeg', q).split(',')[1]

/** Shrink (and cut long screenshots into bands) so the request stays small and the text readable. */
export function canvasForAi(src: HTMLImageElement | HTMLCanvasElement): AiImage[] {
  const { w, h } = dims(src)
  return slicePlan(w, h).map(({ sy, sh, scale }) => {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(sh * scale))
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
    g.drawImage(src, 0, sy, w, sh, 0, 0, c.width, c.height)
    return { media_type: 'image/jpeg' as const, data: toBase64Jpeg(c) }
  })
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

/** A small preview canvas for thumbnails. */
export function thumbnail(src: HTMLCanvasElement | HTMLImageElement, size = 300): HTMLCanvasElement {
  const { w, h } = dims(src)
  const r = size / Math.max(w, h)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * r)); c.height = Math.max(1, Math.round(h * r))
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  return c
}

/** Save a Blob as a normal browser download. */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
