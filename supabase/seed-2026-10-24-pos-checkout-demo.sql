-- Dev-only seed for POS checkout (craft-os-dev), after seed-2026-10-23-pos-demo-branch.sql.
-- Re-runnable. NEVER run this on prod (prod branches get these from /pos/settings).
-- Demo branch: receipt header, receipts on the Bar route (the ZY301), one 10% dine-in
-- service-charge rule, four payment methods and reason templates.
do $$
declare v_branch uuid;
begin
  if not exists (select 1 from staff where id = '76cbcf9f-905e-450d-9f5e-1c9e72a9373d') then
    raise exception 'STOP: this seed is for craft-os-dev only';
  end if;
  select id into v_branch from branches where name = 'Demo';
  if v_branch is null then raise exception 'STOP: run seed-2026-10-23-pos-demo-branch.sql first'; end if;

  update branches
     set receipt_title = coalesce(receipt_title, 'Craft Cafe - Demo'),
         legal_name    = coalesce(legal_name, 'Craftale Sdn Bhd'),
         phone         = coalesce(phone, '03-0000 0000')
   where id = v_branch;

  insert into branch_pos_settings(branch_id, sst_registered, cash_rounding, receipt_route)
  values (v_branch, true, 'nearest_5_sen', 'Bar')
  on conflict (branch_id) do update set receipt_route = coalesce(branch_pos_settings.receipt_route, excluded.receipt_route);

  if not exists (select 1 from service_charge_rules where branch_id = v_branch) then
    insert into service_charge_rules(branch_id, rate_bp, order_types, sort_order) values (v_branch, 1000, array['dine_in'], 1);
  end if;

  insert into payment_methods(branch_id, name, kind, needs_reference, sort_order) values
    (v_branch, 'Cash', 'cash', false, 1),
    (v_branch, 'Maybank Terminal', 'card', false, 2),
    (v_branch, 'DuitNow QR', 'duitnow', false, 3),
    (v_branch, 'Touch ''n Go', 'ewallet', false, 4)
  on conflict (branch_id, name) do nothing;

  insert into reason_templates(branch_id, action, reasons, compulsory, allow_other) values
    (v_branch, 'void_item', array['Customer changed mind', 'Wrong item keyed', 'Out of stock', 'Kitchen mistake'], true, true),
    (v_branch, 'void_bill', array['Customer left', 'Duplicate bill', 'Test bill'], true, true),
    (v_branch, 'refund',    array['Item not served', 'Wrong charge', 'Quality complaint', 'Customer changed mind'], true, true)
  on conflict (branch_id, action) do nothing;
  raise notice 'Demo branch % checkout settings ready', v_branch;
end $$;
select b.name,
       (select receipt_route from branch_pos_settings s where s.branch_id = b.id) as receipt_route,
       (select count(*) from service_charge_rules r where r.branch_id = b.id) as sc_rules,
       (select count(*) from payment_methods m where m.branch_id = b.id) as methods,
       (select count(*) from reason_templates t where t.branch_id = b.id) as reason_templates
  from branches b where b.name = 'Demo';
