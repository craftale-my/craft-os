-- ============================================================================
-- Craft OS — POS outlets (2026-10-29): outlet kinds, extra outlets, the POS login
-- capability, and the back office acting on a chosen outlet.
-- Run on craft-os-dev after migration-2026-10-26-pos-frontend.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-29-pos-outlets.md
-- Design: docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md (§1)
--
-- O1  branches.kind (branch | kiosk | popup), opens_on / closes_on (a pop-up's first and last
--     day), bill_prefix (1–4 of A–Z 0–9, unique). Only HQ (all_branches + access_settings)
--     sets them: save_outlet, and the trigger branches_outlet_guard for direct writes.
-- O2  staff_outlets: the outlets a staff member may work at besides their home branch.
--     set_staff_outlet adds or removes one; readable by every signed-in staff member.
-- O3  Capability pos_login ("Sign in to the POS"): on for every role except hr. has_menu_cap
--     and staff_has_cap are canonical here now, with the SQL defaults of all_branches and
--     pos_login added (they mirror DEFAULT_SYSTEM_ROLE_CAPS in src/shared/types/index.ts).
-- O4  pos_outlet_open, staff_outlet_scope, pos_staff_may_work, pos_manages_outlet, my_outlets.
-- O5  Approvers: anyone who may work at the outlet and holds pos_supervise (pos_approvers,
--     pos_check_approver); pos_outlet_approvers lists them for POS settings; clear_pos_pin
--     acts on staff who work at one of the caller's outlets.
-- O6  Bill numbers: pos_next_bill_no puts the outlet's prefix in front (PJ-261029-001).
-- O7  POS settings act on a chosen outlet in the caller's scope: save_receipt_settings,
--     save_shift_settings and save_branch_catalogs take p_branch_id first (the old
--     signatures are dropped), insert_test_print takes an optional p_branch_id (null = the
--     caller's home branch, as the POS sends it); the write policies of print_routes,
--     dining_tables, branch_catalogs, service_charge_rules, payment_methods and
--     reason_templates and dining_tables_guard use pos_manages_outlet.
-- Re-run hazards: re-running migration-2026-10-24-pos-catalogs.sql (has_menu_cap,
-- staff_has_cap, branch_catalogs_manage), migration-2026-10-24-pos-checkout-fixes.sql (the
-- three settings policies), migration-2026-10-23-pos-ordering.sql (print_routes and
-- dining_tables policies), migration-2026-10-24-pos-bill-actions-fn.sql (pos_approvers,
-- pos_check_approver, clear_pos_pin) or migration-2026-10-26-pos-frontend.sql
-- (dining_tables_guard) puts the older versions back — re-run this file afterwards.
-- Re-running catalogs-fn or shifts-fn re-creates an old one-argument settings function next to
-- the new one; it acts on the caller's home branch only and the app no longer calls it.
-- Re-running ordering-fn re-creates insert_test_print(text) next to insert_test_print(text, uuid):
-- the POS's call with p_route only then becomes ambiguous and fails — drop the old one
-- (drop function insert_test_print(text);) or re-run this file.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_set_bill_pax(uuid,integer)') is null or to_regprocedure('staff_has_cap(uuid,text)') is null then
    raise exception 'STOP: run migration-2026-10-26-pos-frontend.sql first (pos_set_bill_pax is missing)';
  end if;
end $$;

-- ── O3. Capabilities: pos_login, and all_branches in SQL ─────────────────────
-- The checkout-fixes / catalogs rule (live staff only; the Owner's setting in
-- system_role_permissions wins over the default) plus two capabilities. Mirrors
-- buildRoleCaps (src/shared/lib/lookups.tsx) over DEFAULT_SYSTEM_ROLE_CAPS — change the three together.
create or replace function has_menu_cap(p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        when 'manage_menu'     then s.system_role in ('owner','admin')
        when 'all_branches'    then s.system_role in ('owner','admin','hr','manager')                  -- O3
        when 'pos_login'       then s.system_role in ('owner','admin','manager','supervisor','staff')  -- O3
        else false
      end)
    from staff s
    where s.id = auth.uid() and s.is_active and s.status = 'active'
  ), false)
$$;

create or replace function staff_has_cap(p_staff_id uuid, p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        when 'manage_menu'     then s.system_role in ('owner','admin')
        when 'all_branches'    then s.system_role in ('owner','admin','hr','manager')                  -- O3
        when 'pos_login'       then s.system_role in ('owner','admin','manager','supervisor','staff')  -- O3
        else false
      end)
    from staff s
    where s.id = p_staff_id and s.is_active and s.status = 'active'
  ), false)
$$;
revoke all on function staff_has_cap(uuid, text) from public, anon, authenticated;

-- ── O1. Outlet columns on branches ──────────────────────────────────────────
alter table branches add column if not exists kind        text not null default 'branch';
alter table branches add column if not exists opens_on    date;
alter table branches add column if not exists closes_on   date;
alter table branches add column if not exists bill_prefix text;
alter table branches drop constraint if exists branches_kind_check;
alter table branches add constraint branches_kind_check check (kind in ('branch', 'kiosk', 'popup'));
alter table branches drop constraint if exists branches_outlet_dates_check;
alter table branches add constraint branches_outlet_dates_check check (
  case when kind = 'popup' then opens_on is not null and closes_on is not null and closes_on >= opens_on
       else opens_on is null and closes_on is null end);
alter table branches drop constraint if exists branches_bill_prefix_check;
alter table branches add constraint branches_bill_prefix_check check (bill_prefix is null or bill_prefix ~ '^[A-Z0-9]{1,4}$');
create unique index if not exists branches_bill_prefix_key on branches (bill_prefix) where bill_prefix is not null;

-- Direct writes (Settings → Branches) may not set an outlet's kind, dates or prefix unless
-- HQ makes them. No signed-in user (the SQL editor, the service role) passes.
create or replace function branches_outlet_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null and not (has_menu_cap('all_branches') and has_menu_cap('access_settings')) and (
       (tg_op = 'INSERT' and (new.kind <> 'branch' or new.opens_on is not null or new.closes_on is not null or new.bill_prefix is not null))
    or (tg_op = 'UPDATE' and (new.kind, new.opens_on, new.closes_on, new.bill_prefix)
                              is distinct from (old.kind, old.opens_on, old.closes_on, old.bill_prefix))) then
    raise exception 'Only HQ can change an outlet''s kind, dates or bill prefix';
  end if;
  return new;
end $$;
drop trigger if exists branches_outlet_guard on branches;
create trigger branches_outlet_guard before insert or update on branches
  for each row execute function branches_outlet_guard();

-- ── O2. Extra outlets ───────────────────────────────────────────────────────
create table if not exists staff_outlets (
  staff_id  uuid not null references staff(id) on delete cascade,
  branch_id uuid not null references branches(id) on delete cascade,
  added_by  uuid references staff(id) on delete set null,
  added_at  timestamptz not null default now(),
  primary key (staff_id, branch_id)
);
alter table staff_outlets enable row level security;
drop policy if exists staff_outlets_read on staff_outlets;
create policy staff_outlets_read on staff_outlets for select to authenticated using (true);
revoke all on staff_outlets from anon, authenticated;
grant select on staff_outlets to authenticated;

-- ── O4. Where an outlet is open, who may work where, whose back office covers what ──
-- Open for POS: active and, for a pop-up, today (Malaysia) between its first and last day.
create or replace function pos_outlet_open(p_branch_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(b.is_active, false)
           and (b.kind <> 'popup'
                or (now() at time zone 'Asia/Kuala_Lumpur')::date between b.opens_on and b.closes_on)
      from branches b where b.id = p_branch_id), false)
$$;
revoke all on function pos_outlet_open(uuid) from public, anon, authenticated;

-- The home branch, the extra outlets, or every outlet with all_branches. Live staff only.
create or replace function staff_outlet_scope(p_staff_id uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id from branches b where staff_has_cap(p_staff_id, 'all_branches')
  union
  select s.branch_id from staff s
   where s.id = p_staff_id and s.is_active and s.status = 'active' and s.branch_id is not null
  union
  select o.branch_id from staff_outlets o join staff s on s.id = o.staff_id
   where o.staff_id = p_staff_id and s.is_active and s.status = 'active'
$$;
revoke all on function staff_outlet_scope(uuid) from public, anon, authenticated;

create or replace function pos_staff_may_work(p_staff_id uuid, p_branch_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_branch_id is not null and staff_has_cap(p_staff_id, 'pos_login')
         and p_branch_id in (select staff_outlet_scope(p_staff_id))
$$;
revoke all on function pos_staff_may_work(uuid, uuid) from public, anon, authenticated;

-- The caller holds access_settings and the outlet is in their scope. Used by RLS policies.
create or replace function pos_manages_outlet(p_branch_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_branch_id is not null and has_menu_cap('access_settings')
         and p_branch_id in (select staff_outlet_scope(auth.uid()))
$$;
revoke all on function pos_manages_outlet(uuid) from public, anon;
grant execute on function pos_manages_outlet(uuid) to authenticated;

-- The caller's outlets for the back office: home branch first, then branches, kiosks, pop-ups.
create or replace function my_outlets()
returns table (id uuid, name text, kind text, opens_on date, closes_on date, bill_prefix text,
               is_active boolean, is_home boolean, open_now boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.name, b.kind, b.opens_on, b.closes_on, b.bill_prefix, coalesce(b.is_active, false),
         coalesce(b.id = (select s.branch_id from staff s where s.id = auth.uid()), false),
         pos_outlet_open(b.id)
    from branches b
   where b.id in (select staff_outlet_scope(auth.uid()))
   order by 8 desc, array_position(array['branch', 'kiosk', 'popup'], b.kind), b.name
$$;
revoke all on function my_outlets() from public, anon;
grant execute on function my_outlets() to authenticated;

-- ── O1. HQ adds or changes an outlet ────────────────────────────────────────
-- p_id null = a new outlet (active). Name, kind, a pop-up's dates and the bill prefix only;
-- everything else stays in POS settings and Settings → Branches.
create or replace function save_outlet(p_id uuid, p_name text, p_kind text, p_opens_on date, p_closes_on date,
                                       p_bill_prefix text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name   text := nullif(btrim(p_name), '');
  v_prefix text := nullif(upper(btrim(p_bill_prefix)), '');
  v_open   date := case when p_kind = 'popup' then p_opens_on end;
  v_close  date := case when p_kind = 'popup' then p_closes_on end;
  v_other  text;
  v_id     uuid;
begin
  if not (has_menu_cap('all_branches') and has_menu_cap('access_settings')) then
    raise exception 'Only HQ can add or change outlets';
  end if;
  if v_name is null then raise exception 'Enter the outlet name'; end if;
  if char_length(v_name) > 60 then raise exception 'The outlet name is longer than 60 characters'; end if;
  if p_kind is null or p_kind not in ('branch', 'kiosk', 'popup') then
    raise exception 'Choose Branch, Kiosk or Pop-up';
  end if;
  if p_kind = 'popup' and (v_open is null or v_close is null) then
    raise exception 'A pop-up needs its first and last day';
  end if;
  if v_close < v_open then raise exception 'The last day is before the first day'; end if;
  if v_prefix is not null and v_prefix !~ '^[A-Z0-9]{1,4}$' then
    raise exception 'The bill prefix is 1 to 4 letters or digits';
  end if;
  if exists (select 1 from branches b where lower(b.name) = lower(v_name) and b.id is distinct from p_id) then
    raise exception 'An outlet named % already exists', v_name;
  end if;
  select b.name into v_other from branches b where b.bill_prefix = v_prefix and b.id is distinct from p_id;
  if found then raise exception 'The bill prefix % is used by %', v_prefix, v_other; end if;
  begin
    if p_id is null then
      insert into branches(name, kind, opens_on, closes_on, bill_prefix, is_active)
      values (v_name, p_kind, v_open, v_close, v_prefix, true)
      returning id into v_id;
    else
      update branches
         set name = v_name, kind = p_kind, opens_on = v_open, closes_on = v_close, bill_prefix = v_prefix
       where id = p_id
      returning id into v_id;
      if v_id is null then raise exception 'Outlet not found'; end if;
    end if;
  exception when unique_violation then
    get stacked diagnostics v_other = constraint_name;
    if v_other = 'branches_bill_prefix_key' then
      raise exception 'The bill prefix % is used by another outlet', v_prefix;
    end if;
    raise;
  end;
  return v_id;
end $$;
revoke all on function save_outlet(uuid, text, text, date, date, text) from public, anon;
grant execute on function save_outlet(uuid, text, text, date, date, text) to authenticated;

-- ── O2. A manager adds or removes an extra outlet of a staff member ──────────
create or replace function set_staff_outlet(p_staff_id uuid, p_branch_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_home uuid;
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can change where staff may work'; end if;
  if p_on is null then raise exception 'Invalid request'; end if;
  if not pos_manages_outlet(p_branch_id) then raise exception 'This outlet is not one of yours'; end if;
  if p_on then
    select s.branch_id into v_home from staff s where s.id = p_staff_id and s.is_active and s.status = 'active';
    if not found then raise exception 'Staff member not found'; end if;
    if v_home = p_branch_id then raise exception 'This is their home branch already'; end if;
    insert into staff_outlets(staff_id, branch_id, added_by) values (p_staff_id, p_branch_id, auth.uid())
    on conflict (staff_id, branch_id) do nothing;
  else
    delete from staff_outlets where staff_id = p_staff_id and branch_id = p_branch_id;
  end if;
end $$;
revoke all on function set_staff_outlet(uuid, uuid, boolean) from public, anon;
grant execute on function set_staff_outlet(uuid, uuid, boolean) to authenticated;

-- ── O5. Approvers ───────────────────────────────────────────────────────────
-- Who may approve at the caller's outlet: may work there and holds pos_supervise.
create or replace function pos_approvers() returns table (staff_id uuid, name text, has_pin boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id, s.name, exists (select 1 from staff_pos_pins p where p.staff_id = s.id)
    from staff s
   where pos_staff_may_work(s.id, pos_my_branch()) and staff_has_cap(s.id, 'pos_supervise')   -- O5
   order by s.name
$$;
revoke all on function pos_approvers() from public, anon;
grant execute on function pos_approvers() to authenticated;

-- The same list for an outlet the caller manages (POS settings → Approvers).
create or replace function pos_outlet_approvers(p_branch_id uuid) returns table (staff_id uuid, name text, has_pin boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not pos_manages_outlet(p_branch_id) then raise exception 'This outlet is not one of yours'; end if;
  return query
    select s.id, s.name, exists (select 1 from staff_pos_pins p where p.staff_id = s.id)
      from staff s
     where pos_staff_may_work(s.id, p_branch_id) and staff_has_cap(s.id, 'pos_supervise')
     order by s.name;
end $$;
revoke all on function pos_outlet_approvers(uuid) from public, anon;
grant execute on function pos_outlet_approvers(uuid) to authenticated;

create or replace function pos_check_approver(p_branch_id uuid, p_approver_id uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_approver_id is null then raise exception 'Choose who approves'; end if;
  if not pos_staff_may_work(p_approver_id, p_branch_id) then                                  -- O5
    raise exception 'The approver cannot work at this outlet';
  end if;
  if not staff_has_cap(p_approver_id, 'pos_supervise') then
    raise exception 'This person cannot approve voids or refunds';
  end if;
  return pos_pin_attempt(p_approver_id, p_pin);
end $$;
revoke all on function pos_check_approver(uuid, uuid, text) from public, anon, authenticated;

create or replace function clear_pos_pin(p_staff_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can clear a PIN'; end if;
  if staff_has_cap(p_staff_id, 'all_branches') and not has_menu_cap('all_branches') then   -- O5: HQ's PIN, HQ only
    raise exception 'Only HQ can clear the PIN of HQ staff';
  end if;
  if not exists (select 1 from staff_outlet_scope(p_staff_id) t(id) where pos_manages_outlet(t.id)) then   -- O5
    raise exception 'This person does not work at your outlets';
  end if;
  delete from staff_pos_pins where staff_id = p_staff_id;
end $$;
revoke all on function clear_pos_pin(uuid) from public, anon;
grant execute on function clear_pos_pin(uuid) to authenticated;

-- ── O6. Bill numbers: [PREFIX-]YYMMDD-NNN per outlet per Malaysia day ───────
create or replace function pos_next_bill_no(p_branch_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_day    date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_prefix text := (select b.bill_prefix || '-' from branches b where b.id = p_branch_id);   -- O6
  v_n      integer;
begin
  insert into bill_counters(branch_id, day, next_no) values (p_branch_id, v_day, 2)
  on conflict (branch_id, day) do update set next_no = bill_counters.next_no + 1
  returning next_no - 1 into v_n;
  return coalesce(v_prefix, '') || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, greatest(3, length(v_n::text)), '0');
end $$;
revoke all on function pos_next_bill_no(uuid) from public, anon, authenticated;

-- ── O7. POS settings act on a chosen outlet ─────────────────────────────────
drop function if exists save_receipt_settings(jsonb);
drop function if exists save_shift_settings(integer);
drop function if exists save_branch_catalogs(jsonb);
drop function if exists insert_test_print(text);

-- Same as migration-2026-10-24-pos-checkout-fn.sql except the outlet: p_branch_id, in scope.
create or replace function save_receipt_settings(p_branch_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := p_branch_id;                                                              -- O7
  v_route  text;
  v_round  text;
  v_footer constant text := 'This is an official receipt. Thank you for visiting us.';
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the receipt settings';
  end if;
  if not pos_manages_outlet(v_branch) then raise exception 'This outlet is not one of yours'; end if;   -- O7
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid settings'; end if;
  if nullif(trim(p->>'receiptTitle'), '') is null then raise exception 'Enter the receipt title'; end if;
  v_route := nullif(trim(p->>'receiptRoute'), '');
  v_round := coalesce(p->>'cashRounding', 'nearest_5_sen');
  if v_round not in ('none', 'nearest_5_sen') then raise exception 'Invalid rounding setting'; end if;
  if v_route is not null and not exists (select 1 from print_routes where branch_id = v_branch and name = v_route) then
    raise exception 'No printer is set for route %', v_route;
  end if;
  -- a key that is absent leaves its column as it is (branches.address is shown all over Craft OS)
  update branches
     set receipt_title   = trim(p->>'receiptTitle'),
         legal_name      = case when p ? 'legalName'      then nullif(trim(p->>'legalName'), '')      else legal_name end,
         registration_no = case when p ? 'registrationNo' then nullif(trim(p->>'registrationNo'), '') else registration_no end,
         sst_no          = case when p ? 'sstNo'          then nullif(trim(p->>'sstNo'), '')          else sst_no end,
         address         = case when p ? 'address'        then nullif(trim(p->>'address'), '')        else address end,
         phone           = case when p ? 'phone'          then nullif(trim(p->>'phone'), '')          else phone end,
         email           = case when p ? 'email'          then nullif(trim(p->>'email'), '')          else email end
   where id = v_branch;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set sst_registered        = case when p ? 'sstRegistered' then coalesce((p->>'sstRegistered')::boolean, sst_registered) else sst_registered end,
         cash_rounding         = case when p ? 'cashRounding' then v_round else cash_rounding end,
         receipt_route         = case when p ? 'receiptRoute' then v_route else receipt_route end,
         receipt_footer        = case when p ? 'footer' then coalesce(nullif(trim(left(p->>'footer', 300)), ''), v_footer) else receipt_footer end,
         qr_requires_open_bill = case when p ? 'qrRequiresOpenBill' then coalesce((p->>'qrRequiresOpenBill')::boolean, qr_requires_open_bill) else qr_requires_open_bill end,
         updated_at            = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_receipt_settings(uuid, jsonb) from public, anon;
grant execute on function save_receipt_settings(uuid, jsonb) to authenticated;

-- Same as migration-2026-10-24-pos-shifts-fn.sql except the outlet.
create or replace function save_shift_settings(p_branch_id uuid, p_cash_variance_limit_sen integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := p_branch_id;                                                              -- O7
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can change the shift settings'; end if;
  if not pos_manages_outlet(v_branch) then raise exception 'This outlet is not one of yours'; end if;   -- O7
  if p_cash_variance_limit_sen is null or p_cash_variance_limit_sen < 0 or p_cash_variance_limit_sen > 1000000 then
    raise exception 'Enter a cash variance limit between RM 0.00 and RM 10000.00';
  end if;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set cash_variance_limit_sen = p_cash_variance_limit_sen, updated_at = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_shift_settings(uuid, integer) from public, anon;
grant execute on function save_shift_settings(uuid, integer) to authenticated;

-- Same as migration-2026-10-24-pos-catalogs-fn.sql except the outlet.
create or replace function save_branch_catalogs(p_branch_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := p_branch_id;                                                              -- O7
  v_uuid   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_role   record;
  v_add    uuid[];
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the menu catalogs';
  end if;
  if not pos_manages_outlet(v_branch) then raise exception 'This outlet is not one of yours'; end if;   -- O7
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(coalesce(p->'additional', '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid catalog settings';
  end if;
  for v_role in select * from (values ('dineIn', 'dine-in'), ('takeaway', 'takeaway'), ('qr', 'QR')) as x(key, label) loop
    if jsonb_typeof(p->v_role.key) is distinct from 'string' then
      raise exception 'Choose the % catalog', v_role.label;
    end if;
    if (p->>v_role.key) !~* v_uuid then raise exception 'Invalid catalog settings'; end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p->'additional', '[]'::jsonb)) e
              where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* v_uuid) then
    raise exception 'Invalid catalog settings';
  end if;
  select coalesce(array_agg(distinct x.v::uuid), '{}') into v_add
    from jsonb_array_elements_text(coalesce(p->'additional', '[]'::jsonb)) as x(v);
  if exists (select 1 from unnest(array[(p->>'dineIn')::uuid, (p->>'takeaway')::uuid, (p->>'qr')::uuid] || v_add) as c(id)
              where not exists (select 1 from menu_catalogs m where m.id = c.id and m.is_active)) then
    raise exception 'This catalog is not available — refresh and try again';
  end if;
  delete from branch_catalogs where branch_id = v_branch;
  insert into branch_catalogs(branch_id, role, catalog_id)
  select v_branch, r.role, r.id
    from (values ('dine_in', (p->>'dineIn')::uuid), ('takeaway', (p->>'takeaway')::uuid), ('qr', (p->>'qr')::uuid)) as r(role, id)
  union all
  select v_branch, 'additional', a.id from unnest(v_add) as a(id);
end $$;
revoke all on function save_branch_catalogs(uuid, jsonb) from public, anon;
grant execute on function save_branch_catalogs(uuid, jsonb) to authenticated;

-- Same as migration-2026-10-23-pos-ordering-fn.sql except the outlet: null = the caller's
-- home branch (the POS print host), otherwise an outlet the caller manages (POS settings).
create or replace function insert_test_print(p_route text, p_branch_id uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_branch_id is null then                                                                -- O7
    select branch_id into v_branch from staff where id = auth.uid() and is_active and status = 'active';
    if v_branch is null then raise exception 'Your account has no branch'; end if;
  elsif pos_manages_outlet(p_branch_id) then
    v_branch := p_branch_id;
  else
    raise exception 'This outlet is not one of yours';
  end if;
  if not exists (select 1 from print_routes where branch_id = v_branch and name = p_route) then
    raise exception 'No printer is set for route %', p_route;
  end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (v_branch, p_route, 'ticket', jsonb_build_object(
    'kind', 'ticket', 'route', p_route, 'tableLabel', 'TEST', 'orderNo', 'TEST01', 'source', 'test',
    'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lines', jsonb_build_array(jsonb_build_object('qty', 1, 'name', 'Test print — ' || p_route, 'note', null, 'mods', '[]'::jsonb))))
  returning id into v_id;
  return v_id;
end $$;
revoke all on function insert_test_print(text, uuid) from public, anon;
grant execute on function insert_test_print(text, uuid) to authenticated;

-- The settings tables: a manager writes the outlets in their scope.
drop policy if exists print_routes_manage on print_routes;
create policy print_routes_manage on print_routes for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));
drop policy if exists dining_tables_insert on dining_tables;
create policy dining_tables_insert on dining_tables for insert to authenticated with check (pos_manages_outlet(branch_id));
drop policy if exists dining_tables_delete on dining_tables;
create policy dining_tables_delete on dining_tables for delete to authenticated using (pos_manages_outlet(branch_id));
drop policy if exists branch_catalogs_manage on branch_catalogs;
create policy branch_catalogs_manage on branch_catalogs for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));
drop policy if exists service_charge_rules_manage on service_charge_rules;
create policy service_charge_rules_manage on service_charge_rules for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));
drop policy if exists payment_methods_manage on payment_methods;
create policy payment_methods_manage on payment_methods for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));
drop policy if exists reason_templates_manage on reason_templates;
create policy reason_templates_manage on reason_templates for all to authenticated
  using (pos_manages_outlet(branch_id)) with check (pos_manages_outlet(branch_id));

-- Same as migration-2026-10-26-pos-frontend.sql except who passes: a manager of both the
-- table's old and new outlet.
create or replace function dining_tables_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (new.qr_token, new.branch_id, new.is_active, new.sort_order, new.area)
     is distinct from (old.qr_token, old.branch_id, old.is_active, old.sort_order, old.area)
     and not (pos_manages_outlet(old.branch_id) and pos_manages_outlet(new.branch_id)) then   -- O7
    raise exception 'Only a manager can change this table''s QR code, branch or status';
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
select 'pos outlets applied' as result;
