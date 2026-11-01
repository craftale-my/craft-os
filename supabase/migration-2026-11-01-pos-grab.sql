-- ============================================================================
-- Craft OS — GrabFood integration skeleton (2026-11-01).
-- Run on craft-os-dev after migration-2026-10-30-pos-discounts.sql. Idempotent.
-- Design: docs/superpowers/specs/2026-11-01-grab-integration-design.md
--
-- G1  grab_stores: which outlet is which GrabFood merchant, and which catalog is its Grab
--     menu. partnerMerchantID (our ID as Grab sees it) is branch_id::text.
-- G2  grab_orders: every order Grab submits, kept once per Grab orderID (Grab retries).
--     bill_id stays null until a later step turns Grab orders into POS bills.
-- G3  grab_events: every call Grab makes to us and every call we make to Grab, with the
--     body, so the first sandbox runs can be read back. Secrets are never stored.
-- G4  grab_menu_source(merchant_id): the store's Grab catalog as rows the Edge Function
--     turns into Grab's menu format. Service role only.
--
-- Only the `grab` Edge Function (service role) writes these tables. Staff with
-- access_settings may read them, and may edit grab_stores (the store mapping).
-- ============================================================================

do $$ begin
  if to_regclass('catalog_variant_prices') is null or to_regprocedure('has_menu_cap(text)') is null then
    raise exception 'STOP: run the POS catalog migrations first (catalog_variant_prices or has_menu_cap is missing)';
  end if;
end $$;

-- ── G1 Stores ───────────────────────────────────────────────────────────────
create table if not exists grab_stores (
  branch_id           uuid primary key references branches(id),
  merchant_id         text not null unique check (length(trim(merchant_id)) between 1 and 64),
  catalog_id          uuid references menu_catalogs(id),                 -- the Grab menu; null = empty menu
  auto_accept         boolean not null default false,                    -- accept MANUAL orders without a tap
  is_active           boolean not null default true,
  integration_status  text check (integration_status in ('INACTIVE', 'ACTIVE', 'SYNCING', 'FAILED')),
  last_menu_job_id    text,                                              -- from Update menu notification
  last_menu_status    text check (last_menu_status in ('QUEUEING', 'PROCESSING', 'SUCCESS', 'FAILED')),
  last_menu_errors    jsonb,
  updated_at          timestamptz not null default now()
);

-- ── G2 Orders ───────────────────────────────────────────────────────────────
create table if not exists grab_orders (
  id                  uuid primary key default gen_random_uuid(),
  grab_order_id       text not null unique,                              -- Grab's orderID
  merchant_id         text not null,
  branch_id           uuid references branches(id),                      -- null = merchant not mapped
  short_order_number  text not null,                                     -- unique per merchant per day
  order_type          text not null,                                     -- featureFlags.orderType
  accepted_type       text not null check (accepted_type in ('AUTO', 'MANUAL')),
  payment_type        text not null check (payment_type in ('CASH', 'CASHLESS')),
  state               text not null default 'SUBMITTED',                 -- then Push order state's values
  subtotal_sen        integer not null,
  total_sen           integer,
  cutlery             boolean not null default false,
  order_time          timestamptz not null,
  scheduled_time      timestamptz,
  unmatched_items     jsonb not null default '[]',                       -- item ids that are no Grab menu variant
  payload             jsonb not null,                                    -- the Submit order body as received
  last_state_payload  jsonb,
  bill_id             uuid references bills(id),                         -- set when the POS takes it in (later)
  received_at         timestamptz not null default now(),
  state_at            timestamptz not null default now(),
  accepted_at         timestamptz,
  ready_at            timestamptz
);
create index if not exists grab_orders_branch_received on grab_orders (branch_id, received_at desc);

-- ── G3 Events ───────────────────────────────────────────────────────────────
create table if not exists grab_events (
  id             bigint generated always as identity primary key,
  direction      text not null check (direction in ('in', 'out')),
  kind           text not null,                                          -- oauth, get_menu, submit_order, …
  merchant_id    text,
  grab_order_id  text,
  body           jsonb,
  http_status    integer,
  error          text,
  at             timestamptz not null default now()
);
create index if not exists grab_events_at on grab_events (at desc);

do $$
declare t text;
begin
  foreach t in array array['grab_stores', 'grab_orders', 'grab_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('drop policy if exists grab_read on %I', t);
    execute format('create policy grab_read on %I for select to authenticated using (has_menu_cap(''access_settings''))', t);
  end loop;
end $$;

drop policy if exists grab_stores_write on grab_stores;
create policy grab_stores_write on grab_stores for all to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));

-- ── G4 The menu the function sends Grab ────────────────────────────────────
-- Like qr_menu: the catalog's own prices (a variant without one is not offered), its order,
-- products the catalog sells everywhere ('all'; counter_only stays off Grab), the outlet's
-- sold-out marks. Time slots are not applied yet: Grab gets one all-day selling time.
create or replace function grab_menu_source(p_merchant_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'merchantId', s.merchant_id,
    'branchId', s.branch_id,
    'catalogId', s.catalog_id,
    'isActive', s.is_active,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'description', p.description,
               'categoryId', mc.id, 'categoryName', mc.name, 'categorySort', mc.sort_order,
               'sort', cp.sort_order,
               'soldOut', coalesce(bms.is_sold_out, false),
               'variants', (select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'priceSen', cvp.price_sen,
                                                                'isBase', v.feedme_variant_key = '')
                                             order by v.sort_order, v.name)
                              from menu_variants v
                              join catalog_variant_prices cvp on cvp.catalog_id = s.catalog_id and cvp.variant_id = v.id
                             where v.product_id = p.id and v.is_active),
               'groups', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select,
                          'options', coalesce((
                            select jsonb_agg(jsonb_build_object(
                                     'id', o.id, 'name', o.name,
                                     'priceDeltaSen', coalesce(cop.price_delta_sen, o.price_delta_sen),
                                     'available', not coalesce(obs.is_sold_out, false))
                                   order by o.sort_order, o.name)
                              from modifier_options o
                              left join catalog_option_prices cop on cop.catalog_id = s.catalog_id and cop.option_id = o.id
                              left join branch_menu_status obs on obs.branch_id = s.branch_id and obs.product_id = o.product_id
                             where o.group_id = g.id and o.availability = 'all'), '[]'::jsonb))
                        order by pmg.sort_order, g.name)
                   from product_modifier_groups pmg
                   join modifier_groups g on g.id = pmg.group_id and g.is_active
                  where pmg.product_id = p.id), '[]'::jsonb)
             ) order by mc.sort_order, mc.name, cp.sort_order, p.name)
        from catalog_products cp
        join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
        join menu_categories mc on mc.id = p.category_id and mc.is_active
        left join branch_menu_status bms on bms.branch_id = s.branch_id and bms.product_id = p.id
       where cp.catalog_id = s.catalog_id and cp.availability = 'all'
         and exists (select 1 from menu_variants v
                       join catalog_variant_prices cvp on cvp.catalog_id = s.catalog_id and cvp.variant_id = v.id
                      where v.product_id = p.id and v.is_active)), '[]'::jsonb))
  from grab_stores s
  where s.merchant_id = p_merchant_id
$$;

revoke all on function grab_menu_source(text) from public, anon, authenticated;
grant execute on function grab_menu_source(text) to service_role;

notify pgrst, 'reload schema';

select 'grab schema applied' as result;
