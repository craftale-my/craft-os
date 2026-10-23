-- VERIFY — go/no-go gate for:
--   migration-2026-10-23-staff-private.sql          (staff_private, staff_manager_notes, RLS)
--   migration-2026-10-23-staff-authority-guard.sql  (rank / system_role guard)
--
-- Run as postgres (SQL Editor or Management API) AFTER both migrations.
-- Read-only in effect: every write probe runs inside a sub-block that always
-- ends in an exception, so Postgres rolls it back. Nothing is left behind.
--
-- Result: one row per persona, a `pass` column per row, and `all_pass` on
-- every row. GO only if all_pass = true.
--
-- Personas (picked from live staff rows):
--   trainee       rank trainee, system_role staff          — missing = FAIL
--   supervisor    system_role supervisor, rank <> manager  — missing = FAIL
--   hr            system_role hr, rank <> manager          — missing = SKIPPED
--   rank-manager  rank manager, system_role staff/supervisor — missing = SKIPPED
--   admin         system_role admin                        — missing = SKIPPED
--   owner         system_role owner                        — missing = FAIL
-- "reader" = hr, rank-manager, admin, owner (can_read_staff_private()).
-- "manager-tier" = rank-manager, admin, owner.
--
-- Columns and what passes:
--   private_rows        staff_private rows visible      reader: total_staff   else 1 (own)
--   notes_rows          staff_manager_notes visible     reader: notes not about themselves   else 0
--   others_upd          staff_private rows of OTHER people an UPDATE touches
--                                                       reader: total_staff-1   else 0
--   ins_other_private   INSERT staff_private for a random uuid
--                                                       reader: passed-rls (stopped later by the FK)
--                                                       else denied
--   notes_write_other   upsert a note about another staff member
--                                                       reader: allowed   else denied
--   notes_self_rows     notes about themselves visible  0 for everyone
--   notes_write_self    upsert a note about themselves  denied for everyone
--   g_sysrole_other     set another (trainee) row's system_role to admin
--                                                       owner: allowed   else denied / rls-0-rows
--   g_rank_mgr_other    set another trainee's rank to manager
--                                                       manager-tier: allowed   else denied / rls-0-rows
--   g_rank_low_other    set another trainee's rank to junior
--                                                       trainee: denied / rls-0-rows   else allowed
--   g_insert_mgr        INSERT a staff row at rank manager
--                                                       manager-tier: allowed / passed (stopped later
--                                                       by the auth.users FK)   else denied
--   g_self_rank         change their own rank           manager-tier: allowed   else denied
-- Outcome words: allowed = the write landed; denied = raised 42501 (RLS or
-- the guard); rls-0-rows = RLS hid the target row (UPDATE matched 0 rows);
-- passed-rls / passed = got past RLS and the guard, then failed a later
-- constraint (the probe uses a uuid with no auth.users / staff row);
-- no-target = no other trainee row to probe against (counts as FAIL);
-- error:… = anything unexpected (FAIL).

drop table if exists _sp_verify;
create temp table _sp_verify (
  ord int, persona text, status text, uid uuid,
  private_rows int, exp_private_rows int,
  notes_rows int, exp_notes_rows int,
  others_upd int, exp_others_upd int,
  ins_other_private text, notes_write_other text,
  notes_self_rows int, notes_write_self text,
  g_sysrole_other text, g_rank_mgr_other text, g_rank_low_other text,
  g_insert_mgr text, g_self_rank text,
  pass boolean
);

do $$
declare
  p            record;
  v_total      int;
  v_other      uuid;
  v_target     uuid;
  v_exp_notes  int;
  v_rows       int;
  v_priv       int;
  v_notes      int;
  v_notes_self int;
  v_upd        int;
  v_ins        text;
  v_nw_other   text;
  v_nw_self    text;
  v_g_sys      text;
  v_g_mgr      text;
  v_g_low      text;
  v_g_ins      text;
  v_g_self     text;
  v_pass       boolean;
begin
  select count(*) into v_total from staff;

  for p in
    select * from (values
      (1, 'trainee',
          (select id from staff where rank = 'trainee' and system_role = 'staff'
             and status = 'active' order by id limit 1),
          true,  false, false, false),
      (2, 'supervisor',
          (select id from staff where system_role = 'supervisor' and rank <> 'manager'
             and status = 'active' order by id limit 1),
          true,  false, false, false),
      (3, 'hr',
          (select id from staff where system_role = 'hr' and rank <> 'manager'
             and status = 'active' order by id limit 1),
          false, true,  false, false),
      (4, 'rank-manager',
          (select id from staff where rank = 'manager' and system_role in ('staff','supervisor')
             and status = 'active' order by id limit 1),
          false, true,  true,  false),
      (5, 'admin',
          (select id from staff where system_role = 'admin'
             and status = 'active' order by id limit 1),
          false, true,  true,  false),
      (6, 'owner',
          (select id from staff where system_role = 'owner' order by id limit 1),
          true,  true,  true,  true)
    ) as t(ord, persona, uid, required, reader, mgr_tier, is_owner)
  loop
    if p.uid is null then
      insert into _sp_verify (ord, persona, status, pass)
      values (p.ord, p.persona,
              case when p.required then 'MISSING' else 'SKIPPED' end,
              not p.required);
      continue;
    end if;

    -- Targets and expectations, computed as postgres (no RLS).
    select id into v_other  from staff where id <> p.uid order by id limit 1;
    select id into v_target from staff where rank = 'trainee' and id <> p.uid order by id limit 1;
    select count(*) into v_exp_notes from staff_manager_notes where staff_id <> p.uid;

    perform set_config('request.jwt.claims',
      json_build_object('sub', p.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    -- ── Reads ──────────────────────────────────────────────────────────────
    select count(*) into v_priv       from staff_private;
    select count(*) into v_notes      from staff_manager_notes;
    select count(*) into v_notes_self from staff_manager_notes where staff_id = p.uid;

    -- ── staff_private: update other people's rows ──────────────────────────
    v_upd := null;
    begin
      update staff_private set updated_at = updated_at where staff_id <> p.uid;
      get diagnostics v_upd = row_count;
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'rollback-probe' then v_upd := -1; end if;
      when others then v_upd := -1;
    end;

    -- ── staff_private: insert for someone else (random uuid) ───────────────
    v_ins := null;
    begin
      insert into staff_private (staff_id) values (gen_random_uuid());
      v_ins := 'allowed';
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'rollback-probe' then v_ins := 'error:' || sqlerrm; end if;
      when insufficient_privilege then v_ins := 'denied';
      when foreign_key_violation  then v_ins := 'passed-rls';
      when others then v_ins := 'error:' || sqlstate;
    end;

    -- ── staff_manager_notes: write about another staff member ──────────────
    v_nw_other := null;
    begin
      insert into staff_manager_notes (staff_id, notes, updated_by)
      values (v_other, '[VERIFY probe]', p.uid)
      on conflict (staff_id) do update set notes = excluded.notes;
      v_nw_other := 'allowed';
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'rollback-probe' then v_nw_other := 'error:' || sqlerrm; end if;
      when insufficient_privilege then v_nw_other := 'denied';
      when others then v_nw_other := 'error:' || sqlstate;
    end;

    -- ── staff_manager_notes: write about themselves ────────────────────────
    v_nw_self := null;
    begin
      insert into staff_manager_notes (staff_id, notes, updated_by)
      values (p.uid, '[VERIFY probe]', p.uid)
      on conflict (staff_id) do update set notes = excluded.notes;
      v_nw_self := 'allowed';
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'rollback-probe' then v_nw_self := 'error:' || sqlerrm; end if;
      when insufficient_privilege then v_nw_self := 'denied';
      when others then v_nw_self := 'error:' || sqlstate;
    end;

    -- ── Authority guard: another trainee's system_role / rank ──────────────
    if v_target is null then
      v_g_sys := 'no-target'; v_g_mgr := 'no-target'; v_g_low := 'no-target';
    else
      v_g_sys := null;
      begin
        update staff set system_role = 'admin' where id = v_target;
        get diagnostics v_rows = row_count;
        v_g_sys := case when v_rows = 0 then 'rls-0-rows' else 'allowed' end;
        raise exception using errcode = 'P0001', message = 'rollback-probe';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'rollback-probe' then v_g_sys := 'error:' || sqlerrm; end if;
        when insufficient_privilege then v_g_sys := 'denied';
        when others then v_g_sys := 'error:' || sqlstate;
      end;

      v_g_mgr := null;
      begin
        update staff set rank = 'manager' where id = v_target;
        get diagnostics v_rows = row_count;
        v_g_mgr := case when v_rows = 0 then 'rls-0-rows' else 'allowed' end;
        raise exception using errcode = 'P0001', message = 'rollback-probe';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'rollback-probe' then v_g_mgr := 'error:' || sqlerrm; end if;
        when insufficient_privilege then v_g_mgr := 'denied';
        when others then v_g_mgr := 'error:' || sqlstate;
      end;

      v_g_low := null;
      begin
        update staff set rank = 'junior' where id = v_target;
        get diagnostics v_rows = row_count;
        v_g_low := case when v_rows = 0 then 'rls-0-rows' else 'allowed' end;
        raise exception using errcode = 'P0001', message = 'rollback-probe';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'rollback-probe' then v_g_low := 'error:' || sqlerrm; end if;
        when insufficient_privilege then v_g_low := 'denied';
        when others then v_g_low := 'error:' || sqlstate;
      end;
    end if;

    -- ── Authority guard: insert a staff row at rank manager ────────────────
    v_g_ins := null;
    begin
      insert into staff (id, name, rank) values (gen_random_uuid(), '[VERIFY probe]', 'manager');
      v_g_ins := 'allowed';
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'rollback-probe' then v_g_ins := 'error:' || sqlerrm; end if;
      when insufficient_privilege then v_g_ins := 'denied';
      when others then v_g_ins := 'passed';   -- e.g. 23503: no auth.users row
    end;

    -- ── Authority guard: own rank ──────────────────────────────────────────
    v_g_self := null;
    begin
      update staff set rank = case when rank = 'senior' then 'junior' else 'senior' end
      where id = p.uid;
      get diagnostics v_rows = row_count;
      v_g_self := case when v_rows = 0 then 'rls-0-rows' else 'allowed' end;
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'rollback-probe' then v_g_self := 'error:' || sqlerrm; end if;
      when insufficient_privilege then v_g_self := 'denied';
      when others then v_g_self := 'error:' || sqlstate;
    end;

    execute 'reset role';

    v_pass :=
          v_priv = case when p.reader then v_total else 1 end
      and v_notes = case when p.reader then v_exp_notes else 0 end
      and v_upd = case when p.reader then v_total - 1 else 0 end
      and v_ins = case when p.reader then 'passed-rls' else 'denied' end
      and v_nw_other = case when p.reader then 'allowed' else 'denied' end
      and v_notes_self = 0
      and v_nw_self = 'denied'
      and case when p.is_owner then v_g_sys = 'allowed'
               else v_g_sys in ('denied','rls-0-rows') end
      and case when p.mgr_tier then v_g_mgr = 'allowed'
               else v_g_mgr in ('denied','rls-0-rows') end
      and case when p.persona = 'trainee' then v_g_low in ('denied','rls-0-rows')
               else v_g_low = 'allowed' end
      and case when p.mgr_tier then v_g_ins in ('allowed','passed')
               else v_g_ins = 'denied' end
      and case when p.mgr_tier then v_g_self = 'allowed'
               else v_g_self = 'denied' end;

    insert into _sp_verify values (
      p.ord, p.persona, 'ok', p.uid,
      v_priv,  case when p.reader then v_total else 1 end,
      v_notes, case when p.reader then v_exp_notes else 0 end,
      v_upd,   case when p.reader then v_total - 1 else 0 end,
      v_ins, v_nw_other, v_notes_self, v_nw_self,
      v_g_sys, v_g_mgr, v_g_low, v_g_ins, v_g_self,
      coalesce(v_pass, false)
    );
  end loop;
end $$;

select v.*,
       bool_and(v.pass) over () as all_pass,
       (select count(*) from staff) as total_staff,
       (select count(*) from staff_manager_notes) as total_notes
from _sp_verify v
order by v.ord;

-- ── After phase 2 only (migration-2026-10-23-staff-private-drop-columns.sql) ─
-- Expect 0 rows; also expect no staff_private_sync_legacy_trg trigger.
--
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'staff'
--   and column_name in ('ic_number','address','date_of_birth','contact_number','manager_notes');
--
-- select tgname from pg_trigger
-- where tgrelid = 'public.staff'::regclass and tgname = 'staff_private_sync_legacy_trg';
