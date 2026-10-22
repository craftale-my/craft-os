import net from 'node:net'

/** Sends raw bytes to a printer on TCP (default port 9100). Rejects if the
 *  printer is unreachable or does not answer within 5 s. */
export function sendRaw(address: string, bytes: Uint8Array): Promise<void> {
  const [host, port = '9100'] = address.split(':')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) })
    socket.setTimeout(5000)
    socket.on('connect', () =>
      socket.end(Buffer.from(bytes), () => {
        socket.destroy()
        resolve()
      }),
    )
    socket.on('timeout', () => socket.destroy(new Error(`Printer ${address} did not answer within 5 s`)))
    socket.on('error', reject)
  })
}
