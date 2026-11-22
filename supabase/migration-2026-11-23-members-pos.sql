-- Members at the counter (spec docs/superpowers/specs/2026-11-22-members-phone-points-design.md §3 "Staff (POS)").
-- Run on craft-os-dev after migration-2026-11-23-members.sql; re-runnable. Self-check:
-- migration-2026-11-23-members-pos-verify.sql.
--
-- No existing function is re-created (pos_receipt_payload, pos_queue_receipt and pos_pay_and_close stay as they
-- are). Two additions:
--   1 pos_bill_member(p_bill_id) — the member on a bill of the till's outlet, for the bill column and the
--     Member dialog: {memberId, phone, phoneMasked, points, earned} | null.
--   2 print_jobs_member_line — a BEFORE INSERT trigger on print_jobs: a customer receipt ('receipt') of a paid
--     bill with a member that earned at least 1 point gets payload.member = {last4, pointsEarned}, which
--     renderReceiptLines prints as "Member ••6789" and "Points earned 42" after the totals. A trigger, so the
--     receipt payload function stays untouched and reprints carry the lines too. It never stops a print job:
--     any error leaves the payload as it was (WARNING).

-- ── 1 the member on a bill ─────────────────────────────────────────────────────
-- A till's staff session (pos_ctx), the bill at the device's outlet, any status. Null when the bill has no
-- member or the member was deleted. `earned` = the bill's earn row (null when it has none yet).
create or replace function pos_bill_member(p_bill_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx  record;
  v_bill bills;
  v_m    members;
begin
  select * into v_ctx from pos_ctx();
  select * into v_bill from bills where id = p_bill_id and branch_id = v_ctx.branch_id;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.member_id is null then return null; end if;
  select * into v_m from members where id = v_bill.member_id and deleted_at is null;
  if not found then return null; end if;
  return jsonb_build_object(
    'memberId', v_m.id, 'phone', v_m.phone, 'phoneMasked', member_phone_mask(v_m.phone), 'points', v_m.points,
    'earned', (select points from member_points where bill_id = v_bill.id and kind = 'earn'));
end $$;
revoke all on function pos_bill_member(uuid) from public, anon;
grant execute on function pos_bill_member(uuid) to authenticated;

-- ── 2 the member lines on a receipt ────────────────────────────────────────────
create or replace function print_jobs_member_line() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_phone  text;
  v_points integer;
begin
  if new.kind <> 'receipt' or new.payload->>'kind' is distinct from 'receipt' or new.payload->>'billNo' is null then
    return new;
  end if;
  begin
    select m.phone, p.points into v_phone, v_points
      from bills b
      join members m on m.id = b.member_id and m.deleted_at is null
      join member_points p on p.bill_id = b.id and p.kind = 'earn'
     where b.branch_id = new.branch_id and b.bill_no = new.payload->>'billNo' and b.status = 'paid';
    if v_phone is not null and v_points >= 1 then
      new.payload := new.payload || jsonb_build_object('member', jsonb_build_object('last4', right(v_phone, 4), 'pointsEarned', v_points));
    end if;
  exception when others then
    raise warning 'print_jobs_member_line: % (receipt % printed without its member lines)', sqlerrm, new.payload->>'billNo';
  end;
  return new;
end $$;
revoke all on function print_jobs_member_line() from public, anon, authenticated;

drop trigger if exists print_jobs_member_line on print_jobs;
create trigger print_jobs_member_line before insert on print_jobs
  for each row execute function print_jobs_member_line();
