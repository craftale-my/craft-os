-- Self-check for the QR table cart. Run on craft-os-dev after migration-2026-11-22-qr-table-cart.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- It borrows a real dev table that has no open bill and a product on its QR menu that needs no
-- choices, so it needs no seed of its own. Three guests: A "Mei", B "Mei" (bad avatar), C unnamed.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm is distinct from p_message then
      raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
    end if;
    return;
  end;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
end $$;

create function pg_temp.ok(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL %', p_label; end if;
end $$;

do $$
declare
  v_table dining_tables;
  v_prod  jsonb;
  v_line  jsonb;
  v_tok   text;
  ga constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-000000000001","name":"  Mei  ","avatar":"a3"}';
  gb constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-000000000002","name":"Mei","avatar":"a9"}';
  gc constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-000000000003","name":"","avatar":"a5"}';
  gd constant jsonb := '{"id":"aaaaaaaa-0000-4000-8000-000000000004","name":"Ann","avatar":"a2"}';
  ida uuid; idb uuid; idc uuid; idx uuid;
  s jsonb; r jsonb; v_order uuid; v_coid uuid := gen_random_uuid(); v_version text;
begin
  -- ── A: schema and grants ──
  perform pg_temp.ok((select relrowsecurity from pg_class where oid = 'qr_cart_lines'::regclass), 'A1 RLS on');
  perform pg_temp.ok(not has_table_privilege('anon', 'qr_cart_lines', 'select'), 'A2 anon cannot read the table');
  perform pg_temp.ok(has_function_privilege('anon', 'qr_cart_state(text)', 'execute'), 'A3 anon runs qr_cart_state');
  perform pg_temp.ok(has_function_privilege('anon', 'qr_cart_send(text, integer, text, uuid[], uuid)', 'execute'), 'A4 anon runs qr_cart_send');
  perform pg_temp.ok(not has_function_privilege('anon', 'qr_cart_labels(uuid)', 'execute'), 'A5 helpers are closed');
  perform pg_temp.ok(not has_function_privilege('anon', 'pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid)', 'execute'), 'A6 pos_insert_order still closed');
  perform pg_temp.ok(has_column_privilege('authenticated', 'order_items', 'guest_label', 'select'), 'A7 staff read guest_label');

  -- ── setup: a free table whose QR menu has a product that needs no choices ──
  select t.* into v_table from dining_tables t
   where t.is_active
     and not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open')
     and exists (select 1 from jsonb_array_elements(qr_menu(t.qr_token)->'categories') c,
                               jsonb_array_elements(c->'products') p
                  where not (p->>'soldOut')::boolean and jsonb_array_length(p->'variants') > 0
                    and not exists (select 1 from jsonb_array_elements(p->'groups') g where (g->>'min')::integer > 0))
   order by t.created_at limit 1;
  if not found then raise exception 'FAIL setup: dev has no free table with a simple product on its QR menu'; end if;
  v_tok := v_table.qr_token;
  update dining_tables set qr_paused = false where id = v_table.id;
  update branch_pos_settings set qr_requires_open_bill = false where branch_id = v_table.branch_id;
  delete from qr_cart_lines where table_id = v_table.id;
  select p into v_prod from jsonb_array_elements(qr_menu(v_tok)->'categories') c, jsonb_array_elements(c->'products') p
   where not (p->>'soldOut')::boolean and jsonb_array_length(p->'variants') > 0
     and not exists (select 1 from jsonb_array_elements(p->'groups') g where (g->>'min')::integer > 0)
   order by (select mp.print_route is null from menu_products mp where mp.id = (p->>'id')::uuid), p->>'name'
   limit 1;
  v_line := jsonb_build_object('productId', v_prod->>'id', 'variantId', v_prod->'variants'->0->>'id',
                               'qty', 2, 'note', '  no ice  ', 'optionIds', '[]'::jsonb);

  -- ── B: adding, labels, cleaning ──
  perform pg_temp.ok((qr_cart_state(v_tok)->>'version') = 'empty', 'B1 empty cart');
  perform pg_temp.ok(qr_cart_state('nosuchtoken') is null, 'B2 unknown table reads null');
  ida := qr_cart_put(v_tok, ga, v_line, null);
  idb := qr_cart_put(v_tok, gb, v_line, null);
  idc := qr_cart_put(v_tok, gc, v_line, null);
  s := qr_cart_state(v_tok);
  perform pg_temp.ok(jsonb_array_length(s->'lines') = 3, 'B3 three lines');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'Mei', 'B4 A is Mei (trimmed)');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = idb::text) = 'Mei 2', 'B5 B is Mei 2');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = idc::text) = 'Guest', 'B6 C is Guest');
  perform pg_temp.ok((select l->>'guestAvatar' from jsonb_array_elements(s->'lines') l where l->>'id' = idb::text) = 'a1', 'B7 a bad avatar becomes a1');
  perform pg_temp.ok((select l->>'note' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'no ice', 'B8 note trimmed');
  perform pg_temp.ok((s->>'version') <> 'empty', 'B9 version set');

  -- ── C: only your own lines; bad input ──
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, %L)', v_tok, gb, v_line, ida),
    'You can only change your own items.', 'C1 edit another guest''s line');
  v_version := s->>'version';
  perform qr_cart_put(v_tok, ga, v_line || '{"qty":3}', ida);
  s := qr_cart_state(v_tok);
  perform pg_temp.ok((select (l->>'qty')::integer from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 3, 'C2 own edit lands');
  perform pg_temp.ok((s->>'version') <> v_version, 'C3 an edit changes the version');
  perform pg_temp.expect_error(format('select qr_cart_remove(%L, %L, %L)', v_tok, gb->>'id', ida),
    'You can only change your own items.', 'C4 remove another guest''s line');
  perform qr_cart_remove(v_tok, (ga->>'id')::uuid, gen_random_uuid());   -- C5 a line already gone: no error
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, %L)', v_tok, ga, v_line, gen_random_uuid()),
    'That item is no longer in the order.', 'C6 edit a line that is gone');
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, ga, v_line || '{"qty":21}'),
    'Invalid quantity', 'C7 qty 21');
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, ga, v_line || jsonb_build_object('productId', gen_random_uuid())),
    'Invalid item', 'C8 unknown product');
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, '{"id":"x"}', v_line),
    'Invalid guest', 'C9 bad guest');
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', 'nosuchtoken', ga, v_line),
    'Invalid table code', 'C10 unknown table');

  -- ── D: rename ──
  perform qr_cart_rename(v_tok, ga || '{"name":"Ann","avatar":"a4"}');
  s := qr_cart_state(v_tok);
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'Ann', 'D1 A renamed');
  perform pg_temp.ok((select l->>'guestAvatar' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'a4', 'D2 A avatar changed');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = idb::text) = 'Mei', 'D3 B is plain Mei now');

  -- ── E: the 50-line cap ──
  insert into qr_cart_lines(table_id, guest_id, guest_name, guest_avatar, product_id, variant_id, qty)
  select v_table.id, (gc->>'id')::uuid, 'Guest', 'a5', (v_prod->>'id')::uuid, (v_prod->'variants'->0->>'id')::uuid, 1
    from generate_series(1, 47);
  perform pg_temp.expect_error(format('select qr_cart_put(%L, %L::jsonb, %L::jsonb, null)', v_tok, ga, v_line),
    'This table''s order is full. Please send it first.', 'E1 line 51');
  delete from qr_cart_lines where table_id = v_table.id and id not in (ida, idb, idc);

  -- ── F: sending ──
  r := qr_cart_send(v_tok, 2, 'stale-version', '{}', v_coid);
  perform pg_temp.ok(r->>'status' = 'changed', 'F1 a stale version sends nothing');
  perform pg_temp.ok((select count(*) from qr_cart_lines where table_id = v_table.id) = 3, 'F2 the cart is untouched');
  v_version := qr_cart_state(v_tok)->>'version';
  r := qr_cart_send(v_tok, 2, v_version, array[idc], v_coid);
  perform pg_temp.ok(r->>'status' = 'sent', 'F3 sent');
  v_order := (r->>'orderId')::uuid;
  perform pg_temp.ok((select count(*) from qr_cart_lines where table_id = v_table.id) = 0, 'F4 the whole cart is cleared, the skipped line too');
  perform pg_temp.ok((select count(*) from order_items where order_id = v_order) = 2, 'F5 two items, the skipped one left out');
  perform pg_temp.ok((select array_agg(guest_label order by guest_label) from order_items where order_id = v_order) = array['Ann', 'Mei'], 'F6 labels on the items');
  perform pg_temp.ok((select guest_avatar from order_items where order_id = v_order and guest_label = 'Ann') = 'a4', 'F7 avatar on the item');
  perform pg_temp.ok((select guest_id from order_items where order_id = v_order and guest_label = 'Mei') = (gb->>'id')::uuid, 'F8 guest id on the item');
  if (select print_route from menu_products where id = (v_prod->>'id')::uuid) is not null then
    perform pg_temp.ok(exists (select 1 from print_jobs j where j.order_id = v_order and j.kind = 'ticket'), 'F9a the order made a ticket');
  end if;
  perform pg_temp.ok(not exists (select 1 from print_jobs j, jsonb_array_elements(j.payload->'lines') l
                                  where j.order_id = v_order and j.kind = 'ticket' and not (l ? 'guest')), 'F9 every ticket line names its guest');
  r := qr_cart_send(v_tok, 2, 'whatever', '{}', v_coid);
  perform pg_temp.ok(r->>'status' = 'sent' and (r->>'orderId')::uuid = v_order, 'F10 a resend returns the same order');
  perform pg_temp.expect_error(format('select qr_cart_send(%L, null, %L, %L, %L)', v_tok, 'empty', '{}', gen_random_uuid()),
    'Nothing to send.', 'F11 an empty cart');

  -- ── G: labels hold for the rest of the bill ──
  idx := qr_cart_put(v_tok, ga || '{"name":"Zed"}', v_line, null);       -- A comes back under another name
  ida := qr_cart_put(v_tok, gd, v_line, null);                            -- a new guest called Ann
  s := qr_cart_state(v_tok);
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = idx::text) = 'Ann', 'G1 A keeps the label on the bill');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text) = 'Ann 2', 'G2 the new Ann is Ann 2');

  -- ── H: what the guest's page reads back ──
  s := qr_table_state(v_tok);
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(s->'items') i where i->>'guestLabel' = 'Mei' and i->>'guestAvatar' = 'a1'), 'H1 qr_table_state carries guest label and avatar');

  -- ── I: the old call still works and can name no guest ──
  v_order := place_table_order(v_tok, null, jsonb_build_array(v_line || jsonb_build_object(
               'guestId', gb->>'id', 'guestLabel', 'AAA', 'guestAvatar', 'a2')), gen_random_uuid());
  perform pg_temp.ok((select guest_id is null and guest_label is null and guest_avatar is null
                        from order_items where order_id = v_order), 'I1 the old call cannot write guest fields');
  perform pg_temp.ok(not exists (select 1 from print_jobs j, jsonb_array_elements(j.payload->'lines') l
                                  where j.order_id = v_order and j.kind = 'ticket' and (l ? 'guest')), 'I2 its ticket lines carry no guest key');
  perform pg_temp.ok((select l->>'guestLabel' from jsonb_array_elements(qr_cart_state(v_tok)->'lines') l where l->>'id' = idx::text) = 'Ann',
                     'I3 a sent guest''s label is not changed by the old call');

  -- ── J: stale lines ──
  update qr_cart_lines set created_at = now() - interval '3 hours' where id = idx;
  s := qr_cart_state(v_tok);
  perform pg_temp.ok(not exists (select 1 from jsonb_array_elements(s->'lines') l where l->>'id' = idx::text), 'J1 a line older than 2 hours is dropped');
  perform pg_temp.ok(exists (select 1 from jsonb_array_elements(s->'lines') l where l->>'id' = ida::text), 'J2 a fresh line stays');
  update qr_cart_lines set created_at = now() - interval '10 minutes' where id = ida;
  update bills set status = 'voided', closed_at = now() - interval '1 minute', void_reason = 'verify'
   where table_id = v_table.id and status = 'open';
  s := qr_cart_state(v_tok);
  perform pg_temp.ok(jsonb_array_length(s->'lines') = 0, 'J3 lines from before the bill closed are dropped');
  -- J4: the next party's bill is already open — an old party's line still goes
  ida := qr_cart_put(v_tok, gd, v_line, null);
  update qr_cart_lines set created_at = now() - interval '10 minutes' where id = ida;   -- before the close in J3
  perform place_table_order(v_tok, null, jsonb_build_array(v_line), gen_random_uuid());  -- opens a new bill
  perform pg_temp.ok(exists (select 1 from bills b where b.table_id = v_table.id and b.status = 'open'), 'J4a a new bill is open');
  s := qr_cart_state(v_tok);
  perform pg_temp.ok(jsonb_array_length(s->'lines') = 0, 'J4 the old party''s line is dropped though a bill is open');
  -- J5: a paid part of a split bill is not the table closing
  ida := qr_cart_put(v_tok, gd, v_line, null);
  update qr_cart_lines set created_at = now() - interval '30 seconds' where id = ida;   -- after J3's close (1 min ago), before the part's
  insert into bills(branch_id, bill_no, table_id, order_type, status, closed_at, split_from)
  select b.branch_id, b.bill_no || '-V', b.table_id, 'dine_in', 'paid', now() - interval '10 seconds', b.id
    from bills b where b.table_id = v_table.id and b.status = 'open';
  s := qr_cart_state(v_tok);
  perform pg_temp.ok(jsonb_array_length(s->'lines') = 1, 'J5 a paid part does not clear the cart');
end $$;

rollback;
select 'VERIFY OK' as result;
