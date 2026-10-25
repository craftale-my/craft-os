-- Run-sheet facts of the Demo branch (read-only; craft-os-dev only). One JSON value: save the
-- "facts" cell as a file and pass it to tools/run-sheet/figures.ts.
with br as (select id from branches where name = 'Demo'),
cat as (select bc.role, bc.catalog_id from branch_catalogs bc, br where bc.branch_id = br.id and bc.role in ('dine_in', 'takeaway', 'qr')),
sold as (select s.product_id from branch_menu_status s, br where s.branch_id = br.id and s.is_sold_out),
prod as (
  select p.id, p.name, p.sst_rate_bp, p.takeaway_fee_sen, p.print_route,
         coalesce(mc.sort_order, 0) as cat_sort, p.sort_order,
         p.name || case when v.feedme_variant_key <> '' then ' (' || v.name || ')' else '' end as name_snapshot,
         (select cvp.price_sen from catalog_variant_prices cvp join cat on cat.catalog_id = cvp.catalog_id and cat.role = 'dine_in'
           where cvp.variant_id = v.id) as dine_in_sen,
         (select cvp.price_sen from catalog_variant_prices cvp join cat on cat.catalog_id = cvp.catalog_id and cat.role = 'takeaway'
           where cvp.variant_id = v.id) as takeaway_sen,
         (select cvp.price_sen from catalog_variant_prices cvp join cat on cat.catalog_id = cvp.catalog_id and cat.role = 'qr'
           where cvp.variant_id = v.id) as qr_sen,
         (select cp.availability from catalog_products cp join cat on cat.catalog_id = cp.catalog_id and cat.role = 'takeaway'
           where cp.product_id = p.id) as takeaway_avail,
         (select cp.availability from catalog_products cp join cat on cat.catalog_id = cp.catalog_id and cat.role = 'qr'
           where cp.product_id = p.id) as qr_avail,
         exists (select 1 from product_schedules ps where ps.product_id = p.id) as has_time_slots,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'group', g.name, 'minSelect', g.min_select,
                   'option', (select jsonb_build_object('name', o.name, 'deltaSen', coalesce(
                                       (select cop.price_delta_sen from catalog_option_prices cop
                                          join cat on cat.catalog_id = cop.catalog_id and cat.role = 'dine_in'
                                         where cop.option_id = o.id), o.price_delta_sen))
                                from modifier_options o
                               where o.group_id = g.id and o.availability = 'all'
                                 and (o.product_id is null or o.product_id not in (select product_id from sold))
                               order by o.sort_order, o.name limit 1))
                 order by pmg.sort_order, g.name), '[]'::jsonb)
            from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id and g.is_active
           where pmg.product_id = p.id and g.min_select > 0) as required
    from menu_products p
    join menu_variants v on v.id = (select v2.id from menu_variants v2 where v2.product_id = p.id and v2.is_active
                                     order by v2.sort_order, v2.name limit 1)
    left join menu_categories mc on mc.id = p.category_id
   where p.is_active and not p.is_addon and p.id not in (select product_id from sold)
     and exists (select 1 from catalog_products cp join cat on cat.catalog_id = cp.catalog_id and cat.role = 'dine_in'
                  where cp.product_id = p.id and cp.availability = 'all')
),
bucketed as (
  select b.bucket, x.*, row_number() over (partition by b.bucket order by x.cat_sort, x.sort_order, x.name) as n
    from prod x
    cross join lateral (values
      (case when x.sst_rate_bp = 600 and x.takeaway_fee_sen = 0 and x.required = '[]'::jsonb and x.takeaway_avail = 'all'
             and x.qr_avail = 'all' and x.dine_in_sen > 0 and x.takeaway_sen > 0 and x.qr_sen > 0 then 'plain' end),
      (case when x.sst_rate_bp > 0 and x.takeaway_fee_sen > 0 and x.required = '[]'::jsonb and x.takeaway_avail = 'all'
             and x.dine_in_sen > 0 and x.takeaway_sen > 0 then 'fee' end),
      (case when x.sst_rate_bp = 0 and x.dine_in_sen > 0
             and not exists (select 1 from jsonb_array_elements(x.required) r
                              where (r->>'minSelect')::int <> 1 or r->'option' is null or r->'option' = 'null'::jsonb) then 'zero' end),
      (case when x.required <> '[]'::jsonb and x.dine_in_sen > 0
             and not exists (select 1 from jsonb_array_elements(x.required) r
                              where (r->>'minSelect')::int <> 1 or r->'option' is null or r->'option' = 'null'::jsonb) then 'set' end)
    ) as b(bucket)
   where b.bucket is not null and not x.has_time_slots
)
select jsonb_pretty(jsonb_build_object(
  'branchId', (select id from br),
  'settings', (select jsonb_build_object('sstRegistered', s.sst_registered, 'cashRounding', s.cash_rounding,
                                         'receiptRoute', s.receipt_route, 'cashVarianceLimitSen', s.cash_variance_limit_sen)
                 from branch_pos_settings s, br where s.branch_id = br.id),
  'rules', (select coalesce(jsonb_agg(jsonb_build_object('rateBp', r.rate_bp, 'orderTypes', to_jsonb(r.order_types),
                                                         'tableIds', to_jsonb(r.table_ids), 'productIds', to_jsonb(r.product_ids))
                                      order by r.sort_order, r.created_at, r.id), '[]'::jsonb)
              from service_charge_rules r, br where r.branch_id = br.id and r.is_active),
  'tables', (select jsonb_object_agg(t.label, t.id) from dining_tables t, br where t.branch_id = br.id and t.is_active),
  'methods', (select coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'kind', m.kind) order by m.sort_order, m.name), '[]'::jsonb)
                from payment_methods m, br where m.branch_id = br.id and m.is_active),
  'openShift', (select exists (select 1 from pos_shifts s, br where s.branch_id = br.id and s.status = 'open')),
  'lastClose', (select max(s.closed_at) from pos_shifts s, br where s.branch_id = br.id and s.status = 'closed'),
  'openBills', (select count(*) from bills b, br where b.branch_id = br.id and b.status = 'open'),
  -- voids already made since the last close: the next Z report lists them too
  'earlierVoids', (select jsonb_build_object(
      'items', count(*), 'valueSen', coalesce(sum(oi.unit_price_sen * oi.qty), 0))
      from order_items oi join bills b on b.id = oi.bill_id, br
     where b.branch_id = br.id and oi.voided_at > (select max(s.closed_at) from pos_shifts s where s.branch_id = br.id and s.status = 'closed')),
  'earlierVoidBills', (select count(*) from bills b, br
     where b.branch_id = br.id and b.status = 'voided'
       and b.closed_at > (select max(s.closed_at) from pos_shifts s where s.branch_id = br.id and s.status = 'closed')),
  'candidates', (select coalesce(jsonb_object_agg(g.bucket, g.items), '{}'::jsonb) from (
      select bucket, jsonb_agg(jsonb_build_object(
               'name', name, 'nameSnapshot', name_snapshot, 'productId', id, 'sstRateBp', sst_rate_bp,
               'takeawayFeeSen', takeaway_fee_sen, 'printRoute', print_route, 'dineInSen', dine_in_sen,
               'takeawaySen', takeaway_sen, 'qrSen', qr_sen, 'required', required) order by n) as items
        from bucketed where n <= 3 group by bucket) g)
)) as facts;
