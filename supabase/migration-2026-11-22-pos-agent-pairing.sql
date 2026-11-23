-- ============================================================================
-- Craft OS — POS print agent pairing, D (2026-11-22). Run on craft-os-dev after
-- migration-2026-10-30-pos-app.sql (any time after; before migration-2026-11-22-pos-switchover.sql).
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-22-pos-agent-pairing-switchover.md
-- Design: docs/superpowers/specs/2026-11-22-pos-agent-pairing-switchover-design.md (§2)
--
-- D1  The print agent pairs like a tablet (Edge Function pos-device-activation, platform 'agent',
--     approved in Craft OS → Devices as kind Print agent) and then needs its outlet. pos_devices is
--     closed to every client (migration-2026-10-29-pos-devices.sql D1) and pos_whoami() is for POS
--     tablets with a session, so pos_agent_whoami() tells an active print-agent device its outlet and
--     name, and stamps last_seen_at (the agent calls it at start and every minute). Anything else —
--     a POS tablet, a revoked device, a staff login, no login — gets device_unpaired.
--     Printing itself needs nothing new: pos_print_branch() already lets a print agent claim,
--     finish and requeue its outlet's jobs, and the pos_read policies let it read its outlet's
--     print_routes and print_jobs (Realtime included).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_whoami()') is null or to_regprocedure('pos_print_branch()') is null then
    raise exception 'STOP: run migration-2026-10-30-pos-app.sql first (pos_whoami is missing)';
  end if;
end $$;

-- ── D1. The print agent's own device and outlet ──────────────────────────────
create or replace function pos_agent_whoami() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found or v_dev.kind <> 'print_agent' or v_dev.revoked_at is not null then
    raise exception 'device_unpaired';
  end if;
  -- as in pos_ctx: stamped at most every 30 s, skipped in a read-only transaction
  if not current_setting('transaction_read_only')::boolean then
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  end if;
  return jsonb_build_object(
    'deviceId', v_dev.id, 'deviceName', v_dev.name,
    'outletId', v_dev.branch_id, 'outletName', (select b.name from branches b where b.id = v_dev.branch_id));
end $$;
revoke all on function pos_agent_whoami() from public, anon;
grant execute on function pos_agent_whoami() to authenticated;

notify pgrst, 'reload schema';
select 'pos agent pairing applied' as result;
