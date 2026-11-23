// tools/print-agent/.device.json: the print agent's device account (git-ignored, mode 0600).
// Written once by the pair command; deleting it is how the agent is paired again.
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDeviceFile, type DeviceFile } from './pairing.ts'

export const DEVICE_PATH = fileURLToPath(new URL('./.device.json', import.meta.url))

export function hasDeviceFile(path: string = DEVICE_PATH): boolean {
  return existsSync(path)
}

/** null when there is no file; throws when it is not a pairing. */
export function readDeviceFile(path: string = DEVICE_PATH): DeviceFile | null {
  if (!existsSync(path)) return null
  const file = parseDeviceFile(readFileSync(path, 'utf8'))
  if (!file) throw new Error(`${path} is not a print agent pairing. Delete it and pair again.`)
  return file
}

/** Owner-only (0600), complete before it appears, and never over an existing pairing: the JSON goes to a
 *  temp file next to the target, then a hard link makes it the target (EEXIST if one is there). */
export function writeDeviceFile(file: DeviceFile, path: string = DEVICE_PATH): void {
  const temp = join(dirname(path), `.device.json.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    chmodSync(temp, 0o600)   // the umask cannot widen it, but an odd one could narrow the create mode
    linkSync(temp, path)
  } finally {
    unlinkSync(temp)
  }
}
