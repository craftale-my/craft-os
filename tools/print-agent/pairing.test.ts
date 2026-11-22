import { describe, expect, it, vi } from 'vitest'
import type { Pending, PollReply } from '../../src/pos/activation.ts'
import {
  afterAgentPoll, agentName, ALREADY_PAIRED, ENDED, isUnpairedError, messageOf, NOT_PAIRED, PAIRED, pairingCodeLine,
  parseDeviceFile, parseWhoami, runPair, startAgent, UNPAIRED, WAITING, type DeviceFile, type PairDeps, type StartDeps,
} from './pairing.ts'

const NOW = new Date('2026-11-22T10:00:00.000Z')
const pending: Pending = { code: 'ABC-123', secret: 's3cret', expiresAt: '2026-11-23T10:00:00Z', name: 'Office Mac' }
const approved = (kind: string): PollReply => ({
  status: 'approved', deviceId: 'dev-1', email: 'device-1@devices.invalid', password: 'pw-secret', branchId: 'b-1', kind, name: 'Office Mac',
})
const file: DeviceFile = { email: 'device-1@devices.invalid', password: 'pw-secret', deviceId: 'dev-1', pairedAt: NOW.toISOString() }
const who = { deviceId: 'dev-1', deviceName: 'Office Mac', outletId: 'b-1', outletName: 'Demo' }

describe('the words (spec §2)', () => {
  it('prints the code, the commands and the outcomes exactly', () => {
    expect(pairingCodeLine('ABC-123')).toBe('Pairing code: ABC-123 — approve it in Craft OS → Devices (kind: Print agent).')
    expect(PAIRED).toBe('Paired. Start the agent with: node --env-file=tools/print-agent/.env tools/print-agent/agent.ts')
    expect(ALREADY_PAIRED).toBe('Already paired. Delete .device.json to pair again.')
    expect(NOT_PAIRED).toBe('Not paired. Run: node --env-file=tools/print-agent/.env tools/print-agent/pair.ts')
    expect(UNPAIRED).toBe('This print agent was unpaired — run the pair command again.')
    expect(ENDED.rejected).toBe('This request was rejected.')
    expect(ENDED.expired).toBe('This request expired.')
  })
})

describe('parseDeviceFile', () => {
  it('reads the four fields', () => {
    expect(parseDeviceFile(JSON.stringify(file))).toEqual(file)
  })
  it('refuses anything else', () => {
    expect(parseDeviceFile('not json')).toBeNull()
    expect(parseDeviceFile('null')).toBeNull()
    expect(parseDeviceFile(JSON.stringify({ ...file, password: '' }))).toBeNull()
    expect(parseDeviceFile(JSON.stringify({ email: 'e', password: 'p', deviceId: 'd' }))).toBeNull()
  })
})

describe('agentName', () => {
  it('takes the argument, else the host name without .local, at most 40 characters', () => {
    expect(agentName('  Cheras bar  ', 'host.local')).toBe('Cheras bar')
    expect(agentName(undefined, 'Craftales-MacBook-Air.local')).toBe('Craftales-MacBook-Air')
    expect(agentName('', 'office')).toBe('office')
    expect(agentName(undefined, 'x'.repeat(50))).toBe('x'.repeat(40))
    expect(agentName(undefined, '  ')).toBeNull()
  })
})

describe('afterAgentPoll', () => {
  it('waits while pending', () => {
    expect(afterAgentPoll({ status: 'pending' }, NOW)).toEqual({ kind: 'wait' })
  })
  it('keeps the credentials of a print agent, with the time', () => {
    expect(afterAgentPoll(approved('print_agent'), NOW)).toEqual({ kind: 'paired', file, name: 'Office Mac' })
  })
  it('does not keep a device approved as a POS tablet', () => {
    expect(afterAgentPoll(approved('pos'), NOW)).toEqual({ kind: 'stop', message: ENDED.wrong_kind })
  })
  it.each(['rejected', 'expired', 'unknown'] as const)('stops when %s', (status) => {
    expect(afterAgentPoll({ status }, NOW)).toEqual({ kind: 'stop', message: ENDED[status] })
  })
})

function pairDeps(replies: (PollReply | Error)[], over: Partial<PairDeps> = {}) {
  const lines: string[] = []
  const saved: DeviceFile[] = []
  const deps: PairDeps = {
    paired: () => false,
    request: vi.fn(async () => pending),
    poll: vi.fn(async () => {
      const r = replies.shift()
      if (!r) throw new Error('no more replies')
      if (r instanceof Error) throw r
      return r
    }),
    save: (f) => { saved.push(f) },
    log: (l) => { lines.push(l) },
    sleep: vi.fn(async () => undefined),
    now: () => NOW,
    ...over,
  }
  return { deps, lines, saved }
}

describe('runPair', () => {
  it('requests with the name, shows the code, polls every 5 s and saves on approval', async () => {
    const { deps, lines, saved } = pairDeps([{ status: 'pending' }, approved('print_agent')])
    expect(await runPair('Office Mac', deps)).toBe(0)
    expect(deps.request).toHaveBeenCalledWith('Office Mac')
    expect(deps.poll).toHaveBeenCalledTimes(2)
    expect(deps.sleep).toHaveBeenCalledWith(5000)
    expect(saved).toEqual([file])
    expect(lines).toEqual([pairingCodeLine('ABC-123'), WAITING, PAIRED])
    expect(lines.join('\n')).not.toContain('pw-secret')
  })
  it.each([['rejected', ENDED.rejected], ['expired', ENDED.expired]] as const)('says so and exits 1 when %s', async (status, message) => {
    const { deps, lines, saved } = pairDeps([{ status }])
    expect(await runPair(null, deps)).toBe(1)
    expect(saved).toEqual([])
    expect(lines.at(-1)).toBe(message)
  })
  it('refuses when already paired, without a request', async () => {
    const { deps, lines } = pairDeps([], { paired: () => true })
    expect(await runPair(null, deps)).toBe(1)
    expect(deps.request).not.toHaveBeenCalled()
    expect(lines).toEqual([ALREADY_PAIRED])
  })
  it('exits 1 with the function words when the request is refused', async () => {
    const { deps, lines } = pairDeps([], { request: async () => { throw new Error('Too many activation requests from this network. Try again in an hour.') } })
    expect(await runPair(null, deps)).toBe(1)
    expect(lines).toEqual(['Too many activation requests from this network. Try again in an hour.'])
  })
  it('keeps polling after a network failure', async () => {
    const { deps, lines, saved } = pairDeps([new TypeError('fetch failed'), approved('print_agent')])
    expect(await runPair(null, deps)).toBe(0)
    expect(lines).toContain('fetch failed Trying again.')
    expect(saved).toEqual([file])
  })
  it('says how to recover when the file cannot be saved, never printing the password', async () => {
    const { deps, lines } = pairDeps([approved('print_agent')], { save: () => { throw new Error('EEXIST: file already exists') } })
    expect(await runPair(null, deps)).toBe(1)
    expect(lines.at(-1)).toBe('Could not save .device.json (EEXIST: file already exists). Ask HQ to unpair "Office Mac" in Devices and pair again.')
    expect(lines.join('\n')).not.toContain('pw-secret')
  })
})

describe('parseWhoami and the error helpers', () => {
  it('reads pos_agent_whoami', () => {
    expect(parseWhoami(who)).toEqual(who)
    expect(() => parseWhoami({ deviceId: 'd' })).toThrow('pos_agent_whoami returned an unexpected reply')
  })
  it('knows device_unpaired from PostgREST and from an Error', () => {
    expect(isUnpairedError({ message: 'device_unpaired', code: 'P0001' })).toBe(true)
    expect(isUnpairedError(new Error('device_unpaired'))).toBe(true)
    expect(isUnpairedError({ message: 'Bill not found' })).toBe(false)
    expect(isUnpairedError(null)).toBe(false)
  })
  it('messageOf reads an Error, a PostgREST error or anything', () => {
    expect(messageOf(new Error('a'))).toBe('a')
    expect(messageOf({ message: 'b' })).toBe('b')
    expect(messageOf('c')).toBe('c')
  })
})

describe('startAgent', () => {
  const start = (over: Partial<StartDeps>) => startAgent({
    readDevice: () => file,
    signIn: async () => null,
    whoami: async () => who,
    ...over,
  })
  it('signs in with the file and returns the outlet', async () => {
    const signIn = vi.fn(async () => null)
    expect(await start({ signIn })).toEqual({ ok: true, who })
    expect(signIn).toHaveBeenCalledWith('device-1@devices.invalid', 'pw-secret')
  })
  it('without .device.json: Not paired', async () => {
    expect(await start({ readDevice: () => null })).toEqual({ ok: false, message: NOT_PAIRED })
  })
  it('a broken .device.json says what is wrong', async () => {
    expect(await start({ readDevice: () => { throw new Error('broken') } })).toEqual({ ok: false, message: 'broken' })
  })
  it('a refused sign-in (banned, wrong password) means unpaired', async () => {
    const banned = Object.assign(new Error('User is banned'), { name: 'AuthApiError' })
    expect(await start({ signIn: async () => banned })).toEqual({ ok: false, message: UNPAIRED })
  })
  it('a sign-in with no reply is not an unpairing', async () => {
    const offline = Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' })
    expect(await start({ signIn: async () => offline })).toEqual({ ok: false, message: 'Could not reach Supabase to sign in: fetch failed' })
    expect(await start({ signIn: async () => { throw new TypeError('fetch failed') } }))
      .toEqual({ ok: false, message: 'Could not reach Supabase to sign in: fetch failed' })
  })
  it('device_unpaired from pos_agent_whoami means unpaired; another error is reported', async () => {
    expect(await start({ whoami: async () => { throw { message: 'device_unpaired' } } })).toEqual({ ok: false, message: UNPAIRED })
    expect(await start({ whoami: async () => { throw { message: 'Could not find the function public.pos_agent_whoami' } } }))
      .toEqual({ ok: false, message: "Could not read this print agent's outlet: Could not find the function public.pos_agent_whoami" })
  })
})
