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
--   g_insert_sysrole    INSERT a staff row with system_role admin
--                                                       owner: allowed / passed   else denied
--   g_demote_high       set another supervisor/manager row's rank to senior
--                                                       manager-tier: allowed   else denied / rls-0-rows
--   Legacy sync trigger (staff_private_sync_legacy, phase 1; `n/a` once the
--   old staff columns are gone). Each writes a unique probe value to an old
--   staff column, then reads the new table AS POSTGRES inside the probe:
--   s_own_phone         own staff.contact_number        copied for everyone (self may write)
--   s_other_phone       another person's staff.contact_number
--                                                       reader: copied   else unchanged / rls-0-rows
--   s_other_notes       another person's staff.manager_notes
--                                                       reader: copied   else unchanged / rls-0-rows
--                       (supervisor: staff_update lets the old-column write
--                       through, so `unchanged` proves the trigger refused it)
-- Outcome words: allowed = the write landed; denied = raised 42501 (RLS or
-- the guard); rls-0-rows = RLS hid the target row (UPDATE matched 0 rows);
-- passed-rls / passed = got past RLS and the guard, then failed the FK or a
-- NOT NULL constraint (the probe uses a uuid with no auth.users / staff row);
-- copied / unchanged = the sync trigger did / did not write the probe value;
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
  g_insert_mgr text, g_self_rank text, g_insert_sysrole text, g_demote_high text,
  s_own_phone text, s_other_phone text, s_other_notes text,
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
  v_g_isys     text;
  v_g_demote   text;
  v_s_own      text;
  v_s_phone    text;
  v_s_notes    text;
  v_high       uuid;
  v_legacy     boolean;
  v_probe      text;
  v_read       text;
  v_pass       boolean;
begin
  select count(*) into v_total from staff;
  select count(*) = 5 into v_legacy
  from information_schema.columns
  where table_schema = 'public' and table_name = 'staff'
    and column_name in ('ic_number','date_of_birth','contact_number','address','manager_notes');

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
    select id into v_high   from staff where rank in ('supervisor','manager') and id <> p.uid order by id limit 1;
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
      when foreign_key_violation or not_null_violation then v_g_ins := 'passed';
      when others then v_g_ins := 'error:' || sqlstate;
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

    -- ── Authority guard: insert a staff row with system_role admin ─────────
    v_g_isys := null;
    begin
      insert into staff (id, name, rank, system_role)
      values (gen_random_uuid(), '[VERIFY probe]', 'trainee', 'admin');
      v_g_isys := 'allowed';
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'rollback-probe' then v_g_isys := 'error:' || sqlerrm; end if;
      when insufficient_privilege then v_g_isys := 'denied';
      when foreign_key_violation or not_null_violation then v_g_isys := 'passed';
      when others then v_g_isys := 'error:' || sqlstate;
    end;

    -- ── Authority guard: demote another supervisor/manager ─────────────────
    if v_high is null then
      v_g_demote := 'no-target';
    else
      v_g_demote := null;
      begin
        update staff set rank = 'senior' where id = v_high;
        get diagnostics v_rows = row_count;
        v_g_demote := case when v_rows = 0 then 'rls-0-rows' else 'allowed' end;
        raise exception using errcode = 'P0001', message = 'rollback-probe';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'rollback-probe' then v_g_demote := 'error:' || sqlerrm; end if;
        when insufficient_privilege then v_g_demote := 'denied';
        when others then v_g_demote := 'error:' || sqlstate;
      end;
    end if;

    -- ── Legacy sync trigger (only while the old columns exist) ─────────────
    -- Dynamic SQL: the old columns may not exist. The read happens after
    -- `reset role` inside the probe, so it sees the row as postgres; the
    -- probe's rollback restores the role, and it is set again after each one.
    if not v_legacy then
      v_s_own := 'n/a'; v_s_phone := 'n/a'; v_s_notes := 'n/a';
    else
      v_s_own := null;
      v_probe := '[VERIFY ' || gen_random_uuid()::text || ']';
      begin
        execute 'update staff set contact_number = $1 where id = $2' using v_probe, p.uid;
        get diagnostics v_rows = row_count;
        execute 'reset role';
        select contact_number into v_read from staff_private where staff_id = p.uid;
        v_s_own := case when v_rows = 0 then 'rls-0-rows'
                        when v_read is not distinct from v_probe then 'copied'
                        else 'unchanged' end;
        raise exception using errcode = 'P0001', message = 'rollback-probe';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'rollback-probe' then v_s_own := 'error:' || sqlerrm; end if;
        when others then v_s_own := 'error:' || sqlstate;
      end;
      execute 'set local role authenticated';

      v_s_phone := null;
      v_probe := '[VERIFY ' || gen_random_uuid()::text || ']';
      begin
        execute 'update staff set contact_number = $1 where id = $2' using v_probe, v_other;
        get diagnostics v_rows = row_count;
        execute 'reset role';
        select contact_number into v_read from staff_private where staff_id = v_other;
        v_s_phone := case when v_rows = 0 then 'rls-0-rows'
                          when v_read is not distinct from v_probe then 'copied'
                          else 'unchanged' end;
        raise exception using errcode = 'P0001', message = 'rollback-probe';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'rollback-probe' then v_s_phone := 'error:' || sqlerrm; end if;
        when insufficient_privilege then v_s_phone := 'denied';
        when others then v_s_phone := 'error:' || sqlstate;
      end;
      execute 'set local role authenticated';

      v_s_notes := null;
      v_probe := '[VERIFY ' || gen_random_uuid()::text || ']';
      begin
        execute 'update staff set manager_notes = $1 where id = $2' using v_probe, v_other;
        get diagnostics v_rows = row_count;
        execute 'reset role';
        select notes into v_read from staff_manager_notes where staff_id = v_other;
        v_s_notes := case when v_rows = 0 then 'rls-0-rows'
                          when v_read is not distinct from v_probe then 'copied'
                          else 'unchanged' end;
        raise exception using errcode = 'P0001', message = 'rollback-probe';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'rollback-probe' then v_s_notes := 'error:' || sqlerrm; end if;
        when insufficient_privilege then v_s_notes := 'denied';
        when others then v_s_notes := 'error:' || sqlstate;
      end;
      execute 'set local role authenticated';
    end if;

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
               else v_g_self = 'denied' end
      and case when p.is_owner then v_g_isys in ('allowed','passed')
               else v_g_isys = 'denied' end
      and case when p.mgr_tier then v_g_demote = 'allowed'
               else v_g_demote in ('denied','rls-0-rows') end
      and case when not v_legacy then v_s_own = 'n/a' and v_s_phone = 'n/a' and v_s_notes = 'n/a'
               else v_s_own = 'copied'
                and case when p.reader then v_s_phone = 'copied'
                         else v_s_phone in ('unchanged','rls-0-rows') end
                and case when p.reader then v_s_notes = 'copied'
                         else v_s_notes in ('unchanged','rls-0-rows') end
          end;

    insert into _sp_verify values (
      p.ord, p.persona, 'ok', p.uid,
      v_priv,  case when p.reader then v_total else 1 end,
      v_notes, case when p.reader then v_exp_notes else 0 end,
      v_upd,   case when p.reader then v_total - 1 else 0 end,
      v_ins, v_nw_other, v_notes_self, v_nw_self,
      v_g_sys, v_g_mgr, v_g_low, v_g_ins, v_g_self, v_g_isys, v_g_demote,
      v_s_own, v_s_phone, v_s_notes,
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
