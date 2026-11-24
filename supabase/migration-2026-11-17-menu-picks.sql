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
create index if not exists bills_branch_paid_closed_idx on bills(branch_id, closed_at) where status = 'paid';

-- RLS on, no policies: read and written only through the functions below
alter table menu_picks_cache enable row level security;
revoke all on menu_picks_cache from public, anon, authenticated;

-- ── P2. The rules, in one place (spec §2) ───────────────────────────────────
-- its result columns changed: a re-run drops the old shape first (nothing in the schema depends on it)
drop function if exists pos_picks_rules();
create or replace function pos_picks_rules(
  out popular_days integer, out popular_min_bills integer, out popular_top integer, out popular_min_units integer,
  out popular_max integer, out pair_fallback integer,
  out pair_days integer, out pair_min_shared integer, out pair_min_share numeric, out pair_top integer,
  out picked_days integer, out picked_min_units integer, out picked_min_share numeric,
  out cache_minutes integer)
language sql immutable security definer set search_path = public, pg_temp as $$
  select 30, 30, 6, 3, 12, 6,   -- Popular here: 30 days; from sales only with >= 30 paid bills; top 6 sellers with >= 3 units; at most 12 in all (the client shows 8 after dropping what its menu lacks); fallback pairs up to 6
         60, 3, 0.10, 6,       -- Goes well with: 60 days; another category, >= 3 shared orders and >= 10 % of the product's orders; up to 6 (the client shows 3 after filtering)
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
   where b.branch_id = p_branch and b.status = 'paid' and coalesce(b.refunded_sen, 0) = 0
     and b.closed_at > now() - make_interval(days => k.popular_days);
  v_sales := v_bills >= k.popular_min_bills;

  with sold as (
    select oi.product_id, sum(oi.qty)::integer as units
      from order_items oi
      join bills b on b.id = oi.bill_id
     where b.branch_id = p_branch and b.status = 'paid' and coalesce(b.refunded_sen, 0) = 0
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
     where b.branch_id = p_branch and b.status = 'paid' and coalesce(b.refunded_sen, 0) = 0
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
               limit k.pair_fallback) x) f
   where p.is_active and not p.is_addon
     and not (v_pairs ? p.id::text)
     and f.ids is not null;

  -- ── Most picked: per product and add-on group, the option most guests choose ──
  with items as (
    select oi.id, oi.product_id, oi.qty, oi.modifiers_snapshot
      from order_items oi
      join bills b on b.id = oi.bill_id
      join menu_products p on p.id = oi.product_id and p.is_active and not p.is_addon
     where b.branch_id = p_branch and b.status = 'paid' and coalesce(b.refunded_sen, 0) = 0
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
  -- stale or missing: one session recomputes; the others take the stale payload (or compute without caching)
  if not pg_try_advisory_xact_lock(hashtext('menu_picks:' || p_branch::text)) then
    select c.payload into v_payload from menu_picks_cache c where c.branch_id = p_branch;
    if found then
      return v_payload;
    end if;
    return pos_compute_picks(p_branch);
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
