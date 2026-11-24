-- ============================================================================
-- Craft OS — POS app (2026-10-30): Sub-plan C2 of devices, PIN login and outlets.
-- Run on craft-os-dev after migration-2026-10-29-pos-device-till.sql. Idempotent.
-- Plan: docs/superpowers/plans/2026-10-30-pos-app.md
-- Design: docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md (§2, §3)
--
-- A1  pos_whoami(): what the POS app needs after a sign-in — the device (name, whether it is
--     the printing tablet), the outlet, the session's staff member, and what that person may
--     do on the tablet: see shift reports (pos_supervise) and unpair it (access_settings with
--     the outlet in their scope, as pos_unpair_this_device checks). It goes through pos_ctx(),
--     so it raises the same coded errors; a staff login gets device_unpaired.
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_unpair_this_device()') is null then
    raise exception 'STOP: run migration-2026-10-29-pos-device-till.sql first (pos_unpair_this_device is missing)';
  end if;
end $$;

create or replace function pos_whoami() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx record;
  v_dev pos_devices;
begin
  select * into v_ctx from pos_ctx();
  if v_ctx.device_id is null then raise exception 'device_unpaired'; end if;      -- a staff login is no device
  select * into v_dev from pos_devices d where d.id = v_ctx.device_id;
  return jsonb_build_object(
    'deviceId', v_dev.id, 'deviceName', v_dev.name, 'prints', v_dev.prints,
    'outletId', v_ctx.branch_id, 'outletName', (select b.name from branches b where b.id = v_ctx.branch_id),
    'staffId', v_ctx.staff_id, 'staffName', (select s.name from staff s where s.id = v_ctx.staff_id),
    'canSupervise', staff_has_cap(v_ctx.staff_id, 'pos_supervise'),
    'canUnpair', staff_has_cap(v_ctx.staff_id, 'access_settings')
                 and v_ctx.branch_id in (select staff_outlet_scope(v_ctx.staff_id)));
end $$;
revoke all on function pos_whoami() from public, anon;
grant execute on function pos_whoami() to authenticated;

notify pgrst, 'reload schema';
select 'pos app applied' as result;
