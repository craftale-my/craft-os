-- ============================================================================
-- Craft OS — Procurement: item department (2026-10-26)
--
-- Adds an optional `department` to items so stock can be filtered by the
-- part of the business that uses it (Cafe & Bar / Bakery / Kitchen).
--
-- Additive and idempotent: safe to run more than once. Nullable on purpose —
-- existing items stay valid and show as "Unassigned" until someone sets it.
-- Run on the dev project first.
-- ============================================================================

alter table items add column if not exists department text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'items_department_check'
       and conrelid = 'public.items'::regclass
  ) then
    alter table items
      add constraint items_department_check
      check (department is null or department in ('cafe_bar','bakery','kitchen'));
  end if;
end;
$$;

create index if not exists items_department_idx on items (department);
