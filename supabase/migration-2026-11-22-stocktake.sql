-- ============================================================================
-- Craft OS — Stocktake (2026-11-22)
--
-- Storage locations per branch, a weekly "key item" flag, and stock counts:
-- staff enter counts (blind) per item and location; submit_stock_count sets
-- each item's balance to the counted total with one 'stocktake' ledger row
-- per item that differs, costed at the branch's moving average.
-- Spec: docs/superpowers/specs/2026-11-22-stocktake-design.md
-- Additive and idempotent. Run on dev first.
-- ============================================================================

-- 1. Key items ---------------------------------------------------------------
alter table items add column if not exists count_weekly boolean not null default false;

-- 2. Ledger type ---------------------------------------------------------------
alter table inventory_transactions
  drop constraint if exists inventory_transactions_transaction_type_check;
alter table inventory_transactions
  add constraint inventory_transactions_transaction_type_check
  check (transaction_type in ('stock_in', 'adjustment', 'wastage',
                              'transfer_out', 'transfer_in',
                              'production_out', 'production_in',
                              'stocktake'));

-- 3. Tables --------------------------------------------------------------------
create table if not exists storage_locations (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches(id),
  name       text not null check (btrim(name) <> ''),
  sort_order int  not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists storage_locations_branch_name_uidx
  on storage_locations (branch_id, lower(btrim(name)));

create table if not exists item_locations (
  item_id     uuid not null references items(id) on delete cascade,
  location_id uuid not null references storage_locations(id) on delete cascade,
  sort_order  int  not null default 0,
  primary key (item_id, location_id)
);
create index if not exists item_locations_location_idx on item_locations (location_id);

create table if not exists stock_counts (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  kind         text not null check (kind in ('weekly', 'full')),
  status       text not null default 'in_progress'
                 check (status in ('in_progress', 'submitted', 'cancelled')),
  started_by   uuid references staff(id),
  started_at   timestamptz not null default now(),
  submitted_by uuid references staff(id),
  submitted_at timestamptz,
  business_date date,
  notes        text,
  item_count   int,
  gain_value   numeric,
  loss_value   numeric,
  net_value    numeric
);
create unique index if not exists stock_counts_one_open_uidx
  on stock_counts (branch_id) where status = 'in_progress';
create index if not exists stock_counts_branch_started_idx
  on stock_counts (branch_id, started_at desc);

create table if not exists stock_count_entries (
  id           uuid primary key default gen_random_uuid(),
  count_id     uuid not null references stock_counts(id) on delete cascade,
  item_id      uuid not null references items(id),
  location_id  uuid references storage_locations(id),
  counted_base numeric not null check (counted_base >= 0),
  counted_by   uuid references staff(id),
  counted_at   timestamptz not null default now()
);
create unique index if not exists stock_count_entries_uidx
  on stock_count_entries (count_id, item_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists stock_count_items (
  count_id       uuid not null references stock_counts(id) on delete cascade,
  item_id        uuid not null references items(id),
  counted_base   numeric not null,
  expected_base  numeric not null,
  variance_base  numeric not null,
  unit_cost      numeric,
  variance_value numeric not null default 0,
  transaction_id uuid references inventory_transactions(id),
  primary key (count_id, item_id)
);

-- 4. RLS: reads by branch; writes only through the functions below -----------
alter table storage_locations   enable row level security;
alter table item_locations      enable row level security;
alter table stock_counts        enable row level security;
alter table stock_count_entries enable row level security;
alter table stock_count_items   enable row level security;

drop policy if exists storage_locations_select on storage_locations;
create policy storage_locations_select on storage_locations for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

drop policy if exists item_locations_select on item_locations;
create policy item_locations_select on item_locations for select to authenticated
  using (has_procurement_cap('use_procurement') and exists (
    select 1 from storage_locations l where l.id = location_id and can_access_branch(l.branch_id)));

drop policy if exists stock_counts_select on stock_counts;
create policy stock_counts_select on stock_counts for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

drop policy if exists stock_count_entries_select on stock_count_entries;
create policy stock_count_entries_select on stock_count_entries for select to authenticated
  using (has_procurement_cap('use_procurement') and exists (
    select 1 from stock_counts c where c.id = count_id and can_access_branch(c.branch_id)));

drop policy if exists stock_count_items_select on stock_count_items;
create policy stock_count_items_select on stock_count_items for select to authenticated
  using (has_procurement_cap('use_procurement') and exists (
    select 1 from stock_counts c where c.id = count_id and can_access_branch(c.branch_id)));

revoke all on storage_locations, item_locations, stock_counts, stock_count_entries, stock_count_items
  from anon, authenticated;
grant select on storage_locations, item_locations, stock_counts, stock_count_entries, stock_count_items
  to authenticated;

-- 5. Setup functions (managers) -----------------------------------------------
create or replace function save_storage_location(
  p_id uuid, p_branch_id uuid, p_name text, p_sort_order int, p_is_active boolean
) returns storage_locations
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_row storage_locations%rowtype;
  v_name text := nullif(btrim(p_name), '');
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to manage storage locations';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised for this branch';
  end if;
  if v_name is null then
    raise exception 'Location name is required';
  end if;
  begin
    if p_id is null then
      insert into storage_locations (branch_id, name, sort_order, is_active)
      values (p_branch_id, v_name, coalesce(p_sort_order, 0), coalesce(p_is_active, true))
      returning * into v_row;
    else
      update storage_locations
         set name = v_name, sort_order = coalesce(p_sort_order, sort_order),
             is_active = coalesce(p_is_active, is_active)
       where id = p_id and branch_id = p_branch_id
      returning * into v_row;
      if not found then
        raise exception 'Location not found';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'A location called "%" already exists at this branch', v_name;
  end;
  return v_row;
end;
$$;

create or replace function set_location_items(p_location_id uuid, p_item_ids uuid[])
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_branch uuid;
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to manage storage locations';
  end if;
  select branch_id into v_branch from storage_locations where id = p_location_id;
  if not found then
    raise exception 'Location not found';
  end if;
  if not can_access_branch(v_branch) then
    raise exception 'Not authorised for this branch';
  end if;
  delete from item_locations where location_id = p_location_id;
  insert into item_locations (item_id, location_id, sort_order)
  select x.item_id, p_location_id, x.ord::int
    from unnest(coalesce(p_item_ids, '{}')) with ordinality as x(item_id, ord)
   where exists (select 1 from items i where i.id = x.item_id)
  on conflict (item_id, location_id) do nothing;
end;
$$;

create or replace function set_item_count_weekly(p_item_id uuid, p_value boolean)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Not authorised to change key items';
  end if;
  update items set count_weekly = coalesce(p_value, false) where id = p_item_id;
  if not found then
    raise exception 'Item not found';
  end if;
end;
$$;

-- 6. Counting functions (anyone with use_procurement at the branch) -----------
create or replace function start_stock_count(p_branch_id uuid, p_kind text)
returns stock_counts
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_row  stock_counts%rowtype;
  v_open uuid;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to count stock';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised to count stock at this branch';
  end if;
  if p_kind is null or p_kind not in ('weekly', 'full') then
    raise exception 'Unknown count type: %', coalesce(p_kind, '(none)');
  end if;
  if not exists (select 1 from branches where id = p_branch_id and is_active) then
    raise exception 'Branch not found';
  end if;
  -- An empty count could never be submitted (nothing to count), so refuse it up front.
  if p_kind = 'weekly' and not exists (select 1 from items where status = 'active' and count_weekly) then
    raise exception 'No key items yet. A manager marks key items under Locations & key items.';
  end if;
  if p_kind = 'full' and not exists (select 1 from items where status = 'active') then
    raise exception 'There are no active items to count.';
  end if;
  select id into v_open from stock_counts where branch_id = p_branch_id and status = 'in_progress';
  if found then
    raise exception 'A count is already in progress at this branch (%)', v_open;
  end if;
  begin
    insert into stock_counts (branch_id, kind, started_by)
    values (p_branch_id, p_kind, auth.uid())
    returning * into v_row;
  exception when unique_violation then
    select id into v_open from stock_counts where branch_id = p_branch_id and status = 'in_progress';
    raise exception 'A count is already in progress at this branch (%)', v_open;
  end;
  return v_row;
end;
$$;

create or replace function save_count_entry(
  p_count_id uuid, p_item_id uuid, p_location_id uuid, p_counted_base numeric
) returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_count stock_counts%rowtype;
  v_loc_active boolean;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to count stock';
  end if;
  -- Share lock: waits for a submit in flight, then sees its status.
  select * into v_count from stock_counts where id = p_count_id for share;
  if not found then
    raise exception 'Count not found';
  end if;
  if not can_access_branch(v_count.branch_id) then
    raise exception 'Not authorised to count stock at this branch';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'This count is no longer open';
  end if;
  if not exists (select 1 from items where id = p_item_id) then
    raise exception 'Item not found';
  end if;
  if p_location_id is not null then
    select is_active into v_loc_active
      from storage_locations where id = p_location_id and branch_id = v_count.branch_id;
    if not found then
      raise exception 'Location not found at this branch';
    end if;
    -- A removed location takes no new numbers; clearing an old entry there (null) is still allowed.
    if not v_loc_active and p_counted_base is not null then
      raise exception 'This location has been removed. Clear this entry and count the item at its current location.';
    end if;
  end if;

  if p_counted_base is null then
    delete from stock_count_entries
     where count_id = p_count_id and item_id = p_item_id
       and location_id is not distinct from p_location_id;
    return;
  end if;
  if p_counted_base < 0 then
    raise exception 'Counted quantity cannot be negative';
  end if;

  insert into stock_count_entries (count_id, item_id, location_id, counted_base, counted_by, counted_at)
  values (p_count_id, p_item_id, p_location_id, round(p_counted_base, 3), auth.uid(), now())
  on conflict (count_id, item_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set counted_base = excluded.counted_base,
                counted_by   = excluded.counted_by,
                counted_at   = excluded.counted_at;
end;
$$;

create or replace function cancel_stock_count(p_count_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_count stock_counts%rowtype;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to count stock';
  end if;
  select * into v_count from stock_counts where id = p_count_id for update;
  if not found then
    raise exception 'Count not found';
  end if;
  if not can_access_branch(v_count.branch_id) then
    raise exception 'Not authorised to count stock at this branch';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'This count is no longer open';
  end if;
  if v_count.started_by is distinct from auth.uid() and not has_procurement_cap('manage_procurement') then
    raise exception 'Only the person who started this count or a manager can cancel it';
  end if;
  update stock_counts set status = 'cancelled' where id = p_count_id;
end;
$$;

create or replace function submit_stock_count(p_count_id uuid)
returns stock_counts
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_count    stock_counts%rowtype;
  v_missing  int;
  r          record;
  v_expected numeric;
  v_variance numeric;
  v_cost     numeric;
  v_value    numeric;
  v_tx       uuid;
  v_gain     numeric := 0;
  v_loss     numeric := 0;
  v_n        int := 0;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to count stock';
  end if;
  select * into v_count from stock_counts where id = p_count_id for update;
  if not found then
    raise exception 'Count not found';
  end if;
  if not can_access_branch(v_count.branch_id) then
    raise exception 'Not authorised to count stock at this branch';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'This count is no longer open';
  end if;

  -- Every active location an item is linked to at this branch needs its own
  -- number (0 is valid). An item linked to no active location here needs an
  -- entry at all (Unassigned, or anywhere, so a layout change mid-count is tolerated).
  select
    (select count(*)
       from items i
       join item_locations il on il.item_id = i.id
       join storage_locations sl on sl.id = il.location_id
            and sl.branch_id = v_count.branch_id and sl.is_active
      where i.status = 'active'
        and (v_count.kind = 'full' or i.count_weekly)
        and not exists (select 1 from stock_count_entries e
                         where e.count_id = p_count_id and e.item_id = i.id
                           and e.location_id = sl.id))
    +
    (select count(*)
       from items i
      where i.status = 'active'
        and (v_count.kind = 'full' or i.count_weekly)
        and not exists (select 1 from item_locations il
                          join storage_locations sl on sl.id = il.location_id
                               and sl.branch_id = v_count.branch_id and sl.is_active
                         where il.item_id = i.id)
        and not exists (select 1 from stock_count_entries e
                         where e.count_id = p_count_id and e.item_id = i.id))
    into v_missing;
  if v_missing > 0 then
    raise exception '% spot(s) not counted yet', v_missing;
  end if;

  for r in
    select i.id as item_id, sum(e.counted_base) as counted
      from items i
      join stock_count_entries e on e.item_id = i.id and e.count_id = p_count_id
     where i.status = 'active' and (v_count.kind = 'full' or i.count_weekly)
     group by i.id
     order by i.id
  loop
    perform pg_advisory_xact_lock(hashtext('stock_out:' || r.item_id::text || ':' || v_count.branch_id::text));
    select coalesce(sum(quantity), 0) into v_expected
      from inventory_transactions
     where item_id = r.item_id and branch_id = v_count.branch_id;
    v_variance := r.counted - v_expected;
    -- NULL when no cost is known anywhere: the ledger row keeps unit_cost NULL
    -- (the stamp trigger's helper also returns NULL) and the line is worth RM 0.
    v_cost := inventory_avg_unit_cost(r.item_id, v_count.branch_id, null);
    v_value := coalesce(round(v_variance * v_cost, 2), 0);
    v_tx := null;
    if v_variance <> 0 then
      insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost,
                                          reference_type, reference_id, created_by, notes)
      values (r.item_id, v_count.branch_id, 'stocktake', v_variance, v_cost,
              'stock_count', p_count_id, auth.uid(), initcap(v_count.kind) || ' stock count')
      returning id into v_tx;
    end if;
    insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base,
                                   unit_cost, variance_value, transaction_id)
    values (p_count_id, r.item_id, r.counted, v_expected, v_variance, v_cost, v_value, v_tx);
    if v_value > 0 then
      v_gain := v_gain + v_value;
    elsif v_value < 0 then
      v_loss := v_loss - v_value;
    end if;
    v_n := v_n + 1;
  end loop;

  update stock_counts
     set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(),
         business_date = business_date_of(now()), item_count = v_n,
         gain_value = v_gain, loss_value = v_loss, net_value = v_gain - v_loss
   where id = p_count_id
  returning * into v_count;
  return v_count;
end;
$$;

-- 7. Grants ----------------------------------------------------------------------
revoke all on function save_storage_location(uuid, uuid, text, int, boolean) from public, anon;
revoke all on function set_location_items(uuid, uuid[]) from public, anon;
revoke all on function set_item_count_weekly(uuid, boolean) from public, anon;
revoke all on function start_stock_count(uuid, text) from public, anon;
revoke all on function save_count_entry(uuid, uuid, uuid, numeric) from public, anon;
revoke all on function cancel_stock_count(uuid) from public, anon;
revoke all on function submit_stock_count(uuid) from public, anon;
grant execute on function save_storage_location(uuid, uuid, text, int, boolean) to authenticated;
grant execute on function set_location_items(uuid, uuid[]) to authenticated;
grant execute on function set_item_count_weekly(uuid, boolean) to authenticated;
grant execute on function start_stock_count(uuid, text) to authenticated;
grant execute on function save_count_entry(uuid, uuid, uuid, numeric) to authenticated;
grant execute on function cancel_stock_count(uuid) to authenticated;
grant execute on function submit_stock_count(uuid) to authenticated;
