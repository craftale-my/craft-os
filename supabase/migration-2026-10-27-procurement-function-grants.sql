-- ============================================================================
-- Craft OS — Procurement function grants (2026-10-27)
--
-- Postgres grants EXECUTE on every new function to PUBLIC, and Supabase's
-- default privileges add anon + authenticated. Earlier "revoke ... from anon"
-- lines therefore did not stop anon (the PUBLIC grant still applied).
-- This migration removes anon / PUBLIC from every procurement function and
-- grants authenticated only where something needs it:
--   * helpers used by RLS policies (all policies are TO authenticated) or by
--     the set_po_number trigger, which runs as the calling user;
--   * client RPCs (already authenticated-only, re-stated here for the record);
--   * trigger functions: no direct grant at all. Postgres checks EXECUTE on a
--     trigger function only when the trigger is created, not when it fires.
--   * internal helpers (inventory_avg_unit_cost, receive_internal_po): nobody
--     but the SECURITY DEFINER callers.
-- Non-procurement functions (HR, tasks, POS) are out of scope; see the audit
-- note in the PR checklist.
-- Prerequisites: all 2026-10-27 procurement migrations up to internal-transfers.
-- Idempotent.
-- ============================================================================

do $$
declare
  f text;
begin
  -- Helpers used by policies / the PO-number trigger: authenticated only.
  foreach f in array array[
    'public.has_procurement_cap(text)',
    'public.can_access_branch(uuid)',
    'public.current_branch_id()',
    'public.is_internal_po_source(uuid)',
    'public.next_po_number()',
    'public.business_date_of(timestamp with time zone)',
    -- client RPCs
    'public.submit_receiving(uuid,text,text,text,jsonb)',
    'public.close_po_short(uuid,text)',
    'public.log_wastage(uuid,uuid,numeric,text,text,text)',
    'public.ship_internal_po(uuid,jsonb,text)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon', f);
      execute format('grant execute on function %s to authenticated', f);
    end if;
  end loop;

  -- Trigger functions and internal helpers: no client role at all.
  foreach f in array array[
    'public.guard_internal_po()',
    'public.guard_po_close_short()',
    'public.guard_po_item_transfer()',
    'public.set_po_number()',
    'public.stamp_inventory_unit_cost()',
    'public.stamp_po_item_conversion_rate()',
    'public.inventory_avg_unit_cost(uuid,uuid,timestamp with time zone)',
    'public.receive_internal_po(uuid,text,text,text,jsonb)'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', f);
    end if;
  end loop;
end $$;
