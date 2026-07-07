-- ============================================================================
-- Leave accrual rework (2026-07-08) — run BY HAND in the Supabase SQL editor.
-- PART 1 (schema) first; verify; then PART 2 (engine + cron).
-- Both parts are idempotent — safe to re-run.
-- Prereq for PART 2: Dashboard → Database → Extensions → enable pg_cron.
-- ============================================================================

-- ───────────────────────────── PART 1: SCHEMA ─────────────────────────────

-- 1) Confirmation date (accrual anchor) + backfill from probation hires
alter table staff add column if not exists confirmation_date date;

update staff s set confirmation_date = sub.d
from (
  select staff_id, min(day3_completed_at)::date as d
  from probation_reviews
  where overall_result = 'hired'
  group by staff_id
) sub
where s.id = sub.staff_id and s.confirmation_date is null;

-- 2) AL ledger — the single source of truth for accrued annual leave
create table if not exists leave_accrual_log (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  leave_type text not null default 'annual' check (leave_type = 'annual'),
  entry_type text not null default 'accrual'
    check (entry_type in ('accrual','forfeit','adjustment')),
  amount numeric not null,
  period_month date,              -- accrual: covered month-anniversary; forfeit: Jan 1
  accrued_at timestamptz not null default now(),
  note text,
  unique (staff_id, entry_type, period_month)
);

alter table leave_accrual_log enable row level security;

drop policy if exists "accrual_log_select" on leave_accrual_log;
create policy "accrual_log_select" on leave_accrual_log for select to authenticated
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));
-- No insert/update/delete policies: clients cannot write; only the
-- security-definer function below writes.

-- 3) PH Replacement credits
create table if not exists ph_replacements (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  granted_by uuid references staff(id),
  granted_at timestamptz not null default now(),
  expires_at date not null,
  reason text,                    -- which public holiday (name/date)
  status text not null default 'available'
    check (status in ('available','used','expired')),
  used_in_leave_request_id uuid references leave_requests(id),
  created_at timestamptz not null default now()
);

alter table ph_replacements enable row level security;

drop policy if exists "ph_select" on ph_replacements;
create policy "ph_select" on ph_replacements for select to authenticated
  using (staff_id = auth.uid() or current_rank() in ('supervisor','manager'));

drop policy if exists "ph_manage" on ph_replacements;
create policy "ph_manage" on ph_replacements for all to authenticated
  using (current_rank() in ('supervisor','manager'));

-- 4) Leave settings (edited in Settings → Leave Settings)
insert into system_rules (key, value, label, description) values
  ('leave_al_monthly_rate',  '0.667', 'AL monthly accrual (days)',   'Annual leave accrued per completed month since confirmation date'),
  ('leave_al_annual_cap',    '8',     'AL yearly accrual cap (days)','Maximum annual leave accrued within one calendar year'),
  ('leave_al_carryover_cap', '4',     'AL carryover cap (days)',     'Balance above this is forfeited every 1 January'),
  ('leave_ph_expiry_months', '3',     'PH replacement validity (months)', 'Months before a granted PH replacement day expires'),
  ('leave_medical_annual',   '14',    'Medical leave per year (days)',    'Yearly medical leave entitlement for new entitlement rows')
on conflict (key) do nothing;

-- ─────────────────────── PART 2: ENGINE + SCHEDULE ───────────────────────

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
    select rank into v_rank from staff where id = auth.uid();
    if v_rank is null or v_rank not in ('supervisor','manager') then
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

grant execute on function process_leave_accruals() to authenticated;

-- Daily at 20:00 UTC (= 04:00 MYT). Re-running replaces the same-named job.
select cron.schedule('leave-daily', '0 20 * * *', $$select process_leave_accruals()$$);
