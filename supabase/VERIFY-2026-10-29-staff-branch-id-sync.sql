-- VERIFY — go/no-go gate for migration-2026-10-29-staff-branch-id-sync.sql
--   (branch_id_for_label lookup + staff_sync_branch_id_trg)
--
-- Run as postgres (SQL Editor or Management API) AFTER the migration.
-- Read-only in effect: every write probe runs inside a sub-block that always
-- ends in an exception, so Postgres rolls back the throwaway auth user and
-- staff row it created. Nothing is left behind.
--
-- Result: one row per check with `got`, `expected`, `pass`, and `all_pass` on
-- every row. GO only if all_pass = true.
--
-- Checks:
--   lookup:*    branch_id_for_label() on each live label form
--   insert:*    INSERT with branch_id null fills it; explicit branch_id wins
--   update:*    label change re-resolves; "Other" clears; explicit wins;
--               clearing branch_id on a resolvable label refills it
--   drift:*     no staff row whose label resolves has a null or different
--               branch_id (after the migration's own backfill)

create or replace function pg_temp.bname(p_id uuid) returns text
language sql stable as $$
  select coalesce((select name from branches where id = p_id), 'null')
$$;

-- Runs p_insert (+ p_update) against a throwaway staff row and returns the branch
-- name its branch_id ends up on. Both are SQL with %1$L = the new id.
create or replace function pg_temp.probe(p_insert text, p_update text default null)
returns text language plpgsql as $$
declare
  v_id  uuid := gen_random_uuid();
  v_out text;
begin
  begin
    insert into auth.users (id, email, aud, role)
      values (v_id, 'verify-' || v_id || '@example.invalid', 'authenticated', 'authenticated');
    execute format(p_insert, v_id);
    if p_update is not null then
      execute format(p_update, v_id);
    end if;
    select pg_temp.bname(branch_id) into v_out from staff where id = v_id;
    raise exception using errcode = 'P0001', message = 'rollback-probe';
  exception when others then
    if sqlerrm <> 'rollback-probe' then v_out := 'error:' || sqlerrm; end if;
  end;
  return v_out;
end;
$$;

with
ins as (
  select $q$insert into staff (id, name, email, branch, branch_id)
            values (%1$L, 'VERIFY branch sync', %1$L || '@example.invalid', $q$ as head
),
checks(check_name, got, expected) as (
  select 'lookup:cheras-long',   pg_temp.bname(branch_id_for_label('Cheras (Taman Connaught)')), 'Cheras'
  union all select 'lookup:puchong-long',  pg_temp.bname(branch_id_for_label('Puchong (Bandar Puteri)')), 'Puchong'
  union all select 'lookup:kepong-long',   pg_temp.bname(branch_id_for_label('Kepong (Taman Usahawan)')), 'Kepong'
  union all select 'lookup:short-name',    pg_temp.bname(branch_id_for_label('cheras')), 'Cheras'
  union all select 'lookup:other',         pg_temp.bname(branch_id_for_label('Other')), 'null'
  union all select 'lookup:empty',         pg_temp.bname(branch_id_for_label('  ')), 'null'
  union all select 'lookup:null',          pg_temp.bname(branch_id_for_label(null)), 'null'

  union all select 'insert:fills-null', pg_temp.probe(
      (select head from ins) || $q$'Cheras (Taman Connaught)', null)$q$), 'Cheras'
  union all select 'insert:explicit-wins', pg_temp.probe(
      (select head from ins) || $q$'Cheras (Taman Connaught)', branch_id_for_label('Puchong'))$q$), 'Puchong'
  union all select 'insert:other-stays-null', pg_temp.probe(
      (select head from ins) || $q$'Other', null)$q$), 'null'

  union all select 'update:label-change-reresolves', pg_temp.probe(
      (select head from ins) || $q$'Cheras (Taman Connaught)', null)$q$,
      $q$update staff set branch = 'Puchong (Bandar Puteri)' where id = %1$L$q$), 'Puchong'
  union all select 'update:other-clears', pg_temp.probe(
      (select head from ins) || $q$'Cheras (Taman Connaught)', null)$q$,
      $q$update staff set branch = 'Other' where id = %1$L$q$), 'null'
  union all select 'update:explicit-wins', pg_temp.probe(
      (select head from ins) || $q$'Cheras (Taman Connaught)', null)$q$,
      $q$update staff set branch = 'Puchong (Bandar Puteri)', branch_id = branch_id_for_label('Kepong') where id = %1$L$q$), 'Kepong'
  union all select 'update:null-id-refilled', pg_temp.probe(
      (select head from ins) || $q$'Kepong (Taman Usahawan)', branch_id_for_label('Cheras'))$q$,
      $q$update staff set branch_id = null where id = %1$L$q$), 'Kepong'

  union all select 'drift:resolvable-but-null',
      (select count(*)::text from staff
        where branch_id is null and branch_id_for_label(branch) is not null), '0'
  union all select 'drift:label-disagrees-with-id',
      (select count(*)::text from staff
        where branch_id_for_label(branch) is not null
          and branch_id is distinct from branch_id_for_label(branch)), '0'
)
select check_name, got, expected, got = expected as pass,
       bool_and(got = expected) over () as all_pass
  from checks;
