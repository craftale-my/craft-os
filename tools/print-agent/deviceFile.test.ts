import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEVICE_PATH, hasDeviceFile, readDeviceFile, writeDeviceFile } from './deviceFile.ts'

const file = { email: 'device-1@devices.invalid', password: 'pw', deviceId: 'dev-1', pairedAt: '2026-11-22T10:00:00.000Z' }
let dir = ''
const tmp = () => { dir = mkdtempSync(join(tmpdir(), 'print-agent-')); return join(dir, '.device.json') }
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })

describe('the device file', () => {
  it('lives next to the agent and is git-ignored', () => {
    expect(DEVICE_PATH.endsWith('/tools/print-agent/.device.json')).toBe(true)
    const ignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8').split('\n')
    expect(ignore).toContain('tools/print-agent/.device.json')
  })
  it('is written with mode 0600 and read back', () => {
    const path = tmp()
    expect(hasDeviceFile(path)).toBe(false)
    expect(readDeviceFile(path)).toBeNull()
    writeDeviceFile(file, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(hasDeviceFile(path)).toBe(true)
    expect(readDeviceFile(path)).toEqual(file)
    expect(readdirSync(dir)).toEqual(['.device.json'])   // no temp file left
  })
  it('never overwrites a pairing', () => {
    const path = tmp()
    writeDeviceFile(file, path)
    expect(() => writeDeviceFile({ ...file, deviceId: 'dev-2' }, path)).toThrow(/EEXIST/)
    expect(readDeviceFile(path)?.deviceId).toBe('dev-1')
    expect(readdirSync(dir)).toEqual(['.device.json'])   // the refused write left no temp file
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
  it('a broken file says what to do', () => {
    const path = tmp()
    writeFileSync(path, '{"email":')
    expect(() => readDeviceFile(path)).toThrow(`${path} is not a print agent pairing. Delete it and pair again.`)
  })
})
