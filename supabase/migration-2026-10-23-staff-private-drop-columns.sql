-- 2026-10-23 — Phase 2 of the staff private-fields split.
--
-- Run ONLY after:
--   1. migration-2026-10-23-staff-private.sql ran on this database,
--   2. the new frontend and provision-staff are deployed,
--   3. migration-2026-10-23-staff-private.sql was re-run (catch-up backfill).
--
-- Irreversible: drops five staff columns. Their data lives in staff_private
-- and staff_manager_notes by now.
--
-- Self-gating: inside the transaction, before the drop, this file
--   (a) locks staff, so no write can land between the checks and the drop;
--   (b) drops the temporary sync trigger staff_private_sync_legacy_trg and
--       its function (created by phase 1 for the deploy window);
--   (c) runs the LOSS CHECK and raises if any value would be lost;
--   (d) raises if any other database object still depends on, or mentions,
--       one of the five columns.
-- Any raise aborts the whole transaction: nothing is dropped, and the sync
-- trigger stays in place. The registration_requests.phone cleanup (decision
-- D3) lives in phase 1, which runs twice; see the note there.
--
-- Re-running after a successful run is a clean no-op: the loss check and
-- both dependency checks are skipped when the columns are already gone.

-- ── LOSS CHECK (optional manual pre-run; the transaction below repeats it) ──
-- A value is "lost" if staff still holds it but the new table has nothing.
-- A different non-null value in the new table is fine: it is a newer edit.
--
-- select count(*) as lost
-- from staff s
-- left join staff_private p        on p.staff_id = s.id
-- left join staff_manager_notes n  on n.staff_id = s.id
-- where p.staff_id is null
--    or (s.ic_number      is not null and p.ic_number      is null)
--    or (s.date_of_birth  is not null and p.date_of_birth  is null)
--    or (s.contact_number is not null and p.contact_number is null)
--    or (s.address        is not null and p.address        is null)
--    or (s.manager_notes  is not null and n.notes          is null);

begin;

-- (a) Nobody writes staff until this transaction ends. ALTER TABLE below
-- needs this lock anyway; taking it first closes the gap between the loss
-- check and the drop.
lock table staff in access exclusive mode;

-- (b) The deploy-window sync trigger goes first: it is the one object this
-- branch owns that depends on the columns (`update of …`).
drop trigger if exists staff_private_sync_legacy_trg on staff;
drop function if exists staff_private_sync_legacy();

-- (c) LOSS CHECK, enforced.
do $do$
declare
  v_cols int;
  v_lost int;
begin
  select count(*) into v_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'staff'
    and column_name in ('ic_number','date_of_birth','contact_number','address','manager_notes');

  if v_cols = 0 then
    raise notice 'Old staff columns already gone: loss check skipped.';
    return;
  end if;
  if v_cols <> 5 then
    raise exception 'Expected all five old staff columns, found %. Investigate before dropping.', v_cols;
  end if;

  execute $q$
    select count(*)
    from staff s
    left join staff_private p        on p.staff_id = s.id
    left join staff_manager_notes n  on n.staff_id = s.id
    where p.staff_id is null
       or (s.ic_number      is not null and p.ic_number      is null)
       or (s.date_of_birth  is not null and p.date_of_birth  is null)
       or (s.contact_number is not null and p.contact_number is null)
       or (s.address        is not null and p.address        is null)
       or (s.manager_notes  is not null and n.notes          is null)
  $q$ into v_lost;

  if v_lost > 0 then
    -- Do not "fix" this by re-running phase 1: its coalesce backfill would
    -- copy back old values that someone deliberately cleared in the new UI.
    raise exception 'LOSS CHECK failed: % staff row(s) hold a value the new tables do not. Inspect these rows (the LOSS CHECK query at the top of this file lists the condition) and decide per row before retrying.', v_lost;
  end if;
end
$do$;

-- (d) Nothing else may still use the columns.
do $do$
declare
  v_deps  text;
  v_funcs text;
  -- Functions this branch owns. The sync function is already dropped above;
  -- it is listed so a manual re-order of this file cannot trip on it.
  v_allow constant text[] := array['staff_private_ensure_row','staff_private_sync_legacy'];
begin
  -- Re-run after a successful drop: nothing left to check (and the "address"
  -- scan could otherwise trip on an unrelated function). Clean no-op.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'staff'
                   and column_name in ('ic_number','date_of_birth','contact_number','address','manager_notes')) then
    raise notice 'Old staff columns already gone: dependency checks skipped.';
    return;
  end if;

  -- Catalog dependencies on the five columns: views, policies, indexes,
  -- constraints, column-list triggers …
  select string_agg(distinct pg_describe_object(d.classid, d.objid, d.objsubid), '; ')
    into v_deps
  from pg_depend d
  join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
  where d.refclassid = 'pg_class'::regclass
    and d.refobjid   = 'public.staff'::regclass
    and a.attname in ('ic_number','date_of_birth','contact_number','address','manager_notes')
    and not a.attisdropped;

  if v_deps is not null then
    raise exception 'Objects still depend on the old staff columns: %', v_deps;
  end if;

  -- Function bodies are not tracked in pg_depend: scan their source.
  -- Skips system and Supabase-managed schemas, extension-owned functions,
  -- and this branch's own functions. A hit is fail-closed: inspect it; a
  -- false positive (e.g. "address" in a comment) can be added to v_allow.
  -- Each hit names schema.function(args) and the column word(s) it matched,
  -- so the operator can judge a false positive at a glance.
  select string_agg(h.hit, '; ' order by h.hit)
    into v_funcs
  from (
    select format('%s.%s(%s) mentions %s',
                  n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
                  (select string_agg(distinct lower(m.w[1]), ', ')
                     from regexp_matches(p.prosrc,
                            '\m(ic_number|date_of_birth|contact_number|address|manager_notes)\M',
                            'gi') as m(w))) as hit
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog','information_schema','pg_toast',
                            'auth','storage','realtime','_realtime','extensions',
                            'graphql','graphql_public','pgbouncer','pgsodium',
                            'pgsodium_masks','vault','net','supabase_functions',
                            'supabase_migrations','cron','_analytics')
      and n.nspname not like 'pg_temp%'
      and n.nspname not like 'pg_toast_temp%'
      and not exists (select 1 from pg_depend e
                      where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
      and p.proname <> all (v_allow)
      and p.prosrc ~* '\m(ic_number|date_of_birth|contact_number|address|manager_notes)\M'
  ) h;

  if v_funcs is not null then
    raise exception 'Functions still mention the old staff columns: %. If a hit is a false positive (e.g. "address" in a comment), add its name to v_allow and re-run.', v_funcs;
  end if;
end
$do$;

alter table staff
  drop column if exists ic_number,
  drop column if exists address,
  drop column if exists date_of_birth,
  drop column if exists contact_number,
  drop column if exists manager_notes;

commit;

-- Verify (expect 0 rows):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'staff'
--   and column_name in ('ic_number','address','date_of_birth','contact_number','manager_notes');
