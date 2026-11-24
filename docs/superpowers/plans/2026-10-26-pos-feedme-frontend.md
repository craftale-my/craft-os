# POS Feedme-layout Front End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/pos` screens to follow the Feedme iPad POS layout and flow (bottom bar, table home with area tabs and totals, a three-column order screen, a bill actions overlay with Move to, full-screen Payment, a Transaction page), keeping the Craft palette and every existing piece of POS logic and RPC.

**Architecture:** `PosPage` becomes a small screen router (home | order | payment | transaction) that owns the shared data (tables, open bills, their server totals, billing config, catalogs, the offline queue, realtime, the shift). Each screen is its own component; every rule a screen needs lives in a small pure helper with Vitest tests. The money logic (`paySession`, `tender`, `follow`, `computeBill`, the queue) is reused unchanged; one migration adds `dining_tables.area`, `pos_open_bill_summaries` (tile totals from `pos_bill_totals`) and `pos_set_bill_pax`.

**Tech Stack:** React 19 + TypeScript (strict), React Router 7, Tailwind CSS 3.4 (Craft tokens), lucide-react 1.18 icons, Supabase (Postgres RPCs, PostgREST, Realtime), Vitest 3 with jsdom and @testing-library/react for component tests.

**Design spec:** `docs/superpowers/specs/2026-10-26-pos-feedme-frontend-design.md`

## Global Constraints

- All UI labels and copy in English.
- Craft palette and fonts only: the existing Tailwind tokens (`cream`, `canvas`, `card`, `border`, `border-mid`, `brown-dark`, `brown-header`, `brown-btn`, `brown-btn-hover`, `brown-muted`, `brown-faint`) plus the red / amber / green status colours the POS already uses. No new colours, no new fonts.
- Design size: iPad landscape **1180 × 820**; every touch target ≥ 44 px high (`min-h-11` / `h-11` or more).
- Reuse existing logic modules unchanged unless a task says otherwise. The server (RPC) result is the truth for money: tiles show `pos_open_bill_summaries`, Payment shows `pos_checkout_state`; `computeBill` is only the instant preview on the order screen.
- Supabase's API role runs pg-safeupdate: every UPDATE / DELETE inside an RPC needs a WHERE (`src/features/pos/sqlSafeUpdate.test.ts` scans every `migration-*-pos-*.sql`).
- Staff liveness in POS SQL = `is_active and status = 'active'` (through `pos_my_branch()`); each RPC checks the caller is staff of that branch; grants are `revoke all on function … from public, anon; grant execute on function … to authenticated;`.
- New SQL goes in `supabase/migration-2026-10-26-pos-frontend.sql` with a rolled-back `supabase/migration-2026-10-26-pos-frontend-verify.sql` ending in a `VERIFY OK` notice. **No step of this plan runs SQL.** The SQL task ends with "Controller applies the migration and verify on craft-os-dev" — the controller does that out of band.
- No `window.confirm` / `window.prompt` on the POS screens (`/pos`): use `ConfirmDialog` / `PaxDialog`. (`/pos/settings` is a settings page and keeps its own.)
- `LineSheet.tsx` stays unchanged: the customer QR page (`src/qr/QrApp.tsx`) uses it. The POS gets its own `ModifierSheet.tsx`.
- `PrintHostPanel` and `ShiftBar` must never unmount while `/pos` is open (the print host prints this iPad's browser-route tickets; the shift bar holds an unsent pay in / pay out): the staff panel is hidden, not unmounted.
- Commands: one test file `npx vitest run <path>`; typecheck `npx tsc -b` (package.json has no typecheck script; `build` is `tsc -b && vite build` and both tsconfigs set `noEmit`); full suite `npx vitest run` (934 tests before this plan). The repo has no ESLint config, so there is no lint step.
- Commit messages end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (second `-m`). Commit on `feature/pos-demo`; never `git stash`.

---

## File Structure

**SQL**
- Create `supabase/migration-2026-10-26-pos-frontend.sql` — `dining_tables.area` + its check, `dining_tables_guard` re-created to guard `area`, RPCs `pos_open_bill_summaries(uuid)` and `pos_set_bill_pax(uuid, integer)`.
- Create `supabase/migration-2026-10-26-pos-frontend-verify.sql` — rolled-back self-check of the above.
- Modify `src/features/pos/sqlSafeUpdate.test.ts` — scans the new migration and checks its grants.

**Data layer**
- Create `src/features/pos/order/billSummaries.ts` (+ test) — `BillSummary` and the parser of `pos_open_bill_summaries`.
- Create `src/features/pos/order/padInfo.ts` (+ test) — per-product SST rate, packaging fee and photo URL; puts photos on the menu.
- Modify `src/features/pos/order/posApi.ts` — `TableRow.area`, `fetchOpenBillSummaries`, `fetchOrderBillId`, `fetchPadProductInfo`.
- Modify `src/features/pos/checkout/checkoutApi.ts` — `setBillPax` (Task 1); `fetchClosedBillDetail` and its row types (Task 10).

**Pure helpers**
- Create `src/features/pos/order/home.ts` (+ test) — area tabs, visible tables, elapsed label.
- Create `src/features/pos/order/orderTarget.ts` (+ test) — `OrderTarget`, its bill, title, pax, the takeaway one-order rule.
- Create `src/features/pos/order/moveTargets.ts` (+ test) — the Move to grid: move vs merge vs refused.
- Create `src/features/pos/shell/shellMenu.ts` (+ test) — grid menu items by capability, Malaysia clock.
- Create `src/features/pos/order/billView.ts` (+ test) — sent + draft view model, totals preview, Payment gate, prompts.
- Create `src/features/pos/order/modifiers.ts` (+ test) — group badge, LineSheet's toggle rule, tile initials.
- Create `src/features/pos/order/billActions.ts` (+ test) — which bill actions exist right now.
- Create `src/features/pos/checkout/payTabs.ts` (+ test) — payment tabs, number pad, one-payment lines, live change.
- Create `src/features/pos/checkout/transactions.ts` (+ test) — Transaction filters, search, labels, date.
- Modify `src/features/pos/order/tableAdmin.ts` (+ test) — `normalizeArea`.
- Modify `src/features/pos/order/rejectedOrder.ts` (+ test) — returns an `OrderTarget` instead of the old `PadMode`.

**Components**
- Create `src/features/pos/shell/ConfirmDialog.tsx` (+ jsdom test) — in-app confirm.
- Create `src/features/pos/shell/PaxDialog.tsx` (+ jsdom test) — Select pax 1–20.
- Create `src/features/pos/shift/useShiftOpen.ts` (+ jsdom test) — is a shift open (banner, Payment).
- Modify `src/features/pos/shift/ShiftBar.tsx` — optional `onChanged` prop.
- Create `src/features/pos/shell/BottomBar.tsx` — grid button · screen name · staff and time.
- Create `src/features/pos/shell/GridMenu.tsx` — Order / Menu / Transaction / Report / Setting.
- Create `src/features/pos/shell/StaffPanel.tsx` — shift, printers, My PIN, live status, Logout (always mounted).
- Modify `src/features/pos/order/ProductTiles.tsx` — Feedme tile (photo or initials), same props.
- Create `src/features/pos/order/ModifierSheet.tsx` (+ jsdom test) — Feedme modifier sheet for the POS.
- Create `src/features/pos/order/BillColumn.tsx` — the order screen's bill column (presentational).
- Create `src/features/pos/order/BillActionsOverlay.tsx` — dark overlay of round action buttons.
- Create `src/features/pos/order/MoveToGrid.tsx` (+ jsdom test) — Move to grid.
- Create `src/features/pos/order/OrderScreen.tsx` — categories | tiles | bill; replaces `OrderPad` + `BillPanel`.
- Create `src/features/pos/checkout/PaymentScreen.tsx` (+ jsdom test) — full-screen Payment; replaces `CheckoutSheet`.
- Create `src/features/pos/checkout/TransactionScreen.tsx` — Transaction page; replaces `TodayBillsDrawer`.
- Create `src/features/pos/order/QueueStrip.tsx` — the offline queue strip (moved out of `PosPage`).
- Create `src/features/pos/order/HomeScreen.tsx` — area tabs, table tiles, Other bills.
- Modify `src/features/pos/order/PosPage.tsx` — rewritten as the screen router.
- Modify `src/features/pos/order/PosSettingsPage.tsx` — Area field per table.
- Delete `src/features/pos/order/TablesGrid.tsx`, `BillPanel.tsx`, `OrderPad.tsx`, `src/features/pos/checkout/CheckoutSheet.tsx`, `TodayBillsDrawer.tsx` (Task 12, once nothing imports them).
- Kept and reused unchanged: `cart.ts`, `catalogs.ts`, `tableStatus.ts`, `useOrderQueue.ts`, `usePosRealtime.ts`, `usePadWindows.ts`, `useMinuteClock.ts`, `padSlots.ts`, `PrintHostPanel.tsx`, `LineSheet.tsx` (QR page), `bill.ts`, `paySession.ts`, `tender.ts`, `follow.ts`, `todayBills.ts`, `rpcResult.ts`, `ApprovalDialog.tsx`, `BillPickers.tsx` (catalog picker), `CheckoutTotals.tsx`, `MyPinDialog.tsx`, `ShiftsDrawer.tsx` and the shift sheets.

---

### Task 1: Data additions — migration, verify, bill summaries, pad product info, pax

**Files:**
- Create: `supabase/migration-2026-10-26-pos-frontend.sql`
- Create: `supabase/migration-2026-10-26-pos-frontend-verify.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts`
- Create: `src/features/pos/order/billSummaries.ts`, Test: `src/features/pos/order/billSummaries.test.ts`
- Create: `src/features/pos/order/padInfo.ts`, Test: `src/features/pos/order/padInfo.test.ts`
- Modify: `src/features/pos/order/posApi.ts` (imports, `TableRow`, `fetchTables`, three new fetchers)
- Modify: `src/features/pos/checkout/checkoutApi.ts` (`setBillPax`, before `openTable`)
- Modify: `src/features/pos/order/tableStatus.test.ts` (fixture gets `area: null`)

**Interfaces:**
- Consumes: `pos_bill_totals(uuid)`, `pos_my_branch()`, `has_menu_cap(text)` (existing SQL); `productThumbUrl(path, updatedAt)` from `src/features/pos/menu/photoUpload.ts`.
- Produces:
  - SQL: `dining_tables.area text null` (check `area is null or (area = btrim(area) and char_length(area) between 1 and 40)`), `pos_open_bill_summaries(p_branch_id uuid) returns table (bill_id uuid, total_sen integer, item_count integer)` (raises `Not your branch`), `pos_set_bill_pax(p_bill_id uuid, p_pax integer) returns void` (raises `Invalid number of guests` / `Bill not found`).
  - `interface BillSummary { billId: string; totalSen: number; itemCount: number }`, `parseBillSummaries(data: unknown): Map<string, BillSummary>` (billSummaries.ts)
  - `interface PadProductRow { id; sst_rate_bp; takeaway_fee_sen; image_path; image_updated_at }`, `interface PadProductInfo { sstRateBp: number; takeawayFeeSen: number; imageUrl: string | null }`, `padProductInfo(rows: PadProductRow[], photoUrl: (path: string, updatedAt: string | null) => string): Map<string, PadProductInfo>`, `withPhotos(menu: PosMenu, info: ReadonlyMap<string, PadProductInfo>): PosMenu` (padInfo.ts)
  - posApi: `TableRow.area: string | null`; `fetchOpenBillSummaries(branchId: string): Promise<Map<string, BillSummary>>`; `fetchOrderBillId(clientOrderId: string): Promise<string | null>`; `fetchPadProductInfo(): Promise<Map<string, PadProductInfo>>`
  - checkoutApi: `setBillPax(billId: string, pax: number): Promise<void>`

- [ ] **Step 1: Write the failing scan test**

In `src/features/pos/sqlSafeUpdate.test.ts`, add the new file to the list in `it('reads the POS function migrations', …)`:

```ts
      'migration-2026-10-25-menu-list-photo.sql',
      'migration-2026-10-26-pos-frontend.sql',
    ]))
```

and add this test as the last one inside `describe('pg-safeupdate guard: POS migrations', …)` (just before its closing `})`):

```ts
  it('scans the Feedme-layout front end additions: the guard, the bill summaries and pax, staff-only grants', () => {
    const sql = readFileSync(new URL('migration-2026-10-26-pos-frontend.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(['dining_tables_guard', 'pos_open_bill_summaries', 'pos_set_bill_pax'])
    expect(sql).toMatch(/revoke all on function pos_open_bill_summaries\(uuid\) from public, anon;/)
    expect(sql).toMatch(/grant execute on function pos_open_bill_summaries\(uuid\) to authenticated;/)
    expect(sql).toMatch(/revoke all on function pos_set_bill_pax\(uuid, integer\) from public, anon;/)
    expect(sql).toMatch(/grant execute on function pos_set_bill_pax\(uuid, integer\) to authenticated;/)
    expect(sql).toMatch(/raise exception 'STOP: run migration-2026-10-25-pos-hardening\.sql first/)
    const verify = readFileSync(new URL('migration-2026-10-26-pos-frontend-verify.sql', SUPABASE), 'utf8')
    expect(verify).toMatch(/^begin;$/m)
    expect(verify).toMatch(/raise notice 'VERIFY OK';\s*end \$\$;\s*select 'VERIFY OK' as result;\s*rollback;\s*$/)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL — `reads the POS function migrations` (the file is not in the list) and `ENOENT: no such file or directory … migration-2026-10-26-pos-frontend.sql`.

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-10-26-pos-frontend.sql`:

```sql
-- ============================================================================
-- Craft OS — POS Feedme-layout front end (2026-10-26): data additions.
-- Run on craft-os-dev after migration-2026-10-25-pos-hardening.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-26-pos-feedme-frontend.md
-- Design: docs/superpowers/specs/2026-10-26-pos-feedme-frontend-design.md (§6)
--
-- F1  dining_tables.area: the floor area of a table, for the home screen's area tabs
--     (null = none), trimmed, 1–40 characters. A manager's change, like the table order:
--     dining_tables_guard is re-created from migration-2026-10-23-pos-ordering.sql with
--     area added to the guarded columns (its message is unchanged).
-- F2  pos_open_bill_summaries(p_branch_id): every open bill of the caller's own branch with
--     its total from pos_bill_totals (the numbers checkout uses) and its live item count.
-- F3  pos_set_bill_pax(p_bill_id, p_pax): the guests of an open dine-in bill. open_table and
--     pos_insert_order only fill pax while it is empty; this changes it (Bill actions → Pax).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_bill_totals(uuid)') is null or to_regprocedure('pos_my_branch()') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'bills' and column_name = 'updated_at') then
    raise exception 'STOP: run migration-2026-10-25-pos-hardening.sql first (pos_bill_totals or bills.updated_at is missing)';
  end if;
end $$;

-- ── F1. Table areas ─────────────────────────────────────────────────────────
alter table dining_tables add column if not exists area text;
alter table dining_tables drop constraint if exists dining_tables_area_check;
alter table dining_tables add constraint dining_tables_area_check
  check (area is null or (area = btrim(area) and char_length(area) between 1 and 40));

create or replace function dining_tables_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (new.qr_token, new.branch_id, new.is_active, new.sort_order, new.area)                      -- F1: area
     is distinct from (old.qr_token, old.branch_id, old.is_active, old.sort_order, old.area)
     and not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change this table''s QR code, branch or status';
  end if;
  return new;
end $$;

-- ── F2. Open bills with their totals, for the home screen's tiles ───────────
create or replace function pos_open_bill_summaries(p_branch_id uuid)
returns table (bill_id uuid, total_sen integer, item_count integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_branch_id is distinct from pos_my_branch() then
    raise exception 'Not your branch';
  end if;
  return query
    select b.id,
           (pos_bill_totals(b.id)->>'totalSen')::integer,
           coalesce((select sum(oi.qty) from order_items oi
                      where oi.bill_id = b.id and oi.voided_at is null), 0)::integer
      from bills b
     where b.branch_id = p_branch_id and b.status = 'open'
     order by b.opened_at, b.id;
end $$;
revoke all on function pos_open_bill_summaries(uuid) from public, anon;
grant execute on function pos_open_bill_summaries(uuid) to authenticated;

-- ── F3. Change the guests of an open dine-in bill ───────────────────────────
-- updated_at moves, so the other iPads get a bills event and refresh.
create or replace function pos_set_bill_pax(p_bill_id uuid, p_pax integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  if p_pax is null or p_pax < 1 or p_pax > 99 then raise exception 'Invalid number of guests'; end if;
  update bills set pax = p_pax, updated_at = now()
   where id = p_bill_id and branch_id = v_branch and status = 'open' and order_type = 'dine_in';
  if not found then raise exception 'Bill not found'; end if;
end $$;
revoke all on function pos_set_bill_pax(uuid, integer) from public, anon;
grant execute on function pos_set_bill_pax(uuid, integer) to authenticated;

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'pos front end data additions applied' as result;
```

- [ ] **Step 4: Write the rolled-back verify script**

Create `supabase/migration-2026-10-26-pos-frontend-verify.sql` (same `expect_error` / `act` helpers and fixture style as `migration-2026-10-25-pos-hardening-verify.sql`):

```sql
-- Self-check for the POS Feedme-layout front end data additions. Run on craft-os-dev after
-- migration-2026-10-26-pos-frontend.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections follow the migration: A schema, grants and search_path; F1 the area
-- column and its guard; F2 the open bill summaries match pos_bill_totals and stay in their
-- branch; F3 the guests of an open dine-in bill.
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

-- act(staff id): the next calls run as this signed-in staff member
create function pg_temp.act(p_staff uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_staff, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  v_owner  uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_a      uuid := 'eeeeeeee-0000-0000-0000-000000000061';   -- cashier of VERIFY F
  v_far    uuid := 'eeeeeeee-0000-0000-0000-000000000062';   -- cashier of another branch
  v_branch uuid; v_branch2 uuid;
  v_t1 dining_tables; v_t2 dining_tables; v_t3 dining_tables;
  v_cat uuid; v_catalog uuid; v_plate uuid; v_plate_v uuid;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid; v_id uuid;
  n integer; m integer; r record;
begin
  -- ── A. schema, grants, search_path, the guard's body ──────────────────────
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'dining_tables'
                  and column_name = 'area' and is_nullable = 'YES') then
    raise exception 'FAIL F1 schema: dining_tables.area is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dining_tables_area_check') then
    raise exception 'FAIL F1 schema: dining_tables_area_check is missing';
  end if;
  for r in select f from unnest(array['pos_open_bill_summaries(uuid)', 'pos_set_bill_pax(uuid,integer)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array['pos_open_bill_summaries', 'pos_set_bill_pax', 'dining_tables_guard'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  if pg_get_functiondef('dining_tables_guard()'::regprocedure) not like '%new.area%' then
    raise exception 'FAIL F1: dining_tables_guard does not guard area — re-run migration-2026-10-26-pos-frontend.sql';
  end if;

  -- ── B. fixture: two branches, three tables, one product, one catalog, two cashiers ──
  update system_role_permissions set permissions = permissions - 'pos_supervise' - 'access_settings' where true;   -- code defaults
  insert into branches(name, address) values ('VERIFY F', 'verify') returning id into v_branch;
  insert into branches(name, address) values ('VERIFY F FAR', 'far') returning id into v_branch2;
  insert into dining_tables(branch_id, label, area, sort_order) values (v_branch, 'F1', 'Patio', 1) returning * into v_t1;
  insert into dining_tables(branch_id, label, sort_order) values (v_branch, 'F2', 2) returning * into v_t2;
  insert into dining_tables(branch_id, label, sort_order) values (v_branch, 'F3', 3) returning * into v_t3;
  insert into menu_categories(name, sort_order) values ('VERIFY F FOOD', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp, takeaway_fee_sen) values ('Verify F Plate', v_cat, 600, 100) returning id into v_plate;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 2000) returning id into v_plate_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY F CATALOG', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_v, 2000);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
  update staff set branch_id = v_branch where id = v_owner;
  -- staff are inserted as 'staff' by the owner (the staff guard refuses anything else)
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_a), (v_far);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_a,   'Verify F Cashier', 'trainee', true, current_date, 'staff', v_branch),
    (v_far, 'Verify F Far',     'trainee', true, current_date, 'staff', v_branch2);

  -- ── F1. area: trimmed, 1–40 characters or null; only a manager changes it ──
  begin
    update dining_tables set area = ' Patio' where id = v_t2.id;
    raise exception 'FAIL F1: an untrimmed area was accepted';
  exception when check_violation then null;
  end;
  begin
    update dining_tables set area = '' where id = v_t2.id;
    raise exception 'FAIL F1: an empty area was accepted';
  exception when check_violation then null;
  end;
  begin
    update dining_tables set area = repeat('x', 41) where id = v_t2.id;
    raise exception 'FAIL F1: a 41-character area was accepted';
  exception when check_violation then null;
  end;
  update dining_tables set area = repeat('x', 40) where id = v_t2.id;
  update dining_tables set area = 'Hall' where id = v_t2.id;          -- the owner may
  update dining_tables set area = null where id = v_t3.id;
  if (select area from dining_tables where id = v_t2.id) is distinct from 'Hall' then
    raise exception 'FAIL F1: a manager could not set the area';
  end if;
  perform pg_temp.act(v_a);
  perform pg_temp.expect_error(format('update dining_tables set area = %L where id = %L', 'Bar', v_t2.id),
    'Only a manager can change this table''s QR code, branch or status', 'F1 a cashier sets an area');
  update dining_tables set qr_paused = true where id = v_t2.id;      -- any staff may still pause QR
  if not (select qr_paused from dining_tables where id = v_t2.id) then raise exception 'FAIL F1: a cashier can no longer pause QR'; end if;

  -- ── F2. summaries: every open bill of the branch, totals from pos_bill_totals ──
  v_id := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v, 'qty', 2)), gen_random_uuid());
  b1 := (select bill_id from orders where id = v_id);
  v_id := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b2 := (select bill_id from orders where id = v_id);
  b3 := open_table(v_t2.id, 3);                                      -- open, nothing on it yet
  -- one line of the table's second order voided (set by hand: the void path is checked elsewhere)
  reset role;
  update order_items set voided_at = now()
   where id = (select oi.id from order_items oi join orders o on o.id = oi.order_id
                where oi.bill_id = b1 order by o.placed_at desc, oi.id limit 1);
  perform pg_temp.act(v_a);
  set local role authenticated;
  select count(*), count(*) filter (where
           (s.bill_id = b1 and s.total_sen = (pos_bill_totals(b1)->>'totalSen')::int and s.item_count = 2)
        or (s.bill_id = b2 and s.total_sen = (pos_bill_totals(b2)->>'totalSen')::int and s.item_count = 1)
        or (s.bill_id = b3 and s.total_sen = (pos_bill_totals(b3)->>'totalSen')::int and s.item_count = 0))
    into n, m
    from pos_open_bill_summaries(v_branch) s;
  reset role;
  if n <> 3 or m <> 3 then raise exception 'FAIL F2: % rows, % matching pos_bill_totals (expected 3 and 3)', n, m; end if;
  -- the table: 2 × 20.00 + SST 6% 2.40 = 42.40 (the voided plate does not count)
  if (select s.total_sen from pos_open_bill_summaries(v_branch) s where s.bill_id = b1) is distinct from 4240 then
    raise exception 'FAIL F2: table total is not 42.40';
  end if;
  -- a merged bill is closed: it leaves the list and its items count on the bill it went into
  perform merge_bills(b2, b1);
  select count(*) into n from pos_open_bill_summaries(v_branch);
  if n <> 2 or exists (select 1 from pos_open_bill_summaries(v_branch) s where s.bill_id = b2)
     or (select s.item_count from pos_open_bill_summaries(v_branch) s where s.bill_id = b1) is distinct from 3
     or (select s.total_sen from pos_open_bill_summaries(v_branch) s where s.bill_id = b1)
        is distinct from (pos_bill_totals(b1)->>'totalSen')::int then
    raise exception 'FAIL F2: the merged bill is still listed or the bill it went into is wrong';
  end if;
  -- another branch's staff and anon are refused
  perform pg_temp.act(v_far);
  perform pg_temp.expect_error(format('select * from pos_open_bill_summaries(%L)', v_branch), 'Not your branch', 'F2 another branch');
  set local role anon;
  begin
    perform * from pos_open_bill_summaries(v_branch);
    raise exception 'FAIL F2: anon could read the summaries';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── F3. the guests of an open dine-in bill ─────────────────────────────────
  perform pg_temp.act(v_a);
  perform pos_set_bill_pax(b1, 5);
  if (select pax from bills where id = b1) is distinct from 5 then raise exception 'FAIL F3: pax was not changed'; end if;
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 0)', b1), 'Invalid number of guests', 'F3 zero guests');
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 100)', b1), 'Invalid number of guests', 'F3 100 guests');
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 2)', b2), 'Bill not found', 'F3 a merged bill');
  v_id := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_v)), gen_random_uuid());
  b4 := (select bill_id from orders where id = v_id);
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 2)', b4), 'Bill not found', 'F3 a takeaway bill');
  perform pg_temp.act(v_far);
  perform pg_temp.expect_error(format('select pos_set_bill_pax(%L, 4)', b1), 'Bill not found', 'F3 another branch');
  if (select pax from bills where id = b1) is distinct from 5 then raise exception 'FAIL F3: another branch changed the pax'; end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 5: Run the scan test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS (30 tests), including `migration-2026-10-26-pos-frontend.sql: every DELETE / UPDATE inside a function has a WHERE`.

- [ ] **Step 6: Write the failing tests for the two parsers**

Create `src/features/pos/order/billSummaries.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseBillSummaries } from './billSummaries'

describe('parseBillSummaries', () => {
  it('keys the rows by bill id', () => {
    const m = parseBillSummaries([
      { bill_id: 'b1', total_sen: 10670, item_count: 4 },
      { bill_id: 'b2', total_sen: 0, item_count: 0 },
    ])
    expect([...m.values()]).toEqual([
      { billId: 'b1', totalSen: 10670, itemCount: 4 },
      { billId: 'b2', totalSen: 0, itemCount: 0 },
    ])
    expect(m.get('b1')?.totalSen).toBe(10670)
  })
  it('an empty branch has no rows', () => {
    expect(parseBillSummaries([]).size).toBe(0)
  })
  it('refuses anything that is not the function\'s shape', () => {
    expect(() => parseBillSummaries(null)).toThrow('Unexpected reply from the server')
    expect(() => parseBillSummaries([{ bill_id: 'b1', total_sen: '10.00', item_count: 1 }])).toThrow('Unexpected reply from the server')
    expect(() => parseBillSummaries([null])).toThrow('Unexpected reply from the server')
  })
})
```

Create `src/features/pos/order/padInfo.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { padProductInfo, withPhotos } from './padInfo'
import type { PosMenu } from './cart'

const url = (path: string, at: string | null) => `https://img/${path}${at ? `?v=${at}` : ''}`

describe('padProductInfo', () => {
  it('keeps the SST rate and packaging fee, and turns a photo path into its URL', () => {
    const m = padProductInfo([
      { id: 'p1', sst_rate_bp: 600, takeaway_fee_sen: 100, image_path: 'p1.webp', image_updated_at: '1' },
      { id: 'p2', sst_rate_bp: 0, takeaway_fee_sen: 0, image_path: null, image_updated_at: null },
    ], url)
    expect(m.get('p1')).toEqual({ sstRateBp: 600, takeawayFeeSen: 100, imageUrl: 'https://img/p1.webp?v=1' })
    expect(m.get('p2')).toEqual({ sstRateBp: 0, takeawayFeeSen: 0, imageUrl: null })
  })
})

describe('withPhotos', () => {
  it('puts each product\'s photo on the menu; unknown products get none', () => {
    const product = (id: string) => ({ id, name: id, description: null, soldOut: false, variants: [], groups: [] })
    const menu: PosMenu = { categories: [{ name: 'TEA', products: [product('p1'), product('p9')] }] }
    const info = padProductInfo([{ id: 'p1', sst_rate_bp: 600, takeaway_fee_sen: 0, image_path: 'p1.webp', image_updated_at: null }], url)
    expect(withPhotos(menu, info).categories[0].products.map((p) => p.imageUrl)).toEqual(['https://img/p1.webp', null])
  })
})
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npx vitest run src/features/pos/order/billSummaries.test.ts src/features/pos/order/padInfo.test.ts`
Expected: FAIL — `Failed to resolve import "./billSummaries"` and `Failed to resolve import "./padInfo"`.

- [ ] **Step 8: Implement the parsers**

Create `src/features/pos/order/billSummaries.ts`:

```ts
// src/features/pos/order/billSummaries.ts
/** pos_open_bill_summaries (supabase/migration-2026-10-26-pos-frontend.sql): every open bill of
 *  the branch with the total checkout would charge (pos_bill_totals) and its live item count.
 *  The home tiles and the Move to grid show these, never a total of their own. */
export interface BillSummary { billId: string; totalSen: number; itemCount: number }

const unexpected = (): never => { throw new Error('Unexpected reply from the server') }

/** Keyed by bill id. Throws "Unexpected reply from the server" for anything else. */
export function parseBillSummaries(data: unknown): Map<string, BillSummary> {
  if (!Array.isArray(data)) return unexpected()
  const out = new Map<string, BillSummary>()
  for (const row of data) {
    if (typeof row !== 'object' || row === null) return unexpected()
    const { bill_id, total_sen, item_count } = row as Record<string, unknown>
    if (typeof bill_id !== 'string' || typeof total_sen !== 'number' || typeof item_count !== 'number') return unexpected()
    out.set(bill_id, { billId: bill_id, totalSen: total_sen, itemCount: item_count })
  }
  return out
}
```

Create `src/features/pos/order/padInfo.ts`:

```ts
// src/features/pos/order/padInfo.ts
/** What the order screen needs of a product beyond pos_menu_rows: its SST rate and packaging fee
 *  (so the bill preview can count unsent items with the server's rules) and its photo (the
 *  Feedme tile). Read from menu_products, the same columns pos_insert_order snapshots. */
import type { PosMenu } from './cart'

export interface PadProductRow {
  id: string
  sst_rate_bp: number
  takeaway_fee_sen: number
  image_path: string | null
  image_updated_at: string | null
}
export interface PadProductInfo { sstRateBp: number; takeawayFeeSen: number; imageUrl: string | null }

/** `photoUrl` turns a photo path (and when it was set) into its URL: productThumbUrl in the app. */
export function padProductInfo(
  rows: PadProductRow[], photoUrl: (path: string, updatedAt: string | null) => string,
): Map<string, PadProductInfo> {
  return new Map(rows.map((r) => [r.id, {
    sstRateBp: r.sst_rate_bp,
    takeawayFeeSen: r.takeaway_fee_sen,
    imageUrl: r.image_path ? photoUrl(r.image_path, r.image_updated_at) : null,
  }]))
}

/** The menu with each product's photo URL (null when it has none or is not in `info`). */
export function withPhotos(menu: PosMenu, info: ReadonlyMap<string, PadProductInfo>): PosMenu {
  return {
    categories: menu.categories.map((c) => ({
      name: c.name,
      products: c.products.map((p) => ({ ...p, imageUrl: info.get(p.id)?.imageUrl ?? null })),
    })),
  }
}
```

- [ ] **Step 9: Run them to verify they pass**

Run: `npx vitest run src/features/pos/order/billSummaries.test.ts src/features/pos/order/padInfo.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Add the fetchers to `posApi.ts`**

After the line `import { menuWindows, type MenuWindows, type MenuWindowsJson } from './padSlots'` add:

```ts
import { parseBillSummaries, type BillSummary } from './billSummaries'
import { padProductInfo, type PadProductInfo, type PadProductRow } from './padInfo'
import { productThumbUrl } from '../menu/photoUpload'
```

Replace the one-line `export interface TableRow { … }` with:

```ts
export interface TableRow {
  id: string; label: string; qr_token: string; qr_paused: boolean; is_active: boolean; sort_order: number
  /** the floor area for the home screen's tabs (null = only under All) */
  area: string | null
}
```

Replace the body of `fetchTables` from `.select(` to the end of the function with the version below, and add the three new functions right after it:

```ts
    .select('id, label, qr_token, qr_paused, is_active, sort_order, area')
    .eq('branch_id', branchId).eq('is_active', true).order('sort_order').order('label')
  if (error) fail(error)
  return (data ?? []) as TableRow[]
}

/** Every open bill of the branch with the total checkout would charge (pos_bill_totals) and its
 *  live item count, keyed by bill id. Staff of the branch only. */
export async function fetchOpenBillSummaries(branchId: string): Promise<Map<string, BillSummary>> {
  const { data, error } = await supabase.rpc('pos_open_bill_summaries', { p_branch_id: branchId })
  if (error) fail(error)
  return parseBillSummaries(data)
}

/** The bill an order landed on, by the id this iPad gave it; null while it has not reached the
 *  server (still in this iPad's queue). Send & pay uses it to open Payment on the right bill. */
export async function fetchOrderBillId(clientOrderId: string): Promise<string | null> {
  const { data, error } = await supabase.from('orders').select('bill_id').eq('client_order_id', clientOrderId).maybeSingle()
  if (error) fail(error)
  return (data as { bill_id: string } | null)?.bill_id ?? null
}

/** SST rate, packaging fee and photo of every orderable product (padInfo.ts), read 1000 rows at a
 *  time so PostgREST's row cap never cuts the list short. */
export async function fetchPadProductInfo(): Promise<Map<string, PadProductInfo>> {
  const rows: PadProductRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('menu_products')
      .select('id, sst_rate_bp, takeaway_fee_sen, image_path, image_updated_at')
      .eq('is_active', true).eq('is_addon', false).order('id').range(from, from + 999)
    if (error) fail(error)
    const page = (data ?? []) as PadProductRow[]
    rows.push(...page)
    if (page.length < 1000) break
  }
  return padProductInfo(rows, productThumbUrl)
}
```

- [ ] **Step 11: Add `setBillPax` to `checkoutApi.ts`**

Insert directly above `export async function openTable(`:

```ts
/** Change the guests of an open dine-in bill (pos_set_bill_pax: 1–99, staff of its branch). */
export async function setBillPax(billId: string, pax: number): Promise<void> {
  const { error } = await supabase.rpc('pos_set_bill_pax', { p_bill_id: billId, p_pax: pax })
  if (error) fail(error)
}
```

- [ ] **Step 12: Fix the table fixture**

In `src/features/pos/order/tableStatus.test.ts` replace the `t` helper with:

```ts
const t = (id: string, label: string, paused = false) => ({ id, label, qr_token: 'x', qr_paused: paused, is_active: true, sort_order: 0, area: null })
```

- [ ] **Step 13: Typecheck and run the touched tests**

Run: `npx tsc -b && npx vitest run src/features/pos/sqlSafeUpdate.test.ts src/features/pos/order/`
Expected: tsc prints nothing; all tests PASS.

- [ ] **Step 14: Commit**

```bash
git add supabase/migration-2026-10-26-pos-frontend.sql supabase/migration-2026-10-26-pos-frontend-verify.sql \
  src/features/pos/sqlSafeUpdate.test.ts src/features/pos/order/billSummaries.ts src/features/pos/order/billSummaries.test.ts \
  src/features/pos/order/padInfo.ts src/features/pos/order/padInfo.test.ts src/features/pos/order/posApi.ts \
  src/features/pos/checkout/checkoutApi.ts src/features/pos/order/tableStatus.test.ts
git commit -m "feat(pos): table areas, open bill summaries and bill pax (SQL + client fetchers)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 15: Controller applies the migration and verify on craft-os-dev**

Not for the implementer: the controller runs `migration-2026-10-26-pos-frontend.sql`, then `migration-2026-10-26-pos-frontend-verify.sql` (expects the result row `VERIFY OK`), on craft-os-dev out of band. Tasks 2–10 do not need the database; Task 12's browser check does.

---

### Task 2: Home and navigation helpers

**Files:**
- Create: `src/features/pos/order/home.ts`, Test: `src/features/pos/order/home.test.ts`
- Create: `src/features/pos/order/orderTarget.ts`, Test: `src/features/pos/order/orderTarget.test.ts`
- Create: `src/features/pos/order/moveTargets.ts`, Test: `src/features/pos/order/moveTargets.test.ts`
- Create: `src/features/pos/shell/shellMenu.ts`, Test: `src/features/pos/shell/shellMenu.test.ts`

**Interfaces:**
- Consumes: `TableRow`, `OpenBillRow` (posApi.ts), `BillSummary` (Task 1), `OrderType` (offline/orderQueue.ts).
- Produces:
  - home.ts: `interface AreaTab { area: string | null; label: string; openCount: number }`, `areaTabs(tables: TableRow[], bills: OpenBillRow[]): AreaTab[]`, `currentArea(tabs: AreaTab[], area: string | null): string | null`, `visibleTables(tables: TableRow[], area: string | null, search: string): TableRow[]`, `elapsedLabel(openedAtIso: string, nowMs: number): string`
  - orderTarget.ts: `type OrderTarget = { kind: 'table'; tableId: string; pax: number | null } | { kind: 'takeaway'; billId: string | null }`, `targetOrderType(t): OrderType`, `targetBill(t, bills): OpenBillRow | null`, `takesNewItems(t): boolean`, `TAKEAWAY_ONE_ORDER: string`, `shownPax(t, bill): number | null`, `billTitle(tableId: string | null, billNo: string | null, tables): string`, `targetTitle(t, bill, tables): string`
  - moveTargets.ts: `type MoveTarget = { tableId; label; kind: 'move' } | { tableId; label; kind: 'merge'; intoBillId: string; intoBillNo: string; totalSen: number | null } | { tableId; label; kind: 'refused'; reason: string }`, `TAKEAWAY_NEEDS_OCCUPIED`, `moveTargets(from: Pick<OpenBillRow, 'table_id' | 'order_type'>, tables, bills, summaries): MoveTarget[]`
  - shellMenu.ts: `type MenuItem = 'order' | 'menu' | 'transaction' | 'report' | 'setting'`, `MENU_LABEL: Record<MenuItem, string>`, `menuItems(caps: { manageMenu: boolean; supervise: boolean; settings: boolean }): MenuItem[]`, `mytClock(nowMs: number): string`

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/order/home.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { areaTabs, currentArea, elapsedLabel, visibleTables } from './home'
import type { OpenBillRow, TableRow } from './posApi'

const t = (id: string, label: string, area: string | null, sort_order: number): TableRow =>
  ({ id, label, area, sort_order, qr_token: 'x', qr_paused: false, is_active: true })
const bill = (id: string, table_id: string | null): OpenBillRow =>
  ({ id, bill_no: `261026-${id}`, table_id, order_type: table_id ? 'dine_in' : 'takeaway', pax: 2, opened_at: '2026-10-26T02:00:00Z' })

const tables = [
  t('a1', 'A1', 'Indoor', 1), t('a2', 'A2', 'Indoor', 2), t('b1', 'B1', 'Patio', 3),
  t('c1', 'C1', null, 4), t('z1', 'Z1', 'Bar', 0),
]

describe('areaTabs', () => {
  it('All first, then areas in table order, each counting its tables with an open bill', () => {
    const tabs = areaTabs(tables, [bill('1', 'a2'), bill('2', 'c1'), bill('3', null), bill('4', 'b1')])
    expect(tabs).toEqual([
      { area: null, label: 'All', openCount: 3 },
      { area: 'Bar', label: 'Bar', openCount: 0 },
      { area: 'Indoor', label: 'Indoor', openCount: 1 },
      { area: 'Patio', label: 'Patio', openCount: 1 },
    ])
  })
  it('ties on sort order go by area name; no areas = All only', () => {
    expect(areaTabs([t('x', 'X', 'Zeta', 1), t('y', 'Y', 'Alpha', 1)], []).map((a) => a.label)).toEqual(['All', 'Alpha', 'Zeta'])
    expect(areaTabs([t('c1', 'C1', null, 1)], [])).toEqual([{ area: null, label: 'All', openCount: 0 }])
  })
})

describe('currentArea', () => {
  it('keeps a tab that exists and falls back to All otherwise', () => {
    const tabs = areaTabs(tables, [])
    expect(currentArea(tabs, 'Patio')).toBe('Patio')
    expect(currentArea(tabs, 'Garden')).toBeNull()
  })
})

describe('visibleTables', () => {
  it('All shows every table; an area shows only its own', () => {
    expect(visibleTables(tables, null, '').map((x) => x.label)).toEqual(['A1', 'A2', 'B1', 'C1', 'Z1'])
    expect(visibleTables(tables, 'Indoor', '').map((x) => x.label)).toEqual(['A1', 'A2'])
  })
  it('a search looks at every label in any case, whatever the tab', () => {
    expect(visibleTables(tables, 'Indoor', ' b ').map((x) => x.label)).toEqual(['B1'])
  })
})

describe('elapsedLabel', () => {
  const opened = '2026-10-26T02:00:00Z'
  const at = (min: number) => Date.parse(opened) + min * 60_000
  it('minutes under an hour, hours and two-digit minutes from an hour', () => {
    expect(elapsedLabel(opened, at(0))).toBe('0m')
    expect(elapsedLabel(opened, at(12) + 59_000)).toBe('12m')
    expect(elapsedLabel(opened, at(59))).toBe('59m')
    expect(elapsedLabel(opened, at(65))).toBe('1h 05m')
    expect(elapsedLabel(opened, at(120))).toBe('2h 00m')
  })
  it('a clock a little behind the server never shows a negative time', () => {
    expect(elapsedLabel(opened, at(-2))).toBe('0m')
  })
})
```

Create `src/features/pos/order/orderTarget.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { billTitle, shownPax, takesNewItems, targetBill, targetOrderType, targetTitle } from './orderTarget'
import type { OpenBillRow } from './posApi'

const bill = (id: string, table_id: string | null, pax: number | null = null): OpenBillRow =>
  ({ id, bill_no: `261026-${id}`, table_id, order_type: table_id ? 'dine_in' : 'takeaway', pax, opened_at: '2026-10-26T02:00:00Z' })
const bills = [bill('001', 't1', 4), bill('002', null)]
const tables = [{ id: 't1', label: 'T1' }, { id: 't2', label: 'T2' }]

describe('order targets', () => {
  it('a table is dine-in on its open bill; a takeaway on its own bill', () => {
    expect(targetOrderType({ kind: 'table', tableId: 't1', pax: null })).toBe('dine_in')
    expect(targetOrderType({ kind: 'takeaway', billId: null })).toBe('takeaway')
    expect(targetBill({ kind: 'table', tableId: 't1', pax: null }, bills)?.id).toBe('001')
    expect(targetBill({ kind: 'table', tableId: 't2', pax: 2 }, bills)).toBeNull()
    expect(targetBill({ kind: 'takeaway', billId: '002' }, bills)?.id).toBe('002')
    expect(targetBill({ kind: 'takeaway', billId: 'gone' }, bills)).toBeNull()
    expect(targetBill({ kind: 'takeaway', billId: null }, bills)).toBeNull()
  })
  it('only an open takeaway bill refuses new items', () => {
    expect(takesNewItems({ kind: 'table', tableId: 't1', pax: null })).toBe(true)
    expect(takesNewItems({ kind: 'takeaway', billId: null })).toBe(true)
    expect(takesNewItems({ kind: 'takeaway', billId: '002' })).toBe(false)
  })
  it('pax: the bill\'s, else the one chosen for an empty table', () => {
    expect(shownPax({ kind: 'table', tableId: 't1', pax: 2 }, bills[0])).toBe(4)
    expect(shownPax({ kind: 'table', tableId: 't2', pax: 2 }, null)).toBe(2)
    expect(shownPax({ kind: 'takeaway', billId: '002' }, bills[1])).toBeNull()
  })
  it('titles', () => {
    expect(billTitle('t1', '261026-001', tables)).toBe('Table T1')
    expect(billTitle('gone', null, tables)).toBe('Table ?')
    expect(billTitle(null, '261026-002', tables)).toBe('Takeaway 261026-002')
    expect(targetTitle({ kind: 'takeaway', billId: null }, null, tables)).toBe('New takeaway')
    expect(targetTitle({ kind: 'table', tableId: 't2', pax: 3 }, null, tables)).toBe('Table T2')
  })
})
```

Create `src/features/pos/order/moveTargets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { moveTargets, TAKEAWAY_NEEDS_OCCUPIED } from './moveTargets'
import type { OpenBillRow, TableRow } from './posApi'

const t = (id: string): TableRow => ({ id, label: id.toUpperCase(), area: null, sort_order: 0, qr_token: 'x', qr_paused: false, is_active: true })
const bill = (id: string, table_id: string | null): OpenBillRow =>
  ({ id, bill_no: `B-${id}`, table_id, order_type: table_id ? 'dine_in' : 'takeaway', pax: null, opened_at: '2026-10-26T02:00:00Z' })
const tables = [t('t1'), t('t2'), t('t3')]
const bills = [bill('b1', 't1'), bill('b3', 't3'), bill('bt', null)]
const summaries = new Map([['b3', { billId: 'b3', totalSen: 10670, itemCount: 3 }]])

describe('moveTargets', () => {
  it('from a table bill: empty tables move, occupied tables merge; its own table is not listed', () => {
    expect(moveTargets(bills[0], tables, bills, summaries)).toEqual([
      { tableId: 't2', label: 'T2', kind: 'move' },
      { tableId: 't3', label: 'T3', kind: 'merge', intoBillId: 'b3', intoBillNo: 'B-b3', totalSen: 10670 },
    ])
  })
  it('from a takeaway bill: only occupied tables, by merging; empty ones are refused with the reason', () => {
    expect(moveTargets(bills[2], tables, bills, summaries)).toEqual([
      { tableId: 't1', label: 'T1', kind: 'merge', intoBillId: 'b1', intoBillNo: 'B-b1', totalSen: null },
      { tableId: 't2', label: 'T2', kind: 'refused', reason: TAKEAWAY_NEEDS_OCCUPIED },
      { tableId: 't3', label: 'T3', kind: 'merge', intoBillId: 'b3', intoBillNo: 'B-b3', totalSen: 10670 },
    ])
  })
})
```

Create `src/features/pos/shell/shellMenu.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { menuItems, mytClock } from './shellMenu'

describe('menuItems', () => {
  it('everything for a manager', () => {
    expect(menuItems({ manageMenu: true, supervise: true, settings: true })).toEqual(['order', 'menu', 'transaction', 'report', 'setting'])
  })
  it('a cashier sees Order and Transaction only', () => {
    expect(menuItems({ manageMenu: false, supervise: false, settings: false })).toEqual(['order', 'transaction'])
  })
  it('a supervisor without settings gets Report but not Setting', () => {
    expect(menuItems({ manageMenu: false, supervise: true, settings: false })).toEqual(['order', 'transaction', 'report'])
  })
})

describe('mytClock', () => {
  it('is Malaysia time, 24-hour, two digits', () => {
    expect(mytClock(Date.parse('2026-10-26T01:05:00Z'))).toBe('09:05')
    expect(mytClock(Date.parse('2026-10-26T15:59:59Z'))).toBe('23:59')
    expect(mytClock(Date.parse('2026-10-26T16:00:00Z'))).toBe('00:00')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/pos/order/home.test.ts src/features/pos/order/orderTarget.test.ts src/features/pos/order/moveTargets.test.ts src/features/pos/shell/shellMenu.test.ts`
Expected: FAIL — `Failed to resolve import` for `./home`, `./orderTarget`, `./moveTargets` and `./shellMenu`.

- [ ] **Step 3: Implement the helpers**

Create `src/features/pos/order/home.ts`:

```ts
// src/features/pos/order/home.ts
/** The home screen's pure rules (spec §1): the area tabs, which tables a tab or the search
 *  shows, and how long a bill has been open. */
import type { OpenBillRow, TableRow } from './posApi'

/** One area tab. `area` null = All. `openCount` = tables of the tab that have an open bill. */
export interface AreaTab { area: string | null; label: string; openCount: number }

/** All first, then one tab per area in table order: an area sits where its lowest sort_order
 *  is (ties by name). A table with no area is only under All. */
export function areaTabs(tables: TableRow[], bills: OpenBillRow[]): AreaTab[] {
  const busy = new Set(bills.flatMap((b) => (b.table_id ? [b.table_id] : [])))
  const areas = new Map<string, { sort: number; open: number }>()
  for (const t of tables) {
    if (!t.area) continue
    const a = areas.get(t.area) ?? { sort: t.sort_order, open: 0 }
    a.sort = Math.min(a.sort, t.sort_order)
    if (busy.has(t.id)) a.open++
    areas.set(t.area, a)
  }
  return [
    { area: null, label: 'All', openCount: tables.filter((t) => busy.has(t.id)).length },
    ...[...areas.entries()]
      .sort((x, y) => x[1].sort - y[1].sort || x[0].localeCompare(y[0]))
      .map(([area, a]) => ({ area, label: area, openCount: a.open })),
  ]
}

/** A tab that no longer exists (its last table moved to another area) falls back to All. */
export function currentArea(tabs: AreaTab[], area: string | null): string | null {
  return tabs.some((t) => t.area === area) ? area : null
}

/** The tables the tab shows. A search (on the label, any case) looks in every area, so a table
 *  is found from whichever tab is open. */
export function visibleTables(tables: TableRow[], area: string | null, search: string): TableRow[] {
  const q = search.trim().toLowerCase()
  if (q) return tables.filter((t) => t.label.toLowerCase().includes(q))
  return area === null ? tables : tables.filter((t) => t.area === area)
}

/** "12m" under an hour, "1h 05m" from an hour; never negative (an iPad clock a little behind). */
export function elapsedLabel(openedAtIso: string, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - Date.parse(openedAtIso)) / 60_000))
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
}
```

Create `src/features/pos/order/orderTarget.ts`:

```ts
// src/features/pos/order/orderTarget.ts
/** What the order screen is open on (spec §2). */
import type { OrderType } from '../offline/orderQueue'
import type { OpenBillRow, TableRow } from './posApi'

/** A table: its open bill when it has one; with none yet, `pax` is what the cashier chose in
 *  Select pax and goes with the first order (no bill exists before that, as today). A takeaway:
 *  an open takeaway bill, or `billId` null for a new takeaway order. */
export type OrderTarget =
  | { kind: 'table'; tableId: string; pax: number | null }
  | { kind: 'takeaway'; billId: string | null }

export const targetOrderType = (t: OrderTarget): OrderType => (t.kind === 'table' ? 'dine_in' : 'takeaway')

/** The open bill the target is on, or null (an empty table, a new takeaway, a bill closed meanwhile). */
export function targetBill(t: OrderTarget, bills: OpenBillRow[]): OpenBillRow | null {
  if (t.kind === 'table') return bills.find((b) => b.table_id === t.tableId) ?? null
  return t.billId ? bills.find((b) => b.id === t.billId) ?? null : null
}

/** pos_insert_order opens a new bill for every takeaway order, so an open takeaway bill takes no
 *  more items: its drafts would land on a second bill. */
export const takesNewItems = (t: OrderTarget): boolean => !(t.kind === 'takeaway' && t.billId !== null)
export const TAKEAWAY_ONE_ORDER = 'A takeaway bill takes one order. For more items, start a new takeaway from the home screen.'

/** The pax to show: the bill's, else what Select pax chose for a table with no bill yet. */
export const shownPax = (t: OrderTarget, bill: OpenBillRow | null): number | null =>
  bill?.pax ?? (t.kind === 'table' ? t.pax : null)

/** "Table T3", "Takeaway 261026-004" or "New takeaway". */
export function billTitle(tableId: string | null, billNo: string | null, tables: Pick<TableRow, 'id' | 'label'>[]): string {
  if (tableId) return `Table ${tables.find((t) => t.id === tableId)?.label ?? '?'}`
  return billNo ? `Takeaway ${billNo}` : 'New takeaway'
}

export const targetTitle = (t: OrderTarget, bill: OpenBillRow | null, tables: Pick<TableRow, 'id' | 'label'>[]): string =>
  billTitle(t.kind === 'table' ? t.tableId : null, bill?.bill_no ?? null, tables)
```

Create `src/features/pos/order/moveTargets.ts`:

```ts
// src/features/pos/order/moveTargets.ts
/** The Move to grid (spec §3): every other active table with what tapping it does. */
import type { BillSummary } from './billSummaries'
import type { OpenBillRow, TableRow } from './posApi'

export type MoveTarget =
  | { tableId: string; label: string; kind: 'move' }
  | { tableId: string; label: string; kind: 'merge'; intoBillId: string; intoBillNo: string; totalSen: number | null }
  | { tableId: string; label: string; kind: 'refused'; reason: string }

export const TAKEAWAY_NEEDS_OCCUPIED = 'A takeaway bill can only be merged into a table with a bill'

/** An empty table takes a table's bill (move_bill). An occupied table merges this bill into its
 *  bill (merge_bills from this bill into that one). A takeaway bill cannot sit on an empty table,
 *  only merge into an occupied one. Takeaway bills are never targets, and the bill's own table
 *  is not listed. `totalSen` is the target bill's total from pos_open_bill_summaries. */
export function moveTargets(
  from: Pick<OpenBillRow, 'table_id' | 'order_type'>,
  tables: TableRow[], bills: OpenBillRow[], summaries: ReadonlyMap<string, BillSummary>,
): MoveTarget[] {
  const byTable = new Map(bills.flatMap((b) => (b.table_id ? [[b.table_id, b] as const] : [])))
  return tables.filter((t) => t.id !== from.table_id).map((t): MoveTarget => {
    const there = byTable.get(t.id)
    if (there) {
      return { tableId: t.id, label: t.label, kind: 'merge', intoBillId: there.id, intoBillNo: there.bill_no, totalSen: summaries.get(there.id)?.totalSen ?? null }
    }
    if (from.order_type === 'takeaway') return { tableId: t.id, label: t.label, kind: 'refused', reason: TAKEAWAY_NEEDS_OCCUPIED }
    return { tableId: t.id, label: t.label, kind: 'move' }
  })
}
```

Create `src/features/pos/shell/shellMenu.ts`:

```ts
// src/features/pos/shell/shellMenu.ts
/** The bottom bar's grid menu and clock (spec §1). */

export type MenuItem = 'order' | 'menu' | 'transaction' | 'report' | 'setting'

export const MENU_LABEL: Record<MenuItem, string> = {
  order: 'Order', menu: 'Menu', transaction: 'Transaction', report: 'Report', setting: 'Setting',
}

/** Menu is the menu back office (/menu needs manage_menu); Report is the closed shifts and
 *  their Z reports (pos_supervise, as the old Shifts button); Setting is /pos/settings
 *  (access_settings). Each is shown only to those its page lets in. */
export function menuItems(caps: { manageMenu: boolean; supervise: boolean; settings: boolean }): MenuItem[] {
  const all: MenuItem[] = ['order', 'menu', 'transaction', 'report', 'setting']
  return all.filter((i) => (i !== 'menu' || caps.manageMenu) && (i !== 'report' || caps.supervise) && (i !== 'setting' || caps.settings))
}

/** "09:05" on the Malaysia clock (UTC+8, no daylight saving), whatever the iPad's time zone. */
export function mytClock(nowMs: number): string {
  const d = new Date(nowMs + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/features/pos/order/home.test.ts src/features/pos/order/orderTarget.test.ts src/features/pos/order/moveTargets.test.ts src/features/pos/shell/shellMenu.test.ts`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/order/home.ts src/features/pos/order/home.test.ts src/features/pos/order/orderTarget.ts \
  src/features/pos/order/orderTarget.test.ts src/features/pos/order/moveTargets.ts src/features/pos/order/moveTargets.test.ts \
  src/features/pos/shell/shellMenu.ts src/features/pos/shell/shellMenu.test.ts
git commit -m "feat(pos): home, order target, move-to and grid menu rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Order screen helpers — bill view model, modifiers, bill actions

**Files:**
- Create: `src/features/pos/order/billView.ts`, Test: `src/features/pos/order/billView.test.ts`
- Create: `src/features/pos/order/modifiers.ts`, Test: `src/features/pos/order/modifiers.test.ts`
- Create: `src/features/pos/order/billActions.ts`, Test: `src/features/pos/order/billActions.test.ts`

**Interfaces:**
- Consumes: `computeBill`, `BillLineInput`, `BillTotals` (checkout/bill.ts); `BillingConfig`, `DEFAULT_POS_SETTINGS` (checkoutApi.ts); `findProduct`, `lineLabel`, `linePriceSen`, `OrderLine`, `PosMenu`, `PosGroup` (cart.ts); `PadProductInfo` (Task 1); `BillItemRow` (posApi.ts).
- Produces:
  - billView.ts: `interface SentRow { item: BillItemRow; qty; name; mods: string[]; note; amountSen; voided }`, `interface DraftRow { index; line: OrderLine; qty; name; mods; note; unitSen: number | null }`, `interface BillView { sent; drafts; liveSentCount; draftCount; totals: BillTotals | null; totalsIncludeDrafts: boolean }`, `billView(i: BillViewInput): BillView` where `BillViewInput = { orderType; tableId; items; lines; menu; info; billing }`; `type PayGate = 'no_shift' | 'send_first' | 'empty' | 'ready'`, `payGate(p: { shiftOpen: boolean | null; draftCount: number; hasBill: boolean; liveSentCount: number }): PayGate`; `NO_SHIFT_PAY`, `itemsWord(n)`, `sendFirstQuestion(n)`, `discardQuestion(n)`, `QUEUED_NOT_SENT`
  - modifiers.ts: `groupBadge(g: Pick<PosGroup, 'min' | 'max'>): { text: string; required: boolean }`, `toggleOption(line: OrderLine, groupMax: number, groupOptionIds: string[], id: string): OrderLine`, `tileInitials(name: string): string`
  - billActions.ts: `type BillAction = 'send' | 'move' | 'void_bill' | 'close_empty' | 'pax' | 'pause_qr' | 'resume_qr' | 'open_qr'`, `BILL_ACTION_LABEL`, `billActions(p: { isTable; hasBill; loaded; liveSentCount; draftCount; qrPaused; qrRequiresOpenBill }): BillAction[]`

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/order/billView.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { billView, discardQuestion, itemsWord, payGate, sendFirstQuestion } from './billView'
import type { BillingConfig } from '../checkout/checkoutApi'
import { DEFAULT_POS_SETTINGS } from '../checkout/checkoutApi'
import type { PosMenu } from './cart'
import type { BillItemRow } from './posApi'
import type { PadProductInfo } from './padInfo'

const billing: BillingConfig = { settings: { ...DEFAULT_POS_SETTINGS, sstRegistered: true, cashRounding: 'nearest_5_sen' }, rules: [] }
const menu: PosMenu = { categories: [{ name: 'FOOD', products: [{
  id: 'p1', name: 'Nasi Lemak', description: null, soldOut: false,
  variants: [{ id: 'v1', name: 'Regular', priceSen: 500, isBase: true }],
  groups: [{ id: 'g1', name: 'Add-on', min: 0, max: 2, options: [{ id: 'o1', name: 'Egg', priceDeltaSen: 200, isDefault: false, available: true }] }],
}] }] }
const info = new Map<string, PadProductInfo>([['p1', { sstRateBp: 600, takeawayFeeSen: 100, imageUrl: null }]])
const item = (id: string, voided = false): BillItemRow => ({
  id, order_id: 'o-1', product_id: 'p1', name_snapshot: 'Nasi Lemak', unit_price_sen: 1000, sst_rate_bp: 600, takeaway_fee_sen: 0,
  order_type: 'dine_in', qty: 2, note: 'less spicy', modifiers_snapshot: [{ name: 'Egg' }], voided_at: voided ? '2026-10-26T03:00:00Z' : null,
  orders: { order_no: '1', source: 'counter', placed_at: '2026-10-26T02:00:00Z' },
})
const draft = { productId: 'p1', variantId: 'v1', qty: 1, note: null, optionIds: ['o1'] }

describe('billView', () => {
  it('lists sent items with their modifiers and note, and drafts priced from the menu', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1'), item('i2', true)], lines: [draft], menu, info, billing })
    expect(v.sent.map((s) => [s.name, s.qty, s.mods, s.note, s.amountSen, s.voided])).toEqual([
      ['Nasi Lemak', 2, ['Egg'], 'less spicy', 2000, false],
      ['Nasi Lemak', 2, ['Egg'], 'less spicy', 2000, true],
    ])
    expect(v.drafts.map((d) => [d.index, d.name, d.mods, d.unitSen])).toEqual([[0, 'Nasi Lemak', ['Egg'], 700]])
    expect(v.liveSentCount).toBe(2)
    expect(v.draftCount).toBe(1)
  })
  it('counts drafts in the preview with the server\'s rules (dine-in: no packaging fee)', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1')], lines: [draft], menu, info, billing })
    // 20.00 + 7.00 = 27.00, SST 6% 1.62 = 28.62 → 28.60
    expect(v.totalsIncludeDrafts).toBe(true)
    expect([v.totals?.subtotalSen, v.totals?.sstSen, v.totals?.totalSen]).toEqual([2700, 162, 2860])
  })
  it('a takeaway draft carries its packaging fee, taxed at its SST rate', () => {
    const v = billView({ orderType: 'takeaway', tableId: null, items: [], lines: [draft], menu, info, billing })
    // 7.00 + fee 1.00, SST 6% of 8.00 = 0.48 → 8.48 → 8.50
    expect([v.totals?.subtotalSen, v.totals?.takeawayFeeSen, v.totals?.sstSen, v.totals?.totalSen]).toEqual([700, 100, 48, 850])
  })
  it('without a product\'s SST rate the preview leaves every draft out and says so', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1')], lines: [draft], menu, info: new Map(), billing })
    expect(v.totalsIncludeDrafts).toBe(false)
    expect(v.totals?.totalSen).toBe(2120)
  })
  it('a draft the menu no longer has is shown as unavailable and not priced', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [], lines: [{ ...draft, productId: 'gone' }], menu, info, billing })
    expect(v.drafts[0]).toMatchObject({ name: 'Unavailable item', unitSen: null })
    expect(v.totalsIncludeDrafts).toBe(false)
  })
  it('no billing config yet: no totals', () => {
    expect(billView({ orderType: 'dine_in', tableId: 't1', items: [item('i1')], lines: [], menu, info, billing: null }).totals).toBeNull()
  })
})

describe('payGate', () => {
  const base = { shiftOpen: true, draftCount: 0, hasBill: true, liveSentCount: 2 }
  it('no open shift (or not known yet) disables Payment first of all', () => {
    expect(payGate({ ...base, shiftOpen: false })).toBe('no_shift')
    expect(payGate({ ...base, shiftOpen: null, draftCount: 3 })).toBe('no_shift')
  })
  it('drafts are sent first, even on a table with no bill yet', () => {
    expect(payGate({ ...base, draftCount: 1 })).toBe('send_first')
    expect(payGate({ ...base, draftCount: 1, hasBill: false, liveSentCount: 0 })).toBe('send_first')
  })
  it('a bill with nothing live cannot be paid; otherwise it is ready', () => {
    expect(payGate({ ...base, liveSentCount: 0 })).toBe('empty')
    expect(payGate({ ...base, hasBill: false })).toBe('empty')
    expect(payGate(base)).toBe('ready')
  })
})

describe('words', () => {
  it('singular and plural', () => {
    expect(itemsWord(1)).toBe('1 item')
    expect(itemsWord(3)).toBe('3 items')
    expect(sendFirstQuestion(1)).toBe('Send 1 new item first?')
    expect(sendFirstQuestion(4)).toBe('Send 4 new items first?')
    expect(discardQuestion(2)).toBe('Discard 2 unsent items?')
  })
})
```

Create `src/features/pos/order/modifiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { groupBadge, tileInitials, toggleOption } from './modifiers'

describe('groupBadge', () => {
  it('required groups say how many to select', () => {
    expect(groupBadge({ min: 1, max: 1 })).toEqual({ text: 'SELECT 1', required: true })
    expect(groupBadge({ min: 1, max: 2 })).toEqual({ text: 'SELECT 1–2', required: true })
  })
  it('optional groups say so', () => {
    expect(groupBadge({ min: 0, max: 1 })).toEqual({ text: 'OPTIONAL', required: false })
    expect(groupBadge({ min: 0, max: 3 })).toEqual({ text: 'UP TO 3', required: false })
  })
})

describe('toggleOption', () => {
  const line = { productId: 'p', variantId: 'v', qty: 1, note: null, optionIds: ['x1'] }
  const ice = ['i1', 'i2']
  it('a one-choice group swaps its choice, and a second tap clears it; other groups keep theirs', () => {
    const a = toggleOption(line, 1, ice, 'i1')
    expect(a.optionIds).toEqual(['x1', 'i1'])
    expect(toggleOption(a, 1, ice, 'i2').optionIds).toEqual(['x1', 'i2'])
    expect(toggleOption(a, 1, ice, 'i1').optionIds).toEqual(['x1'])
  })
  it('a many-choice group adds and removes', () => {
    const a = toggleOption(line, 3, ice, 'i1')
    const b = toggleOption(a, 3, ice, 'i2')
    expect(b.optionIds).toEqual(['x1', 'i1', 'i2'])
    expect(toggleOption(b, 3, ice, 'i1').optionIds).toEqual(['x1', 'i2'])
  })
})

describe('tileInitials', () => {
  it('the first three letters, spaces left out', () => {
    expect(tileInitials('Custom Cake')).toBe('Cus')
    expect(tileInitials('  Iced Latte')).toBe('Ice')
    expect(tileInitials('Te')).toBe('Te')
  })
})
```

Create `src/features/pos/order/billActions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { billActions } from './billActions'

const table = { isTable: true, hasBill: true, loaded: true, liveSentCount: 2, draftCount: 0, qrPaused: false, qrRequiresOpenBill: false }

describe('billActions', () => {
  it('a table bill with items: Move, Void bill, Pax, Pause QR', () => {
    expect(billActions(table)).toEqual(['move', 'void_bill', 'pax', 'pause_qr'])
  })
  it('drafts add Send first; a bill with nothing live offers Close empty bill instead of Void bill', () => {
    expect(billActions({ ...table, draftCount: 2, liveSentCount: 0 })).toEqual(['send', 'move', 'close_empty', 'pax', 'pause_qr'])
  })
  it('neither void nor close before the items are loaded', () => {
    expect(billActions({ ...table, loaded: false })).toEqual(['move', 'pax', 'pause_qr'])
  })
  it('an empty table: Pax and the QR switches; Open for QR only when QR waits for an open bill', () => {
    const empty = { ...table, hasBill: false, liveSentCount: 0, qrPaused: true }
    expect(billActions(empty)).toEqual(['pax', 'resume_qr'])
    expect(billActions({ ...empty, qrRequiresOpenBill: true })).toEqual(['pax', 'resume_qr', 'open_qr'])
  })
  it('a takeaway bill: Move and Void bill only', () => {
    expect(billActions({ ...table, isTable: false })).toEqual(['move', 'void_bill'])
    expect(billActions({ ...table, isTable: false, hasBill: false, draftCount: 1 })).toEqual(['send'])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/pos/order/billView.test.ts src/features/pos/order/modifiers.test.ts src/features/pos/order/billActions.test.ts`
Expected: FAIL — `Failed to resolve import` for `./billView`, `./modifiers` and `./billActions`.

- [ ] **Step 3: Implement the helpers**

Create `src/features/pos/order/billView.ts`:

```ts
// src/features/pos/order/billView.ts
/** The order screen's bill column (spec §2): the sent items from the server, the drafts (the
 *  cart) under them, and the instant totals preview. The server's totals stay the truth: the
 *  Payment screen shows pos_checkout_state's numbers, the tiles pos_open_bill_summaries'. */
import { computeBill, type BillLineInput, type BillTotals } from '../checkout/bill'
import type { BillingConfig } from '../checkout/checkoutApi'
import type { OrderType } from '../offline/orderQueue'
import { findProduct, lineLabel, linePriceSen, type OrderLine, type PosMenu } from './cart'
import type { PadProductInfo } from './padInfo'
import type { BillItemRow } from './posApi'

export interface SentRow { item: BillItemRow; qty: number; name: string; mods: string[]; note: string | null; amountSen: number; voided: boolean }
export interface DraftRow {
  index: number                 // position in the cart
  line: OrderLine
  qty: number
  name: string                  // 'Unavailable item' when the menu does not have it
  mods: string[]
  note: string | null
  unitSen: number | null        // null = not priced (unavailable)
}
export interface BillView {
  sent: SentRow[]
  drafts: DraftRow[]
  liveSentCount: number         // qty of sent items not voided
  draftCount: number            // qty of all draft lines
  totals: BillTotals | null     // null until the branch's billing config is loaded
  totalsIncludeDrafts: boolean  // false when a draft could not be priced (then only sent items count)
}
export interface BillViewInput {
  orderType: OrderType
  tableId: string | null
  items: BillItemRow[]
  lines: OrderLine[]
  menu: PosMenu | null
  info: ReadonlyMap<string, PadProductInfo>
  billing: BillingConfig | null
}

export function billView(i: BillViewInput): BillView {
  const sent: SentRow[] = i.items.map((it) => ({
    item: it, qty: it.qty, name: it.name_snapshot, mods: it.modifiers_snapshot.map((m) => m.name), note: it.note,
    amountSen: it.unit_price_sen * it.qty, voided: it.voided_at !== null,
  }))
  const drafts: DraftRow[] = i.lines.map((line, index) => {
    const p = i.menu ? findProduct(i.menu, line.productId) : undefined
    if (!p) return { index, line, qty: line.qty, name: 'Unavailable item', mods: [], note: line.note, unitSen: null }
    const { name, mods } = lineLabel(p, line)
    return { index, line, qty: line.qty, name, mods, note: line.note, unitSen: linePriceSen(p, line) }
  })
  const sentLines: BillLineInput[] = i.items.map((it) => ({
    productId: it.product_id, unitPriceSen: it.unit_price_sen, qty: it.qty, sstRateBp: it.sst_rate_bp,
    takeawayFeeSen: it.takeaway_fee_sen, voided: it.voided_at !== null, orderType: it.order_type,
  }))
  // a draft counts like pos_insert_order will snapshot it: its price, its product's SST rate, and
  // the packaging fee on a takeaway order only
  const draftLines: BillLineInput[] = drafts.flatMap((d) => {
    const info = i.info.get(d.line.productId)
    if (d.unitSen === null || !info) return []
    return [{ productId: d.line.productId, unitPriceSen: d.unitSen, qty: d.qty, sstRateBp: info.sstRateBp,
              takeawayFeeSen: i.orderType === 'takeaway' ? info.takeawayFeeSen : 0, voided: false, orderType: i.orderType }]
  })
  const totalsIncludeDrafts = draftLines.length === drafts.length
  const totals = i.billing ? computeBill({
    orderType: i.orderType, tableId: i.tableId,
    sstRegistered: i.billing.settings.sstRegistered, cashRounding: i.billing.settings.cashRounding, rules: i.billing.rules,
    lines: totalsIncludeDrafts ? [...sentLines, ...draftLines] : sentLines,
  }) : null
  return {
    sent, drafts, totals, totalsIncludeDrafts,
    liveSentCount: sent.filter((s) => !s.voided).reduce((n, s) => n + s.qty, 0),
    draftCount: i.lines.reduce((n, l) => n + l.qty, 0),
  }
}

/** What the Payment button does (spec §2 rules), in this order: no open shift → disabled; drafts →
 *  ask "Send n new items first?"; nothing live on the bill → disabled; else open Payment. A shift
 *  that is not known yet counts as not open (nothing that moves money is offered then). */
export type PayGate = 'no_shift' | 'send_first' | 'empty' | 'ready'
export function payGate(p: { shiftOpen: boolean | null; draftCount: number; hasBill: boolean; liveSentCount: number }): PayGate {
  if (p.shiftOpen !== true) return 'no_shift'
  if (p.draftCount > 0) return 'send_first'
  if (!p.hasBill || p.liveSentCount === 0) return 'empty'
  return 'ready'
}

export const NO_SHIFT_PAY = 'Open a shift to take payment'
export const itemsWord = (n: number): string => `${n} item${n === 1 ? '' : 's'}`
export const sendFirstQuestion = (n: number): string => `Send ${n} new item${n === 1 ? '' : 's'} first?`
export const discardQuestion = (n: number): string => `Discard ${n} unsent item${n === 1 ? '' : 's'}?`
/** Send & pay found the order still in this iPad's queue (offline): no bill to pay yet. */
export const QUEUED_NOT_SENT = 'The order is saved on this iPad and will send when the network is back. Take payment once it has arrived.'
```

Create `src/features/pos/order/modifiers.ts`:

```ts
// src/features/pos/order/modifiers.ts
/** Pure parts of the Feedme modifier sheet and product tiles (spec §2). */
import type { OrderLine, PosGroup } from './cart'

/** A required group shows a red "SELECT n" ("SELECT 1–2" for a range); an optional one a grey
 *  "OPTIONAL" or "UP TO n". */
export function groupBadge(g: Pick<PosGroup, 'min' | 'max'>): { text: string; required: boolean } {
  if (g.min > 0) return { text: g.min === g.max ? `SELECT ${g.min}` : `SELECT ${g.min}–${g.max}`, required: true }
  return { text: g.max === 1 ? 'OPTIONAL' : `UP TO ${g.max}`, required: false }
}

/** Tap an option — LineSheet's rule, unchanged: in a one-choice group it takes the place of the
 *  choice (or clears it when tapped again); in a many-choice group it is added or removed. Other
 *  groups keep theirs. validateLine still judges the counts. */
export function toggleOption(line: OrderLine, groupMax: number, groupOptionIds: string[], id: string): OrderLine {
  const inGroup = line.optionIds.filter((x) => groupOptionIds.includes(x))
  const others = line.optionIds.filter((x) => !groupOptionIds.includes(x))
  if (groupMax === 1) return { ...line, optionIds: inGroup[0] === id ? others : [...others, id] }
  return { ...line, optionIds: inGroup.includes(id) ? [...others, ...inGroup.filter((x) => x !== id)] : [...others, ...inGroup, id] }
}

/** A product with no photo shows its first three letters on a grey block (Feedme's "Cus"). */
export function tileInitials(name: string): string {
  return name.replace(/\s+/g, '').slice(0, 3)
}
```

Create `src/features/pos/order/billActions.ts`:

```ts
// src/features/pos/order/billActions.ts
/** The bill actions overlay (spec §3): only what exists for this bill right now, Feedme order. */

export type BillAction = 'send' | 'move' | 'void_bill' | 'close_empty' | 'pax' | 'pause_qr' | 'resume_qr' | 'open_qr'

export const BILL_ACTION_LABEL: Record<BillAction, string> = {
  send: 'Send', move: 'Move', void_bill: 'Void bill', close_empty: 'Close empty bill', pax: 'Pax',
  pause_qr: 'Pause QR', resume_qr: 'Resume QR', open_qr: 'Open for QR',
}

/** Send with drafts; Move with a bill; Void bill when the bill has live items, Close empty bill when
 *  it has none (both only once its items are loaded); on a table: Pax, Pause or Resume QR, and Open
 *  for QR while it has no bill and the branch makes QR wait for an open bill (today's BillPanel). */
export function billActions(p: {
  isTable: boolean; hasBill: boolean; loaded: boolean; liveSentCount: number; draftCount: number
  qrPaused: boolean; qrRequiresOpenBill: boolean
}): BillAction[] {
  const out: BillAction[] = []
  if (p.draftCount > 0) out.push('send')
  if (p.hasBill) out.push('move')
  if (p.hasBill && p.loaded) out.push(p.liveSentCount > 0 ? 'void_bill' : 'close_empty')
  if (p.isTable) {
    out.push('pax', p.qrPaused ? 'resume_qr' : 'pause_qr')
    if (!p.hasBill && p.qrRequiresOpenBill) out.push('open_qr')
  }
  return out
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/features/pos/order/billView.test.ts src/features/pos/order/modifiers.test.ts src/features/pos/order/billActions.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/order/billView.ts src/features/pos/order/billView.test.ts src/features/pos/order/modifiers.ts \
  src/features/pos/order/modifiers.test.ts src/features/pos/order/billActions.ts src/features/pos/order/billActions.test.ts
git commit -m "feat(pos): bill view model with drafts, payment gate, modifier and bill action rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ConfirmDialog and PaxDialog

**Files:**
- Create: `src/features/pos/shell/ConfirmDialog.tsx`, Test: `src/features/pos/shell/ConfirmDialog.test.tsx`
- Create: `src/features/pos/shell/PaxDialog.tsx`, Test: `src/features/pos/shell/PaxDialog.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface ConfirmRequest { title: string; message?: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }`; `default ConfirmDialog(props: { title; message?; confirmLabel; cancelLabel?; danger?; busy?; onConfirm: () => void; onCancel: () => void })` — callers keep a `ConfirmRequest | null` in state and render `<ConfirmDialog {...confirm} onCancel={…} onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />`.
  - `PAX_CHOICES: number[]` (1–20); `default PaxDialog(props: { title: string; current: number | null; onPick: (pax: number) => void; onClose: () => void })`.
  - Layering used by every later task: overlays (grid menu, staff panel, bill actions) `z-30`; sheets and approval / picker dialogs `z-40`; Confirm and Pax `z-50`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/shell/ConfirmDialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfirmDialog from './ConfirmDialog'

afterEach(cleanup)

describe('ConfirmDialog', () => {
  it('asks the question and answers each button once', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog title="Merge into B4?" message="Every item moves onto bill 261026-004." confirmLabel="Merge"
      onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.getByRole('dialog', { name: 'Merge into B4?' })).toBeTruthy()
    expect(screen.getByText('Every item moves onto bill 261026-004.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('a tap outside cancels, a tap inside does not; while busy nothing answers', () => {
    const onCancel = vi.fn()
    const { container, rerender } = render(<ConfirmDialog title="Close bill?" confirmLabel="Close bill" onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('dialog'))
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.click(container.firstChild as Element)
    expect(onCancel).toHaveBeenCalledTimes(1)
    rerender(<ConfirmDialog title="Close bill?" confirmLabel="Close bill" busy onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(container.firstChild as Element)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: 'Close bill' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
```

Create `src/features/pos/shell/PaxDialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import PaxDialog, { PAX_CHOICES } from './PaxDialog'

afterEach(cleanup)

describe('PaxDialog', () => {
  it('offers 1 to 20 and answers the one tapped', () => {
    expect(PAX_CHOICES).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    const onPick = vi.fn()
    render(<PaxDialog title="Table T3" current={null} onPick={onPick} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    expect(onPick).toHaveBeenCalledWith(4)
    expect(screen.getAllByRole('button')).toHaveLength(21)   // 20 numbers + Cancel
  })

  it('marks the current pax, and Cancel closes', () => {
    const onClose = vi.fn()
    render(<PaxDialog title="Table T3" current={6} onPick={() => {}} onClose={onClose} />)
    expect(screen.getByRole('button', { name: '6' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '5' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/pos/shell/ConfirmDialog.test.tsx src/features/pos/shell/PaxDialog.test.tsx`
Expected: FAIL — `Failed to resolve import "./ConfirmDialog"` and `"./PaxDialog"`.

- [ ] **Step 3: Implement the dialogs**

Create `src/features/pos/shell/ConfirmDialog.tsx`:

```tsx
// src/features/pos/shell/ConfirmDialog.tsx
/** The POS's own confirm dialog (spec §3). The built-in browser pane and some iPad states dismiss
 *  window.confirm by themselves, so no POS screen uses it. Callers keep a ConfirmRequest in state
 *  and render this while it is set. */
export interface ConfirmRequest {
  title: string
  message?: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel = 'Cancel', danger = false, busy = false, onConfirm, onCancel }: {
  title: string
  message?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onCancel}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-brown-dark">{title}</h2>
        {message && <p className="mt-1 text-sm text-brown-muted">{message}</p>}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onCancel} disabled={busy}
            className="min-h-12 rounded-xl border border-border-mid text-brown-dark disabled:opacity-40">{cancelLabel}</button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className={`min-h-12 rounded-xl font-medium text-white disabled:opacity-40 ${danger ? 'bg-red-700 hover:bg-red-800' : 'bg-brown-btn hover:bg-brown-btn-hover'}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
```

Create `src/features/pos/shell/PaxDialog.tsx`:

```tsx
// src/features/pos/shell/PaxDialog.tsx
/** Select pax (spec §1): a 1–20 grid, Feedme style. Asked when an empty table is opened, and by
 *  Pax in the bill actions. */
export const PAX_CHOICES: number[] = Array.from({ length: 20 }, (_, i) => i + 1)

export default function PaxDialog({ title, current, onPick, onClose }: {
  title: string                 // "Table T3"
  current: number | null        // highlighted
  onPick: (pax: number) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Select pax" className="w-full max-w-md rounded-2xl bg-card p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-brown-dark">Select pax</h2>
          <span className="text-sm text-brown-muted">{title}</span>
        </div>
        <div className="mt-4 grid grid-cols-5 gap-2">
          {PAX_CHOICES.map((n) => (
            <button key={n} type="button" onClick={() => onPick(n)} aria-pressed={current === n}
              className={`h-14 rounded-xl text-lg font-semibold ${current === n ? 'bg-brown-btn text-white' : 'border border-border-mid bg-canvas text-brown-dark'}`}>
              {n}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="mt-4 min-h-12 w-full rounded-xl border border-border-mid text-brown-dark">Cancel</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/features/pos/shell/ConfirmDialog.test.tsx src/features/pos/shell/PaxDialog.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/shell/ConfirmDialog.tsx src/features/pos/shell/ConfirmDialog.test.tsx \
  src/features/pos/shell/PaxDialog.tsx src/features/pos/shell/PaxDialog.test.tsx
git commit -m "feat(pos): in-app confirm dialog and Select pax dialog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Shell — shift hook, bottom bar, grid menu, staff panel

**Files:**
- Create: `src/features/pos/shift/useShiftOpen.ts`, Test: `src/features/pos/shift/useShiftOpen.test.tsx`
- Modify: `src/features/pos/shift/ShiftBar.tsx` (signature, `closeSheet`, `onOpened`)
- Create: `src/features/pos/shell/BottomBar.tsx`
- Create: `src/features/pos/shell/GridMenu.tsx`
- Create: `src/features/pos/shell/StaffPanel.tsx`

**Interfaces:**
- Consumes: `fetchShiftStatus()` (shiftApi.ts), `useMinuteClock()` (order/useMinuteClock.ts), `mytClock`, `MENU_LABEL`, `MenuItem` (Task 2), `PrintHostPanel`, `ShiftBar`.
- Produces:
  - `useShiftOpen(refreshKey: number): { open: boolean | null; reload: () => void }`
  - `ShiftBar` gains `onChanged?: () => void` (called after a shift opens and whenever its sheet closes).
  - `default BottomBar(props: { title: string; staffName: string; onMenu: () => void; onStaff: () => void })`
  - `default GridMenu(props: { items: MenuItem[]; current: MenuItem | null; onPick: (item: MenuItem) => void; onClose: () => void })`
  - `default StaffPanel(props: { open: boolean; branchId: string; branchName: string; staffName: string; refreshKey: number; liveStatus: string; onShiftChanged: () => void; onMyPin: () => void; onClose: () => void })` — always rendered; `open` only toggles the `hidden` class.

- [ ] **Step 1: Write the failing hook test**

Create `src/features/pos/shift/useShiftOpen.test.tsx`:

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const fetchShiftStatus = vi.fn()
vi.mock('./shiftApi', () => ({ fetchShiftStatus: () => fetchShiftStatus() }))

import { useShiftOpen } from './useShiftOpen'

const status = (open: boolean) => ({
  shift: open ? { id: 's1', openedAt: '2026-10-26T01:00:00Z', openedByName: 'Aina', openingFloatSen: 20000 } : null,
  openBillCount: 0, lastFloatSen: null, now: '2026-10-26T02:00:00Z',
})
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => { fetchShiftStatus.mockReset() })

describe('useShiftOpen', () => {
  it('is null until the first read, then whether a shift is open', async () => {
    fetchShiftStatus.mockResolvedValueOnce(status(false))
    const { result } = renderHook(({ k }) => useShiftOpen(k), { initialProps: { k: 0 } })
    expect(result.current.open).toBeNull()
    await flush()
    expect(result.current.open).toBe(false)
  })

  it('reads again on a refresh and on reload(); a failed read keeps the last answer', async () => {
    fetchShiftStatus.mockResolvedValueOnce(status(false))
    const { result, rerender } = renderHook(({ k }) => useShiftOpen(k), { initialProps: { k: 0 } })
    await flush()
    fetchShiftStatus.mockResolvedValueOnce(status(true))
    rerender({ k: 1 })
    await flush()
    expect(result.current.open).toBe(true)
    fetchShiftStatus.mockRejectedValueOnce(new Error('Load failed'))
    act(() => result.current.reload())
    await flush()
    expect(result.current.open).toBe(true)
    expect(fetchShiftStatus).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/pos/shift/useShiftOpen.test.tsx`
Expected: FAIL — `Failed to resolve import "./useShiftOpen"`.

- [ ] **Step 3: Implement the hook**

Create `src/features/pos/shift/useShiftOpen.ts`:

```ts
// src/features/pos/shift/useShiftOpen.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchShiftStatus } from './shiftApi'

/** Whether the branch has an open shift, for the home banner and the Payment button (spec §1–2):
 *  true / false, or null until the first read answers. Read again on every POS refresh
 *  (`refreshKey`) and on reload() (ShiftBar calls it after opening or closing a shift). A failed
 *  read keeps the last answer: checkout_bill refuses a payment with no open shift anyway. */
export function useShiftOpen(refreshKey: number): { open: boolean | null; reload: () => void } {
  const [open, setOpen] = useState<boolean | null>(null)
  const seq = useRef(0)
  const reload = useCallback(() => {
    const id = ++seq.current                       // only the newest reply counts
    fetchShiftStatus().then((s) => { if (id === seq.current) setOpen(s.shift !== null) }, () => undefined)
  }, [])
  useEffect(() => { reload() }, [reload, refreshKey])
  return { open, reload }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/pos/shift/useShiftOpen.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Give `ShiftBar` an `onChanged` prop**

In `src/features/pos/shift/ShiftBar.tsx` replace the end of the doc comment and the signature:

```tsx
 *  into document.body, so they do not take the header's small muted text. */
export default function ShiftBar({ branchId, refreshKey, canSupervise }: { branchId: string; refreshKey: number; canSupervise: boolean }) {
```

with:

```tsx
 *  into document.body, so they do not take the header's small muted text. `onChanged` runs after a
 *  shift was opened and whenever a sheet closes, so the POS page re-reads whether a shift is open. */
export default function ShiftBar({ branchId, refreshKey, canSupervise, onChanged }: {
  branchId: string; refreshKey: number; canSupervise: boolean; onChanged?: () => void
}) {
```

Replace `const closeSheet = () => { setSheet(null); setClosing(null); void load() }` with:

```tsx
  const closeSheet = () => { setSheet(null); setClosing(null); void load(); onChanged?.() }
```

Replace the `OpenShiftSheet`'s `onOpened` prop with:

```tsx
              onOpened={(s) => { seq.current++; setStatus(s); setError(null); setSheet(null); setNote('Shift opened'); onChanged?.() }} />
```

Nothing else in `ShiftBar` changes.

- [ ] **Step 6: Write the bottom bar, grid menu and staff panel**

Create `src/features/pos/shell/BottomBar.tsx`:

```tsx
// src/features/pos/shell/BottomBar.tsx
import { LayoutGrid } from 'lucide-react'
import { useMinuteClock } from '../order/useMinuteClock'
import { mytClock } from './shellMenu'

/** The bar at the bottom of every POS screen but Payment (spec §1): the grid menu on the left, the
 *  screen's name in the middle, the staff member and the Malaysia time on the right (tap → staff panel). */
export default function BottomBar({ title, staffName, onMenu, onStaff }: {
  title: string
  staffName: string
  onMenu: () => void
  onStaff: () => void
}) {
  const now = useMinuteClock()
  return (
    <nav className="flex h-14 shrink-0 items-center justify-between bg-brown-header px-2 text-cream">
      <button type="button" onClick={onMenu} aria-label="Menu"
        className="flex h-11 w-14 items-center justify-center rounded-lg hover:bg-brown-btn">
        <LayoutGrid size={24} />
      </button>
      <div className="font-semibold tracking-wide">{title}</div>
      <button type="button" onClick={onStaff} aria-label="Staff panel"
        className="flex h-11 items-center gap-3 rounded-lg px-3 hover:bg-brown-btn">
        <span className="font-medium">{staffName}</span>
        <span className="tabular-nums opacity-80">{mytClock(now)}</span>
      </button>
    </nav>
  )
}
```

Create `src/features/pos/shell/GridMenu.tsx`:

```tsx
// src/features/pos/shell/GridMenu.tsx
import type { ComponentType } from 'react'
import { ClipboardList, LayoutGrid, Receipt, Settings, UtensilsCrossed } from 'lucide-react'
import { MENU_LABEL, type MenuItem } from './shellMenu'

const ICON: Record<MenuItem, ComponentType<{ size?: number }>> = {
  order: LayoutGrid, menu: UtensilsCrossed, transaction: Receipt, report: ClipboardList, setting: Settings,
}

/** The sheet the bottom bar's grid button opens (spec §1). */
export default function GridMenu({ items, current, onPick, onClose }: {
  items: MenuItem[]             // menuItems(...)
  current: MenuItem | null      // the screen that is open
  onPick: (item: MenuItem) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose}>
      <div role="menu" aria-label="POS menu" onClick={(e) => e.stopPropagation()}
        className="absolute bottom-16 left-2 grid w-[420px] grid-cols-3 gap-2 rounded-2xl bg-card p-3 shadow-card-hover">
        {items.map((i) => {
          const Icon = ICON[i]
          return (
            <button key={i} role="menuitem" type="button" onClick={() => onPick(i)}
              className={`flex h-24 flex-col items-center justify-center gap-2 rounded-xl ${current === i ? 'bg-brown-btn text-white' : 'bg-cream text-brown-dark hover:bg-border'}`}>
              <Icon size={28} />
              <span className="text-sm font-medium">{MENU_LABEL[i]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

Create `src/features/pos/shell/StaffPanel.tsx`:

```tsx
// src/features/pos/shell/StaffPanel.tsx
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import PrintHostPanel from '../order/PrintHostPanel'
import ShiftBar from '../shift/ShiftBar'

/** The right-side staff panel (spec §1): the shift (Open / Close shift, Pay in / out), printers,
 *  My PIN, the live status and Logout. It stays MOUNTED and is only hidden when closed: the print
 *  host inside it prints the browser-route tickets of this iPad, and the shift bar keeps a pay in /
 *  pay out whose reply was lost, so neither may unmount when the cashier closes the panel. */
export default function StaffPanel({ open, branchId, branchName, staffName, refreshKey, liveStatus, onShiftChanged, onMyPin, onClose }: {
  open: boolean
  branchId: string
  branchName: string
  staffName: string
  refreshKey: number
  liveStatus: string            // usePosRealtime's status
  onShiftChanged: () => void
  onMyPin: () => void
  onClose: () => void
}) {
  return (
    <div className={open ? 'fixed inset-0 z-30 bg-black/40' : 'hidden'} onClick={onClose}>
      <aside aria-label="Staff panel" onClick={(e) => e.stopPropagation()}
        className="absolute bottom-0 right-0 top-0 flex w-[380px] flex-col gap-5 overflow-y-auto bg-card p-5 shadow-card-hover">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-semibold text-brown-dark">{staffName}</div>
            <div className="text-sm text-brown-muted">{branchName}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close staff panel"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border"><X size={20} /></button>
        </div>
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brown-muted">Shift</h3>
          <div className="flex flex-wrap items-center gap-2 text-sm [&_button]:min-h-11">
            <ShiftBar branchId={branchId} refreshKey={refreshKey} canSupervise={false} onChanged={onShiftChanged} />
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brown-muted">Printers</h3>
          <div className="text-sm [&_button]:min-h-11">
            <PrintHostPanel branchId={branchId} />
          </div>
        </section>
        <button type="button" onClick={onMyPin} className="min-h-12 rounded-xl border border-border-mid px-4 text-left text-brown-dark">My PIN</button>
        <div className="text-sm text-brown-muted">Live: {liveStatus}</div>
        <Link to="/profile" className="mt-auto flex min-h-12 items-center justify-center rounded-xl bg-brown-btn font-medium text-white hover:bg-brown-btn-hover">
          Logout
        </Link>
      </aside>
    </div>
  )
}
```

- [ ] **Step 7: Typecheck and run the shift tests**

Run: `npx tsc -b && npx vitest run src/features/pos/shift/`
Expected: tsc prints nothing; all shift tests PASS (the existing ones are unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/shift/useShiftOpen.ts src/features/pos/shift/useShiftOpen.test.tsx src/features/pos/shift/ShiftBar.tsx \
  src/features/pos/shell/BottomBar.tsx src/features/pos/shell/GridMenu.tsx src/features/pos/shell/StaffPanel.tsx
git commit -m "feat(pos): bottom bar, grid menu and staff panel shell" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Product tiles, modifier sheet and bill column

**Files:**
- Modify: `src/features/pos/order/ProductTiles.tsx` (whole file below; same props, so the old `OrderPad` keeps compiling until Task 12)
- Create: `src/features/pos/order/ModifierSheet.tsx`, Test: `src/features/pos/order/ModifierSheet.test.tsx`
- Create: `src/features/pos/order/BillColumn.tsx`

**Interfaces:**
- Consumes: `tileInitials`, `groupBadge`, `toggleOption` (Task 3); `BillView`, `SentRow`, `DraftRow`, `itemsWord` (Task 3); `defaultLine`, `formatSen`, `linePriceSen`, `validateLine`, `PosProduct`, `OrderLine` (cart.ts); `formatRate`, `BillTotals` (bill.ts); `tileSlotLabel`, `MenuWindows` (padSlots.ts).
- Produces:
  - `ProductTiles` (unchanged props: `{ products: PosProduct[]; windows: MenuWindows; now: Date; soldOutMode: boolean; onTap: (p: PosProduct, outOfSlot: boolean) => void }`), now drawing `p.imageUrl` or `tileInitials(p.name)`.
  - `default ModifierSheet(props: { product: PosProduct; initial?: OrderLine; onCancel: () => void; onDone: (line: OrderLine) => void; onRemove?: () => void })`
  - `default BillColumn(props: { title; billNo: string | null; pax: number | null; onPax: (() => void) | null; catalogName: string | null; catalogIsExtra: boolean; onCatalog: (() => void) | null; view: BillView; loading: boolean; loadError: string | null; notice: string | null; onSentTap: (row: SentRow) => void; onDraftTap: (row: DraftRow) => void; onActions: () => void; onSend: () => void; sendDisabled: boolean; sending: boolean; payLabel: string; payDisabled: boolean; payHint: string | null; onPay: () => void })`

- [ ] **Step 1: Write the failing modifier sheet test**

Create `src/features/pos/order/ModifierSheet.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ModifierSheet from './ModifierSheet'
import type { PosProduct } from './cart'

afterEach(cleanup)

const latte: PosProduct = {
  id: 'p1', name: 'Latte', description: null, soldOut: false,
  variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }, { id: 'cold', name: 'Cold', priceSen: 1100, isBase: false }],
  groups: [
    { id: 'milk', name: 'Milk', min: 1, max: 1, options: [
      { id: 'oat', name: 'Oat', priceDeltaSen: 200, isDefault: false, available: true },
      { id: 'soy', name: 'Soy', priceDeltaSen: 0, isDefault: false, available: false },
    ] },
    { id: 'extra', name: 'Extras', min: 0, max: 2, options: [{ id: 'shot', name: 'Extra shot', priceDeltaSen: 300, isDefault: false, available: true }] },
  ],
}

describe('ModifierSheet', () => {
  it('shows a red SELECT badge on required groups and greys a sold-out option', () => {
    render(<ModifierSheet product={latte} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getAllByText('SELECT 1')).toHaveLength(2)           // the variant and Milk
    expect(screen.getByText('UP TO 2')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Soy/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('Confirm with a required group missing says what is missing; once chosen it answers the line', () => {
    const onDone = vi.fn()
    render(<ModifierSheet product={latte} onCancel={() => {}} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm · RM 9.00' }))
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Choose at least 1 for Latte: Milk')
    fireEvent.click(screen.getByRole('button', { name: /Cold/ }))
    fireEvent.click(screen.getByRole('button', { name: /Oat/ }))
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm · RM 26.00' }))
    expect(onDone).toHaveBeenCalledWith({ productId: 'p1', variantId: 'cold', qty: 2, note: null, optionIds: ['oat'] })
  })

  it('a draft being edited offers Remove', () => {
    const onRemove = vi.fn()
    render(<ModifierSheet product={latte} initial={{ productId: 'p1', variantId: 'hot', qty: 1, note: null, optionIds: ['oat'] }}
      onCancel={() => {}} onDone={() => {}} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/pos/order/ModifierSheet.test.tsx`
Expected: FAIL — `Failed to resolve import "./ModifierSheet"`.

- [ ] **Step 3: Implement the modifier sheet**

Create `src/features/pos/order/ModifierSheet.tsx`:

```tsx
// src/features/pos/order/ModifierSheet.tsx
import { useState } from 'react'
import { Minus, Plus, X } from 'lucide-react'
import { defaultLine, formatSen, linePriceSen, validateLine, type OrderLine, type PosProduct } from './cart'
import { groupBadge, toggleOption } from './modifiers'

/** The order screen's modifier sheet, Feedme style (spec §2): each group with a red SELECT n badge
 *  when it is required, options as a two-column grid of name and price, qty and a kitchen note,
 *  Confirm at the bottom. Same rules as LineSheet (which the QR page keeps): validateLine judges
 *  the line, toggleOption is LineSheet's tap rule. A draft being edited also offers Remove. */
export default function ModifierSheet({ product, initial, onCancel, onDone, onRemove }: {
  product: PosProduct
  initial?: OrderLine
  onCancel: () => void
  onDone: (line: OrderLine) => void
  onRemove?: () => void
}) {
  const [line, setLine] = useState<OrderLine>(initial ?? defaultLine(product))
  const [touched, setTouched] = useState(initial !== undefined)
  const problem = validateLine(product, line)
  const price = linePriceSen(product, line)
  const confirm = () => { if (problem) setTouched(true); else onDone(line) }
  const tile = (on: boolean) =>
    `flex min-h-12 items-center justify-between gap-2 rounded-xl border px-3 text-left text-sm disabled:opacity-40 ${on ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid bg-canvas text-brown-dark'}`

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div role="dialog" aria-modal="true" aria-label={product.name} onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-card">
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="text-lg font-semibold text-brown-dark">{product.name}</h2>
            {product.description && <p className="text-sm text-brown-muted">{product.description}</p>}
          </div>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border"><X size={20} /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {product.variants.length > 1 && (
            <section>
              <GroupHead name="Choose one" badge={{ text: 'SELECT 1', required: true }} />
              <div className="grid grid-cols-2 gap-2">
                {product.variants.map((v) => (
                  <button key={v.id} type="button" aria-pressed={line.variantId === v.id} className={tile(line.variantId === v.id)}
                    onClick={() => { setTouched(true); setLine({ ...line, variantId: v.id }) }}>
                    <span>{v.name}</span><span className="tabular-nums">{formatSen(v.priceSen)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {product.groups.map((g) => {
            const ids = g.options.map((o) => o.id)
            return (
              <section key={g.id}>
                <GroupHead name={g.name} badge={groupBadge(g)} />
                <div className="grid grid-cols-2 gap-2">
                  {g.options.map((o) => {
                    const on = line.optionIds.includes(o.id)
                    return (
                      <button key={o.id} type="button" disabled={!o.available} aria-pressed={on} className={tile(on)}
                        onClick={() => { setTouched(true); setLine((l) => toggleOption(l, g.max, ids, o.id)) }}>
                        <span>{o.name}{!o.available && ' (sold out)'}</span>
                        <span className="tabular-nums">{o.priceDeltaSen > 0 ? `+${formatSen(o.priceDeltaSen)}` : ''}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
          <section className="flex items-center gap-3">
            <span className="font-semibold text-brown-dark">Qty</span>
            <button type="button" aria-label="Less" className="flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid"
              onClick={() => setLine({ ...line, qty: Math.max(1, line.qty - 1) })}><Minus size={18} /></button>
            <span className="w-8 text-center text-lg tabular-nums">{line.qty}</span>
            <button type="button" aria-label="More" className="flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid"
              onClick={() => setLine({ ...line, qty: Math.min(20, line.qty + 1) })}><Plus size={18} /></button>
          </section>
          <input className="h-12 w-full rounded-xl border border-border-mid px-3 text-base" placeholder="Note for the kitchen (optional)"
            value={line.note ?? ''} onChange={(e) => setLine({ ...line, note: e.target.value || null })} maxLength={120} />
          {touched && problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
        </div>
        <div className="flex gap-2 border-t border-border p-4">
          {onRemove && (
            <button type="button" onClick={onRemove} className="min-h-14 rounded-xl border border-red-300 px-6 font-medium text-red-700">Remove</button>
          )}
          <button type="button" onClick={confirm} className="min-h-14 flex-1 rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover">
            Confirm · {price === null ? '—' : formatSen(price * line.qty)}
          </button>
        </div>
      </div>
    </div>
  )
}

function GroupHead({ name, badge }: { name: string; badge: { text: string; required: boolean } }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="font-semibold text-brown-dark">{name}</span>
      <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${badge.required ? 'bg-red-600 text-white' : 'bg-border text-brown-muted'}`}>{badge.text}</span>
    </div>
  )
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/pos/order/ModifierSheet.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Restyle the product tiles**

Replace the whole of `src/features/pos/order/ProductTiles.tsx` with:

```tsx
// src/features/pos/order/ProductTiles.tsx
import { formatSen, type PosProduct } from './cart'
import { tileSlotLabel, type MenuWindows } from './padSlots'
import { tileInitials } from './modifiers'

/** The order screen's product tiles, Feedme style: photo on top (or the first three letters on a
 *  grey block), name and price below. A sold-out product, or one outside its time slots at `now`
 *  (the server's time, moved on every minute by usePadWindows), is greyed out and says why;
 *  tapping it only works in sold-out mode (the screen decides). */
export default function ProductTiles({ products, windows, now, soldOutMode, onTap }: {
  products: PosProduct[]
  windows: MenuWindows
  now: Date
  /** in sold-out mode every tile can be tapped (to mark it sold out or back) */
  soldOutMode: boolean
  onTap: (p: PosProduct, outOfSlot: boolean) => void
}) {
  return (
    <>
      {products.map((p) => {
        const slot = tileSlotLabel(windows, p.id, now)
        const tappable = soldOutMode || (!p.soldOut && slot === null)     // what the screen's tap() accepts
        const dim = p.soldOut || slot !== null
        const price = p.variants.length > 1 ? `${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))} –` : formatSen(p.variants[0].priceSen)
        return (
          <button key={p.id} type="button" onClick={() => onTap(p, slot !== null)} aria-disabled={!tappable}
            className={`flex min-h-36 flex-col overflow-hidden rounded-xl border bg-card text-left ${p.soldOut ? 'border-red-300' : 'border-border'} ${soldOutMode ? 'ring-2 ring-red-200' : ''}`}>
            <div className={`relative h-20 w-full bg-border ${dim ? 'opacity-50 grayscale' : ''}`}>
              {p.imageUrl
                ? <img src={p.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                : <div className="flex h-full items-center justify-center text-2xl font-semibold text-brown-muted">{tileInitials(p.name)}</div>}
              {p.soldOut && <span className="absolute left-1 top-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">SOLD OUT</span>}
            </div>
            <div className={`flex flex-1 flex-col p-2 ${dim ? 'text-brown-faint' : 'text-brown-dark'}`}>
              <div className="line-clamp-2 text-sm font-medium">{p.name}</div>
              <div className="mt-auto text-xs text-brown-muted">{price}</div>
              {slot && <div className="text-xs">{slot}</div>}
            </div>
          </button>
        )
      })}
    </>
  )
}
```

- [ ] **Step 6: Write the bill column**

Create `src/features/pos/order/BillColumn.tsx`:

```tsx
// src/features/pos/order/BillColumn.tsx
import { LayoutGrid, Users } from 'lucide-react'
import { formatSen } from './cart'
import { formatRate, type BillTotals } from '../checkout/bill'
import { itemsWord, type BillView, type DraftRow, type SentRow } from './billView'

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })

/** The order screen's bill (spec §2): header with pax and catalog, the sent items grouped by order,
 *  the drafts under an amber rule, the totals preview, and the grid · Send · Payment buttons.
 *  Presentational: OrderScreen owns every action. */
export default function BillColumn(p: {
  title: string                       // "Table T3"
  billNo: string | null               // null = no bill yet
  pax: number | null
  onPax: (() => void) | null          // null = no pax here (takeaway)
  catalogName: string | null
  catalogIsExtra: boolean             // an additional catalog: amber
  onCatalog: (() => void) | null      // null = cannot switch now
  view: BillView
  loading: boolean
  loadError: string | null
  notice: string | null               // e.g. a takeaway bill takes no new items
  onSentTap: (row: SentRow) => void
  onDraftTap: (row: DraftRow) => void
  onActions: () => void
  onSend: () => void
  sendDisabled: boolean
  sending: boolean
  payLabel: string
  payDisabled: boolean
  payHint: string | null
  onPay: () => void
}) {
  const { view } = p
  const orders = [...new Map(view.sent.map((s) => [s.item.order_id, s.item.orders])).entries()]
  return (
    <section aria-label="Bill" className="flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-card">
      <header className="border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="truncate text-lg font-semibold text-brown-dark">{p.title}</h2>
          {p.onPax && (
            <button type="button" onClick={p.onPax} className="flex min-h-11 items-center gap-1 rounded-lg border border-border-mid px-3 text-sm">
              <Users size={16} />{p.pax ?? '—'} pax
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-brown-muted">
          <span>{p.billNo ? `Bill ${p.billNo}` : 'No bill yet'}</span>
          {p.catalogName && (p.onCatalog ? (
            <button type="button" onClick={p.onCatalog}
              className={`min-h-11 rounded-lg border px-3 text-sm ${p.catalogIsExtra ? 'border-amber-500 bg-amber-50 text-amber-800' : 'border-border-mid text-brown-dark'}`}>
              {p.catalogName}
            </button>
          ) : <span className={p.catalogIsExtra ? 'text-amber-700' : ''}>{p.catalogName}</span>)}
        </div>
      </header>
      {p.notice && <p role="status" className="mx-3 mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{p.notice}</p>}
      <div className="flex-1 overflow-y-auto p-3 text-sm">
        {p.loadError && <p role="alert" className="mb-2 rounded bg-red-50 p-2 text-red-700">{p.loadError}</p>}
        {p.loading && <p className="text-brown-muted">Loading…</p>}
        {orders.map(([orderId, o]) => (
          <div key={orderId} className="mb-3">
            <div className="text-xs text-brown-muted">#{o.order_no} · {o.source === 'qr' ? 'QR' : 'Counter'} · {time(o.placed_at)}</div>
            {view.sent.filter((s) => s.item.order_id === orderId).map((s) => (
              <button key={s.item.id} type="button" disabled={s.voided} onClick={() => p.onSentTap(s)}
                className={`flex min-h-11 w-full justify-between gap-2 py-1.5 text-left ${s.voided ? 'line-through opacity-50' : ''}`}>
                <LineText qty={s.qty} name={s.name} mods={s.mods} note={s.note} />
                <span className="tabular-nums">{formatSen(s.amountSen)}</span>
              </button>
            ))}
          </div>
        ))}
        {view.drafts.length > 0 && (
          <div className="mt-2 border-l-4 border-amber-400 pl-2">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-800">Not sent · {itemsWord(view.draftCount)}</div>
            {view.drafts.map((d) => (
              <button key={d.index} type="button" onClick={() => p.onDraftTap(d)}
                className={`flex min-h-11 w-full justify-between gap-2 py-1.5 text-left ${d.unitSen === null ? 'text-red-700' : ''}`}>
                <LineText qty={d.qty} name={d.name} mods={d.mods} note={d.note} />
                <span className="tabular-nums">{d.unitSen === null ? '—' : formatSen(d.unitSen * d.qty)}</span>
              </button>
            ))}
          </div>
        )}
        {!p.loading && view.sent.length === 0 && view.drafts.length === 0 && <p className="text-brown-muted">Tap items to add them.</p>}
      </div>
      <footer className="border-t border-border p-3 text-sm">
        {view.totals && <Totals t={view.totals} />}
        {view.drafts.length > 0 && (
          <p className="mt-1 text-xs text-amber-800">{view.totalsIncludeDrafts ? 'Totals include the unsent items.' : 'Unsent items are not in the totals yet.'}</p>
        )}
        <div className="mt-3 grid grid-cols-[56px_1fr_1.4fr] gap-2">
          <button type="button" aria-label="Bill actions" onClick={p.onActions}
            className="flex min-h-14 items-center justify-center rounded-xl border border-border-mid text-brown-dark"><LayoutGrid size={22} /></button>
          <button type="button" onClick={p.onSend} disabled={p.sendDisabled}
            className="min-h-14 rounded-xl border-2 border-brown-btn font-semibold text-brown-btn disabled:opacity-40">{p.sending ? 'Sending…' : 'Send'}</button>
          <button type="button" onClick={p.onPay} disabled={p.payDisabled}
            className="min-h-14 rounded-xl bg-brown-btn font-semibold text-white hover:bg-brown-btn-hover disabled:opacity-40">{p.payLabel}</button>
        </div>
        {p.payHint && <p className="mt-2 text-center text-xs text-brown-muted">{p.payHint}</p>}
      </footer>
    </section>
  )
}

function LineText({ qty, name, mods, note }: { qty: number; name: string; mods: string[]; note: string | null }) {
  return (
    <span>
      {qty} × {name}
      {mods.map((m, k) => <span key={k} className="block pl-4 text-xs text-brown-muted">+ {m}</span>)}
      {note && <span className="block pl-4 text-xs italic text-brown-muted">* {note}</span>}
    </span>
  )
}

function Totals({ t }: { t: BillTotals }) {
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{formatSen(t.subtotalSen)}</span></div>
      {t.serviceChargeGroups.map((g) => (
        <div key={`sc${g.rateBp}`} className="flex justify-between text-brown-muted"><span>Service charge ({formatRate(g.rateBp)})</span><span className="tabular-nums">{formatSen(g.amountSen)}</span></div>
      ))}
      {t.sstGroups.map((g) => (
        <div key={`sst${g.rateBp}`} className="flex justify-between text-brown-muted"><span>SST ({formatRate(g.rateBp)})</span><span className="tabular-nums">{formatSen(g.amountSen)}</span></div>
      ))}
      {t.takeawayFeeSen > 0 && <div className="flex justify-between text-brown-muted"><span>Takeaway packaging</span><span className="tabular-nums">{formatSen(t.takeawayFeeSen)}</span></div>}
      {t.roundingSen !== 0 && <div className="flex justify-between text-brown-muted"><span>Rounding</span><span className="tabular-nums">{formatSen(t.roundingSen)}</span></div>}
      <div className="flex justify-between text-base font-semibold"><span>Total</span><span className="tabular-nums">{formatSen(t.totalSen)}</span></div>
    </div>
  )
}
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc -b`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/order/ProductTiles.tsx src/features/pos/order/ModifierSheet.tsx \
  src/features/pos/order/ModifierSheet.test.tsx src/features/pos/order/BillColumn.tsx
git commit -m "feat(pos): Feedme product tiles, modifier sheet and bill column" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Bill actions overlay and Move to grid

**Files:**
- Create: `src/features/pos/order/BillActionsOverlay.tsx` (not `BillActions.tsx`: macOS is case-insensitive and `billActions.ts` already exists)
- Create: `src/features/pos/order/MoveToGrid.tsx`, Test: `src/features/pos/order/MoveToGrid.test.tsx`

**Interfaces:**
- Consumes: `BillAction`, `BILL_ACTION_LABEL` (Task 3); `MoveTarget`, `TAKEAWAY_NEEDS_OCCUPIED` (Task 2); `formatSen`.
- Produces:
  - `default BillActionsOverlay(props: { title: string; actions: BillAction[]; disabled: boolean; onPick: (a: BillAction) => void; onClose: () => void })`
  - `default MoveToGrid(props: { billNo: string; targets: MoveTarget[]; busy: boolean; onPick: (t: MoveTarget) => void; onClose: () => void })`

- [ ] **Step 1: Write the failing Move to test**

Create `src/features/pos/order/MoveToGrid.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import MoveToGrid from './MoveToGrid'
import { TAKEAWAY_NEEDS_OCCUPIED, type MoveTarget } from './moveTargets'

afterEach(cleanup)

const targets: MoveTarget[] = [
  { tableId: 't2', label: 'T2', kind: 'move' },
  { tableId: 't3', label: 'B4', kind: 'merge', intoBillId: 'b3', intoBillNo: '261026-003', totalSen: 10670 },
  { tableId: 't4', label: 'T4', kind: 'refused', reason: TAKEAWAY_NEEDS_OCCUPIED },
]

describe('MoveToGrid', () => {
  it('every table with what it holds; a refused one cannot be tapped', () => {
    const onPick = vi.fn()
    render(<MoveToGrid billNo="261026-001" targets={targets} busy={false} onPick={onPick} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /T2\s*Empty/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /B4\s*RM 106\.70/ }))
    expect(onPick).toHaveBeenCalledWith(targets[1])
    const refused = screen.getByRole('button', { name: /T4/ }) as HTMLButtonElement
    expect(refused.disabled).toBe(true)
    expect(refused.title).toBe(TAKEAWAY_NEEDS_OCCUPIED)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/pos/order/MoveToGrid.test.tsx`
Expected: FAIL — `Failed to resolve import "./MoveToGrid"`.

- [ ] **Step 3: Implement the grid and the overlay**

Create `src/features/pos/order/MoveToGrid.tsx`:

```tsx
// src/features/pos/order/MoveToGrid.tsx
import { formatSen } from './cart'
import type { MoveTarget } from './moveTargets'

/** Move to (spec §3): every other table with its current total, Feedme style. An empty table moves
 *  the bill there, an occupied one merges it in (OrderScreen asks first), a refused one says why. */
export default function MoveToGrid({ billNo, targets, busy, onPick, onClose }: {
  billNo: string
  targets: MoveTarget[]         // moveTargets(...)
  busy: boolean
  onPick: (t: MoveTarget) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onClose}>
      <div role="dialog" aria-modal="true" aria-label="Move to" onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl bg-card p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-brown-dark">Move to</h2>
          <span className="text-sm text-brown-muted">Bill {billNo} · an empty table moves it, a table with a bill merges it in</span>
        </div>
        <div className="mt-4 grid flex-1 grid-cols-5 content-start gap-3 overflow-y-auto">
          {targets.map((t) => (
            <button key={t.tableId} type="button" disabled={busy || t.kind === 'refused'} onClick={() => onPick(t)}
              title={t.kind === 'refused' ? t.reason : undefined}
              className={`h-24 rounded-xl border-2 p-2 text-left disabled:opacity-40 ${t.kind === 'merge' ? 'border-brown-btn bg-brown-btn text-white' : 'border-border bg-canvas text-brown-dark'}`}>
              <div className="text-xl font-semibold">{t.label}</div>
              <div className="text-xs">
                {t.kind === 'merge' ? (t.totalSen === null ? `Bill ${t.intoBillNo}` : formatSen(t.totalSen)) : t.kind === 'move' ? 'Empty' : 'Empty · merge only'}
              </div>
            </button>
          ))}
          {targets.length === 0 && <p className="col-span-5 text-sm text-brown-muted">No other table.</p>}
        </div>
        <button type="button" onClick={onClose} disabled={busy} className="mt-4 min-h-12 rounded-xl border border-border-mid text-brown-dark disabled:opacity-40">Cancel</button>
      </div>
    </div>
  )
}
```

Create `src/features/pos/order/BillActionsOverlay.tsx`:

```tsx
// src/features/pos/order/BillActionsOverlay.tsx
import type { ComponentType } from 'react'
import { ArrowRightLeft, Ban, CircleX, Pause, Play, QrCode, Send, Users, X } from 'lucide-react'
import { BILL_ACTION_LABEL, type BillAction } from './billActions'

const ICON: Record<BillAction, ComponentType<{ size?: number }>> = {
  send: Send, move: ArrowRightLeft, void_bill: Ban, close_empty: CircleX, pax: Users,
  pause_qr: Pause, resume_qr: Play, open_qr: QrCode,
}

/** The dark overlay of round action buttons the bill's grid button opens (spec §3, Feedme style).
 *  Shows only the actions billActions() gives; Void bill and Close empty bill are red. */
export default function BillActionsOverlay({ title, actions, disabled, onPick, onClose }: {
  title: string
  actions: BillAction[]
  disabled: boolean             // a bill action is already running
  onPick: (a: BillAction) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col items-center justify-center bg-brown-dark/90 p-6" onClick={onClose}>
      <h2 className="mb-8 text-xl font-semibold text-cream">{title}</h2>
      <div role="menu" aria-label="Bill actions" className="flex max-w-3xl flex-wrap justify-center gap-6" onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => {
          const Icon = ICON[a]
          const danger = a === 'void_bill' || a === 'close_empty'
          return (
            <button key={a} type="button" role="menuitem" disabled={disabled} onClick={() => onPick(a)}
              className="flex w-24 flex-col items-center gap-2 text-cream disabled:opacity-40">
              <span className={`flex h-20 w-20 items-center justify-center rounded-full ${danger ? 'bg-red-700 text-white' : 'bg-cream text-brown-dark'}`}><Icon size={30} /></span>
              <span className="text-center text-sm font-medium">{BILL_ACTION_LABEL[a]}</span>
            </button>
          )
        })}
        {actions.length === 0 && <p className="text-cream">Nothing to do on this bill yet.</p>}
      </div>
      <button type="button" onClick={onClose} aria-label="Close bill actions"
        className="mt-10 flex h-14 w-14 items-center justify-center rounded-full border border-cream/50 text-cream"><X size={26} /></button>
    </div>
  )
}
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run src/features/pos/order/MoveToGrid.test.tsx && npx tsc -b`
Expected: PASS (1 test); tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/order/BillActionsOverlay.tsx src/features/pos/order/MoveToGrid.tsx src/features/pos/order/MoveToGrid.test.tsx
git commit -m "feat(pos): bill actions overlay and Move to grid" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Order screen

**Files:**
- Create: `src/features/pos/order/OrderScreen.tsx`

**Interfaces:**
- Consumes: from posApi `fetchBillItems`, `fetchBranchCatalogs`, `fetchPadProductInfo`, `fetchPosMenu`, `setSoldOut`, `setTablePaused`; from checkoutApi `mergeBills`, `moveBill`, `openTable`, `setBillPax`, `voidBill`, `voidItem`, `BillingConfig`; catalogs.ts `defaultCatalogProblem`, `noCatalogMessage`, `selectableCatalogs`, `SWITCH_CATALOG_CONFIRM`, `BranchCatalogs`; `newQueuedOrder`, `QueuedOrder`; `SubmitResult`; `usePadWindows`; Tasks 2–7 (`OrderTarget` and its helpers, `moveTargets`, `billView`, `payGate`, the prompts, `billActions`, `withPhotos`, `ProductTiles`, `ModifierSheet`, `BillColumn`, `BillActionsOverlay`, `MoveToGrid`, `ConfirmDialog`, `PaxDialog`); `ApprovalDialog`, `PickerSheet` (BillPickers.tsx).
- Produces: `default OrderScreen(props: { branchId: string; target: OrderTarget; tables: TableRow[]; bills: OpenBillRow[]; summaries: ReadonlyMap<string, BillSummary>; refreshKey: number; billing: BillingConfig | null; shiftOpen: boolean | null; lastCatalogs: BranchCatalogs | null; initialLines?: OrderLine[]; initialCatalogId?: string | null; submit: (o: QueuedOrder) => Promise<SubmitResult>; onCatalogs: (c: BranchCatalogs) => void; onTarget: (t: OrderTarget) => void; onBack: () => void; onSent: () => void; onPay: (bill: OpenBillRow) => void; onSendAndPay: (clientOrderId: string) => Promise<void>; onChanged: () => Promise<void> | void; onDraftCount: (n: number) => void })`

Behaviour kept from `OrderPad` (copied, not rewritten): fresh catalog read per screen with the last-seen fallback and Retry; only the order type's default is auto-picked; one catalog per order with clear-on-switch (now asked in `ConfirmDialog`) and the "no longer offered" carry; sold-out mode; out-of-slot greying and the pre-send `slots.check`; enqueue-then-send through `submit`, `Rejected: …` keeps the cart and reloads the menu, `Order NOT saved on this iPad: …`. Kept from `BillPanel`: items re-read on bill change / `refreshKey` / after each action; one action at a time (`busyRef`); void item and void bill through `ApprovalDialog`; close an empty bill with an empty approval; move; merge; Pause / Resume QR; Open for QR when `qrRequiresOpenBill`. New: drafts and sent items in one bill column, Send / Send & pay / Payment gate, discard guard, Move to grid, pax via `PaxDialog` (`pos_set_bill_pax` on an open bill; local for an empty table and sent with the first order), product photos.

- [ ] **Step 1: Write the order screen**

Create `src/features/pos/order/OrderScreen.tsx`:

```tsx
// src/features/pos/order/OrderScreen.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import {
  fetchBillItems, fetchBranchCatalogs, fetchPadProductInfo, fetchPosMenu, setSoldOut, setTablePaused,
  type BillItemRow, type OpenBillRow, type TableRow,
} from './posApi'
import { defaultLine, findProduct, formatSen, validateLine, type OrderLine, type PosMenu, type PosProduct } from './cart'
import { defaultCatalogProblem, noCatalogMessage, selectableCatalogs, SWITCH_CATALOG_CONFIRM, type BranchCatalogs } from './catalogs'
import { newQueuedOrder, type QueuedOrder } from '../offline/orderQueue'
import type { SubmitResult } from './useOrderQueue'
import { usePadWindows } from './usePadWindows'
import ProductTiles from './ProductTiles'
import ModifierSheet from './ModifierSheet'
import BillColumn from './BillColumn'
import BillActionsOverlay from './BillActionsOverlay'
import MoveToGrid from './MoveToGrid'
import { billActions, type BillAction } from './billActions'
import { billView, discardQuestion, NO_SHIFT_PAY, payGate, sendFirstQuestion, type DraftRow, type SentRow } from './billView'
import { moveTargets, type MoveTarget } from './moveTargets'
import { shownPax, takesNewItems, TAKEAWAY_ONE_ORDER, targetBill, targetOrderType, targetTitle, type OrderTarget } from './orderTarget'
import { withPhotos, type PadProductInfo } from './padInfo'
import type { BillSummary } from './billSummaries'
import { mergeBills, moveBill, openTable, setBillPax, voidBill, voidItem, type BillingConfig } from '../checkout/checkoutApi'
import ApprovalDialog from '../checkout/ApprovalDialog'
import PickerSheet from '../checkout/BillPickers'
import ConfirmDialog, { type ConfirmRequest } from '../shell/ConfirmDialog'
import PaxDialog from '../shell/PaxDialog'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const BILL_GONE = 'This bill is no longer open.'

type Dialog =
  | { kind: 'void_item'; row: SentRow }
  | { kind: 'void_bill' }
  | { kind: 'actions' }
  | { kind: 'move' }
  | { kind: 'pax'; purpose: 'set' | 'open_qr' }
  | { kind: 'catalog' }
  | null

/** The order screen (spec §2): categories | product tiles | bill, replacing the old BillPanel and
 *  OrderPad. Everything OrderPad did is here unchanged — one catalog per order (the type's default,
 *  or an additional one; switching clears the cart, an edited order no longer offered carries what
 *  the new catalog sells), sold-out mode, time-slot greying and the pre-send slot check, the queue
 *  (enqueue then send; a rejection keeps the cart) — and every bill action BillPanel had: void item
 *  and void bill with approval, close an empty bill, move, merge, pause QR, open for QR. */
export default function OrderScreen({
  branchId, target, tables, bills, summaries, refreshKey, billing, shiftOpen, lastCatalogs, initialLines, initialCatalogId,
  submit, onCatalogs, onTarget, onBack, onSent, onPay, onSendAndPay, onChanged, onDraftCount,
}: {
  branchId: string
  target: OrderTarget
  tables: TableRow[]
  bills: OpenBillRow[]                       // the branch's open bills (PosPage keeps them fresh)
  summaries: ReadonlyMap<string, BillSummary>
  refreshKey: number                         // bumped on every order, bills event and 15 s sweep
  billing: BillingConfig | null
  shiftOpen: boolean | null
  lastCatalogs: BranchCatalogs | null        // the last catalogs this iPad saw: used when the fresh read fails
  initialLines?: OrderLine[]                 // a rejected order being edited
  initialCatalogId?: string | null           // ...keeps its catalog
  submit: (o: QueuedOrder) => Promise<SubmitResult>
  onCatalogs: (c: BranchCatalogs) => void
  onTarget: (t: OrderTarget) => void         // a move or merge landed elsewhere, or pax was chosen for an empty table
  onBack: () => void
  onSent: () => void                         // the drafts are in the queue: back to the tables
  onPay: (bill: OpenBillRow) => void
  onSendAndPay: (clientOrderId: string) => Promise<void>   // rejects with the words to show
  onChanged: () => Promise<void> | void      // a bill action changed something: reload
  onDraftCount: (n: number) => void          // PosPage guards leaving through the menu
}) {
  const orderType = targetOrderType(target)
  const bill = targetBill(target, bills)
  const table = target.kind === 'table' ? tables.find((t) => t.id === target.tableId) ?? null : null

  // ── catalogs: fetched fresh for this screen; offline, the last list this iPad saw ──
  const [fresh, setFresh] = useState<BranchCatalogs | null>(null)
  const [catalogsError, setCatalogsError] = useState<string | null>(null)
  const [catalogsTry, setCatalogsTry] = useState(0)
  useEffect(() => {
    let live = true
    setCatalogsError(null)
    fetchBranchCatalogs(branchId).then(
      (c) => { if (live) { onCatalogs(c); setFresh(c) } },
      (e) => {
        if (!live) return
        if (lastCatalogs) setFresh(lastCatalogs)
        else setCatalogsError(msg(e))
      },
    )
    return () => { live = false }
  }, [branchId, catalogsTry]) // eslint-disable-line react-hooks/exhaustive-deps
  const catalogs = useMemo(
    () => (fresh ? selectableCatalogs(fresh.assignments, fresh.catalogs, orderType, initialCatalogId ?? null) : null),
    [fresh, orderType, initialCatalogId],
  )
  const defaultProblem = fresh ? defaultCatalogProblem(fresh.assignments, fresh.catalogs, orderType) : null

  // ── the menu and the cart (OrderPad's state, unchanged) ──
  const [catalogId, setCatalogId] = useState<string | null>(initialCatalogId ?? null)
  const [menu, setMenu] = useState<PosMenu | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<OrderLine[]>(initialLines ?? [])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [soldOutMode, setSoldOutMode] = useState(false)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)              // synchronous guard: Send and Send & pay never run twice
  const [carry, setCarry] = useState<{ lines: OrderLine[]; to: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [info, setInfo] = useState<ReadonlyMap<string, PadProductInfo>>(new Map())
  const loadSeq = useRef(0)
  const catalogIdRef = useRef(catalogId)
  useEffect(() => { catalogIdRef.current = catalogId }, [catalogId])
  const slots = usePadWindows(catalogId)
  useEffect(() => { setError(null) }, [lines])
  useEffect(() => {
    let live = true
    fetchPadProductInfo().then((m) => { if (live) setInfo(m) }, () => undefined)   // without it: no photos, drafts left out of the totals
    return () => { live = false }
  }, [])

  // Only the order type's default is ever picked for the cashier (OrderPad's rule).
  useEffect(() => {
    if (!catalogs) return
    const def = catalogs.find((c) => c.isDefault)
    if (catalogId !== null && catalogId !== (initialCatalogId ?? null) && lines.length === 0
        && !catalogs.some((c) => c.id === catalogId)) {
      setCatalogId(def?.id ?? null)
      return
    }
    if (catalogId === null && def) setCatalogId(def.id)
  }, [catalogs, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    const seq = ++loadSeq.current
    const id = catalogIdRef.current
    if (!id) { setMenu(null); return }
    try {
      const m = await fetchPosMenu(id)
      if (seq === loadSeq.current) { setMenu(m); setError(null) }
    } catch (e) {
      if (seq === loadSeq.current) setError(msg(e))
    }
  }
  useEffect(() => { void load() }, [branchId, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = catalogs?.find((c) => c.id === catalogId) ?? null
  const noCatalog = catalogs !== null && catalogId === null && !catalogs.some((c) => c.isDefault)

  const doSwitch = (id: string, carrying: boolean) => {
    setCarry(carrying ? { lines, to: id } : null)
    if (!carrying) setLines([])
    setSheet(null); setMenu(null); setCategory(null); setNotice(null); setCatalogId(id)
  }
  // One order = one catalog: switching starts the cart again (asked first, in the POS's own dialog).
  const switchCatalog = (id: string) => {
    if (!id || id === catalogId) return
    const carrying = lines.length > 0 && !!current && !current.offered
    if (!carrying && lines.length > 0) {
      setConfirm({ title: SWITCH_CATALOG_CONFIRM, message: 'The items not sent yet are removed.', confirmLabel: 'Switch catalog', danger: true,
        onConfirm: () => doSwitch(id, false) })
      return
    }
    doSwitch(id, carrying)
  }
  useEffect(() => {
    if (!carry || !menu || carry.to !== catalogId) return
    const kept = carry.lines.filter((l) => {
      const p = findProduct(menu, l.productId)
      return p !== undefined && validateLine(p, l) === null
    })
    setLines(kept)
    if (kept.length < carry.lines.length) setNotice(`Items not in ${current?.name ?? 'this catalog'} were removed`)
    setCarry(null)
  }, [menu, carry, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const shownMenu = useMemo(() => (menu ? withPhotos(menu, info) : null), [menu, info])
  const products = useMemo(() => {
    if (!shownMenu) return []
    const all = shownMenu.categories.flatMap((c) => c.products.map((p) => ({ ...p, category: c.name })))
    const q = search.trim().toLowerCase()
    return all.filter((p) => (q ? p.name.toLowerCase().includes(q) : !category || p.category === category))
  }, [shownMenu, category, search])

  const tap = async (p: PosProduct, outOfSlot: boolean) => {
    if (soldOutMode) {
      try { await setSoldOut(branchId, p.id, !p.soldOut); await load() } catch (e) { setError(msg(e)) }
      return
    }
    if (!takesNewItems(target)) { setError(TAKEAWAY_ONE_ORDER); return }
    if (p.soldOut || outOfSlot) return
    if (p.variants.length === 1 && p.groups.length === 0) setLines((ls) => [...ls, defaultLine(p)])
    else setSheet({ product: p, index: null })
  }

  // ── the bill: sent items from the server (BillPanel's reads, unchanged) ──
  const [items, setItems] = useState<BillItemRow[] | null>(null)   // null = not loaded yet for this bill
  const [itemsError, setItemsError] = useState<string | null>(null)
  const [localKey, setLocalKey] = useState(0)
  useEffect(() => { setItems(null); setItemsError(null) }, [bill?.id])
  useEffect(() => {
    if (!bill) return
    let alive = true
    fetchBillItems(bill.id).then(
      (rows) => { if (alive) { setItems(rows); setItemsError(null) } },
      (e) => { if (alive) setItemsError(msg(e)) },
    )
    return () => { alive = false }
  }, [bill?.id, refreshKey, localKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const loaded = !bill || (items !== null && !itemsError)            // only then is it known whether the bill is empty

  const view = billView({
    orderType: bill?.order_type ?? orderType,
    tableId: bill ? bill.table_id : target.kind === 'table' ? target.tableId : null,
    items: bill ? items ?? [] : [], lines, menu, info, billing,
  })
  useEffect(() => { onDraftCount(view.draftCount) }, [view.draftCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── dialogs and one bill action at a time (BillPanel's run) ──
  const [dialog, setDialog] = useState<Dialog>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  useEffect(() => { setDialog(null) }, [bill?.id])
  const run = async (fn: () => Promise<void>, then?: () => void) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      try { await fn() } catch (e) { setDialog(null); setError(msg(e)); return }
      setDialog(null); setLocalKey((k) => k + 1)
      await onChanged()
      then?.()
    } finally { busyRef.current = false; setBusy(false) }
  }

  const [paused, setPaused] = useState(table?.qr_paused ?? false)
  useEffect(() => { setPaused(table?.qr_paused ?? false) }, [table?.id, table?.qr_paused])
  const togglePause = async () => {
    if (!table) return
    const next = !paused
    setPaused(next)
    try { await setTablePaused(table.id, next); void onChanged() } catch (e) { setPaused(!next); setError(msg(e)) }
  }

  // ── Send, Send & pay, Payment, back ──
  /** The drafts as one order through the queue; the order's id once it is stored, else null (the error shows). */
  const sendDrafts = async (): Promise<string | null> => {
    if (sendingRef.current || !menu || lines.length === 0) return null
    if (!takesNewItems(target)) { setError(TAKEAWAY_ONE_ORDER); return null }
    if (!catalogId) { setError(noCatalogMessage(orderType)); return null }
    for (const l of lines) {
      const p = findProduct(menu, l.productId)
      const problem = p ? validateLine(p, l) : 'Item is no longer on the menu'
      if (problem) { setError(problem); return null }
    }
    sendingRef.current = true; setSending(true)
    try {
      const late = await slots.check(lines, (id) => findProduct(menu, id)?.name ?? 'An item')
      if (late) { setError(late); return null }                     // the server would refuse it with the same words
      // the pax chosen for an empty table goes with its first order (the server only fills an empty pax)
      const pax = target.kind === 'table' && !bill?.pax ? target.pax : null
      const res = await submit(newQueuedOrder(orderType, target.kind === 'table' ? target.tableId : null, pax, lines,
        Date.now(), crypto.randomUUID(), catalogId))
      if (res.rejectedReason) { setError(`Rejected: ${res.rejectedReason} — fix the order and send again`); await load(); return null }
      setLines([]); setError(null)
      return res.clientOrderId
    } catch (e) {
      setError(`Order NOT saved on this iPad: ${msg(e)}`)
      return null
    } finally { sendingRef.current = false; setSending(false) }
  }
  const send = async () => { if (await sendDrafts()) onSent() }
  const sendAndPay = async () => {
    const id = await sendDrafts()
    if (!id) return
    sendingRef.current = true; setSending(true)
    try { await onSendAndPay(id) } catch (e) { setError(msg(e)) } finally { sendingRef.current = false; setSending(false) }
  }

  const gate = payGate({ shiftOpen, draftCount: view.draftCount, hasBill: !!bill, liveSentCount: view.liveSentCount })
  const pay = () => {
    if (gate === 'send_first') {
      setConfirm({ title: sendFirstQuestion(view.draftCount), message: 'They go to the kitchen, then Payment opens.', confirmLabel: 'Send & pay',
        onConfirm: () => void sendAndPay() })
      return
    }
    if (gate === 'ready' && bill && loaded) onPay(bill)
  }
  const back = () => {
    if (view.draftCount > 0) {
      setConfirm({ title: discardQuestion(view.draftCount), confirmLabel: 'Discard', danger: true, onConfirm: onBack })
      return
    }
    onBack()
  }

  // ── bill actions ──
  const actions = billActions({
    isTable: target.kind === 'table', hasBill: !!bill, loaded, liveSentCount: view.liveSentCount, draftCount: view.draftCount,
    qrPaused: paused, qrRequiresOpenBill: billing?.settings.qrRequiresOpenBill ?? false,
  })
  const pickAction = (a: BillAction) => {
    setDialog(null)
    if (a === 'send') void send()
    else if (a === 'move') setDialog({ kind: 'move' })
    else if (a === 'void_bill') setDialog({ kind: 'void_bill' })
    else if (a === 'close_empty' && bill) {
      setConfirm({ title: `Close bill ${bill.bill_no}?`, message: 'It has nothing on it.', confirmLabel: 'Close bill', danger: true,
        onConfirm: () => void run(() => voidBill(bill.id, { reason: '', approverId: null, pin: null }), () => { if (lines.length === 0) onBack() }) })
    } else if (a === 'pax') setDialog({ kind: 'pax', purpose: 'set' })
    else if (a === 'open_qr') setDialog({ kind: 'pax', purpose: 'open_qr' })
    else if (a === 'pause_qr' || a === 'resume_qr') void togglePause()
  }
  const pickPax = (n: number) => {
    const purpose = dialog?.kind === 'pax' ? dialog.purpose : 'set'
    setDialog(null)
    if (purpose === 'open_qr' && table) { void run(async () => { await openTable(table.id, n) }); return }
    if (bill) { void run(() => setBillPax(bill.id, n)); return }
    if (target.kind === 'table') onTarget({ ...target, pax: n })
  }
  const pickMove = (m: MoveTarget) => {
    if (!bill || busyRef.current || m.kind === 'refused') return
    const landed = () => onTarget({ kind: 'table', tableId: m.tableId, pax: null })
    if (m.kind === 'move') { void run(() => moveBill(bill.id, m.tableId), landed); return }
    setConfirm({ title: `Merge into ${m.label}?`, message: `Every item of bill ${bill.bill_no} moves onto bill ${m.intoBillNo}, and this bill closes.`,
      confirmLabel: 'Merge', onConfirm: () => void run(() => mergeBills(bill.id, m.intoBillId), landed) })
  }
  const tapDraft = (d: DraftRow) => {
    const p = menu ? findProduct(menu, d.line.productId) : undefined
    if (p) { setSheet({ product: p, index: d.index }); return }
    setConfirm({ title: 'Remove this item?', message: 'It is no longer on the menu.', confirmLabel: 'Remove', danger: true,
      onConfirm: () => setLines((ls) => ls.filter((_, k) => k !== d.index)) })
  }

  const title = targetTitle(target, bill, tables)
  const tileNotice = !takesNewItems(target) ? (bill ? TAKEAWAY_ONE_ORDER : BILL_GONE) : null
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-card p-2">
          <button type="button" onClick={back} disabled={sending} aria-label="Back to tables"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border-mid disabled:opacity-40"><ArrowLeft size={20} /></button>
          <label className="relative flex-1">
            <Search size={18} className="pointer-events-none absolute left-3 top-3 text-brown-muted" />
            <input className="h-11 w-full rounded-xl border border-border-mid pl-9 pr-3 text-base" placeholder="Search menu"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button type="button" onClick={() => setSoldOutMode((v) => !v)} aria-pressed={soldOutMode}
            className={`h-11 shrink-0 rounded-xl px-4 text-sm font-medium ${soldOutMode ? 'bg-red-600 text-white' : 'border border-border-mid text-brown-dark'}`}>
            {soldOutMode ? 'Sold out · Done' : 'Sold out'}
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Categories" className="w-[200px] shrink-0 space-y-1 overflow-y-auto border-r border-border bg-card p-2">
            {[null, ...(menu?.categories.map((c) => c.name) ?? [])].map((name) => {
              const on = !search && category === name
              return (
                <button key={name ?? '*'} type="button" onClick={() => { setCategory(name); setSearch('') }}
                  className={`min-h-12 w-full rounded-lg px-3 text-left text-sm font-medium ${on ? 'bg-brown-dark text-cream' : 'text-brown-dark hover:bg-cream'}`}>
                  {name ?? 'All'}
                </button>
              )
            })}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            {soldOutMode && <p className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">Tap items to mark them sold out, or back on sale.</p>}
            {error && <p role="alert" className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
            {notice && <p role="status" className="m-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{notice}</p>}
            <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto p-3">
              {catalogs === null && catalogsError && (
                <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">
                  Could not load the menu catalogs: {catalogsError}{' '}
                  <button type="button" className="underline" onClick={() => setCatalogsTry((n) => n + 1)}>Retry</button>
                </p>
              )}
              {noCatalog && (
                <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">
                  {defaultProblem ?? noCatalogMessage(orderType)}
                  {catalogs.length > 0 && ' — or choose a catalog on the bill for this order.'}
                </p>
              )}
              {!menu && !error && !noCatalog && !(catalogs === null && catalogsError) && <p className="col-span-4 text-brown-muted">Loading menu…</p>}
              <ProductTiles products={products} windows={slots.windows} now={slots.now} soldOutMode={soldOutMode}
                onTap={(p, outOfSlot) => void tap(p, outOfSlot)} />
            </div>
          </div>
        </div>
      </div>

      <BillColumn
        title={title}
        billNo={bill?.bill_no ?? null}
        pax={shownPax(target, bill)}
        onPax={target.kind === 'table' ? () => setDialog({ kind: 'pax', purpose: 'set' }) : null}
        catalogName={current?.name ?? null}
        catalogIsExtra={!!current && !current.isDefault}
        onCatalog={catalogs && catalogs.length > 1 && !sending && takesNewItems(target) ? () => setDialog({ kind: 'catalog' }) : null}
        view={view}
        loading={!!bill && items === null && !itemsError}
        loadError={itemsError}
        notice={tileNotice}
        onSentTap={(row) => setDialog({ kind: 'void_item', row })}
        onDraftTap={tapDraft}
        onActions={() => setDialog({ kind: 'actions' })}
        onSend={() => void send()}
        sendDisabled={sending || lines.length === 0}
        sending={sending}
        payLabel={view.totals ? `Payment ${formatSen(view.totals.totalSen)}` : 'Payment'}
        payDisabled={sending || gate === 'no_shift' || gate === 'empty' || (gate === 'ready' && !loaded)}
        payHint={gate === 'no_shift' ? NO_SHIFT_PAY : null}
        onPay={pay}
      />

      {sheet && (
        <ModifierSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          onCancel={() => setSheet(null)}
          onRemove={sheet.index === null ? undefined : () => { const i = sheet.index; setLines((ls) => ls.filter((_, k) => k !== i)); setSheet(null) }}
          onDone={(line) => { setLines((ls) => (sheet.index === null ? [...ls, line] : ls.map((x, k) => (k === sheet.index ? line : x)))); setSheet(null) }} />
      )}
      {dialog?.kind === 'actions' && (
        <BillActionsOverlay title={title} actions={actions} disabled={busy || sending} onPick={pickAction} onClose={() => setDialog(null)} />
      )}
      {bill && dialog?.kind === 'move' && (
        <MoveToGrid billNo={bill.bill_no} targets={moveTargets(bill, tables, bills, summaries)} busy={busy}
          onPick={pickMove} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'pax' && (
        <PaxDialog title={title} current={shownPax(target, bill)} onPick={pickPax} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'catalog' && (
        <PickerSheet title="Catalog" hint="This order is priced from the catalog you choose."
          options={(catalogs ?? []).map((c) => ({ id: c.id, label: c.name, detail: c.isDefault ? 'Default' : c.offered ? 'Additional' : 'No longer offered' }))}
          empty="No catalog is set for this branch." onClose={() => setDialog(null)}
          onPick={(id) => { setDialog(null); switchCatalog(id) }} />
      )}
      {bill && dialog?.kind === 'void_item' && (
        <ApprovalDialog branchId={branchId} action="void_item" title="Void item"
          summary={`${dialog.row.qty} × ${dialog.row.name} · ${formatSen(dialog.row.amountSen)} — the kitchen gets a VOID ticket`}
          onApprove={(a) => voidItem(dialog.row.item.id, a)} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); setLocalKey((k) => k + 1); void onChanged() }} />
      )}
      {bill && dialog?.kind === 'void_bill' && (
        <ApprovalDialog branchId={branchId} action="void_bill" title="Void bill"
          summary={`Bill ${bill.bill_no} · ${view.liveSentCount} item${view.liveSentCount === 1 ? '' : 's'}${summaries.get(bill.id) ? ` · ${formatSen(summaries.get(bill.id)?.totalSen ?? 0)}` : ''} — every item is voided and the table is freed`}
          onApprove={(a) => voidBill(bill.id, a)} onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); void onChanged(); if (lines.length === 0) onBack() }} />
      )}
      {confirm && (
        <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck and run the order tests**

Run: `npx tsc -b && npx vitest run src/features/pos/order/`
Expected: tsc prints nothing; all order tests PASS. (`OrderScreen` is wired in Task 12; until then `/pos` still shows the old screens.)

- [ ] **Step 3: Commit**

```bash
git add src/features/pos/order/OrderScreen.tsx
git commit -m "feat(pos): Feedme order screen with categories, tiles and bill (drafts, Send, Send & pay, bill actions)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full-screen Payment

**Files:**
- Create: `src/features/pos/checkout/payTabs.ts`, Test: `src/features/pos/checkout/payTabs.test.ts`
- Create: `src/features/pos/checkout/PaymentScreen.tsx`, Test: `src/features/pos/checkout/PaymentScreen.test.tsx`

**Interfaces:**
- Consumes: `tender.ts` (`changeSen`, `lineProblem`, `parseRinggit`, `payProblem`, `quickTenders`, `remainingSen`, `toPayments`, `TenderLine`, `TenderMethod`, `PaymentKind`), `paySession.ts`, `follow.ts`, `looksOffline`, `checkoutBill`, `fetchCheckoutState`, `fetchPaymentMethods`, `CheckoutTotals`, `fetchBillItems`, `formatSen` — all unchanged.
- Produces:
  - payTabs.ts: `type PayTab = 'cash' | 'card' | 'epay' | 'other'`, `PAY_TAB_LABEL`, `interface PayTabGroup { tab: PayTab; label: string; methods: TenderMethod[] }`, `payTabs(methods: TenderMethod[]): PayTabGroup[]`, `NUMPAD_KEYS`, `numpadPress(text: string, key: string): string`, `singleLines(method: TenderMethod, totalSen: number, receivedText: string, reference: string): { lines: Omit<TenderLine, 'key'>[] } | { problem: string }`, `liveChangeSen(dueSen: number, receivedText: string): number | null`
  - `default PaymentScreen(props: { branchId: string; bill: OpenBillRow; title: string; refreshKey: number; earlierIds: string[]; onSendIds: (ids: string[]) => void; onClose: () => void; onPaid: () => void })` — the same props as `CheckoutSheet`.

- [ ] **Step 1: Write the failing helper tests**

Create `src/features/pos/checkout/payTabs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { liveChangeSen, numpadPress, payTabs, singleLines } from './payTabs'
import type { TenderMethod } from './tender'

const m = (id: string, kind: TenderMethod['kind'], needsReference = false): TenderMethod => ({ id, name: id, kind, needsReference })
const cash = m('Cash', 'cash')
const card = m('Visa', 'card', true)

describe('payTabs', () => {
  it('groups methods into Cash, Card, E-payment and Other, in that order, keeping each tab\'s order', () => {
    const tabs = payTabs([m('TNG', 'ewallet'), card, m('Voucher', 'other'), cash, m('DuitNow QR', 'duitnow')])
    expect(tabs.map((t) => [t.label, t.methods.map((x) => x.id)])).toEqual([
      ['Cash', ['Cash']], ['Card', ['Visa']], ['E-payment', ['TNG', 'DuitNow QR']], ['Other', ['Voucher']],
    ])
  })
  it('leaves out a tab with no active method', () => {
    expect(payTabs([cash, m('TNG', 'ewallet')]).map((t) => t.tab)).toEqual(['cash', 'epay'])
    expect(payTabs([])).toEqual([])
  })
})

describe('numpadPress', () => {
  const type = (keys: string[]) => keys.reduce(numpadPress, '')
  it('types ringgit and sen', () => {
    expect(type(['5', '0'])).toBe('50')
    expect(type(['1', '2', '.', '5'])).toBe('12.5')
    expect(type(['.', '5'])).toBe('0.5')
    expect(type(['0', '7'])).toBe('7')
  })
  it('ignores a second point, a third decimal and a seventh whole digit', () => {
    expect(type(['1', '.', '.', '2'])).toBe('1.2')
    expect(type(['1', '.', '2', '5', '9'])).toBe('1.25')
    expect(type(['1', '2', '3', '4', '5', '6', '7'])).toBe('123456')
  })
  it('backspace and clear', () => {
    expect(numpadPress('12.5', '⌫')).toBe('12.')
    expect(numpadPress('', '⌫')).toBe('')
    expect(numpadPress('12.5', 'C')).toBe('')
  })
})

describe('singleLines', () => {
  it('cash exact, cash with change, a card with its reference', () => {
    expect(singleLines(cash, 10670, '', '')).toEqual({ lines: [{ method: cash, amountSen: 10670, tenderedSen: null, reference: null }] })
    expect(singleLines(cash, 10670, '150', '')).toEqual({ lines: [{ method: cash, amountSen: 10670, tenderedSen: 15000, reference: null }] })
    expect(singleLines(card, 10670, '', ' 123456 ')).toEqual({ lines: [{ method: card, amountSen: 10670, tenderedSen: null, reference: '123456' }] })
  })
  it('the same words as tender.ts when something is missing', () => {
    expect(singleLines(cash, 10670, '100', '')).toEqual({ problem: 'Cash received is less than the amount' })
    expect(singleLines(cash, 10670, 'abc', '')).toEqual({ problem: 'Enter the cash received' })
    expect(singleLines(card, 10670, '', '')).toEqual({ problem: 'Enter the reference for Visa' })
  })
  it('a bill of RM 0.00 takes no payment', () => {
    expect(singleLines(cash, 0, '', '')).toEqual({ lines: [] })
  })
})

describe('liveChangeSen', () => {
  it('exact is no change; short or unreadable is null', () => {
    expect(liveChangeSen(10670, '')).toBe(0)
    expect(liveChangeSen(10670, '150')).toBe(4330)
    expect(liveChangeSen(10670, '100')).toBeNull()
    expect(liveChangeSen(10670, '1.2.3')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/pos/checkout/payTabs.test.ts`
Expected: FAIL — `Failed to resolve import "./payTabs"`.

- [ ] **Step 3: Implement the helpers**

Create `src/features/pos/checkout/payTabs.ts`:

```ts
// src/features/pos/checkout/payTabs.ts
/** Pure parts of the full-screen Payment (spec §4): the method tabs, the number pad, and the one
 *  payment of a bill paid in one go. tender.ts keeps every money rule; this only arranges it. */
import { lineProblem, parseRinggit, type PaymentKind, type TenderLine, type TenderMethod } from './tender'

export type PayTab = 'cash' | 'card' | 'epay' | 'other'
export const PAY_TAB_LABEL: Record<PayTab, string> = { cash: 'Cash', card: 'Card', epay: 'E-payment', other: 'Other' }
const TAB_OF: Record<PaymentKind, PayTab> = { cash: 'cash', card: 'card', duitnow: 'epay', ewallet: 'epay', other: 'other' }
const ORDER: PayTab[] = ['cash', 'card', 'epay', 'other']

export interface PayTabGroup { tab: PayTab; label: string; methods: TenderMethod[] }

/** Cash · Card · E-payment (DuitNow and e-wallets) · Other, each with its active methods in their
 *  order; a tab with none is left out. */
export function payTabs(methods: TenderMethod[]): PayTabGroup[] {
  return ORDER
    .map((tab) => ({ tab, label: PAY_TAB_LABEL[tab], methods: methods.filter((m) => TAB_OF[m.kind] === tab) }))
    .filter((g) => g.methods.length > 0)
}

export const NUMPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const

/** One key on the number pad. The text only ever becomes something parseRinggit reads (at most
 *  6 whole digits and 2 decimals); a key that would break that is ignored. 'C' clears. */
export function numpadPress(text: string, key: string): string {
  if (key === 'C') return ''
  if (key === '⌫') return text.slice(0, -1)
  if (key === '.') return text.includes('.') ? text : text === '' ? '0.' : `${text}.`
  if (!/^\d$/.test(key)) return text
  const next = text === '0' ? key : text + key
  return parseRinggit(next) === null ? text : next
}

/** The bill paid in one go (Split payment off): one payment of the whole total with the chosen
 *  method; cash with what was received ('' = exact). A bill of RM 0.00 takes no payment. */
export function singleLines(method: TenderMethod, totalSen: number, receivedText: string, reference: string):
  { lines: Omit<TenderLine, 'key'>[] } | { problem: string } {
  if (totalSen === 0) return { lines: [] }
  let tenderedSen: number | null = null
  if (method.kind === 'cash' && receivedText.trim()) {
    tenderedSen = parseRinggit(receivedText)
    if (tenderedSen === null) return { problem: 'Enter the cash received' }
  }
  const line = { method, amountSen: totalSen, tenderedSen, reference: reference.trim() || null }
  const problem = lineProblem(line, totalSen)
  return problem ? { problem } : { lines: [line] }
}

/** The change shown live on the Cash tab: 0 for exact, null while the cash received is short or unreadable. */
export function liveChangeSen(dueSen: number, receivedText: string): number | null {
  if (!receivedText.trim()) return 0
  const received = parseRinggit(receivedText)
  return received === null || received < dueSen ? null : received - dueSen
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/features/pos/checkout/payTabs.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing screen test**

Create `src/features/pos/checkout/PaymentScreen.test.tsx`:

```tsx
// @vitest-environment jsdom
// The full-screen Payment keeps the Checkout sheet's money logic: these drive it the way a cashier
// does and check what reaches checkout_bill.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  fetchCheckoutState: vi.fn(),
  fetchPaymentMethods: vi.fn(),
  checkoutBill: vi.fn(),
  fetchBillItems: vi.fn(),
}))
vi.mock('./checkoutApi', () => ({
  fetchCheckoutState: api.fetchCheckoutState,
  fetchPaymentMethods: api.fetchPaymentMethods,
  checkoutBill: api.checkoutBill,
}))
vi.mock('../order/posApi', () => ({ fetchBillItems: api.fetchBillItems }))

import PaymentScreen from './PaymentScreen'

const totals = {
  subtotalSen: 10066, serviceChargeSen: 0, sstSen: 604, takeawayFeeSen: 0, beforeRoundingSen: 10670,
  roundingSen: 0, totalSen: 10670, sstGroups: [], serviceChargeGroups: [],
}
const bill = { id: 'b1', bill_no: '261026-001', table_id: 't3', order_type: 'dine_in' as const, pax: 2, opened_at: '2026-10-26T02:00:00Z' }
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

function renderScreen(onPaid = vi.fn()) {
  render(<PaymentScreen branchId="br" bill={bill} title="Table T3" refreshKey={0} earlierIds={[]}
    onSendIds={() => {}} onClose={() => {}} onPaid={onPaid} />)
  return onPaid
}

beforeEach(() => {
  api.fetchCheckoutState.mockResolvedValue({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals, result: null })
  api.fetchPaymentMethods.mockResolvedValue([
    { id: 'm-cash', branch_id: 'br', name: 'Cash', kind: 'cash', needs_reference: false, sort_order: 1, is_active: true },
    { id: 'm-visa', branch_id: 'br', name: 'Visa', kind: 'card', needs_reference: true, sort_order: 2, is_active: true },
  ])
  api.fetchBillItems.mockResolvedValue([])
  api.checkoutBill.mockReset()
})
afterEach(cleanup)

describe('PaymentScreen', () => {
  it('cash in one go: the number pad shows the change, Pay sends one payment with the cash received', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 4330, receiptQueued: true })
    const onPaid = renderScreen()
    await flush()
    expect(screen.getByText('RM 106.70', { selector: 'div' })).toBeTruthy()
    press('1'); press('5'); press('0')
    expect(screen.getByText('Received RM 150 · Change RM 43.30')).toBeTruthy()
    press('Pay RM 106.70')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(1)
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([{ methodId: 'm-cash', amountSen: 10670, tenderedSen: 15000, reference: null }])
    expect(screen.getByText('RM 43.30')).toBeTruthy()
    press('Done')
    expect(onPaid).toHaveBeenCalledTimes(1)
  })

  it('a card asks for its reference on the Card tab', async () => {
    renderScreen()
    await flush()
    fireEvent.click(screen.getByRole('tab', { name: 'Card' }))
    press('Pay RM 106.70')
    expect(screen.getByText('Enter the reference for Visa')).toBeTruthy()
    expect(api.checkoutBill).not.toHaveBeenCalled()
  })

  it('no reply: Try again resends the same payment under the same checkout id', async () => {
    api.checkoutBill.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.checkoutBill.mockResolvedValueOnce({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true })
    renderScreen()
    await flush()
    press('Pay RM 106.70')
    await flush()
    expect(screen.getByText(/Not sure the payment went through/)).toBeTruthy()
    press('Try again')
    await flush()
    expect(api.checkoutBill).toHaveBeenCalledTimes(2)
    expect(api.checkoutBill.mock.calls[1][1]).toEqual(api.checkoutBill.mock.calls[0][1])
    expect(api.checkoutBill.mock.calls[1][2]).toBe(api.checkoutBill.mock.calls[0][2])
  })

  it('split payment: Pay waits until the payments add up to the total', async () => {
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 10670, changeSen: 0, receiptQueued: true })
    renderScreen()
    await flush()
    press('Split payment')
    press('C'); press('5'); press('0')
    press('Add Cash')
    expect((screen.getByRole('button', { name: 'Pay RM 106.70' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('RM 56.70', { selector: 'div' })).toBeTruthy()      // left to pay
    press('Add Cash')                                                           // the rest, prefilled
    press('Pay RM 106.70')
    await flush()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([
      { methodId: 'm-cash', amountSen: 5000, tenderedSen: null, reference: null },
      { methodId: 'm-cash', amountSen: 5670, tenderedSen: null, reference: null },
    ])
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/features/pos/checkout/PaymentScreen.test.tsx`
Expected: FAIL — `Failed to resolve import "./PaymentScreen"`.

- [ ] **Step 7: Implement the Payment screen**

Create `src/features/pos/checkout/PaymentScreen.tsx` (the follow / session / Check bill code is `CheckoutSheet`'s, line for line; only `send` takes the lines to send so the one-go payment and Try again share it):

```tsx
// src/features/pos/checkout/PaymentScreen.tsx
import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { fetchBillItems, type BillItemRow, type OpenBillRow } from '../order/posApi'
import type { BillTotals } from './bill'
import { checkoutBill, fetchCheckoutState, fetchPaymentMethods, type CheckoutResult } from './checkoutApi'
import CheckoutTotals from './CheckoutTotals'
import { followBill, type FollowAction } from './follow'
import { CHECKED_OPEN, UNSURE, checkoutIds, linesLocked, newPaySession, nextPay, type PayEvent, type PaySession } from './paySession'
import { looksOffline } from './rpcResult'
import {
  changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments,
  type TenderLine, type TenderMethod,
} from './tender'
import { NUMPAD_KEYS, liveChangeSen, numpadPress, payTabs, singleLines, type PayTab } from './payTabs'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const money = (sen: number) => (Math.max(0, sen) / 100).toFixed(2)

/** Full-screen Payment (spec §4), replacing the Checkout sheet. Its logic is the sheet's, unchanged:
 *  the server's totals (pos_checkout_state, re-read on every bills event and sweep), one checkout id
 *  per attempt (paySession: Try again after a lost reply never charges twice, Check bill), the
 *  follow rules (paid / voided / merged on another iPad locks the screen) and tender.ts' checks.
 *  New is only the layout: the bill on the left; the amount, method tabs, quick tender and number
 *  pad on the right; Split payment for several payments. */
export default function PaymentScreen({ branchId, bill, title, refreshKey, earlierIds, onSendIds, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3" or "Takeaway 261024-004"
  refreshKey: number            // bumped on every bills event, order and 15 s sweep: re-read the bill
  earlierIds: string[]          // checkout ids an earlier Payment of this bill used on this iPad
  onSendIds: (ids: string[]) => void   // every id used so far, at each send: PosPage keeps them per bill
  onClose: () => void           // Cancel payment: back to the bill
  onPaid: () => void            // Done on the success screen: back home
}) {
  const [totals, setTotals] = useState<BillTotals | null>(null)
  const [methods, setMethods] = useState<TenderMethod[]>([])
  const [items, setItems] = useState<BillItemRow[] | null>(null)
  const [lines, setLines] = useState<TenderLine[]>([])
  const [split, setSplit] = useState(false)
  const [tab, setTab] = useState<PayTab | null>(null)
  const [method, setMethod] = useState<TenderMethod | null>(null)
  const [entry, setEntry] = useState('')            // the number pad: cash received (whole bill) or this payment's amount (split)
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [methodsError, setMethodsError] = useState<string | null>(null)
  const [changeNote, setChangeNote] = useState<string | null>(null)   // the bill changed on another iPad
  const [lockNote, setLockNote] = useState<string | null>(null)       // paid, voided or merged on another iPad
  const [result, setResult] = useState<CheckoutResult | null>(null)
  const [session, setSession] = useState<PaySession>(() => newPaySession(crypto.randomUUID(), earlierIds))
  const sessionRef = useRef(session)
  const totalsRef = useRef<BillTotals | null>(null)
  const loadFailed = useRef(false)
  const readSeq = useRef(0)
  const keySeq = useRef(0)

  // ── the Checkout sheet's follow logic, unchanged ──
  const step = (e: PayEvent): PaySession => {
    const s = nextPay(sessionRef.current, e)
    sessionRef.current = s
    setSession(s)
    if (e.type === 'send') onSendIds(checkoutIds(s))
    return s
  }
  const apply = (a: FollowAction) => {
    if (a.kind === 'paidHere') setResult(a.result)
    else if (a.kind === 'lock') { setLockNote(a.note); setMethod(null); setError(null); setChangeNote(null) }
    else if (a.kind === 'reload') {
      totalsRef.current = a.totals
      setTotals(a.totals)
      if (a.note) setChangeNote(a.note)
    }
  }
  const follow = async () => {
    const seq = ++readSeq.current
    try {
      const state = await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current))
      if (seq !== readSeq.current) return
      apply(followBill(state, totalsRef.current?.totalSen ?? null))
      if (loadFailed.current) { loadFailed.current = false; setError(null) }
    } catch (e) {
      if (seq === readSeq.current && !totalsRef.current) { loadFailed.current = true; setError(msg(e)) }
    }
  }
  useEffect(() => {
    let live = true
    setMethodsError(null)
    fetchPaymentMethods(branchId, true)
      .then((rows) => { if (live) setMethods(rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, needsReference: m.needs_reference }))) })
      .catch((e) => { if (live) setMethodsError(msg(e)) })
    return () => { live = false }
  }, [branchId])
  useEffect(() => {
    const phase = sessionRef.current.phase
    if (!result && !lockNote && phase !== 'paying' && phase !== 'checking') void follow()
  }, [bill.id, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true
    fetchBillItems(bill.id).then((rows) => { if (live) setItems(rows) }, () => undefined)   // the list is for reading; the totals are the server's
    return () => { live = false }
  }, [bill.id, refreshKey])

  const total = totals?.totalSen ?? 0
  const left = remainingSen(total, lines)
  const locked = linesLocked(session) || lockNote !== null
  const busy = session.phase === 'paying' || session.phase === 'checking'
  const tabs = payTabs(methods)
  const shownTab = tabs.find((t) => t.tab === tab) ?? tabs[0] ?? null
  const due = split ? left : total

  const pick = (m: TenderMethod) => {
    if (locked) return
    setMethod(m); setError(null); setReference('')
    setEntry(split ? money(left) : '')
  }
  useEffect(() => {                                  // the first method of the first tab, once they are loaded
    if (!method && !lockNote && tabs[0]) setMethod(tabs[0].methods[0])
  }, [methods]) // eslint-disable-line react-hooks/exhaustive-deps
  const chooseTab = (t: PayTab) => {
    const g = tabs.find((x) => x.tab === t)
    if (!g || locked) return
    setTab(t); pick(g.methods[0])
  }
  const toggleSplit = () => {
    if (locked) return
    const next = !split
    setSplit(next); setLines([]); setError(null); setReference('')
    setEntry(next ? money(total) : '')
  }

  // Split: add one payment (CheckoutSheet's add, unchanged rules)
  const add = (tenderedOverride?: number | null) => {
    if (!method || locked) return
    const amountSen = parseRinggit(entry)
    if (amountSen === null) { setError('Enter the amount'); return }
    const tenderedSen = method.kind === 'cash' && tenderedOverride !== undefined ? tenderedOverride : null
    const line = { method, amountSen, tenderedSen, reference: reference.trim() || null }
    const problem = lineProblem(line, left)
    if (problem) { setError(problem); return }
    const next = [...lines, { ...line, key: String(++keySeq.current) }]
    setLines(next); setReference(''); setError(null)
    setEntry(money(remainingSen(total, next)))
  }

  // Pay (editing) and Try again (unsure): Try again resends the SAME lines under the session's id
  const send = async (toSend: TenderLine[]) => {
    const s = sessionRef.current
    if (!totals || lockNote || (s.phase !== 'editing' && s.phase !== 'unsure')) return
    const sending = s.phase === 'unsure' ? lines : toSend
    if (s.phase === 'editing') {
      const problem = payProblem(total, sending)
      if (problem) { setError(problem); return }
      setLines(sending)
    }
    step({ type: 'send' }); setError(null); setChangeNote(null)
    try {
      setResult(await checkoutBill(bill.id, toPayments(sending), s.checkoutId))
    } catch (e) {
      const m = msg(e)
      if (looksOffline(m)) { step({ type: 'noReply' }); setError(UNSURE); void follow() }
      else { step({ type: 'refused' }); setError(m); void follow() }
    }
  }
  const pay = () => {
    if (session.phase === 'unsure' || split) { void send(lines); return }
    if (!method) { setError('Choose how the bill is paid'); return }
    const r = singleLines(method, total, entry, reference)
    if ('problem' in r) { setError(r.problem); return }
    void send(r.lines.map((l) => ({ ...l, key: String(++keySeq.current) })))
  }

  // Check bill: paid by this screen → its result; open → unlock with a new id; else lock
  const checkBill = async () => {
    if (sessionRef.current.phase !== 'unsure') return
    step({ type: 'check' }); setError(null)
    ++readSeq.current
    try {
      const a = followBill(await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current)), totalsRef.current?.totalSen ?? null)
      apply(a)
      if (a.kind === 'keep' || a.kind === 'reload') { step({ type: 'checkedOpen', newCheckoutId: crypto.randomUUID() }); setError(CHECKED_OPEN) }
      else step({ type: 'checkEnded' })
    } catch (e) {
      step({ type: 'checkEnded' }); setError(`Could not check the bill: ${msg(e)}`)
    }
    void follow()
  }

  if (result) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-cream p-6">
        <div className="w-full max-w-md rounded-2xl bg-card p-8 text-center shadow-card">
          <div className="text-sm text-brown-muted">Bill {result.billNo} paid · {formatSen(result.totalSen)}</div>
          <div className="mt-6 text-sm uppercase tracking-wide text-brown-muted">Change</div>
          <div className="text-6xl font-semibold text-brown-dark tabular-nums">{formatSen(result.changeSen)}</div>
          <p className="mt-6 text-sm text-brown-muted">
            {result.receiptQueued ? 'Receipt printing…' : 'No receipt printer is set — choose one in POS settings.'}
          </p>
          <button type="button" onClick={onPaid} className="mt-8 min-h-14 w-full rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover">Done</button>
        </div>
      </div>
    )
  }

  const live = (items ?? []).filter((i) => !i.voided_at)
  const itemCount = live.reduce((n, i) => n + i.qty, 0)
  const showPad = !locked && method !== null && (split || method.kind === 'cash')
  const change = !split && method?.kind === 'cash' ? liveChangeSen(total, entry) : null
  const quick = method?.kind === 'cash' ? quickTenders(split ? parseRinggit(entry) ?? left : total) : []
  const key = 'flex h-14 items-center justify-center rounded-xl border border-border-mid bg-card text-xl font-semibold text-brown-dark disabled:opacity-40'
  return (
    <div className="flex min-h-0 flex-1 bg-cream">
      <section aria-label="Bill" className="flex w-[40%] shrink-0 flex-col border-r border-border bg-card p-4 text-sm">
        <div className="text-lg font-semibold text-brown-dark">{title}</div>
        <div className="text-xs text-brown-muted">Bill {bill.bill_no} · {itemCount} item{itemCount === 1 ? '' : 's'}</div>
        <div className="mt-3 flex-1 space-y-1 overflow-y-auto">
          {items === null && <p className="text-brown-muted">Loading…</p>}
          {live.map((i) => (
            <div key={i.id} className="flex justify-between gap-2">
              <span>
                {i.qty} × {i.name_snapshot}
                {i.modifiers_snapshot.map((m, k) => <span key={k} className="block pl-4 text-xs text-brown-muted">+ {m.name}</span>)}
              </span>
              <span className="tabular-nums">{formatSen(i.unit_price_sen * i.qty)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-border pt-3"><CheckoutTotals totals={totals} /></div>
        {changeNote && <p role="status" className="mt-2 rounded bg-amber-50 p-2 text-amber-800">{changeNote}</p>}
        <button type="button" onClick={onClose} disabled={busy}
          className="mt-3 min-h-14 rounded-xl border border-border-mid font-medium text-brown-dark disabled:opacity-40">
          {lockNote ? 'Close' : 'Cancel payment'}
        </button>
      </section>

      <section aria-label="Payment" className="flex min-w-0 flex-1 flex-col p-4">
        <div className="flex justify-end">
          <button type="button" onClick={toggleSplit} disabled={locked} aria-pressed={split}
            className={`min-h-11 rounded-xl px-4 text-sm font-medium disabled:opacity-40 ${split ? 'bg-brown-dark text-cream' : 'border border-border-mid text-brown-dark'}`}>
            Split payment
          </button>
        </div>
        {lockNote && <p role="alert" className="mt-3 rounded bg-red-50 p-3 font-semibold text-red-700">{lockNote}</p>}
        <div className="mt-2 text-center">
          <div className="text-sm uppercase tracking-wide text-brown-muted">{split ? 'Left to pay' : 'Amount due'}</div>
          <div className="text-5xl font-semibold text-brown-dark tabular-nums">{totals ? formatSen(due) : '…'}</div>
          {!split && method?.kind === 'cash' && (
            <div className="mt-1 text-sm text-brown-muted">
              Received {entry ? `RM ${entry}` : 'exact'} · Change {change === null ? '—' : formatSen(change)}
            </div>
          )}
          {split && <div className="mt-1 text-sm text-brown-muted">This payment RM {entry || '0'}</div>}
        </div>
        {method?.needsReference && !locked && (
          <label className="mx-auto mt-3 block w-full max-w-sm text-sm">Reference
            <input className="mt-1 h-12 w-full rounded-xl border border-border-mid px-3 text-base" value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {shownTab?.methods.map((m) => (
            <button key={m.id} type="button" onClick={() => pick(m)} disabled={busy || locked} aria-pressed={method?.id === m.id}
              className={`min-h-14 rounded-xl border px-3 text-left font-medium disabled:opacity-40 ${method?.id === m.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid bg-card text-brown-dark'}`}>
              {m.name}
            </button>
          ))}
          {methods.length === 0 && (methodsError
            ? <p role="alert" className="col-span-3 rounded bg-red-50 p-2 text-sm text-red-700">{methodsError}</p>
            : <p className="col-span-3 text-sm text-brown-muted">No payment methods — add them in POS settings.</p>)}
        </div>
        {showPad && (
          <div className="mt-3 flex min-h-0 flex-1 gap-3">
            <div className="grid flex-1 grid-cols-3 content-start gap-2">
              {NUMPAD_KEYS.map((k) => (
                <button key={k} type="button" className={key} disabled={busy} onClick={() => setEntry((t) => numpadPress(t, k))}>{k}</button>
              ))}
            </div>
            <div className="flex w-40 flex-col gap-2">
              {method?.kind === 'cash' && !split && (
                <button type="button" className={key} disabled={busy} onClick={() => setEntry('')}>Exact</button>
              )}
              {quick.map((n) => (
                <button key={n} type="button" className={key} disabled={busy}
                  onClick={() => (split ? add(n) : setEntry((n / 100).toFixed(0)))}>RM {n / 100}</button>
              ))}
              <button type="button" className={key} disabled={busy} onClick={() => setEntry('')}>C</button>
              {split && (
                <button type="button" onClick={() => add()} disabled={busy}
                  className="min-h-14 rounded-xl bg-brown-dark font-semibold text-cream disabled:opacity-40">Add {method?.name}</button>
              )}
            </div>
          </div>
        )}
        {!showPad && <div className="flex-1" />}
        {split && lines.length > 0 && (
          <div className="mt-3 space-y-1 text-sm">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center justify-between rounded-lg bg-card p-2">
                <span>{l.method.name}{l.reference ? ` · ${l.reference}` : ''}{l.tenderedSen !== null ? ` · received ${formatSen(l.tenderedSen)}` : ''}</span>
                <span className="flex items-center gap-3 tabular-nums">{formatSen(l.amountSen)}
                  <button type="button" disabled={locked} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    className="min-h-11 px-2 text-xs text-red-700 underline disabled:opacity-40">Remove</button>
                </span>
              </div>
            ))}
            <div className="flex justify-between px-2"><span>Change</span><b className="tabular-nums">{formatSen(changeSen(lines))}</b></div>
          </div>
        )}
        {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {lockNote ? (
          <button type="button" onClick={onClose} disabled={busy} className="mt-3 min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white">Close</button>
        ) : session.phase === 'unsure' || session.phase === 'checking' ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={pay} className="min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white disabled:opacity-40">Try again</button>
            <button type="button" disabled={busy} onClick={() => void checkBill()} className="min-h-16 rounded-xl border border-border-mid text-lg disabled:opacity-40">
              {session.phase === 'checking' ? 'Checking…' : 'Check bill'}
            </button>
          </div>
        ) : (
          <button type="button" onClick={pay} disabled={busy || !totals || (split ? left !== 0 : !method && total !== 0)}
            className="mt-3 min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {busy ? 'Paying…' : `Pay ${formatSen(total)}`}
          </button>
        )}
        {tabs.length > 0 && (
          <div role="tablist" aria-label="Payment type" className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map((t) => (
              <button key={t.tab} type="button" role="tab" aria-selected={shownTab?.tab === t.tab} disabled={busy || locked} onClick={() => chooseTab(t.tab)}
                className={`min-h-12 rounded-xl font-medium disabled:opacity-40 ${shownTab?.tab === t.tab ? 'bg-brown-dark text-cream' : 'bg-card text-brown-dark'}`}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 8: Run the checkout tests and typecheck**

Run: `npx vitest run src/features/pos/checkout/ && npx tsc -b`
Expected: all checkout tests PASS (4 new screen tests among them); tsc prints nothing.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/checkout/payTabs.ts src/features/pos/checkout/payTabs.test.ts \
  src/features/pos/checkout/PaymentScreen.tsx src/features/pos/checkout/PaymentScreen.test.tsx
git commit -m "feat(pos): full-screen Payment with method tabs, number pad and split payment" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Transaction page

**Files:**
- Create: `src/features/pos/checkout/transactions.ts`, Test: `src/features/pos/checkout/transactions.test.ts`
- Modify: `src/features/pos/checkout/checkoutApi.ts` (import `BillTotals`; add `fetchClosedBillDetail` and its row types above `// ── /pos/settings`)
- Create: `src/features/pos/checkout/TransactionScreen.tsx`

**Interfaces:**
- Consumes: `fetchClosedBillsSince`, `fetchRefundableMethods`, `refundBill`, `reprintReceipt`, `ClosedBillRow` (checkoutApi.ts); `mytDayStartIso`, `refundChoices`, `refundDoneNote`, `refundableSen`, `RefundChoice` (todayBills.ts); `ApprovalDialog`, `CheckoutTotals`, `fetchBillItems`, `parseRinggit`.
- Produces:
  - transactions.ts: `type TxFilter = 'all' | 'paid' | 'voided' | 'refunded' | 'merged'`, `TX_FILTERS`, `txWhere(b): string`, `txKind(b): Exclude<TxFilter, 'all'>`, `filterTransactions<T>(bills: T[], filter: TxFilter, search: string): T[]`, `txStatusLabel(b): string`, `mytDateLabel(nowMs: number): string`
  - checkoutApi: `interface PaymentRow`, `interface RefundRow`, `interface ClosedBillDetail { totals: BillTotals | null; mergedIntoBillNo: string | null; payments: PaymentRow[]; refunds: RefundRow[] }`, `fetchClosedBillDetail(billId: string): Promise<ClosedBillDetail>`
  - `default TransactionScreen(props: { branchId: string })`

- [ ] **Step 1: Write the failing helper tests**

Create `src/features/pos/checkout/transactions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { filterTransactions, mytDateLabel, txKind, txStatusLabel, txWhere } from './transactions'

const b = (bill_no: string, status: 'paid' | 'voided' | 'merged', refunded_sen = 0, label: string | null = 'T3') => ({
  bill_no, status, refunded_sen, order_type: label ? 'dine_in' as const : 'takeaway' as const,
  dining_tables: label ? { label } : null,
})
const bills = [b('261026-001', 'paid'), b('261026-002', 'paid', 500, null), b('261026-003', 'voided', 0, 'B4'), b('261026-004', 'merged')]

describe('transactions', () => {
  it('where a bill was', () => {
    expect(txWhere(bills[0])).toBe('Table T3')
    expect(txWhere(bills[1])).toBe('Takeaway')
    expect(txWhere({ order_type: 'dine_in', dining_tables: null })).toBe('—')
  })
  it('a refund moves a paid bill to Refunded', () => {
    expect(bills.map(txKind)).toEqual(['paid', 'refunded', 'voided', 'merged'])
    expect(bills.map(txStatusLabel)).toEqual(['Paid', 'Refunded RM 5.00', 'Voided', 'Merged'])
  })
  it('filters, then searches the bill number or the table', () => {
    expect(filterTransactions(bills, 'all', '').length).toBe(4)
    expect(filterTransactions(bills, 'paid', '').map((x) => x.bill_no)).toEqual(['261026-001'])
    expect(filterTransactions(bills, 'refunded', '').map((x) => x.bill_no)).toEqual(['261026-002'])
    expect(filterTransactions(bills, 'all', 'b4').map((x) => x.bill_no)).toEqual(['261026-003'])
    expect(filterTransactions(bills, 'all', ' -004').map((x) => x.bill_no)).toEqual(['261026-004'])
    expect(filterTransactions(bills, 'voided', 'takeaway')).toEqual([])
  })
  it('today\'s date in Malaysia', () => {
    expect(mytDateLabel(Date.parse('2026-10-26T15:59:00Z'))).toBe('26 Oct 2026')
    expect(mytDateLabel(Date.parse('2026-10-26T16:00:00Z'))).toBe('27 Oct 2026')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/pos/checkout/transactions.test.ts`
Expected: FAIL — `Failed to resolve import "./transactions"`.

- [ ] **Step 3: Implement the helpers**

Create `src/features/pos/checkout/transactions.ts`:

```ts
// src/features/pos/checkout/transactions.ts
/** The Transaction screen's list (spec §5): today's closed bills, filtered and searched. */
import { formatSen } from '../order/cart'
import type { ClosedBillRow } from './checkoutApi'

export type TxFilter = 'all' | 'paid' | 'voided' | 'refunded' | 'merged'
export const TX_FILTERS: { id: TxFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'paid', label: 'Paid' }, { id: 'voided', label: 'Voided' },
  { id: 'refunded', label: 'Refunded' }, { id: 'merged', label: 'Merged' },
]

type TxBill = Pick<ClosedBillRow, 'bill_no' | 'status' | 'refunded_sen' | 'order_type' | 'dining_tables'>

/** "Table T3", "Takeaway", or "—" for a dine-in bill whose table is gone. */
export function txWhere(b: Pick<ClosedBillRow, 'order_type' | 'dining_tables'>): string {
  return b.dining_tables ? `Table ${b.dining_tables.label}` : b.order_type === 'takeaway' ? 'Takeaway' : '—'
}

/** A paid bill with any refund counts as Refunded, not Paid. */
export function txKind(b: Pick<ClosedBillRow, 'status' | 'refunded_sen'>): Exclude<TxFilter, 'all'> {
  return b.status === 'paid' ? (b.refunded_sen > 0 ? 'refunded' : 'paid') : b.status
}

/** The filter, then the search on the bill number or the table / Takeaway (any case). */
export function filterTransactions<T extends TxBill>(bills: T[], filter: TxFilter, search: string): T[] {
  const q = search.trim().toLowerCase()
  return bills.filter((b) => (filter === 'all' || txKind(b) === filter)
    && (!q || b.bill_no.toLowerCase().includes(q) || txWhere(b).toLowerCase().includes(q)))
}

export function txStatusLabel(b: Pick<ClosedBillRow, 'status' | 'refunded_sen'>): string {
  const k = txKind(b)
  return k === 'refunded' ? `Refunded ${formatSen(b.refunded_sen)}` : k === 'paid' ? 'Paid' : k === 'voided' ? 'Voided' : 'Merged'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "26 Oct 2026": today in Malaysia (UTC+8), whatever the iPad's time zone. */
export function mytDateLabel(nowMs: number): string {
  const d = new Date(nowMs + 8 * 3600_000)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run src/features/pos/checkout/transactions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the closed-bill detail read**

In `src/features/pos/checkout/checkoutApi.ts` change the bill import to:

```ts
import type { BillOrderType, BillTotals, CashRounding, ServiceChargeRuleInput } from './bill'
```

and insert directly above the line `// ── /pos/settings ───…`:

```ts
/** One payment of a closed bill, as the receipt lists it. */
export interface PaymentRow {
  id: string
  method_name: string
  kind: PaymentKind
  amount_sen: number
  tendered_sen: number | null
  change_sen: number
  reference: string | null
  line_no: number
  taken_at: string
}
export interface RefundRow { id: string; method_name: string; amount_sen: number; reason: string | null; created_at: string }
/** What the Transaction screen shows of a closed bill besides its items: the totals stored at
 *  checkout (bills.totals, null on a voided or merged bill), the bill it was merged into, its
 *  payments and its refunds. */
export interface ClosedBillDetail { totals: BillTotals | null; mergedIntoBillNo: string | null; payments: PaymentRow[]; refunds: RefundRow[] }

export async function fetchClosedBillDetail(billId: string): Promise<ClosedBillDetail> {
  const [b, p, r] = await Promise.all([
    supabase.from('bills').select('totals, merged_into').eq('id', billId).maybeSingle(),
    supabase.from('payments').select('id, method_name, kind, amount_sen, tendered_sen, change_sen, reference, line_no, taken_at')
      .eq('bill_id', billId).order('taken_at').order('line_no'),
    supabase.from('refunds').select('id, method_name, amount_sen, reason, created_at').eq('bill_id', billId).order('created_at'),
  ])
  if (b.error) fail(b.error)
  if (p.error) fail(p.error)
  if (r.error) fail(r.error)
  const row = b.data as { totals: BillTotals | null; merged_into: string | null } | null
  let mergedIntoBillNo: string | null = null
  if (row?.merged_into) {
    const m = await supabase.from('bills').select('bill_no').eq('id', row.merged_into).maybeSingle()
    if (m.error) fail(m.error)
    mergedIntoBillNo = (m.data as { bill_no: string } | null)?.bill_no ?? null
  }
  return { totals: row?.totals ?? null, mergedIntoBillNo, payments: (p.data ?? []) as PaymentRow[], refunds: (r.data ?? []) as RefundRow[] }
}
```

(`payments`, `refunds` and `bills` already have the `pos_read` select policy for staff.)

- [ ] **Step 6: Write the Transaction screen**

Create `src/features/pos/checkout/TransactionScreen.tsx` (the refund and reprint code is `TodayBillsDrawer`'s, unchanged):

```tsx
// src/features/pos/checkout/TransactionScreen.tsx
import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { formatSen } from '../order/cart'
import { fetchBillItems, type BillItemRow } from '../order/posApi'
import {
  fetchClosedBillDetail, fetchClosedBillsSince, fetchRefundableMethods, refundBill, reprintReceipt,
  type ClosedBillDetail, type ClosedBillRow,
} from './checkoutApi'
import ApprovalDialog from './ApprovalDialog'
import CheckoutTotals from './CheckoutTotals'
import { mytDayStartIso, refundChoices, refundDoneNote, refundableSen, type RefundChoice } from './todayBills'
import { filterTransactions, mytDateLabel, TX_FILTERS, txStatusLabel, txWhere, type TxFilter } from './transactions'
import { parseRinggit } from './tender'
import type { RefundResult } from './rpcResult'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur' })

/** Transaction (spec §5), replacing the Today's bills drawer with the same data and actions:
 *  today's closed bills (Malaysia day) on the left with search and a status filter; the chosen bill
 *  on the right with its items, totals, payments and refunds, Reprint receipt and Refund. The
 *  reprint guard and the refund flow (one refund id per dialog, amount and method fixed after the
 *  first Approve, refunds back the way the bill was paid) are the drawer's, unchanged. */
export default function TransactionScreen({ branchId }: { branchId: string }) {
  const [bills, setBills] = useState<ClosedBillRow[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [filter, setFilter] = useState<TxFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ items: BillItemRow[]; d: ClosedBillDetail } | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailKey, setDetailKey] = useState(0)
  const detailSeq = useRef(0)
  // ── the drawer's refund and reprint state, unchanged ──
  const [refunding, setRefunding] = useState<ClosedBillRow | null>(null)
  const [amountText, setAmountText] = useState('')
  const [methodId, setMethodId] = useState('')
  const [choices, setChoices] = useState<RefundChoice[] | null>(null)
  const [choicesError, setChoicesError] = useState<string | null>(null)
  const refundId = useRef<string>('')
  const [refundLocked, setRefundLocked] = useState(false)
  const refundResult = useRef<RefundResult | null>(null)
  const reprintingRef = useRef(new Set<string>())
  const [reprinting, setReprinting] = useState<ReadonlySet<string>>(new Set())

  const load = async () => {
    try { setBills(await fetchClosedBillsSince(branchId, mytDayStartIso(Date.now()))) } catch (e) { setNote(msg(e)) }
  }
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedId) return
    const id = ++detailSeq.current                  // a slow reply for a bill no longer chosen is dropped
    setDetail(null); setDetailError(null)
    Promise.all([fetchBillItems(selectedId), fetchClosedBillDetail(selectedId)]).then(
      ([items, d]) => { if (id === detailSeq.current) setDetail({ items, d }) },
      (e) => { if (id === detailSeq.current) setDetailError(msg(e)) },
    )
  }, [selectedId, detailKey])

  const reprint = async (b: ClosedBillRow) => {
    if (reprintingRef.current.has(b.id)) return
    reprintingRef.current.add(b.id); setReprinting(new Set(reprintingRef.current))
    try { await reprintReceipt(b.id); setNote(`Receipt ${b.bill_no} sent to the printer`) } catch (e) { setNote(msg(e)) }
    finally { reprintingRef.current.delete(b.id); setReprinting(new Set(reprintingRef.current)) }
  }

  const startRefund = (b: ClosedBillRow) => {
    const id = crypto.randomUUID()                  // one id per refund: a retry can never refund twice
    refundId.current = id
    setAmountText(''); setMethodId(''); setChoices(null); setChoicesError(null); setRefundLocked(false)
    refundResult.current = null
    setRefunding(b)
    fetchRefundableMethods(b.id).then((rows) => {
      if (refundId.current !== id) return
      const c = refundChoices(rows, refundableSen(b))
      setChoices(c)
      setMethodId(c[0]?.methodId ?? '')
      setAmountText(c[0] ? (c[0].maxSen / 100).toFixed(2) : '')
    }, (e) => { if (refundId.current === id) setChoicesError(msg(e)) })
  }
  const chooseMethod = (id: string) => {
    if (refundLocked) return
    setMethodId(id)
    const c = choices?.find((x) => x.methodId === id)
    if (c) setAmountText((c.maxSen / 100).toFixed(2))
  }
  const chosen = choices?.find((c) => c.methodId === methodId) ?? null
  const amountSen = parseRinggit(amountText)
  const refundProblem = !refunding ? null
    : choicesError ? `Could not load how this bill was paid: ${choicesError}`
    : choices === null ? 'Loading how this bill was paid…'
    : choices.length === 0 ? 'Nothing left to refund on this bill.'
    : !chosen ? 'Choose how the money goes back'
    : amountSen === null || amountSen <= 0 ? 'Enter the refund amount'
    : amountSen > chosen.maxSen ? `At most ${formatSen(chosen.maxSen)} can go back this way`
    : null

  const shown = bills ? filterTransactions(bills, filter, search) : []
  const selected = bills?.find((b) => b.id === selectedId) ?? null
  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label="Bills" className="flex w-[440px] shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border p-2">
          <label className="relative flex-1">
            <Search size={18} className="pointer-events-none absolute left-3 top-3 text-brown-muted" />
            <input className="h-11 w-full rounded-xl border border-border-mid pl-9 pr-3" placeholder="Bill no or table"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button type="button" onClick={() => void load()} aria-label="Refresh"
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid"><RefreshCw size={18} /></button>
        </div>
        <div className="flex items-center justify-between px-3 pt-2 text-sm">
          <span className="font-semibold text-brown-dark">Today · {mytDateLabel(Date.now())}</span>
        </div>
        <div className="flex gap-1 overflow-x-auto p-2">
          {TX_FILTERS.map((f) => (
            <button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}
              className={`min-h-11 whitespace-nowrap rounded-lg px-3 text-sm ${filter === f.id ? 'bg-brown-dark text-cream' : 'border border-border-mid text-brown-dark'}`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-2 text-sm">
          {bills === null && <p className="text-brown-muted">Loading…</p>}
          {bills !== null && shown.length === 0 && <p className="text-brown-muted">No bills.</p>}
          {shown.map((b) => (
            <button key={b.id} type="button" onClick={() => setSelectedId(b.id)}
              className={`mb-1 flex min-h-14 w-full items-center justify-between rounded-lg px-3 text-left ${selectedId === b.id ? 'bg-brown-btn text-white' : 'hover:bg-cream'}`}>
              <span>
                <span className="block font-medium">{b.bill_no} · {txWhere(b)}</span>
                <span className="block text-xs opacity-80">{time(b.closed_at)} · {txStatusLabel(b)}</span>
              </span>
              <span className="tabular-nums">{b.total_sen !== null ? formatSen(b.total_sen) : '—'}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Bill detail" className="flex min-w-0 flex-1 flex-col p-4 text-sm">
        {note && <p className="mb-3 rounded bg-amber-50 p-2 text-amber-800">{note}</p>}
        {!selected && <p className="text-brown-muted">Choose a bill on the left.</p>}
        {selected && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-brown-dark">{selected.bill_no} · {txWhere(selected)}</div>
                <div className="text-xs text-brown-muted">{time(selected.closed_at)} · {txStatusLabel(selected)}</div>
              </div>
              {selected.status === 'paid' && (
                <div className="flex gap-2">
                  <button type="button" onClick={() => void reprint(selected)} disabled={reprinting.has(selected.id)}
                    className="min-h-12 rounded-xl border border-border-mid px-4 disabled:opacity-40">{reprinting.has(selected.id) ? 'Printing…' : 'Reprint receipt'}</button>
                  <button type="button" onClick={() => startRefund(selected)} disabled={refundableSen(selected) === 0}
                    className="min-h-12 rounded-xl border border-red-300 px-4 text-red-700 disabled:opacity-40">Refund</button>
                </div>
              )}
            </div>
            <div className="mt-3 flex-1 overflow-y-auto rounded-xl bg-card p-3">
              {detailError && <p role="alert" className="rounded bg-red-50 p-2 text-red-700">{detailError} <button type="button" className="underline" onClick={() => setDetailKey((k) => k + 1)}>Try again</button></p>}
              {!detail && !detailError && <p className="text-brown-muted">Loading…</p>}
              {detail && (
                <div className="space-y-3">
                  {detail.d.mergedIntoBillNo && <p className="text-brown-muted">Merged into bill {detail.d.mergedIntoBillNo}.</p>}
                  <div className="space-y-1">
                    {detail.items.map((i) => (
                      <div key={i.id} className={`flex justify-between gap-2 ${i.voided_at ? 'line-through opacity-50' : ''}`}>
                        <span>
                          {i.qty} × {i.name_snapshot}
                          {i.modifiers_snapshot.map((m, k) => <span key={k} className="block pl-4 text-xs text-brown-muted">+ {m.name}</span>)}
                          {i.note && <span className="block pl-4 text-xs italic text-brown-muted">* {i.note}</span>}
                        </span>
                        <span className="tabular-nums">{formatSen(i.unit_price_sen * i.qty)}</span>
                      </div>
                    ))}
                    {detail.items.length === 0 && <p className="text-brown-muted">No items on this bill.</p>}
                  </div>
                  {detail.d.totals && <div className="border-t border-border pt-3"><CheckoutTotals totals={detail.d.totals} /></div>}
                  {detail.d.payments.length > 0 && (
                    <div className="border-t border-border pt-3">
                      <div className="mb-1 text-xs font-semibold uppercase text-brown-muted">Payments</div>
                      {detail.d.payments.map((p) => (
                        <div key={p.id} className="flex justify-between">
                          <span>{p.method_name}{p.reference ? ` · ${p.reference}` : ''}{p.tendered_sen !== null ? ` · received ${formatSen(p.tendered_sen)}, change ${formatSen(p.change_sen)}` : ''}</span>
                          <span className="tabular-nums">{formatSen(p.amount_sen)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {detail.d.refunds.length > 0 && (
                    <div className="border-t border-border pt-3">
                      <div className="mb-1 text-xs font-semibold uppercase text-brown-muted">Refunds</div>
                      {detail.d.refunds.map((r) => (
                        <div key={r.id} className="flex justify-between text-red-700">
                          <span>{time(r.created_at)} · {r.method_name}{r.reason ? ` · ${r.reason}` : ''}</span>
                          <span className="tabular-nums">−{formatSen(r.amount_sen)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {refunding && (
        <ApprovalDialog branchId={branchId} action="refund" title={`Refund bill ${refunding.bill_no}`}
          summary={`Paid ${formatSen(refunding.total_sen ?? 0)}${refunding.refunded_sen ? `, already refunded ${formatSen(refunding.refunded_sen)}` : ''}`}
          extra={
            <div className="space-y-2 text-sm">
              {choicesError && <p className="rounded bg-red-50 p-2 text-red-700">Could not load how this bill was paid: {choicesError}</p>}
              {!choicesError && choices === null && <p className="text-brown-muted">Loading how this bill was paid…</p>}
              {choices?.length === 0 && <p className="rounded bg-amber-50 p-2 text-amber-800">Nothing left to refund on this bill.</p>}
              {choices && choices.length > 0 && (
                <>
                  <label className="block">Paid back by
                    <select className="ml-2 rounded border border-border p-2 disabled:opacity-60" value={methodId}
                      disabled={refundLocked} onChange={(e) => chooseMethod(e.target.value)}>
                      {choices.map((c) => <option key={c.methodId} value={c.methodId}>{c.label}</option>)}
                    </select>
                  </label>
                  <label className="block">Amount (RM)
                    <input inputMode="decimal" className="ml-2 w-32 rounded border border-border p-2 disabled:opacity-60" value={amountText}
                      disabled={refundLocked} onChange={(e) => setAmountText(e.target.value)} />
                  </label>
                  <p className="text-xs text-brown-muted">Refunds go back the way the bill was paid.</p>
                </>
              )}
              {refundLocked && <p className="text-xs text-brown-muted">Amount and method are fixed for this refund. To refund a different amount, close and reopen.</p>}
            </div>
          }
          extraProblem={refundProblem}
          approveDisabled={!refundLocked && (choices === null || choices.length === 0)}
          onApprove={async (a) => {
            setRefundLocked(true)
            refundResult.current = await refundBill(refundId.current, refunding.id, amountSen ?? 0, methodId, a)
          }}
          onClose={() => { refundId.current = ''; setRefunding(null) }}
          onDone={() => {
            const r = refundResult.current
            setNote(r ? refundDoneNote(r, refunding.bill_no) : `Refund on ${refunding.bill_no} done`)
            setRefunding(null); setDetailKey((k) => k + 1); void load()
          }} />
      )}
    </div>
  )
}
```

- [ ] **Step 7: Typecheck and run the checkout tests**

Run: `npx tsc -b && npx vitest run src/features/pos/checkout/`
Expected: tsc prints nothing; all checkout tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/checkout/transactions.ts src/features/pos/checkout/transactions.test.ts \
  src/features/pos/checkout/checkoutApi.ts src/features/pos/checkout/TransactionScreen.tsx
git commit -m "feat(pos): Transaction page with filters, bill detail, reprint and refund" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Home screen and queue strip

**Files:**
- Create: `src/features/pos/order/QueueStrip.tsx`
- Create: `src/features/pos/order/HomeScreen.tsx`

**Interfaces:**
- Consumes: `areaTabs`, `currentArea`, `visibleTables`, `elapsedLabel` (Task 2); `tableCards`, `takeawayBills`, `TableCard` (tableStatus.ts, unchanged); `BillSummary` (Task 1); `useMinuteClock`; `FlushReport`, `QueuedOrder`; `BranchCatalogs`.
- Produces:
  - `default QueueStrip(props: { report: FlushReport | null; stuck: QueuedOrder[]; discardError: string | null; tables: TableRow[]; catalogs: BranchCatalogs | null; productNames: Map<string, string> | null; onRetry: () => void; onEdit: (o: QueuedOrder) => void; onDiscard: (clientOrderId: string) => void })`
  - `default HomeScreen(props: { tables: TableRow[]; bills: OpenBillRow[]; summaries: ReadonlyMap<string, BillSummary>; newBillIds: ReadonlySet<string>; banners: ReactNode; onRefresh: () => void; onPickTable: (tableId: string) => void; onPickBill: (billId: string) => void; onNewTakeaway: () => void })`

- [ ] **Step 1: Write the queue strip** (the old `PosPage` strip, moved; the words are unchanged)

Create `src/features/pos/order/QueueStrip.tsx`:

```tsx
// src/features/pos/order/QueueStrip.tsx
import type { FlushReport, QueuedOrder } from '../offline/orderQueue'
import type { BranchCatalogs } from './catalogs'
import type { TableRow } from './posApi'

/** The offline queue strip, moved from the old PosPage header unchanged (spec §1 banners): orders
 *  waiting to send with Retry now, and every rejected order with Edit (back to the order screen,
 *  cart intact) and Discard. Renders nothing when the queue is clear. */
export default function QueueStrip({ report, stuck, discardError, tables, catalogs, productNames, onRetry, onEdit, onDiscard }: {
  report: FlushReport | null
  stuck: QueuedOrder[]
  discardError: string | null
  tables: TableRow[]
  catalogs: BranchCatalogs | null
  productNames: Map<string, string> | null
  onRetry: () => void
  onEdit: (o: QueuedOrder) => void
  onDiscard: (clientOrderId: string) => void
}) {
  const waiting = report && (report.pending > 0 || report.lastError)
  if (!waiting && stuck.length === 0 && !discardError) return null
  return (
    <div className="space-y-1 border-b border-border bg-amber-50 px-4 py-2 text-sm">
      {waiting && (
        <p className="text-amber-800">
          {report.pending} order{report.pending === 1 ? '' : 's'} waiting to send{report.lastError ? ` — ${report.lastError}` : ''}{' '}
          <button type="button" className="min-h-11 px-2 underline" onClick={onRetry}>Retry now</button>
        </p>
      )}
      {stuck.map((o) => {
        const n = o.items.reduce((sum, l) => sum + l.qty, 0)
        const where = o.tableId ? `Table ${tables.find((t) => t.id === o.tableId)?.label ?? '?'}` : 'Takeaway'
        const catalog = o.catalogId ? catalogs?.catalogs.find((c) => c.id === o.catalogId)?.name : null
        const names = o.items.map((l) => `${l.qty} × ${productNames?.get(l.productId) || 'Unknown item'}`).join(', ')
        return (
          <p key={o.clientOrderId} className="text-red-700">
            Rejected: {o.failedReason} · {where}{catalog ? ` · ${catalog}` : ''} · {n} item{n === 1 ? '' : 's'} ({names}){' '}
            <button type="button" className="mr-2 min-h-11 px-2 underline" onClick={() => onEdit(o)}>Edit</button>
            <button type="button" className="min-h-11 px-2 underline" onClick={() => onDiscard(o.clientOrderId)}>Discard</button>
          </p>
        )
      })}
      {discardError && <p className="text-red-700">Could not discard: {discardError}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Write the home screen**

Create `src/features/pos/order/HomeScreen.tsx`:

```tsx
// src/features/pos/order/HomeScreen.tsx
import { useState, type ReactNode } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { formatSen } from './cart'
import type { BillSummary } from './billSummaries'
import { areaTabs, currentArea, elapsedLabel, visibleTables } from './home'
import type { OpenBillRow, TableRow } from './posApi'
import { tableCards, takeawayBills, type TableCard } from './tableStatus'
import { useMinuteClock } from './useMinuteClock'

/** Home (spec §1): search, refresh and the area tabs on top; the table tiles (5 a row) with each
 *  open bill's total and minutes; the Other bills column with + Takeaway and every open takeaway
 *  bill. `banners` (no shift, the offline queue, a load error) sit above the tiles. */
export default function HomeScreen({ tables, bills, summaries, newBillIds, banners, onRefresh, onPickTable, onPickBill, onNewTakeaway }: {
  tables: TableRow[]
  bills: OpenBillRow[]
  summaries: ReadonlyMap<string, BillSummary>
  newBillIds: ReadonlySet<string>      // QR orders not opened yet: the green ring
  banners: ReactNode
  onRefresh: () => void
  onPickTable: (tableId: string) => void
  onPickBill: (billId: string) => void
  onNewTakeaway: () => void
}) {
  const [area, setArea] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const now = useMinuteClock()
  const tabs = areaTabs(tables, bills)
  const shownArea = currentArea(tabs, area)
  const cards = tableCards(visibleTables(tables, shownArea, search), bills, newBillIds)
  const takeaways = takeawayBills(bills)
  return (
    <div className="flex min-h-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-card p-2">
          <label className="relative w-48 shrink-0">
            <Search size={18} className="pointer-events-none absolute left-3 top-3 text-brown-muted" />
            <input className="h-11 w-full rounded-xl border border-border-mid pl-9 pr-3" placeholder="Search table"
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button type="button" onClick={onRefresh} aria-label="Refresh"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border-mid"><RefreshCw size={18} /></button>
          <div role="tablist" aria-label="Areas" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <button key={t.area ?? '*'} type="button" role="tab" aria-selected={!search && shownArea === t.area}
                onClick={() => { setArea(t.area); setSearch('') }}
                className={`h-11 whitespace-nowrap rounded-lg px-4 text-sm font-medium ${!search && shownArea === t.area ? 'bg-brown-dark text-cream' : 'text-brown-dark hover:bg-cream'}`}>
                {t.label} ({t.openCount})
              </button>
            ))}
          </div>
        </div>
        {banners}
        <div className="grid flex-1 grid-cols-5 content-start gap-3 overflow-y-auto p-3">
          {cards.map((c) => (
            <TableTile key={c.id} card={c} summary={c.bill ? summaries.get(c.bill.id) ?? null : null} nowMs={now} onPick={onPickTable} />
          ))}
          {cards.length === 0 && (
            <p className="col-span-5 text-brown-muted">{search ? 'No table matches.' : 'No tables — add them in POS settings.'}</p>
          )}
        </div>
      </main>
      <aside aria-label="Other bills" className="flex w-[260px] shrink-0 flex-col border-l border-border bg-card">
        <div className="p-2">
          <button type="button" onClick={onNewTakeaway}
            className="min-h-14 w-full rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover">+ Takeaway</button>
        </div>
        <h3 className="px-3 text-xs font-semibold uppercase tracking-wide text-brown-muted">Other bills</h3>
        <div className="flex-1 space-y-2 overflow-y-auto p-2">
          {takeaways.map((b) => {
            const s = summaries.get(b.id)
            return (
              <button key={b.id} type="button" onClick={() => onPickBill(b.id)}
                className="flex min-h-14 w-full items-center justify-between rounded-xl border-2 border-brown-btn bg-canvas px-3 text-left">
                <span>
                  <span className="block font-semibold text-brown-dark">{b.bill_no}</span>
                  <span className="block text-xs text-brown-muted">Takeaway · {elapsedLabel(b.opened_at, now)}</span>
                </span>
                <span className="font-semibold tabular-nums text-brown-dark">{s ? formatSen(s.totalSen) : ''}</span>
              </button>
            )
          })}
          {takeaways.length === 0 && <p className="px-1 text-sm text-brown-muted">No open takeaway bills.</p>}
        </div>
      </aside>
    </div>
  )
}

function TableTile({ card, summary, nowMs, onPick }: { card: TableCard; summary: BillSummary | null; nowMs: number; onPick: (tableId: string) => void }) {
  const open = card.state !== 'empty'
  return (
    <button type="button" onClick={() => onPick(card.id)}
      className={`flex h-28 flex-col justify-between rounded-xl border-2 p-3 text-left ${open ? 'border-brown-btn bg-brown-btn text-white' : 'border-border bg-card text-brown-dark'} ${card.state === 'new' ? 'ring-4 ring-green-400' : ''}`}>
      <span className="text-2xl font-semibold">{card.label}</span>
      <span className="text-sm">
        {card.bill
          ? <span className="tabular-nums">{summary ? `${formatSen(summary.totalSen)} · ` : ''}{elapsedLabel(card.bill.opened_at, nowMs)}</span>
          : <span className="text-brown-muted">{card.paused ? 'QR paused' : ''}</span>}
        {card.state === 'new' && <span className="block text-xs font-semibold text-green-200">New QR order</span>}
        {open && card.paused && <span className="block text-xs opacity-80">QR paused</span>}
      </span>
    </button>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/features/pos/order/QueueStrip.tsx src/features/pos/order/HomeScreen.tsx
git commit -m "feat(pos): Feedme home with area tabs, table totals and Other bills" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Wire PosPage, reopen rejected orders on the order screen, remove the old screens

**Files:**
- Modify: `src/features/pos/order/rejectedOrder.ts`, Test: `src/features/pos/order/rejectedOrder.test.ts`
- Modify: `src/features/pos/order/PosPage.tsx` (whole file below)
- Delete: `src/features/pos/order/TablesGrid.tsx`, `src/features/pos/order/BillPanel.tsx`, `src/features/pos/order/OrderPad.tsx`, `src/features/pos/checkout/CheckoutSheet.tsx`, `src/features/pos/checkout/TodayBillsDrawer.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–11; `useOrderQueue`, `usePosRealtime`, `fetchBillingConfig`, `fetchProductNames`, `MyPinDialog`, `ShiftsDrawer`, `useCan` (`manage_menu`, `pos_supervise`, `access_settings`).
- Produces: `padFromRejected(o: QueuedOrder): { target: OrderTarget; lines: OrderLine[]; catalogId: string | null }` (replaces the `mode: PadMode` field); `/pos` renders the new screens.

- [ ] **Step 1: Update the rejected-order test**

Replace `src/features/pos/order/rejectedOrder.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { newQueuedOrder } from '../offline/orderQueue'
import { padFromRejected } from './rejectedOrder'

const line = { productId: 'p1', variantId: 'v1', qty: 2, note: null, optionIds: [] }

describe('padFromRejected', () => {
  it('reopens a table order with its lines, guests and catalog', () => {
    expect(padFromRejected(newQueuedOrder('dine_in', 't-5', 3, [line], 1, 'a', 'c-staff'))).toEqual({
      target: { kind: 'table', tableId: 't-5', pax: 3 }, lines: [line], catalogId: 'c-staff',
    })
  })

  it('a table order sent without guests reopens with none', () => {
    expect(padFromRejected(newQueuedOrder('dine_in', 't-5', null, [line], 1, 'a', 'c-staff')).target)
      .toEqual({ kind: 'table', tableId: 't-5', pax: null })
  })

  it('reopens a takeaway as a new takeaway; an order queued before catalogs has none', () => {
    const { catalogId: _drop, ...legacy } = newQueuedOrder('takeaway', null, null, [line], 1, 'b')
    void _drop
    expect(padFromRejected(legacy)).toEqual({ target: { kind: 'takeaway', billId: null }, lines: [line], catalogId: null })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/pos/order/rejectedOrder.test.ts`
Expected: FAIL — the result has `mode` instead of `target` (e.g. `expected { mode: …, lines: …, catalogId: … } to deeply equal { target: …, … }`).

- [ ] **Step 3: Return an order target**

Replace `src/features/pos/order/rejectedOrder.ts` with:

```ts
// src/features/pos/order/rejectedOrder.ts
import type { QueuedOrder } from '../offline/orderQueue'
import type { OrderLine } from './cart'
import type { OrderTarget } from './orderTarget'

/** How the order screen reopens a rejected queued order: same table (with the pax it was sent
 *  with) or a new takeaway, same lines, and the same catalog (null for an order queued before
 *  catalogs existed, which the screen then prices from the branch default). */
export function padFromRejected(o: QueuedOrder): { target: OrderTarget; lines: OrderLine[]; catalogId: string | null } {
  return {
    target: o.tableId ? { kind: 'table', tableId: o.tableId, pax: o.pax } : { kind: 'takeaway', billId: null },
    lines: o.items,
    catalogId: o.catalogId ?? null,
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/pos/order/rejectedOrder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Rewrite PosPage as the screen router**

Replace `src/features/pos/order/PosPage.tsx` with:

```tsx
// src/features/pos/order/PosPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { useCan } from '../../../shared/lib/permissions'
import {
  fetchBranchCatalogs, fetchBranchName, fetchOpenBillSummaries, fetchOpenBills, fetchOrderBillId, fetchTables,
  type OpenBillRow, type TableRow,
} from './posApi'
import type { BillSummary } from './billSummaries'
import { usePosRealtime, type OrderInsert } from './usePosRealtime'
import type { OrderLine } from './cart'
import type { BranchCatalogs } from './catalogs'
import { padFromRejected } from './rejectedOrder'
import type { QueuedOrder } from '../offline/orderQueue'
import { useOrderQueue } from './useOrderQueue'
import { discardQuestion, QUEUED_NOT_SENT } from './billView'
import { billTitle, targetBill, targetTitle, type OrderTarget } from './orderTarget'
import HomeScreen from './HomeScreen'
import QueueStrip from './QueueStrip'
import OrderScreen from './OrderScreen'
import { fetchBillingConfig, fetchProductNames, type BillingConfig } from '../checkout/checkoutApi'
import MyPinDialog from '../checkout/MyPinDialog'
import PaymentScreen from '../checkout/PaymentScreen'
import TransactionScreen from '../checkout/TransactionScreen'
import ShiftsDrawer from '../shift/ShiftsDrawer'
import { useShiftOpen } from '../shift/useShiftOpen'
import BottomBar from '../shell/BottomBar'
import GridMenu from '../shell/GridMenu'
import StaffPanel from '../shell/StaffPanel'
import ConfirmDialog, { type ConfirmRequest } from '../shell/ConfirmDialog'
import PaxDialog from '../shell/PaxDialog'
import { menuItems, type MenuItem } from '../shell/shellMenu'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Which POS screen is up. An order screen keeps its `session` while a move or merge changes its
 *  target, so the cart survives; a new session (opened from home, Payment's Cancel) starts clean. */
type Screen =
  | { kind: 'home' }
  | { kind: 'order'; session: number; target: OrderTarget; lines?: OrderLine[]; catalogId?: string | null }
  | { kind: 'payment'; bill: OpenBillRow; back: OrderTarget }
  | { kind: 'transaction' }

/** /pos — the Feedme-layout POS (docs/superpowers/specs/2026-10-26-pos-feedme-frontend-design.md).
 *  Owns the data every screen shares (tables, open bills and their summaries, billing config,
 *  catalogs, the offline queue, realtime, the shift) and which screen is up. */
export default function PosPage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const navigate = useNavigate()
  const branchId = staff?.branch_id ?? null
  const [tables, setTables] = useState<TableRow[]>([])
  const [bills, setBills] = useState<OpenBillRow[]>([])
  const [summaries, setSummaries] = useState<Map<string, BillSummary>>(new Map())
  const [newBillIds, setNewBillIds] = useState<Set<string>>(new Set())
  const [refreshKey, setRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [screen, setScreen] = useState<Screen>({ kind: 'home' })
  const [menuOpen, setMenuOpen] = useState(false)
  const [staffOpen, setStaffOpen] = useState(false)
  const [pinOpen, setPinOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [paxFor, setPaxFor] = useState<TableRow | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [branchName, setBranchName] = useState<string | null>(null)
  const [stuckNames, setStuckNames] = useState<Map<string, string> | null>(null)
  const [branchCatalogs, setBranchCatalogs] = useState<BranchCatalogs | null>(null)
  const [billing, setBilling] = useState<BillingConfig | null>(null)
  const queue = useOrderQueue()
  const shift = useShiftOpen(refreshKey)
  const reqId = useRef(0)
  const session = useRef(0)
  const draftCount = useRef(0)                      // the order screen's unsent items, for the menu's guard
  const openBillIdRef = useRef<string | null>(null)
  // checkout ids this iPad sent per bill: a reopened Payment re-reads with them, so an unsure payment
  // that lands late shows as paid here. Dropped once the bill is paid or no longer open.
  const checkoutIdsByBill = useRef(new Map<string, string[]>())
  // The rejected original stays in the strip until its edited copy is saved; leaving the order
  // screen without sending keeps it, so nothing the cashier confirmed is ever silently dropped.
  const editingFrom = useRef<string | null>(null)

  /** Tables, open bills and their summaries together; resolves with the bills it read (null on failure). */
  const reload = useCallback(async (): Promise<OpenBillRow[] | null> => {
    if (!branchId) return null
    const id = ++reqId.current
    try {
      const [t, b, s] = await Promise.all([fetchTables(branchId), fetchOpenBills(branchId), fetchOpenBillSummaries(branchId)])
      if (id === reqId.current) { setTables(t); setBills(b); setSummaries(s); setError(null) }
      return b
    } catch (e) {
      if (id === reqId.current) setError(msg(e))
      return null
    }
  }, [branchId])
  useEffect(() => { void reload() }, [reload])
  const bump = useCallback(() => { setRefreshKey((k) => k + 1); void reload() }, [reload])
  useEffect(() => {
    const open = new Set(bills.map((b) => b.id))
    for (const id of checkoutIdsByBill.current.keys()) if (!open.has(id)) checkoutIdsByBill.current.delete(id)
  }, [bills])
  useEffect(() => {
    if (branchId) fetchBranchName(branchId).then(setBranchName, () => setBranchName(null))
  }, [branchId])
  const loadBilling = useCallback(() => {
    if (branchId) fetchBillingConfig(branchId).then(setBilling, (e) => setError(msg(e)))
  }, [branchId])
  useEffect(() => { loadBilling() }, [loadBilling])
  const hasStuck = queue.stuck.length > 0
  useEffect(() => {
    if (hasStuck && !stuckNames) fetchProductNames().then((rows) => setStuckNames(new Map(rows.map((r) => [r.id, r.name]))), () => undefined)
  }, [hasStuck, stuckNames])
  useEffect(() => {
    if (branchId) fetchBranchCatalogs(branchId).then(setBranchCatalogs, (e) => setError(msg(e)))
  }, [branchId])

  const onOrder = useCallback((row: OrderInsert) => {
    if (row.source === 'qr' && row.bill_id !== openBillIdRef.current) setNewBillIds((s) => new Set(s).add(row.bill_id))
    bump()
  }, [bump])
  // another iPad paid, voided, moved or merged a bill: refresh everything on screen
  const rtStatus = usePosRealtime(branchId, { onOrder, onBill: bump, onSweep: bump })

  const orderBill = screen.kind === 'order' ? targetBill(screen.target, bills) : null
  openBillIdRef.current = orderBill?.id ?? null

  // ── navigation ──
  const goHome = () => { editingFrom.current = null; draftCount.current = 0; setScreen({ kind: 'home' }) }
  const openOrder = (target: OrderTarget, lines?: OrderLine[], catalogId?: string | null) => {
    draftCount.current = lines?.reduce((n, l) => n + l.qty, 0) ?? 0
    setScreen({ kind: 'order', session: ++session.current, target, lines, catalogId })
  }
  /** Leave the order screen through the menu: unsent items are asked about first (spec §2). */
  const leave = (go: () => void) => {
    if (screen.kind === 'order' && draftCount.current > 0) {
      setConfirm({ title: discardQuestion(draftCount.current), confirmLabel: 'Discard', danger: true,
        onConfirm: () => { editingFrom.current = null; draftCount.current = 0; go() } })
      return
    }
    go()
  }
  const pickTable = (tableId: string) => {
    const bill = bills.find((b) => b.table_id === tableId)
    if (bill) {
      setNewBillIds((s) => { const n = new Set(s); n.delete(bill.id); return n })
      openOrder({ kind: 'table', tableId, pax: null })
      return
    }
    setPaxFor(tables.find((t) => t.id === tableId) ?? null)     // an empty table: Select pax first
  }
  const pickMenu = (item: MenuItem) => {
    setMenuOpen(false)
    if (item === 'report') { setReportOpen(true); return }
    leave(() => {
      if (item === 'order') goHome()
      else if (item === 'transaction') { editingFrom.current = null; setScreen({ kind: 'transaction' }) }
      else navigate(item === 'menu' ? '/menu' : '/pos/settings')
    })
  }

  // ── the queue ──
  // A rejected order is handed straight back to the order screen (cart intact), so drop the queued
  // copy instead of leaving a duplicate in the strip once the cashier fixes and resends.
  const submit = async (o: QueuedOrder) => {
    const res = await queue.submit(o)
    if (res.rejectedReason) await queue.discard(res.clientOrderId)
    else if (editingFrom.current) {
      // the edited copy is now saved on this iPad, so the rejected original can go
      await queue.discard(editingFrom.current)
      editingFrom.current = null
    }
    return res
  }
  const editRejected = (o: QueuedOrder) => {
    const p = padFromRejected(o)
    openOrder(p.target, p.lines, p.catalogId)
    editingFrom.current = o.clientOrderId
  }

  /** Send & pay: the order reached the server (else QUEUED_NOT_SENT) → Payment on the bill it landed on. */
  const sendAndPay = async (clientOrderId: string, target: OrderTarget) => {
    const billId = await fetchOrderBillId(clientOrderId)
    if (!billId) throw new Error(QUEUED_NOT_SENT)
    setRefreshKey((k) => k + 1)
    const fresh = await reload()
    if (!fresh) throw new Error('Could not load the bill — press Payment again.')
    const bill = fresh.find((b) => b.id === billId)
    if (!bill) throw new Error('This bill is no longer open — check it on the home screen.')
    loadBilling()
    draftCount.current = 0
    setScreen({ kind: 'payment', bill, back: target.kind === 'takeaway' ? { kind: 'takeaway', billId } : target })
  }

  if (!staff) return null
  if (!branchId) {
    return <div className="p-8 text-center">Your account has no branch — ask a manager to set it in Team.</div>
  }
  const items = menuItems({ manageMenu: can('manage_menu'), supervise: can('pos_supervise'), settings: can('access_settings') })
  const title = screen.kind === 'home' ? 'Tables'
    : screen.kind === 'order' ? targetTitle(screen.target, orderBill, tables)
    : screen.kind === 'transaction' ? 'Transaction' : 'Payment'
  const current: MenuItem | null = screen.kind === 'transaction' ? 'transaction' : screen.kind === 'payment' ? null : 'order'
  const banners = (
    <>
      {shift.open === false && (
        <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <span>No shift open — orders still go to the kitchen, but payment waits for a shift.</span>
          <button type="button" onClick={() => setStaffOpen(true)} className="min-h-11 rounded-lg bg-brown-btn px-4 font-medium text-white">Open shift</button>
        </div>
      )}
      <QueueStrip report={queue.report} stuck={queue.stuck} discardError={queue.discardError} tables={tables}
        catalogs={branchCatalogs} productNames={stuckNames} onRetry={() => void queue.flush()} onEdit={editRejected}
        onDiscard={(id) => void queue.discard(id)} />
      {error && (
        <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">
          {error} <button type="button" className="min-h-11 px-2 underline" onClick={() => void reload()}>Retry</button>
        </p>
      )}
    </>
  )
  return (
    <div className="flex h-dvh flex-col bg-cream text-brown-dark">
      {screen.kind === 'home' && (
        <HomeScreen tables={tables} bills={bills} summaries={summaries} newBillIds={newBillIds} banners={banners}
          onRefresh={bump} onPickTable={pickTable} onPickBill={(billId) => openOrder({ kind: 'takeaway', billId })}
          onNewTakeaway={() => openOrder({ kind: 'takeaway', billId: null })} />
      )}
      {screen.kind === 'order' && (
        <OrderScreen key={`${screen.session}:${screen.target.kind}`} branchId={branchId} target={screen.target}
          tables={tables} bills={bills} summaries={summaries} refreshKey={refreshKey} billing={billing} shiftOpen={shift.open}
          lastCatalogs={branchCatalogs} initialLines={screen.lines} initialCatalogId={screen.catalogId}
          submit={submit}
          onCatalogs={setBranchCatalogs}
          onTarget={(t) => setScreen((s) => (s.kind === 'order' ? { ...s, target: t } : s))}
          onBack={goHome}
          onSent={() => { goHome(); bump() }}
          onPay={(bill) => { loadBilling(); setScreen({ kind: 'payment', bill, back: screen.target }) }}
          onSendAndPay={(id) => sendAndPay(id, screen.target)}
          onChanged={async () => { setRefreshKey((k) => k + 1); await reload() }}
          onDraftCount={(n) => { draftCount.current = n }} />
      )}
      {screen.kind === 'transaction' && <TransactionScreen branchId={branchId} />}
      {screen.kind === 'payment' && (
        <PaymentScreen key={screen.bill.id} branchId={branchId} bill={screen.bill} refreshKey={refreshKey}
          title={billTitle(screen.bill.table_id, screen.bill.bill_no, tables)}
          earlierIds={checkoutIdsByBill.current.get(screen.bill.id) ?? []}
          onSendIds={(ids) => checkoutIdsByBill.current.set(screen.bill.id, ids)}
          onClose={() => openOrder(screen.back)}
          onPaid={() => { checkoutIdsByBill.current.delete(screen.bill.id); goHome(); bump() }} />
      )}
      {screen.kind !== 'payment' && (
        <BottomBar title={title} staffName={staff.name} onMenu={() => setMenuOpen(true)} onStaff={() => setStaffOpen(true)} />
      )}
      {menuOpen && <GridMenu items={items} current={current} onPick={pickMenu} onClose={() => setMenuOpen(false)} />}
      <StaffPanel open={staffOpen} branchId={branchId} branchName={branchName ?? staff.branch ?? 'Branch'} staffName={staff.name}
        refreshKey={refreshKey} liveStatus={rtStatus} onShiftChanged={shift.reload}
        onMyPin={() => setPinOpen(true)} onClose={() => setStaffOpen(false)} />
      {pinOpen && <MyPinDialog onClose={() => setPinOpen(false)} />}
      {reportOpen && <ShiftsDrawer onClose={() => setReportOpen(false)} />}
      {paxFor && (
        <PaxDialog title={`Table ${paxFor.label}`} current={null} onClose={() => setPaxFor(null)}
          onPick={(n) => { const t = paxFor; setPaxFor(null); openOrder({ kind: 'table', tableId: t.id, pax: n }) }} />
      )}
      {confirm && (
        <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
      )}
    </div>
  )
}
```

- [ ] **Step 6: Remove the replaced screens**

```bash
git rm src/features/pos/order/TablesGrid.tsx src/features/pos/order/BillPanel.tsx src/features/pos/order/OrderPad.tsx \
  src/features/pos/checkout/CheckoutSheet.tsx src/features/pos/checkout/TodayBillsDrawer.tsx
```

- [ ] **Step 7: Typecheck, check nothing still imports them, run everything**

Run: `npx tsc -b && grep -rnE "TablesGrid|BillPanel|OrderPad|CheckoutSheet|TodayBillsDrawer" src ; npx vitest run`
Expected: tsc prints nothing; grep prints only comments (in `OrderScreen.tsx`, `billActions.ts` and `PaymentScreen.tsx`, naming what they replace), no `import`; the full suite PASSES (1006 tests: 934 before + 72 new).

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/order/rejectedOrder.ts src/features/pos/order/rejectedOrder.test.ts src/features/pos/order/PosPage.tsx
git commit -m "feat(pos): Feedme-layout POS screens wired in PosPage; old pad, panel, sheet and drawer removed" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Table area in POS settings

**Files:**
- Modify: `src/features/pos/order/tableAdmin.ts`, Test: `src/features/pos/order/tableAdmin.test.ts`
- Modify: `src/features/pos/order/PosSettingsPage.tsx`

**Interfaces:**
- Consumes: `TableRow.area` (Task 1); the page's existing `run`, `check`, `setError`, `supabase`.
- Produces: `AREA_MAX = 40`, `normalizeArea(text: string): { area: string | null } | { problem: string }`; an Area column on `/pos/settings` → Tables.

- [ ] **Step 1: Write the failing test**

In `src/features/pos/order/tableAdmin.test.ts` change the import to:

```ts
import { addTableAction, friendlyDbMessage, normalizeArea, openBillMessage, renameConflict } from './tableAdmin'
```

and add inside `describe('tableAdmin', …)`, after `it('messages', …)`:

```ts
  it('normalizeArea', () => {
    expect(normalizeArea('  Patio  ')).toEqual({ area: 'Patio' })
    expect(normalizeArea('Main   hall')).toEqual({ area: 'Main hall' })
    expect(normalizeArea('   ')).toEqual({ area: null })
    expect(normalizeArea('x'.repeat(40))).toEqual({ area: 'x'.repeat(40) })
    expect(normalizeArea('x'.repeat(41))).toEqual({ problem: 'An area name is at most 40 characters' })
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/pos/order/tableAdmin.test.ts`
Expected: FAIL — `normalizeArea is not a function` (or a TypeScript import error).

- [ ] **Step 3: Implement `normalizeArea`**

Append to `src/features/pos/order/tableAdmin.ts`:

```ts

export const AREA_MAX = 40

/** A table's area as typed in POS settings: trimmed with inner spaces collapsed; empty = no area
 *  (null). At most 40 characters, the dining_tables_area_check limit (counted as Postgres does). */
export function normalizeArea(text: string): { area: string | null } | { problem: string } {
  const area = text.trim().replace(/\s+/g, ' ')
  if (!area) return { area: null }
  if ([...area].length > AREA_MAX) return { problem: `An area name is at most ${AREA_MAX} characters` }
  return { area }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/pos/order/tableAdmin.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the Area column to the settings page**

In `src/features/pos/order/PosSettingsPage.tsx`:

Change the tableAdmin import to:

```tsx
import { addTableAction, friendlyDbMessage, normalizeArea, openBillMessage, renameConflict } from './tableAdmin'
```

Insert directly above `const showCard = async (t: TableRow) => {`:

```tsx
  // the home screen's area tabs: empty = no area (the table is only under All)
  const saveArea = (t: TableRow, text: string) => {
    const r = normalizeArea(text)
    if ('problem' in r) { setError(r.problem); return }
    if (r.area === t.area) return
    void run(async () => { check(await supabase.from('dining_tables').update({ area: r.area }).eq('id', t.id).select('id'), 'Saving the area') })
  }
```

Directly under `<h2 className="font-semibold">Tables</h2>` add:

```tsx
        <p className="text-xs text-brown-muted">The area groups tables into tabs on the POS home screen, in table order. Leave it empty for a table that is only under All.</p>
```

Replace the table header row with:

```tsx
          <thead><tr className="text-left text-xs text-brown-muted"><th>Label</th><th>Area</th><th>QR</th><th></th></tr></thead>
```

Directly under the label cell (`<td className="py-2 font-medium">{t.label}…</td>`) add:

```tsx
                <td><AreaField key={`${t.id}:${t.area ?? ''}`} table={t} onSave={(text) => saveArea(t, text)} /></td>
```

Append at the end of the file:

```tsx

/** A table's area, saved when the field loses focus or Enter is pressed. Remounted (by its key)
 *  when the saved area changes, so it always starts from what is stored. */
function AreaField({ table, onSave }: { table: TableRow; onSave: (text: string) => void }) {
  const [text, setText] = useState(table.area ?? '')
  return (
    <input aria-label={`Area of table ${table.label}`} className="w-36 rounded border border-border p-1 text-sm" placeholder="No area"
      maxLength={60} value={text} onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text.trim() !== (table.area ?? '')) onSave(text) }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
  )
}
```

(The update goes through the existing `dining_tables_update` policy; `dining_tables_guard` refuses it for anyone without `access_settings`, the same as this page's route.)

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/order/tableAdmin.ts src/features/pos/order/tableAdmin.test.ts src/features/pos/order/PosSettingsPage.tsx
git commit -m "feat(pos): table area field in POS settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Final checks and the browser check list

**Files:** none changed (fix-ups only if a check fails, committed as `fix(pos): …`).

**Interfaces:** none.

- [ ] **Step 1: Full suite and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: all test files PASS (1007 tests: 934 before + 73 new); tsc prints nothing.

- [ ] **Step 2: No native dialogs on the POS screens**

Run: `grep -rnE "window\.(confirm|prompt|alert)" src/features/pos/order src/features/pos/checkout src/features/pos/shell src/features/pos/shift`
Expected: only `src/features/pos/order/PosSettingsPage.tsx` and `src/features/pos/checkout/CheckoutSettings.tsx` (settings pages, out of scope).

- [ ] **Step 3: The QR page's sheet is untouched**

Run: `git log --format='%h %s' -3 -- src/features/pos/order/LineSheet.tsx src/qr/`
Expected: none of the listed commits is from this plan (all are older than `docs(pos): Feedme-layout front end implementation plan`).

- [ ] **Step 4: Hand the controller the browser check list**

The controller (after applying the migration on craft-os-dev, Task 1 Step 15) runs `/pos` on dev at 1180 × 820 with the dev launch entry and a `[TEST]` seed, and ticks:

1. Bottom bar on Home, Order and Transaction (not on Payment): grid button opens Order / Menu / Transaction / Report / Setting by role; the right side shows the staff name and the Malaysia time and opens the staff panel.
2. Staff panel: Open shift → banner "No shift open" disappears; Pay in / out; Close shift; My PIN; Printers (Test print); Live status; Exit POS → `/profile` (asks about unsent items first). Close the panel and confirm a browser-route test ticket still prints (the print host stays mounted).
3. Home: area tabs `All (n)` then areas in table order with open counts; Search finds a table from any tab; tiles 5 a row; an open table shows `RM x.xx · 12m`; a QR order on a table not open on screen gets the green ring.
4. Empty table → Select pax 1–20 → order screen with "No bill yet" and the pax; leaving with no drafts leaves no bill.
5. Order: categories, Search menu, Sold out mode (tap marks / unmarks), out-of-slot greyed; product with modifiers → sheet with red `SELECT n`, Confirm; draft appears under `Not sent · n items`, tap → edit / Remove; catalog chip switches (asks first with a cart).
6. Send → back home, tile shows the total; open again → sent items; tap one → Void item (approval).
7. Payment with drafts → "Send n new items first?" → Send & pay → Payment opens on that bill.
8. ← with drafts → "Discard n unsent items?".
9. Bill actions: Move → empty table moves; occupied table → "Merge into B4?" → merged; takeaway → only tables with a bill; Void bill (approval); Close empty bill; Pax; Pause / Resume QR; Open for QR (with the branch switch on).
10. Payment: Cash with the number pad and change; quick notes; Card tab asks the reference; Split payment with two payments; success shows the change and "Receipt printing…"; Done → home. Turn the network off at Pay → "Not sure the payment went through" → Try again / Check bill.
11. Transaction: today's bills, filters All / Paid / Voided / Refunded / Merged, search; detail shows items, totals, payments, refunds; Reprint receipt; Refund (approval) updates the list.
12. Offline: an order still queues (strip shows waiting), a rejected order shows Edit (reopens the order screen with its cart and catalog) / Discard.
13. No shift open → Payment disabled with "Open a shift to take payment"; Send still works.
14. `/pos/settings` → Tables → Area: set "Patio", blank it, 41 characters is refused.

Pushing `feature/pos-demo` and opening the PR are the controller's call after the browser check.
