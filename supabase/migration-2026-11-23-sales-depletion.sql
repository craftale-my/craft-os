-- ============================================================================
-- Craft OS — POS sales depletion (2026-11-23)
-- When a bill becomes paid, deduct its ingredients by menu variant and add-on
-- recipes: one 'sale' ledger row per ingredient, costed at the moving average.
-- Never blocks checkout (errors are recorded in bill_depletions).
-- Spec: docs/superpowers/specs/2026-11-23-sales-depletion-design.md
-- Additive and idempotent. Requires the POS, menu costing and stocktake migrations.
-- ============================================================================

do $$
begin
  if to_regclass('public.bills') is null or to_regclass('public.menu_variant_recipe_lines') is null
     or to_regclass('public.stock_counts') is null then
    raise exception 'Apply the POS, menu costing and stocktake migrations first';
  end if;
end $$;

-- 1. Ledger type ---------------------------------------------------------------
alter table inventory_transactions
  drop constraint if exists inventory_transactions_transaction_type_check;
alter table inventory_transactions
  add constraint inventory_transactions_transaction_type_check
  check (transaction_type in ('stock_in', 'adjustment', 'wastage',
                              'transfer_out', 'transfer_in',
                              'production_out', 'production_in',
                              'stocktake', 'sale'));

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
    )
    select item_id, sum(q) as total
      from usage
     group by item_id
    having sum(q) <> 0
  loop
    insert into inventory_transactions (item_id, branch_id, transaction_type, quantity,
                                        reference_type, reference_id, notes)
    values (r.item_id, v_bill.branch_id, 'sale', -r.total, 'bill', p_bill_id, 'Sale ' || v_bill.bill_no);
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

-- 4. Trigger: deplete on the transition to paid, never blocking -------------------
create or replace function bills_deplete_on_paid()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  begin
    perform deplete_bill(new.id);
  exception when others then
    insert into bill_depletions (bill_id, branch_id, status, error)
    values (new.id, new.branch_id, 'error', left(sqlerrm, 500))
    on conflict (bill_id) do nothing;
  end;
  return null;
end;
$$;
revoke all on function bills_deplete_on_paid() from public, anon, authenticated;

drop trigger if exists bills_deplete_on_paid on bills;
create trigger bills_deplete_on_paid
  after update of status on bills
  for each row
  when (old.status is distinct from 'paid' and new.status = 'paid')
  execute function bills_deplete_on_paid();
