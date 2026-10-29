# POS devices, PIN login and outlets (design)

Date: 2026-10-29. Branch `feature/pos-demo`. Builds on the Feedme-layout POS (`2026-10-26-pos-feedme-frontend-design.md`) and the hardening spec (`2026-10-25-pos-hardening-design.md`).

## Owner decisions (2026-10-29)

- **Approach A:** every tablet has its own device account; staff unlock it with a PIN, which opens a staff session on that device. Every POS action is checked on the server against device → outlet and session → staff.
- **The POS becomes its own app**, separate from Craft OS, in the same repo and on the same Supabase.
- **Activation the Feedme way:** a newly installed app cannot be used until HQ approves it. Only HQ (staff with `all_branches`) approves activations.
- **Outlet types:** Branch, Kiosk (a small fixed stall with its own staff and cash drawer) and Pop-up (temporary, with dates). A self-order machine is out of scope.
- **Who may work where:** the staff member's role has the new `pos_login` permission, AND the outlet is their home branch or one a manager added for them. `all_branches` staff may work at every outlet.
- **One PIN per person**, valid at every outlet they may work at, like Feedme.
- **Login screen:** tap your name, then enter your PIN.
- **Menus:** a new outlet picks from the existing catalogs; there are no per-outlet products.
- **Unpairing:** HQ may unpair any device. Staff with `access_settings` may unpair devices of outlets in their scope.

## Facts this design starts from (feature/pos-demo, 2026-10-29)

- About 28 POS RPCs get the branch from `pos_my_branch()` (auth.uid() → `staff.branch_id`, active staff only). Branch-scoped RLS uses `pos_caller_branch()`. The actor is always `auth.uid()`.
- The read policies on `bills`, `orders`, `order_items`, `payments`, `refunds`, `print_jobs`, `pos_shifts` and `pos_cash_moves` are `for select to authenticated using (true)`. Any signed-in staff member can read every branch. Writes go only through security-definer RPCs, which are branch-scoped.
- PINs (`staff_pos_pins`, bcrypt) are approval secrets only: 4–6 digits, five wrong tries per (approver, caller) pair lock for 10 minutes (`pos_pin_attempts`). Nothing logs in with a PIN today.
- `staff.branch_id` holds a single branch. No staff↔branch link table exists.
- Vite already builds two entries, `index.html` (Craft OS) and `qr/index.html` (customer QR at `/t/…`). There is no PWA manifest and no service worker.
- The print agent signs in with a staff email and password and must match `BRANCH_ID`.
- The offline order queue (IndexedDB `craft-pos-v2`) stores neither staff nor branch. A different login on the same tablet would send someone else's queued orders under the new identity.
- Prod has no POS data yet: the POS SQL chain has not run on prod, so there is no live POS to migrate.

## 1. Outlets and who may work where

**An outlet is a `branches` row.** HR, clock-in, catalogs, print routes, bill numbers and shifts are all keyed by branch, so no parallel table is created. New columns on `branches`:
- `kind text not null default 'branch'`, one of `branch | kiosk | popup`.
- `opens_on date null`, `closes_on date null`, required for `popup` and null otherwise; `closes_on >= opens_on`.
- `bill_prefix text null`, 1–4 upper-case letters or digits. When set, bill numbers become `<prefix>-YYMMDD-NNN`; when null they stay `YYMMDD-NNN`. Prefixes are unique among outlets.

An outlet is **open for POS** when `is_active` holds and, for a pop-up, today's date (Asia/Kuala_Lumpur) lies between `opens_on` and `closes_on`. A closed pop-up keeps its bills, shifts and reports, but its devices cannot sign anyone in.

Each outlet keeps its own print routes, catalog assignments (`branch_catalogs`), service charge, payment methods, shifts, cash drawer and reports, exactly as branches do today. The pop-up and kiosk menus come from the existing catalogs.

**Extra outlets:** a new table `staff_outlets(staff_id, branch_id, added_by, added_at)` with primary key `(staff_id, branch_id)`. Staff with `access_settings` add and remove rows for outlets in their scope, on the staff member's page in Craft OS.

**New capability `pos_login`.** It is listed on the existing role permissions page. Defaults: on for owner, admin, manager, supervisor and staff; off for hr.

**A staff member may work at an outlet** (function `pos_staff_may_work(staff_id, branch_id)`) when they are active (`is_active and status = 'active'`), have `pos_login`, and the outlet is their `staff.branch_id`, has a `staff_outlets` row for them, or they have `all_branches`.

**The supervisor approval rule** (`pos_check_approver`) changes from "same branch" to `pos_staff_may_work(approver, outlet)` plus `pos_supervise`.

**Outlet scope of a back-office user** (`staff_outlet_scope(staff_id)`): the home branch plus `staff_outlets`, or every outlet with `all_branches`.

Back office (Craft OS, POS Settings → Outlets): staff with `all_branches` create outlets and set the kind, dates and bill prefix. Staff with `access_settings` edit the other settings of outlets in their scope, as they do today.

## 2. Activation, PIN login, lock

### Device records

- `pos_devices`:
  - `id uuid pk` equals the device's own `auth.users.id`.
  - `branch_id`, `kind` (`pos | print_agent`), `name`, `platform` (`ipad | android | other | agent`).
  - `approved_by`, `approved_at`, `last_seen_at`, `revoked_at`, `revoked_by`.
- `pos_device_requests`:
  - `id`, `code` (7 characters `XXX-XXX`, unambiguous alphabet), `secret_hash`, `name`, `platform`.
  - `status` (`pending | approved | rejected | expired`), `created_at`, `expires_at` (`created_at + 24 h`), `device_id null`, `decided_by`.

Device accounts are Supabase auth users with no `staff` row, so they cannot use Craft OS. Their email is synthetic (`device-<uuid>@devices.invalid`) and their password random. Both are created by an Edge Function using the service role and are never shown to anyone.

### Activation flow

1. **Request.** On first launch the app shows **"This device isn't activated"**. It calls the Edge Function `pos-device-activation` (`action: request`, anon allowed) with an optional name and the detected platform. The function creates a pending request and returns its `code` and a random `secret`. The app keeps the secret; the server stores only its hash. The screen shows the code, the name and "Waiting for approval".
2. **Approve or reject.** HQ (`all_branches`) opens Craft OS **Devices → Pending requests**, which shows the code, name, platform and time. To approve, HQ types or confirms the code shown on the tablet, picks the outlet and the kind (POS or Print agent), edits the name, then presses **Approve**. **Reject** is the other choice.
3. **Activate.** While its screen is open, the tablet polls the function (`action: poll`, with code and secret) every 5 s. On approval, the function creates the auth user and the `pos_devices` row and returns the credentials once. The tablet signs in and stores the session in the POS app's own storage key. The request is marked `approved` and links `device_id`; a later poll returns nothing.
4. **Expiry and abuse limits.** A request expires 24 h after creation and then needs **Request again**. The function allows at most 5 requests per IP per hour and at most 50 pending requests at a time. A poll without the matching secret gets the same reply as an unknown code.

**Unpair.** HQ may unpair any device. A staff member with `access_settings` may unpair devices of outlets in their scope, from Devices in Craft OS or from **Unpair this device** in the POS app's settings (needs a session of such a staff member). Unpairing sets `revoked_at`, bans the auth user, and ends any open staff session. Every server check refuses a revoked device at once.

**Moving a device to another outlet** is unpair plus a new activation.

The **Devices** page in Craft OS lists name, outlet, kind, platform, approved by and when, last seen, and revoked state. Outlet-scoped staff see only their outlets.

### PIN login and staff sessions

- `pos_staff_sessions(id, device_id, staff_id, started_at, last_active_at, ended_at null, end_reason)`. At most one open session per device; starting a new one ends the old one (`end_reason = 'switched'`).
- **Lock screen.** It shows the outlet and device names and the roster from `pos_login_roster()`. The roster is every staff member who may work at this outlet (§1), giving `id`, `name` and `has_pin` only. Names without a PIN are greyed with "Set a PIN in Craft OS first".
- **Sign in.** Tap a name, then type the PIN on the keypad. `pos_start_session(staff_id, pin)` checks, in order: the device is active, the outlet is open for POS, the staff member may work here, and the PIN is correct. Then it opens the session.
- **PIN lockout at login** is per staff member, across all devices. Each try is recorded in `pos_login_attempts(staff_id, device_id, at, ok)`, which clients cannot read. Five wrong tries since that person's last successful sign-in, within 24 h, lock their sign-in for 10 minutes on every device. A success clears the count.
- **Setting a PIN** stays in Craft OS (**My PIN**, `set_my_pos_pin`). `clear_pos_pin` stays with `access_settings`, now checked against the outlet scope.
- **Lock.** Tap the staff name on the bottom bar, then **Lock**. This calls `pos_end_session` (`end_reason = 'locked'`). The next person signs in from the roster.
- **Auto-lock.** After a period with no touch the app ends the session (`end_reason = 'idle'`). The period is a per-outlet setting in POS Settings, 1–60 minutes, default 10. While the device is offline the idle timer is paused.
- **Offline.** PIN checks need the server, so nobody can sign in offline. The signed-in staff member keeps working; the offline order queue works as today. Pressing **Lock** while offline first asks "You're offline — nobody can sign in until the network is back." with **Lock anyway** / Cancel.
- **What locking keeps:** unsent drafts stay on the device and belong to whoever presses Send. An open Payment screen returns to home without taking money.
- **"Exit POS" is removed** from the staff panel. The POS app has no Craft OS to return to.

### Offline queue

A queued order also stores `staffId`, the signed-in staff member when it was queued. It is always sent by the same device, so it can only go to that device's outlet. The server records `placed_by = staffId` when that staff member may still work at the outlet, and otherwise the staff member of the current session.

### Approvals

Void, refund, pay out and cash variance still ask for an approver and the approver's PIN (ApprovalDialog, unchanged). The requester is now the session's staff member. The approval lockout keeps its (approver, caller) pairs, with the caller being the session's staff member.

## 3. The POS as its own app

- **Build.** A third Vite entry (`pos/index.html` → `src/pos/main.tsx`), following the QR entry. The POS screens stay in `src/features/pos` and are shared. A `build:pos` script produces a bundle whose `index.html` is the POS.
- **Hosting.** A second Vercel project **craft-pos**, from the same repository with the `build:pos` build, at `craft-pos.vercel.app`. A custom domain can be added later without code changes. Craft OS stays at `craft-os-tale.vercel.app`. Each project deploys on its own, so a Craft OS release never interrupts service at the shop.
- **Supabase client.** The POS has its own client with its own `storageKey`, so a device session and a staff login never share storage. Its environment points at the same Supabase project as Craft OS for that tier (dev or prod).
- **Install and offline launch.** It gets a web app manifest (standalone, landscape, Craft icon and name "Craft POS") and a service worker that caches the app shell and assets. A tablet that reloads with no network still opens the POS and its offline queue. iPad installs from Safari and Android from Chrome via "Add to Home Screen".
- **Updates.** A new version is downloaded in the background. It takes effect only on the lock screen, never in the middle of an order.
- **What stays in Craft OS (back office):**
  - POS Settings (including the new idle-lock minutes and Outlets), the menu editor and reports.
  - The new **Devices** page (requests, approve or reject, unpair, list).
  - Extra outlets on the staff page.
  - The old `/pos` route shows "The POS has moved to its own app" with the address.

## 4. Server checks

### Three kinds of caller

| Caller | Identified by | May do |
|---|---|---|
| POS device | active `pos_devices` row of kind `pos` plus an open staff session | Front-of-house: tables, ordering, move/merge, pax, checkout, void, refund, reprint, shifts, pay in/out, today's transactions and shift reports of its own outlet |
| Printing device | active `pos_devices` row (kind `pos` or `print_agent`); no staff session needed | `claim_print_job`, `finish_print_job`, `requeue_print_job` on its own outlet only. An iPad print host keeps printing while locked |
| Staff login (Craft OS) | `auth.uid()` = active staff | Back office only (settings, menus, devices, outlets, staff outlets, reports) within `staff_outlet_scope` and the existing caps |

**Staff email logins can no longer call front-of-house RPCs.** Taking money, voiding and refunding need an activated device and a PIN session.

### The context helper

`pos_ctx()` replaces `pos_my_branch()` in every front-of-house RPC. It returns `(device_id, branch_id, staff_id)` and raises a coded error unless all of these hold:
1. `auth.uid()` is a `pos_devices` row of kind `pos` that is not revoked → `device_unpaired`.
2. The device's outlet is open for POS → `outlet_closed`.
3. The device has an open staff session → `no_session`.
4. `pos_staff_may_work(session staff, outlet)` holds → `access_changed`, which also ends the session.

It updates `pos_devices.last_seen_at` and `pos_staff_sessions.last_active_at`. Every RPC that used `auth.uid()` as the actor uses `staff_id` from `pos_ctx()` instead. The RPC bodies otherwise stay as they are.

`pos_print_branch()` is used by the three print RPCs: an active device of either kind returns its outlet, with no session needed.

`pos_caller_branch()`, used in the RLS policies on settings tables, returns the device's outlet for a device and the staff member's home branch for a staff login.

### Read access

The `using (true)` read policies on `bills`, `orders`, `order_items`, `payments`, `refunds`, `print_jobs`, `pos_shifts` and `pos_cash_moves` are replaced by `branch_id in (select pos_readable_branches())`:
- For a device it is its own outlet.
- For staff it is `staff_outlet_scope`.
- For a device account that is revoked, or a user who is neither, it is nothing.

Realtime uses the same policies, so a tablet only receives its own outlet's changes. `dining_tables` and the other branch tables follow the same rule. Menu tables stay company-wide.

### Audit

`device_id uuid null references pos_devices` is added to `orders`, `bills` (closing device), `payments`, `refunds`, the void records, `pos_shifts` (opened and closed) and `pos_cash_moves`. It is filled from `pos_ctx()`.

### Print agent

`node … agent.ts pair` runs the activation flow from the terminal: it prints the code, polls, and saves the device credentials to a git-ignored file. After that, `agent.ts` signs in as that device. `AGENT_EMAIL`, `AGENT_PASSWORD` and `BRANCH_ID` are removed from `.env`; the outlet comes from the device.

## 5. Errors and testing

### Messages (English UI)

| Error code / case | Screen | Message |
|---|---|---|
| `device_unpaired` | activation screen | "This device was unpaired. Ask HQ to activate it again." Orders still in the offline queue are listed under "n orders were not sent" with their items, so staff can enter them again |
| request expired / rejected | activation screen | "This request expired." / "This request was rejected." + **Request again** |
| `outlet_closed` | lock screen, no sign-in | "This outlet closed on 30 Nov." (or "opens on …" before the start date) |
| `access_changed` | lock screen | "Your access here has changed. Ask your manager." |
| `no_session` | lock screen | none (it happens after auto-lock) |
| wrong PIN | PIN keypad | "Wrong PIN · n tries left" |
| PIN locked | lock screen | "Too many tries. Try again in 10 minutes." |
| no PIN set | roster | name greyed, "Set a PIN in Craft OS first" |

### Tests

- **Vitest:**
  - the activation state machine (pending → approved / rejected / expired, polling stops)
  - the idle timer (pauses offline, resets on touch)
  - the roster mapping
  - the error code → message map
  - the queued-order `staffId` handling
  - bill prefix formatting
- **SQL verify** (rolled back, on dev):
  - **Allowed:** an outlet A device with an outlet A staff session; a staff member with a `staff_outlets` row for A; an `all_branches` staff member anywhere.
  - **Refused:** a revoked device; a pop-up outside its dates; staff without `pos_login`; a staff member not allowed at A; a staff email login calling `open_table` / `checkout_bill`.
  - **Reads:** an A device reads none of outlet B's bills; staff reads follow their scope.
  - **Printing:** a print agent claims only its own outlet's jobs; a locked iPad still claims.
  - **PIN:** login lockout counts across devices; approvals follow the new rule.
- **Browser on dev:**
  - Two isolated browser profiles act as two devices on two outlets.
  - The full sequence: request → approve → PIN sign-in → switch staff → auto-lock → remote unpair during an order → offline ordering with auto-lock paused → print agent pairing.
- **Real tablets:** iPad (Safari) and an Android tablet (Chrome): add to home screen, launch offline.

## Out of scope

Self-order kiosk machines, native App Store / Play Store apps, offline PIN sign-in, per-outlet products, multi-outlet reports beyond scope filtering, the bill discount (separate paused design).

## Build order (for the plan)

1. **Outlets:** `branches.kind/opens_on/closes_on/bill_prefix`, `staff_outlets`, `pos_login`, `pos_staff_may_work`, `staff_outlet_scope`, back-office screens.
2. **Devices and login:** device tables, Edge Function activation, Devices page, staff sessions, PIN login, `pos_ctx` swap across the RPCs, read-policy fix, audit columns, offline queue `staffId`.
3. **Separate app:** POS entry, own Supabase client, manifest and service worker, the `craft-pos` Vercel project, the Craft OS `/pos` notice.
4. **Print agent pairing.**

Prod rollout: after the whole POS SQL chain and `migration-2026-10-26-pos-frontend.sql`, before the first prod deploy of the POS app.

## Amendments (owner, 2026-10-29, after approval)

- **HQ is owner and admin.** Manager has All Branches switched off (set on dev; prod still to set in Settings → System Roles). HQ = `all_branches` + `access_settings`.
- **Only HQ clears the PIN of HQ staff** (`clear_pos_pin`, Sub-plan A).
- **All tablets are equal: no main/sub.** Feedme's main/sub linking exists because its main POS holds the data on the shop network; every Craft POS tablet talks to Supabase on its own, so one tablet going down never stops the others.
  - **The first screen of the app picks what the device is for.** Only **POS** for now; a customer display can be added later as another choice. The print agent pairs from its own terminal command (§4).
  - **One POS tablet per outlet is the printing tablet**: it prints (the iPad print host) and holds the cash drawer. HQ marks it when approving; a manager of the outlet can move it on the Devices page; unpairing clears it.
- **The offline queue's staffId is honoured only for someone who has signed in on that tablet** and may still work at the outlet (the queued staffId always comes from the tablet's own session); otherwise the order is placed by the current session's staff member. A staff login's staffId is ignored.
- **Build order re-split.** The `pos_ctx` swap ends front-of-house access for staff email logins, so it ships with the POS app:
  - **B:** the server for devices and sessions plus the back office.
  - **C:** the POS app, the swap, read policies, audit columns, the offline `staffId`, the `/pos` notice.
  - **D:** print agent pairing.
