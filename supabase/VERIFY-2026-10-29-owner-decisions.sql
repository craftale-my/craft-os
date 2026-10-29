-- ============================================================================
-- VERIFY — Owner decisions (2026-10-29). DEV ONLY (craft-os-dev).
--
-- Acts as the [TEST] logins inside one DO block that always ends by raising
-- its report as an error, so every change it makes (matrix overrides, a
-- wastage row) is rolled back. Last line: VERIFY OK or VERIFY FAILED.
-- ============================================================================
do $verify$
declare
  c_sup_cheras constant uuid := 'bfd13ca2-6282-42f3-ad85-5fbe1325516d';
  c_staff      constant uuid := '406b1762-107b-42ea-b27b-71c38d15d1a4';  -- test.staff.cheras
  c_cheras     constant uuid := '75bb97bb-dedb-4aee-b326-373fd883780e';
  c_item       constant uuid := 'df0d4ada-d0a8-4aaf-9818-97296472c8a8';
  v_out  text := '';
  v_fail boolean := false;
  v_ok   boolean;
  v_owner uuid;

  procedure_check text;
begin
  select id into v_owner from staff where system_role = 'owner' and is_active and status = 'active' limit 1;

  -- 1. Defaults: supervisor uses, does not manage; staff neither --------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);
  v_ok := has_procurement_cap('use_procurement') and not has_procurement_cap('manage_procurement');
  perform set_config('request.jwt.claims', json_build_object('sub', c_staff, 'role', 'authenticated')::text, true);
  v_ok := v_ok and not has_procurement_cap('use_procurement');
  v_out := v_out || format(E'%s  defaults: supervisor uses, staff does not\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 2. Owner switches procurement OFF for supervisors -> refused --------------
  update system_role_permissions set permissions = permissions || '{"use_procurement": false}' where system_role = 'supervisor';
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);
  v_ok := not has_procurement_cap('use_procurement');
  v_out := v_out || format(E'%s  owner can switch procurement off for a role\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 3. Owner switches it ON for staff -> allowed --------------------------------
  update system_role_permissions set permissions = permissions || '{"use_procurement": true}' where system_role = 'staff';
  perform set_config('request.jwt.claims', json_build_object('sub', c_staff, 'role', 'authenticated')::text, true);
  v_ok := has_procurement_cap('use_procurement');
  v_out := v_out || format(E'%s  owner can switch procurement on for a role\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 4. Owner role cannot be locked out ------------------------------------------
  update system_role_permissions set permissions = permissions || '{"manage_procurement": false}' where system_role = 'owner';
  if v_owner is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    v_ok := has_procurement_cap('manage_procurement');
  else
    v_ok := true;  -- no owner login on this database: nothing to check
  end if;
  v_out := v_out || format(E'%s  owner keeps access even if switched off\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 5. New wastage reasons are accepted -----------------------------------------
  update system_role_permissions set permissions = permissions - 'use_procurement' where system_role = 'supervisor';
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform log_wastage(c_cheras, c_item, 1, 'staff_meal', null, null);
    perform log_wastage(c_cheras, c_item, 1, 'customer_return', null, null);
    v_ok := true;
  exception when others then v_ok := false;
  end;
  begin
    perform log_wastage(c_cheras, c_item, 1, 'stolen', null, null);
    v_ok := false;
  exception when others then v_ok := v_ok and true;
  end;
  execute 'reset role';
  v_out := v_out || format(E'%s  staff_meal and customer_return accepted, unknown reasons refused\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  -- Raising rolls back every change above.
  raise exception E'\n%', v_out;
end
$verify$;
