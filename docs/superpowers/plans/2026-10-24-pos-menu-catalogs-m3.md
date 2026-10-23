# POS · Menu catalogs M3 — Time slots and photos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner (capability **Edit menu**, `manage_menu`) decides **when** each product sells and **what it looks like** on the QR menu. Time availability works the Feedme way: named, reusable **schedules** (e.g. "Breakfast · Mon–Fri · 08:00–11:30"), each with one or more time windows, ticked on the products that follow them — from a new **Schedules** page under `/menu` or from a **Time slots** section in the product editor. Outside every window of its schedules a product is refused by the server ("Big Breakfast is not available at this time" — offline orders too, by the server's clock, into the existing Rejected strip), hidden on the QR page and greyed out at the counter with "Available 08:00–11:30"; both screens read the slots again every minute, so a schedule edit reaches an open pad or QR page within a minute. Like Feedme, a schedule has no on/off switch: it is **deleted**. Each product gets one **photo** (bucket `menu-images`, resized in the browser to at most 800 px wide), uploaded in a **Photo** section of the product editor or copied in bulk from a zip of Feedme photos on `/menu/import`; photos show on the QR page, the counter keeps text tiles.

**Architecture:** Two migrations. `supabase/migration-2026-10-24-pos-slots-photos.sql` adds three tables (`menu_schedules`, `menu_schedule_windows`, `product_schedules`; read-only to staff, written only through functions), `menu_products.image_path` / `image_updated_at`, and the public `menu-images` bucket (listable by signed-in staff only, written with Edit menu). `supabase/migration-2026-10-24-pos-slots-photos-fn.sql` adds **new** functions — the time maths (`menu_window_open`, `menu_product_open`), the Schedules page and product editor calls, the import's photo targets, the counter's `pos_menu_windows` — and re-creates only `pos_insert_order` (one added check) and `qr_menu` (one added filter, one added key) from their live text in M1's file; it becomes their canonical definition. No M2 function is re-created: `menu_save_product` stays as it is, because Time slots and Photo save on their own. On the client the time maths is one pure module, `timeSlots.ts`, checked against the same 19 vectors as the SQL (`slotVectors.json`, copied byte for byte into the verify script); every other rule lives in pure modules with Vitest tests (`scheduleForm`, `photo`, `photoImport`, `padSlots`, `qrState`), the photo upload's failure handling and the pad's per-minute re-read (`usePadWindows`) are tested with their I/O mocked, and the pages stay thin.

**Tech Stack:** React 19 + Vite 6 + TypeScript + Tailwind, Supabase (Postgres RLS, plpgsql `security definer` RPCs, Storage, Realtime), Vitest, `fflate` (already a dependency) for the photo zip. No ESLint config in the repo; the gates are `npx tsc -b` and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md` — §2 (`product_schedules`, the image columns), §3 (time slots), §5 (photos), §8-M3, §9 and §10 bind this plan, with the Spec deltas below. Builds on M1 (`docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m1.md`) and M2 (`docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m2.md`, head `1b550cd`). Feedme reference: `docs/superpowers/research/2026-10-23-feedme-back-office-teardown.md` §1.2 (product image) and §1.7 (Scheduler).

## Spec deltas (decided while planning, 2026-10-24)

The owner asked, before sleeping, that open choices follow Feedme's behaviour. Choices marked **assumed — Feedme behaviour (owner asleep, 2026-10-24)** do that; the Open points list them again.

- **Time slots are named, reusable schedules, not rows per product.** Feedme's back office models time availability as *Schedulers* — name · repeat · period · applied products ("Grab Combo Set · Daily · 10:00 am – 11:59 pm · 10 items"). Spec §2's `product_schedules (id, product_id, days, start_time, end_time)` becomes three tables — the spec's per-product columns moved to `menu_schedule_windows`, and the name `product_schedules` is reused for the **links** (do not read spec §2's columns into it): `menu_schedules (id, name unique, sort_order, created_at)`; `menu_schedule_windows (id, schedule_id, days smallint[] ISO 1=Mon…7=Sun, start_time, end_time, sort_order; start ≠ end; end < start crosses midnight; days = the day a window starts)`; and `product_schedules (product_id, schedule_id)` links. **A product that follows no schedule sells at any time; one that follows schedules sells inside ANY window of them.** One schedule has 1–10 windows; one product follows at most 20 schedules, checked from both sides (the product editor and the schedule's product list: "<product> follows too many schedules (at most 20)"). **Assumed — Feedme behaviour (owner asleep, 2026-10-24).**
- **Both the start and the end minute are inside a window**, to the last second of the end minute (Feedme's "10:00 am – 11:59 pm" means "until midnight"). Times are whole minutes, Malaysia time (UTC+8 all year). **Assumed — Feedme behaviour (owner asleep, 2026-10-24).**
- **A schedule has no on/off switch; it is deleted** (Feedme's Scheduler has Delete, no switch). `menu_delete_schedule` removes the schedule, its windows and its product links — no order refers to any of them (orders snapshot names and prices) — after a confirm that names how many products follow it; those products then sell at any time unless another schedule they follow says otherwise. The foreign keys to `menu_schedules` have no cascade, so nothing else can delete them by accident. **Assumed — Feedme behaviour (owner asleep, 2026-10-24).** `menu_schedules` therefore has no `is_active` column (M3 has not run anywhere yet, so nothing needs migrating).
- **`menu_save_product` is not re-created** (M2's plan expected M3 to). The product editor's **Photo** and **Time slots** sections save on their own (`menu_set_product_image`, `menu_set_product_schedules`), each with its outcome in the section (the per-section lesson), and appear once the product has been created. A product's schedules can be set from both sides — the product editor and the schedule's product list; the last save wins.
- **Configuration rows are deleted, nothing an order refers to is.** Saving a schedule replaces its windows; unticking removes a `product_schedules` link; deleting a schedule removes it with both. Orders snapshot names and prices, never a schedule.
- **`qr_menu` returns each product's `imagePath`, not a URL**: Postgres does not know the project's public URL (dev and prod differ), so the QR page turns the path into the public URL with the Storage client's `getPublicUrl` (no request is made).
- **WebP where the browser can make it, else JPEG.** Safari's canvas cannot encode WebP; there the photo is JPEG at quality 0.8 (`.jpg`). Photos are drawn at most 800 px wide **and 1600 px high** (a very tall picture would pass the bucket's limit and Safari's canvas limit), the right way up (`imageOrientation: 'from-image'`). The bucket takes `image/webp` and `image/jpeg`, at most 2 MB per file (an 800 px photo is ~50–150 KB). The input must be an image under 10 MB.
- **The bucket is listable by signed-in staff only.** Customers load photos by their public URL (`/object/public/…`, no policy needed); the editors' upload and remove need SELECT, so `menu_images_read` is `to authenticated`.
- **The counter reads time slots through a new `pos_menu_windows(catalog)`** instead of a re-created `pos_menu_rows`: re-running M2's file can then never strip the windows. It lists the windows of the catalog's products on sale (switched on, not add-on items, as `pos_menu_rows`) and returns the server's clock; the pad greys products out by the server's time, so a wrong iPad clock does not matter. **The pad reads it again at the start of every minute** (`usePadWindows`), so a schedule edit reaches an open pad within a minute and the pre-send check uses fresh windows; a failed read keeps the last windows and tries again the next minute.
- **The counter's label** is the next window that opens later today ("Available 08:00–11:30"), else "Not available now" (spec §3 only named the first case).
- **The QR page reads `qr_menu` again every minute** while it is in view, and at once when it comes back into view (spec §3: "re-evaluate every minute"); a product whose slot ended leaves the menu and the cart, with a notice in the cart panel ("Pancake is not available at this time and was taken out of your order."), and an open product sheet for it closes. Nothing changes while an order is being sent.
- **The pad refuses to send a cart line outside its slot** with the server's words, before sending. An order already queued offline is still judged by the server's clock when it arrives and lands in the existing Rejected strip.
- **Replacing a photo**: upload the new file → point the product at it → delete the old file. If pointing seems to fail, the answer may only have been lost, so the product is read again: the new file is deleted only when the product certainly does not point at it (the old photo stays); when it does, the photo is saved and the section says "Photo saved, but the old file could not be identified for deletion"; when it cannot be read, nothing is deleted and the error shows — **an unused file is harmless, a product pointing at a deleted file is not**. If only the old file cannot be deleted, the section says "Photo saved, but the old file could not be deleted: …" (an unused file is harmless). `menu_products.image_path` gets a CHECK (`products/<uuid>/<8–64 letters or digits>.webp|.jpg`), because M1's `menu_products_edit` policy still lets an Edit menu holder update the row directly; `menu_set_product_image` also checks that the file is in the bucket.
- **The import's Photos step skips products that already have a photo by default** (Craft OS is the master of the menu: a photo uploaded here is not overwritten unless the owner unticks "Skip products that already have a photo"). Files match products by **exact** Feedme product ID (spaces at the ends ignored); the first file for a product wins. "Products still without a photo" lists products on sale (switched on, not add-on items). **Assumed — Feedme behaviour (owner asleep, 2026-10-24)** for "one photo per product".
- **The Feedme photo copy is the last, optional controller step** (Task 10) and waits for the owner's permission to download. If the portal does not expose each photo URL with its Feedme product ID, photos are uploaded by hand in the product editor (spec §5).

## Global Constraints

- **Dev database first.** The SQL here is applied on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) by the controller from the owner's Chrome tab on the dashboard SQL editor; prod (`yfsoesxzurzjdwstszru`) is a later step the owner decides. Both migrations run on prod **before** any main deploy that carries this code — the pad calls `pos_menu_windows` from Task 7 on. Seeds never run on prod; the verify script is dev-only.
- Every step that reads or writes the dev database, Storage or the Feedme portal is marked **(controller, … ; the implementer does not touch the database)**; implementers run only local commands (`grep`, `diff`, `npx tsc -b`, `npx vitest run`) and commit.
- All UI copy, field names and error messages in English (`english-product-copy` rule); code comments may be Chinese or English, matching the surrounding file.
- **Money is integer sen and unchanged.** Nothing in M3 prices anything; Sub-plan 3's money rules and the 22 vectors in `src/features/pos/checkout/billVectors.json` do not change. Orders still send ids only.
- **The server is the truth.** `pos_insert_order` refuses a product outside its slots with "<name> is not available at this time"; `qr_menu` leaves it out; the counter's grey-out and the pad's pre-send check only repeat the server's rule with the server's words.
- **Every new `security definer` function** pins `set search_path = public, pg_temp`, checks Edit menu through M2's `menu_require_editor()` → `has_menu_cap('manage_menu')` (live staff only: `is_active and status = 'active'`; the Owner's override in `system_role_permissions` wins), revokes execute from `public, anon` and grants `authenticated`; internal helpers (`menu_window_open`, `menu_product_open`, `menu_window_json`, `menu_hm`, `menu_days`) are revoked from `authenticated` too. `pos_menu_windows` needs live staff with a branch (`pos_my_branch`), not Edit menu. The storage policies call `public.has_menu_cap('manage_menu')`.
- **Nothing is hard-deleted** that an order refers to. The one allowed hard delete is **Delete schedule** (Feedme's behaviour; the schedule, its windows and its links — none of which an order refers to). Otherwise only windows (on save), product–schedule links (on untick) and a replaced photo's file are deleted.
- **pg-safeupdate:** Supabase's API role refuses a DELETE or UPDATE without WHERE even inside a function (the SQL editor does not, so the verify script cannot catch it). Every DELETE / UPDATE in the new files has a WHERE; `src/features/pos/sqlSafeUpdate.test.ts` scans every `migration-*-pos-*.sql` and Task 2 names the new function file and its write functions.
- **No unpaged reads that can pass 1,000 rows.** Every new read is an RPC returning one JSON value; the Storage calls touch one or two files at a time.
- **Migrations are idempotent** (`create table if not exists`, `add column if not exists`, a guarded constraint, `drop policy if exists` + `create policy`, `on conflict` for the bucket, `create or replace function`), and each ends with `notify pgrst, 'reload schema';` before its final `select`.
- **STOP guards:** the schema file stops without M1 + M2 or without a `storage` schema; the function file stops without the schema file, without M1/M2's functions, or when `has_menu_cap` does not know `manage_menu`.
- **Re-run hazards.** (1) Re-running `migration-2026-10-24-pos-catalogs-fn.sql` (M1) brings back its `pos_insert_order` and `qr_menu`: no time-slot refusal, no QR filter, no photos — re-run `migration-2026-10-24-pos-slots-photos-fn.sql` afterwards. Task 2 says so in M1's file header, and the verify's A section fails when either function lacks the slot check (or when an even older file left a second `pos_insert_order`). (2) Re-running `migration-2026-10-22-pos-menu.sql` or a checkout file brings back a `has_menu_cap` without `manage_menu` (the M2 hazard): every editor function and every `menu-images` upload is then refused; re-run `migration-2026-10-24-pos-checkout-fixes.sql`, `migration-2026-10-24-pos-catalogs.sql`, `migration-2026-10-24-pos-catalogs-fn.sql`, then both M3 files. (3) Re-running M2's file or the M3 schema file is harmless.
- **Craft OS is the master of the menu.** Re-importing the Feedme menu (`menu_import`) touches neither photos (`image_path` is not in its column list) nor schedules.
- **Staff fixtures in the verify script** are created after `request.jwt.claims` is set to the dev owner `76cbcf9f-905e-450d-9f5e-1c9e72a9373d`, inserted as `staff` and promoted by the owner (the staff authority guard).
- **UI lessons from M1/M2, applied to every new page and section:** each save shows its outcome next to the section that made it; every write button is disabled while it runs and a ref refuses a second click in the same render; a load that fails, or a reload after a save that fails, locks the writes and offers **Try again**; every load keyed by a selection drops a stale reply (a sequence ref, and the editors are keyed by their route id); every input has a visible label or an `aria-label`; no file this plan creates or rewrites passes ~250 lines.
- `tsconfig` has `noUnusedLocals` / `noUnusedParameters`: remove an import the moment it is no longer used.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Several sessions share the stash stack: never use a bare `git stash`. Another session may have touched `CategoriesPage.tsx`, `menuForms.ts`, `importView.ts` or M2's function file since `1b550cd`; this plan does not edit them, and every replacement below quotes its old text — if one does not match, read the file and apply the same change to what is there.

## File Structure

| File | Responsibility |
|---|---|
| `src/features/pos/menu/timeSlots.ts` (+test), `slotVectors.json` | The time maths (Malaysia clock, window open, labels, window problems) and its 19 shared vectors (Task 1) |
| `supabase/migration-2026-10-24-pos-slots-photos.sql` | Tables, image columns and constraint, RLS, the `menu-images` bucket and its policies (Task 2) |
| `supabase/migration-2026-10-24-pos-slots-photos-fn.sql` | Every M3 function; canonical `pos_insert_order` and `qr_menu` (Task 2) |
| `supabase/migration-2026-10-24-pos-catalogs-fn.sql` | Header comment only: re-run M3's function file after this one (Task 2) |
| `src/features/pos/sqlSafeUpdate.test.ts` | Names the new function file and its write functions in the pg-safeupdate scan (Task 2) |
| `supabase/migration-2026-10-24-pos-slots-photos-verify.sql`, `src/features/pos/menu/slotVectorsSql.test.ts` | Self-check, rolled back; the vectors in it equal `slotVectors.json` (Task 3) |
| `src/features/pos/menu/slotsApi.ts` | Types and RPC wrappers of every M3 editor call (Task 4) |
| `src/features/pos/menu/scheduleForm.ts` (+test) | Schedule form ↔ detail ↔ payload, every schedule rule (Task 4) |
| `src/features/pos/menu/SchedulesPage.tsx`, `ScheduleEditorPage.tsx`, `schedule/WindowsSection.tsx`, `schedule/ProductsSection.tsx` | The Schedules page and editor (Task 4) |
| `src/features/pos/menu/menuView.ts` (+test), `MenuRoutes.tsx` | The Schedules tab and routes (Task 4) |
| `src/features/pos/menu/product/TimeSlotsSection.tsx`, `ProductEditorPage.tsx` | The product editor's Time slots section (Task 5) |
| `src/features/pos/menu/photo.ts` (+test), `photoResize.ts`, `photoUpload.ts` (+test), `product/PhotoSection.tsx` | Photo rules; the canvas work; upload, replace, remove; the product editor's Photo section (Task 6) |
| `src/features/pos/order/padSlots.ts` (+test), `useMinuteClock.ts`, `usePadWindows.ts` (+test), `ProductTiles.tsx`, `posApi.ts`, `OrderPad.tsx` | The counter's grey-out, its per-minute re-read and the pre-send check (Task 7) |
| `src/features/pos/order/cart.ts` (+test), `src/qr/qrState.ts` (+test), `src/qr/QrApp.tsx` | QR photos and the minute refresh (Task 8) |
| `src/features/pos/menu/photoImport.ts` (+test), `PhotoImportSection.tsx`, `MenuImportPage.tsx` | The import's Photos step (Task 9) |

`menu_save_product`, `pos_menu_rows`, `place_counter_order`, `place_table_order`, `menu_import*`, `buildPosMenu`, `LineSheet`, POS settings, checkout and every earlier RLS policy do not change.

**Test counts** (checked while planning on a scratch copy of the worktree at `1b550cd`, by replaying this document task by task): baseline 90 files / 781 tests. After Task 1: 91 / 810. Task 2: 91 / 813. Task 3: 92 / 814. Task 4: 93 / 820. Task 5: 93 / 820. Task 6: 95 / 832. Task 7: 97 / 838. Task 8: 97 / 841. Task 9: 98 / 846. `npx tsc -b` prints nothing after every task.

---

### Task 1: The time maths — one pure module and its shared vectors

**Files:**
- Create: `src/features/pos/menu/slotVectors.json`, `src/features/pos/menu/timeSlots.test.ts`, `src/features/pos/menu/timeSlots.ts`

**Interfaces:**
- Produces (later tasks import these exact names): `SlotWindow { days: number[]; start: string; end: string }`, `ShopClock`, `DAY_NAMES`, `MAX_WINDOWS = 10`, `malaysiaClock(at)`, `parseHm(text)`, `windowOpen(w, clock)`, `availableAt(windows, at)`, `slotLabel(windows, at)` (null / "Available HH:MM–HH:MM" / "Not available now"), `notAvailableNow(name)` ("<name> is not available at this time"), `daysLabel(days)`, `windowLabel(w)`, `windowProblem(w)` (menu_save_schedule's words: "Pick at least one day for each time window", "Enter each time as HH:MM, e.g. 08:00", "A time window cannot start and end at the same time").
- The rule (mirrored by `menu_window_open` in Task 2): take the Malaysian day (ISO, Mon = 1) and minute (seconds dropped). If start < end the window is open on its days from start to end, both minutes included. If end < start it crosses midnight: open on its days from start to midnight, and on the day after one of its days from midnight to end.

- [ ] **Step 1: Write the shared vectors.** Create `src/features/pos/menu/slotVectors.json` (2026-10-24 is a Saturday; every `at` is UTC):

```json
[
  {"name": "inside a weekday window: Mon 09:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T01:00:00Z", "open": true},
  {"name": "the start minute counts: Mon 08:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T00:00:00Z", "open": true},
  {"name": "the end minute counts, to its last second: Mon 11:30:59", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T03:30:59Z", "open": true},
  {"name": "a minute after the end: Mon 11:31", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T03:31:00Z", "open": false},
  {"name": "a minute before the start: Mon 07:59 (still Sunday in UTC)", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-25T23:59:00Z", "open": false},
  {"name": "Malaysian day, not the UTC day: Mon 00:30 is Sunday 16:30 UTC", "days": [1], "start": "00:00", "end": "08:00", "at": "2026-10-25T16:30:00Z", "open": true},
  {"name": "a day that is not listed: Sat 09:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-24T01:00:00Z", "open": false},
  {"name": "crossing midnight, before midnight on the start day: Fri 23:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T15:00:00Z", "open": true},
  {"name": "crossing midnight, after midnight belongs to the start day: Sat 01:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T17:00:00Z", "open": true},
  {"name": "crossing midnight, the end minute counts: Sat 02:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T18:00:00Z", "open": true},
  {"name": "crossing midnight, a minute after the end: Sat 02:01", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T18:01:00Z", "open": false},
  {"name": "crossing midnight, early morning of the start day belongs to the day before: Fri 01:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-22T17:00:00Z", "open": false},
  {"name": "crossing midnight, evening of a day that is not listed: Sat 23:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-24T15:00:00Z", "open": false},
  {"name": "Sunday is day 7: Sun 12:00", "days": [7], "start": "10:00", "end": "23:59", "at": "2026-10-25T04:00:00Z", "open": true},
  {"name": "Sunday night into Monday: Mon 01:30", "days": [7], "start": "22:00", "end": "02:00", "at": "2026-10-25T17:30:00Z", "open": true},
  {"name": "Feedme's 10:00–23:59 runs to midnight: Sat 23:59:30", "days": [1, 2, 3, 4, 5, 6, 7], "start": "10:00", "end": "23:59", "at": "2026-10-24T15:59:30Z", "open": true},
  {"name": "Feedme's 10:00–23:59 is closed at midnight: Sun 00:00", "days": [1, 2, 3, 4, 5, 6, 7], "start": "10:00", "end": "23:59", "at": "2026-10-24T16:00:00Z", "open": false},
  {"name": "an end of 00:00 is the first minute of the next day: Tue 00:00", "days": [1], "start": "18:00", "end": "00:00", "at": "2026-10-26T16:00:00Z", "open": true},
  {"name": "an end of 00:00, a minute later: Tue 00:01", "days": [1], "start": "18:00", "end": "00:00", "at": "2026-10-26T16:01:00Z", "open": false}
]
```

- [ ] **Step 2: Write the failing test.** Create `src/features/pos/menu/timeSlots.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  availableAt, daysLabel, malaysiaClock, notAvailableNow, parseHm, slotLabel, windowLabel, windowOpen, windowProblem,
  type SlotWindow,
} from './timeSlots'
import vectors from './slotVectors.json'

interface Vector { name: string; days: number[]; start: string; end: string; at: string; open: boolean }
const all = vectors as Vector[]

describe('windowOpen — shared vectors (same instants as the SQL verify script)', () => {
  it('has the vectors the design asks for', () => {
    expect(all).toHaveLength(19)
    expect(all.filter((v) => v.end < v.start).length).toBeGreaterThanOrEqual(8)   // midnight crossings
  })
  for (const v of all) {
    it(v.name, () => {
      expect(windowOpen({ days: v.days, start: v.start, end: v.end }, malaysiaClock(new Date(v.at)))).toBe(v.open)
    })
  }
})

describe('malaysiaClock', () => {
  it('is UTC + 8 hours, Monday = 1 and Sunday = 7, seconds dropped', () => {
    expect(malaysiaClock(new Date('2026-10-25T16:30:59Z'))).toEqual({ isoDay: 1, minute: 30 })   // Mon 00:30
    expect(malaysiaClock(new Date('2026-10-25T04:00:00Z'))).toEqual({ isoDay: 7, minute: 720 })  // Sun 12:00
    expect(malaysiaClock(new Date('2026-10-24T15:59:00Z'))).toEqual({ isoDay: 6, minute: 1439 }) // Sat 23:59
  })
})

describe('parseHm', () => {
  it('reads HH:MM from 00:00 to 23:59 only', () => {
    expect(parseHm('00:00')).toBe(0)
    expect(parseHm('08:05')).toBe(485)
    expect(parseHm('23:59')).toBe(1439)
    for (const bad of ['24:00', '8:00', '08:60', '08:00:00', '', 'noon']) expect(parseHm(bad)).toBeNull()
  })
})

describe('availableAt and slotLabel', () => {
  const breakfast: SlotWindow = { days: [1, 2, 3, 4, 5], start: '08:00', end: '11:30' }
  const dinner: SlotWindow = { days: [1, 2, 3, 4, 5], start: '18:00', end: '21:00' }
  const mon = (hm: string) => new Date(`2026-10-26T${hm}:00+08:00`)
  it('no windows: always available', () => {
    expect(availableAt([], mon('03:00'))).toBe(true)
    expect(slotLabel([], mon('03:00'))).toBeNull()
  })
  it('any window open makes the product available', () => {
    expect(availableAt([breakfast, dinner], mon('09:00'))).toBe(true)
    expect(availableAt([breakfast, dinner], mon('19:00'))).toBe(true)
    expect(availableAt([breakfast, dinner], mon('14:00'))).toBe(false)
  })
  it('names the next window that opens later today', () => {
    expect(slotLabel([dinner, breakfast], mon('07:00'))).toBe('Available 08:00–11:30')
    expect(slotLabel([breakfast, dinner], mon('14:00'))).toBe('Available 18:00–21:00')
    expect(slotLabel([breakfast, dinner], mon('22:00'))).toBe('Not available now')
    expect(slotLabel([breakfast], new Date('2026-10-24T09:00:00+08:00'))).toBe('Not available now')   // Saturday
    expect(slotLabel([breakfast], mon('09:00'))).toBeNull()
  })
  it('uses the server words', () => {
    expect(notAvailableNow('Big Breakfast')).toBe('Big Breakfast is not available at this time')
  })
})

describe('labels and problems', () => {
  it('names days like Feedme', () => {
    expect(daysLabel([1, 2, 3, 4, 5, 6, 7])).toBe('Daily')
    expect(daysLabel([5, 1, 2, 3, 4])).toBe('Mon–Fri')
    expect(daysLabel([6, 7])).toBe('Sat, Sun')
    expect(daysLabel([1, 3, 4, 5])).toBe('Mon, Wed–Fri')
    expect(daysLabel([])).toBe('No days')
  })
  it('marks a window that crosses midnight', () => {
    expect(windowLabel({ days: [5, 6], start: '22:00', end: '02:00' })).toBe('Fri, Sat · 22:00–02:00 (next day)')
    expect(windowLabel({ days: [1, 2, 3, 4, 5, 6, 7], start: '10:00', end: '23:59' })).toBe('Daily · 10:00–23:59')
  })
  it('gives the server words for a bad window', () => {
    expect(windowProblem({ days: [], start: '08:00', end: '09:00' })).toBe('Pick at least one day for each time window')
    expect(windowProblem({ days: [1], start: '', end: '09:00' })).toBe('Enter each time as HH:MM, e.g. 08:00')
    expect(windowProblem({ days: [1], start: '09:00', end: '09:00' })).toBe('A time window cannot start and end at the same time')
    expect(windowProblem({ days: [1], start: '22:00', end: '02:00' })).toBeNull()
  })
})
```

- [ ] **Step 3: Run it to verify it fails.** Run: `npx vitest run src/features/pos/menu/timeSlots.test.ts` — Expected: FAIL, `Failed to load url ./timeSlots … Does the file exist?`.

- [ ] **Step 4: Implement.** Create `src/features/pos/menu/timeSlots.ts`:

```ts
// src/features/pos/menu/timeSlots.ts
/** Time slots (spec §3, M3): when a product may be sold. Pure, so every rule is tested —
 *  against the very vectors the server's menu_window_open is checked with
 *  (slotVectors.json; supabase/migration-2026-10-24-pos-slots-photos-verify.sql carries a copy).
 *  Malaysia keeps UTC+8 all year (no daylight saving), so the shop clock is UTC + 8 h. */

/** One window of a schedule: ISO days (1 = Mon … 7 = Sun) and "HH:MM" times. Both the start
 *  and the end minute are inside ("10:00–23:59" runs to midnight, Feedme's way). An end before
 *  the start crosses midnight; `days` are the days the window starts on. */
export interface SlotWindow { days: number[]; start: string; end: string }
/** The shop's day of the week (1 = Mon … 7 = Sun) and minute of the day (0–1439). */
export interface ShopClock { isoDay: number; minute: number }

const MALAYSIA_OFFSET_MS = 8 * 60 * 60 * 1000
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
export const MAX_WINDOWS = 10

/** The Malaysian day and minute at `at` (seconds dropped, as the server does). */
export function malaysiaClock(at: Date): ShopClock {
  const t = new Date(at.getTime() + MALAYSIA_OFFSET_MS)
  return { isoDay: ((t.getUTCDay() + 6) % 7) + 1, minute: t.getUTCHours() * 60 + t.getUTCMinutes() }
}

/** "08:00" → 480; null unless it is HH:MM from 00:00 to 23:59. */
export function parseHm(text: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

const prevDay = (d: number) => (d === 1 ? 7 : d - 1)

/** Whether one window is open at the shop clock (menu_window_open). */
export function windowOpen(w: SlotWindow, c: ShopClock): boolean {
  const s = parseHm(w.start)
  const e = parseHm(w.end)
  if (s === null || e === null || s === e) return false
  if (s < e) return w.days.includes(c.isoDay) && c.minute >= s && c.minute <= e
  return (w.days.includes(c.isoDay) && c.minute >= s) || (w.days.includes(prevDay(c.isoDay)) && c.minute <= e)
}

/** No windows = always available; otherwise available inside any one of them (menu_product_open). */
export function availableAt(windows: SlotWindow[], at: Date): boolean {
  if (windows.length === 0) return true
  const c = malaysiaClock(at)
  return windows.some((w) => windowOpen(w, c))
}

/** What the counter shows on a product outside its slots: the next window that opens later
 *  today ("Available 08:00–11:30"), else "Not available now". null while it is available. */
export function slotLabel(windows: SlotWindow[], at: Date): string | null {
  if (availableAt(windows, at)) return null
  const c = malaysiaClock(at)
  const next = windows
    .filter((w) => w.days.includes(c.isoDay) && (parseHm(w.start) ?? -1) > c.minute)
    .sort((a, b) => (parseHm(a.start) ?? 0) - (parseHm(b.start) ?? 0))[0]
  return next ? `Available ${next.start}–${next.end}` : 'Not available now'
}

/** pos_insert_order's words for a product outside its slots. */
export const notAvailableNow = (name: string) => `${name} is not available at this time`

/** "Daily", "Mon–Fri", "Sat, Sun", "Mon, Wed–Fri". */
export function daysLabel(days: number[]): string {
  const set = [...new Set(days)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort((a, b) => a - b)
  if (set.length === 7) return 'Daily'
  if (set.length === 0) return 'No days'
  const runs: [number, number][] = []
  for (const d of set) {
    const last = runs[runs.length - 1]
    if (last && d === last[1] + 1) last[1] = d
    else runs.push([d, d])
  }
  const name = (d: number) => DAY_NAMES[d - 1]
  return runs.map(([a, b]) => (a === b ? name(a) : b === a + 1 ? `${name(a)}, ${name(b)}` : `${name(a)}–${name(b)}`)).join(', ')
}

/** "Mon–Fri · 08:00–11:30", "Fri, Sat · 22:00–02:00 (next day)". */
export function windowLabel(w: SlotWindow): string {
  const s = parseHm(w.start)
  const e = parseHm(w.end)
  return `${daysLabel(w.days)} · ${w.start}–${w.end}${s !== null && e !== null && e < s ? ' (next day)' : ''}`
}

/** menu_save_schedule's words for one window, or null. */
export function windowProblem(w: SlotWindow): string | null {
  if (w.days.length === 0) return 'Pick at least one day for each time window'
  if (parseHm(w.start) === null || parseHm(w.end) === null) return 'Enter each time as HH:MM, e.g. 08:00'
  if (w.start === w.end) return 'A time window cannot start and end at the same time'
  return null
}
```

- [ ] **Step 5: Run the gates.** Run: `npx vitest run src/features/pos/menu/timeSlots.test.ts` — Expected: PASS, 29 tests. Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 91 files, 810 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/menu/slotVectors.json src/features/pos/menu/timeSlots.ts src/features/pos/menu/timeSlots.test.ts
git commit -m "feat(pos-menu): time-slot maths — Malaysia clock, windows across midnight, labels; 19 shared vectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema, storage and functions (SQL) and the pg-safeupdate scan

**Files:**
- Create: `supabase/migration-2026-10-24-pos-slots-photos.sql`, `supabase/migration-2026-10-24-pos-slots-photos-fn.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts`, `supabase/migration-2026-10-24-pos-catalogs-fn.sql` (header comment only)

**Interfaces:**
- Consumes: M1's `has_menu_cap` / `pos_my_branch` / `pos_order_catalog`, `catalog_products`, `branch_catalogs`; M2's `menu_require_editor`, `menu_clean_name`, `menu_uuid`; Supabase's `storage.buckets`, `storage.objects`, `storage.foldername`.
- Produces (later tasks call these exact names and shapes; JSON keys camelCase):
  - `menu_schedule_list() → [{ id, name, sortOrder, windows: [{ days, start: 'HH:MM', end: 'HH:MM' }], productCount }]`
  - `menu_schedule_detail(p_schedule_id uuid) → { id, name, windows, productIds }`
  - `menu_save_schedule(p jsonb) → uuid` — `p = { id|null, name, windows: [{ days, start, end }], productIds? }` (`productIds` left out = links kept for an existing schedule; windows always replace)
  - `menu_reorder_schedules(p_ids uuid[])`, `menu_delete_schedule(p_id uuid)` (the schedule, its windows and its links)
  - `menu_product_extras(p_product_id uuid) → { imagePath, imageUpdatedAt, scheduleIds }`, `menu_set_product_schedules(p_product_id uuid, p_schedule_ids uuid[])` (the whole set)
  - `menu_set_product_image(p_product_id uuid, p_path text) → text` (the path it replaced, or null; `p_path` null = no photo), `menu_photo_targets() → [{ id, name, feedmeProductId, imagePath, isActive, isAddon }]`
  - `pos_menu_windows(p_catalog_id uuid) → { now: ISO string, windows: [{ productId, days, start, end }] }`
  - `qr_menu(p_token)` products gain `imagePath`; products outside their slots are left out. `pos_insert_order` refuses `<name> is not available at this time`.
  - Refusal words (shown as they are): `Not allowed to edit the menu`; `Invalid schedule`; `Schedule name is required`; `Schedule name is too long (at most 60 characters)`; `A schedule called <name> already exists`; `Schedule not found — refresh and try again`; `Schedule not found` (detail read); `A schedule needs at least one time window`; `Too many time windows (at most 10)`; `Pick at least one day for each time window`; `Enter each time as HH:MM, e.g. 08:00`; `A time window cannot start and end at the same time`; `<product> follows too many schedules (at most 20)`; `Product not found — refresh and try again`; `Product not found` (extras read); `The schedule list changed — refresh and try again`; `Too many schedules (at most 20)`; `Invalid photo path`; `Photo not found — upload it again`; `<name> is not available at this time`.

- [ ] **Step 1: Make the pg-safeupdate scan name the new file.** In `src/features/pos/sqlSafeUpdate.test.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```ts
      'migration-2026-10-24-pos-menu-editor-fn.sql',
    ]))
```

   with

```ts
      'migration-2026-10-24-pos-menu-editor-fn.sql',
      'migration-2026-10-24-pos-slots-photos-fn.sql',
    ]))
```

2. Replace

```ts
      'menu_set_category_active',
    ]))
  })
```

   with

```ts
      'menu_set_category_active',
    ]))
  })

  it('scans every write function of time slots and photos (M3)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-slots-photos-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'menu_save_schedule', 'menu_reorder_schedules', 'menu_delete_schedule', 'menu_set_product_schedules',
      'menu_set_product_image', 'pos_insert_order', 'qr_menu',
    ]))
  })
```


- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` — Expected: FAIL, 2 failed (`reads the POS function migrations` misses the new file; the new test cannot read it: `ENOENT`).

- [ ] **Step 3: Say in M1's header that M3 must be re-run after it** (comment only; the function bodies Step 6 compares do not move). In `supabase/migration-2026-10-24-pos-catalogs-fn.sql` make exactly these replacements (each old text occurs once):

1. Replace

```sql
-- pos_insert_order / place_counter_order as a second, old-signature function next
-- to the new one) — re-run this file afterwards.
```

   with

```sql
-- pos_insert_order / place_counter_order as a second, old-signature function next
-- to the new one) — re-run this file afterwards.
-- M3 re-creates pos_insert_order and qr_menu once more: after re-running THIS file,
-- re-run migration-2026-10-24-pos-slots-photos-fn.sql too (time slots, QR photos).
```


- [ ] **Step 4: Write the schema migration.** Create `supabase/migration-2026-10-24-pos-slots-photos.sql`:

```sql
-- ============================================================================
-- Craft OS — POS menu catalogs · M3 schema: time slots and product photos (2026-10-24).
-- Run on craft-os-dev after migration-2026-10-24-pos-menu-editor-fn.sql (M2).
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m3.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §2, §3, §5
--
-- Time slots follow Feedme's Scheduler (assumed — Feedme behaviour, owner asleep,
-- 2026-10-24): named, reusable schedules, each with one or more windows, linked to
-- products. A product that follows no schedule is always available; one that follows
-- schedules is available inside ANY window of them. Like Feedme, a schedule has no
-- on/off switch: it is deleted, with its windows and links (no order refers to them).
-- The three new tables have no write policy: they are written only through the
-- Edit menu functions in migration-2026-10-24-pos-slots-photos-fn.sql.
-- ============================================================================

do $$ begin
  if to_regclass('public.menu_catalogs') is null or to_regprocedure('menu_require_editor()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs.sql, -catalogs-fn.sql and -menu-editor-fn.sql first';
  end if;
  if to_regclass('storage.buckets') is null then
    raise exception 'STOP: no storage schema — run this on the Supabase project, not a bare Postgres';
  end if;
end $$;

-- ── Schedules (Feedme: Menu → Scheduler) ────────────────────────────────────
-- Deleted outright by menu_delete_schedule (Feedme's Delete), the one hard delete of M3.
create table if not exists menu_schedules (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) between 1 and 60),
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

-- One window: ISO days (1 = Mon … 7 = Sun) and whole-minute times, Malaysia time.
-- The end minute is included (Feedme's "10:00 am – 11:59 pm" runs to midnight).
-- end_time < start_time crosses midnight; days are the days the window starts on.
-- Configuration only (no order refers to it): a save replaces a schedule's windows.
create table if not exists menu_schedule_windows (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null references menu_schedules(id),          -- no cascade: menu_delete_schedule removes them itself
  days         smallint[] not null check (cardinality(days) between 1 and 7 and days <@ array[1,2,3,4,5,6,7]::smallint[]),
  start_time   time not null check (extract(second from start_time) = 0),
  end_time     time not null check (extract(second from end_time) = 0),
  sort_order   integer not null default 0,
  check (start_time <> end_time)
);
create index if not exists menu_schedule_windows_schedule_idx on menu_schedule_windows(schedule_id);

-- Which schedules a product follows (configuration: a removed link is deleted).
create table if not exists product_schedules (
  product_id   uuid not null references menu_products(id) on delete cascade,
  schedule_id  uuid not null references menu_schedules(id),          -- no cascade, as above
  primary key (product_id, schedule_id)
);
create index if not exists product_schedules_schedule_idx on product_schedules(schedule_id);

-- ── Product photo: a path in the menu-images bucket ─────────────────────────
alter table menu_products add column if not exists image_path text;
alter table menu_products add column if not exists image_updated_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_products_image_path_check') then
    alter table menu_products add constraint menu_products_image_path_check
      check (image_path is null or image_path ~ '^products/[0-9a-f-]{36}/[A-Za-z0-9_-]{8,64}\.(webp|jpg)$');
  end if;
end $$;

-- ── RLS: signed-in staff read; nobody writes directly ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['menu_schedules','menu_schedule_windows','product_schedules']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists menu_read on %I', t);
    execute format('create policy menu_read on %I for select to authenticated using (true)', t);
  end loop;
end $$;

-- ── Storage: bucket menu-images, public read, Edit menu writes ──────────────
-- Same pattern as company-assets / staff-avatars (supabase/schema.sql). Files are
-- products/<product_id>/<random>.webp (or .jpg where the browser cannot make WebP),
-- already resized to 800 px wide in the browser: 2 MB is a generous ceiling.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 2097152, array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "menu_images_read" on storage.objects;
-- Signed-in staff only (the editors' upload and remove need it). Customers fetch photos
-- through the public URL (/object/public/…), which needs no policy, and cannot list the bucket.
create policy "menu_images_read" on storage.objects for select to authenticated
  using (bucket_id = 'menu-images');

drop policy if exists "menu_images_insert" on storage.objects;
create policy "menu_images_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'menu-images' and (storage.foldername(name))[1] = 'products'
              and public.has_menu_cap('manage_menu'));

drop policy if exists "menu_images_update" on storage.objects;
create policy "menu_images_update" on storage.objects for update to authenticated
  using (bucket_id = 'menu-images' and public.has_menu_cap('manage_menu'))
  with check (bucket_id = 'menu-images' and (storage.foldername(name))[1] = 'products'
              and public.has_menu_cap('manage_menu'));

drop policy if exists "menu_images_delete" on storage.objects;
create policy "menu_images_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'menu-images' and public.has_menu_cap('manage_menu'));

-- PostgREST picks up the new tables and columns now, not at its next poll
notify pgrst, 'reload schema';

select 'time slots and photos schema applied' as result;
```

- [ ] **Step 5: Write the functions migration.** It holds every M3 function in full; `pos_insert_order` and `qr_menu` are the live text of `migration-2026-10-24-pos-catalogs-fn.sql` with only the lines marked `M3` added. Create `supabase/migration-2026-10-24-pos-slots-photos-fn.sql`:

```sql
-- ============================================================================
-- Craft OS — POS menu catalogs · M3 functions: time slots and product photos (2026-10-24).
-- Run on craft-os-dev after migration-2026-10-24-pos-slots-photos.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m3.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §2, §3, §5
--
-- New functions: the time maths (menu_window_open, menu_product_open — mirrored by
-- src/features/pos/menu/timeSlots.ts, checked against the same vectors), the
-- Schedules page and the product editor's Time slots and Photo sections (Edit menu
-- only), the import's photo targets, and the counter's pos_menu_windows.
--
-- Canonical from here on: pos_insert_order and qr_menu. Each is the live text of
-- migration-2026-10-24-pos-catalogs-fn.sql with only the lines marked "M3" added
-- (pos_insert_order refuses a product outside its time slots; qr_menu hides it and
-- returns the product photo). Re-running migration-2026-10-24-pos-catalogs-fn.sql
-- (or an older file defining them) brings the old bodies back — re-run this file
-- afterwards. No M1 or M2 function other than these two is re-created.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regclass('public.menu_schedule_windows') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-slots-photos.sql first (menu_schedule_windows is missing)';
  end if;
  if to_regprocedure('pos_order_catalog(uuid,text,text,uuid)') is null
     or to_regprocedure('menu_require_editor()') is null
     or to_regprocedure('menu_clean_name(text,text,integer)') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs-fn.sql and migration-2026-10-24-pos-menu-editor-fn.sql first';
  end if;
  if pg_get_functiondef('has_menu_cap(text)'::regprocedure) not like '%manage_menu%' then
    raise exception 'STOP: has_menu_cap does not know manage_menu — re-run migration-2026-10-24-pos-catalogs.sql first';
  end if;
end $$;

-- ── Time maths. Malaysia keeps UTC+8 all year. Mirrored by windowOpen() /
--    availableAt() in src/features/pos/menu/timeSlots.ts; the verify script runs
--    the shared vectors (src/features/pos/menu/slotVectors.json) through it ─────
-- One window at one instant: the Malaysian day and minute (seconds dropped) inside
-- start..end, both minutes included. end < start crosses midnight: the window runs
-- from start on one of `days` to end on the next day.
create or replace function menu_window_open(p_days smallint[], p_start time, p_end time, p_at timestamptz)
returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select case
           when p_start < p_end then c.d = any (p_days) and c.t between p_start and p_end
           else (c.d = any (p_days) and c.t >= p_start)
             or ((case when c.d = 1 then 7 else c.d - 1 end)::smallint = any (p_days) and c.t <= p_end)
         end
    from (select extract(isodow from l)::smallint as d, date_trunc('minute', l)::time as t
            from (select p_at at time zone 'Asia/Kuala_Lumpur' as l) x) c
$$;
revoke all on function menu_window_open(smallint[], time, time, timestamptz) from public, anon, authenticated;

-- A product may be sold at p_at when it follows no schedule, or when one window of
-- one of its schedules is open (spec §3, Feedme's Scheduler).
create or replace function menu_product_open(p_product_id uuid, p_at timestamptz) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select not exists (select 1 from product_schedules ps where ps.product_id = p_product_id)
      or exists (select 1 from product_schedules ps
                   join menu_schedule_windows w on w.schedule_id = ps.schedule_id
                  where ps.product_id = p_product_id
                    and menu_window_open(w.days, w.start_time, w.end_time, p_at))
$$;
revoke all on function menu_product_open(uuid, timestamptz) from public, anon, authenticated;

-- A window as every client reads it: { days: [1..7], start: 'HH:MM', end: 'HH:MM' }.
create or replace function menu_window_json(w menu_schedule_windows) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('days', to_jsonb(w.days), 'start', to_char(w.start_time, 'HH24:MI'),
                            'end', to_char(w.end_time, 'HH24:MI'))
$$;
revoke all on function menu_window_json(menu_schedule_windows) from public, anon, authenticated;

-- 'HH:MM' from 00:00 to 23:59 as a time, else null.
create or replace function menu_hm(p_value jsonb) returns time
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string'
     or (p_value #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return null;
  end if;
  return (p_value #>> '{}')::time;
end $$;
revoke all on function menu_hm(jsonb) from public, anon, authenticated;

-- A JSON array of ISO days (whole numbers 1..7) as a sorted array without repeats
-- (empty when the array is); null when it is not such an array.
create or replace function menu_days(p_value jsonb) returns smallint[]
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v smallint[];
begin
  if jsonb_typeof(p_value) is distinct from 'array' then return null; end if;
  if exists (select 1 from jsonb_array_elements(p_value) e
              where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[1-7]$') then
    return null;
  end if;
  select coalesce(array_agg(distinct (e #>> '{}')::smallint order by (e #>> '{}')::smallint), '{}')
    into v from jsonb_array_elements(p_value) e;
  return v;
end $$;
revoke all on function menu_days(jsonb) from public, anon, authenticated;

-- ── Reads for the Schedules page and the product editor (Edit menu; one JSON value each) ──
-- Every schedule with its windows and how many products follow it.
create or replace function menu_schedule_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'name', s.name, 'sortOrder', s.sort_order,
             'windows', coalesce((select jsonb_agg(menu_window_json(w) order by w.sort_order)
                                    from menu_schedule_windows w where w.schedule_id = s.id), '[]'::jsonb),
             -- products on sale (add-on items are not on the counter or QR)
             'productCount', (select count(*) from product_schedules ps
                                join menu_products p on p.id = ps.product_id and p.is_active and not p.is_addon
                               where ps.schedule_id = s.id))
           order by s.sort_order, s.name)
      from menu_schedules s), '[]'::jsonb);
end $$;
revoke all on function menu_schedule_list() from public, anon;
grant execute on function menu_schedule_list() to authenticated;

-- The schedule editor: the schedule, its windows in order and every product linked to it.
create or replace function menu_schedule_detail(p_schedule_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform menu_require_editor();
  select jsonb_build_object(
           'id', s.id, 'name', s.name,
           'windows', coalesce((select jsonb_agg(menu_window_json(w) order by w.sort_order)
                                  from menu_schedule_windows w where w.schedule_id = s.id), '[]'::jsonb),
           'productIds', coalesce((select jsonb_agg(ps.product_id order by ps.product_id)
                                     from product_schedules ps where ps.schedule_id = s.id), '[]'::jsonb))
    into v
    from menu_schedules s
   where s.id = p_schedule_id;
  if v is null then
    raise exception 'Schedule not found';
  end if;
  return v;
end $$;
revoke all on function menu_schedule_detail(uuid) from public, anon;
grant execute on function menu_schedule_detail(uuid) to authenticated;

-- The product editor's Photo and Time slots sections.
create or replace function menu_product_extras(p_product_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform menu_require_editor();
  select jsonb_build_object(
           'imagePath', p.image_path, 'imageUpdatedAt', p.image_updated_at,
           'scheduleIds', coalesce((select jsonb_agg(ps.schedule_id order by s.sort_order, s.name)
                                      from product_schedules ps join menu_schedules s on s.id = ps.schedule_id
                                     where ps.product_id = p.id), '[]'::jsonb))
    into v
    from menu_products p
   where p.id = p_product_id;
  if v is null then
    raise exception 'Product not found';
  end if;
  return v;
end $$;
revoke all on function menu_product_extras(uuid) from public, anon;
grant execute on function menu_product_extras(uuid) to authenticated;

-- The import's Photos step: every product with its Feedme id and whether it has a photo.
create or replace function menu_photo_targets() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'feedmeProductId', p.feedme_product_id, 'imagePath', p.image_path,
             'isActive', p.is_active, 'isAddon', p.is_addon)
           order by p.sort_order, p.name)
      from menu_products p), '[]'::jsonb);
end $$;
revoke all on function menu_photo_targets() from public, anon;
grant execute on function menu_photo_targets() to authenticated;

-- ── Schedules: save, reorder, delete ───────────────────────────────────────
-- p = { id: uuid|null (null = new), name,
--       windows: [{ days: [1..7], start: 'HH:MM', end: 'HH:MM' }]   (array order = order on screen; replaces them all)
--       productIds: [uuid] (optional; left out = links kept, else the whole set of products that follow it) }
-- Returns the schedule id.
create or replace function menu_save_schedule(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id     uuid;
  v_new    boolean;
  v_name   text;
  v_text   text;
  v_el     record;
  v_days   smallint[];
  v_start  time;
  v_end    time;
  v_ids    uuid[];
begin
  perform menu_require_editor();
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(p->'windows') is distinct from 'array'
     or (p ? 'productIds' and jsonb_typeof(p->'productIds') is distinct from 'array') then
    raise exception 'Invalid schedule';
  end if;
  v_new := coalesce(jsonb_typeof(p->'id'), 'null') = 'null';
  if not v_new then
    v_id := menu_uuid(p->'id');
    if v_id is null or not exists (select 1 from menu_schedules where id = v_id) then
      raise exception 'Schedule not found — refresh and try again';
    end if;
  end if;
  v_name := menu_clean_name(p->>'name', 'Schedule', 60);
  if exists (select 1 from menu_schedules where lower(name) = lower(v_name) and id is distinct from v_id) then
    raise exception 'A schedule called % already exists', v_name;
  end if;

  -- ── windows: all checked before anything is written ──
  if jsonb_array_length(p->'windows') = 0 then raise exception 'A schedule needs at least one time window'; end if;
  if jsonb_array_length(p->'windows') > 10 then raise exception 'Too many time windows (at most 10)'; end if;
  for v_el in select e.v from jsonb_array_elements(p->'windows') as e(v) loop
    if jsonb_typeof(v_el.v) <> 'object' then raise exception 'Invalid schedule'; end if;
    v_days := menu_days(v_el.v->'days');
    if v_days is null then raise exception 'Invalid schedule'; end if;
    if cardinality(v_days) = 0 then raise exception 'Pick at least one day for each time window'; end if;
    v_start := menu_hm(v_el.v->'start');
    v_end := menu_hm(v_el.v->'end');
    if v_start is null or v_end is null then raise exception 'Enter each time as HH:MM, e.g. 08:00'; end if;
    if v_start = v_end then raise exception 'A time window cannot start and end at the same time'; end if;
  end loop;

  -- ── products that follow it ──
  if p ? 'productIds' then
    if exists (select 1 from jsonb_array_elements(p->'productIds') g where menu_uuid(g) is null) then
      raise exception 'Invalid schedule';
    end if;
    select coalesce(array_agg(distinct menu_uuid(g)), '{}') into v_ids from jsonb_array_elements(p->'productIds') g;
    if exists (select 1 from unnest(v_ids) u where not exists (select 1 from menu_products mp where mp.id = u)) then
      raise exception 'Product not found — refresh and try again';
    end if;
    -- the product editor's limit, kept from this side too
    select mp.name into v_text
      from unnest(v_ids) u join menu_products mp on mp.id = u
     where (select count(*) from product_schedules ps where ps.product_id = u and ps.schedule_id is distinct from v_id) >= 20
     order by mp.name limit 1;
    if v_text is not null then raise exception '% follows too many schedules (at most 20)', v_text; end if;
  end if;

  -- ── write ──
  begin
    if v_new then
      insert into menu_schedules(name, sort_order)
      values (v_name, coalesce((select max(sort_order) + 1 from menu_schedules), 0))
      returning id into v_id;
    else
      update menu_schedules set name = v_name where id = v_id;
    end if;
  exception when unique_violation then
    raise exception 'A schedule called % already exists', v_name;    -- another save took the name meanwhile
  end;
  delete from menu_schedule_windows where schedule_id = v_id;
  insert into menu_schedule_windows(schedule_id, days, start_time, end_time, sort_order)
  select v_id, menu_days(e.v->'days'), menu_hm(e.v->'start'), menu_hm(e.v->'end'), e.ord - 1
    from jsonb_array_elements(p->'windows') with ordinality as e(v, ord);
  if p ? 'productIds' then
    delete from product_schedules where schedule_id = v_id and not (product_id = any (v_ids));
    insert into product_schedules(product_id, schedule_id)
    select u, v_id from unnest(v_ids) u
    on conflict (product_id, schedule_id) do nothing;
  end if;
  return v_id;
end $$;
revoke all on function menu_save_schedule(jsonb) from public, anon;
grant execute on function menu_save_schedule(jsonb) to authenticated;

create or replace function menu_reorder_schedules(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_ids is null
     or cardinality(p_ids) <> (select count(distinct u) from unnest(p_ids) u)
     or cardinality(p_ids) <> (select count(*) from menu_schedules)
     or exists (select 1 from unnest(p_ids) u where not exists (select 1 from menu_schedules s where s.id = u)) then
    raise exception 'The schedule list changed — refresh and try again';
  end if;
  update menu_schedules s set sort_order = x.ord - 1
    from unnest(p_ids) with ordinality as x(id, ord)
   where s.id = x.id;
end $$;
revoke all on function menu_reorder_schedules(uuid[]) from public, anon;
grant execute on function menu_reorder_schedules(uuid[]) to authenticated;

-- Feedme's Delete (a scheduler has no on/off switch): the schedule, its windows and its
-- product links go. No order refers to them; its products then sell at any time unless
-- another schedule they follow says otherwise. The one hard delete of M3.
create or replace function menu_delete_schedule(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_id is null or not exists (select 1 from menu_schedules where id = p_id) then
    raise exception 'Schedule not found — refresh and try again';
  end if;
  delete from product_schedules where schedule_id = p_id;
  delete from menu_schedule_windows where schedule_id = p_id;
  delete from menu_schedules where id = p_id;
end $$;
revoke all on function menu_delete_schedule(uuid) from public, anon;
grant execute on function menu_delete_schedule(uuid) to authenticated;

-- ── The product editor: which schedules a product follows, and its photo ────
-- p_schedule_ids is the whole set (empty = always available).
create or replace function menu_set_product_schedules(p_product_id uuid, p_schedule_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids uuid[];
begin
  perform menu_require_editor();
  if p_schedule_ids is null then raise exception 'Invalid schedule'; end if;
  if not exists (select 1 from menu_products where id = p_product_id) then
    raise exception 'Product not found — refresh and try again';
  end if;
  select coalesce(array_agg(distinct u), '{}') into v_ids from unnest(p_schedule_ids) u;
  if cardinality(v_ids) > 20 then raise exception 'Too many schedules (at most 20)'; end if;
  if exists (select 1 from unnest(v_ids) u where u is null or not exists (select 1 from menu_schedules s where s.id = u)) then
    raise exception 'Schedule not found — refresh and try again';
  end if;
  delete from product_schedules where product_id = p_product_id and not (schedule_id = any (v_ids));
  insert into product_schedules(product_id, schedule_id)
  select p_product_id, u from unnest(v_ids) u
  on conflict (product_id, schedule_id) do nothing;
end $$;
revoke all on function menu_set_product_schedules(uuid, uuid[]) from public, anon;
grant execute on function menu_set_product_schedules(uuid, uuid[]) to authenticated;

-- p_path: a file the editor has just uploaded to menu-images, products/<this product>/<random>.webp|.jpg;
-- null = no photo. Returns the path it replaced (the editor then deletes that file), or null.
create or replace function menu_set_product_image(p_product_id uuid, p_path text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old text;
begin
  perform menu_require_editor();
  select image_path into v_old from menu_products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found — refresh and try again';
  end if;
  if p_path is not null then
    if p_path !~ ('^products/' || p_product_id::text || '/[A-Za-z0-9_-]{8,64}\.(webp|jpg)$') then
      raise exception 'Invalid photo path';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'menu-images' and o.name = p_path) then
      raise exception 'Photo not found — upload it again';
    end if;
  end if;
  update menu_products
     set image_path = p_path, image_updated_at = case when p_path is null then null else now() end, updated_at = now()
   where id = p_product_id;
  return case when v_old is distinct from p_path then v_old end;
end $$;
revoke all on function menu_set_product_image(uuid, text) from public, anon;
grant execute on function menu_set_product_image(uuid, text) to authenticated;

-- ── The counter: time slots of one catalog's products, with the server's clock ──
-- Each window of each schedule followed by a product the catalog sells (switched on,
-- not an add-on item, as pos_menu_rows lists them). The pad re-reads it every minute and
-- greys a product out by the server's time (the iPad's own clock only counts the
-- seconds since this read). Live staff with a branch only.
create or replace function pos_menu_windows(p_catalog_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform pos_my_branch();
  return jsonb_build_object(
    'now', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'windows', coalesce((
      select jsonb_agg(menu_window_json(w) || jsonb_build_object('productId', cp.product_id)
                       order by cp.product_id, s.sort_order, s.name, w.sort_order)
        from catalog_products cp
        join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
        join product_schedules ps on ps.product_id = cp.product_id
        join menu_schedules s on s.id = ps.schedule_id
        join menu_schedule_windows w on w.schedule_id = s.id
       where cp.catalog_id = p_catalog_id and cp.availability <> 'hidden'), '[]'::jsonb));
end $$;
revoke all on function pos_menu_windows(uuid) from public, anon;
grant execute on function pos_menu_windows(uuid) to authenticated;

-- ── pos_insert_order, re-created: a product outside its time slots is refused
--    (offline orders too: they are judged by the server's clock when they arrive) ──
create or replace function pos_insert_order(
  p_branch_id uuid, p_table_id uuid, p_order_type text, p_pax integer,
  p_source text, p_placed_by uuid, p_items jsonb, p_client_order_id uuid,
  p_catalog_id uuid                     -- M1: the catalog asked for; null = the branch's default for this order
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing   uuid;
  v_bill_id    uuid;
  v_bill_no    text;
  v_order_id   uuid;
  v_order_no   text;
  v_label      text;
  v_item       jsonb;
  v_opt_id     uuid;
  v_opt_ids    uuid[];
  v_prod       menu_products;
  v_var        menu_variants;
  v_opt_row    record;
  v_grp        record;
  v_qty        numeric;
  v_n          integer;
  v_price      integer;
  v_mods       jsonb;
  v_allowed    text[] := case when p_source = 'qr' then array['all'] else array['all', 'counter_only'] end;
  v_catalog    uuid;                    -- M1
  v_avail      text;                    -- M1
  v_unit       integer;                 -- M1
begin
  if p_client_order_id is null then
    raise exception 'Order id is missing';
  end if;
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;                         -- resend: already in
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order has no items';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Too many items in one order';
  end if;
  if p_order_type is null or p_order_type not in ('dine_in', 'takeaway') then
    raise exception 'Invalid order type';
  end if;
  if (p_order_type = 'dine_in') <> (p_table_id is not null) then
    raise exception 'Dine-in orders need a table; takeaway orders have none';
  end if;
  if p_pax is not null and (p_pax < 1 or p_pax > 99) then
    raise exception 'Invalid number of guests';
  end if;
  -- M1: the catalog this order is priced from; refuses one the branch does not offer for it
  v_catalog := pos_order_catalog(p_branch_id, p_order_type, p_source, p_catalog_id);

  -- ── validate every line before writing anything (bad input is always P0001 = final) ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item->'productId') is distinct from 'string'
       or jsonb_typeof(v_item->'variantId') is distinct from 'string'
       or (v_item->>'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_item->>'variantId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid item';
    end if;
    -- M1: the product must be in the catalog with an availability this source may order
    --     (menu_products.availability is no longer read)
    v_avail := null;
    select * into v_prod from menu_products
     where id = (v_item->>'productId')::uuid and is_active and not is_addon;
    if found then
      select cp.availability into v_avail from catalog_products cp
       where cp.catalog_id = v_catalog and cp.product_id = v_prod.id;
    end if;
    if v_avail is null or not (v_avail = any (v_allowed)) then
      raise exception 'Item is not available: %', coalesce(v_prod.name, v_item->>'productId');
    end if;
    -- M3: inside one of its time slots now (Asia/Kuala_Lumpur, the server's clock), or it has none
    if not menu_product_open(v_prod.id, now()) then
      raise exception '% is not available at this time', v_prod.name;
    end if;
    if exists (select 1 from branch_menu_status s
                where s.branch_id = p_branch_id and s.product_id = v_prod.id and s.is_sold_out) then
      raise exception 'Sold out: %', v_prod.name;
    end if;
    select * into v_var from menu_variants
     where id = (v_item->>'variantId')::uuid and product_id = v_prod.id and is_active;
    -- M1: ...and the catalog must have a price for this variant
    if not found or not exists (select 1 from catalog_variant_prices cvp
                                 where cvp.catalog_id = v_catalog and cvp.variant_id = v_var.id) then
      raise exception 'Item is not available: %', v_prod.name;
    end if;
    if v_item->'qty' is not null then
      if jsonb_typeof(v_item->'qty') <> 'number' then raise exception 'Invalid quantity'; end if;
      v_qty := (v_item->'qty')::numeric;
      if v_qty < 1 or v_qty > 20 or v_qty <> trunc(v_qty) then raise exception 'Invalid quantity'; end if;
    end if;
    if v_item->'optionIds' is not null and jsonb_typeof(v_item->'optionIds') <> 'array' then
      raise exception 'Invalid add-ons';
    end if;
    -- each option must be a well-formed uuid string, appear once (compared as uuids, so
    -- letter case cannot sneak a duplicate past), belong to a group linked to this
    -- product, and be orderable here
    if exists (select 1 from jsonb_array_elements(coalesce(v_item->'optionIds', '[]'::jsonb)) e
                where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'Invalid add-ons';
    end if;
    select coalesce(array_agg(x.v::uuid), '{}') into v_opt_ids
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v);
    if cardinality(v_opt_ids) <> (select count(distinct u) from unnest(v_opt_ids) u) then
      raise exception 'Invalid add-ons';
    end if;
    foreach v_opt_id in array v_opt_ids loop
      select o.id, o.name, o.availability, o.product_id, g.name as group_name into v_opt_row
        from modifier_options o
        join modifier_groups g on g.id = o.group_id and g.is_active
        join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
       where o.id = v_opt_id;
      if not found then
        raise exception 'Add-on is not available for %', v_prod.name;
      end if;
      if not (v_opt_row.availability = any (v_allowed))
         or exists (select 1 from branch_menu_status s
                     where s.branch_id = p_branch_id and s.product_id = v_opt_row.product_id and s.is_sold_out) then
        raise exception 'Sold out: %', v_opt_row.name;
      end if;
    end loop;
    -- per linked group: min..max
    for v_grp in
      select g.name, g.min_select, g.max_select,
             (select count(*) from modifier_options o
               where o.group_id = g.id
                 and o.id = any (v_opt_ids)) as chosen
        from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id and g.is_active
       where pmg.product_id = v_prod.id
    loop
      if v_grp.chosen < v_grp.min_select then
        raise exception 'Choose at least % for %: %', v_grp.min_select, v_prod.name, v_grp.name;
      end if;
      if v_grp.chosen > v_grp.max_select then
        raise exception 'Choose at most % for %: %', v_grp.max_select, v_prod.name, v_grp.name;
      end if;
    end loop;
  end loop;

  -- ── bill + order share one savepoint: a concurrent resend that wins the
  --    client_order_id race rolls both back, so no orphan bill is left ──
  begin
    if p_table_id is not null then
      select label into v_label from dining_tables
       where id = p_table_id and branch_id = p_branch_id and is_active;
      if not found then raise exception 'Invalid table'; end if;
      select id, bill_no into v_bill_id, v_bill_no from bills
       where table_id = p_table_id and status = 'open';
      if v_bill_id is null then
        v_bill_no := pos_next_bill_no(p_branch_id);
        insert into bills(branch_id, bill_no, table_id, order_type, pax)
        values (p_branch_id, v_bill_no, p_table_id, 'dine_in', p_pax)
        on conflict (table_id) where status = 'open' and table_id is not null do nothing
        returning id into v_bill_id;
        if v_bill_id is null then                 -- lost the race: use the winner's bill
          select id, bill_no into v_bill_id, v_bill_no from bills
           where table_id = p_table_id and status = 'open';
        end if;
      elsif p_pax is not null then
        update bills set pax = p_pax where id = v_bill_id and pax is null;
      end if;
    else
      v_bill_no := pos_next_bill_no(p_branch_id);
      insert into bills(branch_id, bill_no, table_id, order_type, pax)
      values (p_branch_id, v_bill_no, null, 'takeaway', p_pax)
      returning id into v_bill_id;
    end if;

    -- serialise order numbering on this bill, and refuse a bill that was closed meanwhile
    perform 1 from bills where id = v_bill_id and status = 'open' for update;
    if not found then
      raise exception 'This bill was just closed. Please send the order again.';
    end if;
    select count(*) + 1 into v_n from orders where bill_id = v_bill_id;
    v_order_no := v_bill_no || '/' || v_n;
    insert into orders(bill_id, branch_id, order_no, source, placed_by, client_order_id, catalog_id)   -- M1: catalog_id
    values (v_bill_id, p_branch_id, v_order_no, p_source, p_placed_by, p_client_order_id, v_catalog)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from orders where client_order_id = p_client_order_id;
    if v_order_id is not null then return v_order_id; end if;
    raise;
  end;

  -- ── items: snapshot name, price, SST and modifiers from the menu ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from menu_products where id = (v_item->>'productId')::uuid;
    select * into v_var  from menu_variants where id = (v_item->>'variantId')::uuid;
    -- M1: the variant's price in this order's catalog
    select cvp.price_sen into v_unit from catalog_variant_prices cvp
     where cvp.catalog_id = v_catalog and cvp.variant_id = v_var.id;
    -- M1: an add-on costs the catalog's price when the catalog sets one, else the option's own
    select coalesce(jsonb_agg(jsonb_build_object(
             'optionId', o.id, 'group', g.name, 'name', o.name,
             'priceDeltaSen', coalesce(cop.price_delta_sen, o.price_delta_sen), 'route', ap.print_route)
             order by pmg.sort_order, g.name, o.sort_order, o.name), '[]'::jsonb),
           coalesce(sum(coalesce(cop.price_delta_sen, o.price_delta_sen)), 0)
      into v_mods, v_price
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v)
      join modifier_options o on o.id = x.v::uuid
      join modifier_groups g on g.id = o.group_id
      join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
      left join catalog_option_prices cop on cop.catalog_id = v_catalog and cop.option_id = o.id
      left join menu_products ap on ap.id = o.product_id;
    insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen,
                            sst_rate_bp, modifiers_snapshot, print_route, qty, note, takeaway_fee_sen)
    values (v_order_id, v_bill_id, v_prod.id, v_var.id,
            v_prod.name || case when v_var.feedme_variant_key <> '' then ' (' || v_var.name || ')' else '' end,
            v_unit + v_price, v_prod.sst_rate_bp, v_mods, v_prod.print_route,          -- M1: v_unit (was v_var.price_sen)
            coalesce((v_item->'qty')::numeric::integer, 1),
            nullif(trim(left(case when jsonb_typeof(v_item->'note') = 'string' then v_item->>'note' end, 200)), ''),
            -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills only)
            case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end);
  end loop;

  -- ── tickets: one job per route, shaped exactly like TicketPayload (ticket.ts) ──
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select p_branch_id, v_order_id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', v_label, 'orderNo', v_order_no,
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              order by l.kind_order, l.name))
    from (
      -- the item on its own route, modifiers as sub-lines
      select oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods
        from order_items oi
       where oi.order_id = v_order_id and oi.print_route is not null
      union all
      -- a modifier whose add-on product prints somewhere else gets its own line there
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.order_id = v_order_id and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
   group by l.route;

  return v_order_id;
end $$;
revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;

-- ── qr_menu, re-created: products outside their time slots are left out; each
--    product carries its photo path (the QR page builds the public URL) ─────
create or replace function qr_menu(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'paused', t.qr_paused,
    'needsPax', not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open' and b.pax is not null),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'products', c.products) order by c.sort_order, c.name)
      from (
        select mc.name, mc.sort_order,
          jsonb_agg(jsonb_build_object(
            'id', p.id, 'name', p.name, 'description', p.description,
            'soldOut', coalesce(bms.is_sold_out, false),
            'imagePath', p.image_path,                                                 -- M3: the product photo (a path in menu-images)
            -- M1: the qr catalog's prices; a variant it has no price for is not offered
            'variants', (select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'priceSen', cvp.price_sen,
                                                             'isBase', v.feedme_variant_key = '')
                                          order by v.sort_order, v.name)
                           from menu_variants v
                           join catalog_variant_prices cvp on cvp.catalog_id = qc.catalog_id and cvp.variant_id = v.id
                          where v.product_id = p.id and v.is_active),
            'groups', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select,
                       'options', coalesce((
                         select jsonb_agg(jsonb_build_object(
                                  'id', o.id, 'name', o.name,
                                  'priceDeltaSen', coalesce(cop.price_delta_sen, o.price_delta_sen),   -- M1
                                  'isDefault', o.is_default,
                                  'available', o.availability = 'all' and not coalesce(obs.is_sold_out, false))
                                order by o.sort_order, o.name)
                           from modifier_options o
                           left join catalog_option_prices cop on cop.catalog_id = qc.catalog_id and cop.option_id = o.id   -- M1
                           left join branch_menu_status obs on obs.branch_id = t.branch_id and obs.product_id = o.product_id
                          where o.group_id = g.id and o.availability <> 'hidden'), '[]'::jsonb))
                     order by pmg.sort_order, g.name)
                from product_modifier_groups pmg
                join modifier_groups g on g.id = pmg.group_id and g.is_active
               where pmg.product_id = p.id), '[]'::jsonb)
          ) order by cp.sort_order, p.name) as products                             -- M1: the catalog's order
          -- M1: the products of the branch's qr catalog that QR may sell (was menu_products.availability = 'all')
          from catalog_products cp
          join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
          join menu_categories mc on mc.id = p.category_id and mc.is_active
          left join branch_menu_status bms on bms.branch_id = t.branch_id and bms.product_id = p.id
         where cp.catalog_id = qc.catalog_id and cp.availability = 'all'
           and menu_product_open(p.id, now())                                        -- M3: inside a time slot now, or none
           and exists (select 1 from menu_variants v
                         join catalog_variant_prices cvp on cvp.catalog_id = qc.catalog_id and cvp.variant_id = v.id
                        where v.product_id = p.id and v.is_active)
         group by mc.name, mc.sort_order
      ) c), '[]'::jsonb))
  from dining_tables t
  -- M1: the branch's qr catalog, if it is set and active (none = an empty menu; ordering says why)
  left join lateral (
    select bc.catalog_id from branch_catalogs bc
      join menu_catalogs m on m.id = bc.catalog_id and m.is_active
     where bc.branch_id = t.branch_id and bc.role = 'qr'
  ) qc on true
  where t.qr_token = p_token and t.is_active
$$;
revoke all on function qr_menu(text) from public;
grant execute on function qr_menu(text) to anon, authenticated;

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'time slots and photos functions applied' as result;
```

- [ ] **Step 6: Check the re-created functions against their live text.** Run:

```bash
diff <(sed -n '/^create or replace function pos_insert_order/,/^revoke all on function pos_insert_order/p' supabase/migration-2026-10-24-pos-catalogs-fn.sql) \
     <(sed -n '/^create or replace function pos_insert_order/,/^revoke all on function pos_insert_order/p' supabase/migration-2026-10-24-pos-slots-photos-fn.sql)
diff <(sed -n '/^create or replace function qr_menu/,/^grant execute on function qr_menu/p' supabase/migration-2026-10-24-pos-catalogs-fn.sql) \
     <(sed -n '/^create or replace function qr_menu/,/^grant execute on function qr_menu/p' supabase/migration-2026-10-24-pos-slots-photos-fn.sql)
```

Expected: exactly the M3 lines, nothing else —

```
75a76,79
>     -- M3: inside one of its time slots now (Asia/Kuala_Lumpur, the server's clock), or it has none
>     if not menu_product_open(v_prod.id, now()) then
>       raise exception '% is not available at this time', v_prod.name;
>     end if;
13a14
>             'imagePath', p.image_path,                                                 -- M3: the product photo (a path in menu-images)
45a47
>            and menu_product_open(p.id, now())                                        -- M3: inside a time slot now, or none
```

If any other line differs, M1's file changed since this plan was written: take its current text for the two functions and add the same M3 lines again.

- [ ] **Step 7: Run the scan and the gates.** Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` — Expected: PASS, 21 tests (the scan now reads two more files and has one more test). If a statement is listed, add its WHERE — never silence the scan. Run: `grep -c "set search_path = public, pg_temp" supabase/migration-2026-10-24-pos-slots-photos-fn.sql` — Expected: `17` (every function). Run: `grep -c "notify pgrst, 'reload schema'" supabase/migration-2026-10-24-pos-slots-photos.sql supabase/migration-2026-10-24-pos-slots-photos-fn.sql` — Expected: `1` each. Run: `npx vitest run` — Expected: 91 files, 813 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add supabase/migration-2026-10-24-pos-slots-photos.sql supabase/migration-2026-10-24-pos-slots-photos-fn.sql src/features/pos/sqlSafeUpdate.test.ts supabase/migration-2026-10-24-pos-catalogs-fn.sql
git commit -m "feat(pos-menu): time-slot schedules and product photos — schema, menu-images bucket, functions; ordering and QR honour the slots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Verify script — and applying M3 on craft-os-dev (implementer + controller)

**Files:**
- Create: `supabase/migration-2026-10-24-pos-slots-photos-verify.sql`, `src/features/pos/menu/slotVectorsSql.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; the dev test login `76cbcf9f-905e-450d-9f5e-1c9e72a9373d` (owner).
- Produces: on dev, both M3 migrations applied and six verify scripts printing `VERIFY OK` (menu, ordering, checkout, catalogs, menu editor, slots and photos).

The script covers spec §9's M3 items and every refusal of Task 2, each paired with the success it guards: grants, internal helpers, `search_path`, the slot check present in `pos_insert_order` and `qr_menu` (a re-run of M1's file is caught), no write policy on the three new tables, the bucket, its read policy for signed-in staff only and its three Edit-menu write policies (A); **the 19 shared vectors through `menu_window_open`** (B); `menu_save_schedule` — every refusal leaving nothing behind, the cleaned name, windows in order with sorted days, links; an edit that leaves out `productIds` keeps them, windows replaced, the product list replaced; **a product following 20 schedules refused a 21st from the schedule's side**; **Delete** removes the schedule with its windows and links (D); `menu_product_open` at fixed instants on a two-window schedule crossing midnight, a product without schedules, a product whose link is removed (E); **ordering by the server's clock** with windows built around the current Malaysian minute — refused in a closed window and in a closed window that crosses midnight (counter and QR, nothing written), accepted with no schedule, with one open window out of two, and in an open window that crosses midnight; refused, then accepted once its schedule is deleted (F); `qr_menu` hides the closed products and gives the photo path; `pos_menu_windows` for a cashier as `authenticated`, the server's clock, no windows for a switched-off product, not staff refused (G); the list and detail reads, a product's schedules set and cleared (21 refused, null refused), reorder (H); **Edit menu on every editor function: manager refused, owner allowed, resigned owner refused** (J — run before I); **photos** last — a manager cannot upload and the owner can only under `products/`, each refusal counted only when the RLS policy on `"objects"` made it; `menu_set_product_image` refuses another product's folder, a wrong type, a file not uploaded; set / replace (returns the old path) / clear; anon cannot list the bucket, anon and a manager change or delete nothing, the owner can change a row; the table's CHECK; the import's targets (I). If dev's real Storage refuses a test row for a reason of its own (a trigger, not the policy), the parts of I that need the rows are skipped with a `SKIP I…` notice and the script still reaches `VERIFY OK`. The vectors are a byte-for-byte copy of `slotVectors.json`; `slotVectorsSql.test.ts` fails if the two differ.

- [ ] **Step 1: Write the verify script.** Create `supabase/migration-2026-10-24-pos-slots-photos-verify.sql` (the `$vectors$` block is `slotVectors.json` verbatim):

```sql
-- Self-check for the POS menu time slots and photos (M3). Run on craft-os-dev after
-- migration-2026-10-24-pos-slots-photos.sql and -slots-photos-fn.sql. Everything is rolled back.
-- Success = a result row "VERIFY OK". Every refusal is paired with the success it guards; the
-- Edit menu checks call each function as `authenticated` (grants too).
-- The vectors below are a byte-for-byte copy of src/features/pos/menu/slotVectors.json
-- (slotVectorsSql.test.ts fails if the two differ).
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm <> p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- A minute of the day (any whole number, taken modulo one day) as a time.
create function pg_temp.hm(p_minute integer) returns time
language sql immutable as $$
  select make_time(((p_minute % 1440 + 1440) % 1440) / 60, ((p_minute % 1440 + 1440) % 1440) % 60, 0)
$$;

-- A window as menu_save_schedule takes it.
create function pg_temp.win(p_days integer[], p_start time, p_end time) returns jsonb
language sql immutable as $$
  select jsonb_build_object('days', to_jsonb(p_days), 'start', to_char(p_start, 'HH24:MI'), 'end', to_char(p_end, 'HH24:MI'))
$$;

do $$
declare
  v_vectors jsonb := $vectors$
[
  {"name": "inside a weekday window: Mon 09:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T01:00:00Z", "open": true},
  {"name": "the start minute counts: Mon 08:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T00:00:00Z", "open": true},
  {"name": "the end minute counts, to its last second: Mon 11:30:59", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T03:30:59Z", "open": true},
  {"name": "a minute after the end: Mon 11:31", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-26T03:31:00Z", "open": false},
  {"name": "a minute before the start: Mon 07:59 (still Sunday in UTC)", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-25T23:59:00Z", "open": false},
  {"name": "Malaysian day, not the UTC day: Mon 00:30 is Sunday 16:30 UTC", "days": [1], "start": "00:00", "end": "08:00", "at": "2026-10-25T16:30:00Z", "open": true},
  {"name": "a day that is not listed: Sat 09:00", "days": [1, 2, 3, 4, 5], "start": "08:00", "end": "11:30", "at": "2026-10-24T01:00:00Z", "open": false},
  {"name": "crossing midnight, before midnight on the start day: Fri 23:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T15:00:00Z", "open": true},
  {"name": "crossing midnight, after midnight belongs to the start day: Sat 01:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T17:00:00Z", "open": true},
  {"name": "crossing midnight, the end minute counts: Sat 02:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T18:00:00Z", "open": true},
  {"name": "crossing midnight, a minute after the end: Sat 02:01", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-23T18:01:00Z", "open": false},
  {"name": "crossing midnight, early morning of the start day belongs to the day before: Fri 01:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-22T17:00:00Z", "open": false},
  {"name": "crossing midnight, evening of a day that is not listed: Sat 23:00", "days": [5], "start": "22:00", "end": "02:00", "at": "2026-10-24T15:00:00Z", "open": false},
  {"name": "Sunday is day 7: Sun 12:00", "days": [7], "start": "10:00", "end": "23:59", "at": "2026-10-25T04:00:00Z", "open": true},
  {"name": "Sunday night into Monday: Mon 01:30", "days": [7], "start": "22:00", "end": "02:00", "at": "2026-10-25T17:30:00Z", "open": true},
  {"name": "Feedme's 10:00–23:59 runs to midnight: Sat 23:59:30", "days": [1, 2, 3, 4, 5, 6, 7], "start": "10:00", "end": "23:59", "at": "2026-10-24T15:59:30Z", "open": true},
  {"name": "Feedme's 10:00–23:59 is closed at midnight: Sun 00:00", "days": [1, 2, 3, 4, 5, 6, 7], "start": "10:00", "end": "23:59", "at": "2026-10-24T16:00:00Z", "open": false},
  {"name": "an end of 00:00 is the first minute of the next day: Tue 00:00", "days": [1], "start": "18:00", "end": "00:00", "at": "2026-10-26T16:00:00Z", "open": true},
  {"name": "an end of 00:00, a minute later: Tue 00:01", "days": [1], "start": "18:00", "end": "00:00", "at": "2026-10-26T16:01:00Z", "open": false}
]
$vectors$;
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr     uuid := 'dddddddd-0000-0000-0000-000000000031';   -- manager of VERIFY M3: no manage_menu
  v_cashier uuid := 'dddddddd-0000-0000-0000-000000000032';   -- staff of VERIFY M3
  v_boss    uuid := 'dddddddd-0000-0000-0000-000000000033';   -- a second owner, resigned in J
  v_branch uuid; v_t1 dining_tables;
  v_cat uuid; c_dine uuid; c_qr uuid;
  v_pancake uuid; v_latte uuid; v_toast uuid; v_soup uuid; v_noodle uuid;
  v_pancake_v uuid; v_latte_v uuid; v_toast_v uuid; v_soup_v uuid; v_noodle_v uuid;
  s_late uuid; s_open uuid; s_closed uuid; s_cross_open uuid; s_cross_closed uuid;
  v_local timestamp; v_dow integer; v_min integer; v_yesterday integer; v_later integer;
  v_s jsonb; v_res jsonb; v_text text; v_id uuid; v_order uuid; n integer; r record;
  v_path text; v_path2 text; v_res_ids uuid[]; v_skip_i boolean;
begin
  -- ── A. grants, internal helpers, search_path, policies ────────────────────
  for r in select f from unnest(array[
             'menu_schedule_list()', 'menu_schedule_detail(uuid)', 'menu_product_extras(uuid)', 'menu_photo_targets()',
             'menu_save_schedule(jsonb)', 'menu_reorder_schedules(uuid[])', 'menu_delete_schedule(uuid)',
             'menu_set_product_schedules(uuid,uuid[])', 'menu_set_product_image(uuid,text)', 'pos_menu_windows(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array[
             'menu_window_open(smallint[],time,time,timestamptz)', 'menu_product_open(uuid,timestamptz)',
             'menu_window_json(menu_schedule_windows)', 'menu_hm(jsonb)', 'menu_days(jsonb)',
             'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'qr_menu(text)', 'execute') then raise exception 'FAIL grants: the QR page cannot call qr_menu'; end if;
  if (select count(*) from pg_proc where proname = 'pos_insert_order') <> 1 then
    raise exception 'FAIL: more than one pos_insert_order — an old file was re-run; re-run the M1 and M3 function files';
  end if;
  -- re-running M1's function file silently drops the slot check and the QR filter
  if pg_get_functiondef('pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)'::regprocedure) not like '%menu_product_open%'
     or pg_get_functiondef('qr_menu(text)'::regprocedure) not like '%menu_product_open%' then
    raise exception 'FAIL: pos_insert_order or qr_menu has no time-slot check — re-run migration-2026-10-24-pos-slots-photos-fn.sql';
  end if;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'menu_window_open','menu_product_open','menu_window_json','menu_hm','menu_days','menu_schedule_list',
              'menu_schedule_detail','menu_product_extras','menu_photo_targets','menu_save_schedule','menu_reorder_schedules',
              'menu_delete_schedule','menu_set_product_schedules','menu_set_product_image','pos_menu_windows',
              'pos_insert_order','qr_menu'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  -- the three new tables are written only through the Edit menu functions
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('menu_schedules','menu_schedule_windows','product_schedules') and cmd <> 'SELECT') then
    raise exception 'FAIL rls: a time-slot table can be written directly';
  end if;
  if exists (select 1 from pg_class where relname in ('menu_schedules','menu_schedule_windows','product_schedules')
              and relnamespace = 'public'::regnamespace and not relrowsecurity) then
    raise exception 'FAIL rls: a time-slot table has row level security off';
  end if;
  if not exists (select 1 from storage.buckets where id = 'menu-images' and public
                   and allowed_mime_types @> array['image/webp', 'image/jpeg'] and file_size_limit = 2097152) then
    raise exception 'FAIL storage: bucket menu-images is missing or not public';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                   and policyname = 'menu_images_read' and cmd = 'SELECT' and roles = array['authenticated']::name[]) then
    raise exception 'FAIL storage: menu-images must be listable by signed-in staff only (public URLs need no policy)';
  end if;
  for r in select x.cmd from unnest(array['INSERT', 'UPDATE', 'DELETE']) as x(cmd) loop
    if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd = r.cmd
                     and coalesce(qual, '') || coalesce(with_check, '') like '%menu-images%'
                     and coalesce(qual, '') || coalesce(with_check, '') like '%has_menu_cap(''manage_menu''::text)%') then
      raise exception 'FAIL storage: no Edit menu % policy on menu-images', r.cmd;
    end if;
  end loop;

  -- ── B. the time maths: the shared vectors ─────────────────────────────────
  if jsonb_array_length(v_vectors) <> 19 then raise exception 'FAIL vectors: expected 19, got %', jsonb_array_length(v_vectors); end if;
  for r in select v from jsonb_array_elements(v_vectors) v loop
    if menu_window_open(array(select jsonb_array_elements_text(r.v->'days')::smallint), (r.v->>'start')::time,
                        (r.v->>'end')::time, (r.v->>'at')::timestamptz) is distinct from (r.v->>'open')::boolean then
      raise exception 'FAIL B %: expected open = %', r.v->>'name', r.v->>'open';
    end if;
  end loop;

  -- ── C. fixture: a branch, two catalogs, five products, staff ──────────────
  update system_role_permissions set permissions = permissions - 'manage_menu';   -- code defaults for this run
  insert into branches(name, address) values ('VERIFY M3', 'verify') returning id into v_branch;
  insert into dining_tables(branch_id, label) values (v_branch, 'M3') returning * into v_t1;
  insert into menu_categories(name, sort_order) values ('VERIFY M3 FOOD', 900) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M3 Dine', 900) returning id into c_dine;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M3 QR', 901) returning id into c_qr;
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', c_dine), (v_branch, 'takeaway', c_dine), (v_branch, 'qr', c_qr);
  insert into menu_products(name, category_id) values ('Verify M3 Pancake', v_cat) returning id into v_pancake;
  insert into menu_products(name, category_id) values ('Verify M3 Latte', v_cat) returning id into v_latte;
  insert into menu_products(name, category_id) values ('Verify M3 Toast', v_cat) returning id into v_toast;
  insert into menu_products(name, category_id) values ('Verify M3 Soup', v_cat) returning id into v_soup;
  insert into menu_products(name, category_id) values ('Verify M3 Noodle', v_cat) returning id into v_noodle;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_pancake, '', 'Regular', 1500) returning id into v_pancake_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_latte, '', 'Regular', 1200) returning id into v_latte_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_toast, '', 'Regular', 800) returning id into v_toast_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_soup, '', 'Regular', 900) returning id into v_soup_v;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_noodle, '', 'Regular', 1100) returning id into v_noodle_v;
  insert into catalog_products(catalog_id, product_id, availability)
  select c, p, 'all' from unnest(array[c_dine, c_qr]) c cross join unnest(array[v_pancake, v_latte, v_toast, v_soup, v_noodle]) p;
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
  select c, v, 1000 from unnest(array[c_dine, c_qr]) c cross join unnest(array[v_pancake_v, v_latte_v, v_toast_v, v_soup_v, v_noodle_v]) v;
  -- staff are inserted as 'staff' and promoted by the owner (the staff guard refuses anything else)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into auth.users (id) values (v_mgr), (v_cashier), (v_boss);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,     'Verify M3 Manager', 'trainee', true, current_date, 'staff', v_branch),
    (v_cashier, 'Verify M3 Cashier', 'trainee', true, current_date, 'staff', v_branch),
    (v_boss,    'Verify M3 Boss',    'trainee', true, current_date, 'staff', v_branch);
  update staff set system_role = 'manager' where id = v_mgr;
  update staff set system_role = 'owner' where id = v_boss;
  if not staff_has_cap(v_owner, 'manage_menu') then raise exception 'FAIL fixture: the test login (owner) lacks manage_menu'; end if;

  -- ── D. menu_save_schedule and menu_delete_schedule ───────────────────────
  v_s := jsonb_build_object('id', null, 'name', '  Verify  M3 Late night ',
    'windows', jsonb_build_array(pg_temp.win(array[5, 6], '22:00', '02:00'), pg_temp.win(array[1, 2, 3, 4, 5], '11:00', '14:00')),
    'productIds', jsonb_build_array(v_soup));
  -- D1. every refusal leaves nothing behind, and says why in the editor's words
  select count(*) into n from menu_schedules;
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', '[]'), 'Invalid schedule', 'D1 not an object');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{name}', '" "')),
    'Schedule name is required', 'D1 blank name');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{name}', to_jsonb(repeat('x', 61)))),
    'Schedule name is too long (at most 60 characters)', 'D1 long name');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows}', '[]')),
    'A schedule needs at least one time window', 'D1 no window');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)',
      jsonb_set(v_s, '{windows}', (select jsonb_agg(pg_temp.win(array[1], '08:00', '09:00')) from generate_series(1, 11)))),
    'Too many time windows (at most 10)', 'D1 eleven windows');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,days}', '[]')),
    'Pick at least one day for each time window', 'D1 no day');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,days}', '[0, 1]')),
    'Invalid schedule', 'D1 day 0');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,days}', '["1"]')),
    'Invalid schedule', 'D1 day as text');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,start}', '"24:00"')),
    'Enter each time as HH:MM, e.g. 08:00', 'D1 24:00');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,end}', '"2:00"')),
    'Enter each time as HH:MM, e.g. 08:00', 'D1 2:00');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{windows,0,end}', '"22:00"')),
    'A time window cannot start and end at the same time', 'D1 empty window');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{productIds}', '{"a": 1}')),
    'Invalid schedule', 'D1 productIds not a list');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{productIds}', jsonb_build_array(gen_random_uuid()))),
    'Product not found — refresh and try again', 'D1 unknown product');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{productIds}', '["x"]')),
    'Invalid schedule', 'D1 product id not a uuid');
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{id}', to_jsonb(gen_random_uuid()))),
    'Schedule not found — refresh and try again', 'D1 unknown schedule');
  if (select count(*) from menu_schedules) <> n then raise exception 'FAIL D1: a refused save left a schedule behind'; end if;
  -- D2. created: name cleaned, windows in order (days sorted, minutes kept), linked product
  s_late := menu_save_schedule(v_s);
  if (select name from menu_schedules where id = s_late) <> 'Verify M3 Late night'
     or (select jsonb_agg(menu_window_json(w) order by w.sort_order) from menu_schedule_windows w where w.schedule_id = s_late)
        <> jsonb_build_array(jsonb_build_object('days', jsonb_build_array(5, 6), 'start', '22:00', 'end', '02:00'),
                             jsonb_build_object('days', jsonb_build_array(1, 2, 3, 4, 5), 'start', '11:00', 'end', '14:00'))
     or not exists (select 1 from product_schedules where product_id = v_soup and schedule_id = s_late) then
    raise exception 'FAIL D2: the created schedule';
  end if;
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_set(v_s, '{name}', '"verify m3 LATE night"')),
    'A schedule called verify m3 LATE night already exists', 'D2 twin name');
  -- D3. edited: windows replaced, productIds left out = links kept
  perform menu_save_schedule(jsonb_build_object('id', s_late, 'name', 'Verify M3 Late night',
    'windows', jsonb_build_array(pg_temp.win(array[6, 5, 5], '22:00', '02:00'))));
  if (select count(*) from menu_schedule_windows where schedule_id = s_late) <> 1
     or (select days from menu_schedule_windows where schedule_id = s_late) <> array[5, 6]::smallint[]
     or not exists (select 1 from product_schedules where product_id = v_soup and schedule_id = s_late) then
    raise exception 'FAIL D3: a save that left out productIds changed the links, or the windows were not replaced';
  end if;
  -- D4. productIds given = the whole set of products that follow it
  perform menu_save_schedule(jsonb_build_object('id', s_late, 'name', 'Verify M3 Late night',
    'windows', jsonb_build_array(pg_temp.win(array[5, 6], '22:00', '02:00'), pg_temp.win(array[1, 2, 3, 4, 5], '11:00', '14:00')),
    'productIds', jsonb_build_array(v_noodle, v_noodle)));
  if exists (select 1 from product_schedules where product_id = v_soup and schedule_id = s_late)
     or (select count(*) from product_schedules where schedule_id = s_late) <> 1 then
    raise exception 'FAIL D4: the linked products were not replaced by the list';
  end if;
  -- D5. a product follows at most 20 schedules, from the schedule's side too
  for n in 1 .. 20 loop
    perform menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Many ' || n,
      'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], '00:00', '23:59')), 'productIds', jsonb_build_array(v_latte)));
  end loop;
  perform pg_temp.expect_error(format('select menu_save_schedule(%L::jsonb)', jsonb_build_object('id', null, 'name', 'Verify M3 Many 21',
      'windows', jsonb_build_array(pg_temp.win(array[1], '08:00', '09:00')), 'productIds', jsonb_build_array(v_latte))),
    'Verify M3 Latte follows too many schedules (at most 20)', 'D5 twenty-first schedule');
  v_id := (select id from menu_schedules where name = 'Verify M3 Many 20');
  perform menu_save_schedule(jsonb_build_object('id', v_id, 'name', 'Verify M3 Many 20',          -- one of its 20 may be saved again
    'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], '00:00', '23:59')), 'productIds', jsonb_build_array(v_latte)));
  -- D6. Delete (Feedme's way, no on/off switch): the schedule, its windows and its links go
  for r in select id from menu_schedules where name like 'Verify M3 Many %' loop
    perform menu_delete_schedule(r.id);
  end loop;
  if exists (select 1 from menu_schedules where name like 'Verify M3 Many %')
     or exists (select 1 from product_schedules where product_id = v_latte)
     or exists (select 1 from menu_schedule_windows w where not exists (select 1 from menu_schedules s where s.id = w.schedule_id)) then
    raise exception 'FAIL D6: a deleted schedule left its windows or links behind';
  end if;
  perform pg_temp.expect_error(format('select menu_delete_schedule(%L)', gen_random_uuid()),
    'Schedule not found — refresh and try again', 'D6 unknown');
  perform pg_temp.expect_error('select menu_delete_schedule(null)', 'Schedule not found — refresh and try again', 'D6 null');

  -- ── E. menu_product_open at fixed instants: any window of any schedule it follows ─
  -- Noodle follows Late night: Fri + Sat 22:00–02:00 and Mon–Fri 11:00–14:00.
  for r in select * from (values
      ('2026-10-23T15:00:00Z'::timestamptz, true,  'Fri 23:00'),
      ('2026-10-24T17:30:00Z'::timestamptz, true,  'Sun 01:30 (Saturday night)'),
      ('2026-10-24T18:01:00Z'::timestamptz, false, 'Sun 02:01'),
      ('2026-10-25T15:00:00Z'::timestamptz, false, 'Sun 23:00'),
      ('2026-10-26T04:00:00Z'::timestamptz, true,  'Mon 12:00 (lunch window)'),
      ('2026-10-26T06:01:00Z'::timestamptz, false, 'Mon 14:01')) as x(at, open, label) loop
    if menu_product_open(v_noodle, r.at) is distinct from r.open then
      raise exception 'FAIL E %: expected open = %', r.label, r.open;
    end if;
  end loop;
  if not menu_product_open(v_latte, '2026-10-25T19:00:00Z') then raise exception 'FAIL E: a product with no schedule is always open'; end if;
  perform menu_save_schedule(jsonb_build_object('id', s_late, 'name', 'Verify M3 Late night',
    'windows', jsonb_build_array(pg_temp.win(array[5, 6], '22:00', '02:00')), 'productIds', '[]'::jsonb));
  if not menu_product_open(v_noodle, '2026-10-25T15:00:00Z') then
    raise exception 'FAIL E: a product that no longer follows a schedule must be open';
  end if;

  -- ── F. ordering by the server's clock (windows built around the current Malaysian minute) ─
  v_local := now() at time zone 'Asia/Kuala_Lumpur';
  v_dow := extract(isodow from v_local)::integer;
  v_min := (extract(hour from v_local) * 60 + extract(minute from v_local))::integer;
  v_yesterday := case when v_dow = 1 then 7 else v_dow - 1 end;
  v_later := v_dow % 7 + 2;                                        -- neither today nor yesterday
  if v_later > 7 then v_later := v_later - 7; end if;
  s_open := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Open now',
    'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min - 1), pg_temp.hm(v_min + 1))),
    'productIds', jsonb_build_array(v_toast)));
  s_closed := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Closed now',
    'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min + 60), pg_temp.hm(v_min + 120))),
    'productIds', jsonb_build_array(v_pancake, v_toast)));
  -- crossing midnight and open now: started yesterday at 23:59, ends at this very minute
  -- (at 23:59 itself: started today at 23:59, ends at 00:00)
  s_cross_open := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Cross open',
    'windows', jsonb_build_array(case when v_min < 1439 then pg_temp.win(array[v_yesterday], '23:59', pg_temp.hm(v_min))
                                      else pg_temp.win(array[v_dow], '23:59', '00:00') end),
    'productIds', jsonb_build_array(v_soup)));
  -- crossing midnight and closed now: from the next minute round to the minute before
  -- (at 00:00 and 23:59: a crossing window on a day that is neither today nor yesterday)
  s_cross_closed := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Cross closed',
    'windows', jsonb_build_array(case when v_min between 1 and 1438 then pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min + 1), pg_temp.hm(v_min - 1))
                                      else pg_temp.win(array[v_later], '23:00', '01:00') end),
    'productIds', jsonb_build_array(v_noodle)));
  if (select count(*) from menu_schedule_windows w where w.schedule_id in (s_cross_open, s_cross_closed) and w.end_time < w.start_time) <> 2 then
    raise exception 'FAIL F fixture: both cross windows must cross midnight';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  -- F1. outside every window: refused in the server's words, nothing written
  select count(*) into n from orders;
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, 2, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v),
                        jsonb_build_object('productId', v_pancake, 'variantId', v_pancake_v)), gen_random_uuid()),
    'Verify M3 Pancake is not available at this time', 'F1 pancake (closed window)');
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, 2, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_noodle, 'variantId', v_noodle_v)), gen_random_uuid()),
    'Verify M3 Noodle is not available at this time', 'F1 noodle (closed window crossing midnight)');
  perform pg_temp.expect_error(format('select place_table_order(%L, 2, %L::jsonb, %L)', v_t1.qr_token,
      jsonb_build_array(jsonb_build_object('productId', v_pancake, 'variantId', v_pancake_v)), gen_random_uuid()),
    'Verify M3 Pancake is not available at this time', 'F1 pancake by QR');
  if (select count(*) from orders) <> n then raise exception 'FAIL F1: a refused order was written'; end if;
  -- F2. inside a window (any one), or no schedule at all: accepted
  v_order := place_counter_order(v_t1.id, 'dine_in', 2, jsonb_build_array(
    jsonb_build_object('productId', v_latte, 'variantId', v_latte_v),
    jsonb_build_object('productId', v_toast, 'variantId', v_toast_v),
    jsonb_build_object('productId', v_soup, 'variantId', v_soup_v)), gen_random_uuid());
  if (select count(*) from order_items where order_id = v_order) <> 3 then
    raise exception 'FAIL F2: latte (no schedule), toast (one open window) and soup (open, crossing midnight) must sell';
  end if;
  -- F3. a deleted schedule no longer refuses: the latte follows a closed one, then it is deleted
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_id := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 Gone',
    'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min + 60), pg_temp.hm(v_min + 120))),
    'productIds', jsonb_build_array(v_latte)));
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, null, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v)), gen_random_uuid()),
    'Verify M3 Latte is not available at this time', 'F3 latte before the delete');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_delete_schedule(v_id);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v)), gen_random_uuid());
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- ── G. what the QR page and the counter read ──────────────────────────────
  -- G1. qr_menu leaves out products outside their slots and gives each product its photo path
  update menu_products set image_path = 'products/' || v_latte || '/verifyphoto1.webp' where id = v_latte;
  v_res := (select jsonb_agg(pr) from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
              cross join jsonb_array_elements(c->'products') pr where c->>'name' = 'VERIFY M3 FOOD');
  if exists (select 1 from jsonb_array_elements(v_res) pr where pr->>'id' in (v_pancake::text, v_noodle::text))
     or (select count(*) from jsonb_array_elements(v_res) pr where pr->>'id' in (v_latte::text, v_toast::text, v_soup::text)) <> 3
     or (select pr->>'imagePath' from jsonb_array_elements(v_res) pr where pr->>'id' = v_latte::text)
        is distinct from 'products/' || v_latte || '/verifyphoto1.webp'
     or not (select pr ? 'imagePath' from jsonb_array_elements(v_res) pr where pr->>'id' = v_toast::text) then
    raise exception 'FAIL G1: qr_menu %', v_res;
  end if;
  -- G2. the counter: windows of the catalog's scheduled products, by the server's clock; the menu itself is unchanged
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := pos_menu_windows(c_dine);
  reset role;
  if (select count(*) from jsonb_array_elements(v_res->'windows') w where w->>'productId' = v_toast::text) <> 2
     or (select count(*) from jsonb_array_elements(v_res->'windows') w where w->>'productId' = v_pancake::text) <> 1
     or exists (select 1 from jsonb_array_elements(v_res->'windows') w where w->>'productId' = v_latte::text)
     or not exists (select 1 from jsonb_array_elements(v_res->'windows') w
                     where w->>'productId' = v_pancake::text and w->>'start' = to_char(pg_temp.hm(v_min + 60), 'HH24:MI')
                       and w->'days' = '[1, 2, 3, 4, 5, 6, 7]'::jsonb)
     or abs(extract(epoch from (v_res->>'now')::timestamptz - now())) > 1 then
    raise exception 'FAIL G2: pos_menu_windows %', v_res;
  end if;
  if not exists (select 1 from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_pancake::text) then
    raise exception 'FAIL G2: the pad still lists a product outside its slots (it greys it out)';
  end if;
  -- a switched-off product is not on the pad, so its windows are not sent either
  update menu_products set is_active = false where id = v_pancake;
  if exists (select 1 from jsonb_array_elements(pos_menu_windows(c_dine)->'windows') w where w->>'productId' = v_pancake::text) then
    raise exception 'FAIL G2: a switched-off product''s windows reach the counter';
  end if;
  update menu_products set is_active = true where id = v_pancake;
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select pos_menu_windows(%L)', c_dine), 'Your account is not active', 'G2 not staff');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- ── H. the Schedules page and the product editor's Time slots ─────────────
  v_res := (select x from jsonb_array_elements(menu_schedule_list()) x where x->>'id' = s_closed::text);
  if (v_res->>'productCount')::int <> 2 or jsonb_array_length(v_res->'windows') <> 1 or v_res->>'name' <> 'Verify M3 Closed now' then
    raise exception 'FAIL H: menu_schedule_list %', v_res;
  end if;
  v_res := menu_schedule_detail(s_closed);
  if not (v_res->'productIds' @> jsonb_build_array(v_pancake, v_toast)) or jsonb_array_length(v_res->'windows') <> 1 then
    raise exception 'FAIL H: menu_schedule_detail %', v_res;
  end if;
  perform pg_temp.expect_error(format('select menu_schedule_detail(%L)', gen_random_uuid()), 'Schedule not found', 'H unknown');
  -- H1. a product's schedules: the whole set, empty = always available
  perform menu_set_product_schedules(v_toast, array[s_closed, s_open, s_open]);
  if (select count(*) from product_schedules where product_id = v_toast) <> 2 then
    raise exception 'FAIL H1: the product''s schedules';
  end if;
  v_res := menu_product_extras(v_toast);
  if not (v_res->'scheduleIds' @> jsonb_build_array(s_closed, s_open)) or v_res->'imagePath' <> 'null'::jsonb then
    raise exception 'FAIL H1: menu_product_extras %', v_res;
  end if;
  perform menu_set_product_schedules(v_toast, '{}');
  if exists (select 1 from product_schedules where product_id = v_toast) then raise exception 'FAIL H1: links not removed'; end if;
  perform pg_temp.expect_error(format('select menu_set_product_schedules(%L, %L::uuid[])', v_toast, array[gen_random_uuid()]),
    'Schedule not found — refresh and try again', 'H1 unknown schedule');
  perform pg_temp.expect_error(format('select menu_set_product_schedules(%L, %L::uuid[])', v_toast,
      (select array_agg(gen_random_uuid()) from generate_series(1, 21))),
    'Too many schedules (at most 20)', 'H1 twenty-one schedules');
  perform pg_temp.expect_error(format('select menu_set_product_schedules(%L, null)', v_toast), 'Invalid schedule', 'H1 null list');
  perform pg_temp.expect_error(format('select menu_set_product_schedules(%L, %L::uuid[])', gen_random_uuid(), array[s_open]),
    'Product not found — refresh and try again', 'H1 unknown product');
  perform pg_temp.expect_error(format('select menu_product_extras(%L)', gen_random_uuid()), 'Product not found', 'H1 extras unknown');
  -- H2. reorder
  select array_agg(id order by sort_order desc, name desc) into v_res_ids from menu_schedules;
  perform menu_reorder_schedules(v_res_ids);
  if (select array_agg(id order by sort_order) from menu_schedules) <> v_res_ids then raise exception 'FAIL H2: reorder'; end if;
  perform pg_temp.expect_error(format('select menu_reorder_schedules(%L::uuid[])', v_res_ids[2:]),
    'The schedule list changed — refresh and try again', 'H2 one missing');

  -- ── J. Edit menu for every editor function: manager refused, owner allowed, resigned owner refused ─
  --    (before I: section I depends on dev's Storage internals, this must not)
  update staff set status = 'resigned' where id = v_boss;                    -- is_active stays true, as in real life
  select array_agg(id order by sort_order, name) into v_res_ids from menu_schedules;
  for r in select * from (values (v_mgr, false, 'manager'), (v_owner, true, 'owner'), (v_boss, false, 'resigned owner'))
                          as x(who, allowed, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    v_id := menu_save_schedule(jsonb_build_object('id', null, 'name', 'Verify M3 J ' || r.label,     -- for the delete below
      'windows', jsonb_build_array(pg_temp.win(array[1], '08:00', '09:00'))));
    perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform menu_schedule_list();
      if not r.allowed then raise exception 'FAIL J %: menu_schedule_list', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_schedule_detail(s_open);
      if not r.allowed then raise exception 'FAIL J %: menu_schedule_detail', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_product_extras(v_latte);
      if not r.allowed then raise exception 'FAIL J %: menu_product_extras', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_photo_targets();
      if not r.allowed then raise exception 'FAIL J %: menu_photo_targets', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_schedule(jsonb_build_object('id', s_open, 'name', 'Verify M3 Open now',
            'windows', jsonb_build_array(pg_temp.win(array[1, 2, 3, 4, 5, 6, 7], pg_temp.hm(v_min - 1), pg_temp.hm(v_min + 1)))));
      if not r.allowed then raise exception 'FAIL J %: menu_save_schedule', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_reorder_schedules(v_res_ids || (select array_agg(id) from menu_schedules where name like 'Verify M3 J %'));
      if not r.allowed then raise exception 'FAIL J %: menu_reorder_schedules', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_delete_schedule(v_id);
      if not r.allowed then raise exception 'FAIL J %: menu_delete_schedule', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_set_product_schedules(v_latte, '{}');
      if not r.allowed then raise exception 'FAIL J %: menu_set_product_schedules', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_set_product_image(v_soup, null);
      if not r.allowed then raise exception 'FAIL J %: menu_set_product_image', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    reset role;
  end loop;
  if exists (select 1 from menu_schedules where name = 'Verify M3 J owner')
     or (select count(*) from menu_schedules where name like 'Verify M3 J %') <> 2 then
    raise exception 'FAIL J: only the owner''s delete may go through';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  -- ── I. photos (last: it writes test rows into storage.objects, and dev's real Storage may
  --    refuse those for reasons of its own — then the parts that need them are skipped with
  --    a SKIP notice, and the rest still reaches VERIFY OK) ──────────────────
  v_path := 'products/' || v_pancake || '/verifyphotoA1.webp';
  v_path2 := 'products/' || v_pancake || '/verifyphotoB2.jpg';
  v_skip_i := false;
  -- I1. storage policies: a manager cannot upload; the owner can, under products/ only. A refusal
  --     counts only when the RLS policy on "objects" made it (not a trigger).
  for r in select * from (values (v_mgr, v_path, 'a manager uploaded a menu photo'),
                                 (v_owner, 'elsewhere/verifyphotoX.webp', 'a menu photo outside products/ was accepted'))
                          as x(who, name, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      insert into storage.objects(bucket_id, name) values ('menu-images', r.name);
      raise exception 'FAIL I1: %', r.label;
    exception when others then
      if sqlerrm like 'FAIL %' then raise; end if;
      if sqlerrm not like '%row-level security policy for table "objects"%' then
        raise notice 'SKIP I: storage refused the test row for its own reasons (%)', sqlerrm;
        v_skip_i := true;
      end if;
    end;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  if not v_skip_i then
    begin
      set local role authenticated;
      insert into storage.objects(bucket_id, name) values ('menu-images', v_path), ('menu-images', v_path2);
    exception when others then
      raise notice 'SKIP I: storage refused the owner''s test rows (%)', sqlerrm;
      v_skip_i := true;
    end;
    reset role;
  end if;
  -- I2. menu_set_product_image: only an uploaded file in the product's own folder (needs no storage row)
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_pancake, 'products/' || v_latte || '/verifyphotoA1.webp'),
    'Invalid photo path', 'I2 another product''s folder');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_pancake, v_path || '.png'),
    'Invalid photo path', 'I2 not webp or jpg');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', v_pancake, 'products/' || v_pancake || '/verifymissing.webp'),
    'Photo not found — upload it again', 'I2 not uploaded');
  perform pg_temp.expect_error(format('select menu_set_product_image(%L, %L)', gen_random_uuid(), v_path),
    'Product not found — refresh and try again', 'I2 unknown product');
  if not v_skip_i then
    -- I3. set, replace (returns the old path, which the editor deletes), clear. Each call is made
    --     before the rows are read: one IF does not fix the order its parts run in.
    v_text := menu_set_product_image(v_pancake, v_path);
    if v_text is not null
       or (select image_path from menu_products where id = v_pancake) is distinct from v_path
       or (select image_updated_at from menu_products where id = v_pancake) is null then
      raise exception 'FAIL I3: first photo';
    end if;
    v_text := menu_set_product_image(v_pancake, v_path2);
    if v_text is distinct from v_path then raise exception 'FAIL I3: replacing must return the old path'; end if;
    v_text := menu_set_product_image(v_pancake, v_path2);
    if v_text is not null then raise exception 'FAIL I3: the same path again replaces nothing'; end if;
    v_text := menu_set_product_image(v_pancake, null);
    if v_text is distinct from v_path2
       or (select image_path is null and image_updated_at is null from menu_products where id = v_pancake) is not true then
      raise exception 'FAIL I3: clearing the photo';
    end if;
    -- I3b. a customer (anon) cannot list the bucket; anon and a manager cannot change or delete a photo; the owner can change one
    for r in select * from (values ('anon', null::uuid), ('authenticated', v_mgr)) as x(role, who) loop
      perform set_config('request.jwt.claims', coalesce(json_build_object('sub', r.who, 'role', r.role)::text, '{"role": "anon"}'), true);
      begin
        if r.role = 'anon' then set local role anon; else set local role authenticated; end if;
        if r.role = 'anon' and exists (select 1 from storage.objects where bucket_id = 'menu-images') then
          raise exception 'FAIL I3b: anon can list menu-images';
        end if;
        update storage.objects set metadata = '{"verify": true}' where bucket_id = 'menu-images' and name = v_path;
        get diagnostics n = row_count;
        if n <> 0 then raise exception 'FAIL I3b: % changed a menu photo', r.role; end if;
        delete from storage.objects where bucket_id = 'menu-images' and name = v_path;
        get diagnostics n = row_count;
        if n <> 0 then raise exception 'FAIL I3b: % deleted a menu photo', r.role; end if;
      exception when others then
        if sqlerrm like 'FAIL %' then raise; end if;
        raise notice 'SKIP I3b (%): storage refused the statement for its own reasons (%)', r.role, sqlerrm;
      end;
      reset role;
    end loop;
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      update storage.objects set metadata = '{"verify": true}' where bucket_id = 'menu-images' and name = v_path;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'FAIL I3b: the owner could not change a menu photo'; end if;
    exception when others then
      if sqlerrm like 'FAIL %' then raise; end if;
      raise notice 'SKIP I3b (owner): storage refused the statement for its own reasons (%)', sqlerrm;
    end;
    reset role;
  end if;
  -- I4. the table refuses a path that is not a menu photo, whoever writes it
  begin
    update menu_products set image_path = 'http://example.com/x.png' where id = v_pancake;
    raise exception 'FAIL I4: menu_products accepted a foreign image path';
  exception when check_violation then
    null;
  end;
  -- I5. the import's targets
  v_res := (select x from jsonb_array_elements(menu_photo_targets()) x where x->>'id' = v_latte::text);
  if v_res->>'imagePath' <> 'products/' || v_latte || '/verifyphoto1.webp' or (v_res->>'isAddon')::boolean then
    raise exception 'FAIL I5: menu_photo_targets %', v_res;
  end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 2: Tie the copy to the original.** Create `src/features/pos/menu/slotVectorsSql.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import vectors from './slotVectors.json'

describe('the SQL verify script carries the very same time-slot vectors', () => {
  it('matches slotVectors.json exactly', () => {
    const sql = readFileSync(new URL('../../../../supabase/migration-2026-10-24-pos-slots-photos-verify.sql', import.meta.url), 'utf8')
    const m = sql.match(/\$vectors\$([\s\S]*?)\$vectors\$/)
    expect(m).not.toBeNull()
    expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual(vectors)
  })
})
```

- [ ] **Step 3: Local checks.** Run: `npx vitest run src/features/pos/menu/slotVectorsSql.test.ts` — Expected: PASS, 1 test. Run: `grep -c "VERIFY OK" supabase/migration-2026-10-24-pos-slots-photos-verify.sql` — Expected: `3` (header, notice, final select). Run: `grep -c "perform pg_temp.expect_error" supabase/migration-2026-10-24-pos-slots-photos-verify.sql` — Expected: `35`. Run: `grep -n "insert into staff" -B2 supabase/migration-2026-10-24-pos-slots-photos-verify.sql | grep -c "v_owner"` — Expected: `1`. Run: `npx vitest run` — Expected: 92 files, 814 tests pass (the scan ignores `-verify` files).

- [ ] **Step 4: Commit**

```bash
git add supabase/migration-2026-10-24-pos-slots-photos-verify.sql src/features/pos/menu/slotVectorsSql.test.ts
git commit -m "test(pos-menu): verify script for time slots and photos, with the shared time-slot vectors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5 (controller, craft-os-dev — dashboard SQL editor in the owner's Chrome tab; the implementer does not touch the database):** confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`) — never the prod project. Load each file with `window.monaco.editor.getModels()[0].setValue(...)` and run it with `cmd+Return`, in order:
  1. `migration-2026-10-24-pos-slots-photos.sql` → `time slots and photos schema applied`. Run it a **second time** → the same row.
  2. `migration-2026-10-24-pos-slots-photos-fn.sql` → `time slots and photos functions applied`. Run it a **second time** → the same row. A `STOP: …` error names the file to run first.
  3. `migration-2026-10-24-pos-slots-photos-verify.sql` → `VERIFY OK`.
  4. Regression, each → `VERIFY OK`: `migration-2026-10-22-pos-menu-verify.sql`, `migration-2026-10-23-pos-ordering-verify.sql`, `migration-2026-10-24-pos-checkout-verify.sql`, `migration-2026-10-24-pos-catalogs-verify.sql`, `migration-2026-10-24-pos-menu-editor-verify.sql`.
  5. The real menu is untouched and the bucket exists:

```sql
select (select count(*) from menu_schedules)                                   as schedules,
       (select count(*) from menu_products where image_path is not null)       as products_with_photo,
       (select count(*) from pg_proc where proname = 'pos_insert_order')       as pos_insert_order_versions,
       (select public::text || ' ' || file_size_limit || ' ' || array_to_string(allowed_mime_types, ',')
          from storage.buckets where id = 'menu-images')                       as bucket;
```

     Expected: `0`, `0`, `1`, `true 2097152 image/webp,image/jpeg`. Dashboard → Storage shows the public bucket **menu-images**.

  If a script stops with `FAIL …`, the message names the check: fix the function file (implementer, new commit), re-run it, then re-run the verify. Read the editor's messages too: a `SKIP I…` notice means dev's Storage refused a test row for a reason of its own (a trigger, not the policy) — record it; the storage policies are then checked in the browser in Task 6's controller step instead. Record the outcome in the ledger.

---

### Task 4: Schedules — list, editor, applied products

**Files:**
- Create: `src/features/pos/menu/slotsApi.ts`, `src/features/pos/menu/scheduleForm.ts`, `src/features/pos/menu/scheduleForm.test.ts`, `src/features/pos/menu/schedule/WindowsSection.tsx`, `src/features/pos/menu/schedule/ProductsSection.tsx`, `src/features/pos/menu/ScheduleEditorPage.tsx`, `src/features/pos/menu/SchedulesPage.tsx`
- Modify: `src/features/pos/menu/menuView.ts`, `src/features/pos/menu/menuView.test.ts`, `src/features/pos/menu/MenuRoutes.tsx`

**Interfaces:**
- Consumes: Task 1 (`timeSlots`), Task 2's RPCs, M2's `fetchMenu` (`menu_product_list`), `listAdmin.reorderedIds`, `menuForms.cleanName` / `nameProblem`, `editorUi`.
- Produces: `slotsApi.ts` (`ScheduleSummary`, `ScheduleDetail`, `SchedulePayload`, `ProductExtras`, `PhotoTarget`, `fetchSchedules`, `fetchScheduleDetail`, `saveSchedule`, `reorderSchedules`, `deleteSchedule`, `fetchProductExtras`, `setProductSchedules`, `fetchPhotoTargets`, `setProductImage`) used by Tasks 5, 6 and 9; routes `/menu/schedules`, `/menu/schedules/new`, `/menu/schedules/:id`; the **Schedules** tab.

- [ ] **Step 1: Write the failing tests.** Create `src/features/pos/menu/scheduleForm.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  addWindow, emptyScheduleForm, removeWindow, scheduleFormDirty, scheduleFormFromDetail, schedulePayload, scheduleProblems,
  setProduct, toggleDay, updateWindow,
} from './scheduleForm'

const detail = {
  id: 's1', name: 'Breakfast',
  windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '11:30' }],
  productIds: ['p2', 'p1'],
}

describe('scheduleForm', () => {
  it('starts a new schedule with one everyday window and no products', () => {
    const f = emptyScheduleForm()
    expect(f.windows).toEqual([{ key: 'w1', days: [1, 2, 3, 4, 5, 6, 7], start: '', end: '' }])
    expect(f.productIds).toEqual([])
    expect(scheduleFormDirty(f, null)).toBe(true)
  })

  it('edits windows: add, times, days in Monday-first order, remove', () => {
    let f = scheduleFormFromDetail(detail)
    f = addWindow(f)
    expect(f.windows.map((w) => w.key)).toEqual(['w1', 'w2'])
    f = updateWindow(f, 'w2', { start: '18:00', end: '21:00' })
    f = toggleDay(f, 'w2', 3)
    expect(f.windows[1].days).toEqual([1, 2, 4, 5, 6, 7])
    f = toggleDay(f, 'w2', 3)
    expect(f.windows[1].days).toEqual([1, 2, 3, 4, 5, 6, 7])
    f = removeWindow(f, 'w1')
    expect(f.windows.map((w) => w.key)).toEqual(['w2'])
    expect(addWindow(f).windows.map((w) => w.key)).toEqual(['w2', 'w1'])
  })

  it('keeps the product list sorted and without repeats', () => {
    let f = scheduleFormFromDetail(detail)
    expect(f.productIds).toEqual(['p1', 'p2'])
    f = setProduct(f, 'p0', true)
    f = setProduct(f, 'p0', true)
    expect(f.productIds).toEqual(['p0', 'p1', 'p2'])
    expect(setProduct(f, 'p1', false).productIds).toEqual(['p0', 'p2'])
  })

  it('finds every problem with the server words, once each', () => {
    const f = { ...emptyScheduleForm(), name: '  ' }
    expect(scheduleProblems(f, [])).toEqual([
      { section: 'details', message: 'Schedule name is required' },
      { section: 'windows', message: 'Enter each time as HH:MM, e.g. 08:00' },
    ])
    const twin = { ...scheduleFormFromDetail(detail), id: null, name: ' breakfast ' }
    expect(scheduleProblems(twin, [{ id: 's1', name: 'Breakfast' }])).toEqual([
      { section: 'details', message: 'A schedule called breakfast already exists' },
    ])
    expect(scheduleProblems(scheduleFormFromDetail(detail), [{ id: 's1', name: 'Breakfast' }])).toEqual([])
    const bad = { ...scheduleFormFromDetail(detail), windows: [
      { key: 'a', days: [], start: '08:00', end: '09:00' }, { key: 'b', days: [1], start: '10:00', end: '10:00' }, { key: 'c', days: [], start: '11:00', end: '12:00' }] }
    expect(scheduleProblems(bad, []).map((p) => p.message)).toEqual([
      'Pick at least one day for each time window', 'A time window cannot start and end at the same time'])
    expect(scheduleProblems({ ...bad, windows: [] }, [])[0].message).toBe('A schedule needs at least one time window')
    const many = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, days: [1], start: '08:00', end: '09:00' }))
    expect(scheduleProblems({ ...bad, windows: many }, [])[0].message).toBe('Too many time windows (at most 10)')
  })

  it('sends everything for a new schedule', () => {
    const f = setProduct(updateWindow({ ...emptyScheduleForm(), name: ' Late  night ' }, 'w1', { start: '22:00', end: '02:00' }), 'p1', true)
    expect(schedulePayload(f, null)).toEqual({
      id: null, name: 'Late night',
      windows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '22:00', end: '02:00' }], productIds: ['p1'],
    })
  })

  it('for a saved schedule sends the products only when they changed', () => {
    const loaded = scheduleFormFromDetail(detail)
    expect(schedulePayload(updateWindow(loaded, 'w1', { end: '12:00' }), loaded)).toEqual({
      id: 's1', name: 'Breakfast', windows: [{ days: [1, 2, 3, 4, 5], start: '08:00', end: '12:00' }],
    })
    const changed = setProduct(loaded, 'p3', true)
    expect(schedulePayload(changed, loaded)).toMatchObject({ productIds: ['p1', 'p2', 'p3'] })
    expect(scheduleFormDirty(loaded, scheduleFormFromDetail(detail))).toBe(false)
    expect(scheduleFormDirty(changed, loaded)).toBe(true)
  })
})
```

Then, in the tab test:

In `src/features/pos/menu/menuView.test.ts` make exactly these replacements (each old text occurs once):

1. Replace

```ts
    expect(menuTab('/menu/categories')).toBe('categories')
```

   with

```ts
    expect(menuTab('/menu/categories')).toBe('categories')
    expect(menuTab('/menu/schedules')).toBe('schedules')
    expect(menuTab('/menu/schedules/abc')).toBe('schedules')
```


- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/menu/scheduleForm.test.ts src/features/pos/menu/menuView.test.ts` — Expected: FAIL — `Failed to load url ./scheduleForm … Does the file exist?`, and `menuTab('/menu/schedules')` is `products`.

- [ ] **Step 3: The API module and the form.** Create `src/features/pos/menu/slotsApi.ts`:

```ts
// src/features/pos/menu/slotsApi.ts
/** M3's server calls (supabase/migration-2026-10-24-pos-slots-photos-fn.sql): the Schedules
 *  page, the product editor's Time slots and Photo sections and the import's photo targets.
 *  Every read is one RPC returning one JSON value (no 1000-row cap); every write validates
 *  everything and answers in the words the page shows. All of them need Edit menu. */
import { supabase } from '../../../shared/lib/supabase'
import type { SlotWindow } from './timeSlots'

/** menu_schedule_list: every schedule. */
export interface ScheduleSummary {
  id: string
  name: string
  sortOrder: number
  windows: SlotWindow[]
  /** products on sale that follow it (add-on items are not counted) */
  productCount: number
}
/** menu_schedule_detail */
export interface ScheduleDetail { id: string; name: string; windows: SlotWindow[]; productIds: string[] }
/** menu_save_schedule. `productIds` left out = links kept (an existing schedule). */
export interface SchedulePayload {
  id: string | null
  name: string
  windows: SlotWindow[]
  productIds?: string[]
}
/** menu_product_extras: the product editor's Photo and Time slots sections. */
export interface ProductExtras { imagePath: string | null; imageUpdatedAt: string | null; scheduleIds: string[] }
/** menu_photo_targets: what the import's Photos step matches files against. */
export interface PhotoTarget {
  id: string
  name: string
  feedmeProductId: string | null
  imagePath: string | null
  isActive: boolean
  isAddon: boolean
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export const fetchSchedules = () => rpc<ScheduleSummary[]>('menu_schedule_list')
export const fetchScheduleDetail = (id: string) => rpc<ScheduleDetail>('menu_schedule_detail', { p_schedule_id: id })
export const saveSchedule = (p: SchedulePayload) => rpc<string>('menu_save_schedule', { p })
export const reorderSchedules = (ids: string[]) => rpc<null>('menu_reorder_schedules', { p_ids: ids })
/** Feedme's Delete: the schedule, its windows and its product links go. */
export const deleteSchedule = (id: string) => rpc<null>('menu_delete_schedule', { p_id: id })
export const fetchProductExtras = (productId: string) => rpc<ProductExtras>('menu_product_extras', { p_product_id: productId })
export const setProductSchedules = (productId: string, scheduleIds: string[]) =>
  rpc<null>('menu_set_product_schedules', { p_product_id: productId, p_schedule_ids: scheduleIds })
export const fetchPhotoTargets = () => rpc<PhotoTarget[]>('menu_photo_targets')
/** Returns the path it replaced (delete that file), or null. */
export const setProductImage = (productId: string, path: string | null) =>
  rpc<string | null>('menu_set_product_image', { p_product_id: productId, p_path: path })
```

Create `src/features/pos/menu/scheduleForm.ts`:

```ts
// src/features/pos/menu/scheduleForm.ts
/** The schedule editor's form: pure, so every rule is tested. menu_save_schedule checks all
 *  of it again with the same words; this only shows a problem next to its section first. */
import type { ScheduleDetail, SchedulePayload } from './slotsApi'
import { MAX_WINDOWS, windowProblem, type SlotWindow } from './timeSlots'
import { cleanName, nameProblem } from './menuForms'

/** One window row; `key` only tells rows apart on screen. */
export interface WindowForm extends SlotWindow { key: string }
export interface ScheduleForm {
  id: string | null
  name: string
  windows: WindowForm[]
  /** the products that follow it, sorted */
  productIds: string[]
}
export type ScheduleSection = 'details' | 'windows' | 'products'
export interface ScheduleProblem { section: ScheduleSection; message: string }

export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]

const nextKey = (ws: WindowForm[]) => {
  let n = 1
  while (ws.some((w) => w.key === `w${n}`)) n++
  return `w${n}`
}

/** A new schedule: one window every day with its times still to be typed. */
export function emptyScheduleForm(): ScheduleForm {
  return { id: null, name: '', windows: [{ key: 'w1', days: [...ALL_DAYS], start: '', end: '' }], productIds: [] }
}

export function scheduleFormFromDetail(d: ScheduleDetail): ScheduleForm {
  return {
    id: d.id, name: d.name,
    windows: d.windows.map((w, i) => ({ key: `w${i + 1}`, days: [...w.days], start: w.start, end: w.end })),
    productIds: [...d.productIds].sort(),
  }
}

export function addWindow(f: ScheduleForm): ScheduleForm {
  return { ...f, windows: [...f.windows, { key: nextKey(f.windows), days: [...ALL_DAYS], start: '', end: '' }] }
}
export function updateWindow(f: ScheduleForm, key: string, patch: Partial<Pick<WindowForm, 'start' | 'end'>>): ScheduleForm {
  return { ...f, windows: f.windows.map((w) => (w.key === key ? { ...w, ...patch } : w)) }
}
/** Ticks or unticks one day of one window; days stay in Monday-first order. */
export function toggleDay(f: ScheduleForm, key: string, day: number): ScheduleForm {
  return {
    ...f,
    windows: f.windows.map((w) => (w.key !== key ? w : {
      ...w, days: w.days.includes(day) ? w.days.filter((d) => d !== day) : [...w.days, day].sort((a, b) => a - b),
    })),
  }
}
export function removeWindow(f: ScheduleForm, key: string): ScheduleForm {
  return { ...f, windows: f.windows.filter((w) => w.key !== key) }
}
export function setProduct(f: ScheduleForm, productId: string, on: boolean): ScheduleForm {
  const rest = f.productIds.filter((id) => id !== productId)
  return { ...f, productIds: on ? [...rest, productId].sort() : rest }
}

/** Every problem that would stop a save, in section order. `others` are the saved schedules. */
export function scheduleProblems(f: ScheduleForm, others: { id: string; name: string }[]): ScheduleProblem[] {
  const out: ScheduleProblem[] = []
  const add = (section: ScheduleSection, message: string | null) => {
    if (message && !out.some((p) => p.message === message)) out.push({ section, message })
  }
  const name = cleanName(f.name)
  add('details', nameProblem('Schedule', f.name, 60))
  if (name && others.some((o) => o.id !== f.id && o.name.toLowerCase() === name.toLowerCase())) {
    add('details', `A schedule called ${name} already exists`)
  }
  if (f.windows.length === 0) add('windows', 'A schedule needs at least one time window')
  if (f.windows.length > MAX_WINDOWS) add('windows', `Too many time windows (at most ${MAX_WINDOWS})`)
  for (const w of f.windows) add('windows', windowProblem(w))
  return out
}

export function scheduleFormDirty(f: ScheduleForm, loaded: ScheduleForm | null): boolean {
  return loaded === null || JSON.stringify(f) !== JSON.stringify(loaded)
}

/** What menu_save_schedule takes. Windows are always sent whole; for a saved schedule the
 *  product list only when it changed, so a save never undoes a link made meanwhile in a
 *  product's editor. */
export function schedulePayload(f: ScheduleForm, loaded: ScheduleForm | null): SchedulePayload {
  const p: SchedulePayload = {
    id: f.id,
    name: cleanName(f.name),
    windows: f.windows.map((w) => ({ days: [...w.days].sort((a, b) => a - b), start: w.start, end: w.end })),
  }
  const isNew = f.id === null || loaded === null
  if (isNew || f.productIds.join() !== loaded.productIds.join()) p.productIds = [...f.productIds]
  return p
}
```

- [ ] **Step 4: Run the form test.** Run: `npx vitest run src/features/pos/menu/scheduleForm.test.ts` — Expected: PASS, 6 tests.

- [ ] **Step 5: The editor's sections.** Create `src/features/pos/menu/schedule/WindowsSection.tsx`:

```tsx
// src/features/pos/menu/schedule/WindowsSection.tsx
import { DAY_NAMES, MAX_WINDOWS, windowLabel, windowProblem } from '../timeSlots'
import { addWindow, removeWindow, toggleDay, updateWindow, type ScheduleForm } from '../scheduleForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** The schedule's time windows: days of the week and a from–to time each. */
export default function WindowsSection({ form, onChange, problem }: {
  form: ScheduleForm
  onChange: (f: ScheduleForm) => void
  problem: string | null
}) {
  return (
    <Section title="Time windows" problem={problem}
      hint="Malaysia time. Both minutes count: 10:00–23:59 runs to midnight. A window that ends before it starts runs past midnight (22:00–02:00 is Friday night when Friday is ticked).">
      <ul className="space-y-3">
        {form.windows.map((w, i) => (
          <li key={w.key} className="space-y-2 rounded border border-border p-3">
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`Days of window ${i + 1}`}>
              {DAY_NAMES.map((name, k) => {
                const day = k + 1
                const on = w.days.includes(day)
                return (
                  <button key={name} type="button" aria-pressed={on} onClick={() => onChange(toggleDay(form, w.key, day))}
                    className={`rounded px-2 py-1 text-sm ${on ? 'bg-brown-btn text-white' : 'border border-border'}`}>
                    {name}
                  </button>
                )
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1">From
                <input type="time" step={60} className={inputCls} value={w.start} aria-label={`Window ${i + 1} from`}
                  onChange={(e) => onChange(updateWindow(form, w.key, { start: e.target.value }))} />
              </label>
              <label className="flex items-center gap-1">to
                <input type="time" step={60} className={inputCls} value={w.end} aria-label={`Window ${i + 1} to`}
                  onChange={(e) => onChange(updateWindow(form, w.key, { end: e.target.value }))} />
              </label>
              <span className="flex-1 text-xs text-brown-muted">{windowProblem(w) ? '' : windowLabel(w)}</span>
              <button type="button" className={linkBtnCls} disabled={form.windows.length === 1} aria-label={`Remove window ${i + 1}`}
                onClick={() => onChange(removeWindow(form, w.key))}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className={linkBtnCls} disabled={form.windows.length >= MAX_WINDOWS} onClick={() => onChange(addWindow(form))}>
        Add time window
      </button>
    </Section>
  )
}
```

Create `src/features/pos/menu/schedule/ProductsSection.tsx`:

```tsx
// src/features/pos/menu/schedule/ProductsSection.tsx
import { useMemo, useState } from 'react'
import type { MenuProductRow } from '../menuApi'
import { setProduct, type ScheduleForm } from '../scheduleForm'
import { Section, inputCls } from '../editorUi'

/** The products that follow this schedule (Feedme's "Apply product"). Add-on items and
 *  switched-off products are listed only while they are ticked. */
export default function ProductsSection({ form, onChange, products }: {
  form: ScheduleForm
  onChange: (f: ScheduleForm) => void
  products: MenuProductRow[]
}) {
  const [search, setSearch] = useState('')
  const [tickedOnly, setTickedOnly] = useState(false)
  const ticked = useMemo(() => new Set(form.productIds), [form.productIds])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return products
      .filter((p) => ticked.has(p.id) || (p.is_active && !p.is_addon))
      .filter((p) => !tickedOnly || ticked.has(p.id))
      .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.category?.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.category?.sort_order ?? 9999) - (b.category?.sort_order ?? 9999)
        || (a.category?.name ?? '').localeCompare(b.category?.name ?? '') || a.sort_order - b.sort_order || a.name.localeCompare(b.name))
  }, [products, ticked, tickedOnly, search])
  const n = form.productIds.length
  return (
    <Section title="Products"
      hint={`${n} product${n === 1 ? ' follows' : 's follow'} this schedule: outside its windows they are hidden on QR and greyed out at the counter. A product that follows several schedules sells inside any of their windows.`}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <input className={`${inputCls} w-64`} placeholder="Search products or categories" aria-label="Search products"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={tickedOnly} onChange={(e) => setTickedOnly(e.target.checked)} /> Ticked only
        </label>
      </div>
      <ul className="max-h-96 space-y-1 overflow-y-auto text-sm">
        {rows.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ticked.has(p.id)} onChange={(e) => onChange(setProduct(form, p.id, e.target.checked))} />
              <span className="flex-1">{p.name}{p.is_active ? '' : ' (off)'}{p.is_addon ? ' (add-on item)' : ''}</span>
              <span className="text-xs text-brown-muted">{p.category?.name ?? 'Uncategorised'}</span>
            </label>
          </li>
        ))}
        {rows.length === 0 && <li className="text-brown-muted">No products match.</li>}
      </ul>
    </Section>
  )
}
```

- [ ] **Step 6: The pages.** Create `src/features/pos/menu/ScheduleEditorPage.tsx`:

```tsx
// src/features/pos/menu/ScheduleEditorPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchMenu, type MenuProductRow } from './menuApi'
import { fetchScheduleDetail, fetchSchedules, saveSchedule, type ScheduleSummary } from './slotsApi'
import {
  emptyScheduleForm, scheduleFormDirty, scheduleFormFromDetail, schedulePayload, scheduleProblems, type ScheduleForm, type ScheduleSection,
} from './scheduleForm'
import MenuTabs from './MenuTabs'
import WindowsSection from './schedule/WindowsSection'
import ProductsSection from './schedule/ProductsSection'
import { OutcomeLine, Section, btnCls, errorText, inputCls, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'

/** /menu/schedules/new and /menu/schedules/:id — a named schedule (Feedme's Scheduler):
 *  its time windows and the products that follow it, saved at once by menu_save_schedule.
 *  The route remounts this page per schedule (MenuRoutes keys it). */
export default function ScheduleEditorPage({ scheduleId }: { scheduleId: string | null }) {
  const navigate = useNavigate()
  const savedNotice = useSavedNotice()
  const [others, setOthers] = useState<ScheduleSummary[]>([])
  const [products, setProducts] = useState<MenuProductRow[] | null>(null)
  const [form, setForm] = useState<ScheduleForm | null>(null)
  const [loaded, setLoaded] = useState<ScheduleForm | null>(null)    // the form as loaded: a save sends only changes
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)                                    // a second click in the same render is refused too
  const [tried, setTried] = useState(false)                          // problems show after the first Save
  const [outcome, setOutcome] = useState<Outcome | null>(savedNotice ? { kind: 'ok', text: savedNotice } : null)
  const loadSeq = useRef(0)

  /** Loads the schedules (for the twin-name check), the products and this schedule; a reply to an older load is dropped. */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const [list, rows, d] = await Promise.all([
      fetchSchedules(), fetchMenu(), scheduleId ? fetchScheduleDetail(scheduleId) : Promise.resolve(null),
    ])
    if (seq !== loadSeq.current) return
    setOthers(list)
    setProducts(rows)
    const f = d ? scheduleFormFromDetail(d) : emptyScheduleForm()
    setForm(f)
    setLoaded(d ? f : null)
    setLoadError(null)
  }, [scheduleId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  /** Reload after a failure; a "Saved, but reloading failed" notice becomes plain "Saved". */
  const retryLoad = () => {
    load()
      .then(() => setOutcome((o) => (o?.kind === 'error' && o.text.startsWith('Saved, but') ? { kind: 'ok', text: 'Saved' } : o)))
      .catch((e) => setLoadError(errorText(e)))
  }

  const change = (next: ScheduleForm) => { setForm(next); setOutcome(null) }
  const problems = form ? scheduleProblems(form, others) : []
  useUnsavedWarning(!!form && !saving && scheduleFormDirty(form, loaded) && (loaded !== null || form.name.trim() !== ''))
  const problemOf = (s: ScheduleSection) => (tried ? problems.find((p) => p.section === s)?.message ?? null : null)

  const save = async () => {
    if (!form || savingRef.current || loadError) return
    setTried(true)
    if (problems.length > 0) { setOutcome({ kind: 'error', text: 'Not saved — fix the problems marked above.' }); return }
    savingRef.current = true
    setSaving(true)
    setOutcome(null)
    try {
      const id = await saveSchedule(schedulePayload(form, loaded))
      if (!form.id) {
        navigate(`/menu/schedules/${id}`, { replace: true, state: { saved: 'Schedule created' } })
        return
      }
      try {
        await load()
        setTried(false)
        setOutcome({ kind: 'ok', text: 'Saved' })
      } catch (e) {
        // The form on screen is now stale: lock it until a fresh load succeeds.
        setLoadError(errorText(e))
        setOutcome({ kind: 'error', text: 'Saved, but reloading failed — reload before editing again.' })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const set = (patch: Partial<ScheduleForm>) => form && change({ ...form, ...patch })
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{scheduleId ? form?.name || 'Schedule' : 'New schedule'}</h1>
        <Link to="/menu/schedules" className="text-sm underline">Back to schedules</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={saving} onClick={() => retryLoad()}>Try again</button>
        </div>
      )}
      {!form || !products ? (!loadError && <p className="text-sm">Loading…</p>) : (
        <>
          {/* Locked while saving (the reload would overwrite typing) and while the form is stale after a failed reload. */}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <Section title="Schedule" problem={problemOf('details')}
              hint="Like Feedme's Scheduler: one schedule (e.g. Breakfast) can be ticked on many products. Delete it on the Schedules page.">
              <label className="block text-sm">Name
                <input className={`${inputCls} mt-1 w-full`} value={form.name} aria-label="Schedule name"
                  onChange={(e) => set({ name: e.target.value })} />
              </label>
            </Section>
            <WindowsSection form={form} onChange={change} problem={problemOf('windows')} />
            <ProductsSection form={form} onChange={change} products={products} />
          </fieldset>
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-cream py-3">
            <button className={btnCls} disabled={saving || !!loadError} onClick={() => void save()}>
              {saving ? 'Saving…' : form.id ? 'Save schedule' : 'Create schedule'}
            </button>
            <OutcomeLine outcome={outcome} />
          </div>
        </>
      )}
    </div>
  )
}
```

Create `src/features/pos/menu/SchedulesPage.tsx`:

```tsx
// src/features/pos/menu/SchedulesPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { deleteSchedule, fetchSchedules, reorderSchedules, type ScheduleSummary } from './slotsApi'
import { reorderedIds } from './listAdmin'
import { windowLabel } from './timeSlots'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText, linkBtnCls, type Outcome } from './editorUi'

/** /menu/schedules — Feedme's Scheduler: named time slots, each ticked on the products that
 *  follow it. Reorder and delete here (each outcome on its own row — a delete's above the
 *  list — one action at a time); open a schedule to edit its windows and products. Like
 *  Feedme, a schedule has no on/off switch. While the list is not loaded (or a reload after a
 *  save failed) every write is locked: a stale list must never be written. */
export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                                           // a second click in the same render is refused too
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})  // by schedule id; 'deleted' for a delete

  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const list = await fetchSchedules()
      if (seq !== loadSeq.current) return
      setSchedules(list)
      setLoadError(null)
    } catch (e) {
      if (seq !== loadSeq.current) return
      throw e
    }
  }, [])
  /** Try again: a successful reload turns a "Saved, but reloading failed" notice into plain "Saved". */
  const retry = () => load().then(
    () => setOutcomes((o) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
      [k, v.kind === 'error' && v.text.startsWith('Saved, but reloading failed') ? { kind: 'ok' as const, text: 'Saved' } : v]))),
    (e) => setLoadError(errorText(e)),
  )
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const locked = busy || loadError !== null || schedules === null

  const run = async (key: string, action: () => Promise<unknown>, ok: string) => {
    if (busyRef.current || locked) return
    busyRef.current = true
    setBusy(true)
    setOutcomes((o) => { const n = { ...o }; delete n[key]; return n })
    try {
      await action()
      try {
        await load()
        setOutcomes((o) => ({ ...o, [key]: { kind: 'ok', text: ok } }))
      } catch (e) {
        setLoadError(`Saved, but reloading failed: ${errorText(e)}`)       // locks every write until a reload works
        setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: `Saved, but reloading failed: ${errorText(e)}` } }))
      }
    } catch (e) {
      setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: errorText(e) } }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const move = (index: number, delta: number) => {
    const ids = schedules && reorderedIds(schedules, index, delta)
    if (ids) void run(ids[index + delta], () => reorderSchedules(ids), 'Moved')
  }
  /** Feedme's Delete: the schedule, its windows and its product links go (no order refers to them). */
  const remove = (s: ScheduleSummary) => {
    const follow = s.productCount === 0 ? 'No product follows it.'
      : `${s.productCount} product${s.productCount === 1 ? ' follows' : 's follow'} it and then sell${s.productCount === 1 ? 's' : ''} at any time, unless another schedule says otherwise.`
    if (!window.confirm(`Delete ${s.name}? ${follow} This cannot be undone.`)) return
    void run('deleted', () => deleteSchedule(s.id), `Deleted ${s.name}`)
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <p className="text-sm text-brown-muted">
            A product that follows a schedule sells only inside its time windows: hidden on QR and greyed out at the counter
            outside them. A product that follows none sells at any time.
          </p>
        </div>
        <Link to="/menu/schedules/new" className={btnCls}>New schedule</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={busy} onClick={retry}>Try again</button>
        </div>
      )}
      <OutcomeLine outcome={outcomes.deleted ?? null} />
      {schedules === null && !loadError && <p className="text-sm">Loading…</p>}
      {schedules?.length === 0 && <p className="text-sm text-brown-muted">No schedules yet.</p>}
      <ul className="space-y-2">
        {schedules?.map((s, i) => (
          <li key={s.id} className="space-y-2 rounded-xl border border-border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1">
                <Link to={`/menu/schedules/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                <span className="ml-2 text-xs text-brown-muted">{s.productCount} product{s.productCount === 1 ? '' : 's'}</span>
                <span className="block text-xs text-brown-muted">{s.windows.map(windowLabel).join('; ')}</span>
              </span>
              <button className={linkBtnCls} disabled={locked || i === 0} aria-label={`Move ${s.name} up`} onClick={() => move(i, -1)}>↑</button>
              <button className={linkBtnCls} disabled={locked || i === schedules.length - 1} aria-label={`Move ${s.name} down`}
                onClick={() => move(i, 1)}>↓</button>
              <button className={linkBtnCls} disabled={locked} aria-label={`Delete ${s.name}`} onClick={() => remove(s)}>Delete</button>
            </div>
            <OutcomeLine outcome={outcomes[s.id] ?? null} />
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 7: The tab and the routes.** In `src/features/pos/menu/menuView.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```ts
export type MenuTab = 'products' | 'catalogs' | 'groups' | 'categories' | 'import'
```

   with

```ts
export type MenuTab = 'products' | 'catalogs' | 'groups' | 'categories' | 'schedules' | 'import'
```

2. Replace

```ts
  { id: 'categories', label: 'Categories', to: '/menu/categories' },
]
```

   with

```ts
  { id: 'categories', label: 'Categories', to: '/menu/categories' },
  { id: 'schedules', label: 'Schedules', to: '/menu/schedules' },
]
```

3. Replace

```ts
  if (rest.startsWith('categories')) return 'categories'
```

   with

```ts
  if (rest.startsWith('categories')) return 'categories'
  if (rest.startsWith('schedules')) return 'schedules'
```


In `src/features/pos/menu/MenuRoutes.tsx` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```tsx
import CategoriesPage from './CategoriesPage'
```

   with

```tsx
import CategoriesPage from './CategoriesPage'
import SchedulesPage from './SchedulesPage'
import ScheduleEditorPage from './ScheduleEditorPage'
```

2. Replace

```tsx
function GroupEditorRoute() {
```

   with

```tsx
function ScheduleEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <ScheduleEditorPage key={id ?? 'new'} scheduleId={id ?? null} />
}

function GroupEditorRoute() {
```

3. Replace

```tsx
      <Route path="categories" element={<CategoriesPage />} />
```

   with

```tsx
      <Route path="categories" element={<CategoriesPage />} />
      <Route path="schedules" element={<SchedulesPage />} />
      <Route path="schedules/new" element={<ScheduleEditorRoute />} />
      <Route path="schedules/:id" element={<ScheduleEditorRoute />} />
```


- [ ] **Step 8: Run the gates.** Run: `npx vitest run src/features/pos/menu/menuView.test.ts` — Expected: PASS. Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 93 files, 820 tests pass. Run: `grep -c "path=" src/features/pos/menu/MenuRoutes.tsx` — Expected: `13` (plus the index route).

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/menu/slotsApi.ts src/features/pos/menu/scheduleForm.ts src/features/pos/menu/scheduleForm.test.ts src/features/pos/menu/schedule src/features/pos/menu/ScheduleEditorPage.tsx src/features/pos/menu/SchedulesPage.tsx src/features/pos/menu/menuView.ts src/features/pos/menu/menuView.test.ts src/features/pos/menu/MenuRoutes.tsx
git commit -m "feat(pos-menu): schedules page — named time slots with windows and applied products; delete like Feedme

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10 (controller, craft-os-dev — browser on the dev server and the SQL editor; the implementer does not touch the database):** test login → **Menu**. M2's `[TEST]` products were switched off at its end, so first make two with the product editor: **New product** `[TEST] Big Breakfast` and `[TEST] Night Soup` (any food category, **Craft Cafe → Counter + QR**, RM 20 and RM 12) → each "Product created". The tabs end with **Schedules** → "No schedules yet." **New schedule** → press **Create schedule** at once → under Schedule "Schedule name is required", under Time windows "Enter each time as HH:MM, e.g. 08:00", next to the button "Not saved — fix the problems marked above."; nothing is created. Name `[TEST] Breakfast`; window 1: untick Sat and Sun, from `08:00` to `11:30` → the line reads "Mon–Fri · 08:00–11:30". **Add time window**: tick only Fri and Sat, `22:00` to `02:00` → "Fri, Sat · 22:00–02:00 (next day)". Products: search `[TEST] Big` and tick `[TEST] Big Breakfast` → "1 product follows this schedule". **Create schedule** → URL `/menu/schedules/<id>`, "Schedule created". SQL: `select s.name, w.days, w.start_time, w.end_time from menu_schedules s join menu_schedule_windows w on w.schedule_id = s.id where s.name = '[TEST] Breakfast' order by w.sort_order` → `{1,2,3,4,5} 08:00:00 11:30:00` and `{5,6} 22:00:00 02:00:00`. Set the second window's to-time to `22:00` → Save → "A time window cannot start and end at the same time" under Time windows; set it back. Create a second schedule `[test] breakfast` → "A schedule called [test] breakfast already exists". Rename it `[TEST] Closed now`, with no products and one Daily window that ended an hour ago (e.g. at 15:00: `13:00`–`14:00`) → **Create schedule** (Tasks 5, 7 and 8 use it). **Schedules** → two rows; `[TEST] Breakfast` shows both windows and "1 product"; **↓/↑** move a row with "Moved" on it, and the order stays after a reload. **Delete:** create `[TEST] Throwaway` (any window, no products) → **Delete** on its row → the confirm reads "Delete [TEST] Throwaway? No product follows it. This cannot be undone." → OK → "Deleted [TEST] Throwaway" above the list, the row is gone; SQL `select count(*) from menu_schedules where name = '[TEST] Throwaway'` → `0`. **Delete** on `[TEST] Breakfast` → the confirm says "1 product follows it and then sells at any time, unless another schedule says otherwise." → **Cancel** (nothing changes). Keep both `[TEST]` schedules for Tasks 5–8.

---

### Task 5: The product editor's Time slots section

**Files:**
- Create: `src/features/pos/menu/product/TimeSlotsSection.tsx`
- Modify: `src/features/pos/menu/ProductEditorPage.tsx`

**Interfaces:**
- Consumes: Task 4's `fetchSchedules`, `fetchProductExtras`, `setProductSchedules`; Task 1's `windowLabel`.
- Produces: the section between **Add-on groups** and **Catalogs** of a saved product. It loads and saves on its own (`menu_set_product_schedules`), shows its outcome in itself, warns before the tab is left with unticked changes, and locks on a failed (re)load with **Try again**. A new product shows "Create the product first, then pick its time slots."

- [ ] **Step 1: The section.** Create `src/features/pos/menu/product/TimeSlotsSection.tsx`:

```tsx
// src/features/pos/menu/product/TimeSlotsSection.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchProductExtras, fetchSchedules, setProductSchedules, type ScheduleSummary } from '../slotsApi'
import { windowLabel } from '../timeSlots'
import { OutcomeLine, Section, btnCls, errorText, useUnsavedWarning, type Outcome } from '../editorUi'

const MAX_SCHEDULES = 20

/** Which schedules a saved product follows (Feedme's Scheduler, ticked from the product's
 *  side). Saved on its own by menu_set_product_schedules, with its outcome here. */
export default function TimeSlotsSection({ productId }: { productId: string }) {
  const [schedules, setSchedules] = useState<ScheduleSummary[] | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const [loaded, setLoaded] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)                                  // a second click in the same render is refused too
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current                                  // a reply to an older load is dropped
    const [list, extras] = await Promise.all([fetchSchedules(), fetchProductExtras(productId)])
    if (seq !== loadSeq.current) return
    setSchedules(list)
    setTicked([...extras.scheduleIds].sort())
    setLoaded([...extras.scheduleIds].sort())
    setLoadError(null)
  }, [productId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const dirty = ticked.join() !== loaded.join()
  useUnsavedWarning(dirty && !saving)
  const tick = (id: string, on: boolean) => {
    setTicked((t) => (on ? [...t.filter((x) => x !== id), id].sort() : t.filter((x) => x !== id)))
    setOutcome(null)
  }

  const save = async () => {
    if (savingRef.current || loadError || !dirty) return
    if (ticked.length > MAX_SCHEDULES) { setOutcome({ kind: 'error', text: `Too many schedules (at most ${MAX_SCHEDULES})` }); return }
    savingRef.current = true
    setSaving(true)
    setOutcome(null)
    try {
      await setProductSchedules(productId, ticked)
      try {
        await load()
        setOutcome({ kind: 'ok', text: 'Time slots saved' })
      } catch (e) {
        setLoadError(errorText(e))                                 // locks the ticks until a reload works
        setOutcome({ kind: 'error', text: 'Saved, but reloading failed — try again before changing more.' })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const shown = schedules ?? []
  return (
    <Section title="Time slots"
      hint="Tick the schedules this product follows: it sells only inside their windows (hidden on QR, greyed out at the counter outside them). None ticked = sold at any time.">
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={saving} onClick={() => { load().catch((e) => setLoadError(errorText(e))) }}>Try again</button>
        </div>
      )}
      {schedules === null && !loadError && <p className="text-sm">Loading…</p>}
      {schedules !== null && shown.length === 0 && (
        <p className="text-sm text-brown-muted">No schedules yet — <Link to="/menu/schedules/new" className="underline">create one</Link>.</p>
      )}
      <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-1 border-0 p-0">
        {shown.map((s) => (
          <label key={s.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={ticked.includes(s.id)} onChange={(e) => tick(s.id, e.target.checked)} />
            <span>
              <Link to={`/menu/schedules/${s.id}`} className="hover:underline">{s.name}</Link>
              <span className="block text-xs text-brown-muted">{s.windows.map(windowLabel).join('; ')}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnCls} disabled={saving || !!loadError || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save time slots'}
        </button>
        <OutcomeLine outcome={outcome} />
      </div>
    </Section>
  )
}
```

- [ ] **Step 2: Place it in the editor.** In `src/features/pos/menu/ProductEditorPage.tsx` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```tsx
import CatalogsSection from './product/CatalogsSection'
```

   with

```tsx
import CatalogsSection from './product/CatalogsSection'
import TimeSlotsSection from './product/TimeSlotsSection'
```

2. Replace

```tsx
          {/* Sections top to bottom. M3 adds "Time slots" after Add-on groups and "Photo" after Details. */}
          {/* Locked while saving (the reload would overwrite typing) and while the form is stale after a failed reload. */}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <DetailsSection form={form} onChange={change} categories={lookups.categories} problem={problemOf('details')} />
            <VariantsSection form={form} onChange={change} problem={problemOf('variants')} />
            <GroupsSection form={form} onChange={change} groups={lookups.groups} problem={problemOf('groups')} />
            <CatalogsSection form={form} onChange={change} catalogs={lookups.catalogs} problem={problemOf('catalogs')} />
          </fieldset>
```

   with

```tsx
          {/* Sections top to bottom. Time slots (M3) saves on its own, so it sits outside the
              fieldset and appears once the product exists. */}
          {/* Locked while saving (the reload would overwrite typing) and while the form is stale after a failed reload. */}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <DetailsSection form={form} onChange={change} categories={lookups.categories} problem={problemOf('details')} />
            <VariantsSection form={form} onChange={change} problem={problemOf('variants')} />
            <GroupsSection form={form} onChange={change} groups={lookups.groups} problem={problemOf('groups')} />
          </fieldset>
          {form.id
            ? <TimeSlotsSection productId={form.id} />
            : <p className="text-sm text-brown-muted">Create the product first, then pick its time slots.</p>}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <CatalogsSection form={form} onChange={change} catalogs={lookups.catalogs} problem={problemOf('catalogs')} />
          </fieldset>
```


- [ ] **Step 3: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 93 files, 820 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/features/pos/menu/product/TimeSlotsSection.tsx src/features/pos/menu/ProductEditorPage.tsx
git commit -m "feat(pos-menu): product editor time slots — tick the schedules a product follows, saved on their own

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5 (controller, craft-os-dev — browser on the dev server (two tabs) and the SQL editor; the implementer does not touch the database):** open `[TEST] Big Breakfast` → **Time slots** lists `[TEST] Breakfast` ticked with its two windows. **New product** → the section says "Create the product first, then pick its time slots." **The server refuses outside the slot** (the pad greys out only from Task 7): `[TEST] Closed now` (Task 4) has no products and a window that ended an hour ago — open `[TEST] Night Soup` → **Time slots** → tick `[TEST] Closed now` → **Save time slots** → "Time slots saved"; SQL `select count(*) from product_schedules ps join menu_products p on p.id = ps.product_id where p.name = '[TEST] Night Soup'` → `1`. `/pos` (Demo) → a table → add that product → **Send order** → "Rejected: [TEST] Night Soup is not available at this time — fix the order and send again". **Offline orders are judged by the server's clock:** set its window to include now (e.g. `13:00`–`23:59`) → Save; tab A `/pos` → DevTools → Network → **Offline** → queue an order with the product (it waits in the queue); tab B (online) → the schedule → set the window back to `13:00`–`14:00` → Save; tab A → **No throttling** → the queue sends it → the Rejected strip shows "Rejected: [TEST] Night Soup is not available at this time · …". **Edit** it from the strip, remove the soup, send → it goes in. Tick a box in Time slots and try to close the tab → the browser asks first; untick it again.

---

### Task 6: Product photos — rules, upload, the editor's Photo section

**Files:**
- Create: `src/features/pos/menu/photo.ts`, `src/features/pos/menu/photo.test.ts`, `src/features/pos/menu/photoResize.ts`, `src/features/pos/menu/photoUpload.ts`, `src/features/pos/menu/photoUpload.test.ts`, `src/features/pos/menu/product/PhotoSection.tsx`
- Modify: `src/features/pos/menu/ProductEditorPage.tsx`, `src/features/pos/menu/productForm.ts` (comment only)

**Interfaces:**
- Consumes: Task 4's `setProductImage`, `fetchProductExtras`; the `menu-images` bucket and policies (Task 2).
- Produces: `photo.ts` (`PHOTO_BUCKET`, `PHOTO_MAX_WIDTH = 800`, `PHOTO_MAX_HEIGHT = 1600`, `PHOTO_QUALITY = 0.8`, `PHOTO_MAX_INPUT_BYTES`, `PhotoMime`, `imageTypeFromName`, `photoInputProblem`, `resizeTarget`, `photoPath`), `photoResize.ts` (`resizePhoto`, the canvas work, kept apart so the upload logic can be tested) and `photoUpload.ts` (`publicPhotoUrl`, `uploadProductPhoto(productId, blob) → { warning }`, `removeProductPhoto(productId) → { warning }`), used again by Task 9; the **Photo** section right after Details.
- The upload's failure rule (Spec deltas): when pointing the product at the new file fails, the product is read again and the new file is deleted only when the product certainly does not point at it; when it does, the result is a warning; when it cannot be read, nothing is deleted and the error is passed on.

- [ ] **Step 1: Write the failing tests.** Create `src/features/pos/menu/photo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  PHOTO_MAX_HEIGHT, PHOTO_MAX_INPUT_BYTES, PHOTO_MAX_WIDTH, PHOTO_QUALITY, imageTypeFromName, photoInputProblem, photoPath, resizeTarget,
} from './photo'

describe('photo rules', () => {
  it('uses the spec parameters: 800 px wide, quality 0.8, input under 10 MB', () => {
    expect(PHOTO_MAX_WIDTH).toBe(800)
    expect(PHOTO_MAX_HEIGHT).toBe(1600)
    expect(PHOTO_QUALITY).toBe(0.8)
    expect(PHOTO_MAX_INPUT_BYTES).toBe(10 * 1024 * 1024)
  })
  it('accepts an image under 10 MB only', () => {
    expect(photoInputProblem({ type: 'image/jpeg', size: 2_000_000 })).toBeNull()
    expect(photoInputProblem({ type: 'image/png', size: PHOTO_MAX_INPUT_BYTES - 1 })).toBeNull()
    expect(photoInputProblem({ type: 'image/png', size: PHOTO_MAX_INPUT_BYTES })).toBe('The photo is too large (at most 10 MB)')
    expect(photoInputProblem({ type: 'application/pdf', size: 10 })).toBe('Choose an image file (JPEG, PNG, WebP or HEIC)')
    expect(photoInputProblem({ type: '', size: 10 })).toBe('Choose an image file (JPEG, PNG, WebP or HEIC)')
    expect(photoInputProblem({ type: 'image/webp', size: 0 })).toBe('The photo file is empty')
  })
  it('scales down to 800 px wide (and 1600 px high) in proportion, never up', () => {
    expect(resizeTarget(800, 6000)).toEqual({ width: 213, height: 1600 })
    expect(resizeTarget(3000, 9000)).toEqual({ width: 533, height: 1600 })
    expect(resizeTarget(4032, 3024)).toEqual({ width: 800, height: 600 })
    expect(resizeTarget(1000, 1500)).toEqual({ width: 800, height: 1200 })
    expect(resizeTarget(1601, 3)).toEqual({ width: 800, height: 1 })
    expect(resizeTarget(640, 480)).toEqual({ width: 640, height: 480 })
    expect(resizeTarget(800, 800)).toEqual({ width: 800, height: 800 })
  })
  it('stores under products/<product id>/ with a random name', () => {
    const id = '3f2c1e9a-1111-4222-8333-944455566677'
    expect(photoPath(id, 'image/webp', 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff'))
      .toBe(`products/${id}/a1b2c3d4e5f647118899aabbccddeeff.webp`)
    expect(photoPath(id, 'image/jpeg', 'abcdefgh')).toBe(`products/${id}/abcdefgh.jpg`)
    expect(() => photoPath(id, 'image/jpeg', 'abc')).toThrow('A photo name needs at least 8 letters or digits')
  })
  it('reads the image type from a file name', () => {
    expect(imageTypeFromName('8812.JPG')).toBe('image/jpeg')
    expect(imageTypeFromName('8812.jpeg')).toBe('image/jpeg')
    expect(imageTypeFromName('8812.png')).toBe('image/png')
    expect(imageTypeFromName('8812.webp')).toBe('image/webp')
    expect(imageTypeFromName('notes.txt')).toBe('')
    expect(imageTypeFromName('8812')).toBe('')
  })
})
```

Create `src/features/pos/menu/photoUpload.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The storage bucket, the two RPCs and the canvas are stand-ins: what is tested is the order of
// the steps and what is kept or deleted when one of them fails.
const bucket = { upload: vi.fn(), remove: vi.fn(), getPublicUrl: vi.fn() }
vi.mock('../../../shared/lib/supabase', () => ({ supabase: { storage: { from: () => bucket } } }))
const api = { setProductImage: vi.fn(), fetchProductExtras: vi.fn() }
vi.mock('./slotsApi', () => ({
  setProductImage: (...a: unknown[]) => api.setProductImage(...a),
  fetchProductExtras: (...a: unknown[]) => api.fetchProductExtras(...a),
}))
vi.mock('./photoResize', () => ({ resizePhoto: async () => ({ blob: new Blob(['w'], { type: 'image/webp' }), mime: 'image/webp' }) }))

import { removeProductPhoto, uploadProductPhoto } from './photoUpload'

const PID = '3f2c1e9a-1111-4222-8333-944455566677'
const file = new Blob(['jpeg bytes'], { type: 'image/jpeg' })
const newPath = () => bucket.upload.mock.calls[0][0] as string

beforeEach(() => {
  vi.clearAllMocks()
  bucket.upload.mockResolvedValue({ error: null })
  bucket.remove.mockResolvedValue({ error: null })
})

describe('uploadProductPhoto', () => {
  it('uploads a new file, points the product at it, then deletes the old one', async () => {
    api.setProductImage.mockResolvedValue(`products/${PID}/oldfile1.webp`)
    expect(await uploadProductPhoto(PID, file)).toEqual({ warning: null })
    expect(newPath()).toMatch(new RegExp(`^products/${PID}/[0-9a-f]{32}\\.webp$`))
    expect(api.setProductImage).toHaveBeenCalledWith(PID, newPath())
    expect(bucket.remove).toHaveBeenCalledWith([`products/${PID}/oldfile1.webp`])
  })

  it('refuses a file that is not an image before uploading anything', async () => {
    await expect(uploadProductPhoto(PID, new Blob(['%PDF'], { type: 'application/pdf' }))).rejects.toThrow('Choose an image file')
    expect(bucket.upload).not.toHaveBeenCalled()
  })

  it('pointing failed and the product does not point at the new file: the new file is deleted', async () => {
    api.setProductImage.mockRejectedValue(new Error('Product not found — refresh and try again'))
    api.fetchProductExtras.mockResolvedValue({ imagePath: `products/${PID}/oldfile1.webp`, imageUpdatedAt: null, scheduleIds: [] })
    await expect(uploadProductPhoto(PID, file)).rejects.toThrow('Product not found')
    expect(bucket.remove).toHaveBeenCalledWith([newPath()])
  })

  it('the answer was lost but the product points at the new file: kept, with a warning', async () => {
    api.setProductImage.mockRejectedValue(new Error('Failed to fetch'))
    api.fetchProductExtras.mockImplementation(async () => ({ imagePath: newPath(), imageUpdatedAt: 'now', scheduleIds: [] }))
    expect(await uploadProductPhoto(PID, file)).toEqual({ warning: 'Photo saved, but the old file could not be identified for deletion' })
    expect(bucket.remove).not.toHaveBeenCalled()
  })

  it('pointing failed and the product cannot be read again: nothing is deleted', async () => {
    api.setProductImage.mockRejectedValue(new Error('Failed to fetch'))
    api.fetchProductExtras.mockRejectedValue(new Error('Failed to fetch'))
    await expect(uploadProductPhoto(PID, file)).rejects.toThrow('Failed to fetch')
    expect(bucket.remove).not.toHaveBeenCalled()
  })

  it('the old file cannot be deleted: the photo is saved, with a warning', async () => {
    api.setProductImage.mockResolvedValue(`products/${PID}/oldfile1.webp`)
    bucket.remove.mockResolvedValue({ error: { message: 'timeout' } })
    expect(await uploadProductPhoto(PID, file)).toEqual({ warning: 'Photo saved, but the old file could not be deleted: timeout' })
  })
})

describe('removeProductPhoto', () => {
  it('takes the photo off the product, then deletes its file', async () => {
    api.setProductImage.mockResolvedValue(`products/${PID}/oldfile1.webp`)
    expect(await removeProductPhoto(PID)).toEqual({ warning: null })
    expect(api.setProductImage).toHaveBeenCalledWith(PID, null)
    expect(bucket.remove).toHaveBeenCalledWith([`products/${PID}/oldfile1.webp`])
  })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/menu/photo.test.ts src/features/pos/menu/photoUpload.test.ts` — Expected: FAIL — `photo.test.ts` cannot load `./photo` (Vite reports `EISDIR: illegal operation on a directory, read ./photo`, because the repo has a top-level `photo/` folder), and `Failed to load url ./photoUpload … Does the file exist?`.

- [ ] **Step 3: The rules.** Create `src/features/pos/menu/photo.ts`:

```ts
// src/features/pos/menu/photo.ts
/** Product photo rules (spec §5), pure so they are tested: what may be picked, how big it is
 *  drawn, where it is stored. photoUpload.ts does the browser work with them. */

export const PHOTO_BUCKET = 'menu-images'
export const PHOTO_MAX_WIDTH = 800
/** a very tall picture is capped too: it would pass the bucket's 2 MB and Safari's canvas limit */
export const PHOTO_MAX_HEIGHT = 1600
export const PHOTO_QUALITY = 0.8
export const PHOTO_MAX_INPUT_BYTES = 10 * 1024 * 1024
export type PhotoMime = 'image/webp' | 'image/jpeg'

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp',
}

/** The image type a file name says ("123.JPG" → image/jpeg); '' when it is not an image name. */
export function imageTypeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return name.includes('.') ? TYPES[ext] ?? '' : ''
}

/** Why a picked file cannot become a product photo, or null. */
export function photoInputProblem(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith('image/')) return 'Choose an image file (JPEG, PNG, WebP or HEIC)'
  if (file.size >= PHOTO_MAX_INPUT_BYTES) return 'The photo is too large (at most 10 MB)'
  if (file.size === 0) return 'The photo file is empty'
  return null
}

/** At most 800 px wide and 1600 px high, in proportion; a smaller picture keeps its size. */
export function resizeTarget(
  width: number, height: number, maxWidth = PHOTO_MAX_WIDTH, maxHeight = PHOTO_MAX_HEIGHT,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  if (scale === 1) return { width, height }
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** products/<product id>/<random>.webp|.jpg — the only paths menu_set_product_image accepts. */
export function photoPath(productId: string, mime: PhotoMime, random: string): string {
  const name = random.replace(/[^A-Za-z0-9]/g, '').slice(0, 64)
  if (name.length < 8) throw new Error('A photo name needs at least 8 letters or digits')
  return `products/${productId}/${name}.${mime === 'image/webp' ? 'webp' : 'jpg'}`
}
```

- [ ] **Step 4: Run the rules' test.** Run: `npx vitest run src/features/pos/menu/photo.test.ts` — Expected: PASS, 5 tests.

- [ ] **Step 5: Resize, upload, replace, remove.** Create `src/features/pos/menu/photoResize.ts`:

```ts
// src/features/pos/menu/photoResize.ts
/** The canvas work of a product photo (browser only, so it is kept apart from the upload
 *  logic, which photoUpload.test.ts tests with this module mocked). */
import { PHOTO_QUALITY, resizeTarget, type PhotoMime } from './photo'

/** Draws the image at most 800 × 1600 px on white, the right way up (EXIF orientation), and
 *  encodes it: WebP where the browser can, else JPEG (Safari's canvas cannot make WebP), both at
 *  quality 0.8. */
export async function resizePhoto(file: Blob): Promise<{ blob: Blob; mime: PhotoMime }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This image could not be read — try a JPEG or PNG')
  }
  try {
    const size = resizeTarget(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('This browser cannot resize photos')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.drawImage(bitmap, 0, 0, size.width, size.height)
    const encode = (type: PhotoMime) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, PHOTO_QUALITY))
    for (const mime of ['image/webp', 'image/jpeg'] as const) {
      const blob = await encode(mime)
      if (blob && blob.type === mime) return { blob, mime }
    }
    throw new Error('This browser cannot make a JPEG or WebP photo')
  } finally {
    bitmap.close()
  }
}
```

Create `src/features/pos/menu/photoUpload.ts`:

```ts
// src/features/pos/menu/photoUpload.ts
/** The browser side of product photos: resize, upload, point the product at the new file,
 *  delete the old one (spec §5). Used by the product editor's Photo section and the
 *  import's Photos step. The rules themselves are in photo.ts, the canvas work in photoResize.ts. */
import { supabase } from '../../../shared/lib/supabase'
import { fetchProductExtras, setProductImage } from './slotsApi'
import { PHOTO_BUCKET, photoInputProblem, photoPath } from './photo'
import { resizePhoto } from './photoResize'

export const publicPhotoUrl = (path: string): string => supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl

/** Resizes and uploads a new file, points the product at it, then deletes the file it replaced.
 *  Returns a warning when only that last clean-up failed (the photo itself is saved).
 *  If pointing the product at the new file seems to fail, the answer may just have been lost:
 *  the product is read again, and the new file is deleted only when the product certainly does
 *  not point at it — a file left unused is harmless, a product pointing at a deleted file is not. */
export async function uploadProductPhoto(productId: string, file: Blob): Promise<{ warning: string | null }> {
  const problem = photoInputProblem(file)
  if (problem) throw new Error(problem)
  const { blob, mime } = await resizePhoto(file)
  const path = photoPath(productId, mime, crypto.randomUUID())
  const bucket = supabase.storage.from(PHOTO_BUCKET)
  const up = await bucket.upload(path, blob, { contentType: mime, cacheControl: '31536000', upsert: false })
  if (up.error) throw new Error(`Upload failed: ${up.error.message}`)
  let old: string | null
  try {
    old = await setProductImage(productId, path)
  } catch (e) {
    let now: string | null | undefined                            // undefined = could not be read again
    try { now = (await fetchProductExtras(productId)).imagePath } catch { now = undefined }
    if (now === path) return { warning: 'Photo saved, but the old file could not be identified for deletion' }
    if (now !== undefined) await bucket.remove([path])           // the product keeps its old photo; the new file goes
    throw e
  }
  if (!old) return { warning: null }
  const rm = await bucket.remove([old])
  return { warning: rm.error ? `Photo saved, but the old file could not be deleted: ${rm.error.message}` : null }
}

/** Takes the photo off the product, then deletes its file. */
export async function removeProductPhoto(productId: string): Promise<{ warning: string | null }> {
  const old = await setProductImage(productId, null)
  if (!old) return { warning: null }
  const rm = await supabase.storage.from(PHOTO_BUCKET).remove([old])
  return { warning: rm.error ? `Photo removed, but its file could not be deleted: ${rm.error.message}` : null }
}
```

- [ ] **Step 6: Run the upload's test.** Run: `npx vitest run src/features/pos/menu/photoUpload.test.ts` — Expected: PASS, 7 tests.

- [ ] **Step 7: The section.** Create `src/features/pos/menu/product/PhotoSection.tsx`:

```tsx
// src/features/pos/menu/product/PhotoSection.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchProductExtras } from '../slotsApi'
import { publicPhotoUrl, removeProductPhoto, uploadProductPhoto } from '../photoUpload'
import { OutcomeLine, Section, errorText, linkBtnCls, type Outcome } from '../editorUi'

/** The product's photo, shown on the QR menu (the counter keeps text tiles). A new photo is
 *  resized in the browser, uploaded, and then replaces the old one, whose file is deleted.
 *  Saved on its own, with its outcome here. */
export default function PhotoSection({ productId, productName }: { productId: string; productName: string }) {
  const [path, setPath] = useState<string | null | undefined>(undefined)       // undefined = not loaded
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)                         // what is running, for the button
  const busyRef = useRef(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const extras = await fetchProductExtras(productId)
    if (seq !== loadSeq.current) return
    setPath(extras.imagePath)
    setLoadError(null)
  }, [productId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const run = async (label: string, action: () => Promise<{ warning: string | null }>, ok: string) => {
    if (busyRef.current || loadError) return
    busyRef.current = true
    setBusy(label)
    setOutcome(null)
    try {
      const { warning } = await action()
      try {
        await load()
        setOutcome(warning ? { kind: 'error', text: warning } : { kind: 'ok', text: ok })
      } catch (e) {
        setLoadError(errorText(e))
        setOutcome({ kind: 'error', text: 'Saved, but reloading failed — try again before changing more.' })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const pick = (file: File | undefined) => {
    if (file) void run('Uploading…', () => uploadProductPhoto(productId, file), 'Photo saved')
  }
  const remove = () => {
    if (window.confirm(`Remove the photo of ${productName}? The QR menu then shows it without a photo.`)) {
      void run('Removing…', () => removeProductPhoto(productId), 'Photo removed')
    }
  }

  const locked = busy !== null || !!loadError || path === undefined
  return (
    <Section title="Photo" hint="Shown on the QR menu. Any image under 10 MB; it is resized to 800 px wide before it is uploaded.">
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={busy !== null} onClick={() => { load().catch((e) => setLoadError(errorText(e))) }}>Try again</button>
        </div>
      )}
      <div className="flex flex-wrap items-start gap-4">
        {path
          ? <img src={publicPhotoUrl(path)} alt={productName} className="h-40 w-40 rounded-lg border border-border object-cover" />
          : <div className="flex h-40 w-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-brown-muted">
              {path === undefined && !loadError ? 'Loading…' : 'No photo'}
            </div>}
        <div className="space-y-2 text-sm">
          <label className={`${linkBtnCls} inline-block cursor-pointer ${locked ? 'pointer-events-none opacity-40' : ''}`}>
            {busy ?? (path ? 'Replace photo…' : 'Choose photo…')}
            <input type="file" accept="image/*" className="sr-only" disabled={locked} aria-label={`Photo of ${productName}`}
              onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          {path && <button type="button" className={`${linkBtnCls} block`} disabled={locked} onClick={remove}>Remove photo</button>}
        </div>
      </div>
      <OutcomeLine outcome={outcome} />
    </Section>
  )
}
```

In `src/features/pos/menu/ProductEditorPage.tsx` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```tsx
import CatalogsSection from './product/CatalogsSection'
```

   with

```tsx
import CatalogsSection from './product/CatalogsSection'
import PhotoSection from './product/PhotoSection'
```

2. Replace

```tsx
          {/* Sections top to bottom. Time slots (M3) saves on its own, so it sits outside the
              fieldset and appears once the product exists. */}
          {/* Locked while saving (the reload would overwrite typing) and while the form is stale after a failed reload. */}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <DetailsSection form={form} onChange={change} categories={lookups.categories} problem={problemOf('details')} />
            <VariantsSection form={form} onChange={change} problem={problemOf('variants')} />
            <GroupsSection form={form} onChange={change} groups={lookups.groups} problem={problemOf('groups')} />
          </fieldset>
          {form.id
            ? <TimeSlotsSection productId={form.id} />
            : <p className="text-sm text-brown-muted">Create the product first, then pick its time slots.</p>}
```

   with

```tsx
          {/* Sections top to bottom. Photo and Time slots (M3) save on their own, so they sit
              outside the fieldset and appear once the product exists. */}
          {/* Locked while saving (the reload would overwrite typing) and while the form is stale after a failed reload. */}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <DetailsSection form={form} onChange={change} categories={lookups.categories} problem={problemOf('details')} />
          </fieldset>
          {form.id
            ? <PhotoSection productId={form.id} productName={form.name} />
            : <p className="text-sm text-brown-muted">Create the product first, then add its photo and time slots.</p>}
          <fieldset disabled={saving || !!loadError} className="m-0 min-w-0 space-y-4 border-0 p-0">
            <VariantsSection form={form} onChange={change} problem={problemOf('variants')} />
            <GroupsSection form={form} onChange={change} groups={lookups.groups} problem={problemOf('groups')} />
          </fieldset>
          {form.id && <TimeSlotsSection productId={form.id} />}
```


In `src/features/pos/menu/productForm.ts` make exactly these replacements (each old text occurs once):

1. Replace

```ts
/** The editor's sections, top to bottom. M3 adds 'slots' and 'photo' here. */
```

   with

```ts
/** The sections this form saves. Photo and Time slots (M3) save on their own (product/PhotoSection.tsx, product/TimeSlotsSection.tsx). */
```


- [ ] **Step 8: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 95 files, 832 tests pass. Run: `wc -l src/features/pos/menu/ProductEditorPage.tsx src/features/pos/menu/product/*.tsx | sort -n | tail -3` — Expected: no file over ~250 lines (the page is 136).

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/menu/photo.ts src/features/pos/menu/photo.test.ts src/features/pos/menu/photoResize.ts src/features/pos/menu/photoUpload.ts src/features/pos/menu/photoUpload.test.ts src/features/pos/menu/product/PhotoSection.tsx src/features/pos/menu/ProductEditorPage.tsx src/features/pos/menu/productForm.ts
git commit -m "feat(pos-menu): product photos — resized in the browser, menu-images bucket, replace deletes the old file only when safe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10 (controller, craft-os-dev — browser on the dev server (Chrome, then Safari if at hand) and the SQL editor; the implementer does not touch the database):** open `[TEST] Night Soup` → **Photo** shows "No photo". **Choose photo…** → a phone photo (3–5 MB JPEG) → "Uploading…" → "Photo saved" and the picture. SQL: `select image_path, image_updated_at from menu_products where name = '[TEST] Night Soup'` → `products/<product id>/<32 hex>.webp` in Chrome; `select name, (metadata->>'size')::int as bytes, metadata->>'mimetype' as type from storage.objects where bucket_id = 'menu-images'` → that file, well under 300 000 bytes, `image/webp`. Open the public URL (right-click the image → open in new tab) → 800 px wide. **Replace photo…** → another image → "Photo saved"; the SQL now shows the new path and only one object for the product (the old file is gone). In Safari (if at hand) replace again → the path ends `.jpg`, type `image/jpeg`. A very tall picture (a long phone screenshot) → its public URL is at most 1600 px high. A phone photo taken upright → shows upright. Choose a PDF → "Choose an image file (JPEG, PNG, WebP or HEIC)"; choose an image over 10 MB → "The photo is too large (at most 10 MB)"; nothing uploaded. **Remove photo** → confirm → "Photo removed" → `image_path` is null and the product has no object left. Upload one again for Task 8. If Task 3's verify printed `SKIP I…` notices: sign in as a manager without Edit menu, open DevTools Console on `/pos` and run `await (await import('/src/shared/lib/supabase.ts')).supabase.storage.from('menu-images').upload('products/x/verifytest1.webp', new Blob(['x'], { type: 'image/webp' }))` → an error mentioning row-level security.

---

### Task 7: The counter greys out products outside their slots

**Files:**
- Create: `src/features/pos/order/padSlots.ts`, `src/features/pos/order/padSlots.test.ts`, `src/features/pos/order/useMinuteClock.ts`, `src/features/pos/order/usePadWindows.ts`, `src/features/pos/order/usePadWindows.test.tsx`, `src/features/pos/order/ProductTiles.tsx`
- Modify: `src/features/pos/order/posApi.ts`, `src/features/pos/order/OrderPad.tsx`

**Interfaces:**
- Consumes: Task 1 (`slotLabel`, `notAvailableNow`), Task 2's `pos_menu_windows`.
- Produces: `fetchMenuWindows(catalogId) → MenuWindows`; `usePadWindows(catalogId) → { windows, now }`, which reads the windows when the catalog changes and again at the start of every minute (a failed read keeps the last windows of that catalog; another catalog's are never shown); the pad re-checks every tile each minute by the server's clock ("Available 08:00–11:30" / "Not available now", `aria-disabled`), ignores taps on such tiles outside sold-out mode, and refuses to send a line outside its slot with the server's words, using the freshest windows. `OrderPad.tsx` stays at 250 lines because the tiles move to `ProductTiles.tsx` and the reading to the hook; its own `load()` is unchanged.

- [ ] **Step 1: Write the failing tests.** Create `src/features/pos/order/padSlots.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { NO_WINDOWS, menuWindows, serverNow, slotProblem, tileSlotLabel } from './padSlots'

const json = {
  now: '2026-10-26T01:00:00.000Z',                                         // Mon 09:00 in Malaysia
  windows: [
    { productId: 'pancake', days: [1, 2, 3, 4, 5], start: '08:00', end: '11:30' },
    { productId: 'soup', days: [1, 2, 3, 4, 5], start: '11:00', end: '14:00' },
    { productId: 'soup', days: [1, 2, 3, 4, 5], start: '18:00', end: '21:00' },
  ],
}

describe('padSlots', () => {
  it('groups windows by product and measures the clock offset', () => {
    const w = menuWindows(json, Date.parse('2026-10-26T00:58:00.000Z'))   // this iPad is 2 minutes slow
    expect(w.offsetMs).toBe(120_000)
    expect(w.byProduct.get('soup')).toHaveLength(2)
    expect(w.byProduct.has('latte')).toBe(false)
    expect(serverNow(w, Date.parse('2026-10-26T00:58:00.000Z')).toISOString()).toBe('2026-10-26T01:00:00.000Z')
    expect(menuWindows({ now: 'nonsense', windows: [] }, 5).offsetMs).toBe(0)
  })

  it('labels a tile by the server time: on sale, the next window today, or not now', () => {
    const w = menuWindows(json, Date.parse(json.now))
    const at = (hm: string) => new Date(`2026-10-26T${hm}:00+08:00`)
    expect(tileSlotLabel(w, 'pancake', at('09:00'))).toBeNull()
    expect(tileSlotLabel(w, 'latte', at('03:00'))).toBeNull()                // no schedule: always on sale
    expect(tileSlotLabel(w, 'soup', at('09:00'))).toBe('Available 11:00–14:00')
    expect(tileSlotLabel(w, 'soup', at('15:00'))).toBe('Available 18:00–21:00')
    expect(tileSlotLabel(w, 'pancake', at('12:00'))).toBe('Not available now')
    expect(tileSlotLabel(NO_WINDOWS, 'pancake', at('12:00'))).toBeNull()
  })

  it('names the first cart line outside its slots in the server words', () => {
    const w = menuWindows(json, Date.parse(json.now))
    const names: Record<string, string> = { pancake: 'Pancake', soup: 'Soup', latte: 'Latte' }
    const lines = [{ productId: 'latte' }, { productId: 'soup' }, { productId: 'pancake' }]
    expect(slotProblem(w, lines, (id) => names[id], new Date('2026-10-26T09:00:00+08:00'))).toBe('Soup is not available at this time')
    expect(slotProblem(w, lines, (id) => names[id], new Date('2026-10-26T11:15:00+08:00'))).toBeNull()
  })
})
```

Create `src/features/pos/order/usePadWindows.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const fetchMenuWindows = vi.fn()
vi.mock('./posApi', () => ({ fetchMenuWindows: (id: string) => fetchMenuWindows(id) }))

import { usePadWindows } from './usePadWindows'
import { menuWindows } from './padSlots'

const json = (start: string) => ({
  now: '2026-10-26T01:00:00.000Z',
  windows: [{ productId: 'soup', days: [1, 2, 3, 4, 5, 6, 7], start, end: '23:00' }],
})
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T01:00:10.000Z'))
  fetchMenuWindows.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('usePadWindows', () => {
  it('reads the windows again every minute, so a schedule edit reaches an open pad', async () => {
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('11:00'), Date.now()))
    const { result } = renderHook(() => usePadWindows('cat-a'))
    await flush()
    expect(result.current.windows.byProduct.get('soup')?.[0].start).toBe('11:00')
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('09:00'), Date.now()))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(fetchMenuWindows).toHaveBeenCalledTimes(2)
    expect(result.current.windows.byProduct.get('soup')?.[0].start).toBe('09:00')
  })

  it('keeps the last windows when a read fails', async () => {
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('11:00'), Date.now()))
    const { result } = renderHook(() => usePadWindows('cat-a'))
    await flush()
    fetchMenuWindows.mockRejectedValueOnce(new Error('Failed to fetch'))
    await act(async () => { vi.advanceTimersByTime(60_000) })
    await flush()
    expect(result.current.windows.byProduct.get('soup')?.[0].start).toBe('11:00')
  })

  it('never shows another catalog\'s windows, and none without a catalog', async () => {
    fetchMenuWindows.mockResolvedValueOnce(menuWindows(json('11:00'), Date.now()))
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => usePadWindows(id), { initialProps: { id: 'cat-a' as string | null } })
    await flush()
    fetchMenuWindows.mockReturnValueOnce(new Promise(() => {}))          // cat-b's reply never comes
    rerender({ id: 'cat-b' })
    expect(result.current.windows.byProduct.size).toBe(0)
    rerender({ id: null })
    expect(result.current.windows.byProduct.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/order/padSlots.test.ts src/features/pos/order/usePadWindows.test.tsx` — Expected: FAIL, `Failed to load url ./padSlots … Does the file exist?` and `Failed to resolve import "./usePadWindows"`.

- [ ] **Step 3: Implement.** Create `src/features/pos/order/padSlots.ts`:

```ts
// src/features/pos/order/padSlots.ts
/** The order pad's time slots (spec §3): which products are outside their slots right now,
 *  by the server's clock. Pure; the time maths is ../menu/timeSlots.ts. */
import { notAvailableNow, slotLabel, type SlotWindow } from '../menu/timeSlots'

/** What pos_menu_windows returns. */
export interface MenuWindowsJson { now: string; windows: (SlotWindow & { productId: string })[] }
/** Windows by product (a product with none sells at any time) and how far the server's clock
 *  is ahead of this iPad's. */
export interface MenuWindows { offsetMs: number; byProduct: Map<string, SlotWindow[]> }

export const NO_WINDOWS: MenuWindows = { offsetMs: 0, byProduct: new Map() }

/** pos_menu_windows, read at `receivedAt` (this iPad's Date.now()). */
export function menuWindows(json: MenuWindowsJson, receivedAt: number): MenuWindows {
  const byProduct = new Map<string, SlotWindow[]>()
  for (const w of json.windows) {
    byProduct.set(w.productId, [...(byProduct.get(w.productId) ?? []), { days: w.days, start: w.start, end: w.end }])
  }
  const server = Date.parse(json.now)
  return { offsetMs: Number.isFinite(server) ? server - receivedAt : 0, byProduct }
}

/** The server's time, from this iPad's clock and the offset measured at the last read. */
export const serverNow = (w: MenuWindows, deviceNow: number): Date => new Date(deviceNow + w.offsetMs)

/** A tile's words while the product is outside its slots ("Available 08:00–11:30"); null = on sale. */
export const tileSlotLabel = (w: MenuWindows, productId: string, at: Date): string | null =>
  slotLabel(w.byProduct.get(productId) ?? [], at)

/** pos_insert_order's words for the first cart line outside its slots at `at`, or null. */
export function slotProblem(w: MenuWindows, lines: { productId: string }[], nameOf: (productId: string) => string, at: Date): string | null {
  const late = lines.find((l) => tileSlotLabel(w, l.productId, at) !== null)
  return late ? notAvailableNow(nameOf(late.productId)) : null
}
```

Create `src/features/pos/order/useMinuteClock.ts`:

```ts
// src/features/pos/order/useMinuteClock.ts
import { useEffect, useState } from 'react'

/** This iPad's Date.now(), refreshed just after the start of every minute: time slots open
 *  and close on the minute, so the pad re-evaluates them once a minute while it is open. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const untilNextMinute = () => 60_000 - (Date.now() % 60_000) + 50
    let timer = setTimeout(function tick() {
      setNow(Date.now())
      timer = setTimeout(tick, untilNextMinute())
    }, untilNextMinute())
    return () => clearTimeout(timer)
  }, [])
  return now
}
```

Create `src/features/pos/order/usePadWindows.ts`:

```ts
// src/features/pos/order/usePadWindows.ts
import { useEffect, useRef, useState } from 'react'
import { fetchMenuWindows } from './posApi'
import { NO_WINDOWS, serverNow, type MenuWindows } from './padSlots'
import { useMinuteClock } from './useMinuteClock'

/** The order pad's time slots: pos_menu_windows for the pad's catalog, read again at the start
 *  of every minute so a schedule edit reaches an open pad within a minute. A failed read keeps
 *  the last windows of this catalog (none at first) and the next minute tries again — the
 *  server refuses anything out of its slot anyway. `now` is the server's time at that minute. */
export function usePadWindows(catalogId: string | null): { windows: MenuWindows; now: Date } {
  const tick = useMinuteClock()
  const [held, setHeld] = useState<{ catalogId: string; windows: MenuWindows } | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    const mine = ++seq.current                                   // a slow reply never overwrites a newer one
    if (!catalogId) return
    fetchMenuWindows(catalogId).then(
      (windows) => { if (mine === seq.current) setHeld({ catalogId, windows }) },
      () => { /* keep the last windows; the next minute tries again */ },
    )
  }, [catalogId, tick])
  // never another catalog's windows
  const windows = held && held.catalogId === catalogId ? held.windows : NO_WINDOWS
  return { windows, now: serverNow(windows, tick) }
}
```

Create `src/features/pos/order/ProductTiles.tsx`:

```tsx
// src/features/pos/order/ProductTiles.tsx
import { formatSen, type PosProduct } from './cart'
import { tileSlotLabel, type MenuWindows } from './padSlots'

/** The pad's product tiles. A sold-out product, or one outside its time slots at `now` (the
 *  server's time, moved on every minute by usePadWindows), is greyed out and says why; tapping
 *  it only works in sold-out mode (the pad decides). */
export default function ProductTiles({ products, windows, now, onTap }: {
  products: PosProduct[]
  windows: MenuWindows
  now: Date
  onTap: (p: PosProduct, outOfSlot: boolean) => void
}) {
  return (
    <>
      {products.map((p) => {
        const slot = tileSlotLabel(windows, p.id, now)
        const look = p.soldOut ? 'border-red-300 bg-red-50 text-red-700'
          : slot ? 'border-border bg-cream text-brown-faint' : 'border-border bg-card'
        return (
          <button key={p.id} onClick={() => onTap(p, slot !== null)} aria-disabled={slot !== null}
            className={`min-h-20 rounded-xl border p-2 text-left text-sm ${look}`}>
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-brown-muted">{p.variants.length > 1 ? `${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))} –` : formatSen(p.variants[0].priceSen)}{p.soldOut && ' · SOLD OUT'}</div>
            {slot && <div className="text-xs">{slot}</div>}
          </button>
        )
      })}
    </>
  )
}
```

In `src/features/pos/order/posApi.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```ts
import type { BranchCatalogRow, BranchCatalogSettings, BranchCatalogs, CatalogRow } from './catalogs'
```

   with

```ts
import type { BranchCatalogRow, BranchCatalogSettings, BranchCatalogs, CatalogRow } from './catalogs'
import { menuWindows, type MenuWindows, type MenuWindowsJson } from './padSlots'
```

2. Replace

```ts
/** Every catalog (for names) and this branch's assignments. */
```

   with

```ts
/** The time slots of one catalog's products, with the server's clock (pos_menu_windows):
 *  the pad greys out a product outside its slots by the server's time. */
export async function fetchMenuWindows(catalogId: string): Promise<MenuWindows> {
  const { data, error } = await supabase.rpc('pos_menu_windows', { p_catalog_id: catalogId })
  if (error) fail(error)
  return menuWindows(data as MenuWindowsJson, Date.now())
}

/** Every catalog (for names) and this branch's assignments. */
```


In `src/features/pos/order/OrderPad.tsx` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```tsx
import LineSheet from './LineSheet'
```

   with

```tsx
import LineSheet from './LineSheet'
import ProductTiles from './ProductTiles'
import { serverNow, slotProblem } from './padSlots'
import { usePadWindows } from './usePadWindows'
```

2. Replace

```tsx
  const catalogIdRef = useRef(catalogId)
  useEffect(() => { catalogIdRef.current = catalogId }, [catalogId])
```

   with

```tsx
  const catalogIdRef = useRef(catalogId)
  useEffect(() => { catalogIdRef.current = catalogId }, [catalogId])
  const slots = usePadWindows(catalogId)                    // M3: time slots, re-read every minute
```

3. Replace

```tsx
  const tap = async (p: PosProduct) => {
    if (soldOutMode) {
      try { await setSoldOut(branchId, p.id, !p.soldOut); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
      return
    }
    if (p.soldOut) return
```

   with

```tsx
  const tap = async (p: PosProduct, outOfSlot: boolean) => {
    if (soldOutMode) {
      try { await setSoldOut(branchId, p.id, !p.soldOut); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
      return
    }
    if (p.soldOut || outOfSlot) return
```

4. Replace

```tsx
      if (problem) { setError(problem); return }
    }
```

   with

```tsx
      if (problem) { setError(problem); return }
    }
    const late = slotProblem(slots.windows, lines, (id) => findProduct(menu, id)?.name ?? 'An item', serverNow(slots.windows, Date.now()))
    if (late) { setError(late); return }                     // the server would refuse it with the same words
```

5. Replace

```tsx
          {products.map((p) => (
            <button key={p.id} onClick={() => void tap(p)}
              className={`min-h-20 rounded-xl border p-2 text-left text-sm ${p.soldOut ? 'border-red-300 bg-red-50 text-red-700' : 'border-border bg-card'}`}>
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-brown-muted">{p.variants.length > 1 ? `${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))} –` : formatSen(p.variants[0].priceSen)}{p.soldOut && ' · SOLD OUT'}</div>
            </button>
          ))}
```

   with

```tsx
          <ProductTiles products={products} windows={slots.windows} now={slots.now} onTap={(p, outOfSlot) => void tap(p, outOfSlot)} />
```


- [ ] **Step 4: Run the gates.** Run: `npx vitest run src/features/pos/order/padSlots.test.ts src/features/pos/order/usePadWindows.test.tsx` — Expected: PASS, 3 + 3 tests. Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 97 files, 838 tests pass. Run: `wc -l src/features/pos/order/OrderPad.tsx` — Expected: `250`.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/order/padSlots.ts src/features/pos/order/padSlots.test.ts src/features/pos/order/useMinuteClock.ts src/features/pos/order/usePadWindows.ts src/features/pos/order/usePadWindows.test.tsx src/features/pos/order/ProductTiles.tsx src/features/pos/order/posApi.ts src/features/pos/order/OrderPad.tsx
git commit -m "feat(pos-order): counter greys out products outside their time slots, re-read every minute, by the server clock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (controller, craft-os-dev — browser on the dev server; the implementer does not touch the database):** `/pos` → a table → `[TEST] Night Soup` (it follows `[TEST] Closed now`, Task 5) is greyed with "Available 13:00–14:00" before 13:00 or "Not available now" after 14:00; tapping it adds nothing; **Sold out…** mode still toggles it. DevTools → Network: opening the pad sends `rpc/pos_menu_rows` and `rpc/pos_menu_windows` once each, then `rpc/pos_menu_windows` once a minute while it stays open. **The minute re-check:** in the schedule editor (second tab) set the window to start at the next whole minute (e.g. at 16:41:20 set `16:42`–`23:59`) → Save → back on the pad, without reloading, within a minute of 16:42 the tile turns normal and can be added. Set the window to end at the current minute → the tile greys out within a minute; **Send order** with that line still in the cart → "[TEST] Night Soup is not available at this time" (the pad's own check). `[TEST] Big Breakfast` is greyed outside Mon–Fri 08:00–11:30 and Fri/Sat 22:00–02:00. A product without schedules is never greyed.

---

### Task 8: QR — photos, and the menu re-read every minute

**Files:**
- Modify: `src/features/pos/order/cart.ts`, `src/features/pos/order/cart.test.ts`, `src/qr/qrState.ts`, `src/qr/qrState.test.ts`, `src/qr/QrApp.tsx`

**Interfaces:**
- Consumes: Task 2's `qr_menu` (`imagePath`, products outside their slots left out).
- Produces: `PosProduct.imageUrl?`, `QrMenuJson` products' `imagePath?`, `posMenuFromQr(json, photoUrl?)`; `leftTheMenu(lines, next, before)`, `leftTheMenuNotice(names)`. The QR page shows a 64 px photo on each product that has one, re-reads `qr_menu` every minute while it is in view and at once when it comes back into view (never while an order is being sent), closes a product sheet whose product left, and takes products that left the menu out of the cart with a notice. The counter (`buildPosMenu`) and `LineSheet` are unchanged.

- [ ] **Step 1: Write the failing tests.** In `src/features/pos/order/cart.test.ts` make exactly these replacements (each old text occurs once):

1. Replace

```ts
    expect(defaultLine(p).optionIds).toEqual(['o'])
  })
})
```

   with

```ts
    expect(defaultLine(p).optionIds).toEqual(['o'])
  })

  it('turns a photo path into its public URL, and no path into none', () => {
    const product = (imagePath: string | null) => ({ id: 'p', name: 'Tea', description: null, soldOut: false, imagePath,
      variants: [{ id: 'v', name: 'HOT', priceSen: 1000, isBase: true }], groups: [] })
    const json = { tableLabel: 'T1', paused: false, needsPax: false,
      categories: [{ name: 'TEA', products: [product('products/p/abc12345.webp'), { ...product(null), id: 'q' }] }] }
    const m = posMenuFromQr(json, (path) => `https://cdn.test/${path}`)
    expect(m.categories[0].products.map((p) => p.imageUrl)).toEqual(['https://cdn.test/products/p/abc12345.webp', null])
    expect(posMenuFromQr(json).categories[0].products[0].imageUrl).toBeNull()
  })
})
```


In `src/qr/qrState.test.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```ts
import { tokenFromLocation, addLine, replaceLine, removeLine } from './qrState'
```

   with

```ts
import { tokenFromLocation, addLine, replaceLine, removeLine, leftTheMenu, leftTheMenuNotice } from './qrState'
import type { PosMenu } from '../features/pos/order/cart'
```

2. Replace

```ts
    expect(two).toHaveLength(2)
  })
})
```

   with

```ts
    expect(two).toHaveLength(2)
  })
})

describe('the minute refresh', () => {
  const product = (id: string, name: string) => ({ id, name, description: null, soldOut: false, variants: [], groups: [] })
  const before: PosMenu = { categories: [{ name: 'FOOD', products: [product('a', 'Pancake'), product('b', 'Latte'), product('c', 'Soup')] }] }
  const after: PosMenu = { categories: [{ name: 'FOOD', products: [product('b', 'Latte')] }] }
  const line = (productId: string) => ({ productId, variantId: 'v', qty: 1, note: null, optionIds: [] })
  it('names each product of the cart that left the menu once, from the menu before', () => {
    expect(leftTheMenu([line('a'), line('b'), line('a'), line('c')], after, before)).toEqual(['Pancake', 'Soup'])
    expect(leftTheMenu([line('b')], after, before)).toEqual([])
  })
  it('says so in plain words', () => {
    expect(leftTheMenuNotice(['Pancake'])).toBe('Pancake is not available at this time and was taken out of your order.')
    expect(leftTheMenuNotice(['Pancake', 'Soup'])).toBe('Pancake, Soup are not available at this time and were taken out of your order.')
    expect(leftTheMenuNotice([])).toBeNull()
  })
})
```


- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/order/cart.test.ts src/qr/qrState.test.ts` — Expected: FAIL — `imageUrl` is `undefined`, and `leftTheMenu is not a function`.

- [ ] **Step 3: Implement.** In `src/features/pos/order/cart.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```ts
  variants: PosVariant[]
  groups: PosGroup[]
}
export interface PosCategory
```

   with

```ts
  variants: PosVariant[]
  groups: PosGroup[]
  /** QR only (M3): the photo's public URL; the counter keeps text tiles */
  imageUrl?: string | null
}
export interface PosCategory
```

2. Replace

```ts
      id: string; name: string; description: string | null; soldOut: boolean
      variants:
```

   with

```ts
      id: string; name: string; description: string | null; soldOut: boolean
      /** M3: a path in the menu-images bucket, or null */
      imagePath?: string | null
      variants:
```

3. Replace

```ts
export function posMenuFromQr(json: QrMenuJson): PosMenu {
```

   with

```ts
/** `photoUrl` turns a photo path into its public URL (the QR page's storage client). */
export function posMenuFromQr(json: QrMenuJson, photoUrl?: (path: string) => string): PosMenu {
```

4. Replace

```ts
        id: p.id, name: p.name.trim(), description: p.description, soldOut: p.soldOut,
```

   with

```ts
        id: p.id, name: p.name.trim(), description: p.description, soldOut: p.soldOut,
        imageUrl: p.imagePath && photoUrl ? photoUrl(p.imagePath) : null,
```


In `src/qr/qrState.ts` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```ts
import type { OrderLine } from '../features/pos/order/cart'
```

   with

```ts
import { findProduct, type OrderLine, type PosMenu } from '../features/pos/order/cart'
```

2. Replace

```ts
export const removeLine = (lines: OrderLine[], i: number): OrderLine[] => lines.filter((_, k) => k !== i)
```

   with

```ts
export const removeLine = (lines: OrderLine[], i: number): OrderLine[] => lines.filter((_, k) => k !== i)

/** After the menu was read again (every minute): the names of the products in the cart that
 *  left it — outside their time slot now, switched off — once each, from the menu before. */
export function leftTheMenu(lines: OrderLine[], next: PosMenu, before: PosMenu): string[] {
  const gone = lines.filter((l) => !findProduct(next, l.productId)).map((l) => findProduct(before, l.productId)?.name ?? 'An item')
  return [...new Set(gone)]
}

/** The words the QR page shows for them. */
export function leftTheMenuNotice(names: string[]): string | null {
  if (names.length === 0) return null
  return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not available at this time and ${names.length === 1 ? 'was' : 'were'} taken out of your order.`
}
```


In `src/qr/QrApp.tsx` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```tsx
import { tokenFromLocation, addLine, replaceLine, removeLine } from './qrState'
```

   with

```tsx
import { tokenFromLocation, addLine, replaceLine, removeLine, leftTheMenu, leftTheMenuNotice } from './qrState'
```

2. Replace

```tsx
type Screen = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ready'; info: QrMenuJson; menu: PosMenu }
```

   with

```tsx
type Screen = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ready'; info: QrMenuJson; menu: PosMenu }

/** M3: a photo path in the public menu-images bucket → its URL (no request is made). */
const photoUrl = (path: string) => qrClient.storage.from('menu-images').getPublicUrl(path).data.publicUrl
const REFRESH_MS = 60_000
```

3. Replace

```tsx
  const [placed, setPlaced] = useState(false)
```

   with

```tsx
  const [placed, setPlaced] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
```

4. Replace

```tsx
  const pending = useRef<{ id: string; key: string } | null>(null)   // one client_order_id per distinct cart
```

   with

```tsx
  const pending = useRef<{ id: string; key: string } | null>(null)   // one client_order_id per distinct cart
  // M3: the minute refresh reads these, not a stale closure
  const linesRef = useRef(lines)
  useEffect(() => { linesRef.current = lines }, [lines])
  const menuRef = useRef<PosMenu | null>(null)
  useEffect(() => { menuRef.current = screen.kind === 'ready' ? screen.menu : null }, [screen])
```

5. Replace

```tsx
      setScreen({ kind: 'ready', info, menu: posMenuFromQr(info) })
```

   with

```tsx
      setScreen({ kind: 'ready', info, menu: posMenuFromQr(info, photoUrl) })
```

6. Replace

```tsx
  useEffect(() => { loadMenu() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps
```

   with

```tsx
  useEffect(() => { loadMenu() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // M3: read the menu again every minute while the page is in view, and when it comes back into
  // view, quietly: products whose time slot ends leave the menu (and the cart, with a notice; an
  // open product sheet for one closes), products whose slot starts appear. A failed read keeps the
  // menu on screen; nothing changes while an order is being sent; the server refuses anything out
  // of its slot anyway.
  const ready = screen.kind === 'ready'
  useEffect(() => {
    if (!ready || !token) return
    const refresh = () => {
      if (document.visibilityState !== 'visible' || sendingRef.current) return
      qrClient.rpc('qr_menu', { p_token: token }).then(({ data, error }) => {
        if (error || !data || !menuRef.current || sendingRef.current) return
        const info = data as QrMenuJson
        const menu = posMenuFromQr(info, photoUrl)
        const gone = leftTheMenu(linesRef.current, menu, menuRef.current)
        setScreen({ kind: 'ready', info, menu })
        setCategory((c) => (c && info.categories.some((x) => x.name === c) ? c : info.categories[0]?.name ?? null))
        setSheet((s) => (s && findProduct(menu, s.product.id) ? s : null))
        if (gone.length > 0) {
          setLines((ls) => ls.filter((l) => findProduct(menu, l.productId)))
          setNotice(leftTheMenuNotice(gone))
        }
      }, () => { /* offline for a moment: try again next minute */ })
    }
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [ready, token])
```

7. Replace

```tsx
        {error && <p className="my-1 text-red-700">{error}</p>}
```

   with

```tsx
        {notice && <p role="status" className="my-1 rounded bg-amber-50 p-2 text-amber-900">{notice}</p>}
        {error && <p className="my-1 text-red-700">{error}</p>}
```

8. Replace

```tsx
          <button key={p.id} disabled={p.soldOut} onClick={() => setSheet({ product: p, index: null })}
            className="flex w-full items-start justify-between rounded-xl border border-border bg-card p-3 text-left disabled:opacity-50">
            <div>
```

   with

```tsx
          <button key={p.id} disabled={p.soldOut} onClick={() => setSheet({ product: p, index: null })}
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left disabled:opacity-50">
            {p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
            <div className="flex-1">
```

9. Replace

```tsx
          onDone={(line) => { setLines(sheet.index === null ? addLine(lines, line) : replaceLine(lines, sheet.index, line)); setSheet(null); setPlaced(false) }} />
```

   with

```tsx
          onDone={(line) => { setLines(sheet.index === null ? addLine(lines, line) : replaceLine(lines, sheet.index, line)); setSheet(null); setPlaced(false); setNotice(null) }} />
```


- [ ] **Step 4: Run the gates.** Run: `npx vitest run src/features/pos/order/cart.test.ts src/qr/qrState.test.ts` — Expected: PASS, 15 + 4 tests. Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 97 files, 841 tests pass. Run: `wc -l src/qr/QrApp.tsx src/features/pos/order/cart.ts` — Expected: about 214 and 238.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/order/cart.ts src/features/pos/order/cart.test.ts src/qr/qrState.ts src/qr/qrState.test.ts src/qr/QrApp.tsx
git commit -m "feat(pos-qr): product photos on the QR menu; the menu is re-read every minute so time slots open and close

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (controller, craft-os-dev — a phone (or a narrow second tab) on a table's QR page, and the editor; the implementer does not touch the database):** open a Demo table's QR page → `[TEST] Night Soup` is **not listed** while `[TEST] Closed now` is closed, and `[TEST] Big Breakfast` only inside its windows. In the schedule editor set its window to start at the next whole minute → Save → within a minute of it `[TEST] Night Soup` appears on the QR page without a reload, **with its photo** (Task 6) — products without a photo show text only; add it to the cart; set the window to end at the current minute → within a minute the product leaves the page and the amber notice in the cart panel (above **Place order**) says "[TEST] Night Soup is not available at this time and was taken out of your order." Open the soup's sheet just before its window ends and wait → the sheet closes when the soup leaves the menu. Turn the phone's network off for two minutes → the menu stays on screen; back on → it refreshes again. DevTools on the tab: one `rpc/qr_menu` per minute while the tab is visible, none while it is in the background, and one at once when you switch back to it.

---

### Task 9: `/menu/import` — the Photos step

**Files:**
- Create: `src/features/pos/menu/photoImport.ts`, `src/features/pos/menu/photoImport.test.ts`, `src/features/pos/menu/PhotoImportSection.tsx`
- Modify: `src/features/pos/menu/MenuImportPage.tsx`

**Interfaces:**
- Consumes: Task 4's `fetchPhotoTargets`; Task 6's `imageTypeFromName`, `uploadProductPhoto`; `fflate`'s `unzipSync`.
- Produces: `readPhotoZip(zip) → { photos: ZipPhoto[], skipped }` (unpacks only image files under 10 MB; the rest is listed as skipped), `planPhotoImport(photos, targets, skipExisting) → { toUpload, keptExisting, unmatched, duplicates }`, `withoutPhoto(targets)`; a **Photos from Feedme** section at the bottom of `/menu/import`: pick a zip → preview (to upload / skipped / matching no product / second photos / not images) → **Upload N photos** one at a time with progress and **Stop** → the report (uploaded, not uploaded with reasons, warnings, files that matched no product, products on sale still without a photo). Leaving the page while it uploads asks first.

- [ ] **Step 1: Write the failing test.** Create `src/features/pos/menu/photoImport.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { planPhotoImport, readPhotoZip, withoutPhoto } from './photoImport'
import type { PhotoTarget } from './slotsApi'

const target = (id: string, feedmeProductId: string | null, over: Partial<PhotoTarget> = {}): PhotoTarget =>
  ({ id, name: `Product ${id}`, feedmeProductId, imagePath: null, isActive: true, isAddon: false, ...over })
const zip = zipSync({
  'photos/FM-1.jpg': strToU8('a'),
  'photos/FM-2.PNG': strToU8('b'),
  'photos/FM-9.webp': strToU8('c'),
  'photos/notes.txt': strToU8('d'),
  'photos/.DS_Store': strToU8('e'),
  '__MACOSX/photos/._FM-1.jpg': strToU8('f'),
  'FM-1.jpeg': strToU8('g'),
  'photos/': new Uint8Array(0),
  'photos/FM-7.jpg': new Uint8Array(10 * 1024 * 1024),
})

describe('readPhotoZip', () => {
  it('reads every image wherever it sits, keyed by its name without the extension', () => {
    const { photos, skipped } = readPhotoZip(zip)
    expect(photos.map((p) => [p.fileName, p.key, p.type])).toEqual([
      ['FM-1.jpeg', 'FM-1', 'image/jpeg'], ['FM-1.jpg', 'FM-1', 'image/jpeg'],
      ['FM-2.PNG', 'FM-2', 'image/png'], ['FM-9.webp', 'FM-9', 'image/webp'],
    ])
    expect(skipped).toEqual(['FM-7.jpg (10 MB or more)', 'notes.txt'])
  })
  it('refuses a file that is not a zip', () => {
    expect(() => readPhotoZip(strToU8('not a zip'))).toThrow()
  })
})

describe('planPhotoImport', () => {
  const { photos } = readPhotoZip(zip)
  const targets = [target('a', 'FM-1'), target('b', ' FM-2 ', { imagePath: 'products/b/x1234567.webp' }), target('c', null), target('d', 'FM-4')]
  it('matches by Feedme product ID, first file wins, lists the rest', () => {
    const plan = planPhotoImport(photos, targets, true)
    expect(plan.toUpload.map((m) => [m.photo.fileName, m.product.id])).toEqual([['FM-1.jpeg', 'a']])
    expect(plan.keptExisting.map((m) => m.product.id)).toEqual(['b'])
    expect(plan.duplicates).toEqual(['FM-1.jpg'])
    expect(plan.unmatched).toEqual(['FM-9.webp'])
  })
  it('replaces existing photos when skip is off', () => {
    const plan = planPhotoImport(photos, targets, false)
    expect(plan.toUpload.map((m) => m.product.id)).toEqual(['a', 'b'])
    expect(plan.keptExisting).toEqual([])
  })
  it('lists products on sale that still have no photo', () => {
    const all = [...targets, target('e', 'FM-5', { isAddon: true }), target('f', 'FM-6', { isActive: false })]
    expect(withoutPhoto(all).map((t) => t.id)).toEqual(['a', 'c', 'd'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/menu/photoImport.test.ts` — Expected: FAIL, `Failed to load url ./photoImport … Does the file exist?`.

- [ ] **Step 3: Implement.** Create `src/features/pos/menu/photoImport.ts`:

```ts
// src/features/pos/menu/photoImport.ts
/** The import's Photos step (spec §5), pure so it is tested: read a zip of
 *  <feedme_product_id>.<ext> files and match each file to a product by its Feedme product ID. */
import { unzipSync } from 'fflate'
import type { PhotoTarget } from './slotsApi'
import { PHOTO_MAX_INPUT_BYTES, imageTypeFromName } from './photo'

/** One image file of the zip; `key` is its name without the extension (the Feedme product ID). */
export interface ZipPhoto { fileName: string; key: string; type: string; bytes: Uint8Array }

/** The image files of a zip, wherever they sit in it. Folders and macOS extras (__MACOSX/, ._*,
 *  .DS_Store) are left out silently; files that are not images, or are 10 MB or more, are listed
 *  as skipped and never unpacked (only the photos are held in memory). */
export function readPhotoZip(zip: Uint8Array): { photos: ZipPhoto[]; skipped: string[] } {
  const photos: ZipPhoto[] = []
  const skipped: string[] = []
  const baseOf = (path: string) => path.split('/').pop() ?? ''
  const entries = unzipSync(zip, {
    filter: (f) => {
      const base = baseOf(f.name)
      if (f.name.endsWith('/') || f.name.startsWith('__MACOSX/') || base.startsWith('.') || base === '') return false
      if (!imageTypeFromName(base)) { skipped.push(base); return false }
      if (f.originalSize >= PHOTO_MAX_INPUT_BYTES) { skipped.push(`${base} (10 MB or more)`); return false }
      return true
    },
  })
  for (const [path, bytes] of Object.entries(entries)) {
    const base = baseOf(path)
    photos.push({ fileName: base, key: base.slice(0, base.lastIndexOf('.')).trim(), type: imageTypeFromName(base), bytes })
  }
  photos.sort((a, b) => a.fileName.localeCompare(b.fileName))
  return { photos, skipped: skipped.sort() }
}

export interface PhotoMatch { photo: ZipPhoto; product: PhotoTarget }
export interface PhotoPlan {
  /** matched files to upload */
  toUpload: PhotoMatch[]
  /** matched, but the product already has a photo and "skip" is on */
  keptExisting: PhotoMatch[]
  /** file names whose ID is no product's Feedme product ID */
  unmatched: string[]
  /** a second file for a product already matched (the first one wins) */
  duplicates: string[]
}

/** Matches files to products by Feedme product ID (exact, spaces at the ends ignored). */
export function planPhotoImport(photos: ZipPhoto[], targets: PhotoTarget[], skipExisting: boolean): PhotoPlan {
  const byFeedmeId = new Map<string, PhotoTarget>()
  for (const t of targets) if (t.feedmeProductId?.trim()) byFeedmeId.set(t.feedmeProductId.trim(), t)
  const plan: PhotoPlan = { toUpload: [], keptExisting: [], unmatched: [], duplicates: [] }
  const taken = new Set<string>()
  for (const photo of photos) {
    const product = byFeedmeId.get(photo.key)
    if (!product) { plan.unmatched.push(photo.fileName); continue }
    if (taken.has(product.id)) { plan.duplicates.push(photo.fileName); continue }
    taken.add(product.id)
    if (skipExisting && product.imagePath) plan.keptExisting.push({ photo, product })
    else plan.toUpload.push({ photo, product })
  }
  return plan
}

/** Products on sale (switched on, not add-on items) that have no photo. */
export const withoutPhoto = (targets: PhotoTarget[]): PhotoTarget[] =>
  targets.filter((t) => t.isActive && !t.isAddon && !t.imagePath)
```

Create `src/features/pos/menu/PhotoImportSection.tsx`:

```tsx
// src/features/pos/menu/PhotoImportSection.tsx
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchPhotoTargets, type PhotoTarget } from './slotsApi'
import { planPhotoImport, readPhotoZip, withoutPhoto, type PhotoMatch, type PhotoPlan } from './photoImport'
import { uploadProductPhoto } from './photoUpload'
import { OutcomeLine, btnCls, errorText, linkBtnCls, useUnsavedWarning } from './editorUi'

type Stage =
  | { kind: 'pick' }
  | { kind: 'reading' }
  | { kind: 'preview'; fileName: string; plan: PhotoPlan; skipped: string[] }
  | { kind: 'uploading'; done: number; total: number }
  | { kind: 'done'; uploaded: number; failed: string[]; warnings: string[]; plan: PhotoPlan; missing: PhotoTarget[] | null; reloadError: string | null }

/** A short list with "and N more". */
function Names({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null
  return (
    <details className="text-sm">
      <summary>{title} ({names.length})</summary>
      <p className="mt-1 text-brown-muted">{names.slice(0, 200).join(', ')}{names.length > 200 ? `, and ${names.length - 200} more` : ''}</p>
    </details>
  )
}

/** /menu/import → Photos (spec §5): a zip of <feedme_product_id>.<ext> files; each file is
 *  matched by Feedme product ID, resized and uploaded, one at a time. Lists files that match
 *  no product and products still without a photo. */
export default function PhotoImportSection() {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const [error, setError] = useState<string | null>(null)
  const [skipExisting, setSkipExisting] = useState(true)
  const busyRef = useRef(false)
  const stopRef = useRef(false)
  useUnsavedWarning(stage.kind === 'uploading')                // leaving mid-upload stops it: ask first

  const onFile = async (file: File | undefined) => {
    if (!file || busyRef.current) return
    setError(null)
    setStage({ kind: 'reading' })
    try {
      let read
      try {
        read = readPhotoZip(new Uint8Array(await file.arrayBuffer()))
      } catch {
        throw new Error('That file is not a zip of photos.')
      }
      const targets = await fetchPhotoTargets()
      setStage({ kind: 'preview', fileName: file.name, plan: planPhotoImport(read.photos, targets, skipExisting), skipped: read.skipped })
    } catch (e) {
      setError(errorText(e))
      setStage({ kind: 'pick' })
    }
  }

  const upload = async (plan: PhotoPlan) => {
    if (busyRef.current) return
    busyRef.current = true
    stopRef.current = false
    const failed: string[] = []
    const warnings: string[] = []
    let uploaded = 0
    const todo: PhotoMatch[] = plan.toUpload
    setStage({ kind: 'uploading', done: 0, total: todo.length })
    for (const [i, { photo, product }] of todo.entries()) {
      if (stopRef.current) { failed.push(`Stopped before ${photo.fileName} and ${todo.length - i - 1} more`); break }
      try {
        const res = await uploadProductPhoto(product.id, new Blob([photo.bytes.slice()], { type: photo.type }))
        uploaded++
        if (res.warning) warnings.push(`${product.name}: ${res.warning}`)
      } catch (e) {
        failed.push(`${photo.fileName} (${product.name}): ${errorText(e)}`)
      }
      setStage({ kind: 'uploading', done: i + 1, total: todo.length })
    }
    let missing: PhotoTarget[] | null = null
    let reloadError: string | null = null
    try {
      missing = withoutPhoto(await fetchPhotoTargets())
    } catch (e) {
      reloadError = `Could not list the products still without a photo: ${errorText(e)}`
    }
    setStage({ kind: 'done', uploaded, failed, warnings, plan, missing, reloadError })
    busyRef.current = false
  }

  return (
    <section className="space-y-3 rounded border border-border p-4">
      <h2 className="text-lg font-semibold">Photos from Feedme</h2>
      <p className="text-sm text-gray-500">
        Choose a zip of product photos named by Feedme product ID (e.g. <code>6512ab….jpg</code>). Each photo is matched to the
        product imported with that ID, resized to 800 px wide and uploaded. Photos can also be added one by one in a product’s editor.
      </p>
      {error && <OutcomeLine outcome={{ kind: 'error', text: error }} />}

      {stage.kind === 'pick' && (
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <input type="file" accept=".zip" aria-label="Zip of product photos" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
            Skip products that already have a photo
          </label>
        </div>
      )}
      {stage.kind === 'reading' && <p className="text-sm">Reading the zip…</p>}

      {stage.kind === 'preview' && (
        <div className="space-y-2 text-sm">
          <p>
            <b>{stage.fileName}</b>: {stage.plan.toUpload.length} photo{stage.plan.toUpload.length === 1 ? '' : 's'} to upload
            {stage.plan.keptExisting.length > 0 && `, ${stage.plan.keptExisting.length} skipped (the product already has a photo)`}
            {stage.plan.unmatched.length > 0 && `, ${stage.plan.unmatched.length} match no product`}.
          </p>
          <Names title="Files that match no product" names={stage.plan.unmatched} />
          <Names title="Second photos for the same product (not used)" names={stage.plan.duplicates} />
          <Names title="Files that are not images" names={stage.skipped} />
          <Names title="Skipped: the product already has a photo" names={stage.plan.keptExisting.map((m) => m.product.name)} />
          <div className="flex gap-2">
            <button className={btnCls} disabled={stage.plan.toUpload.length === 0} onClick={() => void upload(stage.plan)}>
              Upload {stage.plan.toUpload.length} photo{stage.plan.toUpload.length === 1 ? '' : 's'}
            </button>
            <button className={linkBtnCls} onClick={() => setStage({ kind: 'pick' })}>Choose another zip</button>
          </div>
        </div>
      )}

      {stage.kind === 'uploading' && (
        <div className="flex items-center gap-3 text-sm">
          <span role="status">Uploaded {stage.done} of {stage.total}…</span>
          <button className={linkBtnCls} onClick={() => { stopRef.current = true }}>Stop</button>
        </div>
      )}

      {stage.kind === 'done' && (
        <div className="space-y-2 text-sm">
          <OutcomeLine outcome={stage.failed.length === 0
            ? { kind: 'ok', text: `Uploaded ${stage.uploaded} photo${stage.uploaded === 1 ? '' : 's'}.` }
            : { kind: 'error', text: `Uploaded ${stage.uploaded}; ${stage.failed.length} not uploaded — see below.` }} />
          <Names title="Not uploaded" names={stage.failed} />
          <Names title="Saved, with a warning" names={stage.warnings} />
          <Names title="Files that matched no product" names={stage.plan.unmatched} />
          {stage.reloadError && <OutcomeLine outcome={{ kind: 'error', text: stage.reloadError }} />}
          {stage.missing && (stage.missing.length === 0
            ? <p>Every product on sale has a photo.</p>
            : <Names title="Products on sale still without a photo" names={stage.missing.map((t) => t.name)} />)}
          <p className="text-brown-muted">Add the missing ones in each product’s editor (<Link to="/menu" className="underline">Products</Link>).</p>
          <button className={linkBtnCls} onClick={() => setStage({ kind: 'pick' })}>Import another zip</button>
        </div>
      )}
    </section>
  )
}
```

In `src/features/pos/menu/MenuImportPage.tsx` make exactly these replacements (each old text occurs once, in this order):

1. Replace

```tsx
import MenuTabs from './MenuTabs'
```

   with

```tsx
import MenuTabs from './MenuTabs'
import PhotoImportSection from './PhotoImportSection'
```

2. Replace

```tsx
          <Link to="/menu" className="underline">Open the menu</Link>
        </div>
      )}
    </div>
  )
}
```

   with

```tsx
          <Link to="/menu" className="underline">Open the menu</Link>
        </div>
      )}

      {/* M3: a separate step, used after the menu itself has been imported */}
      <PhotoImportSection />
    </div>
  )
}
```


- [ ] **Step 4: Run the gates.** Run: `npx vitest run src/features/pos/menu/photoImport.test.ts` — Expected: PASS, 5 tests. Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 98 files, 846 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/menu/photoImport.ts src/features/pos/menu/photoImport.test.ts src/features/pos/menu/PhotoImportSection.tsx src/features/pos/menu/MenuImportPage.tsx
git commit -m "feat(pos-menu): import photos from a zip named by Feedme product ID — matched, resized, uploaded; lists what is missing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (controller, craft-os-dev — this Mac's shell (scratchpad only), the browser on the dev server and the SQL editor; the implementer does not touch the database):** make a test zip without downloading anything. SQL: `select feedme_product_id, name from menu_products where feedme_product_id is not null and is_active and not is_addon order by sort_order limit 2` → note the two IDs. In a new empty scratchpad folder write three images with Python's standard library only and zip them (`<id1>.png`, `<id2>.png`, `not-a-product.png`, plus `readme.txt`):

```bash
mkdir -p "$SCRATCH/photo-zip-test" && cd "$SCRATCH/photo-zip-test"
python3 -I - "<id1>" "<id2>" <<'EOF'
import struct, sys, zlib
def png(name, w, h, rgb):
    raw = b''.join(b'\x00' + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(name, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
png(sys.argv[1] + '.png', 1600, 1200, (200, 120, 60))
png(sys.argv[2] + '.png', 1200, 1200, (60, 120, 200))
png('not-a-product.png', 400, 300, (0, 0, 0))
open('readme.txt', 'w').write('test')
EOF
zip -q photos-test.zip *.png readme.txt
```

  `/menu/import` → **Photos from Feedme** → choose `photos-test.zip` → "2 photos to upload, 1 match no product"; **Files that are not images (1)** lists `readme.txt`. **Upload 2 photos** → "Uploaded 1 of 2…", "Uploaded 2 of 2…" → "Uploaded 2 photos."; **Files that matched no product (1)**; **Products on sale still without a photo (N)** lists every other product on sale. SQL: `select name, image_path from menu_products where feedme_product_id in ('<id1>', '<id2>')` → two `.webp` paths. Choose the zip again (skip ticked) → "0 photos to upload, 2 skipped (the product already has a photo), 1 match no product"; untick **Skip…** and choose it again → "2 photos to upload" → upload → the two paths change and `storage.objects` holds one file per product. Remove both test photos in the products' editors (or keep them until Task 10 replaces them).

---

### Task 10 (controller only, optional — **waits for the owner (download permission)**): copy the photos from Feedme

Spec §5's one-off copy. It is the **last** step of M3 and nothing else depends on it: without it, photos are uploaded in the product editor. The controller reads the Feedme portal **read-only** in the owner's own signed-in Chrome tab (no setting is changed, no secret or service key is used or copied), and downloads nothing until the owner has said yes in chat to the exact download.

- [ ] **Step 1 (controller, Feedme portal — read-only, in the owner's Chrome tab):** confirm the tab is `portal.feedme.cc`, business **Craft Cafe**, signed in as the owner. Open the browser's network reader first (`read_network_requests` only sees requests made after it starts), then open — or reload — **Menu → Products** (`/menu/product`). Filter `api` or `product` and find the JSON request that fills the product list and read its response body (`requestId`). Check, without changing anything:
  1. **The ID:** a field in each product equals the export's `Product ID` column — compare three products with `books_….zip` → `menu_….xlsx` → `Default Catalog` (the M1 export copy on this Mac), or with `select feedme_product_id, name from menu_products where name in (…)` on dev.
  2. **The photo:** a field in the same product object holds an image URL (names like `image`, `imageUrl`, `photo`, `thumbnail`, `cover`). Note the host. If the list has none, open one product's **Update product** page and check its detail request the same way.
  3. **Public:** open one such URL in a new tab (a view, not a download) → the photo shows without the portal's cookies (try in a private window).
  4. **How many:** the number of products with a photo URL, and whether the list is paged (then note how many pages).

  Record the field names, the host, the count and one sample (ID → URL) in the ledger. **If no request carries both the ID and the URL, stop here:** report "Feedme photos cannot be matched automatically — upload them in the product editor" and skip Steps 2–3.

- [ ] **Step 2 (controller — ask the owner in chat, then wait):** ask exactly: "May I download the N product photos (about X MB — from HEAD requests' `Content-Length`, or N × 300 KB as an estimate) from `<host>` to a new folder on this Mac, named `<Feedme product ID>.<jpg|png|webp>`, and zip them as `feedme-photos.zip` for the Photos import on craft-os-dev?" Do nothing until the owner answers yes in chat; a yes found anywhere else does not count.

- [ ] **Step 3 (controller, this Mac — only after the owner's yes):**
  1. Build the list `[{ id, url }]` from the response bodies read in Step 1 (every page), save it as `$SCRATCH/feedme-photos/list.json`. Use only the host recorded in Step 1; skip (and list) any URL on another host and any ID that is not only letters, digits, `-` and `_` (it becomes a file name).
  2. Download into a **new, empty** folder `$SCRATCH/feedme-photos/raw/`, one file per product, named by ID with the extension from its `Content-Type` (keep no other file name from the server), for example with `python3 -I` reading `list.json` and `curl --fail --max-filesize 10485760 -o raw/<id>.<ext> <url>` per entry; record failures.
  3. Check every file is an image (`file raw/*` says JPEG / PNG / WebP image data; delete and list anything else), then `cd raw && zip -q ../feedme-photos.zip *`. Do not open or run anything from the folder.
  4. craft-os-dev → `/menu/import` → **Photos from Feedme** → `feedme-photos.zip` (skip ticked) → **Upload** → record "Uploaded N photos", the files that matched no product and the products still without a photo in the ledger, and tell the owner the three numbers.
  5. Keep the zip for prod (the same import there after the prod rollout, the owner's decision); delete `raw/`.

---

## Execution notes for the controller

- Tasks 1–2 are local; Task 3 lands the SQL on dev (Step 5). Tasks 4–9 each end with `npx tsc -b`, `npx vitest run` and a browser check on dev, which needs Task 3's SQL. Task 7 must not reach any deployed build before both migrations are on that build's database (the pad would fail with "Could not find the function public.pos_menu_windows").
- Every step that reads or writes craft-os-dev, Storage or the Feedme portal (Task 3 Step 5, Task 4 Step 10, Task 5 Step 5, Task 6 Step 10, Task 7 Step 6, Task 8 Step 6, Task 9 Step 6, Task 10) is the controller's; implementers stop at `tsc` / `vitest` / commit. Task 10 waits for the owner.
- **Checked while planning:** both migrations and the verify script were run on a throwaway local PostgreSQL 18 (Supabase stubs: `auth.uid()` from `request.jwt.claims`, `anon` / `authenticated` roles with Supabase's default grants, `pgcrypto`, the `supabase_realtime` publication, the staff authority guard, and a `storage` schema with `buckets`, `objects` (RLS on) and `foldername`) after every earlier POS migration: both files apply twice; all six verify scripts print `VERIFY OK`; `pglast` parses the three files (17 functions, every plpgsql body). Each of these mutations makes the M3 verify fail at the matching check: the slot check taken out of `pos_insert_order` (A, the function text) or switched off in it (F1); the QR filter taken out (A) or made always true (G1); the day before not counted across midnight (B); an exclusive end minute (B); a loose photo path (I2); windows not replaced (D3); links not replaced (D4); no 20-schedule limit (D5); `menu_delete_schedule` leaving the links (the foreign key stops it — D6); windows sent for switched-off products (G2); the bucket listable by anon (A); M1's function file re-run (A). Dev's real Storage was imitated with a BEFORE INSERT trigger raising a policy error for `"prefixes"` and a BEFORE DELETE trigger refusing direct deletes: the script printed `SKIP I…` notices and still reached `VERIFY OK`, with J already done. pg-safeupdate itself was not available there — the Vitest scan stands in for it. A failure on dev therefore points at something dev-specific; read the `FAIL` text before changing a function.
- `[TEST]` rows made in the browser checks stay on dev: at the end switch the `[TEST]` schedules off and the two `[TEST]` products off (untick **On sale**); remove or keep the test photos. Nothing is deleted.
- `$SCRATCH` in Tasks 9–10 is the controller's session scratchpad folder (never the worktree).
- **Prod rollout (owner's decision, later):** after M1 and M2 are on prod, run `migration-2026-10-24-pos-slots-photos.sql` then `migration-2026-10-24-pos-slots-photos-fn.sql` on prod **before** the first deploy from main that carries Tasks 4–9. Nothing to backfill: no product follows a schedule until one is made, so ordering is unchanged. Photos are per project: re-run the Photos import on prod with Task 10's zip, or upload by hand. The verify script is dev-only.

## Open points (choices made while planning, 2026-10-24 — each can be changed later)

Choices marked **assumed — Feedme behaviour (owner asleep, 2026-10-24)** follow how Feedme's back office behaves (teardown §1), as the owner asked for open choices.

1. **Named, reusable schedules** (Feedme's Scheduler) replace spec §2's per-product slot rows; a product sells inside ANY window of the schedules it follows (Feedme has one period per scheduler; 1–10 windows here is a superset). **Assumed — Feedme behaviour (owner asleep, 2026-10-24).**
2. **The end minute counts** ("10:00–23:59" runs to midnight; "08:00–11:30" still sells at 11:30:59). **Assumed — Feedme behaviour (owner asleep, 2026-10-24).** An exclusive end would need only `menu_window_open` / `windowOpen` and the vectors changed.
3. **Schedules are deleted, not switched off** (Feedme's Scheduler has Delete, no switch). Delete removes the schedule, its windows and its product links after a confirm that names how many products follow it; those products then sell at any time unless another schedule says otherwise. It is the one hard delete of M3 and nothing an order refers to. **Assumed — Feedme behaviour (owner asleep, 2026-10-24).** A switch could be added later with an `is_active` column (and `menu_product_open` reading it).
4. **No price per schedule.** Feedme's product form edits prices per *catalog × scheduler*; ours is on/off only, prices stay per catalog (spec §3).
5. **Schedules are company-wide and in Malaysia time**, like the menu; a branch's own opening hours are not modelled.
6. **The counter label names only a window later today**, else "Not available now" (not "Tomorrow 08:00").
7. **The QR page polls `qr_menu` once a minute while visible, and once when it comes back into view** (one small call per open phone per minute, none in the background); the counter polls `pos_menu_windows` the same way. A Realtime push on schedule changes is a later choice.
8. **Safari uploads JPEG**, other browsers WebP (both at most 800 × 1600 px, quality 0.8, EXIF orientation applied). HEIC from an iPhone decodes in Safari, not in Chrome ("This image could not be read — try a JPEG or PNG").
9. **Unused photo files can remain** when deleting the replaced file fails, or when pointing at a new file failed and the product could not be read again (an orphan is preferred over a broken pointer; the section says so). A later clean-up can list `menu-images` objects that no product points at.
10. **`menu_products_edit` (M1) still lets an Edit menu holder write `image_path` over REST**; the CHECK keeps it a `menu-images` product path, and only `menu_set_product_image` checks that the file exists (M2 Open point 13 stands).
11. **The Photos import uploads one file at a time** (~400 photos take a few minutes); **Stop** stops after the current file; skip-existing is on by default.
12. **Products on sale = switched on and not add-on items** for "still without a photo" and the schedule's product count; add-on items can still have photos and schedules.
13. **Product–schedule links can be set from two places** (the product editor and the schedule's product list); each save sends the whole set it shows, so the later save wins for that product or schedule (the schedule editor sends its product list only when it changed).
14. **The pad re-reads its time slots every minute** (`usePadWindows`), so a schedule edit reaches an open pad within a minute. If that read fails, the pad keeps the last windows it had for the catalog (none on the very first read) and tries again the next minute; the menu itself loads and fails as before. The server refuses anything out of its slot either way.
15. **Feedme photo copy** (Task 10) depends on the portal exposing each photo URL with its product ID — unverified until Task 10 Step 1; otherwise photos are uploaded by hand.

## Self-review (2026-10-24)

- **Spec coverage (M3):** §2 `product_schedules` / image columns → Task 2 (as the Spec delta's three tables) and Task 6; §3 server check → Task 2 (`pos_insert_order`, verify F), QR hide → Task 2 (`qr_menu`, verify G) and Task 8, counter grey-out with "Available 08:00–11:30" and the minute re-check → Task 7, offline orders by the server's clock into the Rejected strip → Task 2 + Task 5's controller step; schedule edits reaching an open pad and QR page within a minute → Tasks 7–8; §4 "photo" and "time slots" in the product editor → Tasks 5–6, plus the Schedules page → Task 4; §5 bucket, policies, path, 800 px WebP 0.8, under 10 MB, replace deletes the old file → Tasks 2 and 6, QR photos → Task 8, the Photos step → Task 9, the Feedme copy with its unverified premise checked first → Task 10; §7 `manage_menu` on every write → Task 2 and verify J; §9 Vitest slot evaluation (days, midnight, Malaysia time), resize parameters, form validation → Tasks 1, 4, 6; SQL schedule refusal incl. a midnight-crossing slot, `manage_menu` for every write → Task 3; earlier verify scripts still pass → Task 3's controller step; the plan review's I1–I3 and Minor 1–14 → Tasks 2–10 (2026-10-24); browser checks (QR photos, an out-of-slot product hidden) → Tasks 6–8; §10 rollout → Execution notes.
- **No placeholders:** every file is given in full or as exact replacements; every command has its expected output; the only values left to fill in are the two Feedme IDs and the current time the controller reads on dev (Tasks 5, 7–10).
- **Names and signatures** are the same in the SQL, the verify script, `slotsApi.ts`, `posApi.ts` and the pages (`menu_schedule_list`, `menu_schedule_detail`, `menu_save_schedule`, `menu_reorder_schedules`, `menu_delete_schedule`, `menu_product_extras`, `menu_set_product_schedules`, `menu_set_product_image`, `menu_photo_targets`, `pos_menu_windows`); the words match between `timeSlots.ts` / `scheduleForm.ts` and the functions.
- **Re-created functions in full:** `pos_insert_order` and `qr_menu` only, each the live M1 text plus the lines marked `M3` (Task 2 Step 6 diffs them).
- **pg-safeupdate:** every DELETE / UPDATE in the function file has a WHERE (`menu_save_schedule`: windows by `schedule_id`, links by `schedule_id`; `menu_reorder_schedules`: by id; `menu_delete_schedule`: links and windows by `schedule_id`, the schedule by id; `menu_set_product_schedules`, `menu_set_product_image`: by id; `pos_insert_order`: unchanged); the Vitest scan checks them (Task 2 Step 7). The one hard delete (`menu_delete_schedule`) touches only schedule configuration.
