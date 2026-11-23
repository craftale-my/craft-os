-- ============================================================================
-- Craft OS — Items in several departments; POs raised per department
-- (2026-10-29)
--
-- What this adds:
--   * items.departments text[]: every department that uses the item
--     (Cafe & Bar / Bakery / Kitchen). Shared items, e.g. fresh milk for the
--     bar and the bakery, list both. A supplier "serves" a department when any
--     of its items do; that is derived, never stored.
--   * items.department (single, 2026-10-26) stays and is kept in step by a
--     trigger, so an older app version that still writes it keeps working:
--     writing departments sets department to its first entry; writing only
--     department sets departments to just that one.
--   * purchase_orders.department: which department raised the order (the New
--     PO screen splits one department's basket into one PO per supplier).
--     Optional; internal and older POs leave it empty.
--
-- Additive and idempotent: safe to run more than once. Run after
-- migration-2026-10-28-inventory-review-fixes.sql (#12 in the PR #9 order).
-- ============================================================================

alter table items add column if not exists departments text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'items_departments_check' and conrelid = 'public.items'::regclass) then
    alter table items add constraint items_departments_check
      check (departments <@ array['cafe_bar', 'bakery', 'kitchen']::text[]);
  end if;
end $$;

create index if not exists items_departments_idx on items using gin (departments);

-- Backfill from the single column (only rows not yet converted).
update items
   set departments = array[department]
 where department is not null and departments = '{}';

create or replace function sync_item_departments()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.departments = '{}' and new.department is not null then
      new.departments := array[new.department];
    end if;
  elsif new.departments is distinct from old.departments then
    -- Remove duplicates, keep a stable order.
    new.departments := array(select distinct d from unnest(new.departments) d order by d);
  elsif new.department is distinct from old.department then
    new.departments := case when new.department is null then '{}' else array[new.department] end;
  end if;
  new.departments := array(select distinct d from unnest(new.departments) d order by d);
  new.department := new.departments[1];
  return new;
end;
$$;
revoke all on function sync_item_departments() from public, anon, authenticated;

drop trigger if exists items_sync_departments on items;
create trigger items_sync_departments
  before insert or update on items
  for each row execute function sync_item_departments();

alter table purchase_orders add column if not exists department text;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'purchase_orders_department_check'
                    and conrelid = 'public.purchase_orders'::regclass) then
    alter table purchase_orders add constraint purchase_orders_department_check
      check (department is null or department in ('cafe_bar', 'bakery', 'kitchen'));
  end if;
end $$;

-- == Verify ==================================================================
-- Expect 0: an item whose single department is not in its list.
select count(*) as out_of_step
  from items
 where department is distinct from departments[1];
