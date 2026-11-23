# Kepong Branch + Clock-In Geofence Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Kepong branch (with a working GPS clock-in geofence) and give Settings → Branches the latitude/longitude/radius fields that until now only SQL could set.

**Architecture:** A validated pure parser (`src/shared/lib/geofence.ts`) turns three free-text form fields into the three nullable `branches` columns; the existing `BranchModal` consumes it and finally verifies its own write via `writeOutcome`. The branch itself is data: one idempotent migration for production, plus a seed update so fresh databases match. The hardcoded `BRANCHES` list gains one entry and loses its duplicate copy.

**Tech Stack:** React 18 + TypeScript + Vite, Tailwind, Supabase (Postgres + RLS), vitest.

## Global Constraints

- All UI labels, copy, placeholders and error strings are **English**. Comments and docs may be Chinese.
- Branch dropdown display value: `Kepong (Taman Usahawan)`. `branches.name` in the database: `Kepong`. These differ on purpose — `ClockModal.tsx:102` matches on the first word of `staff.branch`.
- Kepong geofence values: latitude `3.2173718`, longitude `101.6406565`, radius `100` meters.
- Kepong address: `B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong, 52100 Kuala Lumpur`.
- Coordinates left blank must keep the existing behaviour: `ClockModal.tsx:111` skips the distance check entirely when `latitude`/`longitude` are null. Never make them required.
- Work stays on the current branch `feature/tasks-projects`. **Never `git checkout` another branch** — the working tree is shared with other live sessions and a switch auto-stashes their uncommitted files. `git add` only the exact paths each task names; `src/features/hr/HrClaims.tsx`, `HrLeave.tsx`, `HrSalary.tsx` and `.claude/launch.json` are another session's work — leave them dirty and uncommitted.
- Do not run migrations against production. The migration file is handed to the user to run in the Supabase SQL Editor (no service_role key exists locally).
- Test command: `npx vitest run`. Typecheck: `npx tsc -b`.

---

### Task 1: Geofence parser

**Files:**
- Create: `src/shared/lib/geofence.ts`
- Test: `src/shared/lib/geofence.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseBranchGeofence(lat: string, lng: string, radius: string): GeofenceParseResult`, where
  `GeofenceParseResult = { ok: true; latitude: number | null; longitude: number | null; radius_meters: number | null } | { ok: false; error: string }`.
  Task 2 calls this and spreads the three numeric fields straight into the `branches` payload.

Why the validation is the point, not decoration: a coordinate typed one digit wrong locks every employee at that branch out of clocking in, and the only thing they see is `You are 8000m away from Kepong` — nobody can trace that back to a bad value in Settings. Same for a radius of `1`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/lib/geofence.test.ts`. The module is pure and imports nothing from Supabase, so unlike `permissions.test.ts` it needs no `vi.mock` preamble.

```ts
import { describe, it, expect } from 'vitest'
import { parseBranchGeofence } from './geofence'

describe('parseBranchGeofence', () => {
  it('all three blank: clears the geofence (clock-in from anywhere)', () => {
    expect(parseBranchGeofence('', '', '')).toEqual({
      ok: true, latitude: null, longitude: null, radius_meters: null,
    })
  })

  it('whitespace counts as blank', () => {
    expect(parseBranchGeofence('  ', '\t', ' ')).toEqual({
      ok: true, latitude: null, longitude: null, radius_meters: null,
    })
  })

  it('accepts Kepong normal values', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '100')).toEqual({
      ok: true, latitude: 3.2173718, longitude: 101.6406565, radius_meters: 100,
    })
  })

  it('splits a "lat,lng" pair pasted into the latitude field alone', () => {
    expect(parseBranchGeofence('3.2173718,101.6406565', '', '100')).toEqual({
      ok: true, latitude: 3.2173718, longitude: 101.6406565, radius_meters: 100,
    })
  })

  it('tolerates spaces around a pasted pair', () => {
    expect(parseBranchGeofence(' 3.2173718, 101.6406565 ', '', '')).toEqual({
      ok: true, latitude: 3.2173718, longitude: 101.6406565, radius_meters: null,
    })
  })

  it('does not split a pasted pair when longitude is already filled', () => {
    const res = parseBranchGeofence('3.2173718,101.6406565', '101.6406565', '100')
    expect(res).toEqual({ ok: false, error: 'Latitude and longitude must be numbers.' })
  })

  it('rejects latitude without longitude', () => {
    expect(parseBranchGeofence('3.2173718', '', '')).toEqual({
      ok: false, error: 'Enter both latitude and longitude, or leave both blank.',
    })
  })

  it('rejects longitude without latitude', () => {
    expect(parseBranchGeofence('', '101.6406565', '')).toEqual({
      ok: false, error: 'Enter both latitude and longitude, or leave both blank.',
    })
  })

  it('rejects a radius with no coordinates to centre it on', () => {
    expect(parseBranchGeofence('', '', '100')).toEqual({
      ok: false, error: 'Set a latitude and longitude before setting a radius.',
    })
  })

  it('rejects non-numeric coordinates', () => {
    expect(parseBranchGeofence('three', '101.6406565', '')).toEqual({
      ok: false, error: 'Latitude and longitude must be numbers.',
    })
  })

  it('rejects latitude out of range', () => {
    expect(parseBranchGeofence('91', '101.6406565', '')).toEqual({
      ok: false, error: 'Latitude must be between -90 and 90.',
    })
  })

  it('rejects longitude out of range', () => {
    expect(parseBranchGeofence('3.2173718', '181', '')).toEqual({
      ok: false, error: 'Longitude must be between -180 and 180.',
    })
  })

  it('accepts negative coordinates (southern/western hemispheres)', () => {
    expect(parseBranchGeofence('-33.8688', '-70.6693', '100')).toEqual({
      ok: true, latitude: -33.8688, longitude: -70.6693, radius_meters: 100,
    })
  })

  it('blank radius with coordinates set leaves the app default to apply', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '')).toEqual({
      ok: true, latitude: 3.2173718, longitude: 101.6406565, radius_meters: null,
    })
  })

  it('rejects a radius below 20m — it would lock everyone out', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '1')).toEqual({
      ok: false, error: 'Radius must be a whole number between 20 and 2000 meters.',
    })
  })

  it('rejects a radius above 2000m', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '5000')).toEqual({
      ok: false, error: 'Radius must be a whole number between 20 and 2000 meters.',
    })
  })

  it('rejects a fractional radius', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', '100.5')).toEqual({
      ok: false, error: 'Radius must be a whole number between 20 and 2000 meters.',
    })
  })

  it('rejects a non-numeric radius', () => {
    expect(parseBranchGeofence('3.2173718', '101.6406565', 'wide')).toEqual({
      ok: false, error: 'Radius must be a whole number between 20 and 2000 meters.',
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/lib/geofence.test.ts`
Expected: FAIL — `Failed to resolve import "./geofence"`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/lib/geofence.ts`:

```ts
/** Parsed geofence values, shaped to drop straight onto a `branches` row.
 *
 *  All three columns are nullable and must stay that way: ClockModal.tsx:111
 *  skips the distance check entirely when a branch has no coordinates, which
 *  is how the two pre-existing branches still work. */
export type GeofenceParseResult =
  | { ok: true; latitude: number | null; longitude: number | null; radius_meters: number | null }
  | { ok: false; error: string }

/** Google Maps copies a location as "3.2173718,101.6406565" — one string. */
const LAT_LNG_PAIR = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/

/** Hard floor on the radius. A branch saved with 1m would reject every
 *  clock-in at that branch, and the staff-facing message ("You are 12m away
 *  from X") gives nobody a reason to suspect the setting. */
const MIN_RADIUS_M = 20
const MAX_RADIUS_M = 2000

export function parseBranchGeofence(lat: string, lng: string, radius: string): GeofenceParseResult {
  let latRaw = lat.trim()
  let lngRaw = lng.trim()
  const radiusRaw = radius.trim()

  // Accept a pasted "lat,lng" pair in the latitude field rather than rejecting
  // the exact thing someone copying from Google Maps will paste first.
  const pair = LAT_LNG_PAIR.exec(latRaw)
  if (pair && !lngRaw) {
    latRaw = pair[1]
    lngRaw = pair[2]
  }

  if (!latRaw && !lngRaw) {
    if (radiusRaw) {
      return { ok: false, error: 'Set a latitude and longitude before setting a radius.' }
    }
    return { ok: true, latitude: null, longitude: null, radius_meters: null }
  }

  if (!latRaw || !lngRaw) {
    return { ok: false, error: 'Enter both latitude and longitude, or leave both blank.' }
  }

  const latNum = Number(latRaw)
  const lngNum = Number(lngRaw)
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return { ok: false, error: 'Latitude and longitude must be numbers.' }
  }
  if (latNum < -90 || latNum > 90) {
    return { ok: false, error: 'Latitude must be between -90 and 90.' }
  }
  if (lngNum < -180 || lngNum > 180) {
    return { ok: false, error: 'Longitude must be between -180 and 180.' }
  }

  if (!radiusRaw) {
    // Coordinates without a radius: ClockModal falls back to 100m (`:119`).
    return { ok: true, latitude: latNum, longitude: lngNum, radius_meters: null }
  }

  const radiusNum = Number(radiusRaw)
  if (!Number.isInteger(radiusNum) || radiusNum < MIN_RADIUS_M || radiusNum > MAX_RADIUS_M) {
    return {
      ok: false,
      error: `Radius must be a whole number between ${MIN_RADIUS_M} and ${MAX_RADIUS_M} meters.`,
    }
  }

  return { ok: true, latitude: latNum, longitude: lngNum, radius_meters: radiusNum }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/lib/geofence.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/lib/geofence.ts src/shared/lib/geofence.test.ts
git commit -m "feat(settings): validated parser for branch clock-in geofence values"
```

---

### Task 2: Geofence fields in the Branches modal

**Files:**
- Modify: `src/features/settings/Settings.tsx` — import block (`:8-11`), `BranchModal` state (`:196-202`), `handleSave` (`:207-223`), modal body JSX (after the Operating Hours field, `:251-254`)

**Interfaces:**
- Consumes: `parseBranchGeofence` from Task 1; `writeOutcome` from `src/shared/lib/db-write.ts` (already imported at `Settings.tsx:14`).
- Produces: nothing other tasks depend on.

Two changes ship together because they are the same bug surface. The modal currently fires `await supabase.from('branches').insert(payload)` and never looks at the result (`:216-220`), which [db-write.ts:16](src/shared/lib/db-write.ts:16) explicitly forbids: an RLS-filtered write returns **no error and no rows**, so the modal closes, the list refreshes without the change, and the manager believes the geofence was saved. Adding geofence fields to a write that can silently vanish would ship the lockout bug, not fix it.

- [ ] **Step 1: Add the import**

In the second import block (`Settings.tsx:8-11`), below the existing `useLookups` / `useCan` / `writeOutcome` imports (`:12-14`), add:

```ts
import { parseBranchGeofence } from '../../shared/lib/geofence'
```

- [ ] **Step 2: Extend the form state**

Replace the `useState` initialiser in `BranchModal` (`Settings.tsx:197-202`):

```ts
  const [form, setForm] = useState({
    name: branch?.name ?? '',
    address: branch?.address ?? '',
    pic_staff_id: branch?.pic_staff_id ?? '',
    operating_hours: branch?.operating_hours ?? '',
    latitude: branch?.latitude != null ? String(branch.latitude) : '',
    longitude: branch?.longitude != null ? String(branch.longitude) : '',
    radius_meters: branch?.radius_meters != null ? String(branch.radius_meters) : '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [locating, setLocating] = useState(false)
```

Coordinates are held as strings all the way to save: a controlled number input that reparses on every keystroke eats the decimal point while someone is typing `3.2`.

- [ ] **Step 3: Add the "use my current location" handler**

Immediately after the `set` helper (`Settings.tsx:204-205`), add:

```ts
  // Not named `use…` — the React hooks lint rule treats that prefix as a hook.
  function fillCurrentLocation() {
    setLocating(true)
    setError('')
    navigator.geolocation.getCurrentPosition(
      pos => {
        setForm(f => ({
          ...f,
          latitude: pos.coords.latitude.toFixed(7),
          longitude: pos.coords.longitude.toFixed(7),
        }))
        setLocating(false)
      },
      () => {
        setError('Could not read your location. Check your browser or device location settings.')
        setLocating(false)
      },
      { timeout: 12000, enableHighAccuracy: true },
    )
  }
```

- [ ] **Step 4: Rewrite handleSave**

Replace `handleSave` in full (`Settings.tsx:207-223`):

```ts
  async function handleSave() {
    if (!form.name.trim()) return

    const geo = parseBranchGeofence(form.latitude, form.longitude, form.radius_meters)
    if (!geo.ok) {
      setError(geo.error)
      return
    }
    setError('')
    setSaving(true)

    const payload = {
      name: form.name.trim(),
      address: form.address.trim() || null,
      pic_staff_id: form.pic_staff_id || null,
      operating_hours: form.operating_hours.trim() || null,
      latitude: geo.latitude,
      longitude: geo.longitude,
      radius_meters: geo.radius_meters,
    }

    // `.select()` + writeOutcome: an RLS-filtered write comes back with no
    // error AND no rows, so the returned row is the only proof it landed.
    // See src/shared/lib/db-write.ts.
    const res = branch?.id
      ? await supabase.from('branches').update(payload).eq('id', branch.id).select()
      : await supabase.from('branches').insert(payload).select()

    const outcome = writeOutcome(res)
    setSaving(false)
    if (!outcome.ok) {
      setError(`Could not save this branch — ${outcome.reason}`)
      return
    }

    onSaved()
    onClose()
  }
```

- [ ] **Step 5: Add the geofence section to the JSX**

In the modal body, between the Operating Hours field (`Settings.tsx:251-254`) and the button row (`:255`), insert:

```tsx
          <div className="pt-3 border-t border-[#E8DDD0]">
            <div className="flex items-center justify-between mb-1">
              <label className={labelCls}>Clock-In Geofence</label>
              <button
                type="button"
                onClick={fillCurrentLocation}
                disabled={locating}
                className="text-xs font-semibold text-[#C4813A] hover:text-[#A86C2C] disabled:opacity-60"
              >
                {locating ? 'Locating...' : 'Use my current location'}
              </button>
            </div>
            <p className="text-xs text-brown-faint mb-3">
              Leave blank to allow clock-in from anywhere. Radius defaults to 100m.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Latitude</label>
                <input className={inputCls} value={form.latitude} onChange={set('latitude')} placeholder="3.2173718" />
              </div>
              <div>
                <label className={labelCls}>Longitude</label>
                <input className={inputCls} value={form.longitude} onChange={set('longitude')} placeholder="101.6406565" />
              </div>
            </div>
            <div className="mt-3">
              <label className={labelCls}>Radius (meters)</label>
              <input className={inputCls} value={form.radius_meters} onChange={set('radius_meters')} placeholder="100" />
            </div>
          </div>
          {error && <p className="text-xs text-[#9E4A30] font-medium">{error}</p>}
```

`labelCls` (`:34`) and `inputCls` (`:32`) are the module-level constants this modal already uses. `#9E4A30` is the repo's error brown (`types/index.ts:301`).

- [ ] **Step 6: Typecheck and run the suite**

Run: `npx tsc -b && npx vitest run`
Expected: tsc silent (exit 0); vitest all green.

- [ ] **Step 7: Commit**

```bash
git add src/features/settings/Settings.tsx
git commit -m "feat(settings): set a branch clock-in geofence from the Branches modal

Also makes the modal's save verify itself with .select() + writeOutcome. It
was fire-and-forget, so an RLS-filtered write (no error, no rows) closed the
modal as if it had saved — which for a geofence would mean staff locked out
of clocking in with nothing on screen to explain it."
```

---

### Task 3: Kepong in the branch dropdowns

**Files:**
- Modify: `src/shared/types/index.ts:308`
- Modify: `src/features/onboarding/Onboarding.tsx:1-13` (delete the duplicate list, import the shared one)
- Modify: `src/features/team/Directory.tsx:38-43` (`shortenBranch`) and `:742` (inline duplicate)

**Interfaces:**
- Consumes: nothing.
- Produces: `BRANCHES` gains the entry `'Kepong (Taman Usahawan)'`, consumed by Register (`:142`), Directory (`:137`, `:834`), StaffProfile (`:1317`), Schedule (`:234`), HrAttendance (`:176`) and — after this task — Onboarding (`:328`).

- [ ] **Step 1: Add Kepong to the shared constant**

`src/shared/types/index.ts:308` — replace:

```ts
export const BRANCHES = ['Cheras (Taman Connaught)', 'Puchong (Bandar Puteri)', 'Other']
```

with:

```ts
export const BRANCHES = [
  'Cheras (Taman Connaught)',
  'Puchong (Bandar Puteri)',
  'Kepong (Taman Usahawan)',
  'Other',
]
```

`'Other'` stays last — it is the catch-all and reads wrong mid-list.

- [ ] **Step 2: Delete Onboarding's duplicate list**

`src/features/onboarding/Onboarding.tsx` — delete lines 9-13 (the local `const BRANCHES = [...]`) and add the shared import after the `useLookups` import at `:5`:

```ts
import { BRANCHES } from '../../shared/types'
```

The `// ─── Data ───` comment banner at `:7` stays; `COMPANY_VALUES` below it still lives there. `Onboarding.tsx:328` keeps calling `BRANCHES.map` unchanged.

Two copies of the same list with nothing keeping them in sync is why Kepong would have been missed on the onboarding page. Accepted trade-off (confirmed with the user): editing `BRANCHES` now also moves the onboarding radio tiles.

- [ ] **Step 3: Teach shortenBranch about Kepong**

`src/features/team/Directory.tsx:38-43` — replace:

```ts
function shortenBranch(branch: string | null): string {
  if (!branch) return '—'
  if (branch.includes('Connaught')) return 'Cheras'
  if (branch.includes('Puteri')) return 'Puchong'
  return branch
}
```

with:

```ts
function shortenBranch(branch: string | null): string {
  if (!branch) return '—'
  if (branch.includes('Connaught')) return 'Cheras'
  if (branch.includes('Puteri')) return 'Puchong'
  if (branch.includes('Usahawan')) return 'Kepong'
  return branch
}
```

- [ ] **Step 4: Fold the inline duplicate into shortenBranch**

`src/features/team/Directory.tsx:742` — replace:

```tsx
                                {req.branch.includes('Connaught') ? 'Cheras' : req.branch.includes('Puteri') ? 'Puchong' : req.branch}
```

with:

```tsx
                                {shortenBranch(req.branch)}
```

This is the same mapping written twice; the ternary is why a third branch has to be added in two places. Inside this JSX, `req.branch` is already truthy (guarded by `{req.branch && (` at `:740`), so the `'—'` arm is unreachable here — behaviour is unchanged.

- [ ] **Step 5: Typecheck and run the suite**

Run: `npx tsc -b && npx vitest run`
Expected: tsc silent; vitest all green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/index.ts src/features/onboarding/Onboarding.tsx src/features/team/Directory.tsx
git commit -m "feat(branches): add Kepong to the branch options

Onboarding kept a second copy of the BRANCHES list that nothing synced, and
Directory had the branch-shortening map written twice. Both folded into the
shared definitions so the next branch is a one-line change."
```

---

### Task 4: Kepong branch row (production migration + fresh-build seed)

**Files:**
- Create: `supabase/migration-2026-10-12-branch-kepong.sql`
- Modify: `supabase/schema.sql:372-378` (seed) and `:660-662` (geofence columns block)
- Modify: `supabase/FRESH_BUILD_full.sql:371-377` (seed) and `:659-661` (geofence columns block)

**Interfaces:**
- Consumes: nothing.
- Produces: a `branches` row named `Kepong` with the geofence set, which `ClockModal.tsx:106` finds by `ilike '%Kepong%'`.

Ordering trap, confirmed by reading the files: the seed sits at `schema.sql:372` but `latitude` / `longitude` / `radius_meters` are only added at `:660`. A seed that references those columns fails on a fresh build. Coordinates therefore go in an `update` placed **after** the `alter table ... add column` block.

- [ ] **Step 1: Write the migration**

Create `supabase/migration-2026-10-12-branch-kepong.sql`:

```sql
-- ============================================================================
-- Add the Kepong branch + its clock-in geofence (2026-10-12, v1)
--
-- Third outlet: B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong,
-- 52100 Kuala Lumpur. Coordinates from Google Maps: 3.2173718, 101.6406565.
--
-- `branches.name` is 'Kepong', NOT the full 'Kepong (Taman Usahawan)' shown in
-- the app's dropdowns. ClockModal.tsx:102 takes the FIRST WORD of staff.branch
-- and matches it with `ilike '%word%'` against branches.name, so the short name
-- is what makes the geofence resolve — same as Cheras and Puchong.
--
-- Idempotent: safe to run more than once. Re-running inserts nothing and
-- overwrites nothing that is already set.
-- ============================================================================

-- 1. The branch row itself.
insert into branches (name, address, latitude, longitude, radius_meters)
select 'Kepong',
       'B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong, 52100 Kuala Lumpur',
       3.2173718,
       101.6406565,
       100
where not exists (select 1 from branches where name ilike 'Kepong');

-- 2. If a Kepong row was already created by hand (via Settings → Branches,
--    which until now had no geofence fields), fill only what is still empty.
--    coalesce, not assignment: never clobber a value someone has since tuned.
update branches
   set address       = coalesce(address, 'B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong, 52100 Kuala Lumpur'),
       latitude      = coalesce(latitude, 3.2173718),
       longitude     = coalesce(longitude, 101.6406565),
       radius_meters = coalesce(radius_meters, 100)
 where name ilike 'Kepong';

-- 3. Backfill staff.branch_id from the free-text branch, same join as
--    migration-2026-07-06-rbac.sql:90. The front end never writes branch_id,
--    so anyone already set to Kepong has it null — and supervisor scoping
--    (HrAttendance.tsx:1192, Schedule.tsx:652, Directory.tsx:535) reads it.
update staff s
   set branch_id = b.id
  from branches b
 where s.branch_id is null
   and s.branch is not null
   and s.branch ilike '%' || b.name || '%';

-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect exactly one Kepong row, 3.2173718 / 101.6406565 / 100, is_active true.
select name, address, latitude, longitude, radius_meters, is_active
  from branches
 order by name;

-- Expect every staff member whose branch text names a real branch to have a
-- branch_id. Rows here are staff on 'Other' or on a branch with no row.
select id, name, branch, branch_id
  from staff
 where branch_id is null and branch is not null
 order by branch, name;
```

- [ ] **Step 2: Add Kepong to both seed blocks**

`supabase/schema.sql:372-378` and the identical `supabase/FRESH_BUILD_full.sql:371-377` — in each, replace:

```sql
insert into branches (name, address)
select v.name, v.address
from (values
  ('Cheras', 'Taman Connaught, Cheras'),
  ('Puchong', 'Bandar Puteri, Puchong')
) as v(name, address)
where not exists (select 1 from branches);
```

with:

```sql
-- Coordinates are NOT set here: latitude/longitude/radius_meters are added to
-- this table further down the file, so they do not exist yet at this point.
-- Kepong's geofence is filled in right after that ALTER block.
insert into branches (name, address)
select v.name, v.address
from (values
  ('Cheras', 'Taman Connaught, Cheras'),
  ('Puchong', 'Bandar Puteri, Puchong'),
  ('Kepong', 'B-G, 1, Jln Metro Perdana 1, Taman Usahawan Kepong, 52100 Kuala Lumpur')
) as v(name, address)
where not exists (select 1 from branches);
```

- [ ] **Step 3: Fill Kepong's geofence after the columns exist**

In `supabase/schema.sql`, directly below the three `alter table branches add column ...` lines (`:660-662`), and the same in `supabase/FRESH_BUILD_full.sql` (`:659-661`), append:

```sql

-- Kepong is the one branch whose coordinates we have; the other two keep null
-- latitude/longitude, which ClockModal.tsx:111 treats as "no distance check".
update branches
   set latitude      = coalesce(latitude, 3.2173718),
       longitude     = coalesce(longitude, 101.6406565),
       radius_meters = coalesce(radius_meters, 100)
 where name ilike 'Kepong';
```

- [ ] **Step 4: Check the SQL parses**

There is no local database, so this is a read-through, not an execution. Confirm by eye:
- every statement ends in `;`
- `insert ... select ... where not exists` has no `from` clause other than the implicit one (correct — a bare `select` with `where not exists` yields zero or one row)
- the two seed blocks are byte-identical between `schema.sql` and `FRESH_BUILD_full.sql`

Run: `diff <(sed -n '370,382p' supabase/schema.sql) <(sed -n '369,381p' supabase/FRESH_BUILD_full.sql)`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-10-12-branch-kepong.sql supabase/schema.sql supabase/FRESH_BUILD_full.sql
git commit -m "feat(db): add the Kepong branch with its clock-in geofence

Seed keeps (name, address) only — latitude/longitude/radius_meters are added
to branches further down the file, so the seed cannot reference them. Kepong's
coordinates are set by an update placed after that ALTER block."
```

- [ ] **Step 6: Hand the migration to the user**

Do not run it. Tell the user to paste `supabase/migration-2026-10-12-branch-kepong.sql` into the Supabase SQL Editor of the **Craft-Os-Prod** project (`yfsoesxzurzjdwstszru`), and report back the two verification selects at the bottom.

---

## Acceptance

1. `npx vitest run` green; `npx tsc -b` silent.
2. Migration run in Supabase SQL Editor: first verify query shows one `Kepong` row with `3.2173718 / 101.6406565 / 100`; running the whole file a second time changes nothing.
3. `Settings → Branches` lists Kepong; Edit shows its coordinates and radius; typing `91` into Latitude shows `Latitude must be between -90 and 90.` in red and does not save.
4. `Kepong (Taman Usahawan)` appears in all seven dropdowns: Register, Onboarding, Directory filter, Directory add-staff, StaffProfile, Schedule filter, HrAttendance filter.
5. A staff member whose branch is Kepong can complete GPS + selfie clock-in within 100m of the coordinates, and gets `You are Nm away from Kepong.` outside it.
