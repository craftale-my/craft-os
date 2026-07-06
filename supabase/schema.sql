-- =============================================
-- Craft OS — Supabase Schema
-- Run this in your Supabase SQL Editor
-- =============================================

-- Staff profiles
create table if not exists staff (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  email text,                         -- mirror of auth.users.email, set at creation
  avatar text,
  rank text not null default 'trainee'
    check (rank in ('trainee','junior','senior','supervisor','manager')),
  level int not null default 1,
  xp int not null default 0,
  department text check (department in ('barista','bakery','kitchen')),
  joined_at date,
  created_at timestamptz not null default now()
);

-- Missions
create table if not exists missions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  xp_reward int not null check (xp_reward > 0),
  category text check (category in ('espresso','milk','service','ops','knowledge','leadership')),
  min_rank text not null default 'trainee'
    check (min_rank in ('trainee','junior','senior','supervisor','manager')),
  requires_approval boolean not null default true,
  verification_type text not null default 'supervisor'
    check (verification_type in ('photo','supervisor','both')),
  created_at timestamptz not null default now()
);

-- Mission completions
create table if not exists mission_completions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  mission_id uuid not null references missions(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  approved_by uuid references staff(id),
  photo_url text,
  supervisor_note text,
  completed_at timestamptz not null default now()
);

-- Prevent duplicate pending submissions for the same mission
create unique index if not exists mission_completions_unique_pending
  on mission_completions (staff_id, mission_id)
  where status = 'pending';

-- Skill ratings
create table if not exists skill_ratings (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  category text not null,
  skill text not null,
  rating int not null check (rating between 1 and 5),
  rated_by uuid references staff(id),
  rated_at timestamptz not null default now(),
  unique (staff_id, category, skill)
);

-- =============================================
-- XP award trigger: when a completion is approved,
-- add XP to staff and recalculate level.
-- =============================================
create or replace function award_xp_on_approval()
returns trigger language plpgsql security definer as $$
declare
  v_xp int;
begin
  if (NEW.status = 'approved' and OLD.status != 'approved') then
    select xp_reward into v_xp from missions where id = NEW.mission_id;
    update staff
      set xp    = xp + v_xp,
          level = floor((xp + v_xp) / 500) + 1
      where id = NEW.staff_id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_award_xp on mission_completions;
create trigger trg_award_xp
  after update on mission_completions
  for each row execute function award_xp_on_approval();

-- =============================================
-- Row Level Security
-- =============================================
alter table staff enable row level security;
alter table missions enable row level security;
alter table mission_completions enable row level security;
alter table skill_ratings enable row level security;

create or replace function current_rank()
returns text language sql security definer stable as $$
  select rank from staff where id = auth.uid()
$$;

-- Staff policies
create policy "staff_select" on staff for select using (true);
create policy "staff_insert" on staff for insert
  with check (current_rank() in ('manager'));
-- Supervisors need staff updates too: probation hire/eliminate writes
-- onboarding_completed / is_active on the trainee's row.
create policy "staff_update" on staff for update
  using (id = auth.uid() or current_rank() in ('supervisor','manager'));

-- Mission policies
create policy "missions_select" on missions for select using (true);
create policy "missions_insert" on missions for insert
  with check (current_rank() = 'manager');
create policy "missions_update" on missions for update
  using (current_rank() = 'manager');
create policy "missions_delete" on missions for delete
  using (current_rank() = 'manager');

-- Mission completion policies
create policy "completions_select" on mission_completions for select
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
create policy "completions_insert" on mission_completions for insert
  with check (staff_id = auth.uid());
create policy "completions_update" on mission_completions for update
  using (current_rank() in ('supervisor','manager'));

-- Skill rating policies
create policy "skills_select" on skill_ratings for select using (true);
create policy "skills_insert" on skill_ratings for insert
  with check (current_rank() in ('supervisor','manager'));
create policy "skills_update" on skill_ratings for update
  using (current_rank() in ('supervisor','manager'));

-- =============================================
-- Supabase Storage
-- Run separately in the Supabase dashboard:
-- 1. Go to Storage → New bucket
-- 2. Name: mission-proofs
-- 3. Public: YES (so photo URLs work without auth)
-- 4. Add storage policy: allow authenticated users to INSERT
--    to path: (uid())::text || '/*'
-- =============================================

-- =============================================
-- Seed: default missions with verification types
-- =============================================
insert into missions (title, description, xp_reward, category, min_rank, requires_approval, verification_type) values
  ('Pull 50 espresso shots',                'Demonstrate consistent extraction across 50 shots.',                          100, 'espresso',   'trainee',    true, 'both'),
  ('Calibrate grinder 3 days in a row',     'Dial in the grinder each morning for 3 consecutive days.',                   80,  'espresso',   'trainee',    true, 'supervisor'),
  ('Steam milk to perfect temperature 20 times', 'Hit 65–70°C consistently.',                                             80,  'milk',       'trainee',    true, 'both'),
  ('Pour a rosetta latte art',              'Produce a recognisable rosetta on a flat white.',                            120, 'milk',       'junior',     true, 'photo'),
  ('Get 5 positive customer compliments',   'Collect 5 verified positive feedback cards or digital mentions.',            120, 'service',    'trainee',    true, 'supervisor'),
  ('Complete opening checklist 5 days in a row', 'Full checklist signed off, no missed items.',                           80,  'ops',        'trainee',    true, 'photo'),
  ('Pass coffee origins quiz',              'Score ≥80% on the coffee origins knowledge test.',                           100, 'knowledge',  'trainee',    true, 'supervisor'),
  ('Train 1 trainee through full onboarding', 'Guide a trainee from day 1 to completing their first week checklist.',     300, 'leadership', 'senior',     true, 'supervisor'),
  ('Complete full menu knowledge test',     'Score ≥90% on the full menu quiz.',                                          100, 'knowledge',  'trainee',    true, 'supervisor'),
  ('Handle a customer complaint successfully', 'Resolve a complaint with manager sign-off.',                              150, 'service',    'junior',     true, 'supervisor')
on conflict do nothing;

-- =============================================
-- Onboarding migration
-- Run this block separately if the tables above already exist.
-- =============================================

-- Drop the old department CHECK constraint so onboarding values can be stored
alter table staff drop constraint if exists staff_department_check;

-- Add onboarding + HR fields to staff
alter table staff add column if not exists onboarding_completed boolean not null default false;
alter table staff add column if not exists nickname            text;
alter table staff add column if not exists ic_number          text;
alter table staff add column if not exists address            text;
alter table staff add column if not exists gender             text;
alter table staff add column if not exists date_of_birth      date;
alter table staff add column if not exists contact_number     text;
alter table staff add column if not exists branch             text;
alter table staff add column if not exists employment_type    text;
alter table staff add column if not exists working_experience text;
alter table staff add column if not exists education          text;

-- Manager accounts are considered onboarded by default
update staff set onboarding_completed = true where rank = 'manager';

-- =============================================
-- Dashboard & Staff Management additions
-- Run this block if the tables above already exist.
-- =============================================

-- Manager notes and level-up tracking
alter table staff add column if not exists manager_notes    text;
alter table staff add column if not exists last_level_up_at timestamptz;

-- =============================================
-- Monthly Performance Reviews
-- =============================================

create table if not exists monthly_reviews (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid references staff(id) on delete cascade,
  reviewer_id uuid references staff(id),
  month       int not null,
  year        int not null,

  -- Attendance
  late_count       int default 0,
  attendance_score int generated always as (greatest(0, 100 - (late_count * 10))) stored,

  -- Self evaluation
  self_attitude    int check (self_attitude    between 1 and 5),
  self_efficiency  int check (self_efficiency  between 1 and 5),
  self_coffee_skill int check (self_coffee_skill between 1 and 5),
  self_service     int check (self_service     between 1 and 5),
  self_comments    text,
  self_submitted_at timestamptz,

  -- Supervisor evaluation
  sup_attitude    int check (sup_attitude    between 1 and 5),
  sup_efficiency  int check (sup_efficiency  between 1 and 5),
  sup_coffee_skill int check (sup_coffee_skill between 1 and 5),
  sup_service     int check (sup_service     between 1 and 5),
  sup_comments    text,
  sup_submitted_at timestamptz,

  status      text not null default 'pending'
                check (status in ('pending','self_done','completed')),
  created_at  timestamptz not null default now(),

  unique (staff_id, month, year)
);

alter table monthly_reviews enable row level security;

-- Staff see own reviews; supervisors/managers see all
create policy "reviews_select" on monthly_reviews for select
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));

-- Only supervisors/managers can create review records (start a cycle)
create policy "reviews_insert" on monthly_reviews for insert
  with check (current_rank() in ('supervisor','manager'));

-- Staff can update own review; supervisors/managers can update any
create policy "reviews_update_self" on monthly_reviews for update
  using (staff_id = auth.uid());
create policy "reviews_update_sup" on monthly_reviews for update
  using (current_rank() in ('supervisor','manager'));

-- Updated XP trigger: also records timestamp when level increases
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

-- =============================================
-- Probation Reviews
-- =============================================

alter table staff add column if not exists is_active boolean not null default true;

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

create policy "probation_select" on probation_reviews for select
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
create policy "probation_insert" on probation_reviews for insert
  with check (current_rank() in ('supervisor','manager'));
create policy "probation_update" on probation_reviews for update
  using (current_rank() in ('supervisor','manager'));

-- Registration requests (self-service staff registration)
create table if not exists registration_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null unique,
  phone text,
  branch text,
  department text,
  employment_type text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  reviewed_by uuid references staff(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz not null default now()
);

alter table registration_requests enable row level security;

create policy "registration_requests_insert" on registration_requests for insert
  to anon, authenticated with check (true);
create policy "registration_requests_manage" on registration_requests for all
  using (current_rank() in ('supervisor','manager'));

-- =============================================
-- General Settings module
-- =============================================

-- Company settings (single row)
create table if not exists company_settings (
  id uuid primary key default gen_random_uuid(),
  company_name text default 'Craftale Sdn Bhd',
  cafe_name text default 'Craft Cafe',
  logo_url text,
  company_culture text,
  contact_email text,
  contact_phone text,
  address text,
  updated_at timestamptz default now()
);

insert into company_settings (id)
values ('00000000-0000-0000-0000-000000000001')
on conflict do nothing;

-- Branches
create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  pic_staff_id uuid references staff(id),
  operating_hours text,
  is_active boolean default true,
  created_at timestamptz default now()
);

insert into branches (name, address)
select v.name, v.address
from (values
  ('Cheras', 'Taman Connaught, Cheras'),
  ('Puchong', 'Bandar Puteri, Puchong')
) as v(name, address)
where not exists (select 1 from branches);

-- Roles / positions
create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  rank text not null check (rank in ('trainee','junior','senior','supervisor','manager')),
  department text,
  description text,
  permissions jsonb default '{}',
  is_active boolean default true,
  created_at timestamptz default now()
);

insert into roles (name, rank, department) values
  ('Trainee Barista', 'trainee', 'barista'),
  ('Junior Barista', 'junior', 'barista'),
  ('Senior Barista', 'senior', 'barista'),
  ('Barista Supervisor', 'supervisor', 'barista'),
  ('Cafe Manager', 'manager', 'barista'),
  ('Bakery Trainee', 'trainee', 'bakery'),
  ('Baker', 'junior', 'bakery'),
  ('Senior Baker', 'senior', 'bakery'),
  ('Kitchen Crew', 'junior', 'kitchen'),
  ('Senior Kitchen', 'senior', 'kitchen')
on conflict (name) do nothing;

-- XP & scoring rules
create table if not exists system_rules (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text not null,
  label text,
  description text,
  updated_at timestamptz default now()
);

insert into system_rules (key, value, label, description) values
  ('xp_per_level', '500', 'XP per level', 'XP needed to advance one level'),
  ('late_deduction', '10', 'Late deduction (%)', 'Score deducted per late instance in monthly review'),
  ('review_weight_attendance', '30', 'Attendance weight (%)', 'Weight of attendance in final score'),
  ('review_weight_attitude', '15', 'Attitude weight (%)', 'Weight of attitude in final score'),
  ('review_weight_efficiency', '20', 'Efficiency weight (%)', 'Weight of efficiency in final score'),
  ('review_weight_coffee', '20', 'Coffee skill weight (%)', 'Weight of coffee skill in final score'),
  ('review_weight_service', '15', 'Service weight (%)', 'Weight of service quality in final score'),
  ('probation_days', '3', 'Probation days', 'Number of probation days for new trainees')
on conflict (key) do nothing;

-- Notification settings
create table if not exists notification_settings (
  id uuid primary key default gen_random_uuid(),
  event_type text not null unique,
  label text,
  enabled boolean default true,
  notify_staff boolean default true,
  notify_supervisor boolean default true,
  notify_manager boolean default false
);

insert into notification_settings (event_type, label, notify_staff, notify_supervisor, notify_manager) values
  ('mission_approved', 'Mission Approved', true, false, false),
  ('mission_rejected', 'Mission Rejected', true, false, false),
  ('level_up', 'Staff Level Up', true, true, true),
  ('review_due', 'Monthly Review Due', true, true, true),
  ('probation_due', 'Probation Review Due', false, true, true),
  ('registration_request', 'New Registration Request', false, true, true),
  ('onboarding_completed', 'Staff Completed Onboarding', false, true, true)
on conflict (event_type) do nothing;

alter table company_settings enable row level security;
alter table branches enable row level security;
alter table roles enable row level security;
alter table system_rules enable row level security;
alter table notification_settings enable row level security;

create policy "settings_manage" on company_settings for all
  using (current_rank() = 'manager');

create policy "branches_select" on branches for select to authenticated using (true);
create policy "branches_manage" on branches for all
  using (current_rank() = 'manager');

create policy "roles_select" on roles for select to authenticated using (true);
create policy "roles_manage" on roles for all
  using (current_rank() = 'manager');

create policy "rules_select" on system_rules for select to authenticated using (true);
create policy "rules_manage" on system_rules for all
  using (current_rank() = 'manager');

create policy "notifications_manage" on notification_settings for all
  using (current_rank() = 'manager');

-- Storage bucket for company logo / assets
insert into storage.buckets (id, name, public)
values ('company-assets', 'company-assets', true)
on conflict (id) do nothing;

create policy "company_assets_public_read" on storage.objects for select
  using (bucket_id = 'company-assets');
create policy "company_assets_manager_write" on storage.objects for all
  using (bucket_id = 'company-assets' and current_rank() = 'manager');

-- =============================================
-- HR module: Attendance, Salary, Leave, Claims
-- =============================================

-- ATTENDANCE
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id),
  date date not null,
  clock_in timestamptz,
  clock_out timestamptz,
  status text default 'present'
    check (status in ('present','absent','late','half_day','public_holiday','on_leave')),
  late_minutes int default 0,
  notes text,
  recorded_by uuid references staff(id),
  created_at timestamptz default now(),
  unique(staff_id, date)
);

alter table attendance enable row level security;

create policy "attendance_select_own" on attendance for select to authenticated
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
create policy "attendance_manage" on attendance for all to authenticated
  using (current_rank() in ('supervisor','manager'));
create policy "attendance_self_clock" on attendance for insert to authenticated
  with check (staff_id = auth.uid());
create policy "attendance_self_update" on attendance for update to authenticated
  using (staff_id = auth.uid());

-- SALARY RECORDS
create table if not exists salary_records (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id),
  month int not null,
  year int not null,
  basic_salary numeric(10,2) default 0,
  allowances numeric(10,2) default 0,
  overtime numeric(10,2) default 0,
  deductions numeric(10,2) default 0,
  bonus numeric(10,2) default 0,
  gross_salary numeric(10,2) generated always as
    (basic_salary + allowances + overtime + bonus - deductions) stored,
  epf_employee numeric(10,2) default 0,
  socso_employee numeric(10,2) default 0,
  eis_employee numeric(10,2) default 0,
  pcb numeric(10,2) default 0,
  net_salary numeric(10,2) generated always as
    (basic_salary + allowances + overtime + bonus - deductions
     - epf_employee - socso_employee - eis_employee - pcb) stored,
  payment_date date,
  payment_method text default 'bank_transfer'
    check (payment_method in ('bank_transfer','cash','cheque')),
  notes text,
  created_by uuid references staff(id),
  created_at timestamptz default now(),
  unique(staff_id, month, year)
);

alter table salary_records enable row level security;

create policy "salary_select_own" on salary_records for select to authenticated
  using (staff_id = auth.uid() or current_rank() = 'manager');
create policy "salary_manage" on salary_records for all to authenticated
  using (current_rank() = 'manager');

-- LEAVE
create table if not exists leave_entitlements (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id),
  year int not null,
  annual_entitled int default 8,
  annual_used int default 0,
  medical_entitled int default 14,
  medical_used int default 0,
  emergency_entitled int default 3,
  emergency_used int default 0,
  unpaid_used int default 0,
  unique(staff_id, year)
);

create table if not exists leave_requests (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id),
  leave_type text not null
    check (leave_type in ('annual','medical','emergency','unpaid','maternity','paternity','public_holiday')),
  start_date date not null,
  end_date date not null,
  total_days int not null,
  reason text,
  attachment_url text,
  status text default 'pending'
    check (status in ('pending','approved','rejected','cancelled')),
  reviewed_by uuid references staff(id),
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz default now()
);

alter table leave_entitlements enable row level security;
alter table leave_requests enable row level security;

create policy "leave_select_own" on leave_requests for select to authenticated
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
create policy "leave_create_own" on leave_requests for insert to authenticated
  with check (staff_id = auth.uid());
create policy "leave_cancel_own" on leave_requests for update to authenticated
  using (staff_id = auth.uid() and status = 'pending');
create policy "leave_manage" on leave_requests for all to authenticated
  using (current_rank() in ('supervisor','manager'));

create policy "entitlements_select_own" on leave_entitlements for select to authenticated
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
create policy "entitlements_manage" on leave_entitlements for all to authenticated
  using (current_rank() in ('supervisor','manager'));
create policy "entitlements_self_upsert" on leave_entitlements for insert to authenticated
  with check (staff_id = auth.uid());

-- CLAIMS
create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id),
  claim_type text not null
    check (claim_type in ('transport','parking','meal','medical','phone','uniform','other')),
  amount numeric(10,2) not null,
  description text not null,
  receipt_url text,
  claim_date date not null,
  status text default 'pending'
    check (status in ('pending','approved','rejected')),
  reviewed_by uuid references staff(id),
  reviewed_at timestamptz,
  rejection_reason text,
  paid_at timestamptz,
  created_at timestamptz default now()
);

alter table claims enable row level security;

create policy "claims_select_own" on claims for select to authenticated
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
create policy "claims_create_own" on claims for insert to authenticated
  with check (staff_id = auth.uid());
create policy "claims_manage" on claims for all to authenticated
  using (current_rank() in ('supervisor','manager'));

-- Storage buckets for HR attachments
insert into storage.buckets (id, name, public)
values ('claim-receipts', 'claim-receipts', true)
on conflict (id) do nothing;
insert into storage.buckets (id, name, public)
values ('leave-attachments', 'leave-attachments', true)
on conflict (id) do nothing;

create policy "claim_receipts_read" on storage.objects for select
  using (bucket_id = 'claim-receipts');
create policy "claim_receipts_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'claim-receipts');

create policy "leave_attachments_read" on storage.objects for select
  using (bucket_id = 'leave-attachments');
create policy "leave_attachments_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'leave-attachments');

-- =============================================
-- Attendance GPS + selfie verification, branch geofencing
-- (added to production out-of-band; defined here so fresh databases match)
-- =============================================

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

-- =============================================
-- Shift Scheduling: shift_types + scheduled_shifts
-- =============================================

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

-- =============================================
-- Phase 2 migration: Resign status, shift break duration, staff avatars
-- Idempotent — safe to run on the existing database via the Supabase SQL editor.
--
-- NOTE: if the live database is missing tables/columns defined earlier in this
-- file (e.g. shift_types, scheduled_shifts, probation_reviews, staff columns),
-- run supabase/catchup-2026-07-02.sql instead — it contains everything the
-- current code needs, in one idempotent script.
-- =============================================

-- 1) Staff resignation status ------------------------------------------------
-- Resigned staff keep all historical data (salary, attendance, tasks, etc.);
-- they are only hidden from scheduling and blocked from logging in.
alter table staff add column if not exists status text not null default 'active'
  check (status in ('active','resigned'));

-- 2) Shift break as a DURATION (minutes) instead of fixed start/end times -----
alter table shift_types add column if not exists break_minutes int not null default 60;
-- (legacy break_start / break_end columns are kept but no longer used)

-- Global fallback break duration used when a staff has no scheduled shift today
insert into system_rules (key, value, label, description) values
  ('default_break_minutes', '60', 'Default break (minutes)', 'Break duration used when no shift is scheduled for the day')
on conflict (key) do nothing;

-- 3) Break clock tracking on attendance --------------------------------------
alter table attendance add column if not exists break_start           timestamptz; -- clocked out for break
alter table attendance add column if not exists break_end             timestamptz; -- clocked back in from break
alter table attendance add column if not exists break_minutes         int;         -- actual minutes taken
alter table attendance add column if not exists break_late            boolean not null default false;
alter table attendance add column if not exists break_overrun_minutes int not null default 0;

-- 4) Staff avatars storage bucket --------------------------------------------
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

-- =============================================
-- Phase 4 migration: Two-break attendance
-- Idempotent — safe to run on the existing database via the Supabase SQL editor.
-- =============================================

-- 1) Two independent break durations per shift ------------------------------
-- 0 means that break does not exist for the shift. The legacy single
-- break_minutes column is kept but no longer written by the app.
alter table shift_types add column if not exists break1_duration_minutes int not null default 0;
alter table shift_types add column if not exists break2_duration_minutes int not null default 0;

-- One-time migration of the old single break into break 1 (only where break 1
-- is still the default 0 and a legacy value exists).
update shift_types set break1_duration_minutes = break_minutes
  where break1_duration_minutes = 0 and coalesce(break_minutes, 0) > 0;

-- 2) Per-break clock records -------------------------------------------------
create table if not exists attendance_breaks (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null references attendance(id) on delete cascade,
  break_number int not null check (break_number in (1, 2)),
  clock_out_time timestamptz,          -- staff started the break
  clock_in_time  timestamptz,          -- staff ended the break
  duration_minutes int,                -- actual minutes taken
  overtime_minutes int not null default 0,
  is_overtime boolean not null default false,
  created_at timestamptz not null default now(),
  unique (attendance_id, break_number)
);

alter table attendance_breaks enable row level security;

-- Staff can read their own break rows; supervisors/managers read all.
drop policy if exists "attendance_breaks_select" on attendance_breaks;
create policy "attendance_breaks_select" on attendance_breaks for select to authenticated
  using (
    exists (
      select 1 from attendance a
      where a.id = attendance_id
        and (a.staff_id = auth.uid() or current_rank() in ('supervisor','manager'))
    )
  );

-- Staff can insert/update break rows for their own attendance day.
drop policy if exists "attendance_breaks_self_insert" on attendance_breaks;
create policy "attendance_breaks_self_insert" on attendance_breaks for insert to authenticated
  with check (
    exists (select 1 from attendance a where a.id = attendance_id and a.staff_id = auth.uid())
  );

drop policy if exists "attendance_breaks_self_update" on attendance_breaks;
create policy "attendance_breaks_self_update" on attendance_breaks for update to authenticated
  using (
    exists (select 1 from attendance a where a.id = attendance_id and a.staff_id = auth.uid())
  );

-- Supervisors/managers may manage all break rows.
drop policy if exists "attendance_breaks_manage" on attendance_breaks;
create policy "attendance_breaks_manage" on attendance_breaks for all to authenticated
  using (current_rank() in ('supervisor','manager'));

-- =============================================================================
-- Migration (2026-07-05): staff.email
-- The staff profile displayed the *viewer's* auth email instead of the profile
-- owner's (staff had no email column). Persist each staff member's email on
-- their row and backfill existing rows from auth.users. Idempotent.
-- Run in the Supabase SQL editor for project yfsoesxzurzjdwstszru.
-- =============================================================================
alter table staff add column if not exists email text;

-- Backfill existing staff rows with their real auth email (only where empty).
update staff s
   set email = u.email
  from auth.users u
 where u.id = s.id
   and (s.email is null or s.email = '');
