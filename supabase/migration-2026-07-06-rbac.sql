-- ============================================================================
-- Craft OS — Dynamic lookups + System-role separation (2026-07-06)
-- Run this WHOLE file in the Supabase SQL editor (project yfsoesxzurzjdwstszru)
-- BEFORE deploying the matching frontend. Idempotent — safe to re-run.
--
-- Built up across parts:
--   Part 1: departments
--   Part 2: employment_types            (added later)
--   Part 3: staff.system_role / job_title_id / branch_id + functions + seeds
-- ============================================================================

-- ── Part 1: Departments ─────────────────────────────────────────────────────
-- `slug` is the canonical value stored on staff.department (kept backward
-- compatible with existing lowercase keys); `name` is the display label.
create table if not exists departments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  status     text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);

-- Seed with the slugs already stored on existing staff rows so nothing breaks.
insert into departments (name, slug) values
  ('Barista (Full Time)', 'barista'),
  ('Service Crew',        'service crew'),
  ('Bakery',              'bakery'),
  ('Kitchen',             'kitchen'),
  ('Other',               'other')
on conflict (slug) do nothing;

alter table departments enable row level security;

-- Public read (the registration page is unauthenticated and needs the list).
drop policy if exists "departments_select" on departments;
create policy "departments_select" on departments for select
  to anon, authenticated using (true);

-- Manager+ can manage.
drop policy if exists "departments_manage" on departments;
create policy "departments_manage" on departments for all
  using (current_rank() = 'manager');

-- ── Part 2: Employment types ────────────────────────────────────────────────
-- staff.employment_type stores the display string, so `name` is the stored value.
create table if not exists employment_types (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  status     text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now()
);

insert into employment_types (name) values
  ('Full Time / Contract'),
  ('Part Time')
on conflict (name) do nothing;

alter table employment_types enable row level security;

drop policy if exists "employment_types_select" on employment_types;
create policy "employment_types_select" on employment_types for select
  to anon, authenticated using (true);

drop policy if exists "employment_types_manage" on employment_types;
create policy "employment_types_manage" on employment_types for all
  using (current_rank() = 'manager');

-- ── Part 3: System roles, job titles, branch scoping ────────────────────────
-- Access control (owner/admin/hr/manager/supervisor/staff) is SEPARATE from
-- `rank` (kept for the XP system) and from job title (display headline).

alter table staff add column if not exists system_role text not null default 'staff'
  check (system_role in ('owner','admin','hr','manager','supervisor','staff'));
alter table staff add column if not exists job_title_id uuid references roles(id);
alter table staff add column if not exists branch_id    uuid references branches(id);

-- Seed system_role from existing rank (does not clobber owner/admin/hr set later).
update staff set system_role = case rank
    when 'manager'    then 'manager'
    when 'supervisor' then 'supervisor'
    else 'staff'
  end
  where system_role not in ('owner','admin','hr');

-- The business owner.
update staff set system_role = 'owner'
  where id = '5b04891e-7d5f-4bb6-ae89-c1ae21524790';

-- Backfill branch_id by matching the free-text branch onto a branches row.
update staff s set branch_id = b.id
  from branches b
  where s.branch_id is null and s.branch is not null and s.branch ilike '%' || b.name || '%';

-- Helper functions (mirror current_rank()).
create or replace function current_system_role() returns text language sql security definer stable as $$
  select system_role from staff where id = auth.uid()
$$;
create or replace function current_is_owner() returns boolean language sql security definer stable as $$
  select coalesce((select system_role = 'owner' from staff where id = auth.uid()), false)
$$;

-- Per-system-role capability overrides (Owner edits these in Settings → System
-- Roles). The app merges these over its built-in defaults; a missing row/key
-- falls back to the code default.
create table if not exists system_role_permissions (
  system_role text primary key
    check (system_role in ('owner','admin','hr','manager','supervisor','staff')),
  permissions jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);

alter table system_role_permissions enable row level security;
drop policy if exists "srp_select" on system_role_permissions;
create policy "srp_select" on system_role_permissions for select to authenticated using (true);
drop policy if exists "srp_manage" on system_role_permissions;
create policy "srp_manage" on system_role_permissions for all
  using (current_is_owner());

-- Seed empty rows so the matrix screen has something to toggle (defaults live in code).
insert into system_role_permissions (system_role, permissions) values
  ('owner','{}'),('admin','{}'),('hr','{}'),('manager','{}'),('supervisor','{}'),('staff','{}')
on conflict (system_role) do nothing;
