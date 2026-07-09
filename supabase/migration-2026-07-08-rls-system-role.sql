-- ============================================================================
-- RLS: align management policies with system_role (2026-07-08)
-- Root cause: the UI gates on staff.system_role (RBAC), but management RLS
-- still checked staff.rank via current_rank(). Users promoted via Settings →
-- System Roles (rank=trainee, system_role=manager) saw every manager button
-- while the DB silently filtered their writes to 0 rows (no error).
-- Fix: every management predicate becomes rank-OR-system_role (a superset —
-- nobody loses access; promoted users gain what the UI already shows).
-- Also adds the missing mission_completions DELETE policy (Reset Progress
-- silently no-oped for everyone).
-- Idempotent — safe to re-run in the Supabase SQL editor.
-- ============================================================================

drop policy if exists "accrual_log_select" on leave_accrual_log;
create policy "accrual_log_select" on leave_accrual_log for select to authenticated
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "attendance_breaks_manage" on attendance_breaks;
create policy "attendance_breaks_manage" on attendance_breaks for all to authenticated
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "attendance_breaks_select" on attendance_breaks;
create policy "attendance_breaks_select" on attendance_breaks for select to authenticated
  using (
    exists (
      select 1 from attendance a
      where a.id = attendance_id
        and (a.staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')))
    )
  );

drop policy if exists "attendance_manage" on attendance;
create policy "attendance_manage" on attendance for all to authenticated
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "attendance_select_own" on attendance;
create policy "attendance_select_own" on attendance for select to authenticated
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "branches_manage" on branches;
create policy "branches_manage" on branches for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "career_paths_manage" on career_paths;
create policy "career_paths_manage" on career_paths for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "claims_manage" on claims;
create policy "claims_manage" on claims for all to authenticated
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "claims_select_own" on claims;
create policy "claims_select_own" on claims for select to authenticated
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "company_assets_manager_write" on storage.objects;
create policy "company_assets_manager_write" on storage.objects for all
  using (bucket_id = 'company-assets' and (current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "completions_select" on mission_completions;
create policy "completions_select" on mission_completions for select
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "completions_update" on mission_completions;
create policy "completions_update" on mission_completions for update
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "departments_manage" on departments;
create policy "departments_manage" on departments for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "employment_types_manage" on employment_types;
create policy "employment_types_manage" on employment_types for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "entitlements_manage" on leave_entitlements;
create policy "entitlements_manage" on leave_entitlements for all to authenticated
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "entitlements_select_own" on leave_entitlements;
create policy "entitlements_select_own" on leave_entitlements for select to authenticated
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "leave_manage" on leave_requests;
create policy "leave_manage" on leave_requests for all to authenticated
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "leave_select_own" on leave_requests;
create policy "leave_select_own" on leave_requests for select to authenticated
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "missions_delete" on missions;
create policy "missions_delete" on missions for delete
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "missions_insert" on missions;
create policy "missions_insert" on missions for insert
  with check ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "missions_update" on missions;
create policy "missions_update" on missions for update
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "notifications_manage" on notification_settings;
create policy "notifications_manage" on notification_settings for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "ph_manage" on ph_replacements;
create policy "ph_manage" on ph_replacements for all to authenticated
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "ph_select" on ph_replacements;
create policy "ph_select" on ph_replacements for select to authenticated
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "pr_manage" on promotion_requests;
create policy "pr_manage" on promotion_requests for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "pr_select" on promotion_requests;
create policy "pr_select" on promotion_requests for select
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "probation_insert" on probation_reviews;
create policy "probation_insert" on probation_reviews for insert
  with check ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "probation_select" on probation_reviews;
create policy "probation_select" on probation_reviews for select
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "probation_update" on probation_reviews;
create policy "probation_update" on probation_reviews for update
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "registration_requests_manage" on registration_requests;
create policy "registration_requests_manage" on registration_requests for all
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "reviews_insert" on monthly_reviews;
create policy "reviews_insert" on monthly_reviews for insert
  with check ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "reviews_select" on monthly_reviews;
create policy "reviews_select" on monthly_reviews for select
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "reviews_update_sup" on monthly_reviews;
create policy "reviews_update_sup" on monthly_reviews for update
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "roles_manage" on roles;
create policy "roles_manage" on roles for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "rules_manage" on system_rules;
create policy "rules_manage" on system_rules for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "sa_insert_mgmt" on skill_assessments;
create policy "sa_insert_mgmt" on skill_assessments for insert
  with check ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "sa_select" on skill_assessments;
create policy "sa_select" on skill_assessments for select
  using (staff_id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "sa_update_mgmt" on skill_assessments;
create policy "sa_update_mgmt" on skill_assessments for update
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "salary_manage" on salary_records;
create policy "salary_manage" on salary_records for all to authenticated
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "salary_select_own" on salary_records;
create policy "salary_select_own" on salary_records for select to authenticated
  using (staff_id = auth.uid() or (current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "scheduled_shifts_manage" on scheduled_shifts;
create policy "scheduled_shifts_manage" on scheduled_shifts for all
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "settings_manage" on company_settings;
create policy "settings_manage" on company_settings for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "shift_types_manage" on shift_types;
create policy "shift_types_manage" on shift_types for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "skills_insert" on skill_ratings;
create policy "skills_insert" on skill_ratings for insert
  with check ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "skills_lib_manage" on skills;
create policy "skills_lib_manage" on skills for all
  using ((current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "skills_update" on skill_ratings;
create policy "skills_update" on skill_ratings for update
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

drop policy if exists "staff_avatars_update" on storage.objects;
create policy "staff_avatars_update" on storage.objects for update to authenticated
  using (
    bucket_id = 'staff-avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or (current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')))
  )
  with check (
    bucket_id = 'staff-avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or (current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')))
  );

drop policy if exists "staff_avatars_write" on storage.objects;
create policy "staff_avatars_write" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'staff-avatars'
    and ((storage.foldername(name))[1] = auth.uid()::text or (current_rank() = 'manager' or current_system_role() in ('manager','hr','admin','owner')))
  );

drop policy if exists "staff_insert" on staff;
create policy "staff_insert" on staff for insert
  with check ((current_rank() in ('manager') or current_system_role() in ('manager','hr','admin','owner')));

drop policy if exists "staff_update" on staff;
create policy "staff_update" on staff for update
  using (id = auth.uid() or (current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

-- Missing DELETE policy: Reset Progress deletes mission_completions.
drop policy if exists "completions_delete" on mission_completions;
create policy "completions_delete" on mission_completions for delete
  using ((current_rank() in ('supervisor','manager') or current_system_role() in ('supervisor','manager','hr','admin','owner')));

-- Same rank-vs-system_role gap inside the accrual engine guard: a promoted
-- manager (rank=trainee, system_role=manager) hitting Settings → Recalculate
-- would get "not allowed". Guard now accepts rank OR system_role.
create or replace function process_leave_accruals()
returns void language plpgsql security definer as $$
declare
  v_rate  numeric;
  v_cap   numeric;
  v_carry numeric;
  v_rank  text;
  r       record;
  n       int;
  d       date;
  y_sum   numeric;
  amt     numeric;
  jan1    date;
  bal     numeric;
  used    numeric;
begin
  -- Callable by cron (no auth context) or supervisors/managers only.
  if auth.uid() is not null then
    select coalesce(
      (select rank in ('supervisor','manager')
              or system_role in ('supervisor','manager','hr','admin','owner')
       from staff where id = auth.uid()), false)::text into v_rank;
    if v_rank <> 'true' then
      raise exception 'process_leave_accruals: not allowed';
    end if;
  end if;

  select coalesce((select value::numeric from system_rules where key = 'leave_al_monthly_rate'),  0.667) into v_rate;
  select coalesce((select value::numeric from system_rules where key = 'leave_al_annual_cap'),    8)     into v_cap;
  select coalesce((select value::numeric from system_rules where key = 'leave_al_carryover_cap'), 4)     into v_carry;

  for r in
    select id, confirmation_date from staff
    where status = 'active' and is_active and confirmation_date is not null
  loop
    -- 1) Monthly accruals: anchor arithmetic avoids month-end drift
    n := 1;
    d := (r.confirmation_date + (n * interval '1 month'))::date;
    while d <= current_date loop
      if not exists (
        select 1 from leave_accrual_log
        where staff_id = r.id and entry_type = 'accrual' and period_month = d
      ) then
        select coalesce(sum(amount), 0) into y_sum from leave_accrual_log
        where staff_id = r.id and entry_type = 'accrual'
          and extract(year from period_month) = extract(year from d);
        amt := least(v_rate, greatest(0, v_cap - y_sum));
        if amt > 0 then
          insert into leave_accrual_log (staff_id, leave_type, entry_type, amount, period_month, note)
          values (r.id, 'annual', 'accrual', round(amt, 3), d, 'monthly accrual');
        end if;
      end if;
      n := n + 1;
      d := (r.confirmation_date + (n * interval '1 month'))::date;
    end loop;

    -- 2) Jan-1 carryover forfeit (once per year per staff)
    jan1 := date_trunc('year', current_date)::date;
    if not exists (
      select 1 from leave_accrual_log
      where staff_id = r.id and entry_type = 'forfeit' and period_month = jan1
    ) then
      select coalesce(sum(amount), 0) into bal from leave_accrual_log
      where staff_id = r.id and period_month < jan1;
      select coalesce(sum(total_days), 0) into used from leave_requests
      where staff_id = r.id and leave_type = 'annual' and status = 'approved'
        and start_date < jan1;
      bal := bal - used;
      if bal > v_carry then
        insert into leave_accrual_log (staff_id, leave_type, entry_type, amount, period_month, note)
        values (r.id, 'annual', 'forfeit', -(round(bal - v_carry, 3)), jan1,
                'forfeited ' || extract(year from jan1)::text || ' carryover');
      end if;
    end if;
  end loop;

  -- 3) Expire PH replacements
  update ph_replacements set status = 'expired'
  where status = 'available' and expires_at < current_date;
end;
$$;
