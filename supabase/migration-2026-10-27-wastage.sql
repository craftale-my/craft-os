-- ============================================================================
-- Craft OS — Wastage quick-log (brief §7.5, §8 step 9) (2026-10-27)
--
-- What this adds:
--   * inventory_transactions.transaction_type CHECK widened with 'wastage'
--     (drop + re-add with a strictly larger set — the accepted additive
--     pattern, brief §7.1). Only 'wastage' is added here; the rest of the
--     §7.1 list comes with the ledger-widening step.
--   * inventory_transactions.reason (text, nullable) — wastage / adjustment
--     reason code (brief §7.1).
--   * business_date_of(timestamptz): 05:00 Asia/Kuala_Lumpur cutoff
--     (brief §7.1 — cutoff PROPOSED, pending the owner's OK; change it here).
--   * wastage_logs: the source document for each wastage entry. The ledger
--     row points back to it (reference_type = 'wastage', reference_id = id).
--   * log_wastage(...) RPC (SECURITY DEFINER, search_path pinned): the only
--     way to write wastage. Clients get SELECT only on wastage_logs.
--
-- Costing (moving-average design, see migration-2026-10-27-cost-fix.sql):
--   the wastage row is stamped with the branch's current moving-average cost
--   (inventory_avg_unit_cost). Removing stock at the average leaves the
--   average of what remains unchanged, so stock value drops by exactly
--   quantity × unit_cost = wastage_logs.value.
--
-- Photos reuse the public 'receiving-photos' bucket under a 'wastage/'
-- prefix; its existing insert policy already requires use_procurement
-- (live staff only, after migration-2026-10-27-security-hardening.sql).
--
-- Prerequisites: migration-2026-10-27-cost-fix.sql,
--   migration-2026-10-27-security-hardening.sql.
-- Idempotent: safe to run more than once.
-- ============================================================================

-- 1. Ledger: allow 'wastage', add reason --------------------------------------
alter table inventory_transactions
  drop constraint if exists inventory_transactions_transaction_type_check;
alter table inventory_transactions
  add constraint inventory_transactions_transaction_type_check
  check (transaction_type in ('stock_in', 'adjustment', 'wastage'));

alter table inventory_transactions add column if not exists reason text;

-- 2. Business date (05:00 MYT cutoff) -----------------------------------------
create or replace function business_date_of(p_ts timestamptz)
returns date
language sql immutable
set search_path = public, pg_temp
as $$
  select ((p_ts at time zone 'Asia/Kuala_Lumpur') - interval '5 hours')::date
$$;

-- 3. wastage_logs ---------------------------------------------------------------
create table if not exists wastage_logs (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id),
  item_id        uuid not null references items(id),
  quantity       numeric not null check (quantity > 0),          -- base units
  reason         text not null
                 check (reason in ('expired', 'damaged', 'production_error', 'other')),
  note           text,
  photo_path     text,                                            -- path in the receiving-photos bucket
  unit_cost      numeric check (unit_cost is null or unit_cost >= 0), -- RM per base unit, stamped
  value          numeric,                                         -- quantity × unit_cost (RM)
  business_date  date not null,
  transaction_id uuid references inventory_transactions(id),
  created_by     uuid references staff(id),
  created_at     timestamptz not null default now(),
  constraint wastage_logs_note_for_other
    check (reason <> 'other' or nullif(btrim(note), '') is not null)
);

create index if not exists wastage_logs_branch_created_idx
  on wastage_logs (branch_id, created_at desc);
create index if not exists wastage_logs_item_idx on wastage_logs (item_id);

alter table wastage_logs enable row level security;

drop policy if exists wastage_logs_select on wastage_logs;
create policy wastage_logs_select on wastage_logs
  for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

-- Writes only through log_wastage().
revoke all on wastage_logs from anon, authenticated;
grant select on wastage_logs to authenticated;

-- 4. log_wastage RPC -----------------------------------------------------------
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
  if p_reason is null or p_reason not in ('expired', 'damaged', 'production_error', 'other') then
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
