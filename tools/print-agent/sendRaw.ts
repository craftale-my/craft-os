import net from 'node:net'

/** Sends raw bytes to a printer on TCP (default port 9100).
 *
 *  Resolves when the bytes were flushed and the connection then closed cleanly,
 *  or when LINGER_MS (1 s) has passed after the flush without an error.
 *  Rejects if the printer is unreachable, the connection errors or is reset,
 *  the printer closes early (before the flush completes or with an error), or
 *  it does not answer within 5 s.
 *
 *  Raw TCP 9100 has no acknowledgement: a reset that arrives later than
 *  LINGER_MS cannot be detected, so a print is only "sent", never "confirmed". */
export function sendRaw(address: string, bytes: Uint8Array): Promise<void> {
  const [host, port = '9100'] = address.split(':')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) })
    let settled = false
    let lingerTimer: ReturnType<typeof setTimeout> | undefined
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(lingerTimer)
      socket.destroy()
      reject(err)
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      clearTimeout(lingerTimer)
      socket.destroy()
      resolve()
    }
    socket.setTimeout(5000)
    // Stays attached for the socket's lifetime so a late error cannot crash the process.
    socket.on('error', fail)
    socket.on('timeout', () => fail(new Error(`Printer ${address} did not answer within 5 s`)))
    // A successful flush only means the kernel accepted the bytes. Linger briefly
    // so a reset or early close from the printer is reported instead of hidden.
    const LINGER_MS = 1000
    let flushed = false
    socket.on('close', (hadError) => {
      if (flushed && !hadError) succeed()
      else fail(new Error(`Printer ${address} closed the connection before the ticket was sent`))
    })
    socket.on('connect', () =>
      socket.end(Buffer.from(bytes), (err?: Error | null) => {
        if (err) return fail(err)
        flushed = true
        lingerTimer = setTimeout(succeed, LINGER_MS)
        lingerTimer.unref()
      }),
    )
  })
}
