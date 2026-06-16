-- =============================================
-- Craft OS — Supabase Schema
-- Run this in your Supabase SQL Editor
-- =============================================

-- Staff profiles
create table if not exists staff (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
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
create policy "staff_update" on staff for update
  using (id = auth.uid() or current_rank() in ('manager'));

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
