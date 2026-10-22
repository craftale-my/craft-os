-- Run in the DEV project's SQL editor after the schema file.
-- Success = "VERIFY OK" notice. Any failure raises and names the check.
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
begin
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

  raise notice 'VERIFY OK';
end $$;

rollback;
