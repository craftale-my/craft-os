# Print agent pairing (D) and the device switch-over (C3) — design

Date: 2026-11-22 · Branch: `feature/pos-demo` · Owner approved the design in chat on 2026-11-22.
Parent design: `docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md` (§2 devices, §4 server checks,
Amendments: build order B → C → D, C3 after D). Readiness: W1 Part C, W6 Part D.

## 1. Goal

The print agent stops depending on a staff email and password: it pairs like a tablet and prints for the outlet it
was approved for. Then the transition ends: front-of-house work (till, money, voids, refunds, shifts, printing) runs
only on activated devices; a staff email login keeps the back office only.

Out of scope: native apps, offline PIN sign-in, a customer display, kiosks, prod rollout (prod has no POS yet).

## 2. D — print agent pairing

- **Server side exists:** `pos_devices.kind` allows `print_agent`; the activation Edge Function
  `pos-device-activation` (request / poll) and Craft OS Devices → Pending requests already approve a request with
  platform `agent` as kind **Print agent** for an outlet. D changes no activation SQL unless the code shows a gap.
- **Pair command:** `node --env-file=tools/print-agent/.env tools/print-agent/pair.ts [name]` (the `.env` holds
  only `SUPABASE_URL` and `SUPABASE_ANON_KEY` now). It requests activation with platform `agent` and the given
  name (default: the computer's host name), prints
  `Pairing code: ABC-123 — approve it in Craft OS → Devices (kind: Print agent).`, polls every 5 s, and on approval
  writes the returned credentials to `tools/print-agent/.device.json` (git-ignored, file mode 0600):
  `{ "email", "password", "deviceId", "pairedAt" }`, then prints `Paired. Start the agent with: …`. Rejected or
  expired: it says so and exits 1. An existing `.device.json` → `Already paired. Delete .device.json to pair again.`
- **Agent start:** `agent.ts` signs in with `.device.json`. It finds its outlet from its own `pos_devices` row
  (no `BRANCH_ID`); the env `BRANCH_ID`, `AGENT_EMAIL`, `AGENT_PASSWORD` are no longer read. With no
  `.device.json`: `Not paired. Run: node --env-file=tools/print-agent/.env tools/print-agent/pair.ts` and exit 1.
- **Unpaired / revoked:** a failed sign-in or a refused print RPC that says the device is unpaired stops the agent
  with `This print agent was unpaired — run the pair command again.` (exit 1).
- The agent reads `print_routes` and claims jobs of its own outlet only (printing-device rules of the parent design
  §4: active device of kind `pos` or `print_agent`, no staff session needed). The plan confirms every read the agent
  makes is allowed for a device account (RLS) and fixes any gap.
- README rewritten for pairing; `.env.example` reduced.

## 3. C3 — switch-over

- **End the TRANSITION** in `migration-2026-10-29-pos-device-till.sql` (and anything re-created since): `pos_ctx`
  no longer accepts a staff login at its home branch; `pos_print_branch` no longer falls back to `pos_my_branch`;
  the write path marked TRANSITION refuses a staff login. A staff email login calling a front-of-house RPC gets the
  coded refusal (`device_unpaired` style) that the POS app already maps to plain words.
- **Back office keeps working** for staff logins: settings, menu editor, reports, Devices, outlets, staff outlets,
  PIN set/clear, test print from POS Settings (the plan checks `insert_test_print` and every back-office function
  still on `pos_my_branch` / `auth.uid()` and lists what changes). Nothing a manager does in Craft OS may break.
- **Craft OS `/pos`** (the till page inside Craft OS) shows `The POS has moved to its own app.` with the POS app
  address (dev: `https://craft-pos-dev.vercel.app`, prod later; from an env setting `VITE_POS_APP_URL`, fallback
  text without a link) and a line `Activate a tablet: open the address on it and approve it in Devices.` The
  POS nav keeps Reports, Menu, POS Settings, Devices; the till entry goes to the notice.
- **Open must-dos** from earlier reviews that belong to C3 (`.superpowers/sdd/progress.md`: Plan B FINAL REVIEW,
  device-till Task 1/2 minors) are listed in the plan and either done here or explicitly left with a reason.
- **Order of rollout:** D SQL first, then pair every print agent (and make sure every outlet's browser-printed
  routes have a POS-app tablet set to print), then deploy the new Craft OS build with the notice, then the C3 SQL
  last. Before the C3 SQL, check that every print route is covered: an `agent` route needs an active `print_agent`
  device at its outlet, any other route an active `pos` device with `prints` there (the query is in plan Task 6
  Step 6; every row `covered = true`). The order was changed after the final review: the new Craft OS build does
  not depend on C3, so it goes first, and C3 goes last. The server cannot tell whether a staff-login agent is
  still running somewhere, so the readiness doc carries this order.

## 4. Testing

- Unit tests: pair command (request / poll / approved / rejected / expired / already paired, file written 0600),
  agent start with and without `.device.json`, unpaired handling, the `/pos` notice.
- SQL verify (rolled back, dev): a staff login calling `open_table`, `checkout_bill`, `claim_print_job` is refused;
  a POS device with a session is allowed; a print-agent device claims its own outlet's jobs and not another's;
  back-office RPCs still work for a staff login (save settings, test print, reports).
- Dev: pair the agent from this Mac against dev (approve in craft-os-dev Devices), run it, see it claim jobs (the
  office printer only on the office network); the POS app on 5179 still sells; Craft OS `/pos` shows the notice.
- Owner, later: real iPad / Android add-to-home-screen and offline launch; pair the office computer's agent.
