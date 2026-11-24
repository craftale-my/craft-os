do $$
begin
  if to_regclass('public.staff') is not null then
    raise exception 'STOP: public.staff exists, so this is the Craft OS production database. Run the POS spike only in the craft-os-dev project.';
  end if;
end $$;

-- Run in the DEV project's SQL editor after the schema file.
-- Success = a result row "VERIFY OK" (plus a notice). Any failure raises and names the check.
begin;

do $$
declare
  v_token   text;
  v_bar     uuid;
  v_kitchen uuid;
  v1        uuid;
  v2        uuid;
  v_jobs    integer;
  v_price   integer;
  v_job2    uuid;
  v_order   uuid;
  v_status  text;
  r         record;
  l         jsonb;
begin
  -- reset fixture state so checks never depend on earlier demoing (all rolled back at the end)
  update spike_tables set qr_paused = false, is_active = true where label in ('A1','A2','B5');
  update spike_menu_items set is_available = true;
  delete from spike_print_jobs;
  delete from spike_order_items;
  delete from spike_orders;
  delete from spike_bills;

  select qr_token into v_token from spike_tables where label = 'A1';
  select id into v_bar     from spike_menu_items where route = 'Bar'     order by name limit 1;
  select id into v_kitchen from spike_menu_items where route = 'Kitchen' order by name limit 1;

  -- 1. one order with a bar and a kitchen item → exactly two print jobs
  v1 := spike_place_table_order(v_token,
          jsonb_build_array(jsonb_build_object('menuItemId', v_bar, 'qty', 2),
                            jsonb_build_object('menuItemId', v_kitchen, 'qty', 1, 'note', 'no onion')),
          '00000000-0000-0000-0000-0000000000a1');
  select count(*) into v_jobs from spike_print_jobs where order_id = v1;
  if v_jobs <> 2 then raise exception 'FAIL routing: expected 2 print jobs, got %', v_jobs; end if;

  -- 2. resend with the same client_order_id → same order, no new jobs
  v2 := spike_place_table_order(v_token,
          jsonb_build_array(jsonb_build_object('menuItemId', v_bar, 'qty', 2)),
          '00000000-0000-0000-0000-0000000000a1');
  if v1 <> v2 then raise exception 'FAIL idempotency: resend created a second order'; end if;
  select count(*) into v_jobs from spike_print_jobs where order_id = v1;
  if v_jobs <> 2 then raise exception 'FAIL idempotency: resend created extra print jobs'; end if;

  -- 3. price comes from the menu, not the client
  select unit_price_sen into v_price from spike_order_items where order_id = v1 and menu_item_id = v_bar;
  if v_price <> (select price_sen from spike_menu_items where id = v_bar) then
    raise exception 'FAIL pricing: snapshot price does not match menu';
  end if;

  -- 4. second order on the same table joins the same open bill
  v2 := spike_place_table_order(v_token,
          jsonb_build_array(jsonb_build_object('menuItemId', v_bar)),
          '00000000-0000-0000-0000-0000000000a2');
  if (select bill_id from spike_orders where id = v1) <> (select bill_id from spike_orders where id = v2) then
    raise exception 'FAIL bills: second order on table A1 opened a new bill';
  end if;

  -- 5. invalid token is rejected
  begin
    perform spike_place_table_order('not-a-token',
              jsonb_build_array(jsonb_build_object('menuItemId', v_bar)), gen_random_uuid());
    raise exception 'FAIL token: invalid token was accepted';
  exception when raise_exception then
    if sqlerrm not like 'Invalid table code%' then raise; end if;
  end;

  -- 6. unavailable item is rejected and nothing is written
  update spike_menu_items set is_available = false where id = v_kitchen;
  begin
    perform spike_place_table_order(v_token,
              jsonb_build_array(jsonb_build_object('menuItemId', v_kitchen)),
              '00000000-0000-0000-0000-0000000000a3');
    raise exception 'FAIL availability: sold-out item was accepted';
  exception when raise_exception then
    if sqlerrm not like 'Item is not available%' then raise; end if;
  end;
  if exists (select 1 from spike_orders where client_order_id = '00000000-0000-0000-0000-0000000000a3') then
    raise exception 'FAIL availability: rejected order left a row behind';
  end if;

  -- 7. claim is single-winner
  select id into v1 from spike_print_jobs where status = 'pending' limit 1;
  if not spike_claim_print_job(v1) then raise exception 'FAIL claim: first claim lost'; end if;
  if spike_claim_print_job(v1)     then raise exception 'FAIL claim: second claim also won'; end if;

  -- 8. print payload shape matches TicketPayload
  select id into v1 from spike_orders where client_order_id = '00000000-0000-0000-0000-0000000000a1';
  for r in select payload from spike_print_jobs where order_id = v1 loop
    if not (r.payload ?& array['kind','route','tableLabel','orderNo','source','placedAt','lines']) then
      raise exception 'FAIL payload: missing a required key in %', r.payload;
    end if;
    if (select count(*) from jsonb_object_keys(r.payload)) <> 7 then
      raise exception 'FAIL payload: expected exactly 7 keys in %', r.payload;
    end if;
    if r.payload->>'placedAt' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' then
      raise exception 'FAIL payload: placedAt is not ISO-8601 UTC with milliseconds: %', r.payload->>'placedAt';
    end if;
    if r.payload->>'tableLabel' is distinct from 'A1' then
      raise exception 'FAIL payload: tableLabel should be A1, got %', r.payload->>'tableLabel';
    end if;
    if jsonb_typeof(r.payload->'lines') is distinct from 'array' then
      raise exception 'FAIL payload: lines is not an array';
    end if;
    for l in select * from jsonb_array_elements(r.payload->'lines') loop
      if (select count(*) from jsonb_object_keys(l)) <> 3 or not (l ?& array['qty','name','note']) then
        raise exception 'FAIL payload: line should have exactly qty, name, note: %', l;
      end if;
    end loop;
  end loop;

  -- 9. takeaway order (no table) prints with a null tableLabel
  v_order := spike_insert_order(null, 'counter', null,
               jsonb_build_array(jsonb_build_object('menuItemId', v_bar)), gen_random_uuid());
  select payload into r from spike_print_jobs where order_id = v_order limit 1;
  if r.payload->'tableLabel' is distinct from 'null'::jsonb then
    raise exception 'FAIL takeaway: tableLabel should be JSON null, got %', r.payload->'tableLabel';
  end if;
  if r.payload->>'source' is distinct from 'counter' then
    raise exception 'FAIL takeaway: source should be counter, got %', r.payload->>'source';
  end if;

  -- 10. bad quantity is a final (P0001) error
  begin
    perform spike_place_table_order((select qr_token from spike_tables where label = 'A2'),
              jsonb_build_array(jsonb_build_object('menuItemId', v_bar, 'qty', 0)), gen_random_uuid());
    raise exception 'FAIL quantity: qty 0 was accepted';
  exception when raise_exception then
    if sqlerrm not like 'Invalid quantity%' then raise; end if;
  end;

  -- 11. paused table: a resend still returns the original order, a new order is refused
  update spike_tables set qr_paused = true where label = 'A1';
  v2 := spike_place_table_order(v_token,
          jsonb_build_array(jsonb_build_object('menuItemId', v_bar, 'qty', 2)),
          '00000000-0000-0000-0000-0000000000a1');
  if v2 is distinct from v1 then raise exception 'FAIL paused resend: did not return the original order'; end if;
  begin
    perform spike_place_table_order(v_token,
              jsonb_build_array(jsonb_build_object('menuItemId', v_bar)), gen_random_uuid());
    raise exception 'FAIL paused: new order was accepted while paused';
  exception when raise_exception then
    if sqlerrm not like 'Ordering is paused%' then raise; end if;
  end;

  -- 12. print lifecycle: pending -> printing -> failed -> pending -> printing -> printed
  select id into v_job2 from spike_print_jobs where status = 'pending' limit 1;
  if v_job2 is null then raise exception 'FAIL lifecycle: no pending job to test with'; end if;
  if not spike_claim_print_job(v_job2) then raise exception 'FAIL lifecycle: claim lost'; end if;
  perform spike_finish_print_job(v_job2, false, 'cover open');
  select status into v_status from spike_print_jobs where id = v_job2;
  if v_status is distinct from 'failed' then raise exception 'FAIL lifecycle: expected failed, got %', v_status; end if;
  if (select last_error from spike_print_jobs where id = v_job2) is distinct from 'cover open' then
    raise exception 'FAIL lifecycle: last_error was not recorded';
  end if;
  perform spike_requeue_print_job(v_job2);
  select status into v_status from spike_print_jobs where id = v_job2;
  if v_status is distinct from 'pending' then raise exception 'FAIL lifecycle: expected pending after requeue, got %', v_status; end if;
  if not spike_claim_print_job(v_job2) then raise exception 'FAIL lifecycle: claim after requeue lost'; end if;
  perform spike_finish_print_job(v_job2, true, null);
  select status into v_status from spike_print_jobs where id = v_job2;
  if v_status is distinct from 'printed' then raise exception 'FAIL lifecycle: expected printed, got %', v_status; end if;
  if (select printed_at from spike_print_jobs where id = v_job2) is null then
    raise exception 'FAIL lifecycle: printed_at not set';
  end if;

  -- 13. privileges
  if has_function_privilege('anon', 'spike_insert_order(uuid,text,uuid,jsonb,uuid)', 'execute') then
    raise exception 'FAIL privileges: anon can execute spike_insert_order';
  end if;
  if has_function_privilege('authenticated', 'spike_insert_order(uuid,text,uuid,jsonb,uuid)', 'execute') then
    raise exception 'FAIL privileges: authenticated can execute spike_insert_order';
  end if;
  if has_function_privilege('anon', 'spike_place_counter_order(uuid,jsonb,uuid)', 'execute') then
    raise exception 'FAIL privileges: anon can execute spike_place_counter_order';
  end if;
  if not has_function_privilege('anon', 'spike_place_table_order(text,jsonb,uuid)', 'execute') then
    raise exception 'FAIL privileges: anon cannot execute spike_place_table_order';
  end if;

  -- 14. RLS: order tables are read-only for staff
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename in ('spike_bills','spike_orders','spike_order_items')
                and cmd <> 'SELECT') then
    raise exception 'FAIL rls: a write policy exists on bills/orders/order_items';
  end if;
  for r in select t as tbl from unnest(array['spike_bills','spike_orders','spike_order_items']) as t loop
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = r.tbl
                      and policyname = 'spike_staff_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no spike_staff_read SELECT policy', r.tbl;
    end if;
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = r.tbl and c.relrowsecurity) then
      raise exception 'FAIL rls: row level security is off on %', r.tbl;
    end if;
  end loop;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;

rollback;
