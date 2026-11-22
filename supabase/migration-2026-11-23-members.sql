-- Members: phone sign-in and points (docs/superpowers/specs/2026-11-22-members-phone-points-design.md).
-- Run on craft-os-dev after migration-2026-11-22-qr-table-cart.sql. Safe to re-run.
-- No existing function is re-created: points are written by triggers on bills and refunds.
--   1 tables: members, member_points (the ledger), member_tokens, member_otps, member_settings,
--     member_bill_events (who put a member on a bill); bills.member_id
--   2 helpers (not callable by clients): phone normalise / mask, token → member, balance writer
--   3 triggers: earn on paid, refund, merge hand-over, split part inherits
--   4 guest RPCs (anon): member_public_settings, member_me, member_sign_out, member_link_table
--   5 till RPCs (device session): pos_bill_set_member, pos_bill_clear_member
--   6 back office: member_search, member_ledger, member_settings_get (access_settings);
--     member_adjust, member_delete, member_settings_set (owner)
--   7 Edge Function only (service_role): member_otp_request, member_otp_verify
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate.

do $$
begin
  -- pgcrypto lives in schema "extensions" (migration-2026-10-24-pos-checkout.sql); digest() is called qualified
  if to_regprocedure('extensions.digest(text,text)') is null then
    raise exception 'STOP: pgcrypto is not in schema "extensions" — the member functions call extensions.digest()';
  end if;
end $$;

-- ── 1 tables ──────────────────────────────────────────────────────────────────
create table if not exists members (
  id            uuid primary key default gen_random_uuid(),
  phone         text,                                        -- E.164 '+60123456789'; null once deleted
  points        integer not null default 0 check (points >= 0),   -- = sum(member_points.points), same transaction
  joined_at     timestamptz not null default now(),
  last_visit_at timestamptz,
  deleted_at    timestamptz,
  constraint members_phone_e164 check (phone is null or phone ~ '^\+601[0-9]{8,9}$'),
  constraint members_phone_or_deleted check (phone is not null or deleted_at is not null)
);
create unique index if not exists members_phone_live on members(phone) where deleted_at is null;
alter table members enable row level security;          -- no policies: functions only
revoke all on members from public, anon, authenticated;

alter table bills add column if not exists member_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bills_member_id_fkey') then
    alter table bills add constraint bills_member_id_fkey foreign key (member_id) references members(id);
  end if;
end $$;
create index if not exists bills_member_idx on bills(member_id) where member_id is not null;

create table if not exists member_points (
  id         uuid primary key default gen_random_uuid(),
  member_id  uuid not null references members(id),
  kind       text not null check (kind in ('earn', 'refund', 'adjust')),
  points     integer not null check (points <> 0),
  bill_id    uuid references bills(id),
  refund_id  uuid references refunds(id),                  -- refund rows: the refund that wrote it
  rate       numeric(6,2),                                 -- earn rows: points per RM 1 used (a refund reuses it)
  reason     text,
  staff_id   uuid,                                         -- adjust rows: the owner
  created_at timestamptz not null default now(),
  constraint member_points_shape check (
    (kind = 'earn'   and bill_id is not null and points > 0 and rate is not null) or
    (kind = 'refund' and bill_id is not null and refund_id is not null and points < 0) or
    (kind = 'adjust' and bill_id is null and reason is not null and staff_id is not null))
);
create unique index if not exists member_points_one_earn on member_points(bill_id) where kind = 'earn';
create unique index if not exists member_points_one_refund on member_points(refund_id) where refund_id is not null;
create index if not exists member_points_member on member_points(member_id, created_at desc);
alter table member_points enable row level security;
revoke all on member_points from public, anon, authenticated;

create table if not exists member_tokens (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references members(id),
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),   -- encode(digest(token,'sha256'),'hex')
  device       text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_used_at timestamptz
);
create index if not exists member_tokens_member on member_tokens(member_id);
alter table member_tokens enable row level security;
revoke all on member_tokens from public, anon, authenticated;

create table if not exists member_otps (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null,
  code_hash  text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  attempts   integer not null default 0,
  ip         text,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  dev_code   text                                          -- dev 'log' mode only; readable by SQL alone
);
create index if not exists member_otps_phone on member_otps(phone, created_at desc);
create index if not exists member_otps_ip on member_otps(ip, created_at);
create index if not exists member_otps_created on member_otps(created_at);
alter table member_otps enable row level security;
revoke all on member_otps from public, anon, authenticated;

create table if not exists member_settings (
  id            boolean primary key default true check (id),   -- one row
  rate          numeric(6,2) not null default 1 check (rate >= 0 and rate <= 100),
  qr_enabled    boolean not null default true,
  sms_daily_cap integer not null default 300 check (sms_daily_cap >= 0 and sms_daily_cap <= 100000),
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
insert into member_settings(id) values (true) on conflict (id) do nothing;
alter table member_settings enable row level security;
revoke all on member_settings from public, anon, authenticated;

-- the staff log of attach / remove at the counter (spec §3: "logged with the staff id")
create table if not exists member_bill_events (
  id         uuid primary key default gen_random_uuid(),
  bill_id    uuid not null references bills(id),
  member_id  uuid references members(id),
  action     text not null check (action in ('attach', 'clear', 'link')),
  staff_id   uuid,
  device_id  uuid,
  created_at timestamptz not null default now()
);
create index if not exists member_bill_events_bill on member_bill_events(bill_id, created_at);
alter table member_bill_events enable row level security;
revoke all on member_bill_events from public, anon, authenticated;

-- ── 2 helpers ─────────────────────────────────────────────────────────────────
-- A Malaysian mobile number in any of the shapes people type → E.164, or null when it is not one.
-- Accepts '0123456789', '60123456789', '+60123456789', '123456789' (the part after a fixed +60),
-- with spaces, dashes, dots and brackets.
create or replace function member_phone_normalise(p_phone text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
           when d ~ '^\+601[0-9]{8,9}$' then d
           when d ~ '^601[0-9]{8,9}$'   then '+' || d
           when d ~ '^01[0-9]{8,9}$'    then '+6' || d
           when d ~ '^1[0-9]{8,9}$'     then '+60' || d
         end
    from (select regexp_replace(coalesce(p_phone, ''), '[\s().-]', '', 'g') as d) x
$$;
revoke all on function member_phone_normalise(text) from public, anon, authenticated;

-- '+60123456789' → '+60 ••• ••6789' (guest side and receipts)
create or replace function member_phone_mask(p_phone text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p_phone is null or length(p_phone) < 8 then null
              else left(p_phone, 3) || ' ••• ••' || right(p_phone, 4) end
$$;
revoke all on function member_phone_mask(text) from public, anon, authenticated;

-- The live member a guest token names (unknown, expired, deleted → null); stamps last_used_at.
create or replace function member_by_token(p_token text) returns members
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tok member_tokens;
  v_m   members;
begin
  if p_token is null or length(p_token) < 16 or length(p_token) > 200 then return null; end if;
  select * into v_tok from member_tokens
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and expires_at > now();
  if not found then return null; end if;
  select * into v_m from members where id = v_tok.member_id and deleted_at is null;
  if not found then return null; end if;
  if not current_setting('transaction_read_only')::boolean
     and (v_tok.last_used_at is null or v_tok.last_used_at < now() - interval '1 minute') then
    update member_tokens set last_used_at = now() where id = v_tok.id;
  end if;
  return v_m;
end $$;
revoke all on function member_by_token(text) from public, anon, authenticated;

-- The one writer of the ledger: a row and the balance together, the member row locked.
create or replace function member_points_add(p_member_id uuid, p_kind text, p_points integer, p_bill_id uuid,
                                             p_refund_id uuid, p_rate numeric, p_reason text, p_staff_id uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bal integer;
begin
  update members set points = points + p_points where id = p_member_id returning points into v_bal;
  insert into member_points(member_id, kind, points, bill_id, refund_id, rate, reason, staff_id)
  values (p_member_id, p_kind, p_points, p_bill_id, p_refund_id, p_rate, p_reason, p_staff_id);
  return v_bal;
end $$;
revoke all on function member_points_add(uuid, text, integer, uuid, uuid, numeric, text, uuid) from public, anon, authenticated;

-- ── 3 triggers ────────────────────────────────────────────────────────────────
-- A bill closes as paid with a member → its one earn row. A split part is inserted already 'paid' and
-- then closed by pos_pay_and_close (status set again, total written), so the earn is decided on any
-- update that sets status while the bill is paid; the unique index makes a repeat a no-op.
create or replace function bills_member_on_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rate   numeric;
  v_points integer;
begin
  if new.status = 'paid' and new.member_id is not null and new.total_sen is not null then
    if exists (select 1 from member_points where bill_id = new.id and kind = 'earn') then return null; end if;
    -- Staff Meal: any live item ordered from a discounted catalog earns nothing
    if exists (select 1 from order_items oi where oi.bill_id = new.id and oi.voided_at is null
                                              and oi.catalog_discount_bp > 0) then
      return null;
    end if;
    perform 1 from members where id = new.member_id and deleted_at is null for update;
    if not found then return null; end if;
    select rate into v_rate from member_settings where id;
    v_points := floor(new.total_sen / 100.0 * coalesce(v_rate, 1));
    if v_points > 0 then
      insert into member_points(member_id, kind, points, bill_id, rate)
      values (new.member_id, 'earn', v_points, new.id, coalesce(v_rate, 1))
      on conflict (bill_id) where kind = 'earn' do nothing;
      if found then
        update members set points = points + v_points,
                           last_visit_at = greatest(coalesce(last_visit_at, '-infinity'), coalesce(new.closed_at, now()))
         where id = new.member_id;
      end if;
    end if;
  elsif new.status = 'merged' and old.status is distinct from 'merged'
        and new.member_id is not null and new.merged_into is not null then
    -- the surviving bill keeps its own member; with none it takes this one's
    update bills set member_id = new.member_id where id = new.merged_into and member_id is null and status = 'open';
  end if;
  return null;
end $$;
revoke all on function bills_member_on_status() from public, anon, authenticated;
drop trigger if exists bills_member_on_status on bills;
create trigger bills_member_on_status after update of status on bills
  for each row execute function bills_member_on_status();

-- A part split off a parent starts with the parent's member (as bills_call_no copies its call number).
create or replace function bills_member_inherit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.split_from is not null and new.member_id is null then
    new.member_id := (select b.member_id from bills b where b.id = new.split_from);
  end if;
  return new;
end $$;
revoke all on function bills_member_inherit() from public, anon, authenticated;
drop trigger if exists bills_member_inherit on bills;
create trigger bills_member_inherit before insert on bills
  for each row execute function bills_member_inherit();

-- A refund of a bill that earned → a negative row of floor(refunded RM × the earn's rate), never taking
-- the bill's net points (or the member's balance) below zero.
create or replace function refunds_member_points() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_earn member_points;
  v_net  integer;
  v_bal  integer;
  v_take integer;
begin
  select * into v_earn from member_points where bill_id = new.bill_id and kind = 'earn';
  if not found then return null; end if;
  select points into v_bal from members where id = v_earn.member_id for update;
  select coalesce(sum(points), 0) into v_net from member_points where bill_id = new.bill_id;
  v_take := least(floor(new.amount_sen / 100.0 * v_earn.rate)::integer, v_net, v_bal);
  if v_take > 0 then
    perform member_points_add(v_earn.member_id, 'refund', -v_take, new.bill_id, new.id, null, null, null);
  end if;
  return null;
end $$;
revoke all on function refunds_member_points() from public, anon, authenticated;
drop trigger if exists refunds_member_points on refunds;
create trigger refunds_member_points after insert on refunds
  for each row execute function refunds_member_points();

-- ── 4 guest RPCs (anon) ───────────────────────────────────────────────────────
-- What the QR page needs before anyone signs in: is the member button shown, and the earn rate.
create or replace function member_public_settings() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('qrEnabled', s.qr_enabled, 'rate', s.rate) from member_settings s where s.id
$$;
revoke all on function member_public_settings() from public;
grant execute on function member_public_settings() to anon, authenticated;

-- The signed-in guest: masked number, balance, last five entries, rate. Null for an unknown, expired or
-- deleted token (the page then returns to "Join & earn points"). Not STABLE: it stamps last_used_at.
create or replace function member_me(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m members;
begin
  v_m := member_by_token(p_token);
  if v_m.id is null then return null; end if;
  return jsonb_build_object(
    'phoneMasked', member_phone_mask(v_m.phone),
    'points', v_m.points,
    'rate', (select rate from member_settings where id),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('at', x.created_at, 'branchName', x.branch_name,
                                          'points', x.points, 'kind', x.kind) order by x.created_at desc, x.id)
        from (select mp.id, mp.created_at, mp.points, mp.kind, br.name as branch_name
                from member_points mp
                left join bills b on b.id = mp.bill_id
                left join branches br on br.id = b.branch_id
               where mp.member_id = v_m.id
               order by mp.created_at desc, mp.id limit 5) x), '[]'::jsonb));
end $$;
revoke all on function member_me(text) from public;
grant execute on function member_me(text) to anon, authenticated;

create or replace function member_sign_out(p_token text) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from member_tokens where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;
revoke all on function member_sign_out(text) from public;
grant execute on function member_sign_out(text) to anon, authenticated;

-- The table's open bill gets this member when it has none. Returns whose number the bill's points go to:
-- {linked: true, phoneMasked: own} when it is (now) this member's; {linked: false, phoneMasked: other's}
-- when another member was first; {linked: false, phoneMasked: null} with no open bill, an unknown table
-- or members switched off on the QR page. Null for a token that names no live member.
create or replace function member_link_table(p_table_token text, p_member_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m     members;
  v_table dining_tables;
  v_bill  bills;
  v_other text;
begin
  v_m := member_by_token(p_member_token);
  if v_m.id is null then return null; end if;
  if not coalesce((select qr_enabled from member_settings where id), false) then
    return jsonb_build_object('linked', false, 'phoneMasked', null);
  end if;
  select * into v_table from dining_tables where qr_token = p_table_token and is_active;
  if not found then return jsonb_build_object('linked', false, 'phoneMasked', null); end if;
  select * into v_bill from bills where table_id = v_table.id and status = 'open' for update;
  if not found then return jsonb_build_object('linked', false, 'phoneMasked', null); end if;
  if v_bill.member_id is null then
    update bills set member_id = v_m.id, updated_at = now() where id = v_bill.id;
    insert into member_bill_events(bill_id, member_id, action) values (v_bill.id, v_m.id, 'link');
    return jsonb_build_object('linked', true, 'phoneMasked', member_phone_mask(v_m.phone));
  end if;
  if v_bill.member_id = v_m.id then
    return jsonb_build_object('linked', true, 'phoneMasked', member_phone_mask(v_m.phone));
  end if;
  select phone into v_other from members where id = v_bill.member_id;
  return jsonb_build_object('linked', false, 'phoneMasked', member_phone_mask(v_other));
end $$;
revoke all on function member_link_table(text, text) from public;
grant execute on function member_link_table(text, text) to anon, authenticated;

-- ── 5 till RPCs (a till tablet's staff session, the bill's own outlet) ────────
-- Staff put a member on an open bill by phone number; a new number becomes a member on the spot.
-- Returns {memberId, phone, phoneMasked, isNew, points}.
create or replace function pos_bill_set_member(p_bill_id uuid, p_phone text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx   record;
  v_bill  bills;
  v_phone text;
  v_m     members;
  v_new   boolean := false;
begin
  select * into v_ctx from pos_ctx();
  select * into v_bill from bills where id = p_bill_id and branch_id = v_ctx.branch_id for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then raise exception 'The member can only be changed on an open bill.'; end if;
  v_phone := member_phone_normalise(p_phone);
  if v_phone is null then raise exception 'Enter a Malaysian mobile number, e.g. 012-345 6789.'; end if;
  select * into v_m from members where phone = v_phone and deleted_at is null;
  if not found then
    insert into members(phone) values (v_phone)
    on conflict (phone) where deleted_at is null do nothing
    returning * into v_m;
    if v_m.id is null then
      select * into v_m from members where phone = v_phone and deleted_at is null;
    else
      v_new := true;
    end if;
  end if;
  if v_bill.member_id is distinct from v_m.id then
    update bills set member_id = v_m.id, updated_at = now() where id = v_bill.id;
    insert into member_bill_events(bill_id, member_id, action, staff_id, device_id)
    values (v_bill.id, v_m.id, 'attach', v_ctx.staff_id, v_ctx.device_id);
  end if;
  return jsonb_build_object('memberId', v_m.id, 'phone', v_m.phone, 'phoneMasked', member_phone_mask(v_m.phone),
                            'isNew', v_new, 'points', v_m.points);
end $$;
revoke all on function pos_bill_set_member(uuid, text) from public, anon;
grant execute on function pos_bill_set_member(uuid, text) to authenticated;

create or replace function pos_bill_clear_member(p_bill_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ctx  record;
  v_bill bills;
begin
  select * into v_ctx from pos_ctx();
  select * into v_bill from bills where id = p_bill_id and branch_id = v_ctx.branch_id for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then raise exception 'The member can only be changed on an open bill.'; end if;
  if v_bill.member_id is null then return; end if;
  update bills set member_id = null, updated_at = now() where id = v_bill.id;
  insert into member_bill_events(bill_id, member_id, action, staff_id, device_id)
  values (v_bill.id, v_bill.member_id, 'clear', v_ctx.staff_id, v_ctx.device_id);
end $$;
revoke all on function pos_bill_clear_member(uuid) from public, anon;
grant execute on function pos_bill_clear_member(uuid) to authenticated;

-- ── 6 back office ─────────────────────────────────────────────────────────────
-- Staff with back-office access (access_settings) read; the owner changes. Members belong to the
-- company, not one outlet, so there is no outlet scope.
create or replace function member_require_back_office() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not has_menu_cap('access_settings') then raise exception 'You cannot see members.'; end if;
end $$;
revoke all on function member_require_back_office() from public, anon, authenticated;

create or replace function member_require_owner() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not current_is_owner() then raise exception 'Only the owner can do this.'; end if;
end $$;
revoke all on function member_require_owner() from public, anon, authenticated;

-- Search by number (any part of it; a leading 0 or 60 is ignored). Newest visit first.
-- Returns {total, rows: [{id, phone, points, joinedAt, lastVisitAt}]}.
create or replace function member_search(p_query text, p_limit integer, p_offset integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_digits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform member_require_back_office();
  v_digits := regexp_replace(v_digits, '^(60|0)', '');
  return (
    with hits as (
      select m.* from members m
       where m.deleted_at is null and (v_digits = '' or m.phone like '%' || v_digits || '%'))
    select jsonb_build_object(
      'total', (select count(*) from hits),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object('id', h.id, 'phone', h.phone, 'points', h.points,
                                            'joinedAt', h.joined_at, 'lastVisitAt', h.last_visit_at)
                         order by h.last_visit_at desc nulls last, h.joined_at desc, h.id)
          from (select * from hits order by last_visit_at desc nulls last, joined_at desc, id
                 limit v_limit offset v_offset) h), '[]'::jsonb)));
end $$;
revoke all on function member_search(text, integer, integer) from public, anon;
grant execute on function member_search(text, integer, integer) to authenticated;

-- One member and their whole ledger (newest first, at most 500 rows).
-- Returns {member: {id, phone, points, joinedAt, lastVisitAt, deletedAt},
--          entries: [{id, at, kind, points, billId, billNo, branchName, reason, staffName}]}, or null.
create or replace function member_ledger(p_member_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_m members;
begin
  perform member_require_back_office();
  select * into v_m from members where id = p_member_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'member', jsonb_build_object('id', v_m.id, 'phone', v_m.phone, 'points', v_m.points, 'joinedAt', v_m.joined_at,
                                 'lastVisitAt', v_m.last_visit_at, 'deletedAt', v_m.deleted_at),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'at', x.created_at, 'kind', x.kind, 'points', x.points,
                                          'billId', x.bill_id, 'billNo', x.bill_no, 'branchName', x.branch_name,
                                          'reason', x.reason, 'staffName', x.staff_name)
                       order by x.created_at desc, x.id)
        from (select mp.*, b.bill_no, br.name as branch_name, s.name as staff_name
                from member_points mp
                left join bills b on b.id = mp.bill_id
                left join branches br on br.id = b.branch_id
                left join staff s on s.id = mp.staff_id
               where mp.member_id = v_m.id
               order by mp.created_at desc, mp.id limit 500) x), '[]'::jsonb));
end $$;
revoke all on function member_ledger(uuid) from public, anon;
grant execute on function member_ledger(uuid) to authenticated;

-- Owner: ± points with a reason; the balance may not go below zero. Returns {points} (the new balance).
create or replace function member_adjust(p_member_id uuid, p_points integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m      members;
  v_reason text := nullif(btrim(left(coalesce(p_reason, ''), 200)), '');
begin
  perform member_require_owner();
  if p_points is null or p_points = 0 or abs(p_points) > 100000 then
    raise exception 'Enter a number of points between -100000 and 100000, not 0.';
  end if;
  if v_reason is null then raise exception 'A reason is required.'; end if;
  select * into v_m from members where id = p_member_id and deleted_at is null for update;
  if not found then raise exception 'Member not found'; end if;
  if v_m.points + p_points < 0 then raise exception 'Points cannot go below zero.'; end if;
  return jsonb_build_object('points',
    member_points_add(v_m.id, 'adjust', p_points, null, null, null, v_reason, auth.uid()));
end $$;
revoke all on function member_adjust(uuid, integer, text) from public, anon;
grant execute on function member_adjust(uuid, integer, text) to authenticated;

-- Owner (PDPA request): the number goes, tokens and codes go, open bills drop the member; the ledger
-- rows stay, now anonymous.
create or replace function member_delete(p_member_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_m members;
begin
  perform member_require_owner();
  select * into v_m from members where id = p_member_id and deleted_at is null for update;
  if not found then raise exception 'Member not found'; end if;
  delete from member_tokens where member_id = v_m.id;
  delete from member_otps where phone = v_m.phone;
  update bills set member_id = null, updated_at = now() where member_id = v_m.id and status = 'open';
  update members set phone = null, deleted_at = now() where id = v_m.id;
end $$;
revoke all on function member_delete(uuid) from public, anon;
grant execute on function member_delete(uuid) to authenticated;

-- {rate, qrEnabled, smsDailyCap, smsSentToday} (today = Malaysia calendar day); no check (internal).
create or replace function member_settings_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('rate', s.rate, 'qrEnabled', s.qr_enabled, 'smsDailyCap', s.sms_daily_cap,
                            'smsSentToday', (select count(*) from member_otps o
                                              where o.created_at >= date_trunc('day', now() at time zone 'Asia/Kuala_Lumpur')
                                                                    at time zone 'Asia/Kuala_Lumpur'))
    from member_settings s where s.id
$$;
revoke all on function member_settings_json() from public, anon, authenticated;

create or replace function member_settings_get() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform member_require_back_office();
  return member_settings_json();
end $$;
revoke all on function member_settings_get() from public, anon;
grant execute on function member_settings_get() to authenticated;

-- Owner: a null argument keeps that setting. Returns what member_settings_get returns.
create or replace function member_settings_set(p_rate numeric, p_qr_enabled boolean, p_sms_daily_cap integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform member_require_owner();
  if p_rate is not null and (p_rate < 0 or p_rate > 100 or p_rate <> round(p_rate, 2)) then
    raise exception 'The earn rate must be between 0 and 100 points per RM 1.';
  end if;
  if p_sms_daily_cap is not null and (p_sms_daily_cap < 0 or p_sms_daily_cap > 100000) then
    raise exception 'The daily SMS cap must be between 0 and 100000.';
  end if;
  update member_settings
     set rate = coalesce(p_rate, rate), qr_enabled = coalesce(p_qr_enabled, qr_enabled),
         sms_daily_cap = coalesce(p_sms_daily_cap, sms_daily_cap), updated_at = now(), updated_by = auth.uid()
   where id;
  return member_settings_json();
end $$;
revoke all on function member_settings_set(numeric, boolean, integer) from public, anon;
grant execute on function member_settings_set(numeric, boolean, integer) to authenticated;

-- ── 7 Edge Function only (service_role) ───────────────────────────────────────
-- A code was made by the function (6 digits, hashed there). Limits (spec §5), checked and recorded
-- under one lock so two requests cannot both slip under a limit: per number 3 codes per 15 minutes and
-- 10 per 24 hours → 'rate_number'; per IP 10 per hour → 'rate_ip'; codes today (Malaysia day) at the
-- daily cap → 'cap'; members off on the QR page → 'disabled'. 'ok' = the code is stored (5 minutes,
-- 5 tries) and the function may send it. Only issued codes count toward the limits. The answer does not
-- depend on whether the number is a member.
create or replace function member_otp_request(p_phone text, p_ip text, p_code_hash text, p_dev_code text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_phone text := member_phone_normalise(p_phone);
  v_set   member_settings;
  v_ip    text := nullif(left(btrim(coalesce(p_ip, '')), 64), '');
begin
  if v_phone is null then raise exception 'Invalid phone number'; end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid code hash'; end if;
  select * into v_set from member_settings where id;
  if not coalesce(v_set.qr_enabled, false) then return 'disabled'; end if;
  perform pg_advisory_xact_lock(hashtextextended('member_otp_request', 0));
  delete from member_otps where created_at < now() - interval '2 days';
  if (select count(*) from member_otps where phone = v_phone and created_at > now() - interval '15 minutes') >= 3
     or (select count(*) from member_otps where phone = v_phone and created_at > now() - interval '24 hours') >= 10 then
    return 'rate_number';
  end if;
  if v_ip is not null
     and (select count(*) from member_otps where ip = v_ip and created_at > now() - interval '1 hour') >= 10 then
    return 'rate_ip';
  end if;
  if (select count(*) from member_otps
       where created_at >= date_trunc('day', now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur')
     >= v_set.sms_daily_cap then
    return 'cap';
  end if;
  insert into member_otps(phone, code_hash, expires_at, ip, dev_code)
  values (v_phone, p_code_hash, now() + interval '5 minutes', v_ip, nullif(p_dev_code, ''));
  return 'ok';
end $$;
revoke all on function member_otp_request(text, text, text, text) from public, anon, authenticated;
grant execute on function member_otp_request(text, text, text, text) to service_role;

-- The number's newest code is checked: none or already used → 'expired'; 5 wrong tries already →
-- 'locked' (so the 6th try answers 'locked', a right code included); past 5 minutes → 'expired'; wrong →
-- the try is counted, 'wrong'. Right → the code is used, the member is created when new, the token's
-- hash is stored for 180 days, 'ok'.
create or replace function member_otp_verify(p_phone text, p_code_hash text, p_token_hash text, p_device text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_phone text := member_phone_normalise(p_phone);
  v_otp   member_otps;
  v_m     uuid;
begin
  if v_phone is null then raise exception 'Invalid phone number'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid token hash'; end if;
  select * into v_otp from member_otps where phone = v_phone order by created_at desc, id limit 1 for update;
  if not found or v_otp.used_at is not null then return 'expired'; end if;
  if v_otp.attempts >= 5 then return 'locked'; end if;
  if v_otp.expires_at <= now() then return 'expired'; end if;
  if p_code_hash is distinct from v_otp.code_hash then
    update member_otps set attempts = attempts + 1 where id = v_otp.id;
    return 'wrong';
  end if;
  update member_otps set used_at = now(), dev_code = null where id = v_otp.id;
  insert into members(phone) values (v_phone)
  on conflict (phone) where deleted_at is null do nothing
  returning id into v_m;
  if v_m is null then select id into v_m from members where phone = v_phone and deleted_at is null; end if;
  delete from member_tokens where member_id = v_m and expires_at <= now();
  insert into member_tokens(member_id, token_hash, device, expires_at)
  values (v_m, p_token_hash, nullif(left(btrim(coalesce(p_device, '')), 120), ''), now() + interval '180 days');
  return 'ok';
end $$;
revoke all on function member_otp_verify(text, text, text, text) from public, anon, authenticated;
grant execute on function member_otp_verify(text, text, text, text) to service_role;

notify pgrst, 'reload schema';
select 'members applied' as result;
