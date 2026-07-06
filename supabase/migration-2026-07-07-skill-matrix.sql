-- ============================================================================
-- Craft OS — Skill Matrix career system (2026-07-07)
-- Run this WHOLE file in the Supabase SQL editor (project yfsoesxzurzjdwstszru)
-- BEFORE deploying the matching frontend. Idempotent — safe to re-run.
--
-- Two parallel growth tracks:
--   • Skill Matrix (new)  — one-off skill sign-offs that gate PROMOTION
--   • Missions (existing) — repeatable behavioural tasks, XP/honour only
-- XP is shared: passing a skill awards XP via trigger, like mission approval.
-- ============================================================================

-- ── 1. Tables ────────────────────────────────────────────────────────────────

-- A promotion path segment, e.g. Trainee Barista → Junior Barista.
create table if not exists career_paths (
  id                uuid primary key default gen_random_uuid(),
  department_id     uuid references departments(id),
  from_job_title_id uuid not null references roles(id),
  to_job_title_id   uuid not null references roles(id),
  status            text not null default 'active' check (status in ('active','inactive')),
  created_at        timestamptz not null default now()
);

-- One active "next step" per job title keeps a staff member's current path
-- deterministic (progress = the single active path from their job title).
create unique index if not exists career_paths_one_active_from
  on career_paths (from_job_title_id) where status = 'active';

-- Skill library, per path segment.
create table if not exists skills (
  id             uuid primary key default gen_random_uuid(),
  career_path_id uuid not null references career_paths(id) on delete cascade,
  name           text not null,
  name_zh        text,
  description    text,
  xp_reward      int not null default 0,
  sort_order     int not null default 0,
  status         text not null default 'active' check (status in ('active','inactive')),
  created_at     timestamptz not null default now()
);

-- Per-staff assessment record for each skill.
create table if not exists skill_assessments (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid not null references staff(id) on delete cascade,
  skill_id    uuid not null references skills(id) on delete cascade,
  status      text not null default 'not_started'
    check (status in ('not_started','learning','pending_review','passed','failed')),
  assessed_by uuid references staff(id),
  assessed_at timestamptz,
  remarks     text,             -- required (by the app) when failing: reason + advice
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (staff_id, skill_id)
);

create index if not exists skill_assessments_staff_idx  on skill_assessments (staff_id);
create index if not exists skill_assessments_status_idx on skill_assessments (status);

-- Promotion evaluations (auto-created when all path skills pass).
create table if not exists promotion_requests (
  id             uuid primary key default gen_random_uuid(),
  staff_id       uuid not null references staff(id) on delete cascade,
  career_path_id uuid not null references career_paths(id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending','approved','deferred')),
  decided_by     uuid references staff(id),
  decided_at     timestamptz,
  defer_reason   text,          -- management-only; required (by the app) when deferring
  created_at     timestamptz not null default now()
);

-- One open request per staff+path.
create unique index if not exists promotion_requests_one_pending
  on promotion_requests (staff_id, career_path_id) where status = 'pending';

-- ── 2. RLS ───────────────────────────────────────────────────────────────────

alter table career_paths       enable row level security;
alter table skills             enable row level security;
alter table skill_assessments  enable row level security;
alter table promotion_requests enable row level security;

-- Library & paths: everyone (logged in) can read; manager+ can write.
drop policy if exists "career_paths_select" on career_paths;
create policy "career_paths_select" on career_paths for select to authenticated using (true);
drop policy if exists "career_paths_manage" on career_paths;
create policy "career_paths_manage" on career_paths for all
  using (current_rank() = 'manager');

drop policy if exists "skills_lib_select" on skills;
create policy "skills_lib_select" on skills for select to authenticated using (true);
drop policy if exists "skills_lib_manage" on skills;
create policy "skills_lib_manage" on skills for all
  using (current_rank() = 'manager');

-- Assessments: staff see their own; supervisors/managers see and update all
-- (branch/department scoping is applied in the app, like attendance).
drop policy if exists "sa_select" on skill_assessments;
create policy "sa_select" on skill_assessments for select
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
drop policy if exists "sa_update_own" on skill_assessments;
create policy "sa_update_own" on skill_assessments for update
  using (staff_id = auth.uid());                 -- app only allows not_started→learning→pending_review
drop policy if exists "sa_update_mgmt" on skill_assessments;
create policy "sa_update_mgmt" on skill_assessments for update
  using (current_rank() in ('supervisor','manager'));
drop policy if exists "sa_insert_mgmt" on skill_assessments;
create policy "sa_insert_mgmt" on skill_assessments for insert
  with check (current_rank() in ('supervisor','manager'));

-- Promotion requests: management only (defer reasons are not staff-visible;
-- staff see "eligible, awaiting review" computed from their own assessments).
drop policy if exists "pr_select" on promotion_requests;
create policy "pr_select" on promotion_requests for select
  using (current_rank() in ('supervisor','manager'));
drop policy if exists "pr_manage" on promotion_requests;
create policy "pr_manage" on promotion_requests for all
  using (current_rank() = 'manager');

-- ── 3. Triggers ──────────────────────────────────────────────────────────────

-- 3a. Award XP when a skill is passed (mirrors award_xp_on_approval).
create or replace function award_xp_on_skill_pass()
returns trigger language plpgsql security definer as $$
declare
  v_xp         int;
  v_old_level  int;
  v_new_level  int;
  v_current_xp int;
begin
  if (NEW.status = 'passed' and OLD.status is distinct from 'passed') then
    select xp_reward into v_xp from skills where id = NEW.skill_id;
    if coalesce(v_xp, 0) > 0 then
      select xp, level into v_current_xp, v_old_level from staff where id = NEW.staff_id;
      v_new_level := floor((v_current_xp + v_xp) / 500) + 1;
      update staff
        set xp               = v_current_xp + v_xp,
            level            = v_new_level,
            last_level_up_at = case when v_new_level > v_old_level then now() else last_level_up_at end
        where id = NEW.staff_id;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_award_xp_skill on skill_assessments;
create trigger trg_award_xp_skill
  after update on skill_assessments
  for each row execute function award_xp_on_skill_pass();

-- 3b. When the LAST active skill of a path passes, open a promotion request.
create or replace function open_promotion_request_when_complete()
returns trigger language plpgsql security definer as $$
declare
  v_path uuid;
begin
  if (NEW.status = 'passed' and OLD.status is distinct from 'passed') then
    select career_path_id into v_path from skills where id = NEW.skill_id;

    -- All active skills of this path passed for this staff member?
    if not exists (
      select 1 from skills s
      where s.career_path_id = v_path and s.status = 'active'
        and not exists (
          select 1 from skill_assessments sa
          where sa.skill_id = s.id and sa.staff_id = NEW.staff_id and sa.status = 'passed'
        )
    ) then
      insert into promotion_requests (staff_id, career_path_id)
      values (NEW.staff_id, v_path)
      on conflict do nothing;   -- respects the one-pending unique index
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_open_promotion on skill_assessments;
create trigger trg_open_promotion
  after update on skill_assessments
  for each row execute function open_promotion_request_when_complete();

-- ── 4. Initialization RPC ────────────────────────────────────────────────────
-- Creates not_started assessment rows for the staff member's current path.
-- Used by: registration approval, Add Staff, promotion (next segment), and the
-- one-off "Initialize All Staff Skills" button. Returns rows inserted.
create or replace function initialize_staff_skills(p_staff_id uuid)
returns int language plpgsql security definer as $$
declare
  v_title uuid;
  v_path  uuid;
  v_count int;
begin
  select job_title_id into v_title from staff where id = p_staff_id;
  if v_title is null then return -1; end if;   -- -1 = no job title assigned

  select id into v_path from career_paths
    where from_job_title_id = v_title and status = 'active';
  if v_path is null then return -2; end if;    -- -2 = no active path from this title

  insert into skill_assessments (staff_id, skill_id)
  select p_staff_id, s.id from skills s
    where s.career_path_id = v_path and s.status = 'active'
  on conflict (staff_id, skill_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function initialize_staff_skills(uuid) to authenticated;

-- ── 5. Seed: Trainee Barista → Junior Barista path with the 6 skill-type
--        items migrated out of missions ─────────────────────────────────────

insert into career_paths (department_id, from_job_title_id, to_job_title_id)
select d.id, rf.id, rt.id
from departments d, roles rf, roles rt
where d.slug = 'barista'
  and rf.name = 'Trainee Barista'
  and rt.name = 'Junior Barista'
  and not exists (
    select 1 from career_paths cp
    where cp.from_job_title_id = rf.id and cp.status = 'active'
  );

insert into skills (career_path_id, name, name_zh, description, xp_reward, sort_order)
select cp.id, v.name, v.name_zh, v.description, v.xp, v.ord
from career_paths cp
join roles rf on rf.id = cp.from_job_title_id and rf.name = 'Trainee Barista'
cross join (values
  ('Pull 50 espresso shots',                     '完成50杯意式浓缩萃取',        'Demonstrate consistent extraction across 50 shots.',            100, 1),
  ('Calibrate grinder 3 days in a row',          '连续3天校准磨豆机',           'Dial in the grinder each morning for 3 consecutive days.',       80, 2),
  ('Steam milk to perfect temperature 20 times', '20次奶泡温度达标(65–70°C)',   'Hit 65–70°C consistently.',                                       80, 3),
  ('Pour a rosetta latte art',                   '拉花:叶形(Rosetta)',          'Produce a recognisable rosetta on a flat white.',                120, 4),
  ('Pass coffee origins quiz',                   '咖啡产地知识测验(≥80%)',      'Score ≥80% on the coffee origins knowledge test.',               100, 5),
  ('Complete full menu knowledge test',          '全菜单知识测验(≥90%)',        'Score ≥90% on the full menu quiz.',                              100, 6)
) as v(name, name_zh, description, xp, ord)
where not exists (
  select 1 from skills s where s.career_path_id = cp.id and s.name = v.name
);

-- Remove the migrated skill-type items from missions (0 completions verified
-- on prod 2026-07-07, so nothing is lost). Behavioural missions remain.
delete from missions where title in (
  'Pull 50 espresso shots',
  'Calibrate grinder 3 days in a row',
  'Steam milk to perfect temperature 20 times',
  'Pour a rosetta latte art',
  'Pass coffee origins quiz',
  'Complete full menu knowledge test'
);
