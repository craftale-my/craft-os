// Explicit .ts extensions: the Node print agent loads this file directly (no bundler).
import { textBlocks, type DocBlock, type PrintDoc } from './doc.ts'
import { fromBase64 } from './logo.ts'

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a
const QUESTION = 0x3f

/** Only printable ASCII goes through — anything else becomes "?". Chinese needs a printer-specific code
 *  page (GB18030 on Chinese models); whether the shop's printers support it is a spike question. */
function pushText(out: number[], text: string): void {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? QUESTION
    out.push(code >= 0x20 && code < 0x7f ? code : QUESTION)
  }
}

function pushAll(out: number[], bytes: ArrayLike<number>): void {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i])
}

/** GS v 0, mode 0: width in bytes and height in dots (little endian), then the raster rows. */
function pushRaster(out: number[], width: number, height: number, data: string): void {
  const row = Math.ceil(width / 8)
  out.push(GS, 0x76, 0x30, 0x00, row & 0xff, row >> 8, height & 0xff, height >> 8)
  pushAll(out, fromBase64(data))
}

/** GS ( k: QR model 2, module size 6, error correction M; the data stored as UTF-8, then printed. */
function pushQr(out: number[], data: string): void {
  const d = new TextEncoder().encode(data)
  const n = d.length + 3
  out.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)   // model 2
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06)         // module size 6
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31)         // error correction M
  out.push(GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30)   // store the data
  pushAll(out, d)
  out.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30)         // print it
}

/** One block. `small`: the document is in Font B; `size`: the body's GS ! value (0x01 for large). */
function pushBlock(out: number[], b: DocBlock, small: boolean, size: number): void {
  switch (b.type) {
    case 'text':
      if (!b.big) {
        pushText(out, b.text)
        out.push(LF)
        return
      }
      out.push(ESC, 0x61, 0x01)                 // ESC a 1: centre
      if (small) out.push(ESC, 0x4d, 0x00)      // the big line in Font A
      out.push(GS, 0x21, 0x11)                  // GS ! 0x11: double width and height
      pushText(out, b.text)
      out.push(LF)
      out.push(GS, 0x21, size)                  // back to the body's size
      if (small) out.push(ESC, 0x4d, 0x01)
      out.push(ESC, 0x61, 0x00)                 // ESC a 0: left
      return
    case 'image':
      out.push(ESC, 0x61, 0x01)
      pushRaster(out, b.width, b.height, b.data)
      out.push(ESC, 0x61, 0x00)
      return
    case 'qr':
      out.push(ESC, 0x61, 0x01)
      pushQr(out, b.data)
      out.push(ESC, 0x61, 0x00)
      return
    case 'pulse':
      out.push(ESC, 0x70, 0x00, 25, 250)        // ESC p 0 25 250: drawer pin 2, 50 ms on, 500 ms off
      return
  }
}

/** Raw bytes of a document for a generic ESC/POS printer on TCP 9100 (the print agent, W4 spec §4):
 *  ESC @, the font (small: ESC M 1, Font B; large: GS ! 0x01, double height), the blocks, then — when
 *  the document has paper — feed and cut. */
export function encodeEscPosDoc(doc: PrintDoc, opts: { feed?: number; cut?: boolean } = {}): Uint8Array {
  const out: number[] = [ESC, 0x40]
  const small = doc.fontSize === 'small'
  const size = doc.fontSize === 'large' ? 0x01 : 0x00
  if (small) out.push(ESC, 0x4d, 0x01)
  if (size) out.push(GS, 0x21, size)
  for (const b of doc.blocks) pushBlock(out, b, small, size)
  if (doc.paper) {
    out.push(ESC, 0x64, opts.feed ?? 4)
    if (opts.cut ?? true) out.push(GS, 0x56, 0x42, 0x00)
  }
  return Uint8Array.from(out)
}

/** Plain lines, normal font, fed and cut (the bytes the agent sent before W4). */
export function encodeEscPos(lines: string[], opts: { feed?: number; cut?: boolean } = {}): Uint8Array {
  return encodeEscPosDoc({ fontSize: 'normal', paper: true, blocks: textBlocks(lines) }, opts)
}
