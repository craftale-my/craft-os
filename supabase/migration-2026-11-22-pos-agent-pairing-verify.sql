-- Self-check for the print agent pairing (D). Run on craft-os-dev after
-- migration-2026-11-22-pos-agent-pairing.sql. Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections (one DO block each, ids in the temp table fixture): FIXTURE; P1 pos_agent_whoami; P2 what a print
-- agent reads (RLS); P3 what it claims and finishes.
-- Outlets VERIFY D A and VERIFY D B, a Bar route of kind agent on each and one test job each (queued from the
-- back office by the dev owner login); print agents on A and on B, a revoked agent on A, a POS tablet on A.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm is distinct from p_message then
      raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
    end if;
    return;
  end;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
end $$;
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;

-- ── FIXTURE ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_ag_a  uuid := 'eeeeeeee-0000-0000-0000-0000000d0a01';
  v_ag_b  uuid := 'eeeeeeee-0000-0000-0000-0000000d0b01';
  v_ag_r  uuid := 'eeeeeeee-0000-0000-0000-0000000d0a02';
  v_pos   uuid := 'eeeeeeee-0000-0000-0000-0000000d0a03';
  v_a uuid; v_b uuid;
begin
  -- the role defaults decide (owner: every outlet and access_settings)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY D A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY D B', 'b') returning id into v_b;
  insert into print_routes(branch_id, name, kind, address) values
    (v_a, 'Bar', 'agent', '127.0.0.1:9100'), (v_b, 'Bar', 'agent', '127.0.0.1:9100');
  insert into auth.users (id) values (v_ag_a), (v_ag_b), (v_ag_r), (v_pos);
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values
    (v_ag_a, v_a, 'print_agent', 'D Agent A', 'agent', false, v_owner),
    (v_ag_b, v_b, 'print_agent', 'D Agent B', 'agent', false, v_owner),
    (v_ag_r, v_a, 'print_agent', 'D Agent gone', 'agent', false, v_owner),
    (v_pos,  v_a, 'pos', 'D Counter', 'ipad', false, v_owner);
  update pos_devices set revoked_at = now(), revoked_by = v_owner where id = v_ag_r;
  perform pg_temp.put('a', v_a); perform pg_temp.put('b', v_b); perform pg_temp.put('owner', v_owner);
  perform pg_temp.put('ag_a', v_ag_a); perform pg_temp.put('ag_b', v_ag_b); perform pg_temp.put('ag_r', v_ag_r);
  perform pg_temp.put('pos', v_pos);
  perform pg_temp.act(v_owner);
  perform pg_temp.put('job_a', insert_test_print('Bar', v_a));
  perform pg_temp.put('job_b', insert_test_print('Bar', v_b));
end $$;

-- ── P1. pos_agent_whoami: an active print agent learns its outlet; nobody else gets an answer ──
do $$
declare
  v_who jsonb;
  r     record;
begin
  if has_function_privilege('anon', 'pos_agent_whoami()', 'execute') then raise exception 'FAIL P1 anon may call it'; end if;
  if not has_function_privilege('authenticated', 'pos_agent_whoami()', 'execute') then raise exception 'FAIL P1 authenticated may not'; end if;
  perform pg_temp.act(pg_temp.id('ag_a'));
  v_who := pos_agent_whoami();
  if (v_who->>'outletId')::uuid is distinct from pg_temp.id('a') or v_who->>'outletName' is distinct from 'VERIFY D A'
     or v_who->>'deviceName' is distinct from 'D Agent A' or (v_who->>'deviceId')::uuid is distinct from pg_temp.id('ag_a') then
    raise exception 'FAIL P1 agent A: %', v_who;
  end if;
  if (select last_seen_at from pos_devices where id = pg_temp.id('ag_a')) is null then raise exception 'FAIL P1 not stamped'; end if;
  for r in select * from (values ('ag_r', 'a revoked agent'), ('pos', 'a POS tablet'), ('owner', 'a staff login')) x(k, label) loop
    perform pg_temp.act(pg_temp.id(r.k));
    perform pg_temp.expect_error('select pos_agent_whoami()', 'device_unpaired', 'P1 ' || r.label);
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect_error('select pos_agent_whoami()', 'device_unpaired', 'P1 no login');
end $$;

-- ── P2. What a print agent reads: its outlet's routes and jobs, nothing of another outlet, never pos_devices ──
do $$
declare
  v_a     uuid := pg_temp.id('a');
  v_b     uuid := pg_temp.id('b');
  v_job_a uuid := pg_temp.id('job_a');
  v_job_b uuid := pg_temp.id('job_b');
  v_ag_a  uuid := pg_temp.id('ag_a');
  v_ag_r  uuid := pg_temp.id('ag_r');
  n_routes integer; n_jobs integer; n_jobs_a integer; v_err text;
begin
  perform pg_temp.act(v_ag_a);
  set local role authenticated;
  select count(*) into n_routes from print_routes where branch_id in (v_a, v_b);
  select count(*) into n_jobs from print_jobs where id in (v_job_a, v_job_b);
  select count(*) into n_jobs_a from print_jobs where id = v_job_a;
  begin
    perform 1 from pos_devices where id = v_ag_a;
    v_err := 'no error';
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  if n_routes <> 1 then raise exception 'FAIL P2 agent A reads % routes of A and B (expected 1)', n_routes; end if;
  if n_jobs <> 1 or n_jobs_a <> 1 then raise exception 'FAIL P2 agent A reads % jobs of A and B, % of A (expected 1, 1)', n_jobs, n_jobs_a; end if;
  if v_err is distinct from 'permission denied for table pos_devices' then raise exception 'FAIL P2 pos_devices read: %', v_err; end if;
  -- a revoked agent reads nothing
  perform pg_temp.act(v_ag_r);
  set local role authenticated;
  select count(*) into n_jobs from print_jobs where id in (v_job_a, v_job_b);
  reset role;
  if n_jobs <> 0 then raise exception 'FAIL P2 a revoked agent reads % jobs', n_jobs; end if;
end $$;

-- ── P3. Claims: own outlet only; finish; a revoked agent is refused ──
do $$
declare
  v_job_a uuid := pg_temp.id('job_a');
  v_job_b uuid := pg_temp.id('job_b');
begin
  perform pg_temp.act(pg_temp.id('ag_a'));
  if claim_print_job(v_job_b) then raise exception 'FAIL P3 agent A claimed outlet B''s job'; end if;
  if (select status from print_jobs where id = v_job_b) is distinct from 'pending' then raise exception 'FAIL P3 B''s job changed'; end if;
  if not claim_print_job(v_job_a) then raise exception 'FAIL P3 agent A could not claim its job'; end if;
  perform finish_print_job(v_job_a, true, null);
  if (select status from print_jobs where id = v_job_a) is distinct from 'printed' then raise exception 'FAIL P3 finish'; end if;
  perform pg_temp.act(pg_temp.id('ag_b'));
  if not claim_print_job(v_job_b) then raise exception 'FAIL P3 agent B could not claim its job'; end if;
  perform pg_temp.act(pg_temp.id('ag_r'));
  perform pg_temp.expect_error(format('select claim_print_job(%L)', v_job_b), 'device_unpaired', 'P3 a revoked agent');
end $$;

select 'VERIFY OK' as result;
rollback;
