// Explicit .ts extensions: the Node print agent loads this file directly (no bundler).

/** The receipt's font (W4 spec §3): small = the printer's Font B, large = double height. */
export type FontSize = 'small' | 'normal' | 'large'

/** One block of a printed document (W4 spec §4). `big`: double width and height, centred (a call number).
 *  An image is the logo raster (ReceiptLogo, print/logo.ts); a QR holds its text; a pulse kicks the drawer. */
export type DocBlock =
  | { type: 'text'; text: string; big?: boolean }
  | { type: 'image'; width: number; height: number; data: string }
  | { type: 'qr'; data: string }
  | { type: 'pulse' }

/** What a print job prints. `paper` false: nothing comes out (a drawer kick) — no feed, no cut. */
export interface PrintDoc {
  fontSize: FontSize
  paper: boolean
  blocks: DocBlock[]
}

/** Characters per line: Font B fits a third more (42 → 56; 32 → 42); normal and large keep `cols`. */
export function lineWidth(fontSize: FontSize, cols: number): number {
  return fontSize === 'small' ? Math.floor((cols * 4) / 3) : cols
}

export function textBlocks(lines: string[]): DocBlock[] {
  return lines.map((text) => ({ type: 'text', text }))
}

/** The text view of a document (tests, Epson ePOS, Star WebPRNT): big text centred as plain text at
 *  `cols`; images, QR codes and pulses left out. */
export function docText(doc: PrintDoc, cols: number): string[] {
  return doc.blocks.flatMap((b) => {
    if (b.type !== 'text') return []
    return b.big ? [' '.repeat(Math.max(0, Math.floor((cols - b.text.length) / 2))) + b.text] : [b.text]
  })
}

/** The document kicks the cash drawer. */
export function docPulses(doc: PrintDoc): boolean {
  return doc.blocks.some((b) => b.type === 'pulse')
}
