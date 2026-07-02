-- ============================================================================
-- Craft OS — CATCH-UP MIGRATION (2026-07-02)
--
-- The live database is missing several tables/columns that the deployed code
-- expects (verified against production on 2026-07-02):
--
--   MISSING TABLES:  shift_types, scheduled_shifts, probation_reviews
--   MISSING COLUMNS: staff.manager_notes, staff.last_level_up_at,
--                    staff.is_active, staff.status,
--                    attendance.break_* (5 columns)
--   MISSING DATA:    system_rules 'default_break_minutes'
--   MISSING STORAGE: staff-avatars policies (bucket itself was created via API)
--   POLICY FIX:      staff_update now includes supervisors (probation
--                    hire/eliminate writes to the trainee's staff row)
--
-- HOW TO RUN: Supabase Dashboard → SQL Editor → paste this whole file → Run.
-- The script is idempotent — running it twice is safe.
-- ============================================================================

-- ── 1. Staff management columns ─────────────────────────────────────────────
alter table staff add column if not exists manager_notes    text;
alter table staff add column if not exists last_level_up_at timestamptz;
alter table staff add column if not exists is_active        boolean not null default true;

-- Resignation status: resigned staff keep ALL historical data; they are only
-- hidden from scheduling and blocked from logging in. Reactivate anytime.
alter table staff add column if not exists status text not null default 'active'
  check (status in ('active','resigned'));

-- Supervisors need staff updates: probation hire/eliminate writes
-- onboarding_completed / is_active on the trainee's row (the original policy
-- only allowed self or manager, so those writes silently updated 0 rows).
drop policy if exists "staff_update" on staff;
create policy "staff_update" on staff for update
  using (id = auth.uid() or current_rank() in ('supervisor','manager'));

-- ── 2. XP trigger update (records level-up timestamp) ───────────────────────
create or replace function award_xp_on_approval()
returns trigger language plpgsql security definer as $$
declare
  v_xp         int;
  v_old_level  int;
  v_new_level  int;
  v_current_xp int;
begin
  if (NEW.status = 'approved' and OLD.status != 'approved') then
    select xp_reward into v_xp from missions where id = NEW.mission_id;
    select xp, level into v_current_xp, v_old_level from staff where id = NEW.staff_id;
    v_new_level := floor((v_current_xp + v_xp) / 500) + 1;
    update staff
      set xp               = v_current_xp + v_xp,
          level            = v_new_level,
          last_level_up_at = case when v_new_level > v_old_level then now() else last_level_up_at end
      where id = NEW.staff_id;
  end if;
  return NEW;
end;
$$;

-- ── 3. Probation reviews (3-day trainee evaluation) ─────────────────────────
create table if not exists probation_reviews (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id) on delete cascade,
  reviewer_id uuid references staff(id),
  start_date date not null,

  day1_attitude      jsonb not null default '{}',
  day1_communication jsonb not null default '{}',
  day1_elimination   jsonb not null default '{}',
  day1_result        text check (day1_result in ('continue','eliminate')),
  day1_completed_at  timestamptz,

  day2_process       jsonb not null default '{}',
  day2_serving       jsonb not null default '{}',
  day2_elimination   jsonb not null default '{}',
  day2_result        text check (day2_result in ('continue','eliminate')),
  day2_completed_at  timestamptz,

  day3_attitude      jsonb not null default '{}',
  day3_performance   jsonb not null default '{}',
  day3_result        text check (day3_result in ('hire','eliminate')),
  day3_completed_at  timestamptz,

  overall_result     text check (overall_result in ('hired','eliminated')),
  supervisor_notes   text,
  created_at         timestamptz not null default now()
);

alter table probation_reviews enable row level security;

drop policy if exists "probation_select" on probation_reviews;
create policy "probation_select" on probation_reviews for select
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
drop policy if exists "probation_insert" on probation_reviews;
create policy "probation_insert" on probation_reviews for insert
  with check (current_rank() in ('supervisor','manager'));
drop policy if exists "probation_update" on probation_reviews;
create policy "probation_update" on probation_reviews for update
  using (current_rank() in ('supervisor','manager'));

-- ── 4. Shift scheduling tables ───────────────────────────────────────────────
create table if not exists shift_types (
  id uuid primary key default gen_random_uuid(),
  department text not null default 'barista',
  name text not null,
  start_time time not null,
  end_time time not null,
  break_start time,                       -- legacy, no longer used
  break_end time,                         -- legacy, no longer used
  break_minutes int not null default 60,  -- allowed break duration per shift
  color text not null default '#8B6344',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists scheduled_shifts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  shift_type_id uuid not null references shift_types(id) on delete cascade,
  branch_id uuid references branches(id),
  date date not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','confirmed','swapped','cancelled')),
  notes text,
  created_by uuid references staff(id),
  created_at timestamptz not null default now(),
  unique (staff_id, date)  -- one shift per staff per day (app upserts on staff_id,date)
);

alter table shift_types enable row level security;
alter table scheduled_shifts enable row level security;

drop policy if exists "shift_types_select" on shift_types;
create policy "shift_types_select" on shift_types for select to authenticated using (true);
drop policy if exists "shift_types_manage" on shift_types;
create policy "shift_types_manage" on shift_types for all
  using (current_rank() = 'manager');

drop policy if exists "scheduled_shifts_select" on scheduled_shifts;
create policy "scheduled_shifts_select" on scheduled_shifts for select to authenticated using (true);
drop policy if exists "scheduled_shifts_manage" on scheduled_shifts;
create policy "scheduled_shifts_manage" on scheduled_shifts for all
  using (current_rank() in ('supervisor','manager'));

-- ── 5. Break clock tracking on attendance ────────────────────────────────────
alter table attendance add column if not exists break_start           timestamptz; -- clocked out for break
alter table attendance add column if not exists break_end             timestamptz; -- clocked back in from break
alter table attendance add column if not exists break_minutes         int;         -- actual minutes taken
alter table attendance add column if not exists break_late            boolean not null default false;
alter table attendance add column if not exists break_overrun_minutes int not null default 0;

-- Global fallback break duration (used when no shift is scheduled that day)
insert into system_rules (key, value, label, description) values
  ('default_break_minutes', '60', 'Default break (minutes)', 'Break duration used when no shift is scheduled for the day')
on conflict (key) do nothing;

-- ── 5b. Attendance GPS/selfie + branch geofence columns ──────────────────────
-- These already exist in production (added out-of-band); included so this
-- script also brings a FRESH database fully up to date. No-ops on prod.
alter table attendance add column if not exists clock_in_photo_url  text;
alter table attendance add column if not exists clock_out_photo_url text;
alter table attendance add column if not exists clock_in_lat        double precision;
alter table attendance add column if not exists clock_in_lng        double precision;
alter table attendance add column if not exists clock_in_distance_m int;
alter table attendance add column if not exists clock_out_lat        double precision;
alter table attendance add column if not exists clock_out_lng        double precision;
alter table attendance add column if not exists clock_out_distance_m int;

alter table branches add column if not exists latitude      double precision;
alter table branches add column if not exists longitude     double precision;
alter table branches add column if not exists radius_meters int;

-- ── 6. Staff avatars storage ─────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('staff-avatars', 'staff-avatars', true)
on conflict (id) do nothing;

drop policy if exists "staff_avatars_read" on storage.objects;
create policy "staff_avatars_read" on storage.objects for select
  using (bucket_id = 'staff-avatars');

-- Writes are scoped to the uploader's own folder (`<staff_id>/...`); managers may
-- write anywhere (they can upload avatars for other staff).
drop policy if exists "staff_avatars_write" on storage.objects;
create policy "staff_avatars_write" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'staff-avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or current_rank() = 'manager')
  );

drop policy if exists "staff_avatars_update" on storage.objects;
create policy "staff_avatars_update" on storage.objects for update to authenticated
  using (
    bucket_id = 'staff-avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or current_rank() = 'manager')
  )
  with check (
    bucket_id = 'staff-avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or current_rank() = 'manager')
  );

-- ── Done. Verify with:
--   select column_name from information_schema.columns where table_name = 'staff';
--   select id from storage.buckets;
