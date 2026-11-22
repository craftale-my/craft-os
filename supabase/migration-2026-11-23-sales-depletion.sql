-- ============================================================================
-- Craft OS — POS sales depletion (2026-11-23)
-- When a bill becomes paid, deduct its ingredients by menu variant and add-on
-- recipes: one 'sale' ledger row per ingredient, costed at the moving average.
-- Never blocks checkout (errors are recorded in bill_depletions).
-- Spec: docs/superpowers/specs/2026-11-23-sales-depletion-design.md
-- Additive and idempotent. Requires the POS, menu costing, stocktake and procurement
-- cost migrations. Never re-run an OLDER migration that rebuilds
-- inventory_transactions_transaction_type_check afterwards: it would drop 'sale'.
-- ============================================================================

-- Never queue long behind live checkouts for a lock: fail fast, retry in a quiet window.
set lock_timeout = '5s';

do $$
begin
  if to_regclass('public.bills') is null or to_regclass('public.menu_variant_recipe_lines') is null
     or to_regclass('public.modifier_recipe_lines') is null or to_regclass('public.stock_counts') is null
     or to_regprocedure('public.has_procurement_cap(text)') is null
     or to_regprocedure('public.can_access_branch(uuid)') is null
     or to_regprocedure('public.inventory_avg_unit_cost(uuid,uuid,timestamp with time zone)') is null
     or to_regprocedure('public.stamp_inventory_unit_cost()') is null then
    raise exception 'Apply the POS, menu costing, stocktake and procurement cost migrations first';
  end if;
end $$;

-- 1. Ledger type ---------------------------------------------------------------
-- Added NOT VALID, then validated (all nine types kept). Skipped when the live constraint
-- already allows 'sale' and is validated, so a re-apply takes no table lock at all.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.inventory_transactions'::regclass
                    and conname = 'inventory_transactions_transaction_type_check'
                    and convalidated
                    and pg_get_constraintdef(oid) like '%''sale''%') then
    alter table inventory_transactions
      drop constraint if exists inventory_transactions_transaction_type_check;
    alter table inventory_transactions
      add constraint inventory_transactions_transaction_type_check
      check (transaction_type in ('stock_in', 'adjustment', 'wastage',
                                  'transfer_out', 'transfer_in',
                                  'production_out', 'production_in',
                                  'stocktake', 'sale')) not valid;
    alter table inventory_transactions
      validate constraint inventory_transactions_transaction_type_check;
  end if;
end $$;

-- Covering index for the per-item balance / moving-average lookups (deplete_bill and
-- inventory_avg_unit_cost): index-only scans instead of heap visits.
-- On prod, build it in a quiet window (a plain CREATE INDEX blocks ledger writes while it builds).
create index if not exists inventory_transactions_item_branch_cover_idx
  on inventory_transactions (item_id, branch_id) include (quantity, unit_cost);

-- 2. One marker per depleted bill --------------------------------------------------
create table if not exists bill_depletions (
  bill_id              uuid primary key references bills(id) on delete cascade,
  branch_id            uuid not null references branches(id),
  depleted_at          timestamptz not null default now(),
  status               text not null check (status in ('done', 'error')),
  error                text,
  lines_without_recipe integer not null default 0
);
create index if not exists bill_depletions_branch_time_idx on bill_depletions (branch_id, depleted_at);

alter table bill_depletions enable row level security;
drop policy if exists bill_depletions_select on bill_depletions;
create policy bill_depletions_select on bill_depletions for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));
revoke all on bill_depletions from anon, authenticated;
grant select on bill_depletions to authenticated;

-- 3. deplete_bill (internal) -------------------------------------------------------
create or replace function deplete_bill(p_bill_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_bill    bills%rowtype;
  v_missing integer;
  r         record;
begin
  select * into v_bill from bills where id = p_bill_id;
  if not found or v_bill.status <> 'paid' then
    return;
  end if;
  if exists (select 1 from bill_depletions where bill_id = p_bill_id) then
    return;
  end if;

  -- Each item's moving-average cost is computed once here, in one aggregate over the whole
  -- item set (same formula and fallbacks as inventory_avg_unit_cost), and inserted explicitly,
  -- so stamp_inventory_unit_cost skips its per-row full-history lookup inside checkout.
  for r in
    with lines as (
      select oi.qty, oi.variant_id,
             case when jsonb_typeof(oi.modifiers_snapshot) = 'array' then oi.modifiers_snapshot else '[]'::jsonb end as mods
        from order_items oi
       where oi.bill_id = p_bill_id and oi.voided_at is null
    ), usage as (
      select vl.item_id, l.qty * vl.qty_base as q
        from lines l
        join menu_variant_recipe_lines vl on vl.variant_id = l.variant_id
      union all
      select ml.item_id, l.qty * ml.qty_base
        from lines l
        cross join lateral jsonb_array_elements(l.mods) as e(mod)
        join modifier_recipe_lines ml on ml.option_id::text = e.mod->>'optionId'
    ), tot as (
      select item_id, sum(q) as total
        from usage
       group by item_id
      having sum(q) <> 0
    ), avg_cost as (
      select t.item_id,
             case when sum(t.quantity) > 0 then sum(t.quantity * t.unit_cost) / sum(t.quantity) end as cost
        from inventory_transactions t
        join tot on tot.item_id = t.item_id
       where t.branch_id = v_bill.branch_id and t.unit_cost is not null
       group by t.item_id
    )
    select tot.item_id, tot.total,
           -- no stock held at the branch: the helper's fallbacks (last receipt, catalogue price)
           coalesce(a.cost, inventory_avg_unit_cost(tot.item_id, v_bill.branch_id, null)) as unit_cost
      from tot
      left join avg_cost a on a.item_id = tot.item_id
  loop
    insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost,
                                        reference_type, reference_id, notes)
    values (r.item_id, v_bill.branch_id, 'sale', -r.total, r.unit_cost, 'bill', p_bill_id, 'Sale ' || v_bill.bill_no);
  end loop;

  select count(*) into v_missing
    from order_items oi
   where oi.bill_id = p_bill_id and oi.voided_at is null
     and not exists (select 1 from menu_variant_recipe_lines vl where vl.variant_id = oi.variant_id);

  insert into bill_depletions (bill_id, branch_id, status, lines_without_recipe)
  values (p_bill_id, v_bill.branch_id, 'done', v_missing);
end;
$$;
revoke all on function deplete_bill(uuid) from public, anon, authenticated;

-- 4. Trigger: deplete whenever a bill is set paid, never blocking -----------------
-- Condition is new.status = 'paid' only, NOT "a transition to paid": split-by-item parts are
-- INSERTed already 'paid' (checkout_items), their lines moved onto them, then UPDATEd to 'paid'
-- again by pos_pay_and_close — old.status is already 'paid' there. deplete_bill's marker check
-- and the bill_depletions primary key keep it to once per bill. No AFTER INSERT trigger: at
-- insert time the part has no lines yet.
create or replace function bills_deplete_on_paid()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform deplete_bill(new.id);
  exception when others then
    -- the error marker itself must never block payment either
    begin
      insert into bill_depletions (bill_id, branch_id, status, error)
      values (new.id, new.branch_id, 'error', left(sqlerrm, 500))
      on conflict (bill_id) do nothing;
    exception when others then
      null;
    end;
  end;
  return null;
end;
$$;
revoke all on function bills_deplete_on_paid() from public, anon, authenticated;

drop trigger if exists bills_deplete_on_paid on bills;
create trigger bills_deplete_on_paid
  after update of status on bills
  for each row
  when (new.status = 'paid')
  execute function bills_deplete_on_paid();
