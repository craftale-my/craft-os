const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a
const QUESTION = 0x3f

/** Raw bytes for a generic ESC/POS printer on TCP 9100 (used by the print
 *  agent). Only printable ASCII goes through — anything else becomes "?".
 *  Chinese needs a printer-specific code page (GB18030 on Chinese models);
 *  whether the shop's printers support it is a spike question, not solved here. */
export function encodeEscPos(lines: string[], opts: { feed?: number; cut?: boolean } = {}): Uint8Array {
  const bytes: number[] = [ESC, 0x40]
  for (const line of lines) {
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? QUESTION
      bytes.push(code >= 0x20 && code < 0x7f ? code : QUESTION)
    }
    bytes.push(LF)
  }
  bytes.push(ESC, 0x64, opts.feed ?? 4)
  if (opts.cut ?? true) bytes.push(GS, 0x56, 0x42, 0x00)
  return Uint8Array.from(bytes)
}
