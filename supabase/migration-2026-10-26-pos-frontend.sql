-- ============================================================================
-- Craft OS — POS Feedme-layout front end (2026-10-26): data additions.
-- Run on craft-os-dev after migration-2026-10-25-pos-hardening.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-26-pos-feedme-frontend.md
-- Design: docs/superpowers/specs/2026-10-26-pos-feedme-frontend-design.md (§6)
--
-- F1  dining_tables.area: the floor area of a table, for the home screen's area tabs
--     (null = none), trimmed, 1–40 characters. A manager's change, like the table order:
--     dining_tables_guard is re-created from migration-2026-10-23-pos-ordering.sql with
--     area added to the guarded columns (its message is unchanged).
-- F2  pos_open_bill_summaries(p_branch_id): every open bill of the caller's own branch with
--     its total from pos_bill_totals (the numbers checkout uses) and its live item count.
-- F3  pos_set_bill_pax(p_bill_id, p_pax): the guests of an open dine-in bill. open_table and
--     pos_insert_order only fill pax while it is empty; this changes it (Bill actions → Pax).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_bill_totals(uuid)') is null or to_regprocedure('pos_my_branch()') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'bills' and column_name = 'updated_at') then
    raise exception 'STOP: run migration-2026-10-25-pos-hardening.sql first (pos_bill_totals or bills.updated_at is missing)';
  end if;
end $$;

-- ── F1. Table areas ─────────────────────────────────────────────────────────
alter table dining_tables add column if not exists area text;
alter table dining_tables drop constraint if exists dining_tables_area_check;
alter table dining_tables add constraint dining_tables_area_check
  check (area is null or (area = btrim(area) and char_length(area) between 1 and 40));

create or replace function dining_tables_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (new.qr_token, new.branch_id, new.is_active, new.sort_order, new.area)                      -- F1: area
     is distinct from (old.qr_token, old.branch_id, old.is_active, old.sort_order, old.area)
     and not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change this table''s QR code, branch or status';
  end if;
  return new;
end $$;

-- ── F2. Open bills with their totals, for the home screen's tiles ───────────
create or replace function pos_open_bill_summaries(p_branch_id uuid)
returns table (bill_id uuid, total_sen integer, item_count integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_branch_id is distinct from pos_my_branch() then
    raise exception 'Not your branch';
  end if;
  return query
    select b.id,
           (pos_bill_totals(b.id)->>'totalSen')::integer,
           coalesce((select sum(oi.qty) from order_items oi
                      where oi.bill_id = b.id and oi.voided_at is null), 0)::integer
      from bills b
     where b.branch_id = p_branch_id and b.status = 'open'
     order by b.opened_at, b.id;
end $$;
revoke all on function pos_open_bill_summaries(uuid) from public, anon;
grant execute on function pos_open_bill_summaries(uuid) to authenticated;

-- ── F3. Change the guests of an open dine-in bill ───────────────────────────
-- updated_at moves, so the other iPads get a bills event and refresh.
create or replace function pos_set_bill_pax(p_bill_id uuid, p_pax integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  if p_pax is null or p_pax < 1 or p_pax > 99 then raise exception 'Invalid number of guests'; end if;
  update bills set pax = p_pax, updated_at = now()
   where id = p_bill_id and branch_id = v_branch and status = 'open' and order_type = 'dine_in';
  if not found then raise exception 'Bill not found'; end if;
end $$;
revoke all on function pos_set_bill_pax(uuid, integer) from public, anon;
grant execute on function pos_set_bill_pax(uuid, integer) to authenticated;

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'pos front end data additions applied' as result;
