// Pairs this computer's print agent like a tablet (spec 2026-11-22 §2): asks pos-device-activation
// for a code, shows it, polls every 5 s until HQ approves it in Craft OS → Devices (kind: Print agent),
// then keeps the device's sign-in in tools/print-agent/.device.json (git-ignored, 0600).
// Run:  node --env-file=tools/print-agent/.env tools/print-agent/pair.ts [name]
import { hostname } from 'node:os'
import { assertDevDatabase } from '../../src/features/pos/guard.ts'
import { activationClient } from './activationClient.ts'
import { hasDeviceFile, writeDeviceFile } from './deviceFile.ts'
import { agentName, runPair } from './pairing.ts'

function env(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key} in tools/print-agent/.env`)
  return value
}

const url = env('SUPABASE_URL')
assertDevDatabase(url)
const client = activationClient(url, env('SUPABASE_ANON_KEY'))
const code = await runPair(agentName(process.argv[2], hostname()), {
  paired: () => hasDeviceFile(),
  request: (name) => client.request(name),
  poll: (p) => client.poll(p),
  save: (file) => writeDeviceFile(file),
  log: (line) => console.log(line),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => new Date(),
})
process.exit(code)
