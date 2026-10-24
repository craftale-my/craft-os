-- Self-check for the POS checkout migrations (Sub-plan 3). Run on craft-os-dev after
-- migration-2026-10-24-pos-checkout.sql, -checkout-fn.sql, -bill-actions-fn.sql and
-- -checkout-fixes.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- The vectors below are a byte-for-byte copy of src/features/pos/checkout/billVectors.json
-- (bill.test.ts fails if the two differ).
begin;

do $$
declare
  v_vectors jsonb := $vectors$
[
  {"name": "receipt #87846: dine-in, 10% service charge, 6% SST", "input": {"orderType": "dine_in", "tableId": "t-7", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-b", "unitPriceSen": 2500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-c", "unitPriceSen": 1800, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-d", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 8000, "serviceChargeSen": 800, "sstSen": 480, "takeawayFeeSen": 0, "beforeRoundingSen": 9280, "roundingSen": 0, "totalSen": 9280, "sstGroups": [{"rateBp": 600, "baseSen": 8000, "amountSen": 480}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 8000, "amountSen": 800}]}},
  {"name": "takeaway: packaging fee per unit carries SST, no service charge, rounds 4399 up to 4400", "input": {"orderType": "takeaway", "tableId": null, "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 2, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1250, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 3850, "serviceChargeSen": 0, "sstSen": 249, "takeawayFeeSen": 300, "beforeRoundingSen": 4399, "roundingSen": 1, "totalSen": 4400, "sstGroups": [{"rateBp": 600, "baseSen": 4150, "amountSen": 249}], "serviceChargeGroups": []}},
  {"name": "0% SST item pays service charge but no SST", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-keychain", "unitPriceSen": 3500, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 5900, "serviceChargeSen": 590, "sstSen": 144, "takeawayFeeSen": 0, "beforeRoundingSen": 6634, "roundingSen": 1, "totalSen": 6635, "sstGroups": [{"rateBp": 600, "baseSen": 2400, "amountSen": 144}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 5900, "amountSen": 590}]}},
  {"name": "rounding: 1001 sen -> 1000 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1001, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1001, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1001, "roundingSen": -1, "totalSen": 1000, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1002 sen -> 1000 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1002, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1002, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1002, "roundingSen": -2, "totalSen": 1000, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1003 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1003, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1003, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1003, "roundingSen": 2, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1004 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1004, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1004, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1004, "roundingSen": 1, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1005 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1005, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1005, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1005, "roundingSen": 0, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1006 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1006, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1006, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1006, "roundingSen": -1, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1007 sen -> 1005 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1007, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1007, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1007, "roundingSen": -2, "totalSen": 1005, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1008 sen -> 1010 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1008, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1008, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1008, "roundingSen": 2, "totalSen": 1010, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding: 1009 sen -> 1010 sen", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1009, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1009, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1009, "roundingSen": 1, "totalSen": 1010, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "rounding off: 1003 sen stays 1003", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "none", "rules": [], "lines": [{"productId": "p-x", "unitPriceSen": 1003, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1003, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 1003, "roundingSen": 0, "totalSen": 1003, "sstGroups": [], "serviceChargeGroups": []}},
  {"name": "voided line is excluded", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": true}, {"productId": "p-b", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 1300, "serviceChargeSen": 130, "sstSen": 78, "takeawayFeeSen": 0, "beforeRoundingSen": 1508, "roundingSen": 2, "totalSen": 1510, "sstGroups": [{"rateBp": 600, "baseSen": 1300, "amountSen": 78}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 1300, "amountSen": 130}]}},
  {"name": "service-charge rules: table rule matches first on the VIP table", "input": {"orderType": "dine_in", "tableId": "t-vip", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": ["t-vip"], "productIds": null}, {"rateBp": 500, "orderTypes": ["dine_in"], "tableIds": null, "productIds": ["p-cake"]}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2800, "serviceChargeSen": 280, "sstSen": 168, "takeawayFeeSen": 0, "beforeRoundingSen": 3248, "roundingSen": 2, "totalSen": 3250, "sstGroups": [{"rateBp": 600, "baseSen": 2800, "amountSen": 168}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 2800, "amountSen": 280}]}},
  {"name": "service-charge rules: elsewhere only the cake rule matches", "input": {"orderType": "dine_in", "tableId": "t-2", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": ["t-vip"], "productIds": null}, {"rateBp": 500, "orderTypes": ["dine_in"], "tableIds": null, "productIds": ["p-cake"]}], "lines": [{"productId": "p-latte", "unitPriceSen": 1300, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-cake", "unitPriceSen": 1500, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2800, "serviceChargeSen": 75, "sstSen": 168, "takeawayFeeSen": 0, "beforeRoundingSen": 3043, "roundingSen": 2, "totalSen": 3045, "sstGroups": [{"rateBp": 600, "baseSen": 2800, "amountSen": 168}], "serviceChargeGroups": [{"rateBp": 500, "baseSen": 1500, "amountSen": 75}]}},
  {"name": "SST per rate group, not per line: 2 x 11.55 at 6% is 1.39 (per line would be 1.38)", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1155, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-b", "unitPriceSen": 1155, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}, {"productId": "p-c", "unitPriceSen": 990, "qty": 1, "sstRateBp": 800, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 3300, "serviceChargeSen": 330, "sstSen": 218, "takeawayFeeSen": 0, "beforeRoundingSen": 3848, "roundingSen": 2, "totalSen": 3850, "sstGroups": [{"rateBp": 600, "baseSen": 2310, "amountSen": 139}, {"rateBp": 800, "baseSen": 990, "amountSen": 79}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 3300, "amountSen": 330}]}},
  {"name": "half a sen rounds up: 24.75 x 6% = 1.485 -> 1.49", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-a", "unitPriceSen": 2475, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2475, "serviceChargeSen": 0, "sstSen": 149, "takeawayFeeSen": 0, "beforeRoundingSen": 2624, "roundingSen": 1, "totalSen": 2625, "sstGroups": [{"rateBp": 600, "baseSen": 2475, "amountSen": 149}], "serviceChargeGroups": []}},
  {"name": "branch not SST-registered: no SST", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": false, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 2400, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 0, "voided": false}]}, "expected": {"subtotalSen": 2400, "serviceChargeSen": 240, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 2640, "roundingSen": 0, "totalSen": 2640, "sstGroups": [], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 2400, "amountSen": 240}]}},
  {"name": "takeaway rule: service charge on the item only, SST on item + fee", "input": {"orderType": "takeaway", "tableId": null, "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in", "takeaway"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1000, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 1000, "serviceChargeSen": 100, "sstSen": 66, "takeawayFeeSen": 100, "beforeRoundingSen": 1266, "roundingSen": -1, "totalSen": 1265, "sstGroups": [{"rateBp": 600, "baseSen": 1100, "amountSen": 66}], "serviceChargeGroups": [{"rateBp": 1000, "baseSen": 1000, "amountSen": 100}]}},
  {"name": "takeaway: the fee of a 0% SST item is untaxed", "input": {"orderType": "takeaway", "tableId": null, "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [{"rateBp": 1000, "orderTypes": ["dine_in"], "tableIds": null, "productIds": null}], "lines": [{"productId": "p-a", "unitPriceSen": 1000, "qty": 1, "sstRateBp": 600, "takeawayFeeSen": 100, "voided": false}, {"productId": "p-keychain", "unitPriceSen": 2000, "qty": 1, "sstRateBp": 0, "takeawayFeeSen": 50, "voided": false}]}, "expected": {"subtotalSen": 3000, "serviceChargeSen": 0, "sstSen": 66, "takeawayFeeSen": 150, "beforeRoundingSen": 3216, "roundingSen": -1, "totalSen": 3215, "sstGroups": [{"rateBp": 600, "baseSen": 1100, "amountSen": 66}], "serviceChargeGroups": []}},
  {"name": "packaging fee is ignored on a dine-in bill", "input": {"orderType": "dine_in", "tableId": "t-1", "sstRegistered": true, "cashRounding": "nearest_5_sen", "rules": [], "lines": [{"productId": "p-a", "unitPriceSen": 1000, "qty": 2, "sstRateBp": 0, "takeawayFeeSen": 100, "voided": false}]}, "expected": {"subtotalSen": 2000, "serviceChargeSen": 0, "sstSen": 0, "takeawayFeeSen": 0, "beforeRoundingSen": 2000, "roundingSen": 0, "totalSen": 2000, "sstGroups": [], "serviceChargeGroups": []}}
]
$vectors$;
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_sup     uuid := 'aaaaaaaa-0000-0000-0000-000000000001';   -- verify supervisor
  v_staff   uuid := 'aaaaaaaa-0000-0000-0000-000000000002';   -- verify cashier (no pos_supervise)
  v_far     uuid := 'aaaaaaaa-0000-0000-0000-000000000003';   -- supervisor of another branch
  v_branch  uuid; v_branch2 uuid;
  v_t1 dining_tables; v_t2 dining_tables; v_t3 dining_tables; v_t4 dining_tables;
  v_cat uuid; v_plate uuid; v_plate_var uuid; v_catalog uuid;
  v_cash uuid; v_card uuid; v_tng uuid; v_far_cash uuid;
  v_order uuid; v_bill bills; v_bill2 bills; v_bill3 bills;
  v_item uuid; v_items jsonb; v_res jsonb; v_res2 jsonb; v_job print_jobs;
  v_refund uuid := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_refund2 uuid := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_refund3 uuid := 'bbbbbbbb-0000-0000-0000-000000000003';
  v_refund4 uuid := 'bbbbbbbb-0000-0000-0000-000000000004';
  v_left text;
  v_checkout uuid := 'cccccccc-0000-0000-0000-000000000001';
  n integer; r record; v_role text;
begin
  -- ── A. schema, RLS, grants ────────────────────────────────────────────────
  for r in select t from unnest(array['branch_pos_settings','service_charge_rules','payment_methods',
                                      'reason_templates','payments','refunds','staff_pos_pins']) as t loop
    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname = r.t and c.relrowsecurity) then
      raise exception 'FAIL schema: % missing or RLS off', r.t;
    end if;
  end loop;
  for r in select t from unnest(array['branch_pos_settings','service_charge_rules','payment_methods',
                                      'reason_templates','payments','refunds']) as t loop
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = 'pos_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no pos_read', r.t;
    end if;
  end loop;
  if exists (select 1 from pg_policies where tablename in ('payments','refunds','branch_pos_settings')
              and cmd in ('INSERT','UPDATE','DELETE','ALL')) then
    raise exception 'FAIL rls: payments/refunds/branch_pos_settings must be written only by RPCs';
  end if;
  -- settings tables: written only by a live manager of the row's own branch (fixes I1)
  for r in select t from unnest(array['service_charge_rules','payment_methods','reason_templates']) as t loop
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = r.t || '_manage' and cmd = 'ALL'
                    and qual like '%pos_caller_branch()%' and qual like '%has_menu_cap%'
                    and with_check like '%pos_caller_branch()%' and with_check like '%has_menu_cap%') then
      raise exception 'FAIL rls: %_manage is not limited to the caller''s branch', r.t;
    end if;
  end loop;
  if exists (select 1 from pg_policies where tablename = 'staff_pos_pins')
     or has_table_privilege('authenticated', 'staff_pos_pins', 'SELECT')
     or has_table_privilege('anon', 'staff_pos_pins', 'SELECT') then
    raise exception 'FAIL pins: PIN hashes must be unreadable by clients';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'bills') then
    raise exception 'FAIL realtime: bills not published';
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'bills' and column_name = 'status')
     and not exists (select 1 from pg_constraint where conname = 'bills_status_check'
                      and pg_get_constraintdef(oid) like '%merged%') then
    raise exception 'FAIL schema: bills.status does not allow merged';
  end if;
  -- callable by staff, never by anon
  for r in select f from unnest(array[
      'pos_compute_bill(jsonb)', 'pos_bill_totals(uuid)', 'checkout_bill(uuid,jsonb,uuid)', 'reprint_receipt(uuid)',
      'save_receipt_settings(jsonb)', 'pos_approvers()', 'set_my_pos_pin(text,text)', 'clear_pos_pin(uuid)',
      'void_order_item(uuid,text,uuid,text)', 'void_bill(uuid,text,uuid,text)', 'move_bill(uuid,uuid)',
      'merge_bills(uuid,uuid)', 'refund_bill(uuid,uuid,integer,uuid,text,uuid,text)', 'open_table(uuid,integer)',
      'pos_caller_branch()', 'pos_refundable_methods(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  -- internal: nobody outside the definer functions
  for r in select f from unnest(array[
      'pos_my_branch()', 'pos_receipt_payload(uuid,boolean)', 'pos_queue_receipt(uuid,boolean)', 'pos_checkout_result(uuid)',
      'staff_has_cap(uuid,text)', 'pos_pin_attempt(uuid,text)', 'pos_check_approver(uuid,uuid,text)',
      'pos_check_reason(uuid,text,text)', 'pos_queue_void_tickets(uuid[])', 'pos_refund_slip_payload(uuid)',
      'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'place_table_order(text,integer,jsonb,uuid)', 'execute') then
    raise exception 'FAIL grants: anon lost place_table_order';
  end if;
  -- every function of this sub-plan pins its search_path
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'pos_my_branch','pos_compute_bill','pos_bill_totals','pos_insert_order','place_table_order','place_counter_order',
              'pos_receipt_payload','pos_queue_receipt','pos_checkout_result','checkout_bill','reprint_receipt',
              'save_receipt_settings','has_menu_cap','staff_has_cap','pos_approvers','pos_pin_attempt','set_my_pos_pin',
              'clear_pos_pin','pos_check_approver','pos_check_reason','pos_queue_void_tickets','void_order_item',
              'void_bill','move_bill','merge_bills','pos_refund_slip_payload','refund_bill','open_table','pos_caller_branch',
              'pos_refundable_methods'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;

  -- ── B. totals: the shared vectors ─────────────────────────────────────────
  if jsonb_array_length(v_vectors) <> 22 then raise exception 'FAIL vectors: expected 22, got %', jsonb_array_length(v_vectors); end if;
  for r in select v from jsonb_array_elements(v_vectors) v loop
    if pos_compute_bill(r.v->'input') <> r.v->'expected' then
      raise exception 'FAIL vector "%": got %', r.v->>'name', pos_compute_bill(r.v->'input');
    end if;
  end loop;

  -- ── C. fixture: two branches, staff, tables, a menu item, methods, settings ─
  insert into branches(name, address, receipt_title, legal_name, sst_no) values ('VERIFY', 'verify street', 'Verify Cafe', 'Verify Sdn Bhd', 'W10-VERIFY')
    returning id into v_branch;
  insert into branches(name, address) values ('VERIFY2', 'far away') returning id into v_branch2;
  insert into dining_tables(branch_id, label) values (v_branch, 'V1') returning * into v_t1;
  insert into dining_tables(branch_id, label) values (v_branch, 'V2') returning * into v_t2;
  insert into dining_tables(branch_id, label) values (v_branch, 'V3') returning * into v_t3;
  insert into dining_tables(branch_id, label) values (v_branch, 'V4') returning * into v_t4;
  insert into print_routes(branch_id, name, kind, address) values (v_branch, 'Bar', 'agent', '127.0.0.1:9100');
  insert into menu_categories(name) values ('VERIFY CAT') returning id into v_cat;
  insert into menu_products(name, category_id, feedme_product_id, print_route, sst_rate_bp, takeaway_fee_sen)
    values ('Verify Plate', v_cat, 'verify-c-plate', 'Bar', 600, 100) returning id into v_plate;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_plate, '', 'Regular', 2000)
    returning id into v_plate_var;
  -- M1 (catalogs): the VERIFY branch sells the plate from one catalog for dine-in, takeaway and QR, at the default price
  insert into menu_catalogs(name) values ('VERIFY C CATALOG') returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_var, 2000);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, needs_reference, sort_order) values (v_branch, 'V Cash', 'cash', false, 1)
    returning id into v_cash;
  insert into payment_methods(branch_id, name, kind, needs_reference, sort_order) values (v_branch, 'V Card', 'card', true, 2)
    returning id into v_card;
  insert into payment_methods(branch_id, name, kind, needs_reference, sort_order) values (v_branch, 'V TnG', 'ewallet', false, 3)
    returning id into v_tng;
  insert into payment_methods(branch_id, name, kind) values (v_branch2, 'X Cash', 'cash') returning id into v_far_cash;
  insert into branch_pos_settings(branch_id, receipt_route) values (v_branch, 'Bar');
  insert into service_charge_rules(branch_id, rate_bp, order_types) values (v_branch, 1000, array['dine_in']);
  insert into reason_templates(branch_id, action, reasons, compulsory, allow_other)
    values (v_branch, 'void_item', array['Wrong item keyed', 'Customer changed mind'], true, false);
  update system_role_permissions set permissions = permissions - 'pos_supervise';   -- code defaults for this run
  update staff set branch_id = v_branch where id = v_owner;
  delete from staff_pos_pins where staff_id = v_owner;                           -- the owner approves without a PIN below
  insert into auth.users (id) values (v_sup), (v_staff), (v_far);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_sup,   'Verify Supervisor', 'supervisor', true, current_date, 'supervisor', v_branch),
    (v_staff, 'Verify Cashier',    'trainee',    true, current_date, 'staff',      v_branch),
    (v_far,   'Far Supervisor',    'supervisor', true, current_date, 'supervisor', v_branch2);
  -- Sub-plan 4a (migration-2026-10-24-pos-shifts.sql): money moves only inside an open shift.
  -- Once shifts are applied, VERIFY works inside one; the shifts verify script tests the shifts.
  if to_regclass('public.pos_shifts') is not null then
    execute 'insert into pos_shifts(branch_id, opened_by, opening_float_sen) values ($1, $2, 0)' using v_branch, v_owner;
  end if;

  -- ── D. capability pos_supervise: defaults, Owner override, SQL helpers agree ─
  for r in select * from (values ('owner', true), ('admin', true), ('hr', false), ('manager', true),
                                 ('supervisor', true), ('staff', false)) as x(role, expected) loop
    -- the owner changes the role (staff_guard_authority_update refuses a self-promotion)
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    update staff set system_role = r.role where id = v_staff;
    perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    if staff_has_cap(v_staff, 'pos_supervise') <> r.expected or has_menu_cap('pos_supervise') <> r.expected then
      raise exception 'FAIL cap: % pos_supervise should be %', r.role, r.expected;
    end if;
    if staff_has_cap(v_staff, 'access_settings') <> has_menu_cap('access_settings') then
      raise exception 'FAIL cap: staff_has_cap and has_menu_cap disagree on access_settings for %', r.role;
    end if;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set system_role = 'staff' where id = v_staff;
  update system_role_permissions set permissions = permissions || '{"pos_supervise": false}' where system_role = 'supervisor';
  if staff_has_cap(v_sup, 'pos_supervise') then raise exception 'FAIL cap: Owner override ignored'; end if;
  update system_role_permissions set permissions = permissions - 'pos_supervise' where system_role = 'supervisor';

  -- ── E. PINs ───────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  begin perform set_my_pos_pin('12a4', null); raise exception 'FAIL: bad PIN accepted';
  exception when raise_exception then if sqlerrm <> 'The PIN must be 4 to 6 digits' then raise; end if; end;
  if not (set_my_pos_pin('1234', null)->>'ok')::boolean then raise exception 'FAIL pin: first PIN not set'; end if;
  if (select pin_hash from staff_pos_pins where staff_id = v_sup) !~ '^\$2[ab]\$' then raise exception 'FAIL pin: not bcrypt'; end if;
  v_res := set_my_pos_pin('5678', '0000');
  if (v_res->>'ok')::boolean or v_res->>'error' <> 'Current PIN: Wrong PIN — 4 tries left' then
    raise exception 'FAIL pin: change without the current PIN: %', v_res;
  end if;
  if not (set_my_pos_pin('1234', '1234')->>'ok')::boolean then raise exception 'FAIL pin: change with the current PIN'; end if;
  if (select failed_attempts from staff_pos_pins where staff_id = v_sup) <> 0 then raise exception 'FAIL pin: counter not reset'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_far, 'role', 'authenticated')::text, true);
  perform set_my_pos_pin('9999', null);
  -- approvers of the VERIFY branch: the owner (test login) and the supervisor, not the cashier or VERIFY2's supervisor
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  if (select array_agg(staff_id order by name) from pos_approvers()) is distinct from
     (select array_agg(id order by name) from staff where id in (v_owner, v_sup)) then
    raise exception 'FAIL approvers: %', (select json_agg(a) from pos_approvers() a);
  end if;
  if not (select has_pin from pos_approvers() where staff_id = v_sup) then raise exception 'FAIL approvers: has_pin'; end if;
  begin perform clear_pos_pin(v_sup); raise exception 'FAIL: cashier cleared a PIN';
  exception when raise_exception then if sqlerrm <> 'Only a manager can clear a PIN' then raise; end if; end;

  -- ── F. totals of a real bill; takeaway fee snapshot ────────────────────────
  -- (the cashier places the orders: any staff member may)
  v_order := place_counter_order(v_t1.id, 'dine_in', 4,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var, 'qty', 4)),
    gen_random_uuid());
  select b.* into v_bill from bills b join orders o on o.bill_id = b.id where o.id = v_order;
  if (select takeaway_fee_sen from order_items where order_id = v_order) <> 0 then raise exception 'FAIL fee: dine-in item has a fee'; end if;
  v_res := pos_bill_totals(v_bill.id);
  if (v_res->>'subtotalSen')::int <> 8000 or (v_res->>'serviceChargeSen')::int <> 800 or (v_res->>'sstSen')::int <> 480
     or (v_res->>'totalSen')::int <> 9280 then
    raise exception 'FAIL totals: %', v_res;
  end if;
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var, 'qty', 2)), gen_random_uuid());
  select b.* into v_bill2 from bills b join orders o on o.bill_id = b.id where o.id = v_order;
  if (select takeaway_fee_sen from order_items where order_id = v_order) <> 100 then raise exception 'FAIL fee: takeaway not snapshotted'; end if;
  v_res := pos_bill_totals(v_bill2.id);
  -- 4000 + fee 200 + SST 6% of (4000 + 200) = 252 → 4452, rounded to 4450; no service charge on takeaway (dine-in rule)
  if (v_res->>'takeawayFeeSen')::int <> 200 or (v_res->>'serviceChargeSen')::int <> 0 or (v_res->>'sstSen')::int <> 252
     or (v_res->>'totalSen')::int <> 4450 then
    raise exception 'FAIL takeaway totals: %', v_res;
  end if;

  -- ── G. checkout ───────────────────────────────────────────────────────────
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_tng, 'amountSen', 9000)), gen_random_uuid());
    raise exception 'FAIL: short payment accepted';
  exception when raise_exception then if sqlerrm <> 'Payments (RM 90.00) do not match the total (RM 92.80)' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_tng, 'amountSen', 9280, 'tenderedSen', 10000)), gen_random_uuid());
    raise exception 'FAIL: change on e-wallet';
  exception when raise_exception then if sqlerrm <> 'Only cash can be tendered above the amount' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', 9280, 'tenderedSen', 5000)), gen_random_uuid());
    raise exception 'FAIL: cash below amount';
  exception when raise_exception then if sqlerrm <> 'Cash received is less than the amount' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_card, 'amountSen', 9280)), gen_random_uuid());
    raise exception 'FAIL: card without reference';
  exception when raise_exception then if sqlerrm <> 'Enter the reference for V Card' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_far_cash, 'amountSen', 9280)), gen_random_uuid());
    raise exception 'FAIL: other branch method';
  exception when raise_exception then if sqlerrm <> 'Payment method is not available at this branch' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_tng, 'amountSen', 9280.5)), gen_random_uuid());
    raise exception 'FAIL: fractional sen';
  exception when raise_exception then if sqlerrm <> 'Invalid payment amount' then raise; end if; end;
  if exists (select 1 from payments where bill_id = v_bill.id) then raise exception 'FAIL: a refused checkout wrote payments'; end if;

  v_res := checkout_bill(v_bill.id, jsonb_build_array(
    jsonb_build_object('methodId', v_tng, 'amountSen', 5000, 'reference', null),
    jsonb_build_object('methodId', v_cash, 'amountSen', 4280, 'tenderedSen', 5000)), v_checkout);
  if v_res->>'billNo' <> v_bill.bill_no or (v_res->>'totalSen')::int <> 9280 or (v_res->>'changeSen')::int <> 720
     or not (v_res->>'receiptQueued')::boolean then
    raise exception 'FAIL checkout result: %', v_res;
  end if;
  select * into v_bill from bills where id = v_bill.id;
  if v_bill.status <> 'paid' or v_bill.closed_by <> v_staff or v_bill.closed_at is null or v_bill.total_sen <> 9280
     or v_bill.subtotal_sen <> 8000 or v_bill.service_charge_sen <> 800 or v_bill.sst_sen <> 480 or v_bill.rounding_sen <> 0
     or v_bill.totals->'sstGroups'->0->>'baseSen' <> '8000' or not v_bill.receipt_queued then
    raise exception 'FAIL paid bill: %', row_to_json(v_bill);
  end if;
  if (select string_agg(method_name || ':' || amount_sen || ':' || coalesce(tendered_sen, -1) || ':' || change_sen, ',' order by line_no)
        from payments where bill_id = v_bill.id) <> 'V TnG:5000:-1:0,V Cash:4280:5000:720' then
    raise exception 'FAIL payments rows';
  end if;
  select * into v_job from print_jobs where branch_id = v_branch and kind = 'receipt' and payload->>'billNo' = v_bill.bill_no;
  if v_job.route <> 'Bar' or v_job.payload->>'kind' <> 'receipt' or (v_job.payload->>'reprint')::boolean
     or v_job.payload->'header'->>'title' <> 'Verify Cafe' or v_job.payload->'header'->>'sstNo' <> 'W10-VERIFY'
     or v_job.payload->>'cashier' <> 'Verify Cashier' or v_job.payload->>'tableLabel' <> 'V1' or (v_job.payload->>'pax')::int <> 4
     or (v_job.payload->>'itemCount')::int <> 4 or v_job.payload->'items'->0->>'name' <> 'Verify Plate'
     or (v_job.payload->'items'->0->>'amountSen')::int <> 8000 or (v_job.payload->>'totalSen')::int <> 9280
     or v_job.payload->'payments'->1->>'name' <> 'V Cash' or (v_job.payload->'payments'->1->>'tenderedSen')::int <> 5000
     or (v_job.payload->>'changeSen')::int <> 720
     or v_job.payload->'serviceChargeGroups' <> '[{"rateBp": 1000, "baseSen": 8000, "amountSen": 800}]'::jsonb
     or v_job.payload->>'footer' <> 'This is an official receipt. Thank you for visiting us.' then
    raise exception 'FAIL receipt payload: %', v_job.payload;
  end if;
  -- the same checkout again: the first answer, nothing new
  if checkout_bill(v_bill.id, '[]'::jsonb, v_checkout) <> v_res then raise exception 'FAIL checkout replay'; end if;
  select count(*) into n from payments where bill_id = v_bill.id; if n <> 2 then raise exception 'FAIL replay wrote payments'; end if;
  select count(*) into n from print_jobs where branch_id = v_branch and kind = 'receipt' and payload->>'billNo' = v_bill.bill_no;
  if n <> 1 then raise exception 'FAIL replay queued % receipts', n; end if;
  -- a checkout id is only ever replayed for its own bill
  begin perform checkout_bill(v_bill2.id, '[]'::jsonb, v_checkout); raise exception 'FAIL: checkout id reused on another bill';
  exception when raise_exception then if sqlerrm <> 'This checkout id belongs to another bill' then raise; end if; end;
  begin perform checkout_bill(v_bill.id, jsonb_build_array(jsonb_build_object('methodId', v_tng, 'amountSen', 9280)), gen_random_uuid());
    raise exception 'FAIL: paid twice';
  exception when raise_exception then if sqlerrm <> 'This bill is already paid' then raise; end if; end;
  -- a paid bill is closed for good: a new order on its table opens a new bill
  v_order := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  if (select bill_id from orders where id = v_order) = v_bill.id then raise exception 'FAIL: order joined a paid bill'; end if;
  select count(*) into n from orders where bill_id = v_bill.id; if n <> 1 then raise exception 'FAIL: paid bill gained orders'; end if;
  select id into v_item from order_items where bill_id = v_bill.id limit 1;
  begin perform void_order_item(v_item, 'Wrong item keyed', v_sup, '1234'); raise exception 'FAIL: voided on a paid bill';
  exception when raise_exception then if sqlerrm not like 'Only items on an open bill can be voided%' then raise; end if; end;
  -- reprint
  perform reprint_receipt(v_bill.id);
  select count(*) into n from print_jobs where branch_id = v_branch and kind = 'receipt' and payload->>'billNo' = v_bill.bill_no
     and (payload->>'reprint')::boolean;
  if n <> 1 then raise exception 'FAIL reprint'; end if;
  update branch_pos_settings set receipt_route = null where branch_id = v_branch;
  begin perform reprint_receipt(v_bill.id); raise exception 'FAIL: reprint without a printer';
  exception when raise_exception then if sqlerrm not like 'No receipt printer is set%' then raise; end if; end;
  update branch_pos_settings set receipt_route = 'Bar' where branch_id = v_branch;
  -- nothing to pay for
  v_item := open_table(v_t3.id, 2);
  begin perform checkout_bill(v_item, '[]'::jsonb, gen_random_uuid()); raise exception 'FAIL: empty bill paid';
  exception when raise_exception then if sqlerrm <> 'This bill has no items to pay for' then raise; end if; end;

  -- ── H. void item: reasons, approver, PIN, lockout ─────────────────────────
  select b.* into v_bill3 from bills b where b.table_id = v_t1.id and b.status = 'open';     -- V1's new bill
  select id into v_item from order_items where bill_id = v_bill3.id limit 1;
  begin perform void_order_item(v_item, '', v_sup, '1234'); raise exception 'FAIL: no reason';
  exception when raise_exception then if sqlerrm <> 'Choose a reason' then raise; end if; end;
  begin perform void_order_item(v_item, 'Felt like it', v_sup, '1234'); raise exception 'FAIL: unlisted reason';
  exception when raise_exception then if sqlerrm <> 'Choose one of the listed reasons' then raise; end if; end;
  begin perform void_order_item(v_item, 'Wrong item keyed', v_staff, '1234'); raise exception 'FAIL: cashier approved';
  exception when raise_exception then if sqlerrm <> 'This person cannot approve voids or refunds' then raise; end if; end;
  begin perform void_order_item(v_item, 'Wrong item keyed', v_far, '9999'); raise exception 'FAIL: other branch approved';
  exception when raise_exception then if sqlerrm <> 'The approver is not active staff of this branch' then raise; end if; end;
  -- a resigned person keeps is_active = true; status = 'resigned' must end their authority
  update staff set status = 'resigned' where id = v_sup;
  begin perform void_order_item(v_item, 'Wrong item keyed', v_sup, '1234'); raise exception 'FAIL: resigned approver approved';
  exception when raise_exception then if sqlerrm <> 'The approver is not active staff of this branch' then raise; end if; end;
  update staff set status = 'active' where id = v_sup;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set status = 'resigned' where id = v_staff;                     -- the owner changes it (staff_guard)
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  begin perform place_counter_order(v_t2.id, 'dine_in', 1,
          jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
    raise exception 'FAIL: resigned cashier ordered';
  exception when raise_exception then if sqlerrm <> 'Your account is not active' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set status = 'active' where id = v_staff;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_res := void_order_item(v_item, 'Wrong item keyed', v_owner, '1234');
  if (v_res->>'ok')::boolean or v_res->>'error' not like 'No POS PIN is set%' then raise exception 'FAIL: approver without a PIN: %', v_res; end if;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if (v_res->>'ok')::boolean or v_res->>'error' <> 'Wrong PIN — 4 tries left' then raise exception 'FAIL wrong PIN: %', v_res; end if;
  if (select voided_at from order_items where id = v_item) is not null then raise exception 'FAIL: wrong PIN voided'; end if;
  if (select failed_attempts from staff_pos_pins where staff_id = v_sup) <> 1 then raise exception 'FAIL: wrong PIN not counted'; end if;
  v_res := void_order_item(v_item, ' Wrong item keyed ', v_sup, '1234');
  if not (v_res->>'ok')::boolean then raise exception 'FAIL void item: %', v_res; end if;
  if not exists (select 1 from order_items where id = v_item and voided_at is not null and voided_by = v_staff
                   and void_approved_by = v_sup and void_reason = 'Wrong item keyed') then
    raise exception 'FAIL void item audit';
  end if;
  select * into v_job from print_jobs where order_id = (select order_id from order_items where id = v_item)
     and (payload->>'void')::boolean;
  if v_job.route <> 'Bar' or v_job.payload->'lines'->0->>'name' <> 'Verify Plate' or v_job.payload->>'tableLabel' <> 'V1' then
    raise exception 'FAIL void ticket: %', v_job.payload;
  end if;
  if not (void_order_item(v_item, 'Wrong item keyed', v_sup, '0000')->>'ok')::boolean then raise exception 'FAIL void retry'; end if;
  select count(*) into n from print_jobs where order_id = (select order_id from order_items where id = v_item) and (payload->>'void')::boolean;
  if n <> 1 then raise exception 'FAIL void retry printed again'; end if;
  -- lockout: 5 wrong PINs lock the approver for 10 minutes, even the right PIN
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  select id into v_item from order_items where order_id = v_order;
  for n in 1..4 loop perform void_order_item(v_item, 'Wrong item keyed', v_sup, '0000'); end loop;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if v_res->>'error' <> 'Wrong PIN — locked for 10 minutes after 5 wrong tries' then raise exception 'FAIL lockout: %', v_res; end if;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '1234');
  if (v_res->>'ok')::boolean or v_res->>'error' not like 'Too many wrong PINs — locked until %' then raise exception 'FAIL locked: %', v_res; end if;
  update staff_pos_pins set locked_until = now() - interval '1 second' where staff_id = v_sup;
  -- wrong tries older than a day are forgotten: 4 old failures + 1 new = "4 tries left", not a lock
  update staff_pos_pins set failed_attempts = 4, updated_at = now() - interval '2 days' where staff_id = v_sup;
  v_res := void_order_item(v_item, 'Wrong item keyed', v_sup, '0000');
  if v_res->>'error' <> 'Wrong PIN — 4 tries left' then raise exception 'FAIL: old failures still counted: %', v_res; end if;
  -- the supervisor may approve their own action
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  if not (void_order_item(v_item, 'Customer changed mind', v_sup, '1234')->>'ok')::boolean then raise exception 'FAIL self-approval'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

  -- ── I. void bill; empty bill closes without approval ──────────────────────
  v_order := place_counter_order(v_t2.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var, 'qty', 2)), gen_random_uuid());
  select b.* into v_bill2 from bills b join orders o on o.bill_id = b.id where o.id = v_order;
  begin perform void_bill(v_bill2.id, '', v_sup, '1234'); raise exception 'FAIL: void bill without reason';
  exception when raise_exception then if sqlerrm <> 'Choose a reason' then raise; end if; end;
  v_res := void_bill(v_bill2.id, 'Customer left', v_sup, '1234');
  if not (v_res->>'ok')::boolean then raise exception 'FAIL void bill: %', v_res; end if;
  select * into v_bill2 from bills where id = v_bill2.id;
  if v_bill2.status <> 'voided' or v_bill2.closed_at is null or v_bill2.void_reason <> 'Customer left' or v_bill2.void_approved_by <> v_sup
     or exists (select 1 from order_items where bill_id = v_bill2.id and voided_at is null) then
    raise exception 'FAIL voided bill: %', row_to_json(v_bill2);
  end if;
  if not exists (select 1 from print_jobs where order_id = v_order and (payload->>'void')::boolean) then raise exception 'FAIL void bill ticket'; end if;
  select id into v_item from bills where table_id = v_t3.id and status = 'open';      -- V3: opened, nothing ordered
  if not (void_bill(v_item, null, null, null)->>'ok')::boolean then raise exception 'FAIL: empty bill needs approval'; end if;

  -- ── J. move and merge ─────────────────────────────────────────────────────
  v_order := place_counter_order(v_t2.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  select b.* into v_bill2 from bills b join orders o on o.bill_id = b.id where o.id = v_order;     -- open on V2
  begin perform move_bill(v_bill3.id, v_t2.id); raise exception 'FAIL: moved onto an occupied table';
  exception when raise_exception then if sqlerrm <> 'Table V2 already has an open bill — merge instead' then raise; end if; end;
  perform move_bill(v_bill3.id, v_t3.id);
  if (select table_id from bills where id = v_bill3.id) <> v_t3.id then raise exception 'FAIL move'; end if;
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  select b.* into v_bill from bills b join orders o on o.bill_id = b.id where o.id = v_order;       -- a takeaway bill
  begin perform move_bill(v_bill.id, v_t4.id); raise exception 'FAIL: takeaway moved';
  exception when raise_exception then if sqlerrm <> 'Only a dine-in bill can move to another table' then raise; end if; end;
  begin perform merge_bills(v_bill3.id, v_bill.id); raise exception 'FAIL: table bill merged into a takeaway';
  exception when raise_exception then
    if sqlerrm <> 'Merge the takeaway bill into the table''s bill, not the other way round' then raise; end if;
  end;
  -- merge V2's bill (pax 2) into V3's bill (pax 2): V3 gets every order and item, pax 4, V2 is free
  select count(*) into n from order_items where bill_id in (v_bill2.id, v_bill3.id);
  perform merge_bills(v_bill2.id, v_bill3.id);
  if (select count(*) from order_items where bill_id = v_bill3.id) <> n or exists (select 1 from orders where bill_id = v_bill2.id) then
    raise exception 'FAIL merge: items';
  end if;
  select * into v_bill2 from bills where id = v_bill2.id;
  if v_bill2.status <> 'merged' or v_bill2.merged_into <> v_bill3.id or (select pax from bills where id = v_bill3.id) <> 4 then
    raise exception 'FAIL merge: bills';
  end if;
  v_order := place_counter_order(v_t3.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  if (select bill_id from orders where id = v_order) <> v_bill3.id then raise exception 'FAIL: order after merge'; end if;
  begin perform merge_bills(v_bill2.id, v_bill3.id); raise exception 'FAIL: merged a merged bill';
  exception when raise_exception then if sqlerrm <> 'Only open bills can be merged' then raise; end if; end;

  -- ── K. refunds ────────────────────────────────────────────────────────────
  select * into v_bill from bills where checkout_id = v_checkout;                                -- the paid #87846-like bill
  begin perform refund_bill(gen_random_uuid(), v_bill3.id, 100, v_cash, 'x', v_sup, '1234'); raise exception 'FAIL: refund on open bill';
  exception when raise_exception then if sqlerrm <> 'Only a paid bill can be refunded' then raise; end if; end;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 9281, v_cash, 'x', v_sup, '1234'); raise exception 'FAIL: refund above total';
  exception when raise_exception then if sqlerrm <> 'Refund is more than what is left on this bill (RM 92.80)' then raise; end if; end;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 1300, v_cash, '', v_sup, '1234'); raise exception 'FAIL: refund without reason';
  exception when raise_exception then if sqlerrm <> 'Choose a reason' then raise; end if; end;
  v_res := refund_bill(v_refund, v_bill.id, 1300, v_cash, 'Item not served', v_sup, '0000');
  if (v_res->>'ok')::boolean or exists (select 1 from refunds where id = v_refund) then raise exception 'FAIL: refund with wrong PIN'; end if;
  v_res := refund_bill(v_refund, v_bill.id, 1300, v_cash, 'Item not served', v_sup, '1234');
  if not (v_res->>'ok')::boolean or (v_res->>'refundedSen')::int <> 1300 or not (v_res->>'slipQueued')::boolean then
    raise exception 'FAIL refund: %', v_res;
  end if;
  if not exists (select 1 from refunds where id = v_refund and amount_sen = 1300 and method_name = 'V Cash'
                   and approved_by = v_sup and created_by = v_staff and reason = 'Item not served') then
    raise exception 'FAIL refund row';
  end if;
  if not exists (select 1 from print_jobs where branch_id = v_branch and kind = 'receipt' and payload->>'kind' = 'refund'
                   and payload->>'billNo' = v_bill.bill_no and (payload->>'amountSen')::int = 1300
                   and payload->>'approvedBy' = 'Verify Supervisor') then
    raise exception 'FAIL refund slip';
  end if;
  if (v_res->>'amountSen')::int is distinct from 1300 then raise exception 'FAIL refund reply has no amountSen: %', v_res; end if;
  if refund_bill(v_refund, v_bill.id, 1300, v_cash, 'Item not served', v_sup, '1234') <> v_res
     or (select refunded_sen from bills where id = v_bill.id) <> 1300
     or (select count(*) from refunds where bill_id = v_bill.id) <> 1 then
    raise exception 'FAIL refund replay: the reply must equal the first one';
  end if;
  -- a resend after a lost reply with another amount or method is refused with what was recorded (fixes I2)
  v_res2 := refund_bill(v_refund, v_bill.id, 2300, v_cash, 'Item not served', v_sup, '1234');
  if (v_res2->>'ok')::boolean
     or v_res2->>'error' is distinct from 'This refund was already recorded as RM 13.00 by V Cash — close and reopen to refund more' then
    raise exception 'FAIL refund replay with another amount: %', v_res2;
  end if;
  v_res2 := refund_bill(v_refund, v_bill.id, 1300, v_tng, 'Item not served', v_sup, '1234');
  if (v_res2->>'ok')::boolean
     or v_res2->>'error' is distinct from 'This refund was already recorded as RM 13.00 by V Cash — close and reopen to refund more' then
    raise exception 'FAIL refund replay with another method: %', v_res2;
  end if;
  if (select refunded_sen from bills where id = v_bill.id) <> 1300
     or (select count(*) from refunds where bill_id = v_bill.id) <> 1
     or (select count(*) from print_jobs where branch_id = v_branch and payload->>'kind' = 'refund'
                                           and payload->>'billNo' = v_bill.bill_no) <> 1 then
    raise exception 'FAIL refund replay with other values wrote something';
  end if;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 8000, v_cash, 'x', v_sup, '1234'); raise exception 'FAIL: refund cap';
  exception when raise_exception then if sqlerrm <> 'Refund is more than what is left on this bill (RM 79.80)' then raise; end if; end;

  -- ── K2. refunds go back the original route (owner decision 2026-10-24) ────
  -- the bill was paid V TnG 50.00 + V Cash 42.80 (tendered 50.00, change 7.20); V Cash 13.00 is refunded
  -- already. Cash counts what it paid (42.80), not what was tendered.
  select string_agg(m.method_name || ':' || m.kind || ':' || m.paid_sen || ':' || m.refunded_sen || ':' || m.left_sen, ',' order by m.n)
    into v_left
    from pos_refundable_methods(v_bill.id) with ordinality as m(method_id, method_name, kind, paid_sen, refunded_sen, left_sen, n);
  if v_left is distinct from 'V TnG:ewallet:5000:0:5000,V Cash:cash:4280:1300:2980' then
    raise exception 'FAIL refundable methods after a refund: %', v_left;
  end if;
  -- a method the bill was not paid with is refused, even one active at this branch (and one of another branch)
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 500, v_card, 'Item not served', v_sup, '1234');
    raise exception 'FAIL: refund by a method the bill was not paid with';
  exception when raise_exception then
    if sqlerrm <> 'Refunds go back the way the bill was paid — choose one of its payment methods' then raise; end if;
  end;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 500, v_far_cash, 'Item not served', v_sup, '1234');
    raise exception 'FAIL: refund by another branch''s method';
  exception when raise_exception then
    if sqlerrm <> 'Refunds go back the way the bill was paid — choose one of its payment methods' then raise; end if;
  end;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 500, null, 'Item not served', v_sup, '1234');
    raise exception 'FAIL: refund with no method';
  exception when raise_exception then
    if sqlerrm <> 'Refunds go back the way the bill was paid — choose one of its payment methods' then raise; end if;
  end;
  -- above what that method has left is refused, though the bill as a whole still has 79.80 left
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 2981, v_cash, 'Item not served', v_sup, '1234');
    raise exception 'FAIL: cash refund above what cash paid less what it gave back';
  exception when raise_exception then
    if sqlerrm <> 'Refund is more than was paid by V Cash on this bill (RM 29.80 left)' then raise; end if;
  end;
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 5001, v_tng, 'Item not served', v_sup, '1234');
    raise exception 'FAIL: e-wallet refund above what the e-wallet paid';
  exception when raise_exception then
    if sqlerrm <> 'Refund is more than was paid by V TnG on this bill (RM 50.00 left)' then raise; end if;
  end;
  if (select refunded_sen from bills where id = v_bill.id) <> 1300 or (select count(*) from refunds where bill_id = v_bill.id) <> 1 then
    raise exception 'FAIL: a refused route refund wrote something';
  end if;
  -- the successes paired with those refusals, called as a signed-in client (a missing grant fails here):
  -- a split refund, TnG 20.00 and the last 29.80 of cash; a method switched off since still takes its money back
  update payment_methods set is_active = false where id = v_tng;
  set local role authenticated;
  v_res := refund_bill(v_refund2, v_bill.id, 2000, v_tng, 'Item not served', v_sup, '1234');
  if not (v_res->>'ok')::boolean or (v_res->>'amountSen')::int <> 2000 or (v_res->>'refundedSen')::int <> 3300 then
    raise exception 'FAIL route refund by TnG: %', v_res;
  end if;
  v_res := refund_bill(v_refund3, v_bill.id, 2980, v_cash, 'Item not served', v_sup, '1234');
  if not (v_res->>'ok')::boolean or (v_res->>'amountSen')::int <> 2980 or (v_res->>'refundedSen')::int <> 6280 then
    raise exception 'FAIL route refund of the cash left: %', v_res;
  end if;
  select string_agg(m.method_name || ':' || m.kind || ':' || m.paid_sen || ':' || m.refunded_sen || ':' || m.left_sen, ',' order by m.n)
    into v_left
    from pos_refundable_methods(v_bill.id) with ordinality as m(method_id, method_name, kind, paid_sen, refunded_sen, left_sen, n);
  reset role;
  update payment_methods set is_active = true where id = v_tng;
  if v_left is distinct from 'V TnG:ewallet:5000:2000:3000,V Cash:cash:4280:4280:0' then
    raise exception 'FAIL refundable methods after a split refund: %', v_left;
  end if;
  if (select string_agg(method_name || ':' || amount_sen, ',' order by created_at, amount_sen) from refunds
       where id in (v_refund2, v_refund3)) is distinct from 'V TnG:2000,V Cash:2980' then
    raise exception 'FAIL route refund rows: the method name must be the payment''s';
  end if;
  -- cash has nothing left now, though the bill still has 30.00
  begin perform refund_bill(gen_random_uuid(), v_bill.id, 1, v_cash, 'Item not served', v_sup, '1234');
    raise exception 'FAIL: cash refunded twice over';
  exception when raise_exception then
    if sqlerrm <> 'Refund is more than was paid by V Cash on this bill (RM 0.00 left)' then raise; end if;
  end;
  -- another branch's bill: neither listed nor refunded; this branch's staff still see it
  perform set_config('request.jwt.claims', json_build_object('sub', v_far, 'role', 'authenticated')::text, true);
  begin perform * from pos_refundable_methods(v_bill.id); raise exception 'FAIL: another branch listed this bill''s methods';
  exception when raise_exception then if sqlerrm <> 'Bill not found' then raise; end if; end;
  begin perform refund_bill(v_refund4, v_bill.id, 100, v_tng, 'Item not served', v_far, '9999');
    raise exception 'FAIL: another branch refunded this bill';
  exception when raise_exception then if sqlerrm <> 'Bill not found' then raise; end if; end;
  if exists (select 1 from refunds where id = v_refund4) then raise exception 'FAIL: another branch wrote a refund'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from pos_refundable_methods(v_bill.id);
  reset role;
  if n <> 2 then raise exception 'FAIL: this branch cannot list its own bill''s methods (% rows)', n; end if;

  -- ── L. QR open-bill switch; a paid table shows nothing to the next party ──
  update branch_pos_settings set qr_requires_open_bill = true where branch_id = v_branch;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  begin perform place_table_order(v_t4.qr_token, 2, jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
    raise exception 'FAIL: QR ordered on a table nobody opened';
  exception when raise_exception then if sqlerrm <> 'Please ask our staff to open your table before ordering.' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_item := open_table(v_t4.id, 3);
  if open_table(v_t4.id, null) <> v_item then raise exception 'FAIL open_table not idempotent'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  v_order := place_table_order(v_t4.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_plate, 'variantId', v_plate_var)), gen_random_uuid());
  if (select bill_id from orders where id = v_order) <> v_item then raise exception 'FAIL: QR order missed the opened bill'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  perform checkout_bill(v_item, jsonb_build_array(jsonb_build_object('methodId', v_cash, 'amountSen', (pos_bill_totals(v_item)->>'totalSen')::int)), gen_random_uuid());
  if qr_table_state(v_t4.qr_token)->>'billNo' is not null or jsonb_array_length(qr_table_state(v_t4.qr_token)->'items') <> 0 then
    raise exception 'FAIL: the next party sees a paid bill';
  end if;
  update branch_pos_settings set qr_requires_open_bill = false where branch_id = v_branch;

  -- ── M. receipt settings: managers only, route must have a printer ─────────
  begin perform save_receipt_settings('{"receiptTitle": "Nope"}'::jsonb); raise exception 'FAIL: cashier saved settings';
  exception when raise_exception then if sqlerrm <> 'Only a manager can change the receipt settings' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  begin perform clear_pos_pin(v_far); raise exception 'FAIL: cleared a PIN of another branch';
  exception when raise_exception then if sqlerrm <> 'This person is not staff of your branch' then raise; end if; end;
  begin perform save_receipt_settings('{"receiptTitle": "Verify Cafe", "receiptRoute": "Nowhere"}'::jsonb); raise exception 'FAIL: unknown route';
  exception when raise_exception then if sqlerrm <> 'No printer is set for route Nowhere' then raise; end if; end;
  perform save_receipt_settings('{"receiptTitle": " Verify Cafe 2 ", "legalName": "", "phone": "03-1234", "footer": "Thanks!",
                                  "receiptRoute": "Bar", "sstRegistered": false, "cashRounding": "none", "qrRequiresOpenBill": true}'::jsonb);
  -- legalName "" clears it; address is absent from the payload, so it stays as it was
  if (select receipt_title || '|' || coalesce(legal_name, 'null') || '|' || phone || '|' || address from branches where id = v_branch)
       <> 'Verify Cafe 2|null|03-1234|verify street'
     or not exists (select 1 from branch_pos_settings where branch_id = v_branch and not sst_registered and cash_rounding = 'none'
                      and receipt_footer = 'Thanks!' and qr_requires_open_bill) then
    raise exception 'FAIL save_receipt_settings';
  end if;

  -- ── N. settings tables: own branch only, live managers only (fixes I1) ─────
  -- RLS is the only gate on service_charge_rules, payment_methods and reason_templates.
  -- The DO block's role bypasses RLS, so the writes below run as `authenticated`;
  -- each refused write has a positive control showing the same write is allowed
  -- where it should be (so a missing grant cannot pass for a policy).
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set system_role = 'manager' where id in (v_sup, v_far);     -- a manager here, and a manager of VERIFY2
  -- N1. a manager of another branch cannot touch this branch's settings
  perform set_config('request.jwt.claims', json_build_object('sub', v_far, 'role', 'authenticated')::text, true);
  if pos_caller_branch() is distinct from v_branch2 or not has_menu_cap('access_settings') then
    raise exception 'FAIL fixture: VERIFY2''s manager is not a live manager of VERIFY2';
  end if;
  set local role authenticated;
  begin
    insert into payment_methods(branch_id, name, kind) values (v_branch, 'Far Sneak', 'cash');
    raise exception 'FAIL rls: a manager of another branch added a payment method here';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  begin
    insert into service_charge_rules(branch_id, rate_bp, order_types) values (v_branch, 10000, array['dine_in']);
    raise exception 'FAIL rls: a manager of another branch added a service charge here';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  begin
    insert into reason_templates(branch_id, action, reasons) values (v_branch, 'refund', array['Far reason']);
    raise exception 'FAIL rls: a manager of another branch added reasons here';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  update payment_methods set is_active = false where branch_id = v_branch;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL rls: a manager of another branch switched off % payment methods here', n; end if;
  update service_charge_rules set rate_bp = 10000 where branch_id = v_branch;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL rls: a manager of another branch changed % service charges here', n; end if;
  update reason_templates set compulsory = false where branch_id = v_branch;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL rls: a manager of another branch changed % reason lists here', n; end if;
  delete from payment_methods where branch_id = v_branch;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL rls: a manager of another branch deleted % payment methods here', n; end if;
  -- positive control: the same person still manages their own branch
  insert into payment_methods(branch_id, name, kind) values (v_branch2, 'X Card', 'card');
  update payment_methods set sort_order = 9 where id = v_far_cash;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL rls: a manager could not edit their own branch''s payment methods'; end if;
  reset role;
  -- N2. a live manager of this branch can; once resigned, nothing
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update payment_methods set sort_order = sort_order where id = v_cash;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL rls: a live manager could not edit their own branch''s payment methods'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set status = 'resigned' where id = v_sup;                  -- is_active stays true, as in real life
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  if has_menu_cap('access_settings') or has_menu_cap('pos_supervise') then raise exception 'FAIL cap: a resigned manager holds has_menu_cap'; end if;
  if staff_has_cap(v_sup, 'access_settings') or staff_has_cap(v_sup, 'pos_supervise') then
    raise exception 'FAIL cap: a resigned manager holds staff_has_cap';
  end if;
  if pos_caller_branch() is not null then raise exception 'FAIL: pos_caller_branch answers for a resigned person'; end if;
  set local role authenticated;
  update payment_methods set is_active = false where id = v_cash;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL rls: a resigned manager switched off a payment method'; end if;
  begin
    insert into service_charge_rules(branch_id, rate_bp, order_types) values (v_branch, 10000, array['dine_in']);
    raise exception 'FAIL rls: a resigned manager added a service charge';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  reset role;
  -- N3. is_active = false ends it too
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set status = 'active', is_active = false where id = v_sup;
  perform set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
  if has_menu_cap('access_settings') or staff_has_cap(v_sup, 'access_settings') or staff_has_cap(v_sup, 'pos_supervise')
     or pos_caller_branch() is not null then
    raise exception 'FAIL cap: an inactive manager still holds a capability';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set is_active = true where id = v_sup;
  if not staff_has_cap(v_sup, 'access_settings') then raise exception 'FAIL cap: a reactivated manager lost access_settings'; end if;
  if (select is_active from payment_methods where id = v_cash) is not true
     or (select rate_bp from service_charge_rules where branch_id = v_branch) <> 1000 then
    raise exception 'FAIL rls: a refused write changed the settings';
  end if;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
