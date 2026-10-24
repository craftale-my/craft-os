-- ============================================================================
-- Craft OS — POS Sub-plan 4a schema: shifts, Pay in / Pay out, the Z report (2026-10-24).
-- Run on craft-os-dev after every earlier POS migration (the checkout fixes and the
-- menu catalogs M1–M3 included). Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-shifts.md
-- Design: docs/superpowers/specs/2026-10-24-pos-shifts-design.md
--
-- One shift per branch at a time (several iPads share one cash drawer). Every money
-- row (payment, refund, pay in / pay out) is stamped with the shift that was open
-- when it was written, by the server (checkout_bill, refund_bill, record_cash_move);
-- so is a paid bill (checkout_bill): a bill of RM 0.00 has no payment rows and still
-- belongs to its shift.
-- Old dev rows keep shift_id null and appear in no report.
-- pos_shifts and pos_cash_moves have RLS on and no policy at all: they are read
-- and written only through the functions in migration-2026-10-24-pos-shifts-fn.sql
-- (the top bar never sees the expected cash before the blind count).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_refundable_methods(uuid)') is null or to_regprocedure('pos_caller_branch()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-checkout-fixes.sql first (pos_refundable_methods is missing)';
  end if;
  if to_regclass('public.branch_catalogs') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs.sql first (branch_catalogs is missing)';
  end if;
end $$;

-- ── Shifts: opened with a float, closed with a blind count ──────────────────
create table if not exists pos_shifts (
  id                    uuid primary key default gen_random_uuid(),
  branch_id             uuid not null references branches(id),
  opened_by             uuid not null references staff(id),
  opened_at             timestamptz not null default now(),
  opening_float_sen     integer not null check (opening_float_sen between 0 and 10000000),
  status                text not null default 'open' check (status in ('open', 'closed')),
  first_count_sen       integer check (first_count_sen between 0 and 10000000),     -- the first blind count, kept
  first_variance_sen    integer,                                                     -- the first count − the expected cash then
  counted_cash_sen      integer check (counted_cash_sen between 0 and 10000000),    -- the count the shift closed with
  expected_cash_sen     integer,
  variance_sen          integer,                                                     -- counted − expected
  variance_reason       text,                                                        -- only when |variance| > the limit
  variance_approved_by  uuid references staff(id),
  closed_by             uuid references staff(id),
  closed_at             timestamptz,
  report                jsonb,                                                       -- the frozen Z report, written once
  report_printed        boolean,                                                     -- was it queued at close
  constraint pos_shifts_closed_complete check (
    status = 'open' or (closed_at is not null and closed_by is not null and counted_cash_sen is not null
                        and expected_cash_sen is not null and variance_sen is not null))
);
create unique index if not exists pos_shifts_one_open on pos_shifts(branch_id) where status = 'open';
create index if not exists pos_shifts_branch_closed_idx on pos_shifts(branch_id, closed_at desc) where status = 'closed';

-- A closed shift never changes. The one write allowed after the close is the frozen
-- report itself (close_shift writes it once, right after closing). Nothing is deleted.
create or replace function pos_shifts_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A shift is never deleted';
  end if;
  if old.status = 'closed'
     and not (old.report is null and new.report is not null
              and (to_jsonb(new) - 'report' - 'report_printed') = (to_jsonb(old) - 'report' - 'report_printed')) then
    raise exception 'A closed shift never changes';
  end if;
  return new;
end $$;
drop trigger if exists pos_shifts_guard on pos_shifts;
create trigger pos_shifts_guard before update or delete on pos_shifts
  for each row execute function pos_shifts_guard();

-- ── Pay in / Pay out: cash put into or taken out of the drawer ──────────────
create table if not exists pos_cash_moves (
  id           uuid primary key,                                        -- client-generated: a resend is safe
  shift_id     uuid not null references pos_shifts(id),
  branch_id    uuid not null references branches(id),
  kind         text not null check (kind in ('pay_in', 'pay_out')),
  amount_sen   integer not null check (amount_sen between 1 and 10000000),
  reason       text not null check (length(trim(reason)) between 1 and 200),
  created_by   uuid not null references staff(id),
  approved_by  uuid references staff(id),                               -- pay out only
  created_at   timestamptz not null default now(),
  constraint pos_cash_moves_approval check ((kind = 'pay_out') = (approved_by is not null))
);
create index if not exists pos_cash_moves_shift_idx on pos_cash_moves(shift_id, created_at);

-- ── The shift stamp on every money row and paid bill; the refund's kind; the variance limit ─
alter table bills add column if not exists shift_id uuid;                -- the shift it was checked out in
alter table payments add column if not exists shift_id uuid;
alter table refunds add column if not exists shift_id uuid;
alter table refunds add column if not exists kind text;                -- snapshot of the payment's kind: cash refunds leave the drawer
alter table branch_pos_settings add column if not exists cash_variance_limit_sen integer not null default 500;
-- the first count's variance, stored with it: "the first count was above the limit" is judged
-- against the expected cash at that moment, not the expected cash at the final count (a pay in
-- recorded after seeing the figure must not let the close skip the approval)
alter table pos_shifts add column if not exists first_variance_sen integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bills_shift_id_fkey') then
    alter table bills add constraint bills_shift_id_fkey foreign key (shift_id) references pos_shifts(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'payments_shift_id_fkey') then
    alter table payments add constraint payments_shift_id_fkey foreign key (shift_id) references pos_shifts(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'refunds_shift_id_fkey') then
    alter table refunds add constraint refunds_shift_id_fkey foreign key (shift_id) references pos_shifts(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'refunds_kind_check') then
    alter table refunds add constraint refunds_kind_check
      check (kind is null or kind in ('cash', 'card', 'duitnow', 'ewallet', 'other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'branch_pos_settings_cash_variance_limit_sen_check') then
    alter table branch_pos_settings add constraint branch_pos_settings_cash_variance_limit_sen_check
      check (cash_variance_limit_sen between 0 and 1000000);
  end if;
end $$;
create index if not exists bills_shift_idx on bills(shift_id) where shift_id is not null;
create index if not exists payments_shift_idx on payments(shift_id) where shift_id is not null;
create index if not exists refunds_shift_idx on refunds(shift_id) where shift_id is not null;

-- ── RLS: on, no policy, no table privilege — functions only ─────────────────
alter table pos_shifts enable row level security;
alter table pos_cash_moves enable row level security;
revoke all on pos_shifts, pos_cash_moves from public, anon, authenticated;

-- PostgREST picks up the new tables and columns now, not at its next poll
notify pgrst, 'reload schema';

select 'shifts schema applied' as result;
