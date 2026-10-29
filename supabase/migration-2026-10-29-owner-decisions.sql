-- ============================================================================
-- Craft OS — Owner decisions on PR #9 (2026-10-29)
--
-- 1. Procurement capabilities follow the owner's capability matrix both ways,
--    the same rule as the app (useCan) and POS (has_menu_cap): an explicit
--    true or false in system_role_permissions wins; with no setting, the
--    built-in default for the system role applies. Before, an explicit setting
--    could only widen access, so the owner could not switch procurement off for
--    a role. The owner role always keeps access, so it cannot lock itself out.
--    Rank is no longer consulted (only when system_role is empty, as in the
--    app). CHECK ON PROD before running: staff whose rank is supervisor/manager
--    but whose system_role is 'staff' lose procurement access.
-- 2. Two more wastage reasons: Staff meal and Returned by customer.
--
-- Run after migration-2026-10-29-item-departments.sql (#13 in the PR #9
-- order). Idempotent. This file is now the canonical log_wastage; the wastage
-- file STOPs if re-run after it.
-- ============================================================================

-- 1. has_procurement_cap: the owner's setting wins both ways ----------------
create or replace function has_procurement_cap(p_cap text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case
      when r.role = 'owner' then true
      when (select srp.permissions ? p_cap from system_role_permissions srp where srp.system_role = r.role)
        then (select (srp.permissions ->> p_cap)::boolean from system_role_permissions srp where srp.system_role = r.role)
      else case p_cap
        when 'manage_procurement' then r.role in ('admin', 'manager')
        when 'use_procurement'    then r.role in ('admin', 'manager', 'supervisor')
        else false
      end
    end
    from staff s
    -- Same role the app uses: system_role, or one derived from rank before it existed.
    cross join lateral (select coalesce(s.system_role,
      case s.rank when 'manager' then 'manager' when 'supervisor' then 'supervisor' else 'staff' end) as role) r
    where s.id = auth.uid()
      and s.is_active
      and s.status = 'active'   -- live staff only (resigned staff lose access)
  ), false)
$$;

-- 2. Wastage reasons ---------------------------------------------------------
alter table wastage_logs drop constraint if exists wastage_logs_reason_check;
alter table wastage_logs add constraint wastage_logs_reason_check
  check (reason in ('expired', 'damaged', 'production_error', 'staff_meal', 'customer_return', 'other'));

create or replace function log_wastage(
  p_branch_id  uuid,
  p_item_id    uuid,
  p_quantity   numeric,
  p_reason     text,
  p_note       text default null,
  p_photo_path text default null
)
returns wastage_logs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item      items%rowtype;
  v_on_hand   numeric;
  v_unit_cost numeric;
  v_note      text := nullif(btrim(p_note), '');
  v_log       wastage_logs%rowtype;
  v_tx_id     uuid;
begin
  -- Authorisation first (live staff only, via the helpers).
  if not has_procurement_cap('use_procurement') then
    raise exception 'Not authorised to log wastage';
  end if;
  if p_branch_id is null or not can_access_branch(p_branch_id) then
    raise exception 'Not authorised to log wastage for this branch';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;
  if p_reason is null or p_reason not in ('expired', 'damaged', 'production_error',
                                          'staff_meal', 'customer_return', 'other') then
    raise exception 'Unknown wastage reason: %', coalesce(p_reason, '(none)');
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'A note is required when the reason is Other';
  end if;

  select * into v_item from items where id = p_item_id;
  if not found then
    raise exception 'Item not found';
  end if;
  if v_item.status <> 'active' then
    raise exception 'Item is inactive';
  end if;
  if not exists (select 1 from branches where id = p_branch_id and is_active) then
    raise exception 'Branch not found';
  end if;

  -- Serialise stock-out for this item at this branch so two loggers cannot
  -- both pass the on-hand check.
  perform pg_advisory_xact_lock(hashtext('stock_out:' || p_item_id::text || ':' || p_branch_id::text));

  select coalesce(sum(quantity), 0) into v_on_hand
    from inventory_transactions
   where item_id = p_item_id and branch_id = p_branch_id;

  if p_quantity > v_on_hand then
    raise exception 'Cannot log % % of wastage: only % % on hand at this branch',
      rtrim(to_char(p_quantity, 'FM999999990.###'), '.'), v_item.base_unit,
      rtrim(to_char(v_on_hand, 'FM999999990.###'), '.'), v_item.base_unit;
  end if;

  -- Current moving-average cost at the branch (before this row).
  v_unit_cost := inventory_avg_unit_cost(p_item_id, p_branch_id, null);

  insert into wastage_logs (branch_id, item_id, quantity, reason, note, photo_path,
                            unit_cost, value, business_date, created_by)
  values (p_branch_id, p_item_id, p_quantity, p_reason, v_note, nullif(btrim(p_photo_path), ''),
          v_unit_cost, p_quantity * v_unit_cost, business_date_of(now()), auth.uid())
  returning * into v_log;

  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity,
                                      reference_type, reference_id, created_by,
                                      notes, unit_cost, reason)
  values (p_item_id, p_branch_id, 'wastage', -p_quantity,
          'wastage', v_log.id, auth.uid(),
          v_note, v_unit_cost, p_reason)
  returning id into v_tx_id;

  update wastage_logs set transaction_id = v_tx_id where id = v_log.id
  returning * into v_log;

  return v_log;
end;
$$;

revoke all on function log_wastage(uuid, uuid, numeric, text, text, text) from public, anon;
grant execute on function log_wastage(uuid, uuid, numeric, text, text, text) to authenticated;
