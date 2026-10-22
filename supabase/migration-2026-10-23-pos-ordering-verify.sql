-- Self-check for the POS ordering migrations. Run on craft-os-dev after both
-- migration files AND the seed. Everything is rolled back. Success = result row "VERIFY OK".
begin;

do $$
declare
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_branch  uuid;
  v_table   dining_tables;
  v_cat     uuid;
  v_latte   uuid; v_hot uuid; v_cold uuid;
  v_oat     uuid; v_oat_var uuid;
  v_milk    uuid; v_opt uuid;
  v_order   uuid; v_order2 uuid;
  v_bill    bills;
  v_items   jsonb;
  n         integer;
  r         record;
begin
  -- A1. schema + RLS + policies
  for r in select t from unnest(array['dining_tables','print_routes','branch_menu_status','bill_counters',
                                      'bills','orders','order_items','print_jobs']) as t loop
    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname = r.t and c.relrowsecurity) then
      raise exception 'FAIL schema: % missing or RLS off', r.t;
    end if;
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = 'pos_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no pos_read', r.t;
    end if;
  end loop;
  if exists (select 1 from pg_policies where tablename in ('bills','orders','order_items')
              and cmd in ('INSERT','UPDATE','DELETE','ALL')) then
    raise exception 'FAIL rls: bills/orders/items must be written only by RPCs';
  end if;
  for r in select f from unnest(array['place_table_order(text,integer,jsonb,uuid)','qr_menu(text)','qr_table_state(text)']) as f loop
    if not has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array['place_counter_order(uuid,text,integer,jsonb,uuid)','claim_print_job(uuid)',
                                      'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
  end loop;
  if has_function_privilege('authenticated', 'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)', 'execute') then
    raise exception 'FAIL grants: pos_insert_order must be internal';
  end if;
  if has_column_privilege('authenticated', 'print_jobs', 'payload', 'UPDATE')
     or not has_column_privilege('authenticated', 'print_jobs', 'status', 'UPDATE') then
    raise exception 'FAIL grants: print_jobs must be updatable only in its lifecycle columns';
  end if;

  -- A2. fixture: a branch with one table, a product with two variants and a milk group
  insert into branches(name, address) values ('VERIFY', 'verify') returning id into v_branch;
  insert into dining_tables(branch_id, label) values (v_branch, 'V1') returning * into v_table;
  insert into print_routes(branch_id, name, kind, address) values (v_branch, 'Bar', 'agent', '127.0.0.1:9100'), (v_branch, 'Kitchen', 'agent', '127.0.0.1:9101');
  insert into menu_categories(name) values ('VERIFY CAT') returning id into v_cat;
  insert into menu_products(name, category_id, feedme_product_id, print_route, sst_rate_bp)
    values ('Verify Latte', v_cat, 'verify-o-latte', 'Bar', 600) returning id into v_latte;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values
    (v_latte, 'v/hot', 'HOT', 1200, 0) returning id into v_hot;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values
    (v_latte, 'v/cold', 'COLD', 1300, 1) returning id into v_cold;
  insert into menu_products(name, category_id, feedme_product_id, is_addon, print_route)
    values ('Verify Oat milk', v_cat, 'verify-o-oat', true, 'Kitchen') returning id into v_oat;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_oat, '', 'Regular', 200) returning id into v_oat_var;
  insert into modifier_groups(feedme_group_id, name, min_select, max_select) values ('verify-o-milk', 'Milk', 0, 1) returning id into v_milk;
  insert into modifier_options(group_id, product_id, name, price_delta_sen) values (v_milk, v_oat, 'Oat milk', 200) returning id into v_opt;
  insert into product_modifier_groups(product_id, group_id) values (v_latte, v_milk);
  update staff set branch_id = v_branch where id = v_owner;

  -- A3. any staff may pause a table, only a settings holder may change its QR token
  insert into auth.users (id) values ('99999999-9999-9999-9999-999999999999');
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id)
  values ('99999999-9999-9999-9999-999999999999', 'verify staff', 'trainee', true, current_date, 'staff', v_branch);
  perform set_config('request.jwt.claims', json_build_object('sub', '99999999-9999-9999-9999-999999999999', 'role', 'authenticated')::text, true);
  update dining_tables set qr_paused = true, label = 'V1' where id = v_table.id;
  begin update dining_tables set qr_token = 'forged' where id = v_table.id; raise exception 'FAIL: staff changed a QR token';
  exception when raise_exception then if sqlerrm not like 'Only a manager%' then raise; end if; end;
  update dining_tables set qr_paused = false where id = v_table.id;

  -- B1. QR menu: table found, product listed with 2 variants and the milk group
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  if qr_menu('no-such-token') is not null then raise exception 'FAIL qr_menu: bad token must be null'; end if;
  if (qr_menu(v_table.qr_token)->>'tableLabel') <> 'V1' then raise exception 'FAIL qr_menu: label'; end if;
  if jsonb_array_length((select c->'products'->0->'variants'
                           from jsonb_array_elements(qr_menu(v_table.qr_token)->'categories') c
                          where c->>'name' = 'VERIFY CAT')) is distinct from 2 then
    raise exception 'FAIL qr_menu: variants';
  end if;
  if (qr_menu(v_table.qr_token)->>'needsPax')::boolean is not true then raise exception 'FAIL qr_menu: needsPax'; end if;

  -- B2. QR order with a modifier: priced on the server (1300 + 200), tickets on Bar (item) and Kitchen (oat)
  v_items := jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_cold, 'qty', 2,
                                                  'note', ' extra hot ', 'optionIds', jsonb_build_array(v_opt)));
  v_order := place_table_order(v_table.qr_token, 3, v_items, '11111111-1111-1111-1111-111111111111');
  select * into v_bill from bills where table_id = v_table.id and status = 'open';
  if v_bill.pax <> 3 or v_bill.order_type <> 'dine_in' or v_bill.bill_no !~ '^\d{6}-001$' then
    raise exception 'FAIL bill: %', row_to_json(v_bill);
  end if;
  select count(*) into n from order_items where order_id = v_order
     and name_snapshot = 'Verify Latte (COLD)' and unit_price_sen = 1500 and sst_rate_bp = 600
     and qty = 2 and note = 'extra hot' and print_route = 'Bar'
     and modifiers_snapshot->0->>'name' = 'Oat milk' and modifiers_snapshot->0->>'route' = 'Kitchen';
  if n <> 1 then raise exception 'FAIL item snapshot'; end if;
  if (select order_no from orders where id = v_order) <> v_bill.bill_no || '/1' then raise exception 'FAIL order_no'; end if;
  select count(*) into n from print_jobs where order_id = v_order and route = 'Bar'
     and payload->'lines'->0->>'name' = 'Verify Latte (COLD)' and payload->'lines'->0->'mods'->>0 = 'Oat milk'
     and payload->>'orderNo' = v_bill.bill_no || '/1' and payload->>'tableLabel' = 'V1' and payload->>'source' = 'qr';
  if n <> 1 then raise exception 'FAIL bar ticket'; end if;
  select count(*) into n from print_jobs where order_id = v_order and route = 'Kitchen'
     and payload->'lines'->0->>'name' = 'Oat milk' and payload->'lines'->0->>'note' = 'for Verify Latte (COLD)';
  if n <> 1 then raise exception 'FAIL kitchen ticket'; end if;

  -- B3. resend = same order, nothing new
  v_order2 := place_table_order(v_table.qr_token, 3, v_items, '11111111-1111-1111-1111-111111111111');
  if v_order2 <> v_order then raise exception 'FAIL idempotent'; end if;
  select count(*) into n from orders where bill_id = v_bill.id; if n <> 1 then raise exception 'FAIL idempotent: % orders', n; end if;

  -- B4. second order joins the same bill, order_no /2, pax kept
  v_order2 := place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), '22222222-2222-2222-2222-222222222222');
  if (select order_no from orders where id = v_order2) <> v_bill.bill_no || '/2' then raise exception 'FAIL second order_no'; end if;
  if (select pax from bills where id = v_bill.id) <> 3 then raise exception 'FAIL pax overwritten'; end if;
  if (qr_table_state(v_table.qr_token)->>'subtotalSen')::int <> 3000 + 1200 then raise exception 'FAIL qr_table_state subtotal'; end if;

  -- B5. rejections
  begin perform place_table_order('nope', null, v_items, gen_random_uuid()); raise exception 'FAIL: bad token accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid table code' then raise; end if; end;
  update dining_tables set qr_paused = true where id = v_table.id;
  begin perform place_table_order(v_table.qr_token, null, v_items, gen_random_uuid()); raise exception 'FAIL: paused accepted';
  exception when raise_exception then if sqlerrm not like 'Ordering is paused%' then raise; end if; end;
  update dining_tables set qr_paused = false where id = v_table.id;
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch, v_latte, true);
  begin perform place_table_order(v_table.qr_token, null, v_items, gen_random_uuid()); raise exception 'FAIL: sold out accepted';
  exception when raise_exception then if sqlerrm <> 'Sold out: Verify Latte' then raise; end if; end;
  delete from branch_menu_status where branch_id = v_branch;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_oat_var)), gen_random_uuid()); raise exception 'FAIL: foreign variant accepted';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Latte' then raise; end if; end;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt, v_opt))), gen_random_uuid()); raise exception 'FAIL: duplicate option accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid add-ons' then raise; end if; end;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt::text, upper(v_opt::text)))), gen_random_uuid()); raise exception 'FAIL: case-duplicate option accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid add-ons' then raise; end if; end;
  update modifier_groups set min_select = 1 where id = v_milk;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid()); raise exception 'FAIL: min_select ignored';
  exception when raise_exception then if sqlerrm <> 'Choose at least 1 for Verify Latte: Milk' then raise; end if; end;
  update modifier_groups set min_select = 0 where id = v_milk;
  update menu_products set availability = 'counter_only' where id = v_latte;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid()); raise exception 'FAIL: counter_only sold by QR';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Latte' then raise; end if; end;
  update menu_products set availability = 'all' where id = v_latte;
  begin perform place_table_order(v_table.qr_token, null, '[]'::jsonb, gen_random_uuid()); raise exception 'FAIL: empty accepted';
  exception when raise_exception then if sqlerrm <> 'Order has no items' then raise; end if; end;

  -- B6. rate limit: 5 per minute per table (two are in already)
  for n in 1..3 loop
    perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt))), gen_random_uuid());
  end loop;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt))), gen_random_uuid()); raise exception 'FAIL: rate limit';
  exception when raise_exception then if sqlerrm not like 'Too many orders%' then raise; end if; end;

  -- C1. counter: takeaway bill, counter_only allowed, placed_by set; no branch → refused
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update menu_products set availability = 'counter_only' where id = v_latte;
  v_order := place_counter_order(null, 'takeaway', null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), '33333333-3333-3333-3333-333333333333');
  select b.* into v_bill from bills b join orders o on o.bill_id = b.id where o.id = v_order;
  if v_bill.order_type <> 'takeaway' or v_bill.table_id is not null or v_bill.bill_no !~ '^\d{6}-002$' then raise exception 'FAIL takeaway bill: %', row_to_json(v_bill); end if;
  if (select placed_by from orders where id = v_order) <> v_owner then raise exception 'FAIL placed_by'; end if;
  if (select payload->>'tableLabel' from print_jobs where order_id = v_order) is not null then raise exception 'FAIL takeaway ticket label'; end if;
  begin perform place_counter_order(v_table.id, 'takeaway', null, v_items, gen_random_uuid()); raise exception 'FAIL: takeaway with table';
  exception when raise_exception then if sqlerrm not like 'Dine-in orders need a table%' then raise; end if; end;
  update staff set branch_id = null where id = v_owner;
  begin perform place_counter_order(null, 'takeaway', null, v_items, gen_random_uuid()); raise exception 'FAIL: no-branch accepted';
  exception when raise_exception then if sqlerrm not like 'Your account has no branch%' then raise; end if; end;
  update staff set branch_id = v_branch where id = v_owner;

  -- D1. print jobs: claim once, finish, requeue failed and stuck
  select id into v_order from print_jobs where branch_id = v_branch and status = 'pending' limit 1;
  if not claim_print_job(v_order) then raise exception 'FAIL claim'; end if;
  if claim_print_job(v_order) then raise exception 'FAIL double claim'; end if;
  perform finish_print_job(v_order, false, 'Not sent: paper out');
  if (select status from print_jobs where id = v_order) <> 'failed' then raise exception 'FAIL finish'; end if;
  perform requeue_print_job(v_order);
  if (select status from print_jobs where id = v_order) <> 'pending' then raise exception 'FAIL requeue failed'; end if;
  perform claim_print_job(v_order);
  perform requeue_print_job(v_order);
  if (select status from print_jobs where id = v_order) <> 'printing' then raise exception 'FAIL requeue must not touch a fresh claim'; end if;
  update print_jobs set claimed_at = now() - interval '3 minutes' where id = v_order;
  perform requeue_print_job(v_order);
  if (select status from print_jobs where id = v_order) <> 'pending' then raise exception 'FAIL requeue stuck'; end if;
  v_order := insert_test_print('Bar');
  if (select payload->>'orderNo' from print_jobs where id = v_order) <> 'TEST01' then raise exception 'FAIL test print'; end if;
  begin perform insert_test_print('Nowhere'); raise exception 'FAIL: unknown route accepted';
  exception when raise_exception then if sqlerrm not like 'No printer is set%' then raise; end if; end;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
