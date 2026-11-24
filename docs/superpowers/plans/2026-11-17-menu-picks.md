# Menu Picks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three hints counted from our own POS sales — **Popular here**, **Goes well with** and **Most picked** — on the customer QR menu first and the counter's order screen second, with a manager's **Recommend on QR menu** switch filling them until sales are enough.

**Architecture:** One SQL function (`pos_compute_picks`) counts paid, non-voided, non-add-on items of one outlet into a small JSON payload; `pos_menu_picks_for` caches it per outlet for 30 minutes in `menu_picks_cache`; `qr_picks` (anon, by table token) and `pos_menu_picks` (staff, by `pos_my_branch()`) are the two entry points; `set_product_recommended` flips the switch and clears the cache. The client parses the payload once (`picks.ts`, pure) and only filters it to what the menu offers now; a failed read hides the hints and never blocks ordering.

**Tech Stack:** Supabase Postgres (plpgsql / sql functions, RLS), React 19 + TypeScript + Vite, Tailwind, Vitest + Testing Library (jsdom per file).

**Spec:** `docs/superpowers/specs/2026-11-17-menu-picks-design.md`

## Spec notes (gaps found, decisions taken — owner asleep, small decisions are ours)

1. **Volatility.** `qr_picks` and `pos_menu_picks` are **volatile** (the spec only calls `pos_compute_picks` stable): they may write the cache, and PostgREST runs a STABLE function in a read-only transaction, where the upsert would fail. `pos_compute_picks` stays stable; `pos_menu_picks_for` is volatile.
2. **Which clock.** Every window is measured on `bills.closed_at` (when the bill was paid). "≥ 30 paid bills in the window" = paid bills of the outlet closed in the last 30 days.
3. **Most picked: option → group.** `modifiers_snapshot` carries `optionId` and the group's *name* only. The group is taken from `modifier_options.group_id` by `optionId` (today's group). An option deleted since is not counted; the match is `o.id::text = m->>'optionId'`, so a malformed snapshot is skipped, never an error.
4. **Popular composition.** Recommended products first (by units at this outlet, then name), then — only with ≥ 30 paid bills — the top 6 *non-recommended* sellers with ≥ 3 units, cut at 8 in all. `is_recommended` is one flag per product for every outlet; the client drops what the outlet's menu does not offer.
5. **Goes well with.** Ties go by product name. Recommended products enter pairs only through the fallback (a real pair outranks a tick). The fallback is computed for every active non-add-on product with no qualifying pair, and left out when it is empty. "Another category" uses today's `category_id`; a product with no category counts as its own category.
6. **What is never counted:** add-on products (everywhere), voided items, bills not `paid` (open, voided, merged). Inactive products are left out of Popular and pairs (they cannot be ordered).
7. **Editor read.** `isRecommended` is added to `menu_product_extras` (the read behind the sections that save on their own: Photo, Time slots), not to `menu_product_detail` / `menu_save_product`. The switch is a new `RecommendSection` under Photo, shown once the product exists.
8. **`set_product_recommended`** uses `menu_require_editor()` (= `has_menu_cap('manage_menu')`, words "Not allowed to edit the menu"); an unknown product → "Product not found". It deletes every cache row with `where true` (pg-safeupdate).
9. **`menu_picks_cache.branch_id`** references `branches(id) on delete cascade`, so the cache never blocks removing an outlet.
10. **Client filters.** Sold-out products are left out of the Popular here row (so they carry no Popular pill), per spec §2's last bullet. The spec's `mostPickedOption(picks, productId, groupId)` becomes `mostPickedFor(picks, productId)` (the product's group → option map), which both sheets take as their `mostPicked` prop; the pill shows only on an available option. Added helpers: `parsePicks`, `offerPairs`, `MAX_PAIRS`, and a shared `PickPill` component.
11. **QR refresh.** Picks are read after `qr_menu`, then again inside the minute menu refresh when ≥ 10 minutes have passed. A failed first read leaves the hints hidden; a failed re-read keeps the last picks (still filtered to the live menu). "Once per product per visit" = per page load.
12. **QR Goes well with panel** is derived live from the cart and the menu: a card leaves once its product is in the cart, and the panel hides when no card is left. It closes on ✕, on any new line (replaced by the new product's panel, if that one is still unshown), and after Place order. Editing a line leaves it as it is.
13. **Counter chip row** shows after every new draft line (no once-per-visit rule at the counter), while that product is still among the drafts; never in sold-out mode or when the bill takes no new items; chips outside their time slot are left out. A tap uses the tile's own rule (direct add with one variant and no add-on groups, else the sheet) — the spec's "sheet if it has required options" read as "as from its tile". The counter reads picks once when the order screen opens.

## Global Constraints

- UI copy in English, exactly: "Popular here", "Popular", "Goes well with your <product>", "Most picked", "Recommend on QR menu", and the hint "Shown under Popular here, and suggested with other items, until sales are enough to choose by themselves." The counter chip row reads "Goes well with:" followed by the product names. Save outcome: "Saved".
- Thresholds (spec §2, verbatim, in **one** place — `pos_picks_rules()`): Popular from sales only when the branch has ≥ 30 paid bills in the window (30 days); top 6 by units, a product needs ≥ 3 units; max 8 in all. A pair Y for X needs Y in another category, ≥ 3 shared orders, and shared/orders(X) ≥ 10%; top 3 by shared orders (60 days). Most picked needs ≥ 10 units of the product with that group answered, and the top option ≥ 40% and strictly ahead of the next (60 days). Cache: at most every 30 minutes.
- Anon may call **only** `qr_picks`. Every new function is `security definer set search_path = public, pg_temp` with an explicit `revoke` / `grant`. `menu_picks_cache` has RLS on, no policy and no client privilege.
- Hints never block ordering: any failed read hides them; nothing waits on them.
- Nothing is pre-selected because of Most picked (guests must not pay for an option they did not choose). `defaultLine` is not changed.
- Every `UPDATE` / `DELETE` inside a function has a `WHERE` (pg-safeupdate; `src/features/pos/sqlSafeUpdate.test.ts` scans every `migration-*-(pos|menu)-*.sql`).
- SQL runs on **craft-os-dev only** (ref `egznnbjmicebbhwasloy`), through the owner's Chrome Supabase SQL editor, following `/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/61468934-8271-4d57-a865-7622f45e3055/scratchpad/dev-sql-howto.md`. Check the ref in the editor URL before every run. **Never** open or run anything on prod (`yfsoesxzurzjdwstszru`).
- Work only in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo` (branch `feature/pos-demo`); never `cd` to the main checkout. Other sessions commit to this branch at the same time: before each task run `git log --oneline -3` and `git status`; touch only the files your task lists; never run a bare `git stash`; `git add` only your own paths. Do not touch `docs/superpowers/plans/2026-11-17-pos-split-bill.md`.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## File map

| File | Change |
|---|---|
| `supabase/migration-2026-11-17-menu-picks.sql` | new: `is_recommended`, `menu_picks_cache`, `pos_picks_rules`, `pos_compute_picks`, `pos_menu_picks_for`, `qr_picks`, `pos_menu_picks`, `set_product_recommended`, `menu_product_extras` + `isRecommended` |
| `supabase/migration-2026-11-17-menu-picks-verify.sql` | new: sections A–E on a seeded outlet, hand-computed expectations |
| `src/features/pos/sqlSafeUpdate.test.ts` | one test pinning the new file's functions and grants |
| `src/features/pos/order/picks.ts` (+ `picks.test.ts`) | new, pure: `MenuPicks`, `parsePicks`, `visiblePopular`, `pairsFor`, `offerPairs`, `mostPickedFor`, `MAX_PAIRS` |
| `src/features/pos/order/PickPill.tsx` | new: the amber "Popular" / "Most picked" pill |
| `src/features/pos/order/LineSheet.tsx` (+ new `LineSheet.test.tsx`) | optional `mostPicked` prop → pill |
| `src/features/pos/order/ModifierSheet.tsx` (+ `ModifierSheet.test.tsx`) | optional `mostPicked` prop → pill |
| `src/qr/QrApp.tsx` | load picks, Popular here row + pills, Goes well with panel, sheet pill |
| `src/features/pos/menu/slotsApi.ts` | `ProductExtras.isRecommended`, `setProductRecommended` |
| `src/features/pos/menu/product/RecommendSection.tsx` (+ test) | new: the switch |
| `src/features/pos/menu/ProductEditorPage.tsx` | mounts `RecommendSection` |
| `src/features/pos/order/posApi.ts` | `fetchMenuPicks` |
| `src/features/pos/order/ProductTiles.tsx` (+ new `ProductTiles.test.tsx`) | `popular` prop → pill |
| `src/features/pos/order/BillColumn.tsx` (+ `BillColumn.test.tsx`) | `goesWell` chip row |
| `src/features/pos/order/OrderScreen.tsx` | picks read, pills, chip row, sheet pill |

---

### Task 1: Server — schema, picks functions, cache, entry points, editor read

**Files:**
- Create: `supabase/migration-2026-11-17-menu-picks.sql`
- Create: `supabase/migration-2026-11-17-menu-picks-verify.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (one new `it` inside `describe('pg-safeupdate guard: POS migrations')`)

**Interfaces:**
- Consumes (existing SQL): `pos_my_branch()` (caller's outlet; raises "Sign in required" etc.), `menu_require_editor()` (raises "Not allowed to edit the menu"), tables `bills`, `orders`, `order_items`, `menu_products`, `modifier_options`, `dining_tables`, `product_schedules`, `menu_schedules`.
- Produces:
  - `menu_products.is_recommended boolean not null default false`
  - `qr_picks(p_token text) returns jsonb` — anon + authenticated; null for an unknown, paused or inactive table.
  - `pos_menu_picks() returns jsonb` — authenticated.
  - `set_product_recommended(p_product_id uuid, p_on boolean) returns void` — authenticated, needs Edit menu.
  - `menu_product_extras(uuid)` now also returns `isRecommended: boolean`.
  - Payload (both reads): `{ "popular": [productId…], "pairs": { productId: [productId…] }, "mostPicked": { productId: { groupId: optionId } }, "fromSales": boolean }`.

- [ ] **Step 1: Write the migration**

Create `supabase/migration-2026-11-17-menu-picks.sql`:

```sql
-- ============================================================================
-- Craft OS — Menu picks (2026-11-17). Run on craft-os-dev after the POS chain
-- (migration-2026-10-30-pos-discounts.sql is the latest). Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-17-menu-picks.md
-- Design: docs/superpowers/specs/2026-11-17-menu-picks-design.md
--
-- P1  Schema: menu_products.is_recommended (the editor's "Recommend on QR menu");
--     menu_picks_cache, one row per outlet, read only through the functions below.
-- P2  pos_picks_rules: every threshold in one place. pos_compute_picks: Popular here,
--     Goes well with and Most picked of one outlet, counted from its paid bills.
-- P3  pos_menu_picks_for: the cached payload, computed again when older than 30 minutes.
--     qr_picks (anon, by table token) and pos_menu_picks (staff, by pos_my_branch()).
-- P4  set_product_recommended (Edit menu) clears every outlet's cache;
--     menu_product_extras returns isRecommended.
-- Re-run hazard: re-running migration-2026-10-24-pos-slots-photos-fn.sql puts back the old
-- menu_product_extras (no isRecommended) — re-run this file after it.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_my_branch()') is null or to_regprocedure('menu_require_editor()') is null
     or to_regprocedure('menu_product_extras(uuid)') is null then
    raise exception 'STOP: run the POS chain first (pos_my_branch, menu_require_editor or menu_product_extras is missing)';
  end if;
end $$;

-- ── P1. Schema ──────────────────────────────────────────────────────────────
alter table menu_products add column if not exists is_recommended boolean not null default false;

create table if not exists menu_picks_cache (
  branch_id    uuid primary key references branches(id) on delete cascade,
  computed_at  timestamptz not null,
  payload      jsonb not null
);
-- RLS on, no policies: read and written only through the functions below
alter table menu_picks_cache enable row level security;
revoke all on menu_picks_cache from public, anon, authenticated;

-- ── P2. The rules, in one place (spec §2) ───────────────────────────────────
create or replace function pos_picks_rules(
  out popular_days integer, out popular_min_bills integer, out popular_top integer, out popular_min_units integer,
  out popular_max integer,
  out pair_days integer, out pair_min_shared integer, out pair_min_share numeric, out pair_top integer,
  out picked_days integer, out picked_min_units integer, out picked_min_share numeric,
  out cache_minutes integer)
language sql immutable security definer set search_path = public, pg_temp as $$
  select 30, 30, 6, 3, 8,      -- Popular here: 30 days; from sales only with >= 30 paid bills; top 6 sellers with >= 3 units; at most 8 in all
         60, 3, 0.10, 3,       -- Goes well with: 60 days; another category, >= 3 shared orders and >= 10 % of the product's orders; top 3
         60, 10, 0.40,         -- Most picked: 60 days; >= 10 units with the group answered; top option >= 40 % and strictly ahead
         30                    -- the cache is computed again when older than 30 minutes
$$;
revoke all on function pos_picks_rules() from public, anon, authenticated;

-- The picks of one outlet. Counted: items of the outlet's PAID bills (bills.closed_at in the window),
-- not voided, of products that are not add-ons. Goes well with counts one guest's basket (an order),
-- not the whole bill.
create or replace function pos_compute_picks(p_branch uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  k          record;
  v_bills    integer;
  v_sales    boolean;
  v_popular  jsonb;
  v_pairs    jsonb;
  v_picked   jsonb;
begin
  select * into k from pos_picks_rules();

  -- ── Popular here: recommended products first, then (once sales are enough) the best sellers ──
  select count(*) into v_bills
    from bills b
   where b.branch_id = p_branch and b.status = 'paid'
     and b.closed_at > now() - make_interval(days => k.popular_days);
  v_sales := v_bills >= k.popular_min_bills;

  with sold as (
    select oi.product_id, sum(oi.qty)::integer as units
      from order_items oi
      join bills b on b.id = oi.bill_id
     where b.branch_id = p_branch and b.status = 'paid'
       and b.closed_at > now() - make_interval(days => k.popular_days)
       and oi.voided_at is null
     group by oi.product_id),
  candidates as (
    select p.id, p.name, p.is_recommended, coalesce(s.units, 0) as units
      from menu_products p
      left join sold s on s.product_id = p.id
     where p.is_active and not p.is_addon),
  best as (
    select c.id from candidates c
     where v_sales and not c.is_recommended and c.units >= k.popular_min_units
     order by c.units desc, c.name, c.id
     limit k.popular_top),
  chosen as (
    select c.* from candidates c
     where c.is_recommended or c.id in (select b.id from best b)
     order by c.is_recommended desc, c.units desc, c.name, c.id
     limit k.popular_max)
  select coalesce(jsonb_agg(c.id order by c.is_recommended desc, c.units desc, c.name, c.id), '[]'::jsonb)
    into v_popular
    from chosen c;

  -- ── Goes well with: products of another category in the same order ──
  with baskets as (                                   -- one row per order and product
    select distinct oi.order_id, p.id as product_id, p.category_id
      from order_items oi
      join bills b on b.id = oi.bill_id
      join menu_products p on p.id = oi.product_id and p.is_active and not p.is_addon
     where b.branch_id = p_branch and b.status = 'paid'
       and b.closed_at > now() - make_interval(days => k.pair_days)
       and oi.voided_at is null),
  orders_of as (
    select product_id, count(*) as n from baskets group by product_id),
  together as (
    select x.product_id as a, y.product_id as b, count(*) as shared
      from baskets x
      join baskets y on y.order_id = x.order_id and y.product_id <> x.product_id
                    and y.category_id is distinct from x.category_id
     group by x.product_id, y.product_id),
  ranked as (
    select t.a, t.b, row_number() over (partition by t.a order by t.shared desc, p.name, p.id) as rk
      from together t
      join orders_of o on o.product_id = t.a
      join menu_products p on p.id = t.b
     where t.shared >= k.pair_min_shared
       and t.shared::numeric / o.n >= k.pair_min_share)
  select coalesce(jsonb_object_agg(r.a, r.ids), '{}'::jsonb) into v_pairs
    from (select a, jsonb_agg(b order by rk) as ids from ranked where rk <= k.pair_top group by a) r;

  -- a product with no pair of its own: the popular list without its own category
  select v_pairs || coalesce(jsonb_object_agg(p.id, f.ids), '{}'::jsonb) into v_pairs
    from menu_products p
    cross join lateral (
      select jsonb_agg(x.id order by x.ord) as ids
        from (select pop.id, pop.ord
                from jsonb_array_elements_text(v_popular) with ordinality as pop(id, ord)
                join menu_products q on q.id = pop.id::uuid
               where q.category_id is distinct from p.category_id
               order by pop.ord
               limit k.pair_top) x) f
   where p.is_active and not p.is_addon
     and not (v_pairs ? p.id::text)
     and f.ids is not null;

  -- ── Most picked: per product and add-on group, the option most guests choose ──
  with items as (
    select oi.id, oi.product_id, oi.qty, oi.modifiers_snapshot
      from order_items oi
      join bills b on b.id = oi.bill_id
      join menu_products p on p.id = oi.product_id and not p.is_addon
     where b.branch_id = p_branch and b.status = 'paid'
       and b.closed_at > now() - make_interval(days => k.picked_days)
       and oi.voided_at is null),
  chosen as (                                         -- one row per item and option chosen; the group by the option's id
    select distinct i.id as item_id, i.product_id, i.qty, o.group_id, o.id as option_id
      from items i
      cross join jsonb_array_elements(i.modifiers_snapshot) m
      join modifier_options o on o.id::text = m->>'optionId'),
  answered as (                                       -- units of the product with the group answered
    select d.product_id, d.group_id, sum(d.qty) as units
      from (select distinct item_id, product_id, group_id, qty from chosen) d
     group by d.product_id, d.group_id),
  per_option as (
    select product_id, group_id, option_id, sum(qty) as units,
           row_number() over w as rk,
           lead(sum(qty)) over w as next_units
      from chosen
     group by product_id, group_id, option_id
    window w as (partition by product_id, group_id order by sum(qty) desc, option_id)),
  winners as (
    select po.product_id, po.group_id, po.option_id
      from per_option po
      join answered a on a.product_id = po.product_id and a.group_id = po.group_id
     where po.rk = 1
       and a.units >= k.picked_min_units
       and po.units::numeric / a.units >= k.picked_min_share
       and po.units > coalesce(po.next_units, 0))
  select coalesce(jsonb_object_agg(w.product_id, w.groups), '{}'::jsonb) into v_picked
    from (select product_id, jsonb_object_agg(group_id, option_id) as groups
            from winners group by product_id) w;

  return jsonb_build_object('popular', v_popular, 'pairs', v_pairs, 'mostPicked', v_picked, 'fromSales', v_sales);
end $$;
revoke all on function pos_compute_picks(uuid) from public, anon, authenticated;

-- ── P3. The cache and the two reads ─────────────────────────────────────────
-- The outlet's cached payload while it is younger than the rule; else computed, stored, returned.
-- Volatile: it writes the cache.
create or replace function pos_menu_picks_for(p_branch uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_payload jsonb;
begin
  select c.payload into v_payload
    from menu_picks_cache c
   where c.branch_id = p_branch
     and c.computed_at > now() - make_interval(mins => (select r.cache_minutes from pos_picks_rules() r));
  if found then
    return v_payload;
  end if;
  v_payload := pos_compute_picks(p_branch);
  insert into menu_picks_cache(branch_id, computed_at, payload) values (p_branch, now(), v_payload)
  on conflict (branch_id) do update set computed_at = excluded.computed_at, payload = excluded.payload;
  return v_payload;
end $$;
revoke all on function pos_menu_picks_for(uuid) from public, anon, authenticated;

-- The customer's QR page: the picks of the table's outlet. Null for an unknown, paused or
-- switched-off table. Volatile (not stable): PostgREST runs stable functions read-only.
create or replace function qr_picks(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid;
begin
  select t.branch_id into v_branch
    from dining_tables t
   where t.qr_token = p_token and t.is_active and not t.qr_paused;
  if v_branch is null then
    return null;
  end if;
  return pos_menu_picks_for(v_branch);
end $$;
revoke all on function qr_picks(text) from public;
grant execute on function qr_picks(text) to anon, authenticated;

-- The counter: the picks of the caller's outlet.
create or replace function pos_menu_picks() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return pos_menu_picks_for(pos_my_branch());
end $$;
revoke all on function pos_menu_picks() from public, anon;
grant execute on function pos_menu_picks() to authenticated;

-- ── P4. The editor's switch and its read ────────────────────────────────────
create or replace function set_product_recommended(p_product_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  update menu_products set is_recommended = p_on where id = p_product_id;
  if not found then
    raise exception 'Product not found';
  end if;
  delete from menu_picks_cache where true;           -- every outlet computes again on its next read
end $$;
revoke all on function set_product_recommended(uuid, boolean) from public, anon;
grant execute on function set_product_recommended(uuid, boolean) to authenticated;

-- The product editor's sections that save on their own (Photo, Time slots, Recommend). The live
-- text of migration-2026-10-24-pos-slots-photos-fn.sql with isRecommended added.
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
                                     where ps.product_id = p.id), '[]'::jsonb),
           'isRecommended', p.is_recommended)                                          -- picks
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

notify pgrst, 'reload schema';
select 'menu picks applied' as result;
```

- [ ] **Step 2: Pin the file in the pg-safeupdate guard test**

In `src/features/pos/sqlSafeUpdate.test.ts`, inside `describe('pg-safeupdate guard: POS migrations', () => { … })`, after the last existing `it(…)` of that describe, add:

```ts
  it('scans the menu picks: its functions, anon only on qr_picks, internal functions closed, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-11-17-menu-picks.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual([
      'pos_picks_rules', 'pos_compute_picks', 'pos_menu_picks_for', 'qr_picks', 'pos_menu_picks',
      'set_product_recommended', 'menu_product_extras',
    ])
    expect([...sql.matchAll(/grant execute on function (\w+)\([^)]*\) to anon/g)].map((m) => m[1])).toEqual(['qr_picks'])
    expect(sql).toMatch(/revoke all on function pos_picks_rules\(\) from public, anon, authenticated;/)
    expect(sql).toMatch(/revoke all on function pos_compute_picks\(uuid\) from public, anon, authenticated;/)
    expect(sql).toMatch(/revoke all on function pos_menu_picks_for\(uuid\) from public, anon, authenticated;/)
    expect(sql).toMatch(/revoke all on menu_picks_cache from public, anon, authenticated;/)
    expect(sql).toMatch(/raise exception 'STOP: /)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
  })
```

- [ ] **Step 3: Run the guard test**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS — the new file is picked up by `POS_MIGRATION` (`migration-2026-11-17-menu-picks.sql` matches `-(pos|menu)-`), its `UPDATE` / `DELETE` all have a `WHERE`, and the new `it` passes.

- [ ] **Step 4: Write the verify**

Create `supabase/migration-2026-11-17-menu-picks-verify.sql`:

```sql
-- Self-check for menu picks. Run on craft-os-dev after migration-2026-11-17-menu-picks.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections: A schema and grants; B the rules; C cold start (recommended only) and the editor
-- switch; D picks from sales; E the cache and the three entry points.
--
-- The seed: outlet VERIFY P (tables P1 open, P2 paused, P3 switched off), products coded by one letter:
--   COFFEE  L Latte · M Mocha · A Americano · T Tea (recommended) · X Matcha (recommended, never sold)
--           H Shot (an add-on product)
--   CAKE    C Cheesecake · B Brownie
--   BREAD   R Croissant · G Bagel (recommended) · S Scone
--   groups  MILK (oat, dairy, soy) · SUGAR (less, normal) · TOPPING (berry, choco, plain, caramel)
-- A line is 'CODE[*qty][:opt[+opt]][!]' — '!' = voided. One inner array = one order; one call = one bill.
--
-- Expected, worked by hand (paid bills of VERIFY P, items not voided, add-ons left out):
--   units, last 30 days: L 40 · C 15 · M 12 · R 9 · A 7 · B 6 · T 4 · G 3 · S 3 · X 0
--   Popular: the recommended by units T G X, then the top 6 sellers L C M R A B, cut at 8
--            → T G X L C M R A   (S out by the top 6, B out by the 8)
--   orders (one guest's basket), last 60 days: L 32 · C 15 · R 9 · M 8 · B 7 · A 5 · G 3 · S 3 · T 2
--   pairs:  L → C R    (C 10, R 6; M is the same category; B 2 shared < 3; S 3/32 < 10 %)
--           A → C B G  (C 5, B 4, R 3, G 3: top 3, the tie goes by name — Bagel before Croissant)
--           C → L A G  · B → A G R · R → L A B · G → A B C · S → L (3/3 >= 10 %)
--           M, T, X → G C R (no pair of their own: Popular without COFFEE, first 3)
--   Most picked, last 60 days: L MILK oat 18/40 = 45 %, ahead of dairy 14 → oat
--           L SUGAR 6 units answered (< 10) → none · M MILK oat 6, dairy 6 (a tie) → none
--           C TOPPING berry 5/15 = 33 % (< 40 %) → none
--   Noise that must not count: a voided L*5:dairy and B*20, an add-on H*20, an open bill (C*20 C*20),
--   a voided bill (T*10), a merged bill (S*20), a paid bill 45 days ago (B*10 — in the 60-day windows
--   only), one 90 days ago (M*20:dairy C), and outlet VERIFY P2 (29 bills of R, 1 of S*2).
--   Orders of one bill must not pair: bills hold M with C orders (m1|c1 …) — a bill grain would give M → C.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message using errcode = 'assert_failure';
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(user id): the next calls run as this signed-in user
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create temp table vp_codes (code text primary key, product_id uuid not null);
create temp table vp_opts  (code text primary key, option_id uuid not null);

-- ids('T G X') → those products' ids as a jsonb array of text, in that order
create function pg_temp.ids(p_codes text) returns jsonb language sql as $$
  select coalesce(jsonb_agg(c.product_id::text order by x.ord), '[]'::jsonb)
    from unnest(string_to_array(p_codes, ' ')) with ordinality as x(code, ord)
    join vp_codes c on c.code = x.code
$$;
-- codes(array) → 'T G X' (a product outside the seed shows as ?), for the failure messages
create function pg_temp.codes(p jsonb) returns text language sql as $$
  select coalesce(string_agg(coalesce(c.code, '?'), ' ' order by x.ord), '')
    from jsonb_array_elements_text(coalesce(p, '[]'::jsonb)) with ordinality as x(id, ord)
    left join vp_codes c on c.product_id::text = x.id
$$;
create function pg_temp.pid(p_code text) returns text language sql as $$
  select product_id::text from vp_codes where code = p_code
$$;
-- list(label, got, 'T G X'): got must be exactly those products, in that order
create function pg_temp.list(p_label text, p_got jsonb, p_want text) returns void language plpgsql as $$
begin
  if p_got is distinct from pg_temp.ids(p_want) then
    raise exception 'FAIL %: got [%] (expected [%])', p_label, pg_temp.codes(p_got), p_want;
  end if;
end $$;

-- sell(outlet, status, days ago, orders): one bill closed p_days ago (open bills: not closed), one
-- order per inner array, one item per line 'CODE[*qty][:opt[+opt]][!]'
create function pg_temp.sell(p_branch uuid, p_status text, p_days integer, p_orders jsonb) returns uuid
language plpgsql as $$
declare
  v_bill uuid; v_order uuid; o jsonb; l text; m text[]; v_k integer := 0;
  v_at timestamptz := now() - make_interval(days => p_days);
begin
  insert into bills(branch_id, bill_no, order_type, status, opened_at, closed_at)
  values (p_branch, 'VP-' || substr(md5(random()::text), 1, 10), 'takeaway', p_status, v_at,
          case when p_status = 'open' then null else v_at end)
  returning id into v_bill;
  for o in select * from jsonb_array_elements(p_orders) loop
    v_k := v_k + 1;
    insert into orders(bill_id, branch_id, order_no, source, client_order_id, placed_at)
    values (v_bill, p_branch, v_k::text, 'counter', gen_random_uuid(), v_at)
    returning id into v_order;
    for l in select * from jsonb_array_elements_text(o) loop
      m := regexp_match(l, '^([A-Z])(?:\*(\d+))?(?::([a-z+]+))?(!)?$');
      if m is null then raise exception 'seed: bad line %', l; end if;
      if m[3] is not null and exists (select 1 from unnest(string_to_array(m[3], '+')) n(code)
                                       where not exists (select 1 from vp_opts vo where vo.code = n.code)) then
        raise exception 'seed: unknown option in %', l;
      end if;
      insert into order_items(order_id, bill_id, product_id, name_snapshot, unit_price_sen, sst_rate_bp, qty,
                              modifiers_snapshot, voided_at)
      select v_order, v_bill, c.product_id, c.code, 1000, 0, coalesce(m[2]::integer, 1),
             coalesce((select jsonb_agg(jsonb_build_object('optionId', vo.option_id, 'group', 'seed', 'name', vo.code,
                                                           'priceDeltaSen', 0, 'route', null) order by n.ord)
                         from unnest(string_to_array(m[3], '+')) with ordinality as n(code, ord)
                         join vp_opts vo on vo.code = n.code), '[]'::jsonb),
             case when m[4] = '!' then now() end
        from vp_codes c where c.code = m[1];
      if not found then raise exception 'seed: unknown product %', m[1]; end if;
    end loop;
  end loop;
  return v_bill;
end $$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_staff uuid := 'eeeeeeee-0000-0000-0000-0000000000b1';   -- a staff login of VERIFY P, without Edit menu
  v_v uuid; v_p2 uuid; v_tok1 text; v_tok2 text; v_tok3 text;
  v_coffee uuid; v_cake uuid; v_bread uuid; v_milk uuid; v_sugar uuid; v_top uuid; v_id uuid;
  k record; r record; v jsonb; i integer;
begin
  -- ── A. schema and grants ──────────────────────────────────────────────────
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_products' and column_name = 'is_recommended'
                    and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false') then
    raise exception 'FAIL schema: menu_products.is_recommended (boolean not null default false) is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.menu_picks_cache'::regclass)
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'menu_picks_cache')
     or has_table_privilege('anon', 'public.menu_picks_cache', 'select')
     or has_table_privilege('authenticated', 'public.menu_picks_cache', 'select')
     or has_table_privilege('authenticated', 'public.menu_picks_cache', 'insert') then
    raise exception 'FAIL rls: menu_picks_cache must have RLS on, no policy and no client privilege';
  end if;
  for r in select * from (values
      ('pos_picks_rules()', false, false),
      ('pos_compute_picks(uuid)', false, false),
      ('pos_menu_picks_for(uuid)', false, false),
      ('qr_picks(text)', true, true),
      ('pos_menu_picks()', false, true),
      ('set_product_recommended(uuid,boolean)', false, true),
      ('menu_product_extras(uuid)', false, true)) as x(fn, anon_ok, auth_ok) loop
    if has_function_privilege('anon', r.fn, 'execute') <> r.anon_ok
       or has_function_privilege('authenticated', r.fn, 'execute') <> r.auth_ok then
      raise exception 'FAIL grants: % (anon %, authenticated %)', r.fn,
        has_function_privilege('anon', r.fn, 'execute'), has_function_privilege('authenticated', r.fn, 'execute');
    end if;
  end loop;
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('pos_picks_rules', 'pos_compute_picks', 'pos_menu_picks_for', 'qr_picks', 'pos_menu_picks', 'set_product_recommended')
         and p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) <> 6 then
    raise exception 'FAIL functions: each picks function must exist once, security definer, search_path = public, pg_temp';
  end if;
  if (select provolatile from pg_proc where oid = 'qr_picks(text)'::regprocedure) <> 'v'
     or (select provolatile from pg_proc where oid = 'pos_menu_picks()'::regprocedure) <> 'v' then
    raise exception 'FAIL volatility: qr_picks and pos_menu_picks write the cache, so they must be volatile';
  end if;

  -- ── B. the rules (spec §2) ────────────────────────────────────────────────
  select * into k from pos_picks_rules();
  if (k.popular_days, k.popular_min_bills, k.popular_top, k.popular_min_units, k.popular_max,
      k.pair_days, k.pair_min_shared, k.pair_min_share, k.pair_top,
      k.picked_days, k.picked_min_units, k.picked_min_share, k.cache_minutes)
     is distinct from (30, 30, 6, 3, 8, 60, 3, 0.10, 3, 60, 10, 0.40, 30) then
    raise exception 'FAIL rules: %', row_to_json(k);
  end if;

  -- ── fixture ───────────────────────────────────────────────────────────────
  update system_role_permissions set permissions = permissions - 'manage_menu' where true;   -- code defaults: owner yes, staff no
  update menu_products set is_recommended = false where is_recommended;                     -- dev's own ticks would join Popular
  insert into branches(name, address) values ('VERIFY P', 'p') returning id into v_v;
  insert into branches(name, address) values ('VERIFY P2', 'p2') returning id into v_p2;
  insert into dining_tables(branch_id, label) values (v_v, 'P1') returning qr_token into v_tok1;
  insert into dining_tables(branch_id, label, qr_paused) values (v_v, 'P2', true) returning qr_token into v_tok2;
  insert into dining_tables(branch_id, label, is_active) values (v_v, 'P3', false) returning qr_token into v_tok3;
  insert into menu_categories(name, sort_order) values ('VP COFFEE', 901) returning id into v_coffee;
  insert into menu_categories(name, sort_order) values ('VP CAKE', 902) returning id into v_cake;
  insert into menu_categories(name, sort_order) values ('VP BREAD', 903) returning id into v_bread;
  for r in select * from (values
      ('L', 'VP Latte', 'coffee', false), ('M', 'VP Mocha', 'coffee', false), ('A', 'VP Americano', 'coffee', false),
      ('T', 'VP Tea', 'coffee', false), ('X', 'VP Matcha', 'coffee', false), ('H', 'VP Shot', 'coffee', true),
      ('C', 'VP Cheesecake', 'cake', false), ('B', 'VP Brownie', 'cake', false),
      ('R', 'VP Croissant', 'bread', false), ('G', 'VP Bagel', 'bread', false), ('S', 'VP Scone', 'bread', false)
    ) as x(code, name, cat, addon) loop
    insert into menu_products(name, category_id, is_addon)
    values (r.name, case r.cat when 'coffee' then v_coffee when 'cake' then v_cake else v_bread end, r.addon)
    returning id into v_id;
    insert into vp_codes values (r.code, v_id);
  end loop;
  insert into modifier_groups(name, min_select, max_select) values ('VP MILK', 1, 1) returning id into v_milk;
  insert into modifier_groups(name, min_select, max_select) values ('VP SUGAR', 0, 1) returning id into v_sugar;
  insert into modifier_groups(name, min_select, max_select) values ('VP TOPPING', 0, 1) returning id into v_top;
  for r in select * from (values ('oat', 'milk'), ('dairy', 'milk'), ('soy', 'milk'), ('less', 'sugar'), ('normal', 'sugar'),
                                  ('berry', 'top'), ('choco', 'top'), ('plain', 'top'), ('caramel', 'top')) as x(code, grp) loop
    insert into modifier_options(group_id, name)
    values (case r.grp when 'milk' then v_milk when 'sugar' then v_sugar else v_top end, r.code)
    returning id into v_id;
    insert into vp_opts values (r.code, v_id);
  end loop;
  update staff set branch_id = v_v where id = v_owner;
  insert into auth.users (id) values (v_staff);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id)
  values (v_staff, 'Verify P Staff', 'trainee', true, current_date, 'staff', v_v);

  -- ── C. cold start: only what a manager recommends; the switch ─────────────
  delete from menu_picks_cache where true;
  insert into menu_picks_cache(branch_id, computed_at, payload) values (v_p2, now(), '{"marker": "P2"}');
  perform pg_temp.act(v_staff);
  perform pg_temp.expect_error(format('select set_product_recommended(%L, true)', pg_temp.pid('T')),
    'Not allowed to edit the menu', 'C staff without Edit menu');
  perform pg_temp.act(v_owner);
  perform pg_temp.expect_error(format('select set_product_recommended(%L, true)', gen_random_uuid()),
    'Product not found', 'C unknown product');
  perform set_product_recommended(pg_temp.pid('T')::uuid, true);
  perform set_product_recommended(pg_temp.pid('G')::uuid, true);
  perform set_product_recommended(pg_temp.pid('X')::uuid, true);
  if exists (select 1 from menu_picks_cache) then
    raise exception 'FAIL C: set_product_recommended must clear every outlet''s cache row';
  end if;
  if (menu_product_extras(pg_temp.pid('G')::uuid)->>'isRecommended') is distinct from 'true'
     or (menu_product_extras(pg_temp.pid('L')::uuid)->>'isRecommended') is distinct from 'false' then
    raise exception 'FAIL C: menu_product_extras must return isRecommended';
  end if;
  v := pos_compute_picks(v_v);
  if (v->'fromSales') is distinct from 'false'::jsonb then raise exception 'FAIL C fromSales: %', v->'fromSales'; end if;
  perform pg_temp.list('C popular (no sales: the recommended, by name)', v->'popular', 'G X T');
  perform pg_temp.list('C pairs of L (COFFEE): fallback', (v->'pairs')->pg_temp.pid('L'), 'G');
  perform pg_temp.list('C pairs of C (CAKE): fallback', (v->'pairs')->pg_temp.pid('C'), 'G X T');
  perform pg_temp.list('C pairs of G (BREAD): fallback', (v->'pairs')->pg_temp.pid('G'), 'X T');
  if (v->'pairs') ? pg_temp.pid('H') then raise exception 'FAIL C: an add-on product gets no pairs'; end if;
  if (v->'mostPicked') is distinct from '{}'::jsonb then raise exception 'FAIL C mostPicked: %', v->'mostPicked'; end if;

  -- ── D. picks from sales ───────────────────────────────────────────────────
  -- noise first: none of it may count anywhere (see the header)
  perform pg_temp.sell(v_v, 'open',    1, '[["C*20","C*20"]]');
  perform pg_temp.sell(v_v, 'voided',  1, '[["T*10"]]');
  perform pg_temp.sell(v_v, 'merged',  1, '[["S*20"]]');
  perform pg_temp.sell(v_v, 'paid',   45, '[["B*10"]]');
  perform pg_temp.sell(v_v, 'paid',   90, '[["M*20:dairy","C"]]');
  for i in 1..29 loop perform pg_temp.sell(v_p2, 'paid', 1, '[["R"]]'); end loop;
  perform pg_temp.sell(v_p2, 'paid', 1, '[["S*2"]]');
  -- the five A bills
  perform pg_temp.sell(v_v, 'paid', 1, '[["A*2","C:berry","B","R","G"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["A*2","C:berry","B","R","G"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["A","C:berry","B","R","G"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["A","C:choco","B"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["A","C:choco"]]');
  -- nine bills of two orders each (the second order never pairs with the first)
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","M*2:oat"],["L*2:oat","C:berry"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","M*2:oat"],["L*2:oat","C:berry"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","M:oat"],["L*2:oat","C:choco"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","M:oat"],["L*2:dairy","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","M*2:dairy"],["L*2:dairy","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","M*2:dairy"],["L*2:dairy","B"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["T*2"],["L*2:soy","S"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["T*2"],["L:dairy+less"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","M:dairy"],["L:oat+normal","C:choco"]]');
  -- fifteen bills of one order
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","M:dairy"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat+normal","C:plain"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","C:plain"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","C:plain"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","C:caramel"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","C:caramel"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","C:caramel"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","B"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","S"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","S"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L*2:oat+less","L*5:dairy!","H*20","B*20!"]]');
  -- 29 paid bills in the last 30 days (the 45- and 90-day ones are older): Popular is still the recommended only
  v := pos_compute_picks(v_v);
  if (v->'fromSales') is distinct from 'false'::jsonb then raise exception 'FAIL D: 29 paid bills are not enough: %', v->'fromSales'; end if;
  perform pg_temp.list('D popular at 29 bills (the recommended, by units)', v->'popular', 'T G X');
  -- the 30th
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy+less"]]');
  v := pos_compute_picks(v_v);
  if (v->'fromSales') is distinct from 'true'::jsonb then raise exception 'FAIL D: 30 paid bills are enough: %', v->'fromSales'; end if;
  perform pg_temp.list('D popular', v->'popular', 'T G X L C M R A');
  perform pg_temp.list('D pairs of L', (v->'pairs')->pg_temp.pid('L'), 'C R');
  perform pg_temp.list('D pairs of A', (v->'pairs')->pg_temp.pid('A'), 'C B G');
  perform pg_temp.list('D pairs of C', (v->'pairs')->pg_temp.pid('C'), 'L A G');
  perform pg_temp.list('D pairs of B', (v->'pairs')->pg_temp.pid('B'), 'A G R');
  perform pg_temp.list('D pairs of R', (v->'pairs')->pg_temp.pid('R'), 'L A B');
  perform pg_temp.list('D pairs of G', (v->'pairs')->pg_temp.pid('G'), 'A B C');
  perform pg_temp.list('D pairs of S', (v->'pairs')->pg_temp.pid('S'), 'L');
  perform pg_temp.list('D pairs of M (fallback)', (v->'pairs')->pg_temp.pid('M'), 'G C R');
  perform pg_temp.list('D pairs of T (fallback)', (v->'pairs')->pg_temp.pid('T'), 'G C R');
  perform pg_temp.list('D pairs of X (fallback)', (v->'pairs')->pg_temp.pid('X'), 'G C R');
  if (v->'pairs') ? pg_temp.pid('H') then raise exception 'FAIL D: an add-on product gets no pairs'; end if;
  if (v->'mostPicked') is distinct from jsonb_build_object(pg_temp.pid('L'),
       jsonb_build_object(v_milk::text, (select option_id::text from vp_opts where code = 'oat'))) then
    raise exception 'FAIL D mostPicked: % (expected only L MILK → oat)', v->'mostPicked';
  end if;
  v := pos_compute_picks(v_p2);
  if (v->'fromSales') is distinct from 'true'::jsonb then raise exception 'FAIL D: VERIFY P2 has 30 paid bills'; end if;
  perform pg_temp.list('D popular of VERIFY P2 (S has 2 units < 3)', v->'popular', 'G X T R');

  -- ── E. the cache and the three entry points ───────────────────────────────
  delete from menu_picks_cache where true;
  v := qr_picks(v_tok1);
  if v is distinct from pos_compute_picks(v_v) then raise exception 'FAIL E: qr_picks must return the table''s outlet''s picks'; end if;
  if not exists (select 1 from menu_picks_cache where branch_id = v_v and computed_at = now() and payload = v) then
    raise exception 'FAIL E: the first read must store the cache';
  end if;
  update menu_picks_cache set payload = '{"marker": "cached"}' where branch_id = v_v;
  if qr_picks(v_tok1) is distinct from '{"marker": "cached"}'::jsonb then
    raise exception 'FAIL E: a cache younger than 30 minutes must be reused';
  end if;
  perform pg_temp.act(v_owner);
  if pos_menu_picks() is distinct from '{"marker": "cached"}'::jsonb then
    raise exception 'FAIL E: pos_menu_picks must read the caller''s outlet (VERIFY P) through the cache';
  end if;
  update menu_picks_cache set computed_at = now() - interval '31 minutes' where branch_id = v_v;
  if qr_picks(v_tok1) is distinct from pos_compute_picks(v_v)
     or (select payload from menu_picks_cache where branch_id = v_v) is distinct from pos_compute_picks(v_v) then
    raise exception 'FAIL E: a cache older than 30 minutes must be computed again and stored';
  end if;
  update menu_picks_cache set payload = '{"marker": "cached"}' where branch_id = v_v;
  perform set_product_recommended(pg_temp.pid('S')::uuid, true);
  v := pos_menu_picks();
  perform pg_temp.list('E popular after recommending S (recomputed)', v->'popular', 'T G S X L C M R');
  if qr_picks('no-such-token') is not null then raise exception 'FAIL E: an unknown token gives null'; end if;
  if qr_picks(v_tok2) is not null then raise exception 'FAIL E: a paused table gives null'; end if;
  if qr_picks(v_tok3) is not null then raise exception 'FAIL E: a switched-off table gives null'; end if;
  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 5: Apply the migration on craft-os-dev**

Follow `/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/61468934-8271-4d57-a865-7622f45e3055/scratchpad/dev-sql-howto.md` (Chrome tab on `https://supabase.com/dashboard/project/egznnbjmicebbhwasloy/sql/new`; check the URL holds `egznnbjmicebbhwasloy`, stop if it shows `yfsoesxzurzjdwstszru`). Build the setValue call with:

```bash
python3 -c 'import json,sys;print("window.monaco.editor.getModels()[0].setValue("+json.dumps(open(sys.argv[1]).read())+");\"ok\"")' supabase/migration-2026-11-17-menu-picks.sql
```

Run it (a "Potential issue detected" or "destructive operation" dialog: confirm the run — the file enables RLS itself).
Expected result row: `menu picks applied`.

- [ ] **Step 6: Run the verify on craft-os-dev**

Same procedure with `supabase/migration-2026-11-17-menu-picks-verify.sql`.
Expected: one result row `VERIFY OK`. A `FAIL …` error names the check (lists print product codes, e.g. `got [T G X L C M B R]`); fix the migration, re-run Step 5, then this step.

- [ ] **Step 7: Commit**

```bash
git add supabase/migration-2026-11-17-menu-picks.sql supabase/migration-2026-11-17-menu-picks-verify.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "feat(db): menu picks — Popular here, Goes well with, Most picked per outlet, cached; Recommend switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `picks.ts` pure module and the pill

**Files:**
- Create: `src/features/pos/order/picks.ts`
- Create: `src/features/pos/order/picks.test.ts`
- Create: `src/features/pos/order/PickPill.tsx`

**Interfaces:**
- Consumes: `findProduct`, `OrderLine`, `PosMenu`, `PosProduct` from `src/features/pos/order/cart.ts`.
- Produces (used by Tasks 3, 4, 6):
  - `interface MenuPicks { popular: string[]; pairs: Record<string, string[]>; mostPicked: Record<string, Record<string, string>>; fromSales: boolean }`
  - `const MAX_PAIRS = 3`
  - `parsePicks(data: unknown): MenuPicks | null`
  - `visiblePopular(menu: PosMenu, picks: MenuPicks | null): PosProduct[]`
  - `pairsFor(menu: PosMenu, picks: MenuPicks | null, productId: string, cart: readonly OrderLine[]): PosProduct[]`
  - `offerPairs(menu: PosMenu, picks: MenuPicks | null, productId: string, cart: readonly OrderLine[], shown: ReadonlySet<string>): boolean`
  - `mostPickedFor(picks: MenuPicks | null, productId: string): Readonly<Record<string, string>> | undefined`
  - `PickPill` default export: `({ text }: { text: 'Popular' | 'Most picked' }) => JSX.Element`

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/order/picks.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MAX_PAIRS, mostPickedFor, offerPairs, pairsFor, parsePicks, visiblePopular, type MenuPicks } from './picks'
import type { OrderLine, PosMenu, PosProduct } from './cart'

const product = (id: string, extra: Partial<PosProduct> = {}): PosProduct => ({
  id, name: id.toUpperCase(), description: null, soldOut: false,
  variants: [{ id: `${id}-v`, name: 'Regular', priceSen: 1000, isBase: true }], groups: [], ...extra,
})
const menu: PosMenu = {
  categories: [
    { name: 'COFFEE', products: [product('latte'), product('mocha')] },
    { name: 'CAKE', products: [product('cake'), product('brownie', { soldOut: true }), product('tart', { variants: [] })] },
    { name: 'BREAD', products: [product('croissant'), product('bagel'), product('scone')] },
  ],
}
const picks: MenuPicks = {
  popular: ['gone', 'cake', 'brownie', 'latte', 'tart', 'croissant'],
  pairs: { latte: ['brownie', 'cake', 'gone', 'latte', 'croissant', 'bagel', 'scone'], mocha: [] },
  mostPicked: { latte: { milk: 'oat' } },
  fromSales: true,
}
const line = (productId: string): OrderLine => ({ productId, variantId: `${productId}-v`, qty: 1, note: null, optionIds: [] })

describe('parsePicks', () => {
  it('reads the server payload', () => {
    expect(parsePicks(picks)).toEqual(picks)
  })
  it('null (an unknown table), text or a half payload is no picks', () => {
    expect(parsePicks(null)).toBeNull()
    expect(parsePicks('nope')).toBeNull()
    expect(parsePicks({ popular: [] })).toBeNull()
  })
  it('drops what is not an id and reads a missing fromSales as false', () => {
    expect(parsePicks({ popular: ['a', 3, null], pairs: { a: ['b', 4], c: 'x' }, mostPicked: { a: { g: 'o', h: 5 }, b: 'x' } }))
      .toEqual({ popular: ['a'], pairs: { a: ['b'], c: [] }, mostPicked: { a: { g: 'o' } }, fromSales: false })
  })
})

describe('visiblePopular', () => {
  it('keeps the server order and only what the menu offers now', () => {
    // gone: not on this menu (catalog or time slot) · brownie: sold out · tart: no price in this catalog
    expect(visiblePopular(menu, picks).map((p) => p.id)).toEqual(['cake', 'latte', 'croissant'])
  })
  it('no picks, no row', () => {
    expect(visiblePopular(menu, null)).toEqual([])
  })
})

describe('pairsFor', () => {
  it('leaves out what is not offered, sold out, in the cart or the product itself, and keeps at most 3', () => {
    expect(pairsFor(menu, picks, 'latte', []).map((p) => p.id)).toEqual(['cake', 'croissant', 'bagel'])
    expect(pairsFor(menu, picks, 'latte', [line('latte'), line('cake')]).map((p) => p.id)).toEqual(['croissant', 'bagel', 'scone'])
    expect(MAX_PAIRS).toBe(3)
  })
  it('a product without pairs, or no picks, gives nothing', () => {
    expect(pairsFor(menu, picks, 'mocha', [])).toEqual([])
    expect(pairsFor(menu, picks, 'scone', [])).toEqual([])
    expect(pairsFor(menu, null, 'latte', [])).toEqual([])
  })
})

describe('offerPairs', () => {
  it('once per product per visit, and only with something to show', () => {
    expect(offerPairs(menu, picks, 'latte', [line('latte')], new Set())).toBe(true)
    expect(offerPairs(menu, picks, 'latte', [line('latte')], new Set(['latte']))).toBe(false)
    expect(offerPairs(menu, picks, 'mocha', [line('mocha')], new Set())).toBe(false)
  })
})

describe('mostPickedFor', () => {
  it("the product's group → option map, or nothing", () => {
    expect(mostPickedFor(picks, 'latte')).toEqual({ milk: 'oat' })
    expect(mostPickedFor(picks, 'mocha')).toBeUndefined()
    expect(mostPickedFor(null, 'latte')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/features/pos/order/picks.test.ts`
Expected: FAIL — `Failed to resolve import "./picks"`.

- [ ] **Step 3: Write the module and the pill**

Create `src/features/pos/order/picks.ts`:

```ts
// src/features/pos/order/picks.ts
/** Menu picks (docs/superpowers/specs/2026-11-17-menu-picks-design.md): the payload qr_picks and
 *  pos_menu_picks return, and the pure rules that keep each hint to what the menu offers now.
 *  The server counts; the client only filters. Hints never block ordering: no payload = no hints. */
import { findProduct, type OrderLine, type PosMenu, type PosProduct } from './cart'

export interface MenuPicks {
  /** product ids: recommended first, then by units sold (at most 8) */
  popular: string[]
  /** product id → the products usually ordered with it (at most 3 each) */
  pairs: Record<string, string[]>
  /** product id → add-on group id → the option most guests choose */
  mostPicked: Record<string, Record<string, string>>
  /** false = Popular is only the recommended products so far */
  fromSales: boolean
}

/** Goes well with shows at most this many products. */
export const MAX_PAIRS = 3

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])

/** The server's reply → MenuPicks, or null when it is not one (an unknown or paused table answers null). */
export function parsePicks(data: unknown): MenuPicks | null {
  if (!isRecord(data) || !Array.isArray(data.popular) || !isRecord(data.pairs) || !isRecord(data.mostPicked)) return null
  const pairs: Record<string, string[]> = {}
  for (const [id, ids] of Object.entries(data.pairs)) pairs[id] = strings(ids)
  const mostPicked: Record<string, Record<string, string>> = {}
  for (const [id, groups] of Object.entries(data.mostPicked)) {
    if (!isRecord(groups)) continue
    const m: Record<string, string> = {}
    for (const [groupId, optionId] of Object.entries(groups)) if (typeof optionId === 'string') m[groupId] = optionId
    mostPicked[id] = m
  }
  return { popular: strings(data.popular), pairs, mostPicked, fromSales: data.fromSales === true }
}

/** On this menu now (its catalog and time slot), not sold out, with a price. */
const orderable = (p: PosProduct | undefined): p is PosProduct => p !== undefined && !p.soldOut && p.variants.length > 0

/** Popular here: the popular products the menu offers now, in the server's order. */
export function visiblePopular(menu: PosMenu, picks: MenuPicks | null): PosProduct[] {
  if (!picks) return []
  return picks.popular.map((id) => findProduct(menu, id)).filter(orderable)
}

/** Goes well with `productId`: its pairs the menu offers now, not in the cart, at most MAX_PAIRS. */
export function pairsFor(menu: PosMenu, picks: MenuPicks | null, productId: string, cart: readonly OrderLine[]): PosProduct[] {
  if (!picks) return []
  const inCart = new Set(cart.map((l) => l.productId))
  return (picks.pairs[productId] ?? [])
    .filter((id) => id !== productId && !inCart.has(id))
    .map((id) => findProduct(menu, id))
    .filter(orderable)
    .slice(0, MAX_PAIRS)
}

/** The QR page offers Goes well with after a new line of `productId` when there is something to
 *  show and it has not been shown for that product in this visit (`shown`). */
export function offerPairs(
  menu: PosMenu, picks: MenuPicks | null, productId: string, cart: readonly OrderLine[], shown: ReadonlySet<string>,
): boolean {
  return !shown.has(productId) && pairsFor(menu, picks, productId, cart).length > 0
}

/** Most picked of one product: group id → option id. The sheets mark that option; nothing is chosen for the guest. */
export function mostPickedFor(picks: MenuPicks | null, productId: string): Readonly<Record<string, string>> | undefined {
  return picks?.mostPicked[productId]
}
```

Create `src/features/pos/order/PickPill.tsx`:

```tsx
// src/features/pos/order/PickPill.tsx
/** The small amber pill of the menu picks: "Popular" on a product, "Most picked" on an option. */
export default function PickPill({ text }: { text: 'Popular' | 'Most picked' }) {
  return (
    <span className="ml-1.5 inline-block whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 align-middle text-[11px] font-semibold text-amber-800">
      {text}
    </span>
  )
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run src/features/pos/order/picks.test.ts` then `npx tsc -b`
Expected: 10 tests PASS; `tsc -b` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/order/picks.ts src/features/pos/order/picks.test.ts src/features/pos/order/PickPill.tsx
git commit -m "feat(pos): menu picks payload and its filters to the live menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Most picked pill in both item sheets

**Files:**
- Modify: `src/features/pos/order/LineSheet.tsx`
- Create: `src/features/pos/order/LineSheet.test.tsx`
- Modify: `src/features/pos/order/ModifierSheet.tsx`
- Modify: `src/features/pos/order/ModifierSheet.test.tsx`

**Interfaces:**
- Consumes: `PickPill` (Task 2).
- Produces: both sheets take an optional prop `mostPicked?: Readonly<Record<string, string>>` (group id → option id). Callers pass `mostPickedFor(picks, product.id)`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/order/LineSheet.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import LineSheet from './LineSheet'
import type { PosProduct } from './cart'

afterEach(cleanup)

const latte: PosProduct = {
  id: 'p1', name: 'Latte', description: null, soldOut: false,
  variants: [{ id: 'hot', name: 'Hot', priceSen: 900, isBase: true }],
  groups: [{ id: 'milk', name: 'Milk', min: 1, max: 1, options: [
    { id: 'oat', name: 'Oat', priceDeltaSen: 200, isDefault: false, available: true },
    { id: 'soy', name: 'Soy', priceDeltaSen: 0, isDefault: false, available: false },
    { id: 'dairy', name: 'Dairy', priceDeltaSen: 0, isDefault: false, available: true },
  ] }],
}

describe('LineSheet Most picked', () => {
  it('marks the most picked option and chooses nothing for the guest', () => {
    render(<LineSheet product={latte} mostPicked={{ milk: 'oat' }} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.getByRole('button', { name: /Oat/ }).textContent).toContain('Most picked')
    expect(screen.getAllByText('Most picked')).toHaveLength(1)
    // Milk is still to be chosen: Add stays off until the guest picks one
    expect((screen.getByRole('button', { name: /^Add/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('no pill on a sold-out option, and none without picks', () => {
    render(<LineSheet product={latte} mostPicked={{ milk: 'soy' }} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.queryByText('Most picked')).toBeNull()
    cleanup()
    render(<LineSheet product={latte} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.queryByText('Most picked')).toBeNull()
  })
})
```

In `src/features/pos/order/ModifierSheet.test.tsx`, add inside `describe('ModifierSheet', () => { … })`, after the last `it`:

```tsx
  it('Most picked: a pill on that option, nothing chosen for the cashier, none on a sold-out option', () => {
    render(<ModifierSheet product={latte} mostPicked={{ milk: 'oat' }} onCancel={() => {}} onDone={() => {}} />)
    const oat = screen.getByRole('button', { name: /Oat/ })
    expect(oat.textContent).toContain('Most picked')
    expect(oat.getAttribute('aria-pressed')).toBe('false')
    cleanup()
    render(<ModifierSheet product={latte} mostPicked={{ milk: 'soy' }} onCancel={() => {}} onDone={() => {}} />)
    expect(screen.queryByText('Most picked')).toBeNull()
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/features/pos/order/LineSheet.test.tsx src/features/pos/order/ModifierSheet.test.tsx`
Expected: FAIL — no element with text "Most picked" (and a TypeScript-level unknown prop, which vitest does not check).

- [ ] **Step 3: Add the prop to LineSheet**

In `src/features/pos/order/LineSheet.tsx` replace:

```tsx
import { defaultLine, formatSen, linePriceSen, validateLine, type OrderLine, type PosProduct } from './cart'

export default function LineSheet({ product, initial, onCancel, onDone }: {
  product: PosProduct
  initial?: OrderLine
  onCancel: () => void
  onDone: (line: OrderLine) => void
}) {
```

with:

```tsx
import { defaultLine, formatSen, linePriceSen, validateLine, type OrderLine, type PosProduct } from './cart'
import PickPill from './PickPill'

export default function LineSheet({ product, initial, mostPicked, onCancel, onDone }: {
  product: PosProduct
  initial?: OrderLine
  /** Most picked (menu picks): group id → option id, marked with a pill — never chosen for the guest */
  mostPicked?: Readonly<Record<string, string>>
  onCancel: () => void
  onDone: (line: OrderLine) => void
}) {
```

and replace:

```tsx
                    {o.name}{o.priceDeltaSen > 0 && ` +${formatSen(o.priceDeltaSen)}`}{!o.available && ' (sold out)'}
```

with:

```tsx
                    {o.name}{o.priceDeltaSen > 0 && ` +${formatSen(o.priceDeltaSen)}`}{!o.available && ' (sold out)'}
                    {o.available && mostPicked?.[g.id] === o.id && <PickPill text="Most picked" />}
```

- [ ] **Step 4: Add the prop to ModifierSheet**

In `src/features/pos/order/ModifierSheet.tsx` replace:

```tsx
import { groupBadge, toggleOption } from './modifiers'
```

with:

```tsx
import { groupBadge, toggleOption } from './modifiers'
import PickPill from './PickPill'
```

replace:

```tsx
export default function ModifierSheet({ product, initial, onCancel, onDone, onRemove }: {
  product: PosProduct
  initial?: OrderLine
```

with:

```tsx
export default function ModifierSheet({ product, initial, mostPicked, onCancel, onDone, onRemove }: {
  product: PosProduct
  initial?: OrderLine
  /** Most picked (menu picks): group id → option id, marked with a pill — never chosen for the cashier */
  mostPicked?: Readonly<Record<string, string>>
```

and replace:

```tsx
                        <span>{o.name}{!o.available && ' (sold out)'}</span>
```

with:

```tsx
                        <span>{o.name}{!o.available && ' (sold out)'}{o.available && mostPicked?.[g.id] === o.id && <PickPill text="Most picked" />}</span>
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run src/features/pos/order/LineSheet.test.tsx src/features/pos/order/ModifierSheet.test.tsx` then `npx tsc -b`
Expected: all PASS (the three existing ModifierSheet tests too); `tsc -b` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/order/LineSheet.tsx src/features/pos/order/LineSheet.test.tsx src/features/pos/order/ModifierSheet.tsx src/features/pos/order/ModifierSheet.test.tsx
git commit -m "feat(pos): Most picked pill in the QR and counter item sheets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: QR page — Popular here, Popular pills, Goes well with, sheet pill

**Files:**
- Modify: `src/qr/QrApp.tsx` (whole file below)

**Interfaces:**
- Consumes: `qr_picks(p_token)` (Task 1); `parsePicks`, `visiblePopular`, `pairsFor`, `offerPairs`, `mostPickedFor`, `MenuPicks` (Task 2); `PickPill` (Task 2); `LineSheet`'s `mostPicked` (Task 3).
- Produces: nothing new for later tasks.

The logic is covered by `picks.test.ts`; this task is wiring and JSX, checked by `tsc`, the build and the browser check in Task 7.

- [ ] **Step 1: Replace `src/qr/QrApp.tsx`**

Write this whole file (everything not marked "picks" is the current file unchanged, except the price text now comes from `priceText`):

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { qrClient } from './qrClient'
import { tokenFromLocation, addLine, replaceLine, removeLine, leftTheMenu, leftTheMenuNotice, pruneAfterRefresh } from './qrState'
import {
  cartKey, cartSubtotalSen, findProduct, formatSen, lineLabel, linePriceSen, posMenuFromQr,
  type OrderLine, type PosMenu, type PosProduct, type QrMenuJson,
} from '../features/pos/order/cart'
import { mostPickedFor, offerPairs, pairsFor, parsePicks, visiblePopular, type MenuPicks } from '../features/pos/order/picks'
import LineSheet from '../features/pos/order/LineSheet'
import PickPill from '../features/pos/order/PickPill'

interface TableState {
  tableLabel: string
  billNo: string | null
  pax: number | null
  items: { name: string; qty: number; unitPriceSen: number; mods: string[]; note: string | null; voided: boolean }[]
  subtotalSen: number
}
type Screen = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'error' } | { kind: 'ready'; info: QrMenuJson; menu: PosMenu }

/** M3: a photo path in the public menu-images bucket → its URL (no request is made). */
const photoUrl = (path: string) => qrClient.storage.from('menu-images').getPublicUrl(path).data.publicUrl
const REFRESH_MS = 60_000
/** picks: read with the menu, then again with the minute refresh at most this often */
const PICKS_REFRESH_MS = 10 * 60_000

/** "RM 9.00", or "from RM 9.00" when the product has several sizes. */
const priceText = (p: PosProduct) =>
  p.variants.length > 1 ? `from ${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))}` : formatSen(p.variants[0].priceSen)

export default function QrApp() {
  const token = tokenFromLocation(window.location.pathname, window.location.search)
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [state, setState] = useState<TableState | null>(null)
  const [lines, setLines] = useState<OrderLine[]>([])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [pax, setPax] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [placed, setPlaced] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const pending = useRef<{ id: string; key: string } | null>(null)   // one client_order_id per distinct cart
  // M3: the minute refresh reads these, not a stale closure
  const linesRef = useRef(lines)
  useEffect(() => { linesRef.current = lines }, [lines])
  const menuRef = useRef<PosMenu | null>(null)
  useEffect(() => { menuRef.current = screen.kind === 'ready' ? screen.menu : null }, [screen])
  const refreshSeq = useRef(0)                                       // a slow reply never lands after a newer one
  // picks (docs/superpowers/specs/2026-11-17-menu-picks-design.md §4): hints only. A failed first read
  // leaves them hidden, a failed re-read keeps the last ones; ordering never waits on them.
  const [picks, setPicks] = useState<MenuPicks | null>(null)
  const picksAt = useRef(0)
  const [goesWellFor, setGoesWellFor] = useState<string | null>(null)   // the product the Goes well with panel is about
  const pairsShown = useRef(new Set<string>())                           // Goes well with: once per product per visit

  const loadState = async () => {
    const { data } = await qrClient.rpc('qr_table_state', { p_token: token })
    if (data) setState(data as TableState)
  }
  const loadPicks = () => {
    if (!token) return
    picksAt.current = Date.now()
    qrClient.rpc('qr_picks', { p_token: token }).then(
      ({ data, error }) => { if (!error) setPicks(parsePicks(data)) },
      () => { /* offline for a moment: the last picks stay */ },
    )
  }
  const loadMenu = () => {
    if (!token) { setScreen({ kind: 'invalid' }); return }
    setScreen({ kind: 'loading' })
    qrClient.rpc('qr_menu', { p_token: token }).then(({ data, error }) => {
      if (error) { setScreen({ kind: 'error' }); return }
      if (!data) { setScreen({ kind: 'invalid' }); return }
      const info = data as QrMenuJson
      setScreen({ kind: 'ready', info, menu: posMenuFromQr(info, photoUrl) })
      setCategory(info.categories[0]?.name ?? null)
      void loadState()
      loadPicks()
    }, () => setScreen({ kind: 'error' }))
  }
  useEffect(() => { loadMenu() }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // M3: read the menu again every minute while the page is in view, and when it comes back into
  // view, quietly: products whose time slot ends leave the menu (and the cart, with a notice; an
  // open product sheet for one closes; a sheet editing another line follows that line), products
  // whose slot starts appear. A failed read keeps the menu on screen; nothing changes while an
  // order is being sent; the server refuses anything out of its slot anyway. The picks are read
  // again with it at most every PICKS_REFRESH_MS.
  const ready = screen.kind === 'ready'
  useEffect(() => {
    if (!ready || !token) return
    const refresh = () => {
      if (document.visibilityState !== 'visible' || sendingRef.current) return
      const mine = ++refreshSeq.current
      qrClient.rpc('qr_menu', { p_token: token }).then(({ data, error }) => {
        if (mine !== refreshSeq.current || error || !data || !menuRef.current || sendingRef.current) return
        const info = data as QrMenuJson
        const menu = posMenuFromQr(info, photoUrl)
        const cart = linesRef.current
        const gone = leftTheMenu(cart, menu, menuRef.current)
        setScreen({ kind: 'ready', info, menu })
        setCategory((c) => (c && info.categories.some((x) => x.name === c) ? c : info.categories[0]?.name ?? null))
        // the sheet's line index points into the cart before the refresh: follow that line, or close
        setSheet((s) => {
          if (!s || !findProduct(menu, s.product.id)) return null
          if (s.index === null) return s
          const { index } = pruneAfterRefresh(cart, menu, s.index)
          return index === null ? null : { ...s, index }
        })
        if (gone.length > 0) {
          setLines(pruneAfterRefresh(cart, menu, null).lines)
          setNotice(leftTheMenuNotice(gone))
        }
        if (Date.now() - picksAt.current >= PICKS_REFRESH_MS) loadPicks()
      }, () => { /* offline for a moment: try again next minute */ })
    }
    const timer = setInterval(refresh, REFRESH_MS)
    document.addEventListener('visibilitychange', refresh)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh) }
  }, [ready, token]) // eslint-disable-line react-hooks/exhaustive-deps

  if (screen.kind === 'loading') return <Shell><p className="p-6 text-center text-brown-muted">Loading menu…</p></Shell>
  if (screen.kind === 'error') {
    return (
      <Shell>
        <div className="p-6 text-center">
          <p>Could not load the menu. Check your connection and try again.</p>
          <button onClick={loadMenu} className="mt-3 rounded-xl bg-brown-btn px-5 py-2 text-white">Try again</button>
        </div>
      </Shell>
    )
  }
  if (screen.kind === 'invalid') return <Shell><p className="p-6 text-center">This table code is not valid. Please order at the counter.</p></Shell>
  const { info, menu } = screen
  if (info.paused) return <Shell title={`Table ${info.tableLabel}`}><p className="p-6 text-center">Ordering from this table is paused. Please order at the counter.</p></Shell>

  const needsPax = info.needsPax && !state?.pax
  const subtotal = cartSubtotalSen(menu, lines)
  // picks, filtered to what this menu offers now
  const popular = visiblePopular(menu, picks)
  const popularIds = new Set(popular.map((p) => p.id))
  const goesWell = goesWellFor ? pairsFor(menu, picks, goesWellFor, lines) : []
  const goesWellName = goesWellFor ? findProduct(menu, goesWellFor)?.name ?? null : null
  const showGoesWell = goesWell.length > 0 && goesWellName !== null

  const place = async () => {
    if (lines.length === 0 || sending || sendingRef.current) return
    const paxNum = needsPax ? Number(pax) : null
    if (needsPax && (!Number.isInteger(paxNum) || (paxNum as number) < 1 || (paxNum as number) > 99)) { setError('How many people are at the table? (1–99)'); return }
    const key = cartKey(lines)
    if (!pending.current || pending.current.key !== key) pending.current = { id: crypto.randomUUID(), key }
    sendingRef.current = true; setSending(true); setError(null)
    try {
      const { error } = await qrClient.rpc('place_table_order', { p_token: token, p_pax: paxNum, p_items: lines, p_client_order_id: pending.current.id })
      if (error) throw new Error(error.message)
      pending.current = null
      setLines([]); setPlaced(true); setNotice(null); setGoesWellFor(null)
      await loadState()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg === 'Failed to fetch' || msg.includes('NetworkError')
        ? 'Not sent: no connection — tap Place order to try again.'
        : `Not sent: ${msg} — tap Place order to try again.`)
    } finally { sendingRef.current = false; setSending(false) }
  }

  /** The sheet's Add / Done: a new line may open Goes well with (once per product per visit). */
  const done = (line: OrderLine) => {
    if (!sheet) return
    const next = sheet.index === null ? addLine(lines, line) : replaceLine(lines, sheet.index, line)
    setLines(next); setSheet(null); setPlaced(false); setNotice(null)
    if (sheet.index === null) {
      const offer = offerPairs(menu, picks, line.productId, next, pairsShown.current)
      if (offer) pairsShown.current.add(line.productId)
      setGoesWellFor(offer ? line.productId : null)
    }
  }

  const products = menu.categories.find((c) => c.name === category)?.products ?? []
  return (
    <Shell title={`Table ${info.tableLabel}`}>
      {placed && (
        <div className="m-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
          Order placed — it is on its way. You can add more below.
        </div>
      )}
      {state && state.items.length > 0 && (
        <details className="m-3 rounded-xl border border-border bg-card p-3 text-sm">
          <summary>Ordered so far · {formatSen(state.subtotalSen)}</summary>
          {state.items.map((i, k) => (
            <div key={k} className={`flex justify-between py-1 ${i.voided ? 'line-through opacity-50' : ''}`}>
              <span>{i.qty} × {i.name}{i.mods.length > 0 && <span className="text-brown-muted"> · {i.mods.join(', ')}</span>}</span>
              <span>{formatSen(i.unitPriceSen * i.qty)}</span>
            </div>
          ))}
        </details>
      )}
      {popular.length > 0 && (
        <section aria-label="Popular here" className="px-3 pt-2">
          <h2 className="text-sm font-semibold text-brown-dark">Popular here</h2>
          <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
            {popular.map((p) => <PickCard key={p.id} product={p} onOpen={() => setSheet({ product: p, index: null })} />)}
          </div>
        </section>
      )}
      <div className="flex gap-1 overflow-x-auto px-3 py-2">
        {menu.categories.map((c) => (
          <button key={c.name} onClick={() => setCategory(c.name)}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name ? 'bg-brown-btn text-white' : 'border border-border bg-card'}`}>{c.name}</button>
        ))}
      </div>
      <div className={`space-y-2 px-3 ${lines.length > 0 ? (showGoesWell ? 'pb-[75vh]' : 'pb-[50vh]') : notice ? 'pb-48' : 'pb-24'}`}>
        {products.filter((p) => p.variants.length > 0).map((p) => (
          <button key={p.id} disabled={p.soldOut} onClick={() => setSheet({ product: p, index: null })}
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left disabled:opacity-50">
            {p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" />}
            <div className="flex-1">
              <div className="font-medium">
                {p.name}
                {popularIds.has(p.id) && <PickPill text="Popular" />}
                {p.soldOut && <span className="ml-2 text-xs text-red-700">Sold out</span>}
              </div>
              {p.description && <div className="text-xs text-brown-muted">{p.description}</div>}
            </div>
            <div className="text-sm">{priceText(p)}</div>
          </button>
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card p-3 text-sm shadow-lg">
        {showGoesWell && (
          <section aria-label="Goes well with" className="mb-2 rounded-xl border border-border bg-cream p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-brown-dark">Goes well with your {goesWellName}</span>
              <button type="button" aria-label="Close" className="h-8 w-8 shrink-0" onClick={() => setGoesWellFor(null)}>✕</button>
            </div>
            <div className="mt-1 flex gap-2 overflow-x-auto">
              {goesWell.map((p) => <PickCard key={p.id} product={p} onOpen={() => setSheet({ product: p, index: null })} />)}
            </div>
          </section>
        )}
        <div className="max-h-[40vh] overflow-y-auto">
        {lines.map((l, i) => {
          const p = findProduct(menu, l.productId)
          if (!p) return null
          const { name, mods } = lineLabel(p, l)
          return (
            <div key={i} className="flex justify-between py-1">
              <button className="text-left" onClick={() => setSheet({ product: p, index: i })}>
                {l.qty} × {name}{mods.length > 0 && <span className="text-brown-muted"> · {mods.join(', ')}</span>}
              </button>
              <span>{formatSen((linePriceSen(p, l) ?? 0) * l.qty)} <button className="ml-2 text-red-700" onClick={() => setLines(removeLine(lines, i))}>✕</button></span>
            </div>
          )
        })}
        {needsPax && lines.length > 0 && (
          <label className="my-1 block">How many people? <input inputMode="numeric" className="ml-2 w-16 rounded border border-border p-1 text-base" value={pax} onChange={(e) => setPax(e.target.value)} /></label>
        )}
        {notice && <p role="status" className="my-1 rounded bg-amber-50 p-2 text-amber-900">{notice}</p>}
        {error && <p className="my-1 text-red-700">{error}</p>}
        </div>
        <button disabled={lines.length === 0 || sending} onClick={() => void place()}
          className="mt-1 w-full rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
          {sending ? 'Sending…' : lines.length === 0 ? 'Tap an item to start' : `Place order · ${formatSen(subtotal)}`}
        </button>
      </div>

      {sheet && (
        <LineSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          mostPicked={mostPickedFor(picks, sheet.product.id)}
          onCancel={() => setSheet(null)}
          onDone={done} />
      )}
    </Shell>
  )
}

/** A card of Popular here and Goes well with: photo, name, price; a tap opens the item sheet. */
function PickCard({ product, onOpen }: { product: PosProduct; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen}
      className="flex w-28 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-left">
      {product.imageUrl
        ? <img src={product.imageUrl} alt="" loading="lazy" className="h-20 w-full object-cover" />
        : <div className="h-20 w-full bg-border" />}
      <div className="p-2">
        <div className="line-clamp-2 text-xs font-medium">{product.name}</div>
        <div className="mt-0.5 text-xs text-brown-muted">{priceText(product)}</div>
      </div>
    </button>
  )
}

function Shell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <header className="bg-brown-header px-4 py-3 text-white">
        <div className="text-xs opacity-80">Craft Cafe</div>
        <div className="text-lg font-semibold">{title ?? 'Order'}</div>
      </header>
      {children}
    </div>
  )
}
```

- [ ] **Step 2: Type check and the QR tests**

Run: `npx tsc -b` then `npx vitest run src/qr src/features/pos/order/picks.test.ts`
Expected: `tsc -b` exits 0; all PASS.

- [ ] **Step 3: Commit**

```bash
git add src/qr/QrApp.tsx
git commit -m "feat(qr): Popular here, Goes well with and Most picked on the QR menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Menu editor — Recommend on QR menu switch

**Files:**
- Modify: `src/features/pos/menu/slotsApi.ts`
- Create: `src/features/pos/menu/product/RecommendSection.tsx`
- Create: `src/features/pos/menu/product/RecommendSection.test.tsx`
- Modify: `src/features/pos/menu/ProductEditorPage.tsx`

**Interfaces:**
- Consumes: `menu_product_extras` → `isRecommended`, `set_product_recommended(p_product_id, p_on)` (Task 1).
- Produces: `ProductExtras.isRecommended: boolean`; `setProductRecommended(productId: string, on: boolean): Promise<null>`; `RecommendSection({ productId })`; `RECOMMEND_HINT`.

- [ ] **Step 1: Write the failing test**

Create `src/features/pos/menu/product/RecommendSection.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The two RPCs are stand-ins: what is tested is the switch's load, save and refusal.
const api = { fetchProductExtras: vi.fn(), setProductRecommended: vi.fn() }
vi.mock('../slotsApi', () => ({
  fetchProductExtras: (...a: unknown[]) => api.fetchProductExtras(...a),
  setProductRecommended: (...a: unknown[]) => api.setProductRecommended(...a),
}))

import RecommendSection from './RecommendSection'

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  api.fetchProductExtras.mockResolvedValue({ imagePath: null, imageUpdatedAt: null, scheduleIds: [], isRecommended: false })
  api.setProductRecommended.mockResolvedValue(null)
})

describe('RecommendSection', () => {
  it('shows the switch with its hint and saves it on its own call', async () => {
    render(<RecommendSection productId="p1" />)
    const sw = await screen.findByRole('switch', { name: 'Recommend on QR menu' })
    expect((sw as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('Shown under Popular here, and suggested with other items, until sales are enough to choose by themselves.')).toBeTruthy()
    fireEvent.click(sw)
    await waitFor(() => expect(api.setProductRecommended).toHaveBeenCalledWith('p1', true))
    await waitFor(() => expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true))
    expect(screen.getByRole('status').textContent).toBe('Saved')
  })

  it('a refused save says why and leaves the switch as it was', async () => {
    api.setProductRecommended.mockRejectedValue(new Error('Not allowed to edit the menu'))
    render(<RecommendSection productId="p1" />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Recommend on QR menu' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Not allowed to edit the menu')
    expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/features/pos/menu/product/RecommendSection.test.tsx`
Expected: FAIL — `Failed to resolve import "./RecommendSection"`.

- [ ] **Step 3: The API additions**

In `src/features/pos/menu/slotsApi.ts` replace:

```ts
/** menu_product_extras: the product editor's Photo and Time slots sections. */
export interface ProductExtras { imagePath: string | null; imageUpdatedAt: string | null; scheduleIds: string[] }
```

with:

```ts
/** menu_product_extras: the product editor's Photo, Time slots and Recommend sections. */
export interface ProductExtras { imagePath: string | null; imageUpdatedAt: string | null; scheduleIds: string[]; isRecommended: boolean }
```

and after the line `export const setProductSchedules = …` (its two lines) add:

```ts
/** Recommend on QR menu (menu picks): saved on its own; every outlet's picks are computed again. */
export const setProductRecommended = (productId: string, on: boolean) =>
  rpc<null>('set_product_recommended', { p_product_id: productId, p_on: on })
```

- [ ] **Step 4: The section**

Create `src/features/pos/menu/product/RecommendSection.tsx`:

```tsx
// src/features/pos/menu/product/RecommendSection.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchProductExtras, setProductRecommended } from '../slotsApi'
import { OutcomeLine, errorText, type Outcome } from '../editorUi'

/** The words under the switch (spec §6). */
export const RECOMMEND_HINT = 'Shown under Popular here, and suggested with other items, until sales are enough to choose by themselves.'

/** Recommend on QR menu (docs/superpowers/specs/2026-11-17-menu-picks-design.md §6): a saved
 *  product's switch, saved on its own by set_product_recommended the moment it is flipped, with its
 *  outcome here — like Photo and Time slots, not through Save product. */
export default function RecommendSection({ productId }: { productId: string }) {
  const [on, setOn] = useState<boolean | null>(null)                 // null = not loaded yet
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)                                    // a second flip in the same render is refused too
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current                                    // a reply to an older load is dropped
    try {
      const extras = await fetchProductExtras(productId)
      if (seq !== loadSeq.current) return
      setOn(extras.isRecommended === true)
      setLoadError(null)
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(errorText(e))
    }
  }, [productId])
  useEffect(() => { void load() }, [load])

  const flip = async (next: boolean) => {
    if (savingRef.current || on === null) return
    savingRef.current = true
    setSaving(true)
    setOutcome(null)
    try {
      await setProductRecommended(productId, next)
      setOn(next)
      setOutcome({ kind: 'ok', text: 'Saved' })
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      {on === null && !loadError && <p className="text-sm">Loading…</p>}
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {on !== null && (
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" role="switch" checked={on} disabled={saving} onChange={(e) => void flip(e.target.checked)} />
          Recommend on QR menu
        </label>
      )}
      <p className="text-xs text-brown-muted">{RECOMMEND_HINT}</p>
      <OutcomeLine outcome={outcome} />
    </section>
  )
}
```

- [ ] **Step 5: Mount it in the product editor**

In `src/features/pos/menu/ProductEditorPage.tsx` replace:

```tsx
import TimeSlotsSection from './product/TimeSlotsSection'
```

with:

```tsx
import TimeSlotsSection from './product/TimeSlotsSection'
import RecommendSection from './product/RecommendSection'
```

and replace:

```tsx
            : <p className="text-sm text-brown-muted">Create the product first, then add its photo and time slots.</p>}
```

with:

```tsx
            : <p className="text-sm text-brown-muted">Create the product first, then add its photo and time slots.</p>}
          {form.id && <RecommendSection productId={form.id} />}
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run src/features/pos/menu` then `npx tsc -b`
Expected: all PASS (`photoUpload.test.ts` mocks `fetchProductExtras` and is unaffected); `tsc -b` exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/menu/slotsApi.ts src/features/pos/menu/product/RecommendSection.tsx src/features/pos/menu/product/RecommendSection.test.tsx src/features/pos/menu/ProductEditorPage.tsx
git commit -m "feat(menu): Recommend on QR menu switch in the product editor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Counter — Popular pill on tiles, Goes well with chip row, sheet pill

**Files:**
- Modify: `src/features/pos/order/posApi.ts`
- Modify: `src/features/pos/order/ProductTiles.tsx` (whole file below)
- Create: `src/features/pos/order/ProductTiles.test.tsx`
- Modify: `src/features/pos/order/BillColumn.tsx`
- Modify: `src/features/pos/order/BillColumn.test.tsx`
- Modify: `src/features/pos/order/OrderScreen.tsx`

**Interfaces:**
- Consumes: `pos_menu_picks()` (Task 1); `parsePicks`, `visiblePopular`, `pairsFor`, `mostPickedFor`, `MenuPicks` (Task 2); `PickPill` (Task 2); `ModifierSheet`'s `mostPicked` (Task 3); `tileSlotLabel(w: MenuWindows, productId: string, at: Date): string | null` from `./padSlots`.
- Produces: `fetchMenuPicks(): Promise<MenuPicks | null>`; `ProductTiles` prop `popular?: ReadonlySet<string>`; `BillColumn` prop `goesWell?: { products: { id: string; name: string }[]; onPick: (productId: string) => void } | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/pos/order/ProductTiles.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ProductTiles from './ProductTiles'
import type { PosProduct } from './cart'

afterEach(cleanup)

const tile = (id: string, name: string): PosProduct => ({
  id, name, description: null, soldOut: false,
  variants: [{ id: `${id}-v`, name: 'Regular', priceSen: 1000, isBase: true }], groups: [],
})

describe('ProductTiles Popular pill', () => {
  it('marks only the popular products', () => {
    render(<ProductTiles products={[tile('a', 'Latte'), tile('b', 'Mocha')]} windows={{ offsetMs: 0, byProduct: new Map() }}
      now={new Date()} soldOutMode={false} popular={new Set(['a'])} onTap={() => {}} />)
    expect(screen.getAllByText('Popular')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Latte/ }).textContent).toContain('Popular')
  })
})
```

In `src/features/pos/order/BillColumn.test.tsx`, after the closing `})` of `describe('BillColumn catalog control', …)`, add:

```tsx
describe('BillColumn Goes well with', () => {
  it('a chip row under the drafts; a tap hands back the product', () => {
    const onPick = vi.fn()
    render(<BillColumn {...props} catalogName={null} onCatalog={null}
      goesWell={{ products: [{ id: 'c1', name: 'Butter Croissant' }, { id: 'c2', name: 'Basque Cheesecake' }], onPick }} />)
    expect(screen.getByRole('group', { name: 'Goes well with' }).textContent).toContain('Goes well with:')
    fireEvent.click(screen.getByRole('button', { name: 'Basque Cheesecake' }))
    expect(onPick).toHaveBeenCalledWith('c2')
  })

  it('no row without products', () => {
    render(<BillColumn {...props} catalogName={null} onCatalog={null} goesWell={null} />)
    expect(screen.queryByRole('group', { name: 'Goes well with' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/features/pos/order/ProductTiles.test.tsx src/features/pos/order/BillColumn.test.tsx`
Expected: FAIL — no "Popular" text; no group named "Goes well with".

- [ ] **Step 3: `fetchMenuPicks` in posApi**

In `src/features/pos/order/posApi.ts` replace:

```ts
import { productThumbUrl } from '../menu/photoUpload'
```

with:

```ts
import { productThumbUrl } from '../menu/photoUpload'
import { parsePicks, type MenuPicks } from './picks'
```

and after the whole `fetchPosMenu` function add:

```ts
/** The menu picks of the caller's outlet (pos_menu_picks), or null when there are none. Hints
 *  only: the order screen hides them when this rejects (an older server has no such function). */
export async function fetchMenuPicks(): Promise<MenuPicks | null> {
  const { data, error } = await supabase.rpc('pos_menu_picks')
  if (error) fail(error)
  return parsePicks(data)
}
```

- [ ] **Step 4: ProductTiles with the pill**

Replace `src/features/pos/order/ProductTiles.tsx` with:

```tsx
// src/features/pos/order/ProductTiles.tsx
import { formatSen, type PosProduct } from './cart'
import { tileSlotLabel, type MenuWindows } from './padSlots'
import { tileInitials } from './modifiers'
import PickPill from './PickPill'

/** The order screen's product tiles, Feedme style: photo on top (or the first three letters on a
 *  grey block), name and price below. A sold-out product, or one outside its time slots at `now`
 *  (the server's time, moved on every minute by usePadWindows), is greyed out and says why;
 *  tapping it only works in sold-out mode (the screen decides). A popular product (menu picks)
 *  carries a Popular pill. */
export default function ProductTiles({ products, windows, now, soldOutMode, popular, onTap }: {
  products: PosProduct[]
  windows: MenuWindows
  now: Date
  /** in sold-out mode every tile can be tapped (to mark it sold out or back) */
  soldOutMode: boolean
  /** ids of the products shown as Popular (menu picks); none when left out */
  popular?: ReadonlySet<string>
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
              {popular?.has(p.id) && <span className="absolute right-1 top-1"><PickPill text="Popular" /></span>}
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

- [ ] **Step 5: BillColumn chip row**

In `src/features/pos/order/BillColumn.tsx` replace:

```tsx
  payHint: string | null
  onPay: () => void
}) {
```

with:

```tsx
  payHint: string | null
  onPay: () => void
  /** Goes well with (menu picks): the products usually ordered with the one just added; null = no row */
  goesWell?: { products: { id: string; name: string }[]; onPick: (productId: string) => void } | null
}) {
```

and replace:

```tsx
        {!p.loading && view.sent.length === 0 && view.drafts.length === 0 && <p className="text-brown-muted">Tap items to add them.</p>}
```

with:

```tsx
        {p.goesWell && p.goesWell.products.length > 0 && (
          <div role="group" aria-label="Goes well with"
            className="mt-2 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-xs text-brown-muted">
            <span>Goes well with:</span>
            {p.goesWell.products.map((g, k) => (
              <span key={g.id} className="flex items-center gap-1">
                {k > 0 && <span aria-hidden="true">·</span>}
                <button type="button" onClick={() => p.goesWell?.onPick(g.id)}
                  className="min-h-11 rounded-lg border border-border-mid px-3 text-sm font-medium text-brown-dark">{g.name}</button>
              </span>
            ))}
          </div>
        )}
        {!p.loading && view.sent.length === 0 && view.drafts.length === 0 && <p className="text-brown-muted">Tap items to add them.</p>}
```

- [ ] **Step 6: Run the component tests**

Run: `npx vitest run src/features/pos/order/ProductTiles.test.tsx src/features/pos/order/BillColumn.test.tsx`
Expected: PASS (the two existing BillColumn tests too).

- [ ] **Step 7: Wire the order screen**

In `src/features/pos/order/OrderScreen.tsx`, make these replacements in order.

(a) Replace:

```tsx
  fetchBillItems, fetchBranchCatalogs, fetchPadProductInfo, fetchPosMenu, setSoldOut, setTablePaused,
```

with:

```tsx
  fetchBillItems, fetchBranchCatalogs, fetchMenuPicks, fetchPadProductInfo, fetchPosMenu, setSoldOut, setTablePaused,
```

(b) Replace:

```tsx
import { withPhotos, type PadProductInfo } from './padInfo'
```

with:

```tsx
import { withPhotos, type PadProductInfo } from './padInfo'
import { mostPickedFor, pairsFor, visiblePopular, type MenuPicks } from './picks'
import { tileSlotLabel } from './padSlots'
```

(c) Replace:

```tsx
    fetchPadProductInfo().then((m) => { if (live) setInfo(m) }, () => undefined)   // without it: no photos, drafts left out of the totals
    return () => { live = false }
  }, [])
```

with:

```tsx
    fetchPadProductInfo().then((m) => { if (live) setInfo(m) }, () => undefined)   // without it: no photos, drafts left out of the totals
    return () => { live = false }
  }, [])
  // menu picks (docs/superpowers/specs/2026-11-17-menu-picks-design.md §5): read once when the screen
  // opens; hints only — a failed read hides them
  const [picks, setPicks] = useState<MenuPicks | null>(null)
  const [goesWellFor, setGoesWellFor] = useState<string | null>(null)   // the product just added: its chip row
  useEffect(() => {
    let live = true
    fetchMenuPicks().then((p) => { if (live) setPicks(p) }, () => { if (live) setPicks(null) })
    return () => { live = false }
  }, [branchId])
```

(d) Replace:

```tsx
    setSheet(null); setMenu(null); setCategory(null); setNotice(null); setCatalogId(id)
```

with:

```tsx
    setSheet(null); setMenu(null); setCategory(null); setNotice(null); setGoesWellFor(null); setCatalogId(id)
```

(e) Replace:

```tsx
    return all.filter((p) => (q ? p.name.toLowerCase().includes(q) : !category || p.category === category))
  }, [shownMenu, category, search])
```

with:

```tsx
    return all.filter((p) => (q ? p.name.toLowerCase().includes(q) : !category || p.category === category))
  }, [shownMenu, category, search])
  const popularIds = useMemo(() => new Set(shownMenu ? visiblePopular(shownMenu, picks).map((p) => p.id) : []), [shownMenu, picks])
  /** A new draft line; its Goes well with chip row replaces the last one. */
  const addDraft = (line: OrderLine) => { setLines((ls) => [...ls, line]); setGoesWellFor(line.productId) }
```

(f) Replace:

```tsx
    if (p.variants.length === 1 && p.groups.length === 0) setLines((ls) => [...ls, defaultLine(p)])
```

with:

```tsx
    if (p.variants.length === 1 && p.groups.length === 0) addDraft(defaultLine(p))
```

(g) Replace:

```tsx
      setLines([]); setError(null)
      return res.clientOrderId
```

with:

```tsx
      setLines([]); setError(null); setGoesWellFor(null)
      return res.clientOrderId
```

(h) Replace:

```tsx
  const title = targetTitle(target, bill, tables)
```

with:

```tsx
  // Goes well with: the chip row for the product just added, while it is still among the drafts —
  // what the menu offers now and inside its time slot; never in sold-out mode or when the bill takes no new items
  const goesWell = goesWellFor && shownMenu && !soldOutMode && takesNewItems(target) && lines.some((l) => l.productId === goesWellFor)
    ? pairsFor(shownMenu, picks, goesWellFor, lines).filter((p) => tileSlotLabel(slots.windows, p.id, slots.now) === null)
    : []

  const title = targetTitle(target, bill, tables)
```

(i) Replace:

```tsx
              <ProductTiles products={products} windows={slots.windows} now={slots.now} soldOutMode={soldOutMode}
                onTap={(p, outOfSlot) => void tap(p, outOfSlot)} />
```

with:

```tsx
              <ProductTiles products={products} windows={slots.windows} now={slots.now} soldOutMode={soldOutMode}
                popular={popularIds} onTap={(p, outOfSlot) => void tap(p, outOfSlot)} />
```

(j) Replace:

```tsx
        onPay={pay}
      />
```

with:

```tsx
        onPay={pay}
        goesWell={goesWell.length > 0 ? {
          products: goesWell.map((p) => ({ id: p.id, name: p.name })),
          onPick: (id) => { const p = goesWell.find((g) => g.id === id); if (p) void tap(p, false) },   // as from its tile
        } : null}
      />
```

(k) Replace:

```tsx
        <ModifierSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          onCancel={() => setSheet(null)}
          onRemove={sheet.index === null ? undefined : () => { const i = sheet.index; setLines((ls) => ls.filter((_, k) => k !== i)); setSheet(null) }}
          onDone={(line) => { setLines((ls) => (sheet.index === null ? [...ls, line] : ls.map((x, k) => (k === sheet.index ? line : x)))); setSheet(null) }} />
```

with:

```tsx
        <ModifierSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          mostPicked={mostPickedFor(picks, sheet.product.id)}
          onCancel={() => setSheet(null)}
          onRemove={sheet.index === null ? undefined : () => { const i = sheet.index; setLines((ls) => ls.filter((_, k) => k !== i)); setSheet(null) }}
          onDone={(line) => {
            if (sheet.index === null) addDraft(line)
            else { const i = sheet.index; setLines((ls) => ls.map((x, k) => (k === i ? line : x))) }
            setSheet(null)
          }} />
```

- [ ] **Step 8: Type check and the order tests**

Run: `npx tsc -b` then `npx vitest run src/features/pos/order`
Expected: `tsc -b` exits 0; all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/order/posApi.ts src/features/pos/order/ProductTiles.tsx src/features/pos/order/ProductTiles.test.tsx src/features/pos/order/BillColumn.tsx src/features/pos/order/BillColumn.test.tsx src/features/pos/order/OrderScreen.tsx
git commit -m "feat(pos): Popular pill, Goes well with chip row and Most picked at the counter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Final checks — full tests, both builds, browser on dev

**Files:** none changed (a fix found here goes back to the task that owns the file, with its own commit).

- [ ] **Step 1: Full test run, type check and both builds**

Run: `npx vitest run`, then `npx tsc -b`, then `npm run build`, then `npm run build:pos`
Expected: every test passes; `tsc -b` exits 0; both builds succeed.

- [ ] **Step 2: Start this worktree's dev server against craft-os-dev**

Start the `craft-os-dev` entry of **this worktree's** `.claude/launch.json` (`npm run dev` in `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`; its `.env.local` points to `egznnbjmicebbhwasloy`). Never use the main checkout's dev server. In the browser check a network request's host is `egznnbjmicebbhwasloy.supabase.co`; stop if it is `yfsoesxzurzjdwstszru`.

- [ ] **Step 3: Back office — the switch**

Signed in as the dev test login (owner), open Menu → Products → three active products of the dev QR outlet's qr catalog, in at least two categories (e.g. a coffee, a cake, a bread). On each: "Recommend on QR menu" is under Photo with the hint; switch it on → "Saved"; reload the page → still on. Note the three names.

- [ ] **Step 4: QR page**

Get an active, unpaused table token of the same outlet from the dev SQL editor (`select label, qr_token from dining_tables where is_active and not qr_paused order by label limit 3;` — dev only) and open `http://localhost:<port>/qr/?t=<token>`. Check:
1. "Popular here" sits above the category chips with the three products (photo, name, price); tapping a card opens its item sheet.
2. In the category lists those products carry a "Popular" pill.
3. Add one of them (a new line) → a panel above the cart: "Goes well with your <product>" with up to 3 cards, none of the same category, none already in the cart; ✕ closes it; adding the same product again in this visit does not bring it back; editing a cart line does not open it.
4. Tap a card in the panel → its sheet; add it → the panel shows for that product or closes.
5. Place order still works; the panel is gone after it.
6. In the browser's network tab, `qr_picks` is called once after `qr_menu`; block it (DevTools request blocking on `rpc/qr_picks`) and reload → no Popular row, no panel, ordering unchanged.

Most picked needs ≥ 10 units of real sales; dev has too few, so it is covered by the verify (section D) and the sheet tests — note this in the report.

- [ ] **Step 5: Counter**

Open the POS order screen of the same outlet (a test table). Check: the three products' tiles show a "Popular" pill; tap one → under the drafts a row "Goes well with: A · B"; tapping a chip adds it as its tile would (direct, or the sheet when it has add-on groups) and the row moves to that product; Send clears the row; in Sold out mode the row is hidden.

- [ ] **Step 6: Put dev back**

Switch "Recommend on QR menu" off on the three products (each → "Saved"). Take one screenshot of the QR page (Popular here + Goes well with) and one of the counter (pill + chip row) for the owner.

- [ ] **Step 7: Report**

Report: test count, both builds, the verify's `VERIFY OK`, the browser checks 4.1–4.6 and 5, and that Most picked was checked by the verify only. Do not push; prod is untouched (it runs with the POS chain later).
