-- ============================================================================
-- Craft OS — Wastage may exceed the system on-hand (2026-11-23)
-- Owner decision 2026-11-23: wastage is logged as it happened even when the
-- system shows less on hand (stock may go negative, like POS sales). HQ shipping
-- (ship_internal_po), production and manual negative adjustments keep their
-- on-hand guards.
-- log_wastage is the canonical definition from migration-2026-10-29-owner-decisions.sql
-- (same signature, body and grants) with only the on-hand refusal removed.
-- The advisory lock is KEPT: it shares the 'stock_out:' key with ship_internal_po,
-- produce_batch and the adjustment guard, so their on-hand checks still wait for a
-- wastage in flight instead of reading a balance it is about to change.
-- Idempotent (create or replace). Never re-run migration-2026-10-29-owner-decisions.sql
-- after this file: it would put the refusal back.
-- ============================================================================

set local lock_timeout = '5s';

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

  -- Serialise with the other stock-out paths (same key). No on-hand check: wastage may
  -- take the branch negative (owner decision 2026-11-23).
  perform pg_advisory_xact_lock(hashtext('stock_out:' || p_item_id::text || ':' || p_branch_id::text));

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
