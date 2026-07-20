-- ============================================================================
-- Supervisor review scope: scoped to own branch + department + ranks below
-- (2026-07-10, v1)
-- Supervisors now can only review staff in the same branch, same department,
-- and with rank below supervisor (trainee/junior/senior). Managers unchanged
-- (can review all). Hire approval (day3_result='hire' or overall_result='hired')
-- restricted to manager tier by probation_update with check — supervisors can
-- only eliminate (probation_update write without hire result). Via new security
-- definer function can_review_staff(target uuid). Idempotent.
-- ============================================================================

create or replace function can_review_staff(target uuid)
returns boolean language sql security definer stable as $$
  select coalesce((
    select
      (me.rank = 'manager' or me.system_role in ('manager','admin','owner'))
      or (
        (me.rank = 'supervisor' or me.system_role = 'supervisor')
        and t.rank in ('trainee','junior','senior')
        and t.department is not null and t.department = me.department
        and (
          (me.branch_id is not null and t.branch_id is not null and me.branch_id = t.branch_id)
          or ((me.branch_id is null or t.branch_id is null) and me.branch is not null and me.branch = t.branch)
        )
      )
    from staff me, staff t
    where me.id = auth.uid() and t.id = target
  ), false)
$$;

drop policy if exists "reviews_select" on monthly_reviews;
create policy "reviews_select" on monthly_reviews for select
  using (staff_id = auth.uid() or can_review_staff(staff_id));

drop policy if exists "reviews_insert" on monthly_reviews;
create policy "reviews_insert" on monthly_reviews for insert
  with check (can_review_staff(staff_id));

drop policy if exists "reviews_update_sup" on monthly_reviews;
create policy "reviews_update_sup" on monthly_reviews for update
  using (can_review_staff(staff_id));

drop policy if exists "sa_select" on skill_assessments;
create policy "sa_select" on skill_assessments for select
  using (staff_id = auth.uid() or can_review_staff(staff_id));

drop policy if exists "sa_insert_mgmt" on skill_assessments;
create policy "sa_insert_mgmt" on skill_assessments for insert
  with check (can_review_staff(staff_id));

drop policy if exists "sa_update_mgmt" on skill_assessments;
create policy "sa_update_mgmt" on skill_assessments for update
  using (can_review_staff(staff_id));

drop policy if exists "probation_select" on probation_reviews;
create policy "probation_select" on probation_reviews for select
  using (staff_id = auth.uid() or can_review_staff(staff_id));

drop policy if exists "probation_insert" on probation_reviews;
create policy "probation_insert" on probation_reviews for insert
  with check (can_review_staff(staff_id));

drop policy if exists "probation_update" on probation_reviews;
create policy "probation_update" on probation_reviews for update
  using (can_review_staff(staff_id))
  with check (
    can_review_staff(staff_id)
    and (
      (day3_result is distinct from 'hire' and overall_result is distinct from 'hired')
      or current_rank() = 'manager' or current_system_role() in ('manager','admin','owner')
    )
  );

-- Data hygiene: backfill branch_id from branch text where possible
update staff s set branch_id = b.id from branches b
where s.branch_id is null and s.branch = b.name;
