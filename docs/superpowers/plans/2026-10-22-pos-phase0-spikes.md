# POS Demo Phase 0 — Technical Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer three yes/no questions before any real POS is built — can an iPad web page print to the shop's LAN printers, does a QR order reach the POS within 2 seconds with its kitchen/bar tickets, and do counter orders survive an internet outage without loss or duplicates — and record each answer as PASS or FAIL.

**Architecture:** A throwaway `spike_*` schema on a **dev** Supabase project, two standalone Vite pages (`spike/pos.html` for staff on the iPad, `spike/qr.html` for customers' phones) that never touch `App.tsx`, and a small Node print agent as the fallback printing path. The pure pieces (ticket layout, ESC/POS bytes, Epson/Star XML, print-job processing, latency maths, offline queue) are unit-tested and carry over to Phase 1; the pages and `spike_*` tables are deleted after the spike.

**Tech Stack:** React 19 + Vite 6 + TypeScript, Supabase (Postgres RPC + Realtime), Vitest, IndexedDB, Node 22.18+ (built-in TypeScript type stripping, `node:net`).

**Spec:** `docs/superpowers/specs/2026-10-22-pos-demo-design.md`（阶段 0）

## Global Constraints

- **Dev database only.** Every spike entry point calls `assertDevDatabase()`; it throws if the Supabase URL contains the prod ref `yfsoesxzurzjdwstszru`. Never run any `spike_*` SQL in the prod project.
- All work happens in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo` on branch `feature/pos-demo`. Do not touch the main checkout.
- All UI copy, field names and error messages are in English (`english-product-copy` rule); comments may be Chinese or English, matching the surrounding files.
- Money is stored as integer sen.
- Do not modify `src/App.tsx` or any existing feature — spike pages are separate Vite entries.
- Latency budget: QR order → visible on POS **≤ 2000 ms**.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run tests from the worktree root with `npx vitest run <path>`.

## File Structure

| File | Responsibility | Survives into Phase 1? |
|---|---|---|
| `supabase/spike-2026-10-22-pos-phase0.sql` | `spike_*` tables, RLS, Realtime, RPCs, seed | No |
| `supabase/spike-2026-10-22-pos-phase0-verify.sql` | Self-checking SQL (rolls back) | No |
| `supabase/spike-2026-10-22-pos-phase0-drop.sql` | Removes everything the spike created | No |
| `src/features/pos/print/ticket.ts` | `TicketPayload` type, Malaysia-time formatting, word wrap, `renderTicketLines` | Yes |
| `src/features/pos/print/escpos.ts` | `encodeEscPos(lines)` → raw printer bytes | Yes |
| `src/features/pos/print/xml.ts` | `escapeXml` | Yes |
| `src/features/pos/print/epson.ts` | Epson ePOS-Print XML + HTTP send | Yes |
| `src/features/pos/print/star.ts` | Star WebPRNT XML + HTTP send | Yes |
| `src/features/pos/print/adapter.ts` | `PrintRoute`, `printFromBrowser` dispatch | Yes |
| `src/features/pos/print/printHost.ts` | `processJob` claim → print → finish | Yes |
| `src/features/pos/offline/orderQueue.ts` | Durable counter-order queue logic | Yes |
| `src/features/pos/offline/idbStore.ts` | IndexedDB-backed `QueueStore` | Yes |
| `src/features/pos/spike/guard.ts` | `assertDevDatabase` | No |
| `src/features/pos/spike/latency.ts` | Clock offset + latency maths | Yes |
| `src/features/pos/spike/spikeApi.ts` | All Supabase calls the spike pages make | No |
| `src/features/pos/spike/PosSpike.tsx` + `LiveOrders.tsx` + `CounterOrder.tsx` + `PrintHostPanel.tsx` + `pos-main.tsx` | iPad page | No |
| `src/features/pos/spike/QrSpike.tsx` + `qr-main.tsx` | Customer page | No |
| `spike/pos.html`, `spike/qr.html` | Vite entries | No |
| `tools/print-agent/agent.ts` + `.env.example` | Node fallback printer driver (raw TCP 9100) | Maybe |
| `docs/superpowers/spikes/2026-10-22-pos-phase0-results.md` | Procedures + recorded PASS/FAIL | Yes |

---

### Task 0: Prerequisites (done by the user, not an agent)

These need the user's own accounts and the shop's hardware. An agent must stop and ask for each item it is missing.

- [ ] **Step 1: Create the dev Supabase project**

In the Supabase dashboard create a new project named `craft-os-dev` (free tier is enough). From **Project Settings → API Keys** copy the Project URL and the **anon** key (under "Legacy API keys" if the page shows both kinds).

- [ ] **Step 2: Point the worktree at it**

Create `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo/.env.local` (git-ignored):

```
VITE_SUPABASE_URL=https://<dev-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<dev anon key>
```

Check it is NOT prod:

```bash
grep -c yfsoesxzurzjdwstszru /Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo/.env.local
```

Expected: `0`

- [ ] **Step 3: Create one staff login in the dev project**

Dashboard → **Authentication → Users → Add user → Create new user**, tick "Auto Confirm User". Use e.g. `pos-spike@craftale.test` with a password of the user's choosing. The iPad page and the print agent both sign in with it. Do not paste the password into chat.

- [ ] **Step 4: Record the printers**

For each printer that will be tested (bar and kitchen): brand, model (label under the printer), and its LAN IP (print the printer's self-test page — hold FEED while powering on). Write them into the results doc in Task 11, Step 1.

- [ ] **Step 5: Install dependencies and check Node**

```bash
cd /Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo && npm install && node -v
```

Expected: install finishes; Node is `v22.18.0` or newer (type stripping is on by default from 22.18).

---

### Task 1: Spike schema, RPCs and SQL self-check

**Files:**
- Create: `supabase/spike-2026-10-22-pos-phase0.sql`
- Create: `supabase/spike-2026-10-22-pos-phase0-verify.sql`
- Create: `supabase/spike-2026-10-22-pos-phase0-drop.sql`

**Interfaces:**
- Produces (used by Tasks 7–10):
  - `spike_place_table_order(p_token text, p_items jsonb, p_client_order_id uuid) returns uuid` — anon + authenticated
  - `spike_place_counter_order(p_table_id uuid, p_items jsonb, p_client_order_id uuid) returns uuid` — authenticated; `p_table_id` null = takeaway
  - `p_items` is a JSON array of `{ "menuItemId": uuid, "qty": int, "note": string|null }` — **no prices are accepted from clients**
  - `spike_qr_menu(p_token text) returns jsonb` → `{ tableLabel, paused, items: [{ id, name, priceSen, available }] }` or `null`
  - `spike_server_now() returns timestamptz`
  - `spike_claim_print_job(p_id uuid) returns boolean`, `spike_finish_print_job(p_id uuid, p_ok boolean, p_error text) returns void`, `spike_requeue_print_job(p_id uuid) returns void`
  - Tables `spike_tables(id, label, qr_token, qr_paused, is_active)`, `spike_menu_items(id, name, price_sen, route, is_available)`, `spike_print_routes(route, kind, address)`, `spike_orders(id, bill_id, source, placed_by, client_order_id, placed_at)`, `spike_print_jobs(id, order_id, route, payload, status, attempts, last_error, created_at, printed_at)`
  - `spike_print_jobs.payload` has exactly the shape of `TicketPayload` (Task 2)

- [ ] **Step 1: Write the schema file**

`supabase/spike-2026-10-22-pos-phase0.sql`:

```sql
-- ============================================================================
-- POS Phase 0 spike schema — DEV SUPABASE ONLY.
-- NEVER run this in the prod project (yfsoesxzurzjdwstszru).
-- Everything here is prefixed spike_ and is removed by
-- spike-2026-10-22-pos-phase0-drop.sql once the spike results are recorded.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists spike_tables (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  qr_token   text not null unique default encode(gen_random_bytes(12), 'hex'),
  qr_paused  boolean not null default false,
  is_active  boolean not null default true
);

create table if not exists spike_menu_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  price_sen     integer not null check (price_sen >= 0),
  route         text not null,
  is_available  boolean not null default true
);

-- route → which printer prints it. kind 'agent' = printed by tools/print-agent
create table if not exists spike_print_routes (
  route    text primary key,
  kind     text not null check (kind in ('epson-epos', 'star-webprnt', 'agent')),
  address  text not null
);

create table if not exists spike_bills (
  id         uuid primary key default gen_random_uuid(),
  table_id   uuid references spike_tables(id),
  status     text not null default 'open' check (status in ('open', 'paid')),
  opened_at  timestamptz not null default now()
);
create unique index if not exists spike_bills_one_open_per_table
  on spike_bills(table_id) where status = 'open' and table_id is not null;

create table if not exists spike_orders (
  id               uuid primary key default gen_random_uuid(),
  bill_id          uuid not null references spike_bills(id),
  source           text not null check (source in ('qr', 'counter')),
  placed_by        uuid,
  client_order_id  uuid not null unique,
  placed_at        timestamptz not null default now()
);

create table if not exists spike_order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references spike_orders(id) on delete cascade,
  menu_item_id    uuid not null references spike_menu_items(id),
  name_snapshot   text not null,
  unit_price_sen  integer not null,
  qty             integer not null check (qty between 1 and 20),
  note            text,
  route           text not null
);

create table if not exists spike_print_jobs (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references spike_orders(id) on delete cascade,  -- null = test print
  route       text not null,
  payload     jsonb not null,
  status      text not null default 'pending'
              check (status in ('pending', 'printing', 'printed', 'failed')),
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  printed_at  timestamptz
);

-- ── RLS: signed-in staff may do anything; anon may do nothing directly ──────
do $$
declare t text;
begin
  foreach t in array array['spike_tables','spike_menu_items','spike_print_routes',
                           'spike_bills','spike_orders','spike_order_items','spike_print_jobs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists spike_staff_all on %I', t);
    execute format('create policy spike_staff_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ── Realtime ─────────────────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table spike_orders;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table spike_print_jobs;
exception when duplicate_object then null; end $$;

-- ── Server clock, for latency measurement ────────────────────────────────────
create or replace function spike_server_now() returns timestamptz
language sql stable as $$ select now() $$;
grant execute on function spike_server_now() to anon, authenticated;

-- ── Shared order writer (not callable by clients) ────────────────────────────
-- Prices, names and routes come from spike_menu_items, never from the client.
-- Idempotent on client_order_id: a resend returns the original order id.
create or replace function spike_insert_order(
  p_table_id uuid, p_source text, p_placed_by uuid, p_items jsonb, p_client_order_id uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_existing  uuid;
  v_bill_id   uuid;
  v_order_id  uuid;
  v_label     text;
  v_item      jsonb;
  v_menu      spike_menu_items;
begin
  select id into v_existing from spike_orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order has no items';
  end if;

  if p_table_id is null then
    insert into spike_bills(table_id) values (null) returning id into v_bill_id;
  else
    insert into spike_bills(table_id) values (p_table_id)
      on conflict (table_id) where status = 'open' and table_id is not null do nothing
      returning id into v_bill_id;
    if v_bill_id is null then
      select id into v_bill_id from spike_bills where table_id = p_table_id and status = 'open';
    end if;
    select label into v_label from spike_tables where id = p_table_id;
  end if;

  begin
    insert into spike_orders(bill_id, source, placed_by, client_order_id)
    values (v_bill_id, p_source, p_placed_by, p_client_order_id)
    returning id into v_order_id;
  exception when unique_violation then
    -- a concurrent resend of the same order won the race
    select id into v_order_id from spike_orders where client_order_id = p_client_order_id;
    return v_order_id;
  end;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_menu from spike_menu_items where id = (v_item->>'menuItemId')::uuid;
    if not found or not v_menu.is_available then
      raise exception 'Item is not available: %', coalesce(v_item->>'menuItemId', '?');
    end if;
    insert into spike_order_items(order_id, menu_item_id, name_snapshot, unit_price_sen, qty, note, route)
    values (v_order_id, v_menu.id, v_menu.name, v_menu.price_sen,
            coalesce((v_item->>'qty')::integer, 1), nullif(v_item->>'note', ''), v_menu.route);
  end loop;

  -- one ticket per route, shaped exactly like TicketPayload (ticket.ts)
  insert into spike_print_jobs(order_id, route, payload)
  select v_order_id, oi.route, jsonb_build_object(
           'kind', 'ticket',
           'route', oi.route,
           'tableLabel', v_label,
           'orderNo', upper(left(v_order_id::text, 6)),
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', oi.qty, 'name', oi.name_snapshot, 'note', oi.note)
                              order by oi.name_snapshot))
    from spike_order_items oi
   where oi.order_id = v_order_id
   group by oi.route;

  return v_order_id;
end $$;
revoke all on function spike_insert_order(uuid, text, uuid, jsonb, uuid) from public, anon, authenticated;

-- ── Customer QR ordering (anon) ──────────────────────────────────────────────
create or replace function spike_place_table_order(p_token text, p_items jsonb, p_client_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_table   spike_tables;
  v_recent  integer;
begin
  select * into v_table from spike_tables where qr_token = p_token and is_active;
  if not found then
    raise exception 'Invalid table code';
  end if;
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;

  select count(*) into v_recent
    from spike_orders o join spike_bills b on b.id = o.bill_id
   where b.table_id = v_table.id and o.source = 'qr' and o.placed_at > now() - interval '1 minute';
  if v_recent >= 5
     and not exists (select 1 from spike_orders where client_order_id = p_client_order_id) then
    raise exception 'Too many orders from this table. Please wait a minute.';
  end if;

  return spike_insert_order(v_table.id, 'qr', null, p_items, p_client_order_id);
end $$;
revoke all on function spike_place_table_order(text, jsonb, uuid) from public;
grant execute on function spike_place_table_order(text, jsonb, uuid) to anon, authenticated;

create or replace function spike_qr_menu(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'tableLabel', t.label,
           'paused', t.qr_paused,
           'items', coalesce((select jsonb_agg(jsonb_build_object(
                                 'id', m.id, 'name', m.name,
                                 'priceSen', m.price_sen, 'available', m.is_available)
                               order by m.name)
                              from spike_menu_items m), '[]'::jsonb))
    from spike_tables t
   where t.qr_token = p_token and t.is_active
$$;
revoke all on function spike_qr_menu(text) from public;
grant execute on function spike_qr_menu(text) to anon, authenticated;

-- ── Counter ordering (staff) ─────────────────────────────────────────────────
create or replace function spike_place_counter_order(p_table_id uuid, p_items jsonb, p_client_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  return spike_insert_order(p_table_id, 'counter', auth.uid(), p_items, p_client_order_id);
end $$;
revoke all on function spike_place_counter_order(uuid, jsonb, uuid) from public, anon;
grant execute on function spike_place_counter_order(uuid, jsonb, uuid) to authenticated;

-- ── Print job lifecycle: pending → printing → printed | failed ───────────────
-- claim is atomic, so the iPad and the print agent can never print one job twice.
create or replace function spike_claim_print_job(p_id uuid) returns boolean
language plpgsql security invoker as $$
begin
  update spike_print_jobs set status = 'printing', attempts = attempts + 1
   where id = p_id and status = 'pending';
  return found;
end $$;

create or replace function spike_finish_print_job(p_id uuid, p_ok boolean, p_error text) returns void
language plpgsql security invoker as $$
begin
  update spike_print_jobs
     set status     = case when p_ok then 'printed' else 'failed' end,
         printed_at = case when p_ok then now() else null end,
         last_error = case when p_ok then null else p_error end
   where id = p_id and status = 'printing';
end $$;

create or replace function spike_requeue_print_job(p_id uuid) returns void
language plpgsql security invoker as $$
begin
  update spike_print_jobs set status = 'pending' where id = p_id and status = 'failed';
end $$;

revoke all on function spike_claim_print_job(uuid), spike_finish_print_job(uuid, boolean, text),
                       spike_requeue_print_job(uuid) from public, anon;
grant execute on function spike_claim_print_job(uuid), spike_finish_print_job(uuid, boolean, text),
                          spike_requeue_print_job(uuid) to authenticated;

-- ── Seed ────────────────────────────────────────────────────────────────────
insert into spike_tables(label) values ('A1'), ('A2'), ('B5') on conflict (label) do nothing;

insert into spike_menu_items(name, price_sen, route)
select n, p, r from (values
  ('Coffee Latte (COLD)',         1300, 'Bar'),
  ('Lychee Rose',                 1800, 'Bar'),
  ('Smoked Duck DON',             2400, 'Kitchen'),
  ('Fried Chicken Curry DON',     2500, 'Kitchen'),
  ('Salted Egg 咸蛋酱 (CJK test)',   0, 'Kitchen')
) as v(n, p, r)
where not exists (select 1 from spike_menu_items);
```

- [ ] **Step 2: Write the self-check**

`supabase/spike-2026-10-22-pos-phase0-verify.sql` — everything runs inside a transaction that is rolled back, so it leaves no rows behind:

```sql
-- Run in the DEV project's SQL editor after the schema file.
-- Success = "VERIFY OK" notice. Any failure raises and names the check.
begin;

do $$
declare
  v_token   text;
  v_bar     uuid;
  v_kitchen uuid;
  v1        uuid;
  v2        uuid;
  v_jobs    integer;
  v_price   integer;
begin
  select qr_token into v_token from spike_tables where label = 'A1';
  select id into v_bar     from spike_menu_items where route = 'Bar'     order by name limit 1;
  select id into v_kitchen from spike_menu_items where route = 'Kitchen' order by name limit 1;

  -- 1. one order with a bar and a kitchen item → exactly two print jobs
  v1 := spike_place_table_order(v_token,
          jsonb_build_array(jsonb_build_object('menuItemId', v_bar, 'qty', 2),
                            jsonb_build_object('menuItemId', v_kitchen, 'qty', 1, 'note', 'no onion')),
          '00000000-0000-0000-0000-0000000000a1');
  select count(*) into v_jobs from spike_print_jobs where order_id = v1;
  if v_jobs <> 2 then raise exception 'FAIL routing: expected 2 print jobs, got %', v_jobs; end if;

  -- 2. resend with the same client_order_id → same order, no new jobs
  v2 := spike_place_table_order(v_token,
          jsonb_build_array(jsonb_build_object('menuItemId', v_bar, 'qty', 2)),
          '00000000-0000-0000-0000-0000000000a1');
  if v1 <> v2 then raise exception 'FAIL idempotency: resend created a second order'; end if;
  select count(*) into v_jobs from spike_print_jobs where order_id = v1;
  if v_jobs <> 2 then raise exception 'FAIL idempotency: resend created extra print jobs'; end if;

  -- 3. price comes from the menu, not the client
  select unit_price_sen into v_price from spike_order_items where order_id = v1 and menu_item_id = v_bar;
  if v_price <> (select price_sen from spike_menu_items where id = v_bar) then
    raise exception 'FAIL pricing: snapshot price does not match menu';
  end if;

  -- 4. second order on the same table joins the same open bill
  v2 := spike_place_table_order(v_token,
          jsonb_build_array(jsonb_build_object('menuItemId', v_bar)),
          '00000000-0000-0000-0000-0000000000a2');
  if (select bill_id from spike_orders where id = v1) <> (select bill_id from spike_orders where id = v2) then
    raise exception 'FAIL bills: second order on table A1 opened a new bill';
  end if;

  -- 5. invalid token is rejected
  begin
    perform spike_place_table_order('not-a-token',
              jsonb_build_array(jsonb_build_object('menuItemId', v_bar)), gen_random_uuid());
    raise exception 'FAIL token: invalid token was accepted';
  exception when raise_exception then
    if sqlerrm not like 'Invalid table code%' then raise; end if;
  end;

  -- 6. unavailable item is rejected and nothing is written
  update spike_menu_items set is_available = false where id = v_kitchen;
  begin
    perform spike_place_table_order(v_token,
              jsonb_build_array(jsonb_build_object('menuItemId', v_kitchen)),
              '00000000-0000-0000-0000-0000000000a3');
    raise exception 'FAIL availability: sold-out item was accepted';
  exception when raise_exception then
    if sqlerrm not like 'Item is not available%' then raise; end if;
  end;
  if exists (select 1 from spike_orders where client_order_id = '00000000-0000-0000-0000-0000000000a3') then
    raise exception 'FAIL availability: rejected order left a row behind';
  end if;

  -- 7. claim is single-winner
  select id into v1 from spike_print_jobs where status = 'pending' limit 1;
  if not spike_claim_print_job(v1) then raise exception 'FAIL claim: first claim lost'; end if;
  if spike_claim_print_job(v1)     then raise exception 'FAIL claim: second claim also won'; end if;

  raise notice 'VERIFY OK';
end $$;

rollback;
```

- [ ] **Step 3: Write the drop script**

`supabase/spike-2026-10-22-pos-phase0-drop.sql`:

```sql
-- Removes everything spike-2026-10-22-pos-phase0.sql created. DEV ONLY.
drop function if exists spike_place_table_order(text, jsonb, uuid);
drop function if exists spike_place_counter_order(uuid, jsonb, uuid);
drop function if exists spike_insert_order(uuid, text, uuid, jsonb, uuid);
drop function if exists spike_qr_menu(text);
drop function if exists spike_server_now();
drop function if exists spike_claim_print_job(uuid);
drop function if exists spike_finish_print_job(uuid, boolean, text);
drop function if exists spike_requeue_print_job(uuid);
drop table if exists spike_print_jobs, spike_order_items, spike_orders, spike_bills,
                     spike_print_routes, spike_menu_items, spike_tables cascade;
```

- [ ] **Step 4: Run schema then self-check on DEV**

The user opens the **dev** project's SQL editor (confirm the project name at the top reads `craft-os-dev`), pastes the schema file, runs it, then pastes and runs the verify file.

Expected: the verify run shows the notice `VERIFY OK` and no error.

- [ ] **Step 5: Register the printers**

In the same SQL editor, using the IPs recorded in Task 0 Step 4. The first route is printed by the iPad browser, the second by the Node agent, so both printing paths are exercised. For an Epson printer use `epson-epos` with `https://<ip>`; for a Star printer use `star-webprnt` with `https://<ip>`; for any other brand use `agent` with `<ip>:9100`.

```sql
insert into spike_print_routes(route, kind, address) values
  ('Bar',     'epson-epos', 'https://192.168.1.50'),
  ('Kitchen', 'agent',      '192.168.1.51:9100')
on conflict (route) do update set kind = excluded.kind, address = excluded.address;
```

(The two IPs above are examples — replace them with the recorded ones before running.)

- [ ] **Step 6: Commit**

```bash
cd /Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo
git add supabase/spike-2026-10-22-pos-phase0.sql supabase/spike-2026-10-22-pos-phase0-verify.sql supabase/spike-2026-10-22-pos-phase0-drop.sql
git commit -m "feat(pos-spike): dev-only spike schema with idempotent order RPCs and print job queue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ticket layout

**Files:**
- Create: `src/features/pos/print/ticket.ts`
- Test: `src/features/pos/print/ticket.test.ts`

**Interfaces:**
- Produces:
  - `interface TicketLine { qty: number; name: string; note: string | null }`
  - `interface TicketPayload { kind: 'ticket'; route: string; tableLabel: string | null; orderNo: string; source: 'qr' | 'counter' | 'test'; placedAt: string; lines: TicketLine[] }`
  - `formatMyt(iso: string): string` → `"22/10/2026 11:48"` (Asia/Kuala_Lumpur)
  - `wrap(text: string, width: number, indent?: string): string[]`
  - `renderTicketLines(t: TicketPayload, cols: number): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { formatMyt, wrap, renderTicketLines, type TicketPayload } from './ticket'

describe('formatMyt', () => {
  it('shows UTC timestamps in Malaysia time (+8)', () => {
    expect(formatMyt('2026-10-22T03:48:00.000Z')).toBe('22/10/2026 11:48')
  })

  it('rolls the date over after 16:00 UTC', () => {
    expect(formatMyt('2026-10-22T16:30:00.000Z')).toBe('23/10/2026 00:30')
  })
})

describe('wrap', () => {
  it('keeps a short line as is', () => {
    expect(wrap('1 x Latte', 32)).toEqual(['1 x Latte'])
  })

  it('breaks on spaces and indents continuation lines', () => {
    expect(wrap('2 x Fried Chicken Curry DON with extra sauce on the side', 32, '    ')).toEqual([
      '2 x Fried Chicken Curry DON with',
      '    extra sauce on the side',
    ])
  })

  it('never splits a single word longer than the width', () => {
    expect(wrap('Supercalifragilistic', 5)).toEqual(['Supercalifragilistic'])
  })
})

describe('renderTicketLines', () => {
  const base: TicketPayload = {
    kind: 'ticket',
    route: 'Bar',
    tableLabel: 'B5',
    orderNo: 'AB12CD',
    source: 'qr',
    placedAt: '2026-10-22T03:48:00.000Z',
    lines: [
      { qty: 1, name: 'Coffee Latte (COLD)', note: 'less ice' },
      { qty: 2, name: 'Fried Chicken Curry DON with extra sauce on the side', note: null },
    ],
  }

  it('lays out a dine-in ticket', () => {
    expect(renderTicketLines(base, 32)).toEqual([
      'BAR TICKET',
      'Table: B5',
      'Order: AB12CD (QR)',
      'Time: 22/10/2026 11:48',
      '--------------------------------',
      '1 x Coffee Latte (COLD)',
      '    * less ice',
      '2 x Fried Chicken Curry DON with',
      '    extra sauce on the side',
      '--------------------------------',
    ])
  })

  it('marks takeaway when there is no table', () => {
    const lines = renderTicketLines({ ...base, tableLabel: null, source: 'counter' }, 32)
    expect(lines[1]).toBe('TAKEAWAY')
    expect(lines[2]).toBe('Order: AB12CD (COUNTER)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/pos/print/ticket.test.ts`
Expected: FAIL — `Failed to resolve import "./ticket"`

- [ ] **Step 3: Write the implementation**

```ts
/** What one kitchen/bar ticket says. The spike SQL (spike_insert_order) builds
 *  exactly this shape into spike_print_jobs.payload, so keep the two in step. */
export interface TicketLine {
  qty: number
  name: string
  note: string | null
}

export interface TicketPayload {
  kind: 'ticket'
  route: string
  tableLabel: string | null // null = takeaway
  orderNo: string
  source: 'qr' | 'counter' | 'test'
  placedAt: string // ISO, UTC
  lines: TicketLine[]
}

const MYT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** "22/10/2026 11:48" in Malaysia time — the format Feedme's receipts use. */
export function formatMyt(iso: string): string {
  return MYT.format(new Date(iso)).replace(',', '')
}

/** Word-wraps on spaces. Width counts characters, so CJK text (two columns
 *  wide on a printer) can still overflow — recorded as a spike question. */
export function wrap(text: string, width: number, indent = ''): string[] {
  const out: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word
    if (!current || candidate.length <= width) {
      current = candidate
      continue
    }
    out.push(current)
    current = `${indent}${word}`
  }
  if (current) out.push(current)
  return out
}

export function renderTicketLines(t: TicketPayload, cols: number): string[] {
  const rule = '-'.repeat(cols)
  const body = t.lines.flatMap((l) => [
    ...wrap(`${l.qty} x ${l.name}`, cols, '    '),
    ...(l.note ? wrap(`* ${l.note}`, cols - 4, '  ').map((s) => `    ${s}`) : []),
  ])
  return [
    `${t.route.toUpperCase()} TICKET`,
    t.tableLabel ? `Table: ${t.tableLabel}` : 'TAKEAWAY',
    `Order: ${t.orderNo} (${t.source.toUpperCase()})`,
    `Time: ${formatMyt(t.placedAt)}`,
    rule,
    ...body,
    rule,
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/pos/print/ticket.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/print/ticket.ts src/features/pos/print/ticket.test.ts
git commit -m "feat(pos): ticket layout with Malaysia-time stamp and word wrap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: ESC/POS encoder

**Files:**
- Create: `src/features/pos/print/escpos.ts`
- Test: `src/features/pos/print/escpos.test.ts`

**Interfaces:**
- Produces: `encodeEscPos(lines: string[], opts?: { feed?: number; cut?: boolean }): Uint8Array`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { encodeEscPos } from './escpos'

describe('encodeEscPos', () => {
  it('initialises, prints each line, feeds and cuts', () => {
    expect(Array.from(encodeEscPos(['Hi', 'A']))).toEqual([
      0x1b, 0x40, // ESC @ — reset
      0x48, 0x69, 0x0a, // "Hi" LF
      0x41, 0x0a, // "A" LF
      0x1b, 0x64, 0x04, // ESC d 4 — feed 4 lines
      0x1d, 0x56, 0x42, 0x00, // GS V B 0 — feed and cut
    ])
  })

  it('replaces characters the printer cannot show with "?"', () => {
    expect(Array.from(encodeEscPos(['咸é'], { cut: false, feed: 0 }))).toEqual([
      0x1b, 0x40, 0x3f, 0x3f, 0x0a, 0x1b, 0x64, 0x00,
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/pos/print/escpos.test.ts`
Expected: FAIL — `Failed to resolve import "./escpos"`

- [ ] **Step 3: Write the implementation**

```ts
const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a
const QUESTION = 0x3f

/** Raw bytes for a generic ESC/POS printer on TCP 9100 (used by the print
 *  agent). Only printable ASCII goes through — anything else becomes "?".
 *  Chinese needs a printer-specific code page (GB18030 on Chinese models);
 *  whether the shop's printers support it is a spike question, not solved here. */
export function encodeEscPos(lines: string[], opts: { feed?: number; cut?: boolean } = {}): Uint8Array {
  const bytes: number[] = [ESC, 0x40]
  for (const line of lines) {
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? QUESTION
      bytes.push(code >= 0x20 && code < 0x7f ? code : QUESTION)
    }
    bytes.push(LF)
  }
  bytes.push(ESC, 0x64, opts.feed ?? 4)
  if (opts.cut ?? true) bytes.push(GS, 0x56, 0x42, 0x00)
  return Uint8Array.from(bytes)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/pos/print/escpos.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/print/escpos.ts src/features/pos/print/escpos.test.ts
git commit -m "feat(pos): ESC/POS byte encoder for raw TCP printing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Epson and Star browser adapters

**Files:**
- Create: `src/features/pos/print/xml.ts`
- Create: `src/features/pos/print/epson.ts`
- Create: `src/features/pos/print/star.ts`
- Create: `src/features/pos/print/adapter.ts`
- Test: `src/features/pos/print/adapter.test.ts`

**Interfaces:**
- Consumes: `TicketPayload`, `renderTicketLines` (Task 2)
- Produces:
  - `escapeXml(s: string): string`
  - `buildEposXml(lines: string[]): string`, `eposEndpoint(address: string): string`, `printEpson(address: string, lines: string[], fetchFn?: typeof fetch): Promise<void>`
  - `buildStarXml(lines: string[]): string`, `starEndpoint(address: string): string`, `printStar(address: string, lines: string[], fetchFn?: typeof fetch): Promise<void>`
  - `type PrinterKind = 'epson-epos' | 'star-webprnt' | 'agent'`
  - `interface PrintRoute { route: string; kind: PrinterKind; address: string }`
  - `TICKET_COLS = 42`
  - `printFromBrowser(route: PrintRoute, payload: TicketPayload, fetchFn?: typeof fetch): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { escapeXml } from './xml'
import { buildEposXml, eposEndpoint } from './epson'
import { buildStarXml, starEndpoint } from './star'
import { printFromBrowser, type PrintRoute } from './adapter'
import type { TicketPayload } from './ticket'

const payload: TicketPayload = {
  kind: 'ticket',
  route: 'Bar',
  tableLabel: 'A1',
  orderNo: 'TEST01',
  source: 'test',
  placedAt: '2026-10-22T03:48:00.000Z',
  lines: [{ qty: 1, name: 'Latte', note: null }],
}

function fakeFetch(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

describe('escapeXml', () => {
  it('escapes the five characters XML cares about', () => {
    expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;')
  })
})

describe('Epson ePOS-Print', () => {
  it('wraps lines in a SOAP epos-print document with feed and cut', () => {
    const xml = buildEposXml(['A & B', 'C'])
    expect(xml).toContain('<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">')
    expect(xml).toContain('<text lang="zh-hans">A &amp; B&#10;C&#10;</text>')
    expect(xml).toContain('<cut type="feed"/>')
  })

  it('builds the service URL and drops a trailing slash', () => {
    expect(eposEndpoint('https://192.168.1.50/')).toBe(
      'https://192.168.1.50/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000',
    )
  })
})

describe('Star WebPRNT', () => {
  it('escapes the inner request inside the StarWebPrint envelope', () => {
    const xml = buildStarXml(['A&B'])
    expect(xml.startsWith('<StarWebPrint xmlns="http://www.star-m.jp"')).toBe(true)
    expect(xml).toContain('&lt;root&gt;&lt;text&gt;A&amp;amp;B\n&lt;/text&gt;')
    expect(xml).toContain('&lt;cutpaper feed=&quot;true&quot;/&gt;')
  })

  it('builds the SendMessage URL', () => {
    expect(starEndpoint('https://10.0.0.9')).toBe('https://10.0.0.9/StarWebPRNT/SendMessage')
  })
})

describe('printFromBrowser', () => {
  const epson: PrintRoute = { route: 'Bar', kind: 'epson-epos', address: 'https://192.168.1.50' }
  const star: PrintRoute = { route: 'Bar', kind: 'star-webprnt', address: 'https://192.168.1.60' }

  it('posts to the Epson printer and accepts success="true"', async () => {
    const f = fakeFetch(200, '<response success="true" code="" status="251658262"/>')
    await printFromBrowser(epson, payload, f)
    expect(vi.mocked(f).mock.calls[0][0]).toBe(eposEndpoint(epson.address))
  })

  it('rejects when the Epson printer reports failure', async () => {
    const f = fakeFetch(200, '<response success="false" code="EPTR_COVER_OPEN"/>')
    await expect(printFromBrowser(epson, payload, f)).rejects.toThrow('EPTR_COVER_OPEN')
  })

  it('posts to the Star printer and accepts <success>true</success>', async () => {
    const f = fakeFetch(200, '<Response><success>true</success></Response>')
    await printFromBrowser(star, payload, f)
    expect(vi.mocked(f).mock.calls[0][0]).toBe(starEndpoint(star.address))
  })

  it('refuses routes that belong to the print agent', async () => {
    await expect(
      printFromBrowser({ route: 'Kitchen', kind: 'agent', address: '10.0.0.5:9100' }, payload, fakeFetch(200, '')),
    ).rejects.toThrow('print agent')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/pos/print/adapter.test.ts`
Expected: FAIL — `Failed to resolve import "./xml"`

- [ ] **Step 3: Write `xml.ts`**

```ts
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
```

- [ ] **Step 4: Write `epson.ts`**

```ts
import { escapeXml } from './xml'

/** Epson ePOS-Print: the printer runs a small web service, so a web page can
 *  print with a plain HTTP POST — no driver, no app. lang="zh-hans" lets the
 *  printer render Chinese if its firmware has the font. */
export function buildEposXml(lines: string[]): string {
  const text = lines.map((l) => `${escapeXml(l)}&#10;`).join('')
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">' +
    `<text lang="zh-hans">${text}</text><feed line="3"/><cut type="feed"/>` +
    '</epos-print></s:Body></s:Envelope>'
  )
}

export function eposEndpoint(address: string): string {
  return `${address.replace(/\/$/, '')}/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000`
}

export async function printEpson(address: string, lines: string[], fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(eposEndpoint(address), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
    body: buildEposXml(lines),
  })
  const body = await res.text()
  if (!res.ok || !/success="true"/.test(body)) {
    throw new Error(`Epson printer refused the job (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }
}
```

- [ ] **Step 5: Write `star.ts`**

```ts
import { escapeXml } from './xml'

/** Star WebPRNT: the print request is its own XML document, escaped once more
 *  and carried inside the <Request> element of the StarWebPrint envelope. */
export function buildStarXml(lines: string[]): string {
  const request =
    '<root>' + lines.map((l) => `<text>${escapeXml(l)}\n</text>`).join('') + '<cutpaper feed="true"/></root>'
  return (
    '<StarWebPrint xmlns="http://www.star-m.jp" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
    `<Request>${escapeXml(request)}</Request></StarWebPrint>`
  )
}

export function starEndpoint(address: string): string {
  return `${address.replace(/\/$/, '')}/StarWebPRNT/SendMessage`
}

export async function printStar(address: string, lines: string[], fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(starEndpoint(address), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    body: buildStarXml(lines),
  })
  const body = await res.text()
  if (!res.ok || !/<success>\s*true\s*<\/success>/i.test(body)) {
    throw new Error(`Star printer refused the job (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }
}
```

- [ ] **Step 6: Write `adapter.ts`**

```ts
import { renderTicketLines, type TicketPayload } from './ticket'
import { printEpson } from './epson'
import { printStar } from './star'

export type PrinterKind = 'epson-epos' | 'star-webprnt' | 'agent'

export interface PrintRoute {
  route: string
  kind: PrinterKind
  address: string
}

/** 80 mm paper at the default font fits 42–48 characters; 42 is the safe
 *  value until the spike measures the real printers. */
export const TICKET_COLS = 42

export async function printFromBrowser(
  route: PrintRoute,
  payload: TicketPayload,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const lines = renderTicketLines(payload, TICKET_COLS)
  if (route.kind === 'epson-epos') return printEpson(route.address, lines, fetchFn)
  if (route.kind === 'star-webprnt') return printStar(route.address, lines, fetchFn)
  throw new Error(`Route ${route.route} is printed by the print agent, not the browser`)
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/features/pos/print/adapter.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/print/xml.ts src/features/pos/print/epson.ts src/features/pos/print/star.ts src/features/pos/print/adapter.ts src/features/pos/print/adapter.test.ts
git commit -m "feat(pos): Epson ePOS and Star WebPRNT browser print adapters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Print host job processing

**Files:**
- Create: `src/features/pos/print/printHost.ts`
- Test: `src/features/pos/print/printHost.test.ts`

**Interfaces:**
- Consumes: `TicketPayload` (Task 2)
- Produces:
  - `interface PrintJob { id: string; route: string; payload: TicketPayload; status: string }`
  - `interface PrintHostDeps { claim(id: string): Promise<boolean>; finish(id: string, ok: boolean, error: string | null): Promise<void>; print(job: PrintJob): Promise<void> }`
  - `type JobResult = 'skipped' | 'printed' | 'failed'`
  - `processJob(job: PrintJob, deps: PrintHostDeps): Promise<JobResult>`
- **Constraint:** this file may only use `import type` (the Node agent loads it through type stripping, which cannot resolve extension-less runtime imports).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { processJob, type PrintHostDeps, type PrintJob } from './printHost'

const job: PrintJob = {
  id: 'job-1',
  route: 'Bar',
  status: 'pending',
  payload: {
    kind: 'ticket',
    route: 'Bar',
    tableLabel: 'A1',
    orderNo: 'X',
    source: 'qr',
    placedAt: '2026-10-22T03:48:00.000Z',
    lines: [],
  },
}

function deps(overrides: Partial<PrintHostDeps> = {}): PrintHostDeps {
  return {
    claim: vi.fn(async () => true),
    finish: vi.fn(async () => undefined),
    print: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('processJob', () => {
  it('prints a pending job it managed to claim, then marks it printed', async () => {
    const d = deps()
    expect(await processJob(job, d)).toBe('printed')
    expect(d.print).toHaveBeenCalledWith(job)
    expect(d.finish).toHaveBeenCalledWith('job-1', true, null)
  })

  it('skips a job someone else already claimed', async () => {
    const d = deps({ claim: vi.fn(async () => false) })
    expect(await processJob(job, d)).toBe('skipped')
    expect(d.print).not.toHaveBeenCalled()
    expect(d.finish).not.toHaveBeenCalled()
  })

  it('skips jobs that are not pending without claiming', async () => {
    const d = deps()
    expect(await processJob({ ...job, status: 'printed' }, d)).toBe('skipped')
    expect(d.claim).not.toHaveBeenCalled()
  })

  it('records the error when printing fails', async () => {
    const d = deps({ print: vi.fn(async () => Promise.reject(new Error('Cover open'))) })
    expect(await processJob(job, d)).toBe('failed')
    expect(d.finish).toHaveBeenCalledWith('job-1', false, 'Cover open')
  })

  it('never marks a printed ticket failed when recording success fails', async () => {
    const finish = vi.fn(async (_id: string, ok: boolean) => {
      if (ok) throw new Error('network down')
    })
    const d = deps({ finish })
    await expect(processJob(job, d)).rejects.toThrow('network down')
    expect(d.print).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish).not.toHaveBeenCalledWith('job-1', false, expect.anything())
  })

  it('records a non-Error throw as text', async () => {
    const d = deps({ print: vi.fn(async () => Promise.reject('paper jam')) })
    expect(await processJob(job, d)).toBe('failed')
    expect(d.finish).toHaveBeenCalledWith('job-1', false, 'paper jam')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/pos/print/printHost.test.ts`
Expected: FAIL — `Failed to resolve import "./printHost"`

- [ ] **Step 3: Write the implementation**

```ts
import type { TicketPayload } from './ticket'

export interface PrintJob {
  id: string
  route: string
  payload: TicketPayload
  status: string
}

export interface PrintHostDeps {
  /** Atomically moves the job pending → printing; false if another host got it first. */
  claim(id: string): Promise<boolean>
  finish(id: string, ok: boolean, error: string | null): Promise<void>
  print(job: PrintJob): Promise<void>
}

export type JobResult = 'skipped' | 'printed' | 'failed'

/** Shared by the iPad page and the Node print agent. Claiming first is what
 *  keeps two hosts — or one host hearing about a job twice — from printing
 *  the same ticket twice. */
export async function processJob(job: PrintJob, deps: PrintHostDeps): Promise<JobResult> {
  if (job.status !== 'pending') return 'skipped'
  if (!(await deps.claim(job.id))) return 'skipped'
  try {
    await deps.print(job)
  } catch (e) {
    await deps.finish(job.id, false, e instanceof Error ? e.message : String(e))
    return 'failed'
  }
  // Outside the try on purpose: the ticket is already on paper, so failing to
  // record that must never turn into 'failed' (which would invite a duplicate
  // reprint). The error propagates and the job stays 'printing'.
  await deps.finish(job.id, true, null)
  return 'printed'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/pos/print/printHost.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/print/printHost.ts src/features/pos/print/printHost.test.ts
git commit -m "feat(pos): claim-print-finish job processing shared by iPad and agent

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Latency maths and the dev-database guard

**Files:**
- Create: `src/features/pos/spike/latency.ts`
- Create: `src/features/pos/spike/guard.ts`
- Test: `src/features/pos/spike/latency.test.ts`

**Interfaces:**
- Produces:
  - `parseServerTime(iso: string): number` — accepts Postgres' 6-digit fractions (Safari's `Date.parse` does not)
  - `clockOffsetMs(sentAtLocal: number, serverIso: string, receivedAtLocal: number): number` — server minus local
  - `latencyMs(placedAtIso: string, receivedAtLocal: number, offsetMs: number): number`
  - `LATENCY_BUDGET_MS = 2000`
  - `assertDevDatabase(url: string): void`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { parseServerTime, clockOffsetMs, latencyMs, LATENCY_BUDGET_MS } from './latency'
import { assertDevDatabase } from './guard'

describe('parseServerTime', () => {
  it('reads Postgres timestamps with microseconds', () => {
    expect(parseServerTime('2026-10-22T03:48:00.123456+00:00')).toBe(Date.UTC(2026, 9, 22, 3, 48, 0, 123))
  })

  it('reads plain ISO timestamps', () => {
    expect(parseServerTime('2026-10-22T03:48:00.500Z')).toBe(Date.UTC(2026, 9, 22, 3, 48, 0, 500))
  })
})

describe('clock offset and latency', () => {
  it('assumes the server answered halfway through the round trip', () => {
    // local clock is 1000 ms behind the server
    const server = '2026-10-22T03:48:01.050Z'
    const sent = Date.UTC(2026, 9, 22, 3, 48, 0, 0)
    expect(clockOffsetMs(sent, server, sent + 100)).toBe(1000)
  })

  it('measures from placed_at to arrival on the server clock', () => {
    const placed = '2026-10-22T03:48:00.000Z'
    const receivedLocal = Date.UTC(2026, 9, 22, 3, 47, 59, 400) // local clock is behind
    expect(latencyMs(placed, receivedLocal, 1000)).toBe(400)
  })

  it('budget is two seconds', () => {
    expect(LATENCY_BUDGET_MS).toBe(2000)
  })
})

describe('assertDevDatabase', () => {
  it('refuses the production project', () => {
    expect(() => assertDevDatabase('https://yfsoesxzurzjdwstszru.supabase.co')).toThrow('production')
  })

  it('allows any other project', () => {
    expect(() => assertDevDatabase('https://abcdefgh.supabase.co')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/pos/spike/latency.test.ts`
Expected: FAIL — `Failed to resolve import "./latency"`

- [ ] **Step 3: Write `latency.ts`**

```ts
export const LATENCY_BUDGET_MS = 2000

/** Postgres sends microseconds ("…:00.123456+00:00"); Safari's Date.parse
 *  rejects more than three fraction digits, so trim them first. */
export function parseServerTime(iso: string): number {
  return Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'))
}

/** Server clock minus local clock, from one request/response round trip —
 *  the server's "now" is assumed to sit at the midpoint. */
export function clockOffsetMs(sentAtLocal: number, serverIso: string, receivedAtLocal: number): number {
  return parseServerTime(serverIso) - (sentAtLocal + receivedAtLocal) / 2
}

/** How long after the server stamped placed_at this device saw the order. */
export function latencyMs(placedAtIso: string, receivedAtLocal: number, offsetMs: number): number {
  return receivedAtLocal + offsetMs - parseServerTime(placedAtIso)
}
```

- [ ] **Step 4: Write `guard.ts`**

```ts
const PROD_REF = 'yfsoesxzurzjdwstszru'

/** The spike writes test orders and print jobs freely. It must never point
 *  at the production project, which local dev uses by default. */
export function assertDevDatabase(url: string): void {
  if (url.includes(PROD_REF)) {
    throw new Error(
      'The POS spike must never run against the production database. Point VITE_SUPABASE_URL at the dev project.',
    )
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/pos/spike/latency.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/spike/latency.ts src/features/pos/spike/guard.ts src/features/pos/spike/latency.test.ts
git commit -m "feat(pos-spike): latency maths and a guard against the prod database

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Offline counter-order queue

**Files:**
- Create: `src/features/pos/offline/orderQueue.ts`
- Create: `src/features/pos/offline/idbStore.ts`
- Test: `src/features/pos/offline/orderQueue.test.ts`
- Test: `src/features/pos/offline/idbStore.test.ts`
- Modify: `package.json` (devDependency `fake-indexeddb`)

**Interfaces:**
- Produces:
  - `interface CartLine { menuItemId: string; qty: number; note: string | null }` — same keys the RPC reads from `p_items`
  - `interface QueuedOrder { clientOrderId: string; tableId: string | null; items: CartLine[]; queuedAt: number; failedReason: string | null }`
  - `interface QueueStore { put(o: QueuedOrder): Promise<void>; all(): Promise<QueuedOrder[]>; remove(clientOrderId: string): Promise<void> }`
  - `type SendResult = { ok: true } | { ok: false; retryable: boolean; reason: string }`
  - `type Sender = (o: QueuedOrder) => Promise<SendResult>`
  - `interface FlushReport { sent: number; pending: number; stuck: number }`
  - `newQueuedOrder(tableId: string | null, items: CartLine[], now?: number, id?: string): QueuedOrder`
  - `enqueue(store: QueueStore, order: QueuedOrder): Promise<void>`
  - `flushQueue(store: QueueStore, send: Sender): Promise<FlushReport>`
  - `toSendResult(error: { message: string; code?: string } | null): SendResult`
  - `createIdbStore(dbName?: string): QueueStore`

- [ ] **Step 1: Install the IndexedDB test double**

```bash
npm install --save-dev fake-indexeddb@^6.0.0
```

Expected: `package.json` gains `"fake-indexeddb"` under `devDependencies`.

- [ ] **Step 2: Write the failing queue test**

`src/features/pos/offline/orderQueue.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  flushQueue, newQueuedOrder, enqueue, toSendResult,
  type QueueStore, type QueuedOrder, type SendResult,
} from './orderQueue'

function memoryStore(): QueueStore & { rows: Map<string, QueuedOrder> } {
  const rows = new Map<string, QueuedOrder>()
  return {
    rows,
    put: async (o) => void rows.set(o.clientOrderId, o),
    all: async () => [...rows.values()],
    remove: async (id) => void rows.delete(id),
  }
}

const line = { menuItemId: 'm1', qty: 1, note: null }
const ok: SendResult = { ok: true }

describe('flushQueue', () => {
  it('sends oldest first and empties the queue', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder(null, [line], 2000, 'b'))
    await enqueue(store, newQueuedOrder(null, [line], 1000, 'a'))
    const send = vi.fn(async (_o: QueuedOrder) => ok)
    expect(await flushQueue(store, send)).toEqual({ sent: 2, pending: 0, stuck: 0 })
    expect(send.mock.calls.map(([o]) => o.clientOrderId)).toEqual(['a', 'b'])
  })

  it('stops at a network failure and keeps that order and everything after it', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder(null, [line], 1, 'a'))
    await enqueue(store, newQueuedOrder(null, [line], 2, 'b'))
    const send = vi.fn(async () => ({ ok: false, retryable: true, reason: 'Load failed' }) as SendResult)
    expect(await flushQueue(store, send)).toEqual({ sent: 0, pending: 2, stuck: 0 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('parks an order the server rejected and carries on with the rest', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder(null, [line], 1, 'bad'))
    await enqueue(store, newQueuedOrder(null, [line], 2, 'good'))
    const send = vi.fn(async (o: QueuedOrder) =>
      o.clientOrderId === 'bad' ? ({ ok: false, retryable: false, reason: 'Item is not available' } as SendResult) : ok,
    )
    expect(await flushQueue(store, send)).toEqual({ sent: 1, pending: 0, stuck: 1 })
    expect(store.rows.get('bad')?.failedReason).toBe('Item is not available')
  })

  it('never resends a parked order', async () => {
    const store = memoryStore()
    await store.put({ ...newQueuedOrder(null, [line], 1, 'bad'), failedReason: 'Item is not available' })
    const send = vi.fn(async () => ok)
    await flushQueue(store, send)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('flushQueue with a throwing sender', () => {
  it('keeps the order and stops the flush instead of rejecting', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder(null, [line], 1, 'a'))
    const send = vi.fn(async () => { throw new Error('boom') })
    expect(await flushQueue(store, send)).toEqual({ sent: 0, pending: 1, stuck: 0 })
  })
})

describe('newQueuedOrder', () => {
  it('copies the cart so later cart edits cannot change a queued order', () => {
    const items = [{ ...line }]
    const order = newQueuedOrder('t1', items, 5, 'id')
    items[0].qty = 9
    expect(order).toEqual({ clientOrderId: 'id', tableId: 't1', items: [line], queuedAt: 5, failedReason: null })
  })
})

describe('toSendResult', () => {
  it('treats no error as success', () => {
    expect(toSendResult(null)).toEqual({ ok: true })
  })

  it.each(['TypeError: Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'fetch failed'])(
    'treats "%s" as a retryable network failure',
    (message) => {
      expect(toSendResult({ message })).toEqual({ ok: false, retryable: true, reason: message })
    },
  )

  it('treats the RPC\'s own business-rule rejections as final', () => {
    expect(toSendResult({ message: 'Item is not available: x', code: 'P0001' })).toEqual({
      ok: false, retryable: false, reason: 'Item is not available: x',
    })
  })

  it('treats a check violation as final', () => {
    expect(toSendResult({ message: 'new row violates check constraint', code: '23514' })).toEqual({
      ok: false, retryable: false, reason: 'new row violates check constraint',
    })
  })

  it('retries an expired JWT', () => {
    expect(toSendResult({ message: 'JWT expired', code: 'PGRST301' })).toEqual({
      ok: false, retryable: true, reason: 'JWT expired',
    })
  })

  it('retries a statement timeout', () => {
    expect(toSendResult({ message: 'canceling statement due to statement timeout', code: '57014' })).toEqual({
      ok: false, retryable: true, reason: 'canceling statement due to statement timeout',
    })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/features/pos/offline/orderQueue.test.ts`
Expected: FAIL — `Failed to resolve import "./orderQueue"`

- [ ] **Step 4: Write `orderQueue.ts`**

```ts
/** Counter orders are written to the device FIRST and sent second, so an
 *  order the cashier has confirmed survives a dropped connection, a closed
 *  tab or a dead battery. The server dedupes on clientOrderId, which makes
 *  resending always safe — including after a send whose reply was lost. */

export interface CartLine {
  menuItemId: string
  qty: number
  note: string | null
}

export interface QueuedOrder {
  clientOrderId: string
  tableId: string | null // null = takeaway
  items: CartLine[]
  queuedAt: number
  failedReason: string | null // set when the server rejected it; never resent automatically
}

export interface QueueStore {
  put(o: QueuedOrder): Promise<void>
  all(): Promise<QueuedOrder[]>
  remove(clientOrderId: string): Promise<void>
}

export type SendResult = { ok: true } | { ok: false; retryable: boolean; reason: string }
export type Sender = (o: QueuedOrder) => Promise<SendResult>

export interface FlushReport {
  sent: number
  pending: number
  stuck: number
}

export function newQueuedOrder(
  tableId: string | null,
  items: CartLine[],
  now: number = Date.now(),
  id: string = crypto.randomUUID(),
): QueuedOrder {
  return { clientOrderId: id, tableId, items: items.map((l) => ({ ...l })), queuedAt: now, failedReason: null }
}

export async function enqueue(store: QueueStore, order: QueuedOrder): Promise<void> {
  await store.put(order)
}

export async function flushQueue(store: QueueStore, send: Sender): Promise<FlushReport> {
  const queued = (await store.all()).sort((a, b) => a.queuedAt - b.queuedAt)
  let sent = 0
  for (const order of queued) {
    if (order.failedReason) continue
    let res: SendResult
    try {
      res = await send(order)
    } catch (e) {
      // A throwing sender must not lose the flush: keep the order, stop here.
      res = { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) }
    }
    if (res.ok) {
      await store.remove(order.clientOrderId)
      sent++
      continue
    }
    if (res.retryable) break // still offline — keep order, try again later
    await store.put({ ...order, failedReason: res.reason })
  }
  const left = await store.all()
  return {
    sent,
    pending: left.filter((o) => !o.failedReason).length,
    stuck: left.filter((o) => o.failedReason).length,
  }
}

/** Only these server-confirmed Postgres errors are final. Anything else —
 *  network failures, expired JWT, 502/503/504, statement timeout, aborts — is
 *  retried, which is always safe because the server dedupes on client_order_id. */
const FINAL_ERROR_CODES = new Set([
  'P0001', // raise_exception — the RPC's own business-rule rejections, e.g. "Item is not available"
  '23514', // check_violation — e.g. qty out of range
  '22P02', // invalid_text_representation — e.g. malformed uuid
  '23503', // foreign_key_violation
])

export function toSendResult(error: { message: string; code?: string } | null): SendResult {
  if (!error) return { ok: true }
  const final = error.code !== undefined && FINAL_ERROR_CODES.has(error.code)
  return { ok: false, retryable: !final, reason: error.message }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/features/pos/offline/orderQueue.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 6: Write the failing IndexedDB test**

`src/features/pos/offline/idbStore.test.ts`:

```ts
import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { createIdbStore, runTransaction } from './idbStore'
import { newQueuedOrder, type QueuedOrder } from './orderQueue'

describe('createIdbStore', () => {
  it('keeps orders across separate store instances (i.e. a page reload)', async () => {
    const first = createIdbStore('test-reload')
    await first.put(newQueuedOrder('t1', [{ menuItemId: 'm1', qty: 2, note: 'hot' }], 1, 'a'))
    await first.put(newQueuedOrder(null, [{ menuItemId: 'm2', qty: 1, note: null }], 2, 'b'))

    const second = createIdbStore('test-reload')
    const rows = (await second.all()).sort((x, y) => x.queuedAt - y.queuedAt)
    expect(rows.map((r) => r.clientOrderId)).toEqual(['a', 'b'])
    expect(rows[0].items).toEqual([{ menuItemId: 'm1', qty: 2, note: 'hot' }])
  })

  it('removes and overwrites by clientOrderId', async () => {
    const store = createIdbStore('test-remove')
    const order = newQueuedOrder(null, [{ menuItemId: 'm1', qty: 1, note: null }], 1, 'a')
    await store.put(order)
    await store.put({ ...order, failedReason: 'rejected' })
    expect(await store.all()).toEqual([{ ...order, failedReason: 'rejected' }])
    await store.remove('a')
    expect(await store.all()).toEqual([])
  })

  describe('never hangs', () => {
    it('rejects a put with no key instead of hanging', async () => {
      const store = createIdbStore('test-nokey')
      await expect(store.put({ foo: 1 } as unknown as QueuedOrder)).rejects.toBeDefined()
    })

    it('rejects when the transaction is aborted', async () => {
      const order = newQueuedOrder(null, [{ menuItemId: 'm1', qty: 1, note: null }], 1, 'a')
      await expect(
        runTransaction('test-abort', 'readwrite', (s) => {
          const r = s.put(order)
          s.transaction.abort()
          return r
        }),
      ).rejects.toBeDefined()
    })

    it('still works on the same database after a rejected call', async () => {
      const store = createIdbStore('test-after-reject')
      await store.put({ foo: 1 } as unknown as QueuedOrder).catch(() => {})
      const order = newQueuedOrder(null, [{ menuItemId: 'm1', qty: 1, note: null }], 1, 'a')
      await store.put(order)
      expect(await store.all()).toEqual([order])
    })
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run src/features/pos/offline/idbStore.test.ts`
Expected: FAIL — `Failed to resolve import "./idbStore"`

- [ ] **Step 8: Write `idbStore.ts`**

```ts
import type { QueueStore, QueuedOrder } from './orderQueue'

const STORE = 'order-queue'

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'clientOrderId' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Opens, runs one request, and waits for the transaction to COMMIT — only
 *  then is the order on disk. Resolving on the request's onsuccess would be
 *  too early. Always settles: a commit-time abort (quota, eviction) rejects,
 *  and a synchronous throw closes the connection instead of leaking it. */
export async function runTransaction<T>(
  dbName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb(dbName)
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      db.close()
      settle()
    }
    try {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => finish(() => resolve(req.result))
      tx.onerror = () => finish(() => reject(tx.error))
      tx.onabort = () =>
        finish(() => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError')))
    } catch (e) {
      finish(() => reject(e))
    }
  })
}

export function createIdbStore(dbName = 'craft-pos'): QueueStore {
  return {
    put: async (o) => {
      await runTransaction(dbName, 'readwrite', (s) => s.put(o))
    },
    all: () => runTransaction(dbName, 'readonly', (s) => s.getAll() as IDBRequest<QueuedOrder[]>),
    remove: async (id) => {
      await runTransaction(dbName, 'readwrite', (s) => s.delete(id))
    },
  }
}
```

- [ ] **Step 9: Run both tests**

Run: `npx vitest run src/features/pos/offline`
Expected: PASS (20 tests)

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/features/pos/offline
git commit -m "feat(pos): durable offline queue for counter orders, backed by IndexedDB

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: HTTPS dev server and the customer QR page

**Files:**
- Modify: `vite.config.ts`
- Modify: `package.json` (devDependency `@vitejs/plugin-basic-ssl`)
- Create: `spike/qr.html`
- Create: `src/features/pos/spike/qr-main.tsx`
- Create: `src/features/pos/spike/QrSpike.tsx`

**Interfaces:**
- Consumes: `spike_qr_menu`, `spike_place_table_order` (Task 1), `assertDevDatabase` (Task 6), `supabase` from `src/shared/lib/supabase.ts`
- Produces: page at `https://<mac-lan-ip>:5173/spike/qr.html?t=<qr_token>`

Why HTTPS: the real POS will be served over HTTPS, and Safari blocks an HTTPS page from calling an `http://` printer (mixed content). The spike must test under the same rule, and `crypto.randomUUID()` also needs a secure context.

- [ ] **Step 1: Install the self-signed HTTPS plugin**

```bash
npm install --save-dev @vitejs/plugin-basic-ssl@^1.2.0
```

- [ ] **Step 2: Enable it only when asked**

Replace `vite.config.ts` with:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  // HTTPS=1 serves a self-signed certificate so iPads and phones on the shop
  // Wi-Fi get a secure context (POS spike). Plain `npm run dev` is unchanged.
  plugins: [react(), ...(process.env.HTTPS === '1' ? [basicSsl()] : [])],
  server: {
    // honor an externally assigned port (e.g. preview harness); default 5173
    port: Number(process.env.PORT) || 5173,
  },
})
```

- [ ] **Step 3: Create `spike/qr.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Order — Craft Cafe</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/features/pos/spike/qr-main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create `src/features/pos/spike/qr-main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../index.css'
import { assertDevDatabase } from './guard'
import QrSpike from './QrSpike'

assertDevDatabase(import.meta.env.VITE_SUPABASE_URL as string)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QrSpike />
  </StrictMode>,
)
```

- [ ] **Step 5: Create `src/features/pos/spike/QrSpike.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'

interface QrMenu {
  tableLabel: string
  paused: boolean
  items: { id: string; name: string; priceSen: number; available: boolean }[]
}

const rm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`

export default function QrSpike() {
  const token = new URLSearchParams(window.location.search).get('t') ?? ''
  const [menu, setMenu] = useState<QrMenu | null | undefined>(undefined)
  const [cart, setCart] = useState<Record<string, number>>({})
  // Kept until the server confirms, so tapping "Place order" again after a
  // timeout resends the SAME order instead of creating a second one.
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    void supabase
      .rpc('spike_qr_menu', { p_token: token })
      .then(({ data, error }) => setMenu(error ? null : ((data as QrMenu | null) ?? null)))
  }, [token])

  if (menu === undefined) return <p className="p-6">Loading menu…</p>
  if (menu === null) return <p className="p-6">This table code is not valid. Please ask our staff.</p>

  const change = (id: string, delta: number) => {
    setPendingId(null) // a different cart is a different order
    setCart((c) => ({ ...c, [id]: Math.max(0, (c[id] ?? 0) + delta) }))
  }

  const items = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([menuItemId, qty]) => ({ menuItemId, qty, note: null }))

  const place = async () => {
    const id = pendingId ?? crypto.randomUUID()
    setPendingId(id)
    setStatus('Sending…')
    const { error } = await supabase.rpc('spike_place_table_order', {
      p_token: token,
      p_items: items,
      p_client_order_id: id,
    })
    if (error) {
      setStatus(`Not sent: ${error.message} Tap Place order to try again.`)
      return
    }
    setPendingId(null)
    setCart({})
    setStatus(`Order placed at ${new Date().toLocaleTimeString()}`)
  }

  return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-xl font-semibold">Table {menu.tableLabel}</h1>
      {menu.paused && <p className="rounded bg-amber-100 p-3">Ordering is paused for this table. Please order at the counter.</p>}
      <ul className="divide-y rounded border">
        {menu.items.map((item) => (
          <li key={item.id} className="flex items-center justify-between p-3">
            <div className={item.available ? '' : 'opacity-40'}>
              <div>{item.name}</div>
              <div className="text-sm text-neutral-500">{item.available ? rm(item.priceSen) : 'Sold out'}</div>
            </div>
            {item.available && (
              <div className="flex items-center gap-3">
                <button className="h-9 w-9 rounded border text-lg" onClick={() => change(item.id, -1)}>−</button>
                <span className="w-5 text-center">{cart[item.id] ?? 0}</span>
                <button className="h-9 w-9 rounded border text-lg" onClick={() => change(item.id, 1)}>+</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button
        className="w-full rounded bg-neutral-900 py-3 text-white disabled:opacity-40"
        disabled={items.length === 0 || menu.paused || status === 'Sending…'}
        onClick={() => void place()}
      >
        Place order
      </button>
      {status && <p className="text-center text-sm">{status}</p>}
    </main>
  )
}
```

- [ ] **Step 6: Type-check and smoke-test**

Run: `npx tsc -b`
Expected: no errors.

Then start the server over HTTPS on the LAN in the background:

```bash
HTTPS=1 npm run dev -- --host
```

Expected: Vite prints a `https://` Network URL. Get a table token from the dev SQL editor (`select label, qr_token from spike_tables;`), open `https://localhost:5173/spike/qr.html?t=<token>` on the Mac, accept the self-signed certificate warning, and confirm the five seed items show with prices and "Table A1" heading. Place one order and confirm `Order placed at …` appears and `select count(*) from spike_orders;` on dev went up by one.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts package.json package-lock.json spike/qr.html src/features/pos/spike/qr-main.tsx src/features/pos/spike/QrSpike.tsx
git commit -m "feat(pos-spike): customer QR order page and opt-in HTTPS dev server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: iPad POS spike page

**Files:**
- Create: `spike/pos.html`
- Create: `src/features/pos/spike/pos-main.tsx`
- Create: `src/features/pos/spike/spikeApi.ts`
- Create: `src/features/pos/spike/PosSpike.tsx`
- Create: `src/features/pos/spike/LiveOrders.tsx`
- Create: `src/features/pos/spike/CounterOrder.tsx`
- Create: `src/features/pos/spike/PrintHostPanel.tsx`

**Interfaces:**
- Consumes: Task 1 RPCs/tables; `printFromBrowser`, `PrintRoute` (Task 4); `processJob`, `PrintJob` (Task 5); `clockOffsetMs`, `latencyMs`, `LATENCY_BUDGET_MS`, `assertDevDatabase` (Task 6); `newQueuedOrder`, `enqueue`, `flushQueue`, `toSendResult`, `createIdbStore`, `CartLine`, `QueuedOrder`, `SendResult`, `FlushReport` (Task 7)
- Produces: page at `https://<mac-lan-ip>:5173/spike/pos.html`

- [ ] **Step 1: Create `spike/pos.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>POS spike</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/features/pos/spike/pos-main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `src/features/pos/spike/pos-main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../../index.css'
import { assertDevDatabase } from './guard'
import PosSpike from './PosSpike'

assertDevDatabase(import.meta.env.VITE_SUPABASE_URL as string)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PosSpike />
  </StrictMode>,
)
```

- [ ] **Step 3: Create `src/features/pos/spike/spikeApi.ts`**

```ts
import { supabase } from '../../../shared/lib/supabase'
import { toSendResult, type QueuedOrder, type SendResult } from '../offline/orderQueue'
import type { PrintRoute } from '../print/adapter'
import type { PrintJob } from '../print/printHost'
import type { TicketPayload } from '../print/ticket'

export interface SpikeTable {
  id: string
  label: string
  qr_token: string
}

export interface SpikeMenuItem {
  id: string
  name: string
  price_sen: number
  route: string
  is_available: boolean
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

export async function fetchTables(): Promise<SpikeTable[]> {
  const { data, error } = await supabase.from('spike_tables').select('id, label, qr_token').eq('is_active', true).order('label')
  fail(error)
  return data ?? []
}

export async function fetchMenu(): Promise<SpikeMenuItem[]> {
  const { data, error } = await supabase.from('spike_menu_items').select('id, name, price_sen, route, is_available').order('name')
  fail(error)
  return data ?? []
}

export async function fetchRoutes(): Promise<PrintRoute[]> {
  const { data, error } = await supabase.from('spike_print_routes').select('route, kind, address').order('route')
  fail(error)
  return data ?? []
}

export async function fetchServerNow(): Promise<string> {
  const { data, error } = await supabase.rpc('spike_server_now')
  fail(error)
  return data as string
}

export async function fetchOrderTableLabel(orderId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('spike_orders')
    .select('spike_bills(spike_tables(label))')
    .eq('id', orderId)
    .single()
  fail(error)
  const row = data as unknown as { spike_bills: { spike_tables: { label: string } | null } | null } | null
  return row?.spike_bills?.spike_tables?.label ?? null
}

export async function sendCounterOrder(o: QueuedOrder): Promise<SendResult> {
  try {
    const { error } = await supabase.rpc('spike_place_counter_order', {
      p_table_id: o.tableId,
      p_items: o.items,
      p_client_order_id: o.clientOrderId,
    })
    return toSendResult(error)
  } catch (e) {
    return { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function countOrdersWithClientId(clientOrderId: string): Promise<number> {
  const { count, error } = await supabase
    .from('spike_orders')
    .select('id', { count: 'exact', head: true })
    .eq('client_order_id', clientOrderId)
  fail(error)
  return count ?? 0
}

export async function claimJob(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('spike_claim_print_job', { p_id: id })
  fail(error)
  return data === true
}

export async function finishJob(id: string, ok: boolean, err: string | null): Promise<void> {
  const { error } = await supabase.rpc('spike_finish_print_job', { p_id: id, p_ok: ok, p_error: err })
  fail(error)
}

export async function requeueJob(id: string): Promise<void> {
  const { error } = await supabase.rpc('spike_requeue_print_job', { p_id: id })
  fail(error)
}

export async function fetchPendingJobs(routes: string[]): Promise<PrintJob[]> {
  if (routes.length === 0) return []
  const { data, error } = await supabase
    .from('spike_print_jobs')
    .select('id, route, payload, status')
    .eq('status', 'pending')
    .in('route', routes)
    .order('created_at')
  fail(error)
  return (data ?? []) as PrintJob[]
}

export async function insertTestJob(route: string): Promise<void> {
  const payload: TicketPayload = {
    kind: 'ticket',
    route,
    tableLabel: 'TEST',
    orderNo: 'TEST01',
    source: 'test',
    placedAt: new Date().toISOString(),
    lines: [
      { qty: 1, name: 'Test print — if you can read this, the route works', note: null },
      { qty: 1, name: 'Chinese check: 咸蛋酱 测试', note: 'Record whether these characters printed' },
    ],
  }
  const { error } = await supabase.from('spike_print_jobs').insert({ route, payload })
  fail(error)
}
```

- [ ] **Step 4: Create `src/features/pos/spike/LiveOrders.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'
import { clockOffsetMs, latencyMs, LATENCY_BUDGET_MS } from './latency'
import { fetchOrderTableLabel, fetchServerNow } from './spikeApi'

interface LiveRow {
  id: string
  source: string
  table: string
  latency: number
}

export default function LiveOrders() {
  const offsetRef = useRef(0)
  const [offset, setOffset] = useState<number | null>(null)
  const [status, setStatus] = useState('connecting')
  const [rows, setRows] = useState<LiveRow[]>([])

  useEffect(() => {
    const sent = Date.now()
    fetchServerNow()
      .then((iso) => {
        offsetRef.current = clockOffsetMs(sent, iso, Date.now())
        setOffset(Math.round(offsetRef.current))
      })
      .catch(() => setOffset(null))
  }, [])

  useEffect(() => {
    const channel = supabase
      .channel('spike-orders')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'spike_orders' }, (p) => {
        const receivedAt = Date.now() // stamp before any further round trip
        const row = p.new as { id: string; source: string; placed_at: string }
        const latency = Math.round(latencyMs(row.placed_at, receivedAt, offsetRef.current))
        void fetchOrderTableLabel(row.id)
          .catch(() => null)
          .then((label) =>
            setRows((r) => [{ id: row.id, source: row.source, table: label ?? 'Takeaway', latency }, ...r].slice(0, 20)),
          )
      })
      .subscribe((s) => setStatus(s))
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  const worst = rows.length ? Math.max(...rows.map((r) => r.latency)) : null

  return (
    <section className="rounded border p-4">
      <h2 className="font-semibold">Spike 2 — live orders</h2>
      <p className="text-sm text-neutral-500">
        Realtime: {status} · clock offset: {offset === null ? 'unknown' : `${offset} ms`} · worst latency:{' '}
        {worst === null ? '—' : `${worst} ms`} (budget {LATENCY_BUDGET_MS} ms)
      </p>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left">
            <th>Order</th>
            <th>Table</th>
            <th>Source</th>
            <th>Latency</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-mono">{r.id.slice(0, 6).toUpperCase()}</td>
              <td>{r.table}</td>
              <td>{r.source}</td>
              <td className={r.latency <= LATENCY_BUDGET_MS ? 'text-green-600' : 'font-semibold text-red-600'}>
                {r.latency} ms
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
```

- [ ] **Step 5: Create `src/features/pos/spike/CounterOrder.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { createIdbStore } from '../offline/idbStore'
import { enqueue, flushQueue, newQueuedOrder, type CartLine, type FlushReport } from '../offline/orderQueue'
import {
  countOrdersWithClientId, fetchMenu, fetchTables, sendCounterOrder,
  type SpikeMenuItem, type SpikeTable,
} from './spikeApi'

const store = createIdbStore()

/** Shows the last good copy at once, then refreshes from the server. Offline,
 *  the cached copy is all there is — which is the point. */
function cachedLoad<T>(key: string, load: () => Promise<T>, set: (v: T) => void): void {
  try {
    const raw = localStorage.getItem(key)
    if (raw) set(JSON.parse(raw) as T)
  } catch {
    // storage unavailable — fall through to the network
  }
  load()
    .then((v) => {
      set(v)
      try {
        localStorage.setItem(key, JSON.stringify(v))
      } catch {
        // ignore
      }
    })
    .catch(() => undefined)
}

export default function CounterOrder() {
  const [tables, setTables] = useState<SpikeTable[]>([])
  const [menu, setMenu] = useState<SpikeMenuItem[]>([])
  const [tableId, setTableId] = useState('') // '' = takeaway
  const [cart, setCart] = useState<CartLine[]>([])
  const [online, setOnline] = useState(navigator.onLine)
  const [report, setReport] = useState<FlushReport | null>(null)
  const [dupResult, setDupResult] = useState<string | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)

  const flush = useCallback(() => {
    // one flush at a time — overlapping flushes would send the same order twice
    inFlight.current ??= flushQueue(store, sendCounterOrder)
      .then(setReport)
      .finally(() => {
        inFlight.current = null
      })
    return inFlight.current
  }, [])

  useEffect(() => {
    cachedLoad('pos-spike:tables', fetchTables, setTables)
    cachedLoad('pos-spike:menu', fetchMenu, setMenu)
    void navigator.storage?.persist?.()
    void flush()
    const goOnline = () => {
      setOnline(true)
      void flush()
    }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    const timer = window.setInterval(() => void flush(), 15_000)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      window.clearInterval(timer)
    }
  }, [flush])

  const add = (menuItemId: string) =>
    setCart((c) =>
      c.some((l) => l.menuItemId === menuItemId)
        ? c.map((l) => (l.menuItemId === menuItemId ? { ...l, qty: l.qty + 1 } : l))
        : [...c, { menuItemId, qty: 1, note: null }],
    )

  const submit = async () => {
    await enqueue(store, newQueuedOrder(tableId || null, cart)) // on disk before anything else
    setCart([])
    await flush()
  }

  const duplicateTest = async () => {
    const order = newQueuedOrder(tableId || null, [{ menuItemId: menu[0].id, qty: 1, note: 'duplicate test' }])
    const first = await sendCounterOrder(order)
    const second = await sendCounterOrder(order) // simulates a resend after a lost reply
    const rows = await countOrdersWithClientId(order.clientOrderId)
    setDupResult(
      first.ok && second.ok && rows === 1
        ? 'PASS — sent twice, stored once'
        : `FAIL — first ${first.ok ? 'ok' : 'error'}, second ${second.ok ? 'ok' : 'error'}, rows ${rows}`,
    )
  }

  const nameOf = (id: string) => menu.find((m) => m.id === id)?.name ?? id

  return (
    <section className="rounded border p-4">
      <h2 className="font-semibold">Spike 3 — counter orders</h2>
      <p className="text-sm text-neutral-500">
        {online ? 'Online' : 'OFFLINE'} · queued: {report?.pending ?? '…'} · rejected: {report?.stuck ?? '…'} · sent in
        last flush: {report?.sent ?? '…'}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <select className="rounded border p-2" value={tableId} onChange={(e) => setTableId(e.target.value)}>
          <option value="">Takeaway</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              Table {t.label}
            </option>
          ))}
        </select>
        {menu.map((m) => (
          <button key={m.id} className="rounded border px-3 py-2" onClick={() => add(m.id)}>
            {m.name}
          </button>
        ))}
      </div>
      <ul className="mt-2 text-sm">
        {cart.map((l) => (
          <li key={l.menuItemId}>
            {l.qty} x {nameOf(l.menuItemId)}
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <button
          className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-40"
          disabled={cart.length === 0}
          onClick={() => void submit()}
        >
          Submit order
        </button>
        <button className="rounded border px-4 py-2" onClick={() => void flush()}>
          Retry now
        </button>
        <button className="rounded border px-4 py-2" disabled={menu.length === 0} onClick={() => void duplicateTest()}>
          Duplicate test
        </button>
      </div>
      {dupResult && <p className="mt-2 text-sm">{dupResult}</p>}
    </section>
  )
}
```

- [ ] **Step 6: Create `src/features/pos/spike/PrintHostPanel.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'
import { printFromBrowser, type PrintRoute } from '../print/adapter'
import { processJob, type PrintJob } from '../print/printHost'
import { claimJob, fetchPendingJobs, fetchRoutes, finishJob, insertTestJob, requeueJob } from './spikeApi'

export default function PrintHostPanel() {
  const [enabled, setEnabled] = useState(true)
  const [routes, setRoutes] = useState<PrintRoute[]>([])
  const [failed, setFailed] = useState<PrintJob[]>([])
  const [log, setLog] = useState<string[]>([])
  const routesRef = useRef<PrintRoute[]>([])

  const note = useCallback(
    (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 30)),
    [],
  )

  const handle = useCallback(
    async (job: PrintJob) => {
      const route = routesRef.current.find((r) => r.route === job.route)
      if (!route || route.kind === 'agent') return // the Node agent prints these
      const result = await processJob(job, {
        claim: claimJob,
        finish: finishJob,
        print: async (j) => {
          try {
            await printFromBrowser(route, j.payload)
          } catch (e) {
            note(`${j.route} error: ${e instanceof Error ? e.message : String(e)}`)
            throw e
          }
        },
      })
      note(`${job.route} ${job.id.slice(0, 8)} → ${result}`)
      if (result === 'failed') setFailed((f) => [...f, job])
    },
    [note],
  )

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchRoutes()
      .then(async (rs) => {
        routesRef.current = rs
        setRoutes(rs)
        const browserRoutes = rs.filter((r) => r.kind !== 'agent').map((r) => r.route)
        for (const job of await fetchPendingJobs(browserRoutes)) {
          if (cancelled) return
          await handle(job)
        }
      })
      .catch((e: Error) => note(`could not load routes: ${e.message}`))
    const channel = supabase
      .channel('spike-print-jobs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'spike_print_jobs' }, (p) => {
        void handle(p.new as PrintJob)
      })
      .subscribe()
    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [enabled, handle, note])

  const reprint = async (job: PrintJob) => {
    await requeueJob(job.id)
    setFailed((f) => f.filter((x) => x.id !== job.id))
    await handle({ ...job, status: 'pending' })
  }

  return (
    <section className="rounded border p-4">
      <h2 className="font-semibold">Spike 1 — printing</h2>
      <label className="mt-1 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        This iPad prints browser routes
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        {routes.map((r) => (
          <button
            key={r.route}
            className="rounded border px-3 py-2"
            onClick={() => void insertTestJob(r.route).catch((e: Error) => note(e.message))}
          >
            Test print {r.route} ({r.kind} · {r.address})
          </button>
        ))}
      </div>
      {failed.length > 0 && (
        <div className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">
          {failed.map((j) => (
            <div key={j.id} className="flex items-center justify-between">
              <span>
                {j.route} ticket {j.id.slice(0, 8)} did not print
              </span>
              <button className="underline" onClick={() => void reprint(j)}>
                Reprint
              </button>
            </div>
          ))}
        </div>
      )}
      <pre className="mt-2 max-h-48 overflow-auto text-xs">{log.join('\n')}</pre>
    </section>
  )
}
```

- [ ] **Step 7: Create `src/features/pos/spike/PosSpike.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../../shared/lib/supabase'
import CounterOrder from './CounterOrder'
import LiveOrders from './LiveOrders'
import PrintHostPanel from './PrintHostPanel'
import { fetchTables, type SpikeTable } from './spikeApi'

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    setError(err ? err.message : null)
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto mt-16 max-w-sm space-y-3 p-4">
      <h1 className="text-xl font-semibold">POS spike — sign in (dev project)</h1>
      <input className="w-full rounded border p-2" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        className="w-full rounded border p-2"
        placeholder="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="w-full rounded bg-neutral-900 py-2 text-white">Sign in</button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  )
}

function TableLinks() {
  const [tables, setTables] = useState<SpikeTable[]>([])
  useEffect(() => {
    fetchTables().then(setTables).catch(() => undefined)
  }, [])
  return (
    <section className="rounded border p-4 text-sm">
      <h2 className="font-semibold">QR pages (open on a phone on the shop Wi-Fi)</h2>
      <ul className="mt-1 space-y-1">
        {tables.map((t) => {
          const url = `${window.location.origin}/spike/qr.html?t=${t.qr_token}`
          return (
            <li key={t.id}>
              Table {t.label}:{' '}
              <a className="break-all underline" href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default function PosSpike() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!ready) return <p className="p-6">Loading…</p>
  if (!session) return <SignIn />

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">POS spike — Phase 0</h1>
      <TableLinks />
      <PrintHostPanel />
      <LiveOrders />
      <CounterOrder />
    </main>
  )
}
```

- [ ] **Step 8: Type-check and lint**

Run: `npx tsc -b && npx eslint src/features/pos`
Expected: no errors.

- [ ] **Step 9: Smoke-test on the Mac**

With `HTTPS=1 npm run dev -- --host` running, open `https://localhost:5173/spike/pos.html`, sign in with the Task 0 account, and check:
1. "QR pages" lists tables A1, A2, B5 with links.
2. "Spike 2 — live orders" shows `Realtime: SUBSCRIBED` and a clock offset in ms.
3. Opening a QR link in another tab and placing an order adds a row to "live orders" with a latency figure.
4. "Spike 3" → pick Table A2, tap two items, **Submit order** → "queued: 0 · sent in last flush: 1".
5. **Duplicate test** → `PASS — sent twice, stored once`.

Expected: all five hold. (Printing is checked on site in Task 11.)

- [ ] **Step 10: Commit**

```bash
git add spike/pos.html src/features/pos/spike
git commit -m "feat(pos-spike): iPad page for print host, live latency and offline counter orders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Node print agent (raw TCP fallback)

**Files:**
- Create: `tools/print-agent/agent.ts`
- Create: `tools/print-agent/.env.example`

**Interfaces:**
- Consumes: `renderTicketLines`, `TicketPayload` (Task 2); `encodeEscPos` (Task 3); `processJob`, `PrintJob`, `PrintHostDeps` (Task 5); `assertDevDatabase` (Task 6); Task 1 RPCs
- Produces: `node --env-file=tools/print-agent/.env tools/print-agent/agent.ts` — prints every job whose route has `kind = 'agent'`

Runs on any always-on computer on the shop LAN (for the spike: the Mac). Node 22.18+ strips the TypeScript types itself, so the imports below carry explicit `.ts` extensions.

- [ ] **Step 1: Create `tools/print-agent/.env.example`**

```
# Copy to tools/print-agent/.env (git-ignored) and fill in. DEV project only.
SUPABASE_URL=https://<dev-project-ref>.supabase.co
SUPABASE_ANON_KEY=<dev anon key>
AGENT_EMAIL=pos-spike@craftale.test
AGENT_PASSWORD=<the password set in Task 0>
TICKET_COLS=42
```

- [ ] **Step 2: Create `tools/print-agent/agent.ts`**

```ts
// POS spike print agent: prints every spike_print_jobs row whose route is
// kind 'agent', by sending raw ESC/POS bytes to the printer on TCP 9100.
// Run:  node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
import net from 'node:net'
import { createClient } from '@supabase/supabase-js'
import { renderTicketLines } from '../../src/features/pos/print/ticket.ts'
import { encodeEscPos } from '../../src/features/pos/print/escpos.ts'
import { processJob, type PrintHostDeps, type PrintJob } from '../../src/features/pos/print/printHost.ts'
import { assertDevDatabase } from '../../src/features/pos/spike/guard.ts'

function env(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key} in tools/print-agent/.env`)
  return value
}

const url = env('SUPABASE_URL')
assertDevDatabase(url)
const supabase = createClient(url, env('SUPABASE_ANON_KEY'), { auth: { persistSession: false } })
const cols = Number(process.env.TICKET_COLS ?? 42)

function sendRaw(address: string, bytes: Uint8Array): Promise<void> {
  const [host, port = '9100'] = address.split(':')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) })
    socket.setTimeout(5000)
    socket.on('connect', () =>
      socket.end(Buffer.from(bytes), () => {
        socket.destroy()
        resolve()
      }),
    )
    socket.on('timeout', () => socket.destroy(new Error(`Printer ${address} did not answer within 5 s`)))
    socket.on('error', reject)
  })
}

async function main(): Promise<void> {
  const { error: authError } = await supabase.auth.signInWithPassword({
    email: env('AGENT_EMAIL'),
    password: env('AGENT_PASSWORD'),
  })
  if (authError) throw authError

  const { data: routes, error: routeError } = await supabase
    .from('spike_print_routes')
    .select('route, address')
    .eq('kind', 'agent')
  if (routeError) throw routeError
  const addressOf = new Map<string, string>((routes ?? []).map((r: { route: string; address: string }) => [r.route, r.address]))
  console.log('agent routes:', Object.fromEntries(addressOf))

  const deps: PrintHostDeps = {
    claim: async (id) => {
      const { data, error } = await supabase.rpc('spike_claim_print_job', { p_id: id })
      if (error) throw error
      return data === true
    },
    finish: async (id, ok, err) => {
      const { error } = await supabase.rpc('spike_finish_print_job', { p_id: id, p_ok: ok, p_error: err })
      if (error) throw error
    },
    print: async (job) => {
      await sendRaw(addressOf.get(job.route)!, encodeEscPos(renderTicketLines(job.payload, cols)))
    },
  }

  const handle = async (job: PrintJob): Promise<void> => {
    if (!addressOf.has(job.route)) return
    const result = await processJob(job, deps)
    console.log(new Date().toISOString(), job.route, job.id.slice(0, 8), result)
  }

  // Realtime can drop events while reconnecting; the sweep catches anything missed.
  const sweep = async (): Promise<void> => {
    const { data, error } = await supabase
      .from('spike_print_jobs')
      .select('id, route, payload, status')
      .eq('status', 'pending')
      .in('route', [...addressOf.keys()])
      .order('created_at')
    if (error) {
      console.error('sweep failed:', error.message)
      return
    }
    for (const job of (data ?? []) as PrintJob[]) await handle(job)
  }

  await sweep()
  supabase
    .channel('print-agent')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'spike_print_jobs' }, (p) => {
      void handle(p.new as PrintJob)
    })
    .subscribe((status) => console.log('realtime:', status))
  setInterval(() => void sweep(), 10_000)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
```

- [ ] **Step 3: Smoke-test against a fake printer**

In one terminal, a stand-in printer that dumps what it receives:

```bash
nc -l 9100 | xxd | head -20
```

In the dev SQL editor point the Kitchen route at it (`<mac-lan-ip>` = the Mac's own address):

```sql
update spike_print_routes set kind = 'agent', address = '<mac-lan-ip>:9100' where route = 'Kitchen';
```

Then create `tools/print-agent/.env` from the example and run:

```bash
node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
```

On the POS spike page press **Test print Kitchen**.
Expected: the agent logs `realtime: SUBSCRIBED` then `… Kitchen <id> printed`; the `nc` window shows bytes starting `1b40` and containing `KITCHEN TICKET`. Afterwards set the Kitchen route back to the real printer address from Task 0.

- [ ] **Step 4: Commit**

```bash
git add tools/print-agent/agent.ts tools/print-agent/.env.example
git commit -m "feat(pos-spike): Node print agent for raw TCP 9100 printers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Run the three spikes on site and record the results

This task is done in the shop with the user. Nothing here is "done" until each spike row reads PASS or FAIL with evidence.

**Files:**
- Create: `docs/superpowers/spikes/2026-10-22-pos-phase0-results.md`

- [ ] **Step 1: Create the results document**

```markdown
# POS Phase 0 — spike results

Spec: docs/superpowers/specs/2026-10-22-pos-demo-design.md
Plan: docs/superpowers/plans/2026-10-22-pos-phase0-spikes.md

## Setup

| Item | Value |
|---|---|
| Date / shop | |
| Wi-Fi network | |
| Mac running Vite + agent (IP) | |
| iPad model / iPadOS version | |
| Phone(s) used for QR | |
| Bar printer — brand / model / IP / route kind | |
| Kitchen printer — brand / model / IP / route kind | |

## Spike 1 — printing

| Check | How | Result | Evidence |
|---|---|---|---|
| 1a Browser → printer over HTTPS | iPad: open `https://<printer-ip>` once and accept its certificate, then POS page → Test print (browser route) | | |
| 1b Certificate acceptance survives closing and reopening Safari | Close Safari fully, reopen POS page, Test print again | | |
| 1c Agent → printer on TCP 9100 | Mac: run agent, POS page → Test print (agent route) | | |
| 1d Chinese characters | Look at the "Chinese check" line on each ticket | | |
| 1e Ticket width | Does a 42-column rule fit on one line? If not, what does? | | |
| 1f Failure shows and reprints | Open the printer cover, Test print, close cover, press Reprint | | |

**Spike 1 verdict:** PASS if 1a+1b pass OR 1c passes, and 1f passes.

## Spike 2 — QR order → POS ≤ 2 s, tickets printed

Procedure: iPad shows the POS page. On a phone on the shop Wi-Fi open the Table B5 QR link. Place 10 orders, each with one Bar and one Kitchen item, about 10 s apart.

| # | Latency on POS (ms) | Bar ticket printed | Kitchen ticket printed |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |

Order-to-print time from the database (paste the output):

    select round(extract(epoch from (j.printed_at - o.placed_at)) * 1000) as ms_to_print, j.route
      from spike_print_jobs j join spike_orders o on o.id = j.order_id
     where o.source = 'qr' order by o.placed_at desc limit 20;

**Spike 2 verdict:** PASS if all 10 latencies ≤ 2000 ms and all 20 tickets printed exactly once.

## Spike 3 — counter orders survive an outage

| Check | How | Result | Evidence |
|---|---|---|---|
| 3a Queue while internet is down | Unplug the router's internet (WAN) cable — Wi-Fi stays up. Submit 3 counter orders. "queued" shows 3 | | |
| 3b Survives closing the tab | Close the POS tab, reopen it (still no internet). "queued" still 3 | | |
| 3c Sends on reconnect | Plug WAN back in. Within 15 s "queued" is 0 and "sent" is 3 | | |
| 3d No duplicates | Paste: `select client_order_id, count(*) from spike_orders where source = 'counter' group by 1 having count(*) > 1;` — expect zero rows | | |
| 3e Duplicate test button | Press Duplicate test | | |

**Spike 3 verdict:** PASS if 3a–3e all pass.

## Outcome

| Spike | Verdict |
|---|---|
| 1 Printing | |
| 2 Realtime | |
| 3 Offline | |

**Decision:**
- All three PASS → start Phase 1 on the spec as written; the print path is whichever of 1a/1c passed.
- Only 1c passed for printing → amend the spec: Phase 1 needs an always-on print agent device in each shop.
- Spike 1 fails entirely → stop and decide on printer hardware before Phase 1.
- Spike 2 fails → investigate Realtime region/latency before Phase 1.
- Spike 3 fails → fix the queue before Phase 1; do not pilot without it.
```

- [ ] **Step 2: Run the spikes with the user and fill in every row**

Start on the Mac (both in the background, on the shop Wi-Fi):

```bash
HTTPS=1 npm run dev -- --host
```

```bash
node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
```

On the iPad open `https://<mac-lan-ip>:5173/spike/pos.html` (accept the certificate), sign in, and follow the three procedures in the results document. Fill in each row as it is done — a row is only PASS with its evidence written next to it (a number, a photo filename, or pasted query output).

- [ ] **Step 3: Commit the results**

```bash
git add docs/superpowers/spikes/2026-10-22-pos-phase0-results.md
git commit -m "docs(pos-spike): Phase 0 spike results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feature/pos-demo
```
