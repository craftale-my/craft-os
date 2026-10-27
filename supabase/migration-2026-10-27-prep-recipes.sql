-- ============================================================================
-- Craft OS — Prep-batch (semi-finished) recipes + production runs
-- (brief §7.3, §7.4, §8 step 11 — item-based only, no menu recipes)
-- (2026-10-27)
--
-- What this adds:
--   * items.category CHECK widened with 'semi_finished' and 'finished'
--     (brief §7.3; drop + re-add with a strictly larger set). A prep batch
--     (e.g. frosting, sponge base) is a normal items row with
--     category = 'semi_finished'. 'finished' is allowed now but unused.
--   * inventory_transactions.transaction_type CHECK widened with
--     'production_out' and 'production_in' (brief §7.1; strictly larger set).
--   * recipes: one row per VERSION of a prep-batch recipe.
--       item_id (the semi-finished output), version (1, 2, ...), yield_qty
--       (base units of the output per batch), effective_from (business date),
--       status ('active' | 'archived'), verified_at / verified_by, notes.
--     Versioning: a production run uses the active, verified version with
--     the latest effective_from <= the business date of the run. A new
--     version therefore supersedes the old one from its effective date on;
--     old versions stay for history. No loss % field (brief §7.4).
--   * recipe_lines: recipe_id, item_id, qty_base — ALWAYS the ingredient's
--     base unit (g / ml / pcs). No unit column, no mass<->volume conversion.
--   * production_batches / production_batch_lines: the source document of
--     each production run, with the cost actually used.
--   * recipe_cost_estimate view: current rolled-up batch / unit cost of each
--     recipe version at each branch, from the branch's moving-average costs.
--   * RPCs (SECURITY DEFINER, search_path pinned, live-staff checks):
--       save_recipe_version(...)  manager+ (manage_procurement). Creates a
--                                 new version with its lines; a manager
--                                 saving it counts as verified (brief §7.4
--                                 verified_at gate).
--       preview_production(...)   supervisor+ at the branch; need vs on hand
--                                 and the cost the run would book.
--       produce_batch(...)        supervisor+ at the branch. Brief §8 calls
--                                 this record_production(); named
--                                 produce_batch per PM.
--
-- Costing (moving-average design, see migration-2026-10-27-cost-fix.sql):
--   each ingredient leaves as production_out at its current moving-average
--   cost at the branch; the output comes in as production_in at
--   unit cost = total ingredient cost / output quantity. The two sides net
--   to zero, so total stock value at the branch does not change.
--
-- Prerequisites: migration-2026-10-27-wastage.sql,
--   migration-2026-10-27-internal-transfers.sql (ledger check below includes
--   the transfer types), migration-2026-10-27-procurement-function-grants.sql.
-- Re-runnable until migration-2026-10-28-inventory-review-fixes.sql has run; after that it STOPS (re-running
-- it would put back older function versions — re-run the later file instead).
-- ============================================================================

-- Stop if a later file already replaced what this one defines.
do $$
begin
  if to_regprocedure('public.guard_po_status_client()') is not null then
    raise exception 'STOP: migration-2026-10-27-prep-recipes.sql is superseded by migration-2026-10-28-inventory-review-fixes.sql. Re-running it would restore older function versions; re-run migration-2026-10-28-inventory-review-fixes.sql instead.';
  end if;
end $$;

-- 1. Wider checks ------------------------------------------------------------
alter table items drop constraint if exists items_category_check;
alter table items add constraint items_category_check
  check (category in ('raw', 'packaging', 'other', 'semi_finished', 'finished'));

alter table inventory_transactions
  drop constraint if exists inventory_transactions_transaction_type_check;
alter table inventory_transactions
  add constraint inventory_transactions_transaction_type_check
  check (transaction_type in ('stock_in', 'adjustment', 'wastage',
                              'transfer_out', 'transfer_in',
                              'production_out', 'production_in'));

-- 2. Recipes -----------------------------------------------------------------
create table if not exists recipes (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references items(id),
  version        integer not null check (version > 0),
  yield_qty      numeric not null check (yield_qty > 0),
  effective_from date not null,
  status         text not null default 'active' check (status in ('active', 'archived')),
  verified_at    timestamptz,
  verified_by    uuid references staff(id),
  notes          text,
  created_by     uuid references staff(id),
  created_at     timestamptz not null default now(),
  unique (item_id, version)
);
create unique index if not exists recipes_item_effective_active_uidx
  on recipes (item_id, effective_from) where status = 'active';

create table if not exists recipe_lines (
  id        uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipes(id) on delete cascade,
  item_id   uuid not null references items(id),
  qty_base  numeric not null check (qty_base > 0),
  sort_order integer not null default 0,
  unique (recipe_id, item_id)
);
create index if not exists recipe_lines_recipe_idx on recipe_lines (recipe_id);

-- 3. Production runs ---------------------------------------------------------
create table if not exists production_batches (
  id              uuid primary key default gen_random_uuid(),
  recipe_id       uuid not null references recipes(id),
  item_id         uuid not null references items(id),
  branch_id       uuid not null references branches(id),
  batches         numeric not null check (batches > 0),
  output_qty      numeric not null check (output_qty > 0),
  total_cost      numeric not null check (total_cost >= 0),
  unit_cost       numeric not null check (unit_cost >= 0),
  business_date   date not null,
  note            text,
  transaction_id  uuid references inventory_transactions(id),
  created_by      uuid references staff(id),
  created_at      timestamptz not null default now()
);
create index if not exists production_batches_branch_idx
  on production_batches (branch_id, created_at desc);
create index if not exists production_batches_item_idx
  on production_batches (item_id, created_at desc);

create table if not exists production_batch_lines (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references production_batches(id) on delete cascade,
  item_id        uuid not null references items(id),
  qty_base       numeric not null check (qty_base > 0),
  unit_cost      numeric not null check (unit_cost >= 0),
  line_cost      numeric not null check (line_cost >= 0),
  transaction_id uuid references inventory_transactions(id)
);
create index if not exists production_batch_lines_batch_idx
  on production_batch_lines (batch_id);

-- 4. RLS: read for procurement users; every write goes through an RPC ---------
alter table recipes                enable row level security;
alter table recipe_lines           enable row level security;
alter table production_batches     enable row level security;
alter table production_batch_lines enable row level security;

drop policy if exists recipes_select on recipes;
create policy recipes_select on recipes for select to authenticated
  using (has_procurement_cap('use_procurement'));

drop policy if exists recipe_lines_select on recipe_lines;
create policy recipe_lines_select on recipe_lines for select to authenticated
  using (has_procurement_cap('use_procurement'));

drop policy if exists production_batches_select on production_batches;
create policy production_batches_select on production_batches for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

drop policy if exists production_batch_lines_select on production_batch_lines;
create policy production_batch_lines_select on production_batch_lines for select to authenticated
  using (exists (select 1 from production_batches b
                  where b.id = batch_id
                    and has_procurement_cap('use_procurement')
                    and can_access_branch(b.branch_id)));

revoke all on recipes, recipe_lines, production_batches, production_batch_lines
  from public, anon, authenticated;
grant select on recipes, recipe_lines, production_batches, production_batch_lines
  to authenticated;

-- 5. Cost estimate view (security_invoker: the caller's RLS applies) ---------
-- Current rolled-up cost of every recipe version at every active branch, using
-- the branch's moving-average cost (inventory_valuation.avg_unit_cost) and the
-- catalogue price when the branch holds none of an ingredient.
create or replace view recipe_cost_estimate
with (security_invoker = true) as
select r.id   as recipe_id,
       r.item_id,
       r.version,
       b.id   as branch_id,
       r.yield_qty,
       sum(l.qty_base * coalesce(v.avg_unit_cost,
                                 i.latest_price / nullif(i.conversion_rate, 0)))
         as batch_cost,
       sum(l.qty_base * coalesce(v.avg_unit_cost,
                                 i.latest_price / nullif(i.conversion_rate, 0)))
         / r.yield_qty as unit_cost,
       bool_or(coalesce(v.avg_unit_cost,
                        i.latest_price / nullif(i.conversion_rate, 0)) is null)
         as missing_cost
  from recipes r
  join recipe_lines l on l.recipe_id = r.id
  join items i        on i.id = l.item_id
  cross join branches b
  left join inventory_valuation v on v.item_id = l.item_id and v.branch_id = b.id
 where b.is_active
 group by r.id, r.item_id, r.version, b.id, r.yield_qty;

revoke all on recipe_cost_estimate from public, anon, authenticated;
grant select on recipe_cost_estimate to authenticated;

-- 6. Which version applies on a date (internal helper) -----------------------
create or replace function recipe_for_date(p_item_id uuid, p_date date)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id
    from recipes r
   where r.item_id = p_item_id
     and r.status = 'active'
     and r.verified_at is not null
     and r.effective_from <= p_date
   order by r.effective_from desc, r.version desc
   limit 1;
$$;
revoke all on function recipe_for_date(uuid, date) from public, anon, authenticated;

-- 7. save_recipe_version -----------------------------------------------------
-- p_lines: [{"item_id": "...", "qty_base": 500}, ...]  (base units)
create or replace function save_recipe_version(
  p_item_id        uuid,
  p_yield_qty      numeric,
  p_effective_from date,
  p_lines          jsonb,
  p_notes          text default null
) returns recipes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item    items%rowtype;
  v_recipe  recipes%rowtype;
  v_version integer;
  v_line    jsonb;
  v_ing     items%rowtype;
  v_qty     numeric;
  v_n       integer := 0;
begin
  if not has_procurement_cap('manage_procurement') then
    raise exception 'Only managers can create or change recipes';
  end if;

  select * into v_item from items where id = p_item_id;
  if not found then
    raise exception 'Item not found';
  end if;
  if v_item.category <> 'semi_finished' then
    raise exception 'Recipes are for semi-finished (prep batch) items only';
  end if;
  if v_item.status <> 'active' then
    raise exception 'Item is inactive';
  end if;
  if p_yield_qty is null or p_yield_qty <= 0 then
    raise exception 'Yield must be greater than zero';
  end if;
  if p_effective_from is null then
    raise exception 'Effective-from date is required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A recipe needs at least one ingredient';
  end if;

  -- One writer per item at a time (version numbers, effective-date clash).
  perform pg_advisory_xact_lock(hashtext('recipe:' || p_item_id::text));

  if exists (select 1 from recipes
              where item_id = p_item_id and status = 'active'
                and effective_from = p_effective_from) then
    raise exception 'A version of this recipe already starts on %', p_effective_from;
  end if;

  select coalesce(max(version), 0) + 1 into v_version from recipes where item_id = p_item_id;

  insert into recipes (item_id, version, yield_qty, effective_from, status,
                       verified_at, verified_by, notes, created_by)
  values (p_item_id, v_version, p_yield_qty, p_effective_from, 'active',
          now(), auth.uid(), nullif(btrim(p_notes), ''), auth.uid())
  returning * into v_recipe;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    begin
      v_qty := (v_line->>'qty_base')::numeric;
    exception when others then
      raise exception 'Line %: quantity is not a number', v_n;
    end;
    select * into v_ing from items where id = (v_line->>'item_id')::uuid;
    if not found then
      raise exception 'Line %: ingredient not found', v_n;
    end if;
    if v_ing.id = p_item_id then
      raise exception 'A recipe cannot use its own output as an ingredient';
    end if;
    if v_ing.status <> 'active' then
      raise exception 'Ingredient % is inactive', v_ing.name;
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Ingredient %: quantity must be greater than zero', v_ing.name;
    end if;
    if exists (select 1 from recipe_lines where recipe_id = v_recipe.id and item_id = v_ing.id) then
      raise exception 'Ingredient % is listed twice', v_ing.name;
    end if;
    insert into recipe_lines (recipe_id, item_id, qty_base, sort_order)
    values (v_recipe.id, v_ing.id, v_qty, v_n);
  end loop;

  return v_recipe;
end;
$$;

-- 8. preview_production ------------------------------------------------------
-- Returns the version that applies today, need vs on hand per ingredient and
-- the cost produce_batch would book (same cost function). Read-only.
create or replace function preview_production(
  p_item_id   uuid,
  p_branch_id uuid,
  p_batches   numeric default 1
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_date   date := business_date_of(now());
  v_recipe recipes%rowtype;
  v_lines  jsonb;
  v_total  numeric;
  v_short  boolean;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to produce batches';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised to produce at this branch';
  end if;
  if p_batches is null or p_batches <= 0 then
    raise exception 'Number of batches must be greater than zero';
  end if;

  select * into v_recipe from recipes where id = recipe_for_date(p_item_id, v_date);
  if not found then
    raise exception 'No verified recipe is in effect for this item on %', v_date;
  end if;

  select jsonb_agg(x order by x.sort_order),
         sum(x.line_cost),
         bool_or(x.short)
    into v_lines, v_total, v_short
    from (
      select l.sort_order,
             l.item_id,
             i.name,
             i.base_unit,
             l.qty_base * p_batches as need,
             coalesce(oh.on_hand, 0) as on_hand,
             inventory_avg_unit_cost(l.item_id, p_branch_id, null) as unit_cost,
             l.qty_base * p_batches
               * coalesce(inventory_avg_unit_cost(l.item_id, p_branch_id, null), 0) as line_cost,
             coalesce(oh.on_hand, 0) < l.qty_base * p_batches as short
        from recipe_lines l
        join items i on i.id = l.item_id
        left join lateral (
          select sum(t.quantity) as on_hand
            from inventory_transactions t
           where t.item_id = l.item_id and t.branch_id = p_branch_id
        ) oh on true
       where l.recipe_id = v_recipe.id
    ) x;

  return jsonb_build_object(
    'recipe_id',      v_recipe.id,
    'version',        v_recipe.version,
    'effective_from', v_recipe.effective_from,
    'business_date',  v_date,
    'yield_qty',      v_recipe.yield_qty,
    'batches',        p_batches,
    'output_qty',     v_recipe.yield_qty * p_batches,
    'lines',          coalesce(v_lines, '[]'::jsonb),
    'total_cost',     coalesce(v_total, 0),
    'unit_cost',      coalesce(v_total, 0) / (v_recipe.yield_qty * p_batches),
    'can_produce',    not coalesce(v_short, false)
  );
end;
$$;

-- 9. produce_batch -----------------------------------------------------------
create or replace function produce_batch(
  p_item_id   uuid,
  p_branch_id uuid,
  p_batches   numeric default 1,
  p_note      text default null
) returns production_batches
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date    date := business_date_of(now());
  v_item    items%rowtype;
  v_recipe  recipes%rowtype;
  v_batch   production_batches%rowtype;
  v_out_qty numeric;
  v_total   numeric := 0;
  v_short   text := '';
  v_tx_id   uuid;
  r         record;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to produce batches';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised to produce at this branch';
  end if;
  if p_batches is null or p_batches <= 0 then
    raise exception 'Number of batches must be greater than zero';
  end if;
  if not exists (select 1 from branches where id = p_branch_id and is_active) then
    raise exception 'Branch not found';
  end if;

  select * into v_item from items where id = p_item_id;
  if not found then
    raise exception 'Item not found';
  end if;
  if v_item.category <> 'semi_finished' or v_item.status <> 'active' then
    raise exception 'Item is not an active semi-finished item';
  end if;

  select * into v_recipe from recipes where id = recipe_for_date(p_item_id, v_date);
  if not found then
    raise exception 'No verified recipe is in effect for this item on %', v_date;
  end if;
  v_out_qty := v_recipe.yield_qty * p_batches;

  -- Same stock-out lock as wastage and shipping; taken in item order so two
  -- runs sharing ingredients cannot deadlock.
  for r in select l.item_id from recipe_lines l
            where l.recipe_id = v_recipe.id order by l.item_id loop
    perform pg_advisory_xact_lock(hashtext('stock_out:' || r.item_id::text || ':' || p_branch_id::text));
  end loop;

  -- Shortage check: list every short ingredient in one message.
  for r in
    select i.name, i.base_unit, i.status, l.qty_base * p_batches as need,
           coalesce((select sum(t.quantity) from inventory_transactions t
                      where t.item_id = l.item_id and t.branch_id = p_branch_id), 0) as on_hand
      from recipe_lines l join items i on i.id = l.item_id
     where l.recipe_id = v_recipe.id
     order by l.sort_order
  loop
    if r.status <> 'active' then
      raise exception 'Ingredient % is inactive', r.name;
    end if;
    if r.need > r.on_hand then
      v_short := v_short || case when v_short = '' then '' else '; ' end
        || format('%s needs %s %s, only %s %s on hand',
                  r.name,
                  rtrim(to_char(r.need, 'FM999999990.999'), '.'), r.base_unit,
                  rtrim(to_char(r.on_hand, 'FM999999990.999'), '.'), r.base_unit);
    end if;
  end loop;
  if v_short <> '' then
    raise exception 'Not enough stock to produce %: %', v_item.name, v_short;
  end if;

  insert into production_batches (recipe_id, item_id, branch_id, batches, output_qty,
                                  total_cost, unit_cost, business_date, note, created_by)
  values (v_recipe.id, p_item_id, p_branch_id, p_batches, v_out_qty,
          0, 0, v_date, nullif(btrim(p_note), ''), auth.uid())
  returning * into v_batch;

  -- Ingredients out at their current moving-average cost.
  for r in
    select l.item_id, l.qty_base * p_batches as qty,
           coalesce(inventory_avg_unit_cost(l.item_id, p_branch_id, null), 0) as unit_cost
      from recipe_lines l
     where l.recipe_id = v_recipe.id
     order by l.sort_order
  loop
    insert into inventory_transactions (item_id, branch_id, transaction_type, quantity,
                                        reference_type, reference_id, created_by,
                                        notes, unit_cost)
    values (r.item_id, p_branch_id, 'production_out', -r.qty,
            'production', v_batch.id, auth.uid(),
            'Used in ' || v_item.name, r.unit_cost)
    returning id into v_tx_id;

    insert into production_batch_lines (batch_id, item_id, qty_base, unit_cost, line_cost, transaction_id)
    values (v_batch.id, r.item_id, r.qty, r.unit_cost, r.qty * r.unit_cost, v_tx_id);

    v_total := v_total + r.qty * r.unit_cost;
  end loop;

  -- Output in at total cost / output quantity.
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity,
                                      reference_type, reference_id, created_by,
                                      notes, unit_cost)
  values (p_item_id, p_branch_id, 'production_in', v_out_qty,
          'production', v_batch.id, auth.uid(),
          format('Batch of %s (recipe v%s)', v_item.name, v_recipe.version),
          v_total / v_out_qty)
  returning id into v_tx_id;

  update production_batches
     set total_cost = v_total,
         unit_cost  = v_total / v_out_qty,
         transaction_id = v_tx_id
   where id = v_batch.id
  returning * into v_batch;

  return v_batch;
end;
$$;

-- 10. Grants -----------------------------------------------------------------
revoke all on function save_recipe_version(uuid, numeric, date, jsonb, text) from public, anon;
grant execute on function save_recipe_version(uuid, numeric, date, jsonb, text) to authenticated;
revoke all on function preview_production(uuid, uuid, numeric) from public, anon;
grant execute on function preview_production(uuid, uuid, numeric) to authenticated;
revoke all on function produce_batch(uuid, uuid, numeric, text) from public, anon;
grant execute on function produce_batch(uuid, uuid, numeric, text) to authenticated;
