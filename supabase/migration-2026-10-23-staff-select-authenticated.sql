-- 2026-10-23 — close anonymous reads of staff, missions and skill_ratings
--
-- schema.sql created these three SELECT policies as `using (true)` with no
-- role, so they applied to `anon` as well: the publishable key shipped in the
-- public bundle was enough to read every staff row (IC numbers, phones,
-- addresses, dates of birth). Every screen that reads these tables sits behind
-- login (Login / Register / Forgot / Reset Password never touch them), so
-- limiting them to `authenticated` changes nothing for signed-in staff.
--
-- Idempotent: safe to re-run.

begin;

drop policy if exists "staff_select" on staff;
create policy "staff_select" on staff for select to authenticated using (true);

drop policy if exists "missions_select" on missions;
create policy "missions_select" on missions for select to authenticated using (true);

drop policy if exists "skills_select" on skill_ratings;
create policy "skills_select" on skill_ratings for select to authenticated using (true);

commit;

-- VERIFY (expect every row's roles = {authenticated}):
--   select tablename, policyname, roles, qual
--   from pg_policies
--   where policyname in ('staff_select', 'missions_select', 'skills_select');
--
-- Then, from outside, with only the publishable key (expect []):
--   curl -s "https://yfsoesxzurzjdwstszru.supabase.co/rest/v1/staff?select=id&limit=1" \
--     -H "apikey: $VITE_SUPABASE_ANON_KEY"
