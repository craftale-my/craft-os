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

create or replace function stock_count_usage(p_count_id uuid)
returns table (item_id uuid, item_name text, base_unit text,
               sold_base numeric, sold_value numeric, wasted_base numeric, wasted_value numeric,
               unexplained_base numeric, unexplained_value numeric, unexplained_pct numeric)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  p record;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to see stock usage';
  end if;
  select * into p from stock_count_usage_period(p_count_id);
  if not can_access_branch(p.branch_id) then
    raise exception 'Not authorised for this branch';
  end if;
  return query
    with tx as (
      select t.item_id,
             -sum(t.quantity) filter (where t.transaction_type = 'sale')                               as sold_b,
             -sum(t.quantity * coalesce(t.unit_cost, 0)) filter (where t.transaction_type = 'sale')    as sold_v,
             -sum(t.quantity) filter (where t.transaction_type = 'wastage')                            as waste_b,
             -sum(t.quantity * coalesce(t.unit_cost, 0)) filter (where t.transaction_type = 'wastage') as waste_v
        from inventory_transactions t
       where t.branch_id = p.branch_id
         and t.transaction_type in ('sale', 'wastage')
         and t.created_at > p.period_start and t.created_at <= p.period_end
       group by t.item_id
    ), ci as (
      select sci.item_id, sci.variance_base, sci.variance_value
        from stock_count_items sci where sci.count_id = p_count_id
    ), ids as (
      select tx.item_id from tx union select ci.item_id from ci
    )
    select ids.item_id, i.name, i.base_unit,
           coalesce(tx.sold_b, 0), coalesce(tx.sold_v, 0),
           coalesce(tx.waste_b, 0), coalesce(tx.waste_v, 0),
           coalesce(ci.variance_base, 0), coalesce(ci.variance_value, 0),
           case when coalesce(tx.sold_b, 0) > 0
                then -coalesce(ci.variance_base, 0) / tx.sold_b * 100 end
      from ids
      join items i on i.id = ids.item_id
      left join tx on tx.item_id = ids.item_id
      left join ci on ci.item_id = ids.item_id;
end;
$$;

create or replace function stock_count_usage_summary(p_count_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  p record;
  v_sold numeric; v_waste numeric; v_unexp numeric;
begin
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to see stock usage';
  end if;
  select * into p from stock_count_usage_period(p_count_id);
  if not can_access_branch(p.branch_id) then
    raise exception 'Not authorised for this branch';
  end if;
  select coalesce(sum(u.sold_value), 0), coalesce(sum(u.wasted_value), 0), coalesce(sum(u.unexplained_value), 0)
    into v_sold, v_waste, v_unexp
    from stock_count_usage(p_count_id) u;
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
    'unexplained_value', v_unexp);
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
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to see stock usage';
  end if;
  select * into p from stock_count_usage_period(p_count_id);
  if not can_access_branch(p.branch_id) then
    raise exception 'Not authorised for this branch';
  end if;
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
