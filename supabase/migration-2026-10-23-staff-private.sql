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
-- Until then a TEMPORARY trigger (staff_private_sync_legacy_trg, below)
-- copies old-bundle writes into the new tables; phase 2 drops it first.
-- This file also clears registration_requests.phone on requests that are no
-- longer pending (decision D3).
--
-- Requires: migration-2026-07-06-rbac.sql (current_system_role()).
-- Idempotent: safe to re-run; re-running is also how the post-deploy
-- catch-up backfill is done.
--
-- Safe on any database state: everything that reads the five old staff
-- columns (ic_number, date_of_birth, contact_number, address, manager_notes)
-- runs through `execute` inside a DO block that first checks the columns
-- exist. So this file also runs cleanly on a fresh build (schema.sql no
-- longer adds them) and after phase 2 has dropped them.

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
-- `staff_id <> auth.uid()`: the subject of a note never sees or writes it,
-- even when they are themselves hr/manager/admin/owner.
create policy "staff_manager_notes_all" on staff_manager_notes for all to authenticated
  using (can_read_staff_private() and staff_id <> auth.uid())
  with check (can_read_staff_private() and staff_id <> auth.uid());

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

-- ── Temporary sync: old staff columns → new tables (deploy window) ────────────
-- TEMPORARY — dropped by phase 2 (migration-2026-10-23-staff-private-drop-
-- columns.sql) before it drops the columns.
--
-- Between this file and the new frontend going live, the old bundle still
-- writes the five staff columns (onboarding, profile edit, manager notes, the
-- old provision-staff approve). This trigger copies each such write into
-- staff_private / staff_manager_notes as it happens, so nothing written in
-- the window is left behind only in a column phase 2 will drop.
--
-- Only a value that actually CHANGED is copied (`old.x is distinct from
-- new.x`; on insert, a non-null new.x). The old bundle's profile save resends
-- every column, unchanged ones included; without this guard a stale,
-- unchanged value from an old tab would overwrite a newer edit made through
-- the new frontend.
--
-- Security definer (it must write rows the caller may not), so it applies the
-- new tables' own write rules itself instead of leaning on RLS:
--   private fields  copied only if the caller is the staff member, or
--                   can_read_staff_private(), or auth.uid() is null (service
--                   role / SQL editor);
--   manager notes   copied only if can_read_staff_private() and the row is
--                   not the caller's own, or auth.uid() is null.
-- Anything else (e.g. a supervisor writing a colleague's old contact_number
-- column, which staff_update has always allowed) stays in the old column
-- only and is dropped with it — it never reaches the new tables.
--
-- Created only when all five old columns exist (not on a fresh build, not
-- after phase 2).
do $do$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'staff'
        and column_name in ('ic_number','date_of_birth','contact_number','address','manager_notes')) = 5 then

    execute $fn$
      create or replace function staff_private_sync_legacy() returns trigger
      language plpgsql security definer set search_path = public as $body$
      declare
        c_ic    boolean;
        c_dob   boolean;
        c_phone boolean;
        c_addr  boolean;
        c_notes boolean;
      begin
        if tg_op = 'INSERT' then
          c_ic    := new.ic_number      is not null;
          c_dob   := new.date_of_birth  is not null;
          c_phone := new.contact_number is not null;
          c_addr  := new.address        is not null;
          c_notes := new.manager_notes  is not null;
        else
          c_ic    := new.ic_number      is distinct from old.ic_number;
          c_dob   := new.date_of_birth  is distinct from old.date_of_birth;
          c_phone := new.contact_number is distinct from old.contact_number;
          c_addr  := new.address        is distinct from old.address;
          c_notes := new.manager_notes  is distinct from old.manager_notes;
        end if;

        if (c_ic or c_dob or c_phone or c_addr)
           and (auth.uid() is null or new.id = auth.uid() or can_read_staff_private()) then
          insert into staff_private (staff_id) values (new.id)
          on conflict (staff_id) do nothing;
          update staff_private set
            ic_number      = case when c_ic    then new.ic_number      else ic_number      end,
            date_of_birth  = case when c_dob   then new.date_of_birth  else date_of_birth  end,
            contact_number = case when c_phone then new.contact_number else contact_number end,
            address        = case when c_addr  then new.address        else address        end,
            updated_at     = now()
          where staff_id = new.id;
        end if;

        if c_notes
           and (auth.uid() is null or (can_read_staff_private() and new.id <> auth.uid())) then
          insert into staff_manager_notes (staff_id, notes, updated_by, updated_at)
          values (new.id, new.manager_notes, auth.uid(), now())
          on conflict (staff_id) do update set
            notes      = excluded.notes,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at;
        end if;

        return new;
      end
      $body$
    $fn$;

    execute 'drop trigger if exists staff_private_sync_legacy_trg on staff';
    execute $t$
      create trigger staff_private_sync_legacy_trg
        after insert or update of ic_number, date_of_birth, contact_number, address, manager_notes
        on staff
        for each row execute function staff_private_sync_legacy()
    $t$;
  else
    raise notice 'staff private columns absent: sync trigger not created';
  end if;
end
$do$;

-- ── Backfill (idempotent) ────────────────────────────────────────────────────
-- Every staff row gets a staff_private row, whatever the database state.
insert into staff_private (staff_id)
select id from staff
on conflict (staff_id) do nothing;

-- Copy the old column values, only while the old columns still exist.
-- coalesce keeps the new table's value: anything the new frontend already
-- wrote wins; only cells still empty in the new table are filled from staff.
do $do$
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'staff'
        and column_name in ('ic_number','date_of_birth','contact_number','address')) = 4 then
    execute $q$
      insert into staff_private (staff_id, ic_number, date_of_birth, contact_number, address)
      select id, ic_number, date_of_birth, contact_number, address from staff
      on conflict (staff_id) do update set
        ic_number      = coalesce(staff_private.ic_number,      excluded.ic_number),
        date_of_birth  = coalesce(staff_private.date_of_birth,  excluded.date_of_birth),
        contact_number = coalesce(staff_private.contact_number, excluded.contact_number),
        address        = coalesce(staff_private.address,        excluded.address)
    $q$;
  else
    raise notice 'staff private columns absent: private-field backfill skipped';
  end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'staff'
               and column_name = 'manager_notes') then
    execute $q$
      insert into staff_manager_notes (staff_id, notes)
      select id, manager_notes from staff where manager_notes is not null
      on conflict (staff_id) do update
        set notes = coalesce(staff_manager_notes.notes, excluded.notes)
    $q$;
  else
    raise notice 'staff.manager_notes absent: notes backfill skipped';
  end if;
end
$do$;

-- ── registration_requests.phone: keep it only while a request is pending ─────
-- (decision D3, 2026-10-23.) registration_requests is readable by
-- supervisors, who are not readers of private fields. Once a request is
-- approved, the number lives in staff_private (provision-staff approve now
-- clears it itself); a rejected request has no further use for it (Directory
-- reject now clears it too). This one-time cleanup handles the rows written
-- before that. It lives here rather than in phase 2 because this file is run
-- twice (before deploy and again as the catch-up), so it also clears rows
-- approved by the old provision-staff in the deploy window, and it gets the
-- numbers out of supervisors' reach at the earliest step. Pending requests
-- keep their phone: the approve flow still needs it.
--
-- It never destroys the only copy of a number:
--   1. An approved request's phone is first copied into the matching staff
--      member's staff_private.contact_number when that is still empty
--      (request → staff by lower(trim(email)) on both sides).
--   2. A non-pending request's phone is then cleared only if
--        - that exact number is now in the matching staff member's
--          staff_private row, or
--        - the request is REJECTED and no staff row has its email (the number
--          belongs to no staff member).
--      Everything else keeps its phone — an approved request whose staff row
--      cannot be matched (email null or changed), or whose staff member now
--      has a different number — and is counted in a NOTICE and in the
--      kept_reg_phones column of the sanity select at the end of this file
--      (the SQL editor may not show NOTICEs).
-- Idempotent. Skipped (with a notice) if registration_requests.phone or
-- staff.email is absent.
do $do$
declare
  v_left int;
begin
  if (select count(*) from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'registration_requests' and column_name = 'phone')
          or (table_name = 'staff' and column_name = 'email'))) <> 2 then
    raise notice 'registration_requests.phone or staff.email absent: phone cleanup skipped';
    return;
  end if;

  execute $q$
    update staff_private p
       set contact_number = r.phone,
           updated_at     = now()
      from staff s
      join registration_requests r on lower(trim(r.email)) = lower(trim(s.email))
     where p.staff_id = s.id
       and r.status = 'approved'
       and r.phone is not null
       and p.contact_number is null
  $q$;

  execute $q$
    update registration_requests r
       set phone = null
     where r.status <> 'pending'
       and r.phone is not null
       and (
             exists (select 1
                       from staff s
                       join staff_private p on p.staff_id = s.id
                      where lower(trim(s.email)) = lower(trim(r.email))
                        and p.contact_number = r.phone)
          or (r.status = 'rejected'
              and not exists (select 1 from staff s where lower(trim(s.email)) = lower(trim(r.email))))
           )
  $q$;

  execute $q$
    select count(*) from registration_requests
     where status <> 'pending' and phone is not null
  $q$ into v_left;

  if v_left > 0 then
    raise notice '% non-pending registration request(s) keep their phone: no safe copy in staff_private. Review: select id, email, status, phone from registration_requests where status <> ''pending'' and phone is not null;', v_left;
  end if;
end
$do$;

commit;

-- Sanity (expect private_rows = staff_rows). kept_reg_phones = non-pending
-- registration requests that still hold a phone because no safe copy exists
-- in staff_private; if not 0, review them:
--   select id, email, status, phone from registration_requests
--   where status <> 'pending' and phone is not null;
select (select count(*) from staff) as staff_rows,
       (select count(*) from staff_private) as private_rows,
       (select count(*) from staff_manager_notes) as notes_rows,
       (select count(*) from registration_requests
         where status <> 'pending' and phone is not null) as kept_reg_phones;
