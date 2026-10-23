-- 2026-10-23 — Phase 1 of the staff private-fields split (PDPA, second tier)
--
-- staff_select is `to authenticated using (true)`, so every logged-in staff
-- member could read every colleague's IC number, address, date of birth,
-- phone and the manager's private notes. This moves them to two tables:
--   staff_private        self + hr/manager/admin/owner
--   staff_manager_notes  hr/manager/admin/owner only (not the subject)
--
-- The old staff columns are NOT dropped here — the deployed bundle still
-- reads and writes them until the new frontend ships. Phase 2
-- (migration-2026-10-23-staff-private-drop-columns.sql) drops them.
--
-- Requires: migration-2026-07-06-rbac.sql (current_system_role()).
-- Idempotent: safe to re-run; re-running is also how the post-deploy
-- backfill (rollout step 3) is done.

begin;

-- ── Who may read private fields ──────────────────────────────────────────────
-- Same set as the salary tier in migration-2026-07-08-rls-system-role.sql.
create or replace function can_read_staff_private() returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce(current_rank() = 'manager', false)
      or coalesce(current_system_role() in ('hr','manager','admin','owner'), false);
$$;

-- ── staff_private ────────────────────────────────────────────────────────────
create table if not exists staff_private (
  staff_id       uuid primary key references staff(id) on delete cascade,
  ic_number      text,
  date_of_birth  date,
  contact_number text,
  address        text,
  updated_at     timestamptz not null default now()
);
alter table staff_private enable row level security;
revoke all on staff_private from anon;

drop policy if exists "staff_private_select" on staff_private;
create policy "staff_private_select" on staff_private for select to authenticated
  using (staff_id = auth.uid() or can_read_staff_private());

drop policy if exists "staff_private_insert" on staff_private;
create policy "staff_private_insert" on staff_private for insert to authenticated
  with check (staff_id = auth.uid() or can_read_staff_private());

drop policy if exists "staff_private_update" on staff_private;
create policy "staff_private_update" on staff_private for update to authenticated
  using (staff_id = auth.uid() or can_read_staff_private())
  with check (staff_id = auth.uid() or can_read_staff_private());
-- No delete policy: rows go away with their staff row (on delete cascade).

-- ── staff_manager_notes ──────────────────────────────────────────────────────
create table if not exists staff_manager_notes (
  staff_id    uuid primary key references staff(id) on delete cascade,
  notes       text,
  updated_by  uuid references staff(id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table staff_manager_notes enable row level security;
revoke all on staff_manager_notes from anon;

drop policy if exists "staff_manager_notes_all" on staff_manager_notes;
create policy "staff_manager_notes_all" on staff_manager_notes for all to authenticated
  using (can_read_staff_private())
  with check (can_read_staff_private());

-- ── Every staff row has a staff_private row ──────────────────────────────────
-- The frontend reads "no row" as "no permission" (RLS hides the row), so a
-- missing row would show a reader "Restricted". Guarantee the row at insert,
-- whatever path inserted the staff row (provision-staff create/approve, SQL).
create or replace function staff_private_ensure_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into staff_private (staff_id) values (new.id)
  on conflict (staff_id) do nothing;
  return new;
end $$;

drop trigger if exists staff_private_ensure_row_trg on staff;
create trigger staff_private_ensure_row_trg
  after insert on staff
  for each row execute function staff_private_ensure_row();

-- ── Backfill (idempotent) ────────────────────────────────────────────────────
-- coalesce keeps the new table's value: anything the new frontend already
-- wrote wins; only cells still empty in the new table are filled from staff.
insert into staff_private (staff_id, ic_number, date_of_birth, contact_number, address)
select id, ic_number, date_of_birth, contact_number, address from staff
on conflict (staff_id) do update set
  ic_number      = coalesce(staff_private.ic_number,      excluded.ic_number),
  date_of_birth  = coalesce(staff_private.date_of_birth,  excluded.date_of_birth),
  contact_number = coalesce(staff_private.contact_number, excluded.contact_number),
  address        = coalesce(staff_private.address,        excluded.address);

insert into staff_manager_notes (staff_id, notes)
select id, manager_notes from staff where manager_notes is not null
on conflict (staff_id) do update
  set notes = coalesce(staff_manager_notes.notes, excluded.notes);

commit;

-- Sanity (expect private_rows = staff_rows):
select (select count(*) from staff) as staff_rows,
       (select count(*) from staff_private) as private_rows,
       (select count(*) from staff_manager_notes) as notes_rows;
