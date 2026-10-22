import net from 'node:net'

/** Sends raw bytes to a printer on TCP (default port 9100). Resolves only once
 *  the bytes were flushed to the socket without error; rejects if the printer
 *  is unreachable, resets the connection, or does not answer within 5 s. */
export function sendRaw(address: string, bytes: Uint8Array): Promise<void> {
  const [host, port = '9100'] = address.split(':')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) })
    let settled = false
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err)
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
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
        setTimeout(succeed, LINGER_MS).unref()
      }),
    )
  })
}
