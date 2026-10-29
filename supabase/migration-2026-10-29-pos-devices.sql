-- ============================================================================
-- Craft OS — POS devices and staff sessions (2026-10-29): Part B of devices, PIN login
-- and outlets. Run on craft-os-dev after migration-2026-10-29-pos-outlets.sql.
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-29-pos-devices.md
-- Design: docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md (§2, §4)
--
-- D1  Tables: pos_devices (one per activated tablet or print agent; id = its auth user),
--     pos_device_requests (activation codes), pos_staff_sessions (who is signed in on a
--     device), pos_login_attempts (PIN sign-in tries). RLS on, no policy, no privilege:
--     functions only. branch_pos_settings.idle_lock_minutes (1–60, default 10).
-- D2  Activation. The Edge Function pos-device-activation (service role only) calls
--     pos_activation_request, pos_activation_poll, pos_activation_finish and
--     pos_activation_unclaim. HQ (all_branches + access_settings) sees the waiting
--     requests (pos_device_requests_pending) and approves or rejects one
--     (pos_decide_device_request), typing the code shown on the tablet.
-- D3  Devices in Craft OS: pos_devices_list (the caller's outlets); pos_unpair_device
--     (a manager of the device's outlet; HQ manages every outlet) revokes the device,
--     bans its auth user and ends its open session. All tablets are equal (no main/sub):
--     one POS tablet per outlet is the printing tablet (pos_devices.prints — it prints
--     and holds the cash drawer). HQ marks it when approving; a manager of the outlet
--     moves it with pos_set_print_tablet. Marking one clears the outlet's previous one.
-- D4  Device context: pos_ctx() → (device_id, branch_id, staff_id) with the coded errors
--     device_unpaired / outlet_closed / no_session / access_changed; pos_print_branch().
--     Both are internal: Part C's front-of-house RPCs call them.
-- D5  Staff sessions on a device: pos_login_roster, pos_start_session (name + PIN; five
--     wrong tries since the person's last sign-in, within 24 h, lock them for 10 minutes
--     on every device), pos_end_session.
-- D6  save_lock_settings(p_branch_id, p_idle_lock_minutes): POS settings → Lock.
-- Nothing on the till changes yet: the front-of-house RPCs still use pos_my_branch().
-- Part C swaps them to pos_ctx() together with the POS app.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_staff_may_work(uuid,uuid)') is null or to_regprocedure('pos_manages_outlet(uuid)') is null then
    raise exception 'STOP: run migration-2026-10-29-pos-outlets.sql first (pos_staff_may_work is missing)';
  end if;
end $$;

-- ── D1. Tables ───────────────────────────────────────────────────────────────
create table if not exists pos_devices (
  id           uuid primary key references auth.users(id) on delete cascade,
  branch_id    uuid not null references branches(id),
  kind         text not null check (kind in ('pos', 'print_agent')),
  name         text not null check (name = btrim(name) and char_length(name) between 1 and 40),
  platform     text not null check (platform in ('ipad', 'android', 'other', 'agent')),
  prints       boolean not null default false check (not prints or kind = 'pos'),   -- the printing tablet
  approved_by  uuid references staff(id) on delete set null,
  approved_at  timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid references staff(id) on delete set null
);
create index if not exists pos_devices_branch on pos_devices (branch_id);
create unique index if not exists pos_devices_one_printer on pos_devices (branch_id) where prints and revoked_at is null;

create table if not exists pos_device_requests (
  id          uuid primary key default gen_random_uuid(),
  code        text not null check (code ~ '^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$'),
  secret_hash text not null,
  name        text check (name is null or (name = btrim(name) and char_length(name) between 1 and 40)),
  platform    text not null check (platform in ('ipad', 'android', 'other', 'agent')),
  ip          text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '24 hours',
  branch_id   uuid references branches(id),                       -- set by HQ on approval
  kind        text check (kind in ('pos', 'print_agent')),
  device_name text,
  prints      boolean not null default false,
  decided_by  uuid references staff(id) on delete set null,
  decided_at  timestamptz,
  claimed_at  timestamptz,                                         -- a poll is creating the device account
  activated_at timestamptz,                                        -- the account exists: the request is spent for good
  device_id   uuid references pos_devices(id) on delete set null
);
-- a code is unique while it can still be used
create unique index if not exists pos_device_requests_live_code on pos_device_requests (code)
  where status = 'pending' or (status = 'approved' and activated_at is null);
create index if not exists pos_device_requests_ip on pos_device_requests (ip, created_at);

create table if not exists pos_staff_sessions (
  id             uuid primary key default gen_random_uuid(),
  device_id      uuid not null references pos_devices(id) on delete cascade,
  staff_id       uuid not null references staff(id),
  started_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  ended_at       timestamptz,
  end_reason     text check (end_reason in ('locked', 'idle', 'switched', 'unpaired', 'access_changed'))
);
create unique index if not exists pos_staff_sessions_one_open on pos_staff_sessions (device_id) where ended_at is null;

create table if not exists pos_login_attempts (
  id        bigint generated always as identity primary key,
  staff_id  uuid not null references staff(id) on delete cascade,
  device_id uuid not null references pos_devices(id) on delete cascade,
  at        timestamptz not null default now(),
  ok        boolean not null
);
create index if not exists pos_login_attempts_staff on pos_login_attempts (staff_id, at);

do $$
declare t text;
begin
  foreach t in array array['pos_devices', 'pos_device_requests', 'pos_staff_sessions', 'pos_login_attempts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;

alter table branch_pos_settings add column if not exists idle_lock_minutes integer not null default 10;
alter table branch_pos_settings drop constraint if exists branch_pos_settings_idle_lock_minutes_check;
alter table branch_pos_settings add constraint branch_pos_settings_idle_lock_minutes_check check (idle_lock_minutes between 1 and 60);

-- HQ: every outlet and the POS settings. Internal.
create or replace function pos_is_hq() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select has_menu_cap('all_branches') and has_menu_cap('access_settings')
$$;
revoke all on function pos_is_hq() from public, anon, authenticated;

-- ── D2. Activation (service role, through the Edge Function) ────────────────
-- A new request: a 6-character code (no I, O, 0 or 1) and a secret only the tablet keeps.
-- At most 5 requests per IP per hour and 50 waiting at a time.
create or replace function pos_activation_request(p_name text, p_platform text, p_ip text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_name     text := nullif(btrim(left(coalesce(p_name, ''), 40)), '');
  v_bytes    bytea;
  v_code     text;
  v_secret   text := encode(extensions.gen_random_bytes(24), 'hex');
  v_row      pos_device_requests;
  i          integer;
begin
  if p_platform is null or p_platform not in ('ipad', 'android', 'other', 'agent') then
    return jsonb_build_object('error', 'bad_request');
  end if;
  update pos_device_requests set status = 'expired' where status = 'pending' and expires_at < now();
  if p_ip is not null
     and (select count(*) from pos_device_requests r where r.ip = p_ip and r.created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('error', 'too_many');
  end if;
  if (select count(*) from pos_device_requests r where r.status = 'pending') >= 50 then
    return jsonb_build_object('error', 'busy');
  end if;
  for attempt in 1..5 loop
    v_bytes := extensions.gen_random_bytes(6);
    v_code := '';
    for i in 0..5 loop
      v_code := v_code || substr(v_alphabet, 1 + get_byte(v_bytes, i) % 32, 1);
      if i = 2 then v_code := v_code || '-'; end if;
    end loop;
    begin
      insert into pos_device_requests(code, secret_hash, name, platform, ip)
      values (v_code, encode(extensions.digest(v_secret, 'sha256'), 'hex'), v_name, p_platform, p_ip)
      returning * into v_row;
      return jsonb_build_object('code', v_row.code, 'secret', v_secret, 'expiresAt', v_row.expires_at);
    exception when unique_violation then
      null;                                                          -- the code is in use: draw again
    end;
  end loop;
  return jsonb_build_object('error', 'busy');
end $$;
revoke all on function pos_activation_request(text, text, text) from public, anon, authenticated;
grant execute on function pos_activation_request(text, text, text) to service_role;

-- What a poll sees. A wrong secret gets the same reply as an unknown code, and so does a
-- spent request (activated_at) — even if its device was later deleted. An approved request
-- must be collected within an hour of approval; it is claimed by one poll ('issue'), which
-- then creates the device account and calls pos_activation_finish; a claim older than a
-- minute is taken over.
create or replace function pos_activation_poll(p_code text, p_secret text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row pos_device_requests;
begin
  select * into v_row from pos_device_requests r
   where r.code = upper(btrim(coalesce(p_code, '')))
     and r.secret_hash = encode(extensions.digest(coalesce(p_secret, ''), 'sha256'), 'hex')
   order by r.created_at desc limit 1
   for update;
  if not found or v_row.activated_at is not null then
    return jsonb_build_object('status', 'unknown');
  end if;
  if v_row.status = 'approved' and v_row.claimed_at > now() - interval '1 minute' then
    return jsonb_build_object('status', 'pending');                  -- another poll is creating the account: never expire it mid-way
  end if;
  if v_row.status in ('pending', 'approved') and v_row.expires_at < now() then
    update pos_device_requests set status = 'expired' where id = v_row.id;
    return jsonb_build_object('status', 'expired');
  end if;
  if v_row.status <> 'approved' then return jsonb_build_object('status', v_row.status); end if;
  update pos_device_requests set claimed_at = now() where id = v_row.id;
  return jsonb_build_object('status', 'issue', 'requestId', v_row.id, 'branchId', v_row.branch_id,
                            'kind', v_row.kind, 'name', v_row.device_name);
end $$;
revoke all on function pos_activation_poll(text, text) from public, anon, authenticated;
grant execute on function pos_activation_poll(text, text) to service_role;

-- The device account exists: record the device and close the request.
create or replace function pos_activation_finish(p_request_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row        pos_device_requests;
  v_constraint text;
begin
  select * into v_row from pos_device_requests r where r.id = p_request_id for update;
  if not found or v_row.status <> 'approved' or v_row.activated_at is not null or v_row.claimed_at is null then
    raise exception 'This request cannot be finished';
  end if;
  begin
    if v_row.prints then                                             -- the outlet's printing tablet moves to this one
      update pos_devices set prints = false where branch_id = v_row.branch_id and prints and revoked_at is null;
    end if;
    insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by, approved_at)
    values (p_user_id, v_row.branch_id, v_row.kind, v_row.device_name, v_row.platform, v_row.prints, v_row.decided_by, v_row.decided_at);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'pos_devices_one_printer' then
      raise exception 'Another tablet just became the printing tablet — try again';
    end if;
    raise;
  end;
  update pos_device_requests set device_id = p_user_id, activated_at = now() where id = v_row.id;
end $$;
revoke all on function pos_activation_finish(uuid, uuid) from public, anon, authenticated;
grant execute on function pos_activation_finish(uuid, uuid) to service_role;

-- Creating the account failed: the next poll may try again.
create or replace function pos_activation_unclaim(p_request_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update pos_device_requests set claimed_at = null where id = p_request_id and activated_at is null;
end $$;
revoke all on function pos_activation_unclaim(uuid) from public, anon, authenticated;
grant execute on function pos_activation_unclaim(uuid) to service_role;

-- HQ: the requests waiting for a decision.
create or replace function pos_device_requests_pending()
returns table (id uuid, code text, name text, platform text, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not pos_is_hq() then raise exception 'Only HQ can approve devices'; end if;
  return query
    select r.id, r.code, r.name, r.platform, r.created_at, r.expires_at
      from pos_device_requests r
     where r.status = 'pending' and r.expires_at > now()
     order by r.created_at;
end $$;
revoke all on function pos_device_requests_pending() from public, anon;
grant execute on function pos_device_requests_pending() to authenticated;

-- HQ approves (outlet, kind, name, whether it is the printing tablet, and the code typed
-- from the tablet) or rejects.
create or replace function pos_decide_device_request(p_request_id uuid, p_approve boolean, p_code text,
                                                     p_branch_id uuid, p_kind text, p_name text,
                                                     p_prints boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row  pos_device_requests;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_name text := nullif(btrim(p_name), '');
begin
  if not pos_is_hq() then raise exception 'Only HQ can approve devices'; end if;
  if p_approve is null then raise exception 'Invalid request'; end if;
  select * into v_row from pos_device_requests r where r.id = p_request_id for update;
  if not found then raise exception 'Request not found'; end if;
  if v_row.status <> 'pending' or v_row.expires_at < now() then
    raise exception 'This request is no longer waiting';
  end if;
  if not p_approve then
    update pos_device_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = v_row.id;
    return;
  end if;
  if char_length(v_code) <> 6 or left(v_code, 3) || '-' || right(v_code, 3) <> v_row.code then
    raise exception 'The code does not match the tablet';
  end if;
  if p_branch_id is null or not exists (select 1 from branches b where b.id = p_branch_id) then
    raise exception 'Choose the outlet';
  end if;
  if p_kind is null or p_kind not in ('pos', 'print_agent') then raise exception 'Choose POS or Print agent'; end if;
  if v_name is null or char_length(v_name) > 40 then raise exception 'Enter the device name (up to 40 characters)'; end if;
  if coalesce(p_prints, false) and p_kind <> 'pos' then
    raise exception 'Only a POS tablet can print and hold the cash drawer';
  end if;
  update pos_device_requests
     set status = 'approved', branch_id = p_branch_id, kind = p_kind, device_name = v_name,
         prints = coalesce(p_prints, false), decided_by = auth.uid(), decided_at = now(),
         expires_at = least(expires_at, now() + interval '1 hour')     -- the device collects its login within the hour
   where id = v_row.id;
end $$;
revoke all on function pos_decide_device_request(uuid, boolean, text, uuid, text, text, boolean) from public, anon;
grant execute on function pos_decide_device_request(uuid, boolean, text, uuid, text, text, boolean) to authenticated;

-- ── D3. Devices in Craft OS ─────────────────────────────────────────────────
create or replace function pos_devices_list()
returns table (id uuid, name text, branch_id uuid, outlet_name text, kind text, platform text, prints boolean,
               approved_by_name text, approved_at timestamptz, last_seen_at timestamptz, revoked_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can see devices'; end if;
  return query
    select d.id, d.name, d.branch_id, b.name, d.kind, d.platform, d.prints, s.name, d.approved_at, d.last_seen_at, d.revoked_at
      from pos_devices d
      join branches b on b.id = d.branch_id
      left join staff s on s.id = d.approved_by
     where pos_manages_outlet(d.branch_id)
     order by d.revoked_at is not null, b.name, d.name;
end $$;
revoke all on function pos_devices_list() from public, anon;
grant execute on function pos_devices_list() to authenticated;

-- A manager of the device's outlet (HQ manages every outlet) unpairs it. Repeating it is a no-op.
create or replace function pos_unpair_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  if not pos_manages_outlet(v_dev.branch_id) then raise exception 'This device is not at one of your outlets'; end if;
  if v_dev.revoked_at is not null then return; end if;
  update pos_devices set revoked_at = now(), revoked_by = auth.uid(), prints = false where id = v_dev.id;
  update pos_staff_sessions set ended_at = now(), end_reason = 'unpaired' where device_id = v_dev.id and ended_at is null;
  -- a real date: Supabase Auth cannot read 'infinity' (sign-in then fails with unexpected_failure)
  update auth.users set banned_until = now() + interval '100 years' where id = v_dev.id;
end $$;
revoke all on function pos_unpair_device(uuid) from public, anon;
grant execute on function pos_unpair_device(uuid) to authenticated;

-- A manager of the outlet makes an active POS tablet the outlet's printing tablet.
create or replace function pos_set_print_tablet(p_device_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev        pos_devices;
  v_constraint text;
begin
  select * into v_dev from pos_devices d where d.id = p_device_id for update;
  if not found then raise exception 'Device not found'; end if;
  if not pos_manages_outlet(v_dev.branch_id) then raise exception 'This device is not at one of your outlets'; end if;
  if v_dev.kind <> 'pos' or v_dev.revoked_at is not null then raise exception 'Only an active POS tablet can print'; end if;
  if v_dev.prints then return; end if;
  begin
    update pos_devices set prints = false where branch_id = v_dev.branch_id and prints and revoked_at is null;
    update pos_devices set prints = true where id = v_dev.id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'pos_devices_one_printer' then
      raise exception 'Another tablet just became the printing tablet — try again';
    end if;
    raise;
  end;
end $$;
revoke all on function pos_set_print_tablet(uuid) from public, anon;
grant execute on function pos_set_print_tablet(uuid) to authenticated;

-- ── D4. Device context (internal; Part C's RPCs call these) ─────────────────
-- The caller must be an active POS device, at an open outlet, with an open staff session
-- of someone who may still work there. The error message is the code the app maps.
create or replace function pos_ctx(out device_id uuid, out branch_id uuid, out staff_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
  v_ses pos_staff_sessions;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null;
  if not found then raise exception 'device_unpaired'; end if;
  if not pos_outlet_open(v_dev.branch_id) then raise exception 'outlet_closed'; end if;
  select * into v_ses from pos_staff_sessions s where s.device_id = v_dev.id and s.ended_at is null;
  if not found then raise exception 'no_session'; end if;
  if not pos_staff_may_work(v_ses.staff_id, v_dev.branch_id) then raise exception 'access_changed'; end if;
  -- stamped at most every 30 s: every till call passes here
  update pos_devices set last_seen_at = now()
   where id = v_dev.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  update pos_staff_sessions set last_active_at = now()
   where id = v_ses.id and last_active_at < now() - interval '30 seconds';
  device_id := v_dev.id;
  branch_id := v_dev.branch_id;
  staff_id := v_ses.staff_id;
end $$;
revoke all on function pos_ctx() from public, anon, authenticated;

-- A printing device (POS or print agent) prints for its own outlet; no session needed.
create or replace function pos_print_branch() returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid;
begin
  select d.branch_id into v_branch from pos_devices d where d.id = auth.uid() and d.revoked_at is null;
  if v_branch is null then raise exception 'device_unpaired'; end if;
  update pos_devices set last_seen_at = now()
   where id = auth.uid() and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  return v_branch;
end $$;
revoke all on function pos_print_branch() from public, anon, authenticated;

-- ── D5. Staff sessions on a device ──────────────────────────────────────────
-- The lock screen: the device, its outlet, the signed-in person, and who may sign in here.
create or replace function pos_login_roster() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_dev  pos_devices;
  v_b    branches;
  v_open boolean;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null;
  if not found then raise exception 'device_unpaired'; end if;
  select * into v_b from branches b where b.id = v_dev.branch_id;
  v_open := pos_outlet_open(v_b.id);
  return jsonb_build_object(
    'device', jsonb_build_object('id', v_dev.id, 'name', v_dev.name, 'prints', v_dev.prints),
    'outlet', jsonb_build_object('id', v_b.id, 'name', v_b.name, 'kind', v_b.kind, 'opensOn', v_b.opens_on,
                                 'closesOn', v_b.closes_on, 'isActive', coalesce(v_b.is_active, false), 'open', v_open),
    'idleLockMinutes', coalesce((select ps.idle_lock_minutes from branch_pos_settings ps where ps.branch_id = v_b.id), 10),
    'session', (select jsonb_build_object('staffId', st.id, 'name', st.name)
                  from pos_staff_sessions s join staff st on st.id = s.staff_id
                 where s.device_id = v_dev.id and s.ended_at is null),
    'staff', case when v_open then coalesce((
               select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name,
                                                   'hasPin', exists (select 1 from staff_pos_pins p where p.staff_id = st.id))
                                order by st.name)
                 from staff st where pos_staff_may_work(st.id, v_b.id)), '[]'::jsonb)
             else '[]'::jsonb end);
end $$;
revoke all on function pos_login_roster() from public, anon;
grant execute on function pos_login_roster() to authenticated;

-- Tap a name, type the PIN. Refusals come back as { ok: false, code, error } so the try is
-- still recorded (a raise would roll it back). Locks in the order device → person → session
-- (as pos_ctx and pos_unpair_device): tries are serialized per device and per person.
create or replace function pos_start_session(p_staff_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev        pos_devices;
  v_hash       text;
  v_last_ok    timestamptz;
  v_wrong      integer;
  v_last_wrong timestamptz;
  v_name       text;
  v_id         uuid;
  v_locked     constant text := 'Too many tries. Try again in 10 minutes.';
begin
  select * into v_dev from pos_devices d where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null for update;
  if not found then raise exception 'device_unpaired'; end if;
  if not pos_outlet_open(v_dev.branch_id) then
    return jsonb_build_object('ok', false, 'code', 'outlet_closed', 'error', 'This outlet is not open for the POS today');
  end if;
  if not pos_staff_may_work(p_staff_id, v_dev.branch_id) then
    return jsonb_build_object('ok', false, 'code', 'not_allowed', 'error', 'This person cannot sign in here');
  end if;
  select st.name into v_name from staff st where st.id = p_staff_id for no key update;    -- one try at a time per person
  select p.pin_hash into v_hash from staff_pos_pins p where p.staff_id = p_staff_id;
  if v_hash is null then
    return jsonb_build_object('ok', false, 'code', 'no_pin', 'error', 'Set a PIN in Craft OS first');
  end if;
  select max(a.at) into v_last_ok from pos_login_attempts a where a.staff_id = p_staff_id and a.ok;
  select count(*), max(a.at) into v_wrong, v_last_wrong from pos_login_attempts a
   where a.staff_id = p_staff_id and not a.ok
     and a.at > greatest(coalesce(v_last_ok, '-infinity'::timestamptz), now() - interval '24 hours');
  if v_wrong >= 5 and v_last_wrong > now() - interval '10 minutes' then
    return jsonb_build_object('ok', false, 'code', 'pin_locked', 'error', v_locked);
  end if;
  if p_pin is null or p_pin !~ '^\d{4,6}$' or v_hash <> extensions.crypt(p_pin, v_hash) then
    insert into pos_login_attempts(staff_id, device_id, ok) values (p_staff_id, v_dev.id, false);
    v_wrong := v_wrong + 1;
    if v_wrong >= 5 then return jsonb_build_object('ok', false, 'code', 'pin_locked', 'error', v_locked); end if;
    return jsonb_build_object('ok', false, 'code', 'wrong_pin',
      'error', format('Wrong PIN · %s %s left', 5 - v_wrong, case when 5 - v_wrong = 1 then 'try' else 'tries' end));
  end if;
  insert into pos_login_attempts(staff_id, device_id, ok) values (p_staff_id, v_dev.id, true);
  update pos_devices set last_seen_at = now() where id = v_dev.id;
  update pos_staff_sessions set ended_at = now(), end_reason = 'switched' where device_id = v_dev.id and ended_at is null;
  insert into pos_staff_sessions(device_id, staff_id) values (v_dev.id, p_staff_id) returning id into v_id;
  return jsonb_build_object('ok', true, 'sessionId', v_id, 'staff', jsonb_build_object('id', p_staff_id, 'name', v_name));
end $$;
revoke all on function pos_start_session(uuid, text) from public, anon;
grant execute on function pos_start_session(uuid, text) to authenticated;

-- Lock (the staff member pressed Lock), idle (auto-lock), or access_changed (pos_ctx said so).
create or replace function pos_end_session(p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_dev pos_devices;
begin
  select * into v_dev from pos_devices d where d.id = auth.uid() and d.kind = 'pos' and d.revoked_at is null;
  if not found then raise exception 'device_unpaired'; end if;
  if p_reason is null or p_reason not in ('locked', 'idle', 'access_changed') then raise exception 'Invalid reason'; end if;
  update pos_staff_sessions set ended_at = now(), end_reason = p_reason where device_id = v_dev.id and ended_at is null;
end $$;
revoke all on function pos_end_session(text) from public, anon;
grant execute on function pos_end_session(text) to authenticated;

-- ── D6. POS settings → Lock ─────────────────────────────────────────────────
create or replace function save_lock_settings(p_branch_id uuid, p_idle_lock_minutes integer) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('access_settings') then raise exception 'Only a manager can change the lock settings'; end if;
  if not pos_manages_outlet(p_branch_id) then raise exception 'This outlet is not one of yours'; end if;
  if p_idle_lock_minutes is null or p_idle_lock_minutes not between 1 and 60 then
    raise exception 'Enter between 1 and 60 minutes';
  end if;
  insert into branch_pos_settings(branch_id) values (p_branch_id) on conflict (branch_id) do nothing;
  update branch_pos_settings set idle_lock_minutes = p_idle_lock_minutes, updated_at = now() where branch_id = p_branch_id;
end $$;
revoke all on function save_lock_settings(uuid, integer) from public, anon;
grant execute on function save_lock_settings(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
select 'pos devices applied' as result;
