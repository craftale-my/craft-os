# POS · Devices and PIN login, server side (Sub-plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server half of HQ-approved device activation and name + PIN staff sessions. A tablet or print agent asks for activation, HQ approves it in Craft OS (and marks the outlet's printing tablet), and the device receives its own login once. Devices can sign staff in with a PIN, lock and switch staff, and every later till call can be checked with `pos_ctx()`. Managers see and unpair their outlets' devices, move the printing tablet, and set the auto-lock minutes.

**Architecture:**
- One idempotent migration, `supabase/migration-2026-10-29-pos-devices.sql` (sections `D1`–`D6`), with a rolled-back self-check. It holds four new tables, service-role-only activation functions, HQ decision RPCs, the device context `pos_ctx()` / `pos_print_branch()`, and the sign-in RPCs.
- A thin Edge Function, `pos-device-activation`, is the only door for a device without a login. Its pure parts are in `logic.ts`, tested with Vitest.
- Craft OS gets a **Devices** page (`/pos/devices`) and a **Lock** section in POS settings.

**Tech Stack:** React 19, Vite 6, TypeScript, Tailwind, Supabase (Postgres plpgsql `security definer`, Edge Functions on Deno with `jsr:@supabase/supabase-js@2`, Auth admin API), Vitest. The gates are `npx tsc -b` and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md` §2 and §4, approved by the owner on 2026-10-29. This plan builds on Sub-plan A (`docs/superpowers/plans/2026-10-29-pos-outlets.md`), which is live on dev at `b5936f7`: `pos_staff_may_work`, `pos_outlet_open`, `pos_manages_outlet`, `staff_outlet_scope`, `my_outlets`.

## Where this sits (re-split of the spec's build order)

The spec's step 2 (devices and login) includes swapping every front-of-house RPC from `pos_my_branch()` to `pos_ctx()`. That swap ends till access for staff email logins, so **it must ship together with the app that signs in as a device**. Shipped alone, it would break the dev POS until the app lands. The work is therefore divided as follows:

- **B — this plan.** The server for devices and sessions, plus the back office:
  - the activation tables and functions, and the Edge Function;
  - HQ approval and the Devices page;
  - unpairing;
  - `pos_ctx()`, `pos_print_branch()`, the roster, PIN sign-in with its lockout, and lock;
  - the per-outlet auto-lock minutes.

  Nothing on the till changes: `/pos` still runs on the staff login.
- **C — the POS app.**
  - Its own Vite entry and Supabase client, the manifest and service worker, and the `craft-pos` Vercel project.
  - The activation, lock and PIN screens; auto-lock; "Unpair this device".
  - The first screen picks what the device is for. Only **POS** for now; a customer display can come later. No main/sub linking (owner, 2026-10-29).
  - Print hosting and the cash drawer run only on the printing tablet (`device.prints` in the roster).
  - The swap of the front-of-house RPCs to `pos_ctx()` and of the print RPCs to `pos_print_branch()`.
  - The `pos_readable_branches()` read policies, the `device_id` audit columns and the offline queue's `staffId`.
  - The Craft OS `/pos` "moved" notice.
- **D — print agent pairing.** It comes after C, because it uses the swapped print RPCs.

## Resolutions (decided while planning, 2026-10-29)

- **HQ = `all_branches` + `access_settings`** (`pos_is_hq()`, the same rule as `save_outlet`).
  - On 2026-10-29 the owner turned All Branches **off for Manager**, and it was set on dev that day. So by default HQ = owner and admin.
  - Prod is not set yet. This session cannot read or write prod; the owner sets it in Settings → System Roles, or allows prod SQL.
- **Activation logic lives in SQL.** The Edge Function is glue, so the rules sit with the rest of the POS SQL and the scratch replay can test them.
  - `pos_activation_request(p_name, p_platform, p_ip)`:
    - The code is 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I, O, 0 or 1), shown as `ABC-DEF`. A clash with a live code means a redraw (up to 5 times).
    - The secret is 48 hex characters, and only its SHA-256 is stored.
    - Limits: 5 requests per IP per rolling hour (every request counts) and 50 pending in total. Pending requests past their 24 h expire on the next request.
  - `pos_activation_poll(p_code, p_secret)`:
    - Gives `unknown` for a wrong secret, an unknown code, or credentials already handed out; otherwise `pending`, `rejected` or `expired`.
    - Gives `issue` once per approved request. That poll **claims** it (`claimed_at`), and a claim older than a minute can be taken over.
    - The Edge Function then creates the auth user and calls `pos_activation_finish`. If that fails, it calls `pos_activation_unclaim` and the next poll retries. The credentials go out exactly once.
- **HQ types the code shown on the tablet** to approve it. The list shows the code as well; typing it confirms that the tablet in front of HQ is the one being approved.
  - The server compares it loosely: case, spaces and dashes are ignored.
  - Reject needs no code.
- **Device accounts** are created by the Edge Function with the service role:
  - email `device-<uuid>@devices.invalid` (dev Auth accepts it: checked 2026-10-29 by creating and deleting one);
  - a random 48-hex password;
  - `email_confirm: true`, `app_metadata.pos_device = true`.
  - They have no `staff` row, so every Craft OS capability check is false for them.
- **All tablets are equal** (owner, 2026-10-29: no Feedme-style main/sub linking; every tablet talks to Supabase on its own).
  - One POS tablet per outlet is the **printing tablet**, which prints and holds the cash drawer: `pos_devices.prints`.
  - A partial unique index allows only one per outlet among active devices, and only a `pos` device can hold it.
  - HQ ticks "This tablet prints and holds the cash drawer" when approving, and the new tablet takes over from the outlet's current one in `pos_activation_finish`.
  - A manager of the outlet moves the role later with `pos_set_print_tablet` (Devices → "Make printing tablet").
  - Unpairing clears it.
  - The roster reports it as `device.prints`; Part C runs the print host only there.
- **Unpairing** is done by a manager of the device's outlet (`pos_manages_outlet`; HQ manages every outlet). It:
  - sets `revoked_at` / `revoked_by`;
  - ends the open session with `unpaired`;
  - bans the auth user (`auth.users.banned_until = 'infinity'`). On dev the `postgres` owner of the functions has UPDATE on `auth.users` (checked 2026-10-29).

  Repeating it is a no-op. Moving a device = unpair + a new activation.
- **Sign-in refusals come back as JSON** — `{ ok: false, code, error }` with code `outlet_closed`, `not_allowed`, `no_pin`, `wrong_pin` or `pin_locked` — not as raised errors, because a raise would roll back the recorded try. A missing or revoked device still raises `device_unpaired`.
- **Lockout** (spec: per person, across devices):
  - Wrong tries are counted since the later of the person's last successful sign-in and 24 h ago.
  - Five or more wrong tries, with the last one less than 10 minutes ago, means locked: "Too many tries. Try again in 10 minutes."
  - The fifth wrong try already answers with that message.
  - After the 10 minutes, one more wrong try locks again until a success.
  - Messages: "Wrong PIN · 4 tries left" … "Wrong PIN · 1 try left".
  - Tries are serialized per person by a row lock on `staff`.
- **`pos_ctx()` cannot end a session.** For `access_changed` it raises, and a raise rolls back any write. So the app calls `pos_end_session('access_changed')` when it sees that code (Part C), and `end_reason` allows `access_changed`. `pos_ctx()` raises in this order: `device_unpaired` (also for a print agent), `outlet_closed`, `no_session`, `access_changed`. It stamps `last_seen_at` and `last_active_at`.
- **`pos_ctx()` and `pos_print_branch()` are internal** (revoked from `authenticated`). Part C's `security definer` RPCs call them. **The roster** (`pos_login_roster()`) is what the app calls to learn its device, outlet, open state, lock minutes, current session and who may sign in. At a closed outlet, `staff` is empty.
- **The auto-lock minutes** are stored per outlet in `branch_pos_settings.idle_lock_minutes` (1–60, default 10) and set under POS settings → Lock (`save_lock_settings`). The app reads them from the roster in Part C.
- **`supabase/functions/_shared/secretKey.ts`** holds `resolveSecretKey()` for the new function. `provision-staff` keeps its own copy until it is next deployed; that is a Minor to tidy then.
- **The Devices page** shows the waiting requests to HQ, refreshed every 15 s and with a Refresh button. It shows the device list to managers (their outlets) and HQ (all). Unpair asks for confirmation first. A new request whose platform is `agent` defaults to Print agent.

## Global Constraints

- **Dev database first.**
  - SQL runs on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) through the Management API (`~/.supabase-access-token`), and only by the controller.
  - The Edge Function deploys to dev only.
  - Prod (`yfsoesxzurzjdwstszru`) is a later step the owner decides, after Sub-plan A on prod.
- Steps marked **(controller; the implementer does not touch the database or deploy)** are the controller's. Implementers run only local commands (`npx tsc -b`, `npx vitest run`, `git`) and commit.
- **All UI copy, field names and error messages are in English.** The exact strings are the ones in this plan's code. Comments match the surrounding file.
- **Functions:**
  - Every new function pins `set search_path = public, pg_temp` and revokes execute from `public, anon`.
  - Client-facing ones are granted to `authenticated`.
  - The activation functions are revoked from `authenticated` too and granted to `service_role` only.
  - The internal ones (`pos_is_hq`, `pos_ctx`, `pos_print_branch`) are revoked from `authenticated`.
  - The four new tables have RLS on, no policy and no client privilege.
- **pg-safeupdate:** every DELETE or UPDATE inside a function has a WHERE, and `sqlSafeUpdate.test.ts` scans the new file.
- **Migrations are idempotent**, end with `notify pgrst, 'reload schema';` before the final `select`, and STOP unless Sub-plan A is applied.
- **Verify fixtures.** Staff are created after `request.jwt.claims` is set to the dev owner `76cbcf9f-905e-450d-9f5e-1c9e72a9373d`, inserted as `staff` and promoted by the owner. Devices act through the same claims mechanism (`pg_temp.act(device id)`). A function called for its side effect is called on its own line before a condition checks its effect.
- **UI rules:**
  - each action shows its outcome next to its control;
  - write buttons are disabled while running, and a ref refuses a second tap;
  - a failed load locks the writes;
  - a load keyed by a selection drops stale replies;
  - inputs have visible labels;
  - new `.ts` / `.tsx` files stay at about 250 lines or fewer. `PosSettingsPage.tsx` reaches exactly 250 here; Part C must not grow it.
- `tsconfig` has `noUnusedLocals` and `noUnusedParameters`.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Never use a bare `git stash`. Every replacement quotes its old text, and if one does not match exactly once, stop and report.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-29-pos-devices.sql` | D1–D6 (Task 1) |
| `supabase/migration-2026-10-29-pos-devices-verify.sql` | Self-check, rolled back (Task 1) |
| `src/features/pos/sqlSafeUpdate.test.ts` | Scans the new migration (Task 1) |
| `supabase/functions/pos-device-activation/logic.ts` (+`logic.test.ts`) | Body parsing, client IP, device credentials, reply mapping (Task 2) |
| `supabase/functions/pos-device-activation/index.ts`, `supabase/functions/_shared/secretKey.ts` | The Edge Function (Task 2) |
| `src/features/pos/devices/devices.ts` (+test), `devicesApi.ts`, `DevicesPage.tsx`; `src/App.tsx`; `src/shared/lib/nav.ts` (+test) | The Devices page (Task 3) |
| `src/features/pos/devices/LockSettingsSection.tsx`, `src/features/pos/order/PosSettingsPage.tsx` | POS settings → Lock (Task 4) |

**Test counts.** These were checked while planning on a scratch copy of the worktree at `b5936f7`, by applying this document:
- Baseline: 129 files / 1060 tests.
- After Task 1: 129 / 1062.
- After Task 2: 130 / 1068.
- After Task 3: 131 / 1075.
- After Task 4: 131 / 1075.
- `npx tsc -b` is silent after every task.

**SQL checks.** The SQL was replayed on a scratch PostgreSQL 18 with Supabase stand-ins, after the POS chain and Sub-plan A:
- The migration applies twice.
- The new verify prints `VERIFY OK`, and so do the outlets, hardening, checkout, shifts and front-end verifies.
- The new verify fails for each of eight deliberate faults:
  - lockout counted per device;
  - a success not clearing the count;
  - `pos_ctx()` without the may-work check;
  - a poll that ignores the secret;
  - unpairing outside the caller's outlets;
  - approval without the code;
  - approving a new printing tablet without clearing the outlet's old one;
  - moving the printing tablet at another outlet.

---

### Task 1: The devices migration and its verify — and applying it on craft-os-dev (implementer + controller)

**Model tier:** cheap (the plan carries every line). The controller runs Step 6.

**Files:**
- Create: `supabase/migration-2026-10-29-pos-devices.sql`, `supabase/migration-2026-10-29-pos-devices-verify.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts`

**Interfaces:**
- Consumes (Sub-plan A, live): `pos_staff_may_work(uuid, uuid)`, `pos_outlet_open(uuid)`, `pos_manages_outlet(uuid)`, `has_menu_cap(text)`, `staff_pos_pins`, `branch_pos_settings`.
- Produces:
  - **Service role** (Task 2):
    - `pos_activation_request(p_name text, p_platform text, p_ip text) → jsonb` `{code, secret, expiresAt}` | `{error: 'bad_request'|'too_many'|'busy'}`
    - `pos_activation_poll(p_code text, p_secret text) → jsonb` `{status: 'unknown'|'pending'|'rejected'|'expired'}` | `{status:'issue', requestId, branchId, kind, name}`
    - `pos_activation_finish(p_request_id uuid, p_user_id uuid)`
    - `pos_activation_unclaim(p_request_id uuid)`
  - **Craft OS** (Tasks 3–4):
    - `pos_device_requests_pending() → table(id, code, name, platform, created_at, expires_at)`
    - `pos_decide_device_request(p_request_id uuid, p_approve boolean, p_code text, p_branch_id uuid, p_kind text, p_name text, p_prints boolean)`
    - `pos_devices_list() → table(id, name, branch_id, outlet_name, kind, platform, prints, approved_by_name, approved_at, last_seen_at, revoked_at)`
    - `pos_unpair_device(p_device_id uuid)`
    - `pos_set_print_tablet(p_device_id uuid)`
    - `save_lock_settings(p_branch_id uuid, p_idle_lock_minutes integer)`
    - column `branch_pos_settings.idle_lock_minutes`
  - **Devices** (Part C): `pos_login_roster() → jsonb`, `pos_start_session(p_staff_id uuid, p_pin text) → jsonb`, `pos_end_session(p_reason text)`.
  - **Internal**: `pos_ctx() → (device_id, branch_id, staff_id)`, `pos_print_branch() → uuid`.

- [ ] **Step 1: Name the new file in the pg-safeupdate scan (the failing test)**

Replacement 1 in `src/features/pos/sqlSafeUpdate.test.ts` — replace:

```ts
      'migration-2026-10-29-pos-outlets.sql',
    ]))
```

with:

```ts
      'migration-2026-10-29-pos-outlets.sql',
      'migration-2026-10-29-pos-devices.sql',
    ]))
```

Replacement 2 in `src/features/pos/sqlSafeUpdate.test.ts` — replace:

```ts
    const verify = readFileSync(new URL('migration-2026-10-29-pos-outlets-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
})
```

with:

```ts
    const verify = readFileSync(new URL('migration-2026-10-29-pos-outlets-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })

  it('scans the devices migration: its write functions, service-role-only activation, a rolled-back verify', () => {
    const sql = readFileSync(new URL('migration-2026-10-29-pos-devices.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(expect.arrayContaining([
      'pos_activation_request', 'pos_activation_poll', 'pos_activation_finish', 'pos_activation_unclaim',
      'pos_decide_device_request', 'pos_unpair_device', 'pos_set_print_tablet', 'pos_ctx', 'pos_print_branch', 'pos_start_session',
      'pos_end_session', 'save_lock_settings',
    ]))
    for (const f of ['pos_activation_request\\(text, text, text\\)', 'pos_activation_poll\\(text, text\\)',
                     'pos_activation_finish\\(uuid, uuid\\)', 'pos_activation_unclaim\\(uuid\\)']) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${f} from public, anon, authenticated;`))
      expect(sql).toMatch(new RegExp(`grant execute on function ${f} to service_role;`))
    }
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-29-pos-outlets\.sql first/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
    const verify = readFileSync(new URL('migration-2026-10-29-pos-devices-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
})
```


Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL. The file list misses `migration-2026-10-29-pos-devices.sql`, and the new scan test cannot read it (ENOENT).

- [ ] **Step 2: Write the migration**

Create `supabase/migration-2026-10-29-pos-devices.sql`:

```sql
-- ============================================================================
-- Craft OS — POS devices and staff sessions (2026-10-29): Part B of devices, PIN login
-- and outlets. Run on craft-os-dev after migration-2026-10-29-pos-outlets.sql.
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-29-pos-devices.md
-- Design: docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md (§2, §4)
--
-- D1  Tables: pos_devices (one per activated tablet or print agent; id = its auth user),
--     pos_device_requests (activation codes), pos_staff_sessions (who is signed in on a
--     device), pos_login_attempts (PIN sign-in tries). RLS on, no policy, no privilege:
--     functions only. branch_pos_settings.idle_lock_minutes (1–60, default 10).
-- D2  Activation. The Edge Function pos-device-activation (service role only) calls
--     pos_activation_request, pos_activation_poll, pos_activation_finish and
--     pos_activation_unclaim. HQ (all_branches + access_settings) sees the waiting
--     requests (pos_device_requests_pending) and approves or rejects one
--     (pos_decide_device_request), typing the code shown on the tablet.
-- D3  Devices in Craft OS: pos_devices_list (the caller's outlets); pos_unpair_device
--     (a manager of the device's outlet; HQ manages every outlet) revokes the device,
--     bans its auth user and ends its open session. All tablets are equal (no main/sub):
--     one POS tablet per outlet is the printing tablet (pos_devices.prints — it prints
--     and holds the cash drawer). HQ marks it when approving; a manager of the outlet
--     moves it with pos_set_print_tablet. Marking one clears the outlet's previous one.
-- D4  Device context: pos_ctx() → (device_id, branch_id, staff_id) with the coded errors
--     device_unpaired / outlet_closed / no_session / access_changed; pos_print_branch().
--     Both are internal: Part C's front-of-house RPCs call them.
-- D5  Staff sessions on a device: pos_login_roster, pos_start_session (name + PIN; five
--     wrong tries since the person's last sign-in, within 24 h, lock them for 10 minutes
--     on every device), pos_end_session.
-- D6  save_lock_settings(p_branch_id, p_idle_lock_minutes): POS settings → Lock.
-- Nothing on the till changes yet: the front-of-house RPCs still use pos_my_branch().
-- Part C swaps them to pos_ctx() together with the POS app.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_staff_may_work(uuid,uuid)') is null or to_regprocedure('pos_manages_outlet(uuid)') is null then
    raise exception 'STOP: run migration-2026-10-29-pos-outlets.sql first (pos_staff_may_work is missing)';
  end if;
end $$;

-- ── D1. Tables ───────────────────────────────────────────────────────────────
create table if not exists pos_devices (
  id           uuid primary key references auth.users(id) on delete cascade,
  branch_id    uuid not null references branches(id),
  kind         text not null check (kind in ('pos', 'print_agent')),
  name         text not null check (name = btrim(name) and char_length(name) between 1 and 40),
  platform     text not null check (platform in ('ipad', 'android', 'other', 'agent')),
  prints       boolean not null default false check (not prints or kind = 'pos'),   -- the printing tablet
  approved_by  uuid references staff(id) on delete set null,
  approved_at  timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid references staff(id) on delete set null
);
create index if not exists pos_devices_branch on pos_devices (branch_id);
create unique index if not exists pos_devices_one_printer on pos_devices (branch_id) where prints and revoked_at is null;

create table if not exists pos_device_requests (
  id          uuid primary key default gen_random_uuid(),
  code        text not null check (code ~ '^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$'),
  secret_hash text not null,
  name        text check (name is null or (name = btrim(name) and char_length(name) between 1 and 40)),
  platform    text not null check (platform in ('ipad', 'android', 'other', 'agent')),
  ip          text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  branch_id   uuid references branches(id),                       -- set by HQ on approval
  kind        text check (kind in ('pos', 'print_agent')),
  device_name text,
  prints      boolean not null default false,
  decided_by  uuid references staff(id) on delete set null,
  decided_at  timestamptz,
  claimed_at  timestamptz,                                         -- a poll is creating the device account
  device_id   uuid references pos_devices(id) on delete set null   -- set once the account exists
);
-- a code is unique while it can still be used
create unique index if not exists pos_device_requests_live_code on pos_device_requests (code)
  where status = 'pending' or (status = 'approved' and device_id is null);
create index if not exists pos_device_requests_ip on pos_device_requests (ip, created_at);

create table if not exists pos_staff_sessions (
  id             uuid primary key default gen_random_uuid(),
  device_id      uuid not null references pos_devices(id) on delete cascade,
  staff_id       uuid not null references staff(id),
  started_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  ended_at       timestamptz,
  end_reason     text check (end_reason in ('locked', 'idle', 'switched', 'unpaired', 'access_changed'))
);
create unique index if not exists pos_staff_sessions_one_open on pos_staff_sessions (device_id) where ended_at is null;

create table if not exists pos_login_attempts (
  id        bigint generated always as identity primary key,
  staff_id  uuid not null references staff(id) on delete cascade,
  device_id uuid not null references pos_devices(id) on delete cascade,
  at        timestamptz not null default now(),
  ok        boolean not null
);
create index if not exists pos_login_attempts_staff on pos_login_attempts (staff_id, at);

do $$
declare t text;
begin
  foreach t in array array['pos_devices', 'pos_device_requests', 'pos_staff_sessions', 'pos_login_attempts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

alter table branch_pos_settings add column if not exists idle_lock_minutes integer not null default 10;
alter table branch_pos_settings drop constraint if exists branch_pos_settings_idle_lock_minutes_check;
alter table branch_pos_settings add constraint branch_pos_settings_idle_lock_minutes_check check (idle_lock_minutes between 1 and 60);

-- HQ: every outlet and the POS settings. Internal.
create or replace function pos_is_hq() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_menu_cap('all_branches') and has_menu_cap('access_settings')
$$;
revoke all on function pos_is_hq() from public, anon, authenticated;

-- ── D2. Activation (service role, through the Edge Function) ────────────────
-- A new request: a 6-character code (no I, O, 0 or 1) and a secret only the tablet keeps.
-- At most 5 requests per IP per hour and 50 waiting at a time.
create or replace function pos_activation_request(p_name text, p_platform text, p_ip text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_name     text := nullif(btrim(left(coalesce(p_name, ''), 40)), '');
  v_bytes    bytea;
  v_code     text;
  v_secret   text := encode(extensions.gen_random_bytes(24), 'hex');
  v_row      pos_device_requests;
  i          integer;
begin
  if p_platform is null or p_platform not in ('ipad', 'android', 'other', 'agent') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update pos_device_requests set status = 'expired' where status = 'pending' and expires_at < now();
  if p_ip is not null
     and (select count(*) from pos_device_requests r where r.ip = p_ip and r.created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('error', 'too_many');
  end if;
  if (select count(*) from pos_device_requests r where r.status = 'pending') >= 50 then
    return jsonb_build_object('error', 'busy');
  end if;
  for attempt in 1..5 loop
    v_bytes := extensions.gen_random_bytes(6);
    v_code := '';
    for i in 0..5 loop
      v_code := v_code || substr(v_alphabet, 1 + get_byte(v_bytes, i) % 32, 1);
      if i = 2 then v_code := v_code || '-'; end if;
    end loop;
    begin
      insert into pos_device_requests(code, secret_hash, name, platform, ip)
      values (v_code, encode(extensions.digest(v_secret, 'sha256'), 'hex'), v_name, p_platform, p_ip)
      returning * into v_row;
      return jsonb_build_object('code', v_row.code, 'secret', v_secret, 'expiresAt', v_row.expires_at);
    exception when unique_violation then
      null;                                                          -- the code is in use: draw again
    end;
  end loop;
  return jsonb_build_object('error', 'busy');
end $$;
revoke all on function pos_activation_request(text, text, text) from public, anon, authenticated;
grant execute on function pos_activation_request(text, text, text) to service_role;

-- What a poll sees. A wrong secret gets the same reply as an unknown code. An approved
-- request is claimed by one poll ('issue'), which then creates the device account and
-- calls pos_activation_finish; a claim older than a minute is taken over.
create or replace function pos_activation_poll(p_code text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row pos_device_requests;
begin
  select * into v_row from pos_device_requests r
   where r.code = upper(btrim(coalesce(p_code, '')))
     and r.secret_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
   order by r.created_at desc limit 1
   for update;
  if not found or (v_row.status = 'approved' and v_row.device_id is not null) then
    return jsonb_build_object('status', 'unknown');
  end if;
  if v_row.status = 'pending' and v_row.expires_at < now() then
    update pos_device_requests set status = 'expired' where id = v_row.id;
    return jsonb_build_object('status', 'expired');
  end if;
  if v_row.status <> 'approved' then return jsonb_build_object('status', v_row.status); end if;
  if v_row.claimed_at is not null and v_row.claimed_at > now() - interval '1 minute' then
    return jsonb_build_object('status', 'pending');
  end if;
  update pos_device_requests set claimed_at = now() where id = v_row.id;
  return jsonb_build_object('status', 'issue', 'requestId', v_row.id, 'branchId', v_row.branch_id,
                            'kind', v_row.kind, 'name', v_row.device_name);
end $$;
revoke all on function pos_activation_poll(text, text) from public, anon, authenticated;
grant execute on function pos_activation_poll(text, text) to service_role;

-- The device account exists: record the device and close the request.
create or replace function pos_activation_finish(p_request_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row pos_device_requests;
begin
  select * into v_row from pos_device_requests r where r.id = p_request_id for update;
  if not found or v_row.status <> 'approved' or v_row.device_id is not null or v_row.claimed_at is null then
    raise exception 'This request cannot be finished';
  end if;
  if v_row.prints then                                               -- the outlet's printing tablet moves to this one
    update pos_devices set prints = false where branch_id = v_row.branch_id and prints and revoked_at is null;
  end if;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by, approved_at)
  values (p_user_id, v_row.branch_id, v_row.kind, v_row.device_name, v_row.platform, v_row.prints, v_row.decided_by, v_row.decided_at);
  update pos_device_requests set device_id = p_user_id where id = v_row.id;
end $$;
revoke all on function pos_activation_finish(uuid, uuid) from public, anon, authenticated;
grant execute on function pos_activation_finish(uuid, uuid) to service_role;

-- Creating the account failed: the next poll may try again.
create or replace function pos_activation_unclaim(p_request_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update pos_device_requests set claimed_at = null where id = p_request_id and device_id is null;
end $$;
revoke all on function pos_activation_unclaim(uuid) from public, anon, authenticated;
grant execute on function pos_activation_unclaim(uuid) to service_role;

-- HQ: the requests waiting for a decision.
create or replace function pos_device_requests_pending()
returns table (id uuid, code text, name text, platform text, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not pos_is_hq() then raise exception 'Only HQ can approve devices'; end if;
  return query
    select r.id, r.code, r.name, r.platform, r.created_at, r.expires_at
      from pos_device_requests r
     where r.status = 'pending' and r.expires_at > now()
     order by r.created_at;
end $$;
revoke all on function pos_device_requests_pending() from public, anon;
grant execute on function pos_device_requests_pending() to authenticated;

-- HQ approves (outlet, kind, name, whether it is the printing tablet, and the code typed
-- from the tablet) or rejects.
create or replace function pos_decide_device_request(p_request_id uuid, p_approve boolean, p_code text,
                                                     p_branch_id uuid, p_kind text, p_name text,
                                                     p_prints boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row  pos_device_requests;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_name text := nullif(btrim(p_name), '');
begin
  if not pos_is_hq() then raise exception 'Only HQ can approve devices'; end if;
  if p_approve is null then raise exception 'Invalid request'; end if;
  select * into v_row from pos_device_requests r where r.id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_row.status <> 'pending' or v_row.expires_at < now() then
    raise exception 'This request is no longer waiting';
  end if;
  if not p_approve then
    update pos_device_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = v_row.id;
    return;
  end if;
  if char_length(v_code) <> 6 or left(v_code, 3) || '-' || right(v_code, 3) <> v_row.code then
    raise exception 'The code does not match the tablet';
  end if;
  if p_branch_id is null or not exists (select 1 from branches b where b.id = p_branch_id) then
    raise exception 'Choose the outlet';
  end if;
  if p_kind is null or p_kind not in ('pos', 'print_agent') then raise exception 'Choose POS or Print agent'; end if;
  if v_name is null or char_length(v_name) > 40 then raise exception 'Enter the device name (up to 40 characters)'; end if;
  if coalesce(p_prints, false) and p_kind <> 'pos' then
    raise exception 'Only a POS tablet can print and hold the cash drawer';
  end if;
  update pos_device_requests
     set status = 'approved', branch_id = p_branch_id, kind = p_kind, device_name = v_name,
         prints = coalesce(p_prints, false), decided_by = auth.uid(), decided_at = now()
   where id = v_row.id;
end $$;
revoke all on function pos_decide_device_request(uuid, boolean, text, uuid, text, text, boolean) from public, anon;
grant execute on function pos_decide_device_request(uuid, boolean, text, uuid, text, text, boolean) to authenticated;

-- ── D3. Devices in Craft OS ─────────────────────────────────────────────────
create or replace function pos_devices_list()
returns table (id uuid, name text, branch_id uuid, outlet_name text, kind text, platform text, prints boolean,
               approved_by_name text, approved_at timestamptz, last_seen_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can see devices'; end if;
  return query
    select d.id, d.name, d.branch_id, b.name, d.kind, d.platform, d.prints, s.name, d.approved_at, d.last_seen_at, d.revoked_at
      from pos_devices d
      join branches b on b.id = d.branch_id
      left join staff s on s.id = d.approved_by
     where pos_manages_outlet(d.branch_id)
     order by d.revoked_at is not null, b.name, d.name;
end $$;
revoke all on function pos_devices_list() from public, anon;
grant execute on function pos_devices_list() to authenticated;

-- A manager of the device's outlet (HQ manages every outlet) unpairs it. Repeating it is a no-op.
create or replace function pos_unpair_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  if not pos_manages_outlet(v_dev.branch_id) then raise exception 'This device is not at one of your outlets'; end if;
  if v_dev.revoked_at is not null then return; end if;
  update pos_devices set revoked_at = now(), revoked_by = auth.uid(), prints = false where id = v_dev.id;
  update pos_staff_sessions set ended_at = now(), end_reason = 'unpaired' where device_id = v_dev.id and ended_at is null;
  update auth.users set banned_until = 'infinity' where id = v_dev.id;
end $$;
revoke all on function pos_unpair_device(uuid) from public, anon;
grant execute on function pos_unpair_device(uuid) to authenticated;

-- A manager of the outlet makes an active POS tablet the outlet's printing tablet.
create or replace function pos_set_print_tablet(p_device_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  if not pos_manages_outlet(v_dev.branch_id) then raise exception 'This device is not at one of your outlets'; end if;
  if v_dev.kind <> 'pos' or v_dev.revoked_at is not null then raise exception 'Only an active POS tablet can print'; end if;
  if v_dev.prints then return; end if;
  update pos_devices set prints = false where branch_id = v_dev.branch_id and prints and revoked_at is null;
  update pos_devices set prints = true where id = v_dev.id;
end $$;
revoke all on function pos_set_print_tablet(uuid) from public, anon;
grant execute on function pos_set_print_tablet(uuid) to authenticated;

-- ── D4. Device context (internal; Part C's RPCs call these) ─────────────────
-- The caller must be an active POS device, at an open outlet, with an open staff session
-- of someone who may still work there. The error message is the code the app maps.
create or replace function pos_ctx(out device_id uuid, out branch_id uuid, out staff_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
  v_ses pos_staff_sessions;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null;
  if not found then raise exception 'device_unpaired'; end if;
  if not pos_outlet_open(v_dev.branch_id) then raise exception 'outlet_closed'; end if;
  select * into v_ses from pos_staff_sessions s where s.device_id = v_dev.id and s.ended_at is null;
  if not found then raise exception 'no_session'; end if;
  if not pos_staff_may_work(v_ses.staff_id, v_dev.branch_id) then raise exception 'access_changed'; end if;
  update pos_devices set last_seen_at = now() where id = v_dev.id;
  update pos_staff_sessions set last_active_at = now() where id = v_ses.id;
  device_id := v_dev.id;
  branch_id := v_dev.branch_id;
  staff_id := v_ses.staff_id;
end $$;
revoke all on function pos_ctx() from public, anon, authenticated;

-- A printing device (POS or print agent) prints for its own outlet; no session needed.
create or replace function pos_print_branch() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid;
begin
  select d.branch_id into v_branch from pos_devices d where d.id = auth.uid() and d.revoked_at is null;
  if v_branch is null then raise exception 'device_unpaired'; end if;
  update pos_devices set last_seen_at = now() where id = auth.uid();
  return v_branch;
end $$;
revoke all on function pos_print_branch() from public, anon, authenticated;

-- ── D5. Staff sessions on a device ──────────────────────────────────────────
-- The lock screen: the device, its outlet, the signed-in person, and who may sign in here.
create or replace function pos_login_roster() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_dev  pos_devices;
  v_b    branches;
  v_open boolean;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null;
  if not found then raise exception 'device_unpaired'; end if;
  select * into v_b from branches b where b.id = v_dev.branch_id;
  v_open := pos_outlet_open(v_b.id);
  return jsonb_build_object(
    'device', jsonb_build_object('id', v_dev.id, 'name', v_dev.name, 'prints', v_dev.prints),
    'outlet', jsonb_build_object('id', v_b.id, 'name', v_b.name, 'kind', v_b.kind, 'opensOn', v_b.opens_on,
                                 'closesOn', v_b.closes_on, 'isActive', coalesce(v_b.is_active, false), 'open', v_open),
    'idleLockMinutes', coalesce((select ps.idle_lock_minutes from branch_pos_settings ps where ps.branch_id = v_b.id), 10),
    'session', (select jsonb_build_object('staffId', st.id, 'name', st.name)
                  from pos_staff_sessions s join staff st on st.id = s.staff_id
                 where s.device_id = v_dev.id and s.ended_at is null),
    'staff', case when v_open then coalesce((
               select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name,
                                                   'hasPin', exists (select 1 from staff_pos_pins p where p.staff_id = st.id))
                                order by st.name)
                 from staff st where pos_staff_may_work(st.id, v_b.id)), '[]'::jsonb)
             else '[]'::jsonb end);
end $$;
revoke all on function pos_login_roster() from public, anon;
grant execute on function pos_login_roster() to authenticated;

-- Tap a name, type the PIN. Refusals come back as { ok: false, code, error } so the try is
-- still recorded (a raise would roll it back). Tries are serialized per person.
create or replace function pos_start_session(p_staff_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev        pos_devices;
  v_hash       text;
  v_last_ok    timestamptz;
  v_wrong      integer;
  v_last_wrong timestamptz;
  v_name       text;
  v_id         uuid;
  v_locked     constant text := 'Too many tries. Try again in 10 minutes.';
begin
  select * into v_dev from pos_devices d where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null;
  if not found then raise exception 'device_unpaired'; end if;
  if not pos_outlet_open(v_dev.branch_id) then
    return jsonb_build_object('ok', false, 'code', 'outlet_closed', 'error', 'This outlet is not open for the POS today');
  end if;
  if not pos_staff_may_work(p_staff_id, v_dev.branch_id) then
    return jsonb_build_object('ok', false, 'code', 'not_allowed', 'error', 'This person cannot sign in here');
  end if;
  select st.name into v_name from staff st where st.id = p_staff_id for update;           -- one try at a time per person
  select p.pin_hash into v_hash from staff_pos_pins p where p.staff_id = p_staff_id;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'code', 'no_pin', 'error', 'Set a PIN in Craft OS first');
  end if;
  select max(a.at) into v_last_ok from pos_login_attempts a where a.staff_id = p_staff_id and a.ok;
  select count(*), max(a.at) into v_wrong, v_last_wrong from pos_login_attempts a
   where a.staff_id = p_staff_id and not a.ok
     and a.at > greatest(coalesce(v_last_ok, '-infinity'::timestamptz), now() - interval '24 hours');
  if v_wrong >= 5 and v_last_wrong > now() - interval '10 minutes' then
    return jsonb_build_object('ok', false, 'code', 'pin_locked', 'error', v_locked);
  end if;
  if p_pin is null or p_pin !~ '^\d{4,6}$' or v_hash <> extensions.crypt(p_pin, v_hash) then
    insert into pos_login_attempts(staff_id, device_id, ok) values (p_staff_id, v_dev.id, false);
    v_wrong := v_wrong + 1;
    if v_wrong >= 5 then return jsonb_build_object('ok', false, 'code', 'pin_locked', 'error', v_locked); end if;
    return jsonb_build_object('ok', false, 'code', 'wrong_pin',
      'error', format('Wrong PIN · %s %s left', 5 - v_wrong, case when 5 - v_wrong = 1 then 'try' else 'tries' end));
  end if;
  insert into pos_login_attempts(staff_id, device_id, ok) values (p_staff_id, v_dev.id, true);
  update pos_staff_sessions set ended_at = now(), end_reason = 'switched' where device_id = v_dev.id and ended_at is null;
  insert into pos_staff_sessions(device_id, staff_id) values (v_dev.id, p_staff_id) returning id into v_id;
  update pos_devices set last_seen_at = now() where id = v_dev.id;
  return jsonb_build_object('ok', true, 'sessionId', v_id, 'staff', jsonb_build_object('id', p_staff_id, 'name', v_name));
end $$;
revoke all on function pos_start_session(uuid, text) from public, anon;
grant execute on function pos_start_session(uuid, text) to authenticated;

-- Lock (the staff member pressed Lock), idle (auto-lock), or access_changed (pos_ctx said so).
create or replace function pos_end_session(p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null;
  if not found then raise exception 'device_unpaired'; end if;
  if p_reason is null or p_reason not in ('locked', 'idle', 'access_changed') then raise exception 'Invalid reason'; end if;
  update pos_staff_sessions set ended_at = now(), end_reason = p_reason where device_id = v_dev.id and ended_at is null;
end $$;
revoke all on function pos_end_session(text) from public, anon;
grant execute on function pos_end_session(text) to authenticated;

-- ── D6. POS settings → Lock ─────────────────────────────────────────────────
create or replace function save_lock_settings(p_branch_id uuid, p_idle_lock_minutes integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can change the lock settings'; end if;
  if not pos_manages_outlet(p_branch_id) then raise exception 'This outlet is not one of yours'; end if;
  if p_idle_lock_minutes is null or p_idle_lock_minutes not between 1 and 60 then
    raise exception 'Enter between 1 and 60 minutes';
  end if;
  insert into branch_pos_settings(branch_id) values (p_branch_id) on conflict (branch_id) do nothing;
  update branch_pos_settings set idle_lock_minutes = p_idle_lock_minutes, updated_at = now() where branch_id = p_branch_id;
end $$;
revoke all on function save_lock_settings(uuid, integer) from public, anon;
grant execute on function save_lock_settings(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
select 'pos devices applied' as result;
```


- [ ] **Step 3: Write the self-check**

Create `supabase/migration-2026-10-29-pos-devices-verify.sql`:

```sql
-- Self-check for POS devices and staff sessions. Run on craft-os-dev after
-- migration-2026-10-29-pos-devices.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections follow the migration: A schema, grants and search_path; D2
-- activation; D3 devices and unpairing; D5 sign-in, lockout and sessions; D4 the device
-- context; D6 the lock setting.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(user id): the next calls run as this signed-in user (staff or device)
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr   uuid := 'eeeeeeee-0000-0000-0000-000000000081';   -- manager of VERIFY D A
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-000000000082';   -- cashier of VERIFY D A
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-000000000083';   -- supervisor of VERIFY D A
  v_far   uuid := 'eeeeeeee-0000-0000-0000-000000000084';   -- cashier of VERIFY D B
  v_nopin uuid := 'eeeeeeee-0000-0000-0000-000000000085';   -- cashier of VERIFY D A without a PIN
  v_dev1  uuid := 'eeeeeeee-0000-0000-0000-0000000000d1';   -- POS tablet at A
  v_dev2  uuid := 'eeeeeeee-0000-0000-0000-0000000000d2';   -- second POS tablet at A
  v_agent uuid := 'eeeeeeee-0000-0000-0000-0000000000d3';   -- print agent at A
  v_dev4  uuid := 'eeeeeeee-0000-0000-0000-0000000000d4';   -- POS tablet at the closed pop-up
  v_dev5  uuid := 'eeeeeeee-0000-0000-0000-0000000000d5';   -- a later POS tablet at A, approved as the printing tablet
  v_a uuid; v_b uuid; v_pop uuid;
  v_res jsonb; v_req jsonb; v_code text; v_secret text; v_rid uuid; v_ctx record;
  v_today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  n integer; r record; v_text text;
begin
  -- ── A. schema, grants, search_path ────────────────────────────────────────
  for r in select t from unnest(array['pos_devices', 'pos_device_requests', 'pos_staff_sessions', 'pos_login_attempts']) as t loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || r.t)::regclass) then
      raise exception 'FAIL D1: % has no RLS', r.t;
    end if;
    if has_table_privilege('authenticated', 'public.' || r.t, 'select') or has_table_privilege('anon', 'public.' || r.t, 'select') then
      raise exception 'FAIL D1: % is readable by clients', r.t;
    end if;
  end loop;
  if not exists (select 1 from information_schema.columns where table_name = 'branch_pos_settings' and column_name = 'idle_lock_minutes'
                  and column_default = '10') then
    raise exception 'FAIL D1: branch_pos_settings.idle_lock_minutes (default 10) is missing';
  end if;
  for r in select f from unnest(array['pos_activation_request(text,text,text)', 'pos_activation_poll(text,text)',
                                      'pos_activation_finish(uuid,uuid)', 'pos_activation_unclaim(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute')
       or not has_function_privilege('service_role', r.f, 'execute') then
      raise exception 'FAIL grants: % must be service role only', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['pos_device_requests_pending()', 'pos_decide_device_request(uuid,boolean,text,uuid,text,text,boolean)',
                                      'pos_devices_list()', 'pos_unpair_device(uuid)', 'pos_set_print_tablet(uuid)', 'pos_login_roster()',
                                      'pos_start_session(uuid,text)', 'pos_end_session(text)', 'save_lock_settings(uuid,integer)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: clients cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array['pos_ctx()', 'pos_print_branch()', 'pos_is_hq()']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL grants: % is internal but callable', r.f;
    end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public'
              and p.proname = any (array['pos_is_hq', 'pos_activation_request', 'pos_activation_poll', 'pos_activation_finish',
                                         'pos_activation_unclaim', 'pos_device_requests_pending', 'pos_decide_device_request',
                                         'pos_devices_list', 'pos_unpair_device', 'pos_set_print_tablet', 'pos_ctx', 'pos_print_branch',
                                         'pos_login_roster', 'pos_start_session', 'pos_end_session', 'save_lock_settings'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;

  -- ── B. fixture: outlets A and B, a closed pop-up; staff; PINs ─────────────
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  update system_role_permissions set permissions = permissions || '{"all_branches": false}' where system_role = 'manager';
  delete from pos_device_requests where status = 'pending';                             -- a clean slate for the counts (rolled back)
  insert into branches(name, address) values ('VERIFY D A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY D B', 'b') returning id into v_b;
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  v_pop := save_outlet(null, 'VERIFY D POP', 'popup', v_today - 10, v_today - 1, null);
  insert into auth.users (id) values (v_mgr), (v_cash), (v_sup), (v_far), (v_nopin);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,   'Verify D Manager',    'trainee', true, current_date, 'staff', v_a),
    (v_cash,  'Verify D Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,   'Verify D Supervisor', 'trainee', true, current_date, 'staff', v_a),
    (v_far,   'Verify D Far',        'trainee', true, current_date, 'staff', v_b),
    (v_nopin, 'Verify D No PIN',     'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'manager' where id = v_mgr;
  update staff set system_role = 'supervisor' where id = v_sup;
  perform pg_temp.act(v_cash);
  if not (set_my_pos_pin('1111', null)->>'ok')::boolean then raise exception 'FAIL fixture: cashier PIN'; end if;
  perform pg_temp.act(v_sup);
  if not (set_my_pos_pin('2222', null)->>'ok')::boolean then raise exception 'FAIL fixture: supervisor PIN'; end if;
  perform pg_temp.act(v_far);
  if not (set_my_pos_pin('3333', null)->>'ok')::boolean then raise exception 'FAIL fixture: far PIN'; end if;

  -- ── D2. activation ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', '', true);                                  -- the Edge Function: no user
  if pos_activation_request('Bar iPad', 'toaster', '10.0.0.1') <> '{"error": "bad_request"}'::jsonb then
    raise exception 'FAIL D2: a bad platform was accepted';
  end if;
  v_req := pos_activation_request('  Bar iPad  ', 'ipad', '10.0.0.1');
  v_code := v_req->>'code'; v_secret := v_req->>'secret';
  if v_code !~ '^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$' or v_secret !~ '^[0-9a-f]{48}$' or v_req->>'expiresAt' is null then
    raise exception 'FAIL D2 request: %', v_req;
  end if;
  if (select name || '|' || platform || '|' || status from pos_device_requests where code = v_code) <> 'Bar iPad|ipad|pending'
     or (select expires_at - created_at from pos_device_requests where code = v_code) <> interval '24 hours'
     or exists (select 1 from pos_device_requests where code = v_code and secret_hash = v_secret) then
    raise exception 'FAIL D2: the request row (trimmed name, 24 h, only the secret''s hash stored)';
  end if;
  for n in 1..4 loop perform pos_activation_request(null, 'android', '10.0.0.1'); end loop;   -- 5 from this IP now
  if pos_activation_request(null, 'android', '10.0.0.1') <> '{"error": "too_many"}'::jsonb then
    raise exception 'FAIL D2: a sixth request from one IP within the hour';
  end if;
  if pos_activation_request(null, 'android', '10.0.0.2')->>'code' is null then raise exception 'FAIL D2: another IP is refused'; end if;
  if pos_activation_poll(v_code, 'wrong')->>'status' <> 'unknown' then raise exception 'FAIL D2: a wrong secret is told apart'; end if;
  if pos_activation_poll('ZZZ-ZZZ', v_secret)->>'status' <> 'unknown' then raise exception 'FAIL D2: an unknown code'; end if;
  if pos_activation_poll(lower(v_code), v_secret)->>'status' <> 'pending' then raise exception 'FAIL D2: a pending request'; end if;

  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error('select count(*) from pos_device_requests_pending()', 'Only HQ can approve devices', 'D2 list by a branch manager');
  select id into v_rid from pos_device_requests where code = v_code;
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, v_code, v_a, 'pos', 'Bar iPad'),
                               'Only HQ can approve devices', 'D2 approval by a branch manager');
  perform pg_temp.act(v_owner);
  if not exists (select 1 from pos_device_requests_pending() p where p.code = v_code and p.name = 'Bar iPad') then
    raise exception 'FAIL D2: HQ does not see the waiting request';
  end if;
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, 'ABC-DEF', v_a, 'pos', 'Bar iPad'),
                               'The code does not match the tablet', 'D2 wrong code');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, null, %L, %L, false)', v_rid, v_code, 'pos', 'Bar iPad'),
                               'Choose the outlet', 'D2 no outlet');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, v_code, v_a, 'till', 'Bar iPad'),
                               'Choose POS or Print agent', 'D2 bad kind');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, false)', v_rid, v_code, v_a, 'pos', repeat('x', 41)),
                               'Enter the device name (up to 40 characters)', 'D2 long name');
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, true, %L, %L, %L, %L, true)', v_rid, v_code, v_a, 'print_agent', 'Shop Mac'),
                               'Only a POS tablet can print and hold the cash drawer', 'D2 a printing print agent');
  perform pos_decide_device_request(v_rid, true, lower(replace(v_code, '-', ' ')), v_a, 'pos', ' Bar iPad ', true);   -- typed loosely; the printing tablet
  perform pg_temp.expect_error(format('select pos_decide_device_request(%L, false, null, null, null, null, null)', v_rid),
                               'This request is no longer waiting', 'D2 deciding twice');
  perform set_config('request.jwt.claims', '', true);
  v_res := pos_activation_poll(v_code, v_secret);
  if v_res->>'status' <> 'issue' or (v_res->>'requestId')::uuid <> v_rid or (v_res->>'branchId')::uuid <> v_a
     or v_res->>'kind' <> 'pos' or v_res->>'name' <> 'Bar iPad' then
    raise exception 'FAIL D2 first poll after approval: %', v_res;
  end if;
  if pos_activation_poll(v_code, v_secret)->>'status' <> 'pending' then
    raise exception 'FAIL D2: a second poll while the first creates the account';
  end if;
  perform pos_activation_unclaim(v_rid);                                                 -- the account could not be made
  if pos_activation_poll(v_code, v_secret)->>'status' <> 'issue' then raise exception 'FAIL D2: retry after unclaim'; end if;
  insert into auth.users (id) values (v_dev1);
  perform pos_activation_finish(v_rid, v_dev1);
  if (select branch_id || '|' || kind || '|' || name || '|' || platform || '|' || prints || '|' || approved_by from pos_devices where id = v_dev1)
       <> v_a || '|pos|Bar iPad|ipad|true|' || v_owner then
    raise exception 'FAIL D2: the device row';
  end if;
  if pos_activation_poll(v_code, v_secret)->>'status' <> 'unknown' then raise exception 'FAIL D2: credentials handed out twice'; end if;
  perform pg_temp.expect_error(format('select pos_activation_finish(%L, %L)', v_rid, v_dev2), 'This request cannot be finished', 'D2 finish twice');
  -- reject and expire
  v_req := pos_activation_request(null, 'other', null);
  perform pg_temp.act(v_owner);
  perform pos_decide_device_request((select id from pos_device_requests where code = v_req->>'code'), false, null, null, null, null, null);
  perform set_config('request.jwt.claims', '', true);
  if pos_activation_poll(v_req->>'code', v_req->>'secret')->>'status' <> 'rejected' then raise exception 'FAIL D2: rejected'; end if;
  v_req := pos_activation_request(null, 'other', null);
  update pos_device_requests set expires_at = now() - interval '1 second' where code = v_req->>'code';
  v_res := pos_activation_poll(v_req->>'code', v_req->>'secret');
  if v_res->>'status' <> 'expired' or (select status from pos_device_requests where code = v_req->>'code') <> 'expired' then
    raise exception 'FAIL D2: expired';
  end if;
  -- at most 50 waiting
  insert into pos_device_requests(code, secret_hash, platform)
  select 'QQ' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + g / 32, 1) || '-' || 'QQ'
           || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + g % 32, 1), 'x', 'other'
    from generate_series(0, 49 - (select count(*)::int from pos_device_requests where status = 'pending')) g;
  if pos_activation_request(null, 'other', null) <> '{"error": "busy"}'::jsonb then raise exception 'FAIL D2: more than 50 waiting'; end if;
  delete from pos_device_requests where secret_hash = 'x';
  -- the other test devices, made directly
  insert into auth.users (id) values (v_dev2), (v_agent), (v_dev4);
  insert into pos_devices(id, branch_id, kind, name, platform, approved_by) values
    (v_dev2, v_a, 'pos', 'Kitchen iPad', 'ipad', v_owner),
    (v_agent, v_a, 'print_agent', 'Shop Mac', 'agent', v_owner),
    (v_dev4, v_pop, 'pos', 'Pop-up iPad', 'android', v_owner);

  -- ── D3. devices list ──────────────────────────────────────────────────────
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error('select count(*) from pos_devices_list()', 'Only a manager can see devices', 'D3 list by a cashier');
  perform pg_temp.act(v_mgr);
  select string_agg(l.name, ',' order by l.name) into v_text from pos_devices_list() l where l.id in (v_dev1, v_dev2, v_agent, v_dev4);
  if v_text is distinct from 'Bar iPad,Kitchen iPad,Shop Mac' then raise exception 'FAIL D3: a branch manager sees %', v_text; end if;
  perform pg_temp.expect_error(format('select pos_unpair_device(%L)', v_dev4), 'This device is not at one of your outlets', 'D3 unpair elsewhere');
  -- the printing tablet: one per outlet, moved by a manager of the outlet or by approving another
  if not (select l.prints from pos_devices_list() l where l.id = v_dev1) then raise exception 'FAIL D3: the list shows the printing tablet'; end if;
  perform pos_set_print_tablet(v_dev2);
  if (select string_agg(name || ':' || prints, ',' order by name) from pos_devices where id in (v_dev1, v_dev2)) <> 'Bar iPad:false,Kitchen iPad:true' then
    raise exception 'FAIL D3: moving the printing tablet';
  end if;
  perform pg_temp.expect_error(format('select pos_set_print_tablet(%L)', v_agent), 'Only an active POS tablet can print', 'D3 a print agent as printing tablet');
  perform pg_temp.expect_error(format('select pos_set_print_tablet(%L)', v_dev4), 'This device is not at one of your outlets', 'D3 printing tablet elsewhere');
  begin
    update pos_devices set prints = true where id = v_dev1;
    raise exception 'FAIL D3: two printing tablets at one outlet';
  exception when unique_violation then null;
  end;
  perform pg_temp.act(v_owner);
  perform set_config('request.jwt.claims', '', true);
  v_req := pos_activation_request('Front iPad', 'ipad', null);
  perform pg_temp.act(v_owner);
  perform pos_decide_device_request((select id from pos_device_requests where code = v_req->>'code'), true, v_req->>'code', v_a, 'pos', 'Front iPad', true);
  perform set_config('request.jwt.claims', '', true);
  v_res := pos_activation_poll(v_req->>'code', v_req->>'secret');
  insert into auth.users (id) values (v_dev5);
  perform pos_activation_finish((v_res->>'requestId')::uuid, v_dev5);
  if (select string_agg(name || ':' || prints, ',' order by name) from pos_devices where id in (v_dev2, v_dev5)) <> 'Front iPad:true,Kitchen iPad:false' then
    raise exception 'FAIL D3: approving a new printing tablet moves the role';
  end if;

  -- ── D5. the lock screen and sign-in ───────────────────────────────────────
  perform pg_temp.act(v_cash);                                                          -- a staff email login is no device
  perform pg_temp.expect_error('select pos_login_roster()', 'device_unpaired', 'D5 roster for a staff login');
  perform pg_temp.act(v_agent);
  perform pg_temp.expect_error('select pos_login_roster()', 'device_unpaired', 'D5 roster for a print agent');
  perform pg_temp.act(v_dev1);
  v_res := pos_login_roster();
  if v_res->'device'->>'name' <> 'Bar iPad' or (v_res->'device'->>'prints')::boolean
     or v_res->'outlet'->>'name' <> 'VERIFY D A' or not (v_res->'outlet'->>'open')::boolean
     or (v_res->>'idleLockMinutes')::int <> 10 or v_res->'session' <> 'null'::jsonb then
    raise exception 'FAIL D5 roster: %', v_res;
  end if;
  select string_agg(e->>'name' || ':' || (e->>'hasPin'), ',' order by e->>'name') into v_text
    from jsonb_array_elements(v_res->'staff') e where e->>'name' like 'Verify D%';
  if v_text is distinct from 'Verify D Cashier:true,Verify D Manager:false,Verify D No PIN:false,Verify D Supervisor:true' then
    raise exception 'FAIL D5 roster staff: %', v_text;
  end if;
  if not exists (select 1 from jsonb_array_elements(v_res->'staff') e where (e->>'id')::uuid = v_owner) then
    raise exception 'FAIL D5: HQ is missing from the roster';
  end if;
  if pos_start_session(v_far, '3333')->>'code' <> 'not_allowed' then raise exception 'FAIL D5: another outlet''s cashier signed in'; end if;
  if pos_start_session(v_nopin, '1234')->>'error' <> 'Set a PIN in Craft OS first' then raise exception 'FAIL D5: no PIN'; end if;
  perform pg_temp.expect_error('select pos_ctx()', 'no_session', 'D4 no session yet');
  -- four wrong tries on tablet 1, the fifth on tablet 2: locked everywhere
  for n in 1..4 loop
    v_res := pos_start_session(v_cash, '9999');
    if v_res->>'error' <> format('Wrong PIN · %s %s left', 5 - n, case when 5 - n = 1 then 'try' else 'tries' end) then
      raise exception 'FAIL D5 wrong PIN %: %', n, v_res;
    end if;
  end loop;
  perform pg_temp.act(v_dev2);
  if pos_start_session(v_cash, '12') ->>'code' <> 'pin_locked' then raise exception 'FAIL D5: the fifth wrong try (other tablet) does not lock'; end if;
  perform pg_temp.act(v_dev1);
  if pos_start_session(v_cash, '1111')->>'error' <> 'Too many tries. Try again in 10 minutes.' then
    raise exception 'FAIL D5: the right PIN works during the lock';
  end if;
  if (select count(*) from pos_login_attempts where staff_id = v_cash) <> 5 then raise exception 'FAIL D5: tries are not all recorded'; end if;
  update pos_login_attempts set at = at - interval '11 minutes' where staff_id = v_cash;  -- the 10 minutes pass
  v_res := pos_start_session(v_cash, '1111');
  if not (v_res->>'ok')::boolean or v_res->'staff'->>'name' <> 'Verify D Cashier' then raise exception 'FAIL D5 sign-in: %', v_res; end if;
  if pos_start_session(v_cash, '0000')->>'error' <> 'Wrong PIN · 4 tries left' then raise exception 'FAIL D5: a success clears the count'; end if;
  select * into v_ctx from pos_ctx();
  if v_ctx.device_id <> v_dev1 or v_ctx.branch_id <> v_a or v_ctx.staff_id <> v_cash then raise exception 'FAIL D4 pos_ctx: %', row_to_json(v_ctx); end if;
  if (select last_seen_at from pos_devices where id = v_dev1) is null then raise exception 'FAIL D4: last seen not stamped'; end if;
  if (pos_login_roster()->'session'->>'staffId')::uuid <> v_cash then raise exception 'FAIL D5: the roster shows who is signed in'; end if;
  -- the supervisor takes over the tablet
  if not (pos_start_session(v_sup, '2222')->>'ok')::boolean then raise exception 'FAIL D5: switching staff'; end if;
  if (select string_agg(end_reason || ':' || (ended_at is not null), ',') from pos_staff_sessions where device_id = v_dev1 and staff_id = v_cash)
       <> 'switched:true' then
    raise exception 'FAIL D5: the previous session is not ended as switched';
  end if;
  perform pg_temp.expect_error('select pos_end_session(''bored'')', 'Invalid reason', 'D5 bad reason');
  perform pos_end_session('locked');
  perform pg_temp.expect_error('select pos_ctx()', 'no_session', 'D4 after Lock');
  -- access changes while signed in
  if not (pos_start_session(v_cash, '1111')->>'ok')::boolean then raise exception 'FAIL D5: sign in again'; end if;
  perform pg_temp.act(v_owner);
  update staff set status = 'resigned' where id = v_cash;
  perform pg_temp.act(v_dev1);
  perform pg_temp.expect_error('select pos_ctx()', 'access_changed', 'D4 resigned while signed in');
  perform pos_end_session('access_changed');
  perform pg_temp.act(v_owner);
  update staff set status = 'active' where id = v_cash;
  -- a closed pop-up: nobody signs in, nothing runs
  perform pg_temp.act(v_dev4);
  v_res := pos_login_roster();
  if (v_res->'outlet'->>'open')::boolean or v_res->'staff' <> '[]'::jsonb then raise exception 'FAIL D5 closed outlet roster: %', v_res; end if;
  if pos_start_session(v_owner, '0000')->>'code' <> 'outlet_closed' then raise exception 'FAIL D5: sign-in at a closed outlet'; end if;
  insert into pos_staff_sessions(device_id, staff_id) values (v_dev4, v_owner);
  perform pg_temp.expect_error('select pos_ctx()', 'outlet_closed', 'D4 closed outlet');
  -- the print agent: prints, never runs the till
  perform pg_temp.act(v_agent);
  if pos_print_branch() <> v_a then raise exception 'FAIL D4: the print agent''s outlet'; end if;
  perform pg_temp.expect_error('select pos_ctx()', 'device_unpaired', 'D4 a print agent at the till');
  perform pg_temp.act(v_dev2);
  if pos_print_branch() <> v_a then raise exception 'FAIL D4: a locked tablet still prints'; end if;

  -- ── D3. unpair ────────────────────────────────────────────────────────────
  perform pg_temp.act(v_dev1);
  if not (pos_start_session(v_sup, '2222')->>'ok')::boolean then raise exception 'FAIL D3 fixture: sign in before unpairing'; end if;
  perform pg_temp.act(v_mgr);
  perform pos_unpair_device(v_dev1);
  perform pos_unpair_device(v_dev1);                                                    -- twice is fine
  if (select revoked_by from pos_devices where id = v_dev1) is distinct from v_mgr
     or (select banned_until from auth.users where id = v_dev1) <> 'infinity'
     or exists (select 1 from pos_staff_sessions where device_id = v_dev1 and ended_at is null)
     or not exists (select 1 from pos_staff_sessions where device_id = v_dev1 and end_reason = 'unpaired')
     or (select prints from pos_devices where id = v_dev1) then
    raise exception 'FAIL D3: unpairing (revoked by, banned, session ended as unpaired)';
  end if;
  perform pg_temp.act(v_dev1);
  perform pg_temp.expect_error('select pos_ctx()', 'device_unpaired', 'D4 after unpairing');
  perform pg_temp.expect_error('select pos_print_branch()', 'device_unpaired', 'D4 printing after unpairing');
  perform pg_temp.expect_error('select pos_login_roster()', 'device_unpaired', 'D5 roster after unpairing');
  perform pg_temp.expect_error(format('select pos_start_session(%L, %L)', v_sup, '2222'), 'device_unpaired', 'D5 sign-in after unpairing');

  -- ── D6. lock setting ──────────────────────────────────────────────────────
  perform pg_temp.act(v_cash);
  perform pg_temp.expect_error(format('select save_lock_settings(%L, 15)', v_a), 'Only a manager can change the lock settings', 'D6 cashier');
  perform pg_temp.act(v_mgr);
  perform pg_temp.expect_error(format('select save_lock_settings(%L, 15)', v_b), 'This outlet is not one of yours', 'D6 another outlet');
  perform pg_temp.expect_error(format('select save_lock_settings(%L, 0)', v_a), 'Enter between 1 and 60 minutes', 'D6 zero');
  perform pg_temp.expect_error(format('select save_lock_settings(%L, 61)', v_a), 'Enter between 1 and 60 minutes', 'D6 61');
  perform save_lock_settings(v_a, 15);
  perform pg_temp.act(v_dev2);
  if (pos_login_roster()->>'idleLockMinutes')::int <> 15 then raise exception 'FAIL D6: the roster carries the lock minutes'; end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```


- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts && npx vitest run && npx tsc -b`
Expected: all pass; 129 files / 1062 tests; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-10-29-pos-devices.sql supabase/migration-2026-10-29-pos-devices-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "feat(pos): devices — activation requests, HQ approval, unpairing, PIN sessions with lockout, pos_ctx (SQL)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Apply on dev and verify (controller; the implementer does not touch the database or deploy)**

Through the Management API on `egznnbjmicebbhwasloy`, in this order:
1. `migration-2026-10-29-pos-devices.sql` → `pos devices applied`.
2. `migration-2026-10-29-pos-devices-verify.sql` → `VERIFY OK`.
3. `migration-2026-10-29-pos-outlets-verify.sql` and `migration-2026-10-25-pos-hardening-verify.sql` → `VERIFY OK`.

If one fails, stop and report; do not edit dev data by hand.

---

### Task 2: The Edge Function `pos-device-activation` — and deploying it to dev with an end-to-end smoke test (implementer + controller)

**Model tier:** cheap. The controller runs Steps 6–7.

**Files:**
- Create: `supabase/functions/pos-device-activation/logic.ts`, `supabase/functions/pos-device-activation/logic.test.ts`, `supabase/functions/pos-device-activation/index.ts`, `supabase/functions/_shared/secretKey.ts`

**Interfaces:**
- Consumes: Task 1's four service-role functions.
- Produces:
  - `POST {SUPABASE_URL}/functions/v1/pos-device-activation`, called with the anon key, no JWT check:
    - request: `{ action: 'request', name?, platform: 'ipad'|'android'|'other'|'agent' }` → 200 `{ code, secret, expiresAt }`, or 429/503/400 `{ error }`.
    - poll: `{ action: 'poll', code, secret }` → `{ status: 'pending'|'rejected'|'expired'|'unknown' }`, or once `{ status: 'approved', deviceId, email, password, branchId, kind, name }`.
  - Parts C (app) and D (agent) call this.

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/pos-device-activation/logic.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { clientIp, deviceCredentials, parseBody, requestReply } from './logic'

describe('parseBody', () => {
  it('a request: platform required, name trimmed to 40 or null', () => {
    expect(parseBody({ action: 'request', platform: 'ipad', name: '  Bar iPad  ' })).toEqual({ action: 'request', platform: 'ipad', name: 'Bar iPad' })
    expect(parseBody({ action: 'request', platform: 'android' })).toEqual({ action: 'request', platform: 'android', name: null })
    expect(parseBody({ action: 'request', platform: 'agent', name: '   ' })).toEqual({ action: 'request', platform: 'agent', name: null })
    expect(parseBody({ action: 'request', platform: 'ipad', name: 'x'.repeat(50) })).toMatchObject({ name: 'x'.repeat(40) })
    expect(parseBody({ action: 'request', platform: 'toaster' })).toBeNull()
    expect(parseBody({ action: 'request' })).toBeNull()
  })
  it('a poll: code and secret as strings of sane length', () => {
    expect(parseBody({ action: 'poll', code: 'ABC-DEF', secret: 'f00' })).toEqual({ action: 'poll', code: 'ABC-DEF', secret: 'f00' })
    expect(parseBody({ action: 'poll', code: 'ABC-DEF' })).toBeNull()
    expect(parseBody({ action: 'poll', code: 'x'.repeat(17), secret: 's' })).toBeNull()
    expect(parseBody({ action: 'poll', code: 'ABC-DEF', secret: 's'.repeat(129) })).toBeNull()
  })
  it('anything else', () => {
    expect(parseBody(null)).toBeNull()
    expect(parseBody('poll')).toBeNull()
    expect(parseBody({ action: 'approve' })).toBeNull()
  })
})

describe('clientIp', () => {
  it('the first forwarded address', () => {
    expect(clientIp('203.0.113.7, 10.0.0.1')).toBe('203.0.113.7')
    expect(clientIp(' 203.0.113.7 ')).toBe('203.0.113.7')
    expect(clientIp(null)).toBeNull()
    expect(clientIp('')).toBeNull()
  })
})

describe('deviceCredentials', () => {
  it('a synthetic address and a 48-hex-digit password, new each time', () => {
    const a = deviceCredentials()
    const b = deviceCredentials()
    expect(a.email).toMatch(/^device-[0-9a-f-]{36}@devices\.invalid$/)
    expect(a.password).toMatch(/^[0-9a-f]{48}$/)
    expect(b.email).not.toBe(a.email)
    expect(b.password).not.toBe(a.password)
  })
})

describe('requestReply', () => {
  it('maps the SQL reply to HTTP', () => {
    expect(requestReply({ code: 'ABC-DEF', secret: 's', expiresAt: 't' })).toEqual({ status: 200, body: { code: 'ABC-DEF', secret: 's', expiresAt: 't' } })
    expect(requestReply({ error: 'too_many' })).toEqual({ status: 429, body: { error: 'Too many activation requests from this network. Try again in an hour.' } })
    expect(requestReply({ error: 'busy' })).toEqual({ status: 503, body: { error: 'Too many devices are waiting for approval. Ask HQ.' } })
    expect(requestReply({ error: 'bad_request' })).toEqual({ status: 400, body: { error: 'Invalid request' } })
  })
})
```


Run: `npx vitest run supabase/functions/pos-device-activation`
Expected: FAIL with "Failed to resolve import "./logic"".

- [ ] **Step 2: Write the pure parts**

Create `supabase/functions/pos-device-activation/logic.ts`:

```ts
// The pure parts of pos-device-activation (no Deno APIs), tested with Vitest in logic.test.ts.

export type Platform = 'ipad' | 'android' | 'other' | 'agent'
export const PLATFORMS: Platform[] = ['ipad', 'android', 'other', 'agent']

export type ActivationBody =
  | { action: 'request'; name: string | null; platform: Platform }
  | { action: 'poll'; code: string; secret: string }

/** The request body, or null when it is neither action. */
export function parseBody(body: unknown): ActivationBody | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.action === 'request') {
    if (typeof b.platform !== 'string' || !PLATFORMS.includes(b.platform as Platform)) return null
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 40).trim() : null
    return { action: 'request', name, platform: b.platform as Platform }
  }
  if (b.action === 'poll') {
    if (typeof b.code !== 'string' || typeof b.secret !== 'string') return null
    if (b.code.length > 16 || b.secret.length > 128) return null
    return { action: 'poll', code: b.code, secret: b.secret }
  }
  return null
}

/** The caller's IP as the platform forwards it: the first x-forwarded-for entry. */
export function clientIp(forwardedFor: string | null): string | null {
  const first = forwardedFor?.split(',')[0]?.trim()
  return first ? first.slice(0, 64) : null
}

/** A synthetic email and a random password for a device account; never shown to anyone. */
export function deviceCredentials(): { email: string; password: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const password = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return { email: `device-${crypto.randomUUID()}@devices.invalid`, password }
}

/** The HTTP status and body for pos_activation_request's reply. */
export function requestReply(r: Record<string, unknown>): { status: number; body: Record<string, unknown> } {
  switch (r.error) {
    case undefined:
      return { status: 200, body: { code: r.code, secret: r.secret, expiresAt: r.expiresAt } }
    case 'too_many':
      return { status: 429, body: { error: 'Too many activation requests from this network. Try again in an hour.' } }
    case 'busy':
      return { status: 503, body: { error: 'Too many devices are waiting for approval. Ask HQ.' } }
    default:
      return { status: 400, body: { error: 'Invalid request' } }
  }
}
```


Run: `npx vitest run supabase/functions/pos-device-activation`
Expected: 6 tests pass.

- [ ] **Step 3: Write the shared key helper**

Create `supabase/functions/_shared/secretKey.ts`:

```ts
// A server key that bypasses RLS, for Edge Functions.
//
// Prefers SUPABASE_SECRET_KEYS (the platform injects it; the new sb_secret_ keys rotate on
// their own and outlive the legacy JWT keys). Its documented shape is a "JSON dictionary"
// with no promised key names, so an object, an array or a bare string are all accepted,
// recognised by the sb_secret_ prefix. SUPABASE_SERVICE_ROLE_KEY is the deprecated fallback.
// provision-staff carries its own copy of this function (deployed before this file existed).
export function resolveSecretKey(): string | null {
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    const looksRight = (v: unknown): v is string => typeof v === 'string' && v.startsWith('sb_secret_')
    if (looksRight(raw)) return raw
    try {
      const parsed = JSON.parse(raw)
      if (looksRight(parsed)) return parsed
      const candidates = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {})
      for (const c of candidates) {
        if (looksRight(c)) return c
        if (c && typeof c === 'object') {
          for (const v of Object.values(c)) if (looksRight(v)) return v
        }
      }
    } catch {
      // not JSON: fall back below
    }
  }
  return Deno.env.get('SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? null
}
```


- [ ] **Step 4: Write the function**

Create `supabase/functions/pos-device-activation/index.ts`:

```ts
// Edge Function: pos-device-activation
//
// A POS tablet or print agent asks to be activated, shows its code, and polls until HQ
// approves it in Craft OS (POS → Devices). The caller has no login yet, so this function
// runs without a JWT check and reaches the database only through the service-role
// functions of supabase/migration-2026-10-29-pos-devices.sql. Those carry the limits
// (5 requests per IP per hour, 50 waiting, 24 h expiry) and answer a wrong secret exactly
// like an unknown code.
//
//   request — { action: 'request', name?, platform } → 200 { code, secret, expiresAt }
//             (429 / 503 / 400 { error } when refused)
//   poll    — { action: 'poll', code, secret }
//             → { status: 'pending' | 'rejected' | 'expired' | 'unknown' }
//             → once: { status: 'approved', deviceId, email, password, branchId, kind, name }
//
// Deploy (no JWT check; SUPABASE_URL and the secret keys are injected by the platform):
//   supabase functions deploy pos-device-activation --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { resolveSecretKey } from '../_shared/secretKey.ts'
import { clientIp, deviceCredentials, parseBody, requestReply } from './logic.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const serviceKey = resolveSecretKey()
  const url = Deno.env.get('SUPABASE_URL')
  if (!serviceKey || !url) return json({ error: 'Function is not configured: no secret key available' }, 500)
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'Invalid request' }, 400) }
  const input = parseBody(body)
  if (!input) return json({ error: 'Invalid request' }, 400)

  if (input.action === 'request') {
    const { data, error } = await admin.rpc('pos_activation_request', {
      p_name: input.name, p_platform: input.platform, p_ip: clientIp(req.headers.get('x-forwarded-for')),
    })
    if (error) {
      console.error('pos_activation_request', error.message)
      return json({ error: 'Could not start the activation. Try again.' }, 500)
    }
    const reply = requestReply(data as Record<string, unknown>)
    return json(reply.body, reply.status)
  }

  const { data, error } = await admin.rpc('pos_activation_poll', { p_code: input.code, p_secret: input.secret })
  if (error) {
    console.error('pos_activation_poll', error.message)
    return json({ error: 'Could not check the activation. Try again.' }, 500)
  }
  const poll = data as { status: string; requestId?: string; branchId?: string; kind?: string; name?: string }
  if (poll.status !== 'issue') return json({ status: poll.status })

  // This poll holds the claim: make the device account, then record the device.
  const { email, password } = deviceCredentials()
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { pos_device: true },
  })
  if (createErr || !created.user) {
    console.error('createUser', createErr?.message)
    await admin.rpc('pos_activation_unclaim', { p_request_id: poll.requestId })
    return json({ status: 'pending' })
  }
  const { error: finishErr } = await admin.rpc('pos_activation_finish', { p_request_id: poll.requestId, p_user_id: created.user.id })
  if (finishErr) {
    console.error('pos_activation_finish', finishErr.message)
    await admin.auth.admin.deleteUser(created.user.id)
    await admin.rpc('pos_activation_unclaim', { p_request_id: poll.requestId })
    return json({ status: 'pending' })
  }
  return json({
    status: 'approved', deviceId: created.user.id, email, password,
    branchId: poll.branchId, kind: poll.kind, name: poll.name,
  })
})
```


The function runs on Deno, so `tsc -b` (which covers `src/` only) does not type-check it. The deploy in Step 6 bundles it and fails on a syntax or import error.

- [ ] **Step 5: Run the tests and commit**

Run: `npx vitest run && npx tsc -b`
Expected: 130 files / 1068 tests; tsc silent.

```bash
git add supabase/functions/pos-device-activation supabase/functions/_shared/secretKey.ts
git commit -m "feat(pos): Edge Function pos-device-activation — request a code, poll, receive the device login once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Deploy to dev (controller; the implementer does not deploy)**

From the worktree root:

```bash
SUPABASE_ACCESS_TOKEN=$(cat ~/.supabase-access-token) supabase functions deploy pos-device-activation --project-ref egznnbjmicebbhwasloy --use-api --no-verify-jwt
```

Expected: "Deployed Functions on project egznnbjmicebbhwasloy: pos-device-activation".

- [ ] **Step 7: End-to-end smoke on dev (controller)**

Save this script to the scratchpad (not the repo) and run it from the worktree root. It creates one real device, "SMOKE iPad" at Demo, and unpairs it at the end:

```bash
#!/bin/bash
# Dev-only end-to-end check of device activation (Part B). Run from the worktree root.
# Needs ~/.supabase-access-token (Management API) and .env.local (dev URL + anon key).
set -euo pipefail
REF=egznnbjmicebbhwasloy
URL=$(grep '^VITE_SUPABASE_URL=' .env.local | cut -d= -f2-)
ANON=$(grep '^VITE_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
OWNER=76cbcf9f-905e-450d-9f5e-1c9e72a9373d          # dev test login (owner, HQ)
DEMO=918afa23-e0d8-41b4-8ca3-19b3447479a6           # dev outlet "Demo"

sql() {
  python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1" |
    curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
      -H "Authorization: Bearer $(cat ~/.supabase-access-token)" -H "Content-Type: application/json" --data @-
  echo
}
as_owner() { sql "begin; select set_config('request.jwt.claims', '{\"sub\":\"$OWNER\",\"role\":\"authenticated\"}', true); $1; commit;"; }
fn() {
  curl -s -X POST "$URL/functions/v1/pos-device-activation" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
    -H "Content-Type: application/json" -d "$1"
  echo
}
field() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1', ''))"; }
roster() {
  curl -s -X POST "$URL/rest/v1/rpc/pos_login_roster" -H "apikey: $ANON" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" -d '{}'
  echo
}

REQ=$(fn '{"action":"request","name":"SMOKE iPad","platform":"ipad"}')
CODE=$(echo "$REQ" | field code); SECRET=$(echo "$REQ" | field secret)
echo "1 request → code $CODE"
POLL="{\"action\":\"poll\",\"code\":\"$CODE\",\"secret\":\"$SECRET\"}"
echo "2 poll before approval → $(fn "$POLL" | field status)"                                   # pending
echo "3 wrong secret → $(fn "{\"action\":\"poll\",\"code\":\"$CODE\",\"secret\":\"nope\"}" | field status)"  # unknown
as_owner "select pos_decide_device_request((select id from pos_device_requests where code = '$CODE' and status = 'pending'), true, '$CODE', '$DEMO', 'pos', 'SMOKE iPad', false)" >/dev/null
P=$(fn "$POLL")
echo "4 poll after approval → $(echo "$P" | field status), kind $(echo "$P" | field kind), name $(echo "$P" | field name)"   # approved, pos, SMOKE iPad
echo "5 poll again → $(fn "$POLL" | field status)"                                            # unknown
EMAIL=$(echo "$P" | field email); PASS=$(echo "$P" | field password); DEV=$(echo "$P" | field deviceId)
TOKEN=$(curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | field access_token)
echo "6 device signs in → token ${#TOKEN} chars"
echo "7 roster → $(roster "$TOKEN" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['device']['name'], '@', d['outlet']['name'], '· open', d['outlet']['open'], '·', len(d['staff']), 'staff')")"
as_owner "select pos_unpair_device('$DEV')" >/dev/null
echo "8 roster after unpair → $(roster "$TOKEN" | field message)"                             # device_unpaired
echo "9 sign-in after unpair → $(curl -s -X POST "$URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error_code') or d.get('msg') or 'SIGNED IN (wrong)')")"   # user_banned
```

Expected lines:
1. A code.
2. `pending`.
3. `unknown`.
4. `approved`, kind `pos`, name `SMOKE iPad`.
5. `unknown`.
6. A token of several hundred characters.
7. `SMOKE iPad @ Demo · open True · n staff`, where n is greater than 0.
8. `device_unpaired`.
9. `user_banned`.

If line 4 stays `pending`, read the function logs in the dashboard (createUser or finish failed) and report.

---

### Task 3: The Devices page in Craft OS (implementer)

**Model tier:** standard (a page, its rules, a route and the nav).

**Files:**
- Create: `src/features/pos/devices/devices.ts`, `src/features/pos/devices/devices.test.ts`, `src/features/pos/devices/devicesApi.ts`, `src/features/pos/devices/DevicesPage.tsx`
- Modify: `src/App.tsx`, `src/shared/lib/nav.ts`, `src/shared/lib/nav.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's Craft OS RPCs.
  - `fetchMyOutlets()` and `Outlet` from `src/features/pos/outlets/` (Sub-plan A).
  - `useCan()` from `src/shared/lib/permissions.ts`.
- Produces:
  - `/pos/devices` (requires `access_settings`) and the nav item "Devices".
  - `parseLockMinutes`, `fetchIdleLockMinutes` and `saveIdleLockMinutes`, used by Task 4.

- [ ] **Step 1: Write the failing test**

Create `src/features/pos/devices/devices.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { approveProblem, lastSeenText, mytDateTime, normalizeCode, parseLockMinutes, type ApproveDraft } from './devices'

describe('normalizeCode', () => {
  it('accepts the code however it is typed', () => {
    expect(normalizeCode('ABC-DEF')).toBe('ABC-DEF')
    expect(normalizeCode('abc def')).toBe('ABC-DEF')
    expect(normalizeCode(' a b c d e f ')).toBe('ABC-DEF')
    expect(normalizeCode('9XF-FKR')).toBe('9XF-FKR')
  })
  it('refuses wrong lengths and the characters codes never use (I, O, 0, 1)', () => {
    expect(normalizeCode('ABC-DE')).toBeNull()
    expect(normalizeCode('ABC-DEFG')).toBeNull()
    expect(normalizeCode('ABC-DE0')).toBeNull()
    expect(normalizeCode('IBC-DEF')).toBeNull()
    expect(normalizeCode('')).toBeNull()
  })
})

describe('approveProblem', () => {
  const ok: ApproveDraft = { code: 'abc def', branchId: 'b1', kind: 'pos', name: 'Bar iPad', prints: true }
  it('passes a complete form', () => {
    expect(approveProblem(ok, 'ABC-DEF')).toBeNull()
  })
  it("refuses with pos_decide_device_request's words", () => {
    expect(approveProblem({ ...ok, code: 'ABC-DEG' }, 'ABC-DEF')).toBe('The code does not match the tablet')
    expect(approveProblem({ ...ok, branchId: '' }, 'ABC-DEF')).toBe('Choose the outlet')
    expect(approveProblem({ ...ok, name: '  ' }, 'ABC-DEF')).toBe('Enter the device name (up to 40 characters)')
    expect(approveProblem({ ...ok, name: 'x'.repeat(41) }, 'ABC-DEF')).toBe('Enter the device name (up to 40 characters)')
    expect(approveProblem({ ...ok, kind: 'print_agent' }, 'ABC-DEF')).toBe('Only a POS tablet can print and hold the cash drawer')
    expect(approveProblem({ ...ok, kind: 'print_agent', prints: false }, 'ABC-DEF')).toBeNull()
  })
})

describe('lastSeenText', () => {
  const now = new Date('2026-10-29T12:00:00Z')
  it('reads as a short age', () => {
    expect(lastSeenText(null, now)).toBe('Never')
    expect(lastSeenText('2026-10-29T11:59:30Z', now)).toBe('Just now')
    expect(lastSeenText('2026-10-29T11:55:00Z', now)).toBe('5 min ago')
    expect(lastSeenText('2026-10-29T09:00:00Z', now)).toBe('3 h ago')
    expect(lastSeenText('2026-10-28T11:00:00Z', now)).toBe('1 day ago')
    expect(lastSeenText('2026-10-26T12:00:00Z', now)).toBe('3 days ago')
  })
})

describe('mytDateTime', () => {
  it('is Malaysia time', () => {
    expect(mytDateTime('2026-10-29T06:05:00Z')).toBe('29 Oct, 14:05')
  })
})

describe('parseLockMinutes', () => {
  it('a whole number from 1 to 60', () => {
    expect(parseLockMinutes(' 15 ')).toBe(15)
    expect(parseLockMinutes('1')).toBe(1)
    expect(parseLockMinutes('60')).toBe(60)
    expect(parseLockMinutes('0')).toBeNull()
    expect(parseLockMinutes('61')).toBeNull()
    expect(parseLockMinutes('7.5')).toBeNull()
    expect(parseLockMinutes('')).toBeNull()
  })
})
```


Run: `npx vitest run src/features/pos/devices`
Expected: FAIL with "Failed to resolve import "./devices"".

- [ ] **Step 2: Write the rules**

Create `src/features/pos/devices/devices.ts`:

```ts
// Devices in Craft OS: the approval form's rules and the words shown for each device.
// The server (pos_decide_device_request, pos_unpair_device) is the truth; these mirror it.

export type DeviceKind = 'pos' | 'print_agent'
export type DevicePlatform = 'ipad' | 'android' | 'other' | 'agent'

export const KIND_LABELS: Record<DeviceKind, string> = { pos: 'POS', print_agent: 'Print agent' }
export const PLATFORM_LABELS: Record<DevicePlatform, string> = { ipad: 'iPad', android: 'Android', other: 'Other', agent: 'Computer' }

/** One row of pos_device_requests_pending(). */
export interface PendingRequest {
  id: string
  code: string
  name: string | null
  platform: DevicePlatform
  createdAt: string
  expiresAt: string
}

/** One row of pos_devices_list(). */
export interface DeviceRow {
  id: string
  name: string
  branchId: string
  outletName: string
  kind: DeviceKind
  platform: DevicePlatform
  prints: boolean
  approvedByName: string | null
  approvedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

export interface ApproveDraft {
  code: string
  branchId: string
  kind: DeviceKind
  name: string
  prints: boolean        // the outlet's printing tablet (prints and holds the cash drawer)
}

/** A code as typed ("abc def", "ABCDEF") in the tablet's form "ABC-DEF", or null. */
export function normalizeCode(text: string): string | null {
  const s = text.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-HJ-NP-Z2-9]{6}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3)}` : null
}

/** The approval form checked with pos_decide_device_request's rules and messages. */
export function approveProblem(d: ApproveDraft, requestCode: string): string | null {
  if (normalizeCode(d.code) !== requestCode) return 'The code does not match the tablet'
  if (!d.branchId) return 'Choose the outlet'
  const name = d.name.trim()
  if (!name || name.length > 40) return 'Enter the device name (up to 40 characters)'
  if (d.prints && d.kind !== 'pos') return 'Only a POS tablet can print and hold the cash drawer'
  return null
}

/** "Never", "Just now", "5 min ago", "3 h ago", "2 days ago". */
export function lastSeenText(iso: string | null, now: Date): string {
  if (!iso) return 'Never'
  const min = Math.floor((now.getTime() - new Date(iso).getTime()) / 60000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ago`
  const days = Math.floor(h / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

const MYT_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
})

/** "29 Oct, 14:05", Malaysia time. */
export function mytDateTime(iso: string): string {
  return MYT_DATE_TIME.format(new Date(iso))
}

/** "15" → 15; anything but a whole number from 1 to 60 → null. */
export function parseLockMinutes(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,2}$/.test(t)) return null
  const n = Number(t)
  return n >= 1 && n <= 60 ? n : null
}
```


Run: `npx vitest run src/features/pos/devices`
Expected: 7 tests pass.

- [ ] **Step 3: Write the API calls**

Create `src/features/pos/devices/devicesApi.ts`:

```ts
import { supabase } from '../../../shared/lib/supabase'
import type { ApproveDraft, DeviceKind, DevicePlatform, DeviceRow, PendingRequest } from './devices'

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

/** HQ: the activation requests waiting for a decision. */
export async function fetchPendingRequests(): Promise<PendingRequest[]> {
  const { data, error } = await supabase.rpc('pos_device_requests_pending')
  if (error) fail(error)
  return ((data ?? []) as { id: string; code: string; name: string | null; platform: DevicePlatform; created_at: string; expires_at: string }[])
    .map((r) => ({ id: r.id, code: r.code, name: r.name, platform: r.platform, createdAt: r.created_at, expiresAt: r.expires_at }))
}

/** HQ approves a request (the code typed from the tablet, outlet, kind, name, printing tablet). */
export async function approveRequest(requestId: string, d: ApproveDraft): Promise<void> {
  const { error } = await supabase.rpc('pos_decide_device_request', {
    p_request_id: requestId, p_approve: true, p_code: d.code, p_branch_id: d.branchId, p_kind: d.kind, p_name: d.name,
    p_prints: d.prints,
  })
  if (error) fail(error)
}

export async function rejectRequest(requestId: string): Promise<void> {
  const { error } = await supabase.rpc('pos_decide_device_request', {
    p_request_id: requestId, p_approve: false, p_code: null, p_branch_id: null, p_kind: null, p_name: null, p_prints: null,
  })
  if (error) fail(error)
}

/** The devices of the caller's outlets. */
export async function fetchDevices(): Promise<DeviceRow[]> {
  const { data, error } = await supabase.rpc('pos_devices_list')
  if (error) fail(error)
  return ((data ?? []) as {
    id: string; name: string; branch_id: string; outlet_name: string; kind: DeviceKind; platform: DevicePlatform; prints: boolean
    approved_by_name: string | null; approved_at: string; last_seen_at: string | null; revoked_at: string | null
  }[]).map((r) => ({
    id: r.id, name: r.name, branchId: r.branch_id, outletName: r.outlet_name, kind: r.kind, platform: r.platform, prints: r.prints,
    approvedByName: r.approved_by_name, approvedAt: r.approved_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
  }))
}

export async function unpairDevice(deviceId: string): Promise<void> {
  const { error } = await supabase.rpc('pos_unpair_device', { p_device_id: deviceId })
  if (error) fail(error)
}

/** Makes an active POS tablet its outlet's printing tablet (the previous one stops). */
export async function setPrintTablet(deviceId: string): Promise<void> {
  const { error } = await supabase.rpc('pos_set_print_tablet', { p_device_id: deviceId })
  if (error) fail(error)
}

/** branch_pos_settings is readable by every signed-in staff member; no row = the default 10. */
export async function fetchIdleLockMinutes(branchId: string): Promise<number> {
  const { data, error } = await supabase.from('branch_pos_settings').select('idle_lock_minutes').eq('branch_id', branchId).maybeSingle()
  if (error) fail(error)
  return (data as { idle_lock_minutes: number } | null)?.idle_lock_minutes ?? 10
}

export async function saveIdleLockMinutes(branchId: string, minutes: number): Promise<void> {
  const { error } = await supabase.rpc('save_lock_settings', { p_branch_id: branchId, p_idle_lock_minutes: minutes })
  if (error) fail(error)
}
```


- [ ] **Step 4: Write the page**

Create `src/features/pos/devices/DevicesPage.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { useCan } from '../../../shared/lib/permissions'
import { fetchMyOutlets } from '../outlets/outletsApi'
import type { Outlet } from '../outlets/outlet'
import {
  KIND_LABELS, PLATFORM_LABELS, approveProblem, lastSeenText, mytDateTime,
  type ApproveDraft, type DeviceKind, type DeviceRow, type PendingRequest,
} from './devices'
import { approveRequest, fetchDevices, fetchPendingRequests, rejectRequest, setPrintTablet, unpairDevice } from './devicesApi'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const box = 'rounded-xl border border-border bg-card p-4'
const input = 'rounded border border-border p-1'
type Outcome = { ok: boolean; text: string } | null

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null
  return outcome.ok
    ? <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{outcome.text}</p>
    : <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{outcome.text}</p>
}

/** POS → Devices: HQ approves the tablets and print agents waiting for activation; managers
 *  see and unpair the devices of their outlets. */
export default function DevicesPage() {
  const { can } = useCan()
  const isHq = can('all_branches') && can('access_settings')
  const [devices, setDevices] = useState<DeviceRow[] | null>(null)       // null while loading or after a failed load
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const running = useRef(false)
  const seq = useRef(0)

  const loadDevices = useCallback(async () => {
    const id = ++seq.current
    try { const d = await fetchDevices(); if (id === seq.current) setDevices(d) }
    catch (e) { if (id === seq.current) { setDevices(null); setOutcome({ ok: false, text: `Could not load the devices: ${msg(e)}` }) } }
  }, [])
  useEffect(() => { void loadDevices() }, [loadDevices])

  const act = async (d: DeviceRow, fn: () => Promise<void>, done: string) => {
    if (running.current) return
    running.current = true; setBusyId(d.id); setOutcome(null)
    try { await fn(); setOutcome({ ok: true, text: done }); await loadDevices() }
    catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusyId(null) }
  }
  const unpair = (d: DeviceRow) => {
    if (!window.confirm(`Unpair ${d.name}? It stops working at once and needs a new activation.`)) return
    void act(d, () => unpairDevice(d.id), `${d.name} unpaired`)
  }
  const makePrinter = (d: DeviceRow) =>
    void act(d, () => setPrintTablet(d.id), `${d.name} now prints and holds the cash drawer at ${d.outletName}`)

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Devices</h1>
      {isHq && <PendingSection onApproved={loadDevices} />}
      <section className={box}>
        <h2 className="font-semibold">Devices</h2>
        <p className="text-xs text-brown-muted">Tablets and print agents activated for your outlets. Every tablet works on its own; one per outlet is the printing tablet (it prints and holds the cash drawer). Unpairing stops a device at once; to move it to another outlet, unpair it and activate it again.</p>
        {devices && devices.length === 0 && <p className="mt-2 text-sm text-brown-muted">No devices yet.</p>}
        {devices && devices.length > 0 && (
          <table className="mt-3 w-full text-sm">
            <thead><tr className="text-left text-xs text-brown-muted"><th>Device</th><th>Outlet</th><th>Kind</th><th>Approved</th><th>Last seen</th><th></th><th></th></tr></thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id} className={`border-t border-border ${d.revokedAt ? 'text-brown-muted' : ''}`}>
                  <td className="py-2 font-medium">{d.name}<span className="ml-2 text-xs text-brown-muted">{PLATFORM_LABELS[d.platform]}</span></td>
                  <td>{d.outletName}</td>
                  <td>{KIND_LABELS[d.kind]}{d.prints && <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-800">Prints · cash drawer</span>}</td>
                  <td className="text-xs">{d.approvedByName ?? '—'} · {mytDateTime(d.approvedAt)}</td>
                  <td className="text-xs">{d.revokedAt ? `Unpaired ${mytDateTime(d.revokedAt)}` : lastSeenText(d.lastSeenAt, new Date())}</td>
                  <td className="text-right">
                    {!d.revokedAt && d.kind === 'pos' && !d.prints && <button disabled={busyId !== null} onClick={() => makePrinter(d)} className="text-xs underline disabled:opacity-50">Make printing tablet</button>}
                  </td>
                  <td className="text-right">
                    {!d.revokedAt && <button disabled={busyId !== null} onClick={() => unpair(d)} className="text-xs text-red-700 underline disabled:opacity-50">{busyId === d.id ? 'Unpairing…' : 'Unpair'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <OutcomeLine outcome={outcome} />
      </section>
    </div>
  )
}

/** HQ only: requests waiting for a decision, refreshed every 15 s while the page is open. */
function PendingSection({ onApproved }: { onApproved: () => Promise<void> }) {
  const [requests, setRequests] = useState<PendingRequest[] | null>(null)
  const [outlets, setOutlets] = useState<Outlet[]>([])
  const [open, setOpen] = useState<{ request: PendingRequest; draft: ApproveDraft } | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)

  const load = useCallback(async () => {
    try { setRequests(await fetchPendingRequests()) }
    catch (e) { setRequests(null); setOutcome({ ok: false, text: `Could not load the requests: ${msg(e)}` }) }
  }, [])
  useEffect(() => {
    void load()
    fetchMyOutlets().then((o) => setOutlets(o.filter((x) => x.isActive)), (e) => setOutcome({ ok: false, text: `Could not load the outlets: ${msg(e)}` }))
    const timer = window.setInterval(() => { void load() }, 15000)
    return () => window.clearInterval(timer)
  }, [load])

  const act = async (fn: () => Promise<void>, done: string) => {
    if (running.current) return
    running.current = true; setBusy(true); setOutcome(null)
    try { await fn(); setOpen(null); setOutcome({ ok: true, text: done }); await load() }
    catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusy(false) }
  }
  const approve = () => {
    if (!open) return
    const problem = approveProblem(open.draft, open.request.code)
    if (problem) { setOutcome({ ok: false, text: problem }); return }
    void act(async () => { await approveRequest(open.request.id, open.draft); await onApproved() },
      `${open.draft.name.trim()} approved — the device finishes activating within a few seconds`)
  }
  const reject = (r: PendingRequest) => {
    if (!window.confirm(`Reject the request ${r.code}?`)) return
    void act(() => rejectRequest(r.id), `Request ${r.code} rejected`)
  }
  const change = (draft: ApproveDraft) => { if (open) setOpen({ ...open, draft }); setOutcome(null) }

  return (
    <section className={box}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Waiting for approval</h2>
        <button onClick={() => void load()} className="text-xs underline">Refresh</button>
      </div>
      <p className="text-xs text-brown-muted">A new tablet or print agent shows a code. Check it is the device in front of you, type its code, choose the outlet and approve. A request expires after 24 hours.</p>
      {requests && requests.length === 0 && <p className="mt-2 text-sm text-brown-muted">No device is waiting.</p>}
      {requests?.map((r) => (
        <div key={r.id} className="mt-2 flex items-center gap-3 border-t border-border pt-2 text-sm">
          <span className="font-mono font-semibold">{r.code}</span>
          <span>{r.name ?? 'Unnamed device'}</span>
          <span className="text-xs text-brown-muted">{PLATFORM_LABELS[r.platform]} · asked {mytDateTime(r.createdAt)}</span>
          <span className="ml-auto space-x-3">
            <button disabled={busy} onClick={() => { setOpen({ request: r, draft: { code: '', branchId: '', kind: r.platform === 'agent' ? 'print_agent' : 'pos', name: r.name ?? '', prints: false } }); setOutcome(null) }} className="text-xs underline">Approve…</button>
            <button disabled={busy} onClick={() => reject(r)} className="text-xs text-red-700 underline">Reject</button>
          </span>
        </div>
      ))}
      {open && (
        <div className="mt-3 space-y-2 rounded border border-border p-3 text-sm">
          <div className="font-medium">Approve {open.request.code}</div>
          <label className="block">Code shown on the device
            <input className={`${input} ml-2 w-28 font-mono uppercase`} value={open.draft.code} onChange={(e) => change({ ...open.draft, code: e.target.value })} />
          </label>
          <label className="block">Outlet
            <select className={`${input} ml-2`} value={open.draft.branchId} onChange={(e) => change({ ...open.draft, branchId: e.target.value })}>
              <option value="">Choose…</option>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="block">Kind
            <select className={`${input} ml-2`} value={open.draft.kind} onChange={(e) => { const kind = e.target.value as DeviceKind; change({ ...open.draft, kind, prints: kind === 'pos' && open.draft.prints }) }}>
              {(Object.keys(KIND_LABELS) as DeviceKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
          </label>
          <label className="block">Name
            <input className={`${input} ml-2 w-64`} maxLength={40} placeholder="e.g. Cheras Counter iPad" value={open.draft.name} onChange={(e) => change({ ...open.draft, name: e.target.value })} />
          </label>
          {open.draft.kind === 'pos' && (
            <label className="block">
              <input type="checkbox" checked={open.draft.prints} onChange={(e) => change({ ...open.draft, prints: e.target.checked })} />
              <span className="ml-2">This tablet prints and holds the cash drawer</span>
              <span className="ml-2 text-xs text-brown-muted">One per outlet: it takes over from the current printing tablet.</span>
            </label>
          )}
          <div className="flex gap-2">
            <button disabled={busy} onClick={approve} className="rounded bg-brown-btn px-3 py-1 text-white disabled:opacity-50">{busy ? 'Approving…' : 'Approve'}</button>
            <button disabled={busy} onClick={() => { setOpen(null); setOutcome(null) }} className="rounded border border-border px-3 py-1">Cancel</button>
          </div>
        </div>
      )}
      <OutcomeLine outcome={outcome} />
    </section>
  )
}
```


- [ ] **Step 5: Route and nav (the nav test fails first)**

Replacement 1 in `src/shared/lib/nav.test.ts` — replace:

```ts
  it('POS groups the register, menu and POS settings; staff see only the register', () => {
```

with:

```ts
  it('POS groups the register, menu, POS settings and devices; staff see only the register', () => {
```

Replacement 2 in `src/shared/lib/nav.test.ts` — replace:

```ts
    expect(pos(canWith('access_settings'))).toEqual(['pos-register', 'pos-settings'])
    expect(pos(canWith('manage_menu'))).toEqual(['pos-register', 'menu'])
    expect(pos(canWith('access_settings', 'manage_menu'))).toEqual(['pos-register', 'menu', 'pos-settings'])
```

with:

```ts
    expect(pos(canWith('access_settings'))).toEqual(['pos-register', 'pos-settings', 'pos-devices'])
    expect(pos(canWith('manage_menu'))).toEqual(['pos-register', 'menu'])
    expect(pos(canWith('access_settings', 'manage_menu'))).toEqual(['pos-register', 'menu', 'pos-settings', 'pos-devices'])
```


Run: `npx vitest run src/shared/lib/nav.test.ts`
Expected: FAIL. `pos-devices` is missing from the lists.

Replacement 1 in `src/shared/lib/nav.ts` — replace:

```ts
      { id: 'pos-settings', label: 'POS Settings',      to: '/pos/settings', cap: 'access_settings' },
```

with:

```ts
      { id: 'pos-settings', label: 'POS Settings',      to: '/pos/settings', cap: 'access_settings' },
      { id: 'pos-devices',  label: 'Devices',           to: '/pos/devices', cap: 'access_settings' },
```


Replacement 1 in `src/App.tsx` — replace:

```tsx
import PosSettingsPage from './features/pos/order/PosSettingsPage'
```

with:

```tsx
import PosSettingsPage from './features/pos/order/PosSettingsPage'
import DevicesPage from './features/pos/devices/DevicesPage'
```

Replacement 2 in `src/App.tsx` — replace:

```tsx
      <Route
        path="/pos/settings"
        element={
          <ProtectedRoute requireCap="access_settings">
            <AppLayout><PosSettingsPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

with:

```tsx
      <Route
        path="/pos/settings"
        element={
          <ProtectedRoute requireCap="access_settings">
            <AppLayout><PosSettingsPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/pos/devices"
        element={
          <ProtectedRoute requireCap="access_settings">
            <AppLayout><DevicesPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```


- [ ] **Step 6: Run the checks and commit**

Run: `npx tsc -b && npx vitest run`
Expected: tsc silent; 131 files / 1075 tests.

```bash
git add src/features/pos/devices/devices.ts src/features/pos/devices/devices.test.ts src/features/pos/devices/devicesApi.ts \
  src/features/pos/devices/DevicesPage.tsx src/App.tsx src/shared/lib/nav.ts src/shared/lib/nav.test.ts
git commit -m "feat(pos): Devices page — HQ approves activation requests, managers see and unpair their outlets' devices

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: POS settings → Lock (implementer)

**Model tier:** cheap.

**Files:**
- Create: `src/features/pos/devices/LockSettingsSection.tsx`
- Modify: `src/features/pos/order/PosSettingsPage.tsx`

**Interfaces:**
- Consumes: `parseLockMinutes` (Task 3's `devices.ts`); `fetchIdleLockMinutes` and `saveIdleLockMinutes` (Task 3's `devicesApi.ts`).
- Produces: the "Lock" section under POS settings, keyed by outlet like its neighbours.

- [ ] **Step 1: Create the section**

Create `src/features/pos/devices/LockSettingsSection.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchIdleLockMinutes, saveIdleLockMinutes } from './devicesApi'
import { parseLockMinutes } from './devices'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** POS settings → Lock: minutes without a touch before a POS tablet locks (save_lock_settings). */
export default function LockSettingsSection({ branchId }: { branchId: string }) {
  const [text, setText] = useState<string | null>(null)        // null while loading or after a failed load
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const id = ++seq.current
    setText(null)
    try { const n = await fetchIdleLockMinutes(branchId); if (id === seq.current) setText(String(n)) }
    catch (e) { if (id === seq.current) setOutcome({ ok: false, text: `Could not load the lock setting: ${msg(e)}` }) }
  }, [branchId])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (text === null || running.current) return
    const n = parseLockMinutes(text)
    if (n === null) { setOutcome({ ok: false, text: 'Enter between 1 and 60 minutes' }); return }
    running.current = true; setBusy(true); setOutcome(null)
    try { await saveIdleLockMinutes(branchId, n); setText(String(n)); setOutcome({ ok: true, text: 'Lock setting saved' }) }
    catch (e) { setOutcome({ ok: false, text: msg(e) }) } finally { running.current = false; setBusy(false) }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="font-semibold">Lock</h2>
      <p className="text-xs text-brown-muted">A POS tablet locks after this many minutes without a touch; the next person signs in with their PIN. While the tablet is offline it does not lock by itself.</p>
      <label className="mt-2 block text-sm">Lock after
        <input className="mx-2 w-16 rounded border border-border p-1" inputMode="numeric" disabled={text === null}
          value={text ?? ''} onChange={(e) => { setText(e.target.value); setOutcome(null) }} />
        minutes
      </label>
      <button disabled={text === null || busy} onClick={() => void save()} className="mt-2 rounded bg-brown-btn px-3 py-1 text-sm text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save lock setting'}</button>
      {outcome && (outcome.ok
        ? <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{outcome.text}</p>
        : <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{outcome.text}</p>)}
    </section>
  )
}
```


- [ ] **Step 2: Mount it on the page**

Replacement 1 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
import ShiftSettingsSection from '../shift/ShiftSettingsSection'
```

with:

```tsx
import ShiftSettingsSection from '../shift/ShiftSettingsSection'
import LockSettingsSection from '../devices/LockSettingsSection'
```

Replacement 2 in `src/features/pos/order/PosSettingsPage.tsx` — replace:

```tsx
      <ShiftSettingsSection key={`shift:${branchId}`} branchId={branchId} />
```

with:

```tsx
      <ShiftSettingsSection key={`shift:${branchId}`} branchId={branchId} />

      <LockSettingsSection key={`lock:${branchId}`} branchId={branchId} />
```


- [ ] **Step 3: Run the checks and commit**

Run: `npx tsc -b && npx vitest run && wc -l src/features/pos/order/PosSettingsPage.tsx`
Expected: tsc silent; 131 files / 1075 tests; 250 lines.

```bash
git add src/features/pos/devices/LockSettingsSection.tsx src/features/pos/order/PosSettingsPage.tsx
git commit -m "feat(pos): POS settings → Lock — minutes before a POS tablet locks, per outlet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Browser check on dev and push (controller)

- [ ] **Step 1:** Use the `pos-menu-dev` preview (port 5174; dev database), signed in as the dev owner. The owner signs in; Claude never types a password.
- [ ] **Step 2: Approve from the page.**
  1. Create a request with the function: `{"action":"request","name":"BROWSER iPad","platform":"ipad"}`.
  2. Open `/pos/devices`. "Waiting for approval" lists the code (or press Refresh).
  3. Approve… with a wrong code → "The code does not match the tablet", shown beside the form.
  4. With the right code, outlet Demo, kind POS → "BROWSER iPad approved — …".
  5. A poll with the secret returns `approved`. The device then appears in the Devices list ("Never" last seen).
- [ ] **Step 2b: Printing tablet.**
  1. Approve a second request "BROWSER Front" at Demo with "This tablet prints and holds the cash drawer" ticked, and poll it.
  2. Its row shows "Prints · cash drawer".
  3. Press "Make printing tablet" on BROWSER iPad → "BROWSER iPad now prints and holds the cash drawer at Demo". The badge moves.
  4. With Kind "Print agent" the checkbox is hidden.
- [ ] **Step 3: Unpair.** Unpair BROWSER iPad and BROWSER Front → confirm → "… unpaired". The rows grey and show "Unpaired …", and the badge is gone.
- [ ] **Step 4: Reject.** Create a second request and Reject it → "Request … rejected". A poll returns `rejected`.
- [ ] **Step 5: Lock setting.** POS settings → Lock: 0 → "Enter between 1 and 60 minutes"; 15 → "Lock setting saved". Switching the outlet shows that outlet's own value.
- [ ] **Step 6: Branch-only manager view.** As a dev manager login, if the owner signs one in: no "Waiting for approval" section, and only that manager's outlets' devices. If no manager login is available, say so in the report.
- [ ] **Step 7: Console:** no errors.
- [ ] **Step 8: Push:**

```bash
git push origin feature/pos-demo
```

## Open points (not in this plan)

- **Prod:**
  - Set All Branches off for Manager. The owner does it in Settings → System Roles, or allows prod SQL in this session.
  - Run Sub-plan A, then this migration, after the POS SQL chain.
  - Deploy the function with `--no-verify-jwt`.
- **Part C** consumes the roster, sign-in, `pos_ctx()` and the coded errors. From Sub-plan A's final review it must also re-create these, which still read `auth.uid()` / `pos_my_branch()`:
  - `pos_approvers()`;
  - `pos_pin_attempt` (the caller becomes the session's staff member);
  - `insert_test_print` (its null path);
  - `branch_menu_status_write` (`pos_caller_branch`).

  It should also add an index on `staff_outlets(branch_id)` and scope `dining_tables_update using (true)`.
- **Housekeeping:** activation requests and login attempts are never deleted. That is fine at this scale; a cleanup job can come later.
