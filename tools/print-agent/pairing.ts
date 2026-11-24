// The print agent pairs like a tablet (spec 2026-11-22 §2): the words it prints, the .device.json
// shape, what a poll reply means, the pair loop and the agent's start. Every side effect (network,
// file, clock, console) is passed in, so Vitest runs all of it. Node runs this file as is (type
// stripping): explicit .ts imports, no enums, no parameter properties.
import { POLL_MS, retryableSignIn, type Pending, type PollReply } from '../../src/pos/activation.ts'

export const PAIR_COMMAND = 'node --env-file=tools/print-agent/.env tools/print-agent/pair.ts'
export const AGENT_COMMAND = 'node --env-file=tools/print-agent/.env tools/print-agent/agent.ts'

export const ALREADY_PAIRED = 'Already paired. Delete .device.json to pair again.'
export const PAIRED = `Paired. Start the agent with: ${AGENT_COMMAND}`
export const NOT_PAIRED = `Not paired. Run: ${PAIR_COMMAND}`
export const UNPAIRED = 'This print agent was unpaired — run the pair command again.'
export const WAITING = 'Waiting for approval…'
export const ENDED = {
  rejected: 'This request was rejected.',
  expired: 'This request expired.',
  unknown: 'This request is no longer valid. Run the pair command again.',
  wrong_kind: 'HQ approved this request as a POS tablet. Ask HQ to unpair it in Devices, then pair again and approve it as Print agent.',
}

export const pairingCodeLine = (code: string): string =>
  `Pairing code: ${code} — approve it in Craft OS → Devices (kind: Print agent).`

/** tools/print-agent/.device.json — the device account, written once by the pair command. */
export interface DeviceFile { email: string; password: string; deviceId: string; pairedAt: string }

export function parseDeviceFile(text: string): DeviceFile | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  for (const k of ['email', 'password', 'deviceId', 'pairedAt']) {
    if (typeof o[k] !== 'string' || o[k] === '') return null
  }
  return { email: o.email as string, password: o.password as string, deviceId: o.deviceId as string, pairedAt: o.pairedAt as string }
}

/** The name HQ sees in Devices: the argument, else this computer's host name; the function keeps 40 characters. */
export function agentName(arg: string | undefined, host: string): string | null {
  const name = (arg?.trim() || host.trim().replace(/\.local$/i, '')).slice(0, 40).trim()
  return name || null
}

export type PollStep = { kind: 'wait' } | { kind: 'paired'; file: DeviceFile; name: string } | { kind: 'stop'; message: string }

/** What a poll reply means for the agent. A device approved as a POS tablet is not kept. */
export function afterAgentPoll(reply: PollReply, now: Date): PollStep {
  switch (reply.status) {
    case 'pending': return { kind: 'wait' }
    case 'approved':
      if (reply.kind !== 'print_agent') return { kind: 'stop', message: ENDED.wrong_kind }
      return {
        kind: 'paired', name: reply.name,
        file: { email: reply.email, password: reply.password, deviceId: reply.deviceId, pairedAt: now.toISOString() },
      }
    default: return { kind: 'stop', message: ENDED[reply.status] }
  }
}

/** An Error's message, a PostgREST error's message, or the value as text. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  return String(e)
}

/** A message as a sentence: a full stop is added unless it already ends with . ! or ?. */
const sentence = (m: string): string => (/[.!?]$/.test(m) ? m : `${m}.`)

export interface PairDeps {
  paired: () => boolean
  request: (name: string | null) => Promise<Pending>
  poll: (p: Pending) => Promise<PollReply>
  save: (file: DeviceFile) => void
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => Date
}

/** The pair command. Resolves to the process exit code. The password is never logged. */
export async function runPair(name: string | null, deps: PairDeps): Promise<number> {
  if (deps.paired()) { deps.log(ALREADY_PAIRED); return 1 }
  let pending: Pending
  try { pending = await deps.request(name) } catch (e) { deps.log(messageOf(e)); return 1 }
  deps.log(pairingCodeLine(pending.code))
  deps.log(WAITING)
  for (;;) {
    await deps.sleep(POLL_MS)
    let reply: PollReply
    try { reply = await deps.poll(pending) } catch (e) { deps.log(`${sentence(messageOf(e))} Trying again.`); continue }
    const step = afterAgentPoll(reply, deps.now())
    if (step.kind === 'wait') continue
    if (step.kind === 'stop') { deps.log(step.message); return 1 }
    try { deps.save(step.file) } catch (e) {
      // the approved reply comes once: the device exists but this computer could not keep its sign-in
      deps.log(`Could not save .device.json (${messageOf(e)}). Ask HQ to unpair "${step.name}" in Devices and pair again.`)
      return 1
    }
    deps.log(PAIRED)
    return 0
  }
}

/** pos_agent_whoami() (migration-2026-11-22-pos-agent-pairing.sql). */
export interface AgentWhoami { deviceId: string; deviceName: string; outletId: string; outletName: string }

export function parseWhoami(data: unknown): AgentWhoami {
  const o = (data ?? {}) as Record<string, unknown>
  if (typeof o.deviceId !== 'string' || typeof o.outletId !== 'string') throw new Error('pos_agent_whoami returned an unexpected reply')
  return { deviceId: o.deviceId, deviceName: String(o.deviceName ?? ''), outletId: o.outletId, outletName: String(o.outletName ?? '') }
}

/** The server's word for a device that may no longer work (unpaired, or not a print agent). */
export const isUnpairedError = (e: unknown): boolean => !!e && messageOf(e) === 'device_unpaired'

/** Supabase refused the login itself: HTTP 400 / 401 / 403, or an auth error code that says so. Nothing else is an unpairing. */
const REFUSED_STATUS = [400, 401, 403]
const REFUSED_CODES = ['invalid_credentials', 'user_banned', 'invalid_grant']
export function loginRefused(e: unknown): boolean {
  const { status, code } = (e ?? {}) as { status?: unknown; code?: unknown }
  return (typeof status === 'number' && REFUSED_STATUS.includes(status)) || (typeof code === 'string' && REFUSED_CODES.includes(code))
}

export interface StartDeps {
  readDevice: () => DeviceFile | null
  /** null when signed in; Supabase's error otherwise (its name tells a network failure). */
  signIn: (email: string, password: string) => Promise<Error | null>
  whoami: () => Promise<AgentWhoami>
}

export type AgentStart = { ok: true; who: AgentWhoami } | { ok: false; message: string }

/** The agent's start: .device.json → sign in → its outlet. */
export async function startAgent(deps: StartDeps): Promise<AgentStart> {
  let file: DeviceFile | null
  try { file = deps.readDevice() } catch (e) { return { ok: false, message: messageOf(e) } }
  if (!file) return { ok: false, message: NOT_PAIRED }
  let signInError: Error | null
  try { signInError = await deps.signIn(file.email, file.password) } catch (e) {
    signInError = e instanceof Error ? e : new Error(String(e))
  }
  if (signInError) {
    if (retryableSignIn(signInError)) return { ok: false, message: `Could not reach Supabase to sign in: ${signInError.message}` }
    if (loginRefused(signInError)) return { ok: false, message: UNPAIRED }
    return { ok: false, message: `Could not sign in: ${signInError.message}. Check the internet connection and start the agent again.` }
  }
  try {
    return { ok: true, who: await deps.whoami() }
  } catch (e) {
    if (isUnpairedError(e)) return { ok: false, message: UNPAIRED }
    return { ok: false, message: `Could not read this print agent's outlet: ${messageOf(e)}` }
  }
}
