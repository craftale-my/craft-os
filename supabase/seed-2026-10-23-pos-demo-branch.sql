-- Dev-only seed for the POS demo (craft-os-dev). Re-runnable.
-- Creates the Demo branch, ten tables, the two print routes and points the test login at it.
do $$
declare v_branch uuid;
begin
  select id into v_branch from branches where name = 'Demo';
  if v_branch is null then
    insert into branches(name, address, is_active) values ('Demo', 'Demo outlet (POS pilot)', true) returning id into v_branch;
  end if;
  insert into dining_tables(branch_id, label, sort_order)
  select v_branch, 'T' || n, n from generate_series(1, 10) n
  on conflict (branch_id, label) do nothing;
  insert into print_routes(branch_id, name, kind, address) values
    (v_branch, 'Bar', 'agent', '192.168.0.8:9100'),
    (v_branch, 'Kitchen', 'agent', '192.168.0.8:9100')
  on conflict (branch_id, name) do update set kind = excluded.kind, address = excluded.address;
  update staff set branch_id = v_branch where id = '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';
  raise notice 'Demo branch % ready', v_branch;
end $$;
select b.name, (select count(*) from dining_tables t where t.branch_id = b.id) as tables,
       (select count(*) from print_routes r where r.branch_id = b.id) as routes
  from branches b where b.name = 'Demo';
