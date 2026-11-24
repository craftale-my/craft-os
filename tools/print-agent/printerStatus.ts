import net from 'node:net'

/** ESC/POS real-time status (DLE EOT n). The printer answers one byte and
 *  prints nothing. Every valid reply has bit 1 and bit 4 set and bits 0 and 7
 *  clear (0x12 under the mask 0x93); anything else is not a status byte.
 *  Raw TCP 9100 accepts ticket bytes with no paper loaded, so this is the only
 *  way to tell "sent" from "nowhere to print" (seen on the ZyWell ZY301,
 *  2026-10-22: 9 tickets recorded printed while the roll was empty). */

const DLE = 0x10
const EOT = 0x04
export const ERROR_STATUS = 2 // cover, paper-end stop, error
export const PAPER_STATUS = 4 // paper near end, paper end

export function isStatusByte(b: number): boolean {
  return (b & 0x93) === 0x12
}

export interface PrinterCheck {
  /** false → do not send the ticket; record a failure with `reason`. */
  ok: boolean
  reason: string | null
  /** Printing can go ahead, but someone should look (e.g. paper low). */
  warnings: string[]
}

/** Combines the replies to DLE EOT 2 and DLE EOT 4. null = no reply. */
export function interpretStatus(errorByte: number | null, paperByte: number | null): PrinterCheck {
  const warnings: string[] = []
  if (errorByte !== null && isStatusByte(errorByte)) {
    if (errorByte & 0x04) return { ok: false, reason: 'printer cover is open', warnings }
    if (errorByte & 0x20) return { ok: false, reason: 'printer is out of paper', warnings }
    if (errorByte & 0x40) return { ok: false, reason: 'printer reports an error', warnings }
  } else {
    warnings.push('printer did not report its cover/error status')
  }
  if (paperByte !== null && isStatusByte(paperByte)) {
    if (paperByte & 0x60) return { ok: false, reason: 'printer is out of paper', warnings }
    if (paperByte & 0x0c) warnings.push('paper is running low')
  } else {
    warnings.push('printer did not report its paper status')
  }
  return { ok: true, reason: null, warnings }
}

/** Sends DLE EOT n and resolves with the reply byte, or null if none arrives
 *  within `timeoutMs`. Rejects only if the printer cannot be reached at all. */
export function queryStatus(address: string, n: number, timeoutMs = 2000): Promise<number | null> {
  const [host, port = '9100'] = address.split(':')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) })
    let settled = false
    const done = (value: number | null, err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    timer.unref()
    socket.on('error', (err) => done(null, err))
    socket.on('data', (buf: Buffer) => done(buf[0]))
    socket.on('close', () => done(null))
    socket.on('connect', () => socket.write(Buffer.from([DLE, EOT, n])))
  })
}

/** Asks for cover/error and paper status, one query after the other (the
 *  printer takes one connection at a time). */
export async function checkPrinter(address: string, timeoutMs = 2000): Promise<PrinterCheck> {
  const errorByte = await queryStatus(address, ERROR_STATUS, timeoutMs)
  const paperByte = await queryStatus(address, PAPER_STATUS, timeoutMs)
  return interpretStatus(errorByte, paperByte)
}
