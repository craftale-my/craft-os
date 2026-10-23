-- Verify migration-2026-10-23-staff-private.sql as different personas.
-- Read-only in effect: the write probe runs inside a sub-block that is
-- always rolled back. Run as postgres (SQL Editor or Management API).
--
-- Expected:
--   persona     private_rows  notes_rows  others_private_update
--   trainee     1             0           0
--   supervisor  1             0           0
--   hr          total_staff   all notes   total_staff - 1
--   owner       total_staff   all notes   total_staff - 1
-- A persona with no matching staff row shows "(no such staff)" — fine.

create temp table if not exists _sp_verify (
  persona text, private_rows int, notes_rows int, others_private_update int
);
truncate _sp_verify;

do $$
declare
  p      record;
  v_priv int;
  v_notes int;
  v_upd  int;
begin
  for p in
    select 'trainee' as persona,
           (select id from staff where rank = 'trainee' and coalesce(system_role, 'staff') = 'staff'
              and status = 'active' limit 1) as uid
    union all
    select 'supervisor', (select id from staff where system_role = 'supervisor' and rank <> 'manager' limit 1)
    union all
    select 'hr', (select id from staff where system_role = 'hr' and rank <> 'manager' limit 1)
    union all
    select 'owner', (select id from staff where system_role = 'owner' limit 1)
  loop
    if p.uid is null then
      insert into _sp_verify values (p.persona || ' (no such staff)', null, null, null);
      continue;
    end if;

    perform set_config('request.jwt.claims',
      json_build_object('sub', p.uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    select count(*) into v_priv  from staff_private;
    select count(*) into v_notes from staff_manager_notes;

    -- Write probe on OTHER people's rows, always rolled back.
    begin
      update staff_private set updated_at = updated_at where staff_id <> p.uid;
      get diagnostics v_upd = row_count;
      raise exception using errcode = 'P0001', message = 'rollback-probe';
    exception when sqlstate 'P0001' then
      null;
    end;

    execute 'reset role';
    insert into _sp_verify values (p.persona, v_priv, v_notes, v_upd);
  end loop;
end $$;

select v.*, (select count(*) from staff) as total_staff,
       (select count(*) from staff_manager_notes) as total_notes
from _sp_verify v;
