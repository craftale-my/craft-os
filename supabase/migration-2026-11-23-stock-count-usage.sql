-- ============================================================================
-- Craft OS — Stock count usage ("Since last count") (2026-11-23)
-- For a submitted count: what sales should have used (sale rows), what was
-- logged as waste, and what the count found missing on top, per ingredient,
-- between the previous submitted count at the branch and this one.
-- Additive and idempotent. Requires migration-2026-11-23-sales-depletion.sql.
-- ============================================================================

create or replace function stock_count_usage_period(
  p_count_id uuid,
  out branch_id uuid, out period_start timestamptz, out period_end timestamptz, out from_previous boolean
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_c stock_counts%rowtype;
begin
  select * into v_c from stock_counts s where s.id = p_count_id;
  if not found or v_c.status <> 'submitted' then
    raise exception 'Count not found or not submitted';
  end if;
  branch_id := v_c.branch_id;
  period_end := v_c.submitted_at;
  select max(s.submitted_at) into period_start
    from stock_counts s
   where s.branch_id = v_c.branch_id and s.status = 'submitted' and s.submitted_at < v_c.submitted_at;
  from_previous := period_start is not null;
  if period_start is null then
    period_start := v_c.submitted_at - interval '30 days';
  end if;
end;
$$;
revoke all on function stock_count_usage_period(uuid) from public, anon, authenticated;

-- Ledger index: every usage query filters by branch and a created_at range.
drop index if exists inventory_transactions_branch_time_idx;
create index if not exists inventory_transactions_sale_waste_idx
  on inventory_transactions (branch_id, created_at) where transaction_type in ('sale', 'wastage');

-- One guard for all report functions: capability first (own message), then ONE generic
-- error for "count missing / not submitted / no access to its branch" so nothing leaks.
create or replace function stock_count_usage_guard(p_count_id uuid)
returns uuid
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  v_branch uuid; v_status text;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to see stock usage';
  end if;
  select s.branch_id, s.status into v_branch, v_status from stock_counts s where s.id = p_count_id;
  if v_branch is null or v_status <> 'submitted' or not can_access_branch(v_branch) then
    raise exception 'Not authorised or count not found';
  end if;
  return v_branch;
end;
$$;
revoke all on function stock_count_usage_guard(uuid) from public, anon, authenticated;

-- Per-item window (decided 2026-11-23): weekly counts cover only key items, so an item's
-- previous count may be older than the latest count. Each item's window starts at the latest
-- earlier submitted count at the branch that CONTAINS the item (a stock_count_items row);
-- if there is none, at the summary-level start (stock_count_usage_period). Items NOT in the
-- target count always use the summary-level start. Hard cap: no window reaches back more than
-- 180 days before period_end, so the ledger scan is always bounded. The window is
-- (period_start, period_end]: a row exactly at the start is excluded, at the end included.
-- Internal: no access check, callers go through stock_count_usage_guard first.
create or replace function stock_count_usage_calc(p_count_id uuid)
returns table (item_id uuid, item_name text, base_unit text,
               sold_base numeric, sold_value numeric, wasted_base numeric, wasted_value numeric,
               unexplained_base numeric, unexplained_value numeric, unexplained_pct numeric,
               counted boolean, period_start timestamptz, rows_without_cost bigint)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  p record;
begin
  select * into p from stock_count_usage_period(p_count_id);
  return query
    with ci as (
      select sci.item_id, sci.variance_base, sci.variance_value
        from stock_count_items sci where sci.count_id = p_count_id
    ), cand as (
      select ci.item_id from ci
      union
      select t.item_id from inventory_transactions t
       where t.branch_id = p.branch_id and t.transaction_type in ('sale', 'wastage')
         and t.created_at > greatest(p.period_start, p.period_end - interval '180 days')
         and t.created_at <= p.period_end
    ), st as (
      select c.item_id,
             greatest(
               case when exists (select 1 from ci where ci.item_id = c.item_id)
                    then coalesce((select max(sc.submitted_at)
                                     from stock_counts sc
                                     join stock_count_items si on si.count_id = sc.id and si.item_id = c.item_id
                                    where sc.branch_id = p.branch_id and sc.status = 'submitted'
                                      and sc.submitted_at < p.period_end), p.period_start)
                    else p.period_start end,
               p.period_end - interval '180 days') as pstart
        from cand c
    ), tx as (
      select t.item_id,
             -sum(t.quantity) filter (where t.transaction_type = 'sale')                               as sold_b,
             -sum(t.quantity * coalesce(t.unit_cost, 0)) filter (where t.transaction_type = 'sale')    as sold_v,
             -sum(t.quantity) filter (where t.transaction_type = 'wastage')                            as waste_b,
             -sum(t.quantity * coalesce(t.unit_cost, 0)) filter (where t.transaction_type = 'wastage') as waste_v,
             count(*) filter (where t.unit_cost is null)                                               as no_cost
        from inventory_transactions t
        join st on st.item_id = t.item_id
       where t.branch_id = p.branch_id
         and t.transaction_type in ('sale', 'wastage')
         and t.created_at > st.pstart and t.created_at <= p.period_end
         and t.created_at > p.period_end - interval '180 days'
       group by t.item_id
    )
    select st.item_id, i.name, i.base_unit,
           coalesce(tx.sold_b, 0), coalesce(tx.sold_v, 0),
           coalesce(tx.waste_b, 0), coalesce(tx.waste_v, 0),
           coalesce(ci.variance_base, 0), coalesce(ci.variance_value, 0),
           case when ci.item_id is not null and coalesce(tx.sold_b, 0) > 0
                then -ci.variance_base / tx.sold_b * 100 end,
           ci.item_id is not null,
           st.pstart,
           coalesce(tx.no_cost, 0)
      from st
      join items i on i.id = st.item_id
      left join tx on tx.item_id = st.item_id
      left join ci on ci.item_id = st.item_id
     where ci.item_id is not null or tx.item_id is not null;
end;
$$;
revoke all on function stock_count_usage_calc(uuid) from public, anon, authenticated;

-- Return type gained columns, so the old signature must go first (idempotent).
drop function if exists stock_count_usage(uuid);
create function stock_count_usage(p_count_id uuid)
returns table (item_id uuid, item_name text, base_unit text,
               sold_base numeric, sold_value numeric, wasted_base numeric, wasted_value numeric,
               unexplained_base numeric, unexplained_value numeric, unexplained_pct numeric,
               counted boolean, period_start timestamptz)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  perform stock_count_usage_guard(p_count_id);
  return query
    select c.item_id, c.item_name, c.base_unit, c.sold_base, c.sold_value, c.wasted_base, c.wasted_value,
           c.unexplained_base, c.unexplained_value, c.unexplained_pct, c.counted, c.period_start
      from stock_count_usage_calc(p_count_id) c;
end;
$$;

create or replace function stock_count_usage_summary(p_count_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  p record;
  v_sold numeric; v_waste numeric; v_unexp numeric; v_nocost bigint;
begin
  perform stock_count_usage_guard(p_count_id);
  select * into p from stock_count_usage_period(p_count_id);
  -- Totals are the sum of the per-item rows (each over its own window).
  select coalesce(sum(u.sold_value), 0), coalesce(sum(u.wasted_value), 0),
         coalesce(sum(u.unexplained_value), 0), coalesce(sum(u.rows_without_cost), 0)
    into v_sold, v_waste, v_unexp, v_nocost
    from stock_count_usage_calc(p_count_id) u;
  return jsonb_build_object(
    'period_start', p.period_start,
    'period_end', p.period_end,
    'from_previous', p.from_previous,
    'bills_paid', (select count(*) from bills b where b.branch_id = p.branch_id and b.status = 'paid'
                     and b.closed_at > p.period_start and b.closed_at <= p.period_end),
    'lines_without_recipe', (select coalesce(sum(d.lines_without_recipe), 0) from bill_depletions d
                              where d.branch_id = p.branch_id and d.depleted_at > p.period_start and d.depleted_at <= p.period_end),
    'depletion_errors', (select count(*) from bill_depletions d
                          where d.branch_id = p.branch_id and d.status = 'error'
                            and d.depleted_at > p.period_start and d.depleted_at <= p.period_end),
    'sold_value', v_sold,
    'wasted_value', v_waste,
    'unexplained_value', v_unexp,
    'rows_without_cost', v_nocost);
end;
$$;

create or replace function stock_count_unrecipe_sales(p_count_id uuid)
returns table (product_name text, variant_name text, qty_sold bigint)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  p record;
begin
  perform stock_count_usage_guard(p_count_id);
  select * into p from stock_count_usage_period(p_count_id);
  return query
    select mp.name::text, mv.name::text, sum(oi.qty)::bigint
      from bills b
      join order_items oi on oi.bill_id = b.id and oi.voided_at is null
      join menu_variants mv on mv.id = oi.variant_id
      join menu_products mp on mp.id = mv.product_id
     where b.branch_id = p.branch_id and b.status = 'paid'
       and b.closed_at > p.period_start and b.closed_at <= p.period_end
       and not exists (select 1 from menu_variant_recipe_lines vl where vl.variant_id = oi.variant_id)
     group by mp.name, mv.name
     order by 3 desc, 1, 2
     limit 50;
end;
$$;

revoke all on function stock_count_usage(uuid) from public, anon;
revoke all on function stock_count_usage_summary(uuid) from public, anon;
revoke all on function stock_count_unrecipe_sales(uuid) from public, anon;
grant execute on function stock_count_usage(uuid) to authenticated;
grant execute on function stock_count_usage_summary(uuid) to authenticated;
grant execute on function stock_count_unrecipe_sales(uuid) to authenticated;
