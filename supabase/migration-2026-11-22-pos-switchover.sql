-- ============================================================================
-- Craft OS — POS switch-over, C3 (2026-11-22). Run on craft-os-dev LAST in the POS chain: after
-- migration-2026-11-22-pos-feedme-habits.sql and migration-2026-11-22-pos-agent-pairing.sql. Rollout order:
-- D SQL -> pair every print agent (and give every outlet's browser-printed routes a POS-app tablet set to
-- print) -> deploy the new Craft OS build with the /pos notice -> this file, last. Pre-check (every row must be
-- covered = true): select r.branch_id, r.name, r.kind, case when r.kind = 'agent' then exists(select 1 from
-- pos_devices d where d.branch_id = r.branch_id and d.kind = 'print_agent' and d.revoked_at is null) else
-- exists(select 1 from pos_devices d where d.branch_id = r.branch_id and d.kind = 'pos' and d.prints and
-- d.revoked_at is null) end as covered from print_routes r order by 1, 2;
-- The server cannot tell whether a staff-login agent still runs somewhere, and from here such an agent stops
-- printing.
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-22-pos-agent-pairing-switchover.md
-- Design: docs/superpowers/specs/2026-11-22-pos-agent-pairing-switchover-design.md (§3);
--         docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md §4 ("Staff email logins can no
--         longer call front-of-house RPCs")
--
-- X1  pos_ctx(): the C1 transition is gone. A caller with no pos_devices row — a staff email login, or no
--     login at all — gets device_unpaired, so every front-of-house RPC (all of them reach pos_ctx through
--     pos_my_branch() or pos_actor(), or call it) refuses it. A device is checked exactly as before.
-- X2  pos_print_branch(): a staff login no longer prints for its home branch (device_unpaired). The print
--     agent pairs as a device (D); the printing tablet prints as before. insert_test_print with an outlet
--     (POS Settings → Test print) keeps its back-office path (pos_manages_outlet).
-- X3  pos_session_branch(): null for a staff login, so the till's direct writes (sold out, pause QR) need a
--     device session or an outlet the caller manages (pos_manages_outlet), as the policies already allow.
-- The back office is unchanged: settings, menu editor, reports, Devices, outlets, staff outlets, PIN set /
-- clear and reads (pos_readable_branches = staff_outlet_scope) never used these three functions' staff paths.
-- Verify scripts: those that run the till as a staff login pass only before this file — the pre-device ones
-- (menu, ordering, catalogs, checkout, menu-editor, shifts, slots-photos, hardening, frontend, outlets),
-- menu-picks, device-till's "C1 transition" block and qr-table-cart L2 / L3. They stay as they are: each runs
-- right after its own file in the chain. After this file run migration-2026-11-22-pos-switchover-verify.sql and
-- the device-fixture verifies.
-- Re-run hazard: re-running migration-2026-10-29-pos-device-till.sql (or the older devices file) puts the
-- transition back — re-run this file after it.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_agent_whoami()') is null then
    raise exception 'STOP: run migration-2026-11-22-pos-agent-pairing.sql first, and pair every print agent before this file (pos_agent_whoami is missing)';
  end if;
  if to_regprocedure('set_items_served(uuid[],boolean)') is null then
    raise exception 'STOP: run migration-2026-11-22-pos-feedme-habits.sql first (set_items_served is missing)';
  end if;
end $$;

-- ── X1. The device context: devices only ─────────────────────────────────────
create or replace function pos_ctx(out device_id uuid, out branch_id uuid, out staff_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev    pos_devices;
  v_ses    pos_staff_sessions;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found then raise exception 'device_unpaired'; end if;                -- X1: a staff login (or none) has no till
  if v_dev.kind <> 'pos' or v_dev.revoked_at is not null then raise exception 'device_unpaired'; end if;
  if not pos_outlet_open(v_dev.branch_id) then raise exception 'outlet_closed'; end if;
  select * into v_ses from pos_staff_sessions s where s.device_id = v_dev.id and s.ended_at is null;
  if not found then raise exception 'no_session'; end if;
  if not pos_staff_may_work(v_ses.staff_id, v_dev.branch_id) then raise exception 'access_changed'; end if;
  -- stamped at most every 30 s: every till call passes here. A read-only transaction (PostgREST
  -- runs STABLE RPCs read-only) skips the stamps instead of failing the call.
  if not current_setting('transaction_read_only')::boolean then
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
    update pos_staff_sessions set last_active_at = now()
     where id = v_ses.id and last_active_at < now() - interval '30 seconds';
  end if;
  device_id := v_dev.id;
  branch_id := v_dev.branch_id;
  staff_id := v_ses.staff_id;
end $$;
revoke all on function pos_ctx() from public, anon, authenticated;

-- ── X2. Printing: devices only ───────────────────────────────────────────────
-- A print agent, or the outlet's printing tablet (locked or not), prints for its outlet.
create or replace function pos_print_branch() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid();
  if not found then
    raise exception 'device_unpaired';            -- X2: a staff login no longer prints (the print agent pairs: D)
  end if;
  if v_dev.revoked_at is not null then raise exception 'device_unpaired'; end if;
  if not (v_dev.kind = 'print_agent' or (v_dev.kind = 'pos' and v_dev.prints)) then raise exception 'not_printing_tablet'; end if;
  if not current_setting('transaction_read_only')::boolean then              -- as in pos_ctx
    update pos_devices set last_seen_at = now()
     where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  end if;
  return v_dev.branch_id;
end $$;
revoke all on function pos_print_branch() from public, anon, authenticated;

-- ── X3. The till's direct writes: a device session only ──────────────────────
-- The outlet of a till write made directly on a table (sold out, pause QR): a POS device with an
-- open session of someone who may still work there, at an open outlet. Non-writing (used by RLS).
create or replace function pos_session_branch() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select case when exists (select 1 from pos_devices d where d.id = auth.uid())
              then (select d.branch_id from pos_devices d
                     where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null and pos_outlet_open(d.branch_id)
                       and exists (select 1 from pos_staff_sessions s
                                    where s.device_id = d.id and s.ended_at is null and pos_staff_may_work(s.staff_id, d.branch_id)))
              else null end                                                   -- X3: a staff login has no till session
$$;
revoke all on function pos_session_branch() from public, anon;
grant execute on function pos_session_branch() to authenticated;

notify pgrst, 'reload schema';
select 'pos switchover applied' as result;
