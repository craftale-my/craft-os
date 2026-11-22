-- ============================================================================
-- Craft OS — MyInvois e-invoice W5: the daily job (2026-11-23). Run on craft-os-dev after
-- migration-2026-11-23-einvoice-w5.sql, once the Edge Function `einvoice` is deployed and the two Vault secrets
-- exist (plan Task 8). Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-23-einvoice-w5.md
-- Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md (W5.4)
--
-- E7  pg_net. einvoice_call_job(action) POSTs {"action": run | reconcile} to the Edge Function with header
--     x-einvoice-job-secret; the URL and the secret are read from Vault (einvoice_function_url,
--     einvoice_job_secret) and never written here. pg_cron calls it every day at 23:00 UTC = 07:00 Malaysia
--     time (job einvoice-daily). The response lands in net._http_response (kept 6 hours).
-- ============================================================================

do $$ begin
  if to_regclass('public.einvoice_job_runs') is null then
    raise exception 'STOP: run migration-2026-11-23-einvoice-w5.sql first (einvoice_job_runs is missing)';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'STOP: enable pg_cron first (Database → Extensions)';
  end if;
  if (select count(*) from vault.secrets where name in ('einvoice_job_secret', 'einvoice_function_url')) <> 2 then
    raise exception 'STOP: add the Vault secrets einvoice_job_secret and einvoice_function_url first';
  end if;
end $$;

create extension if not exists pg_net;

create or replace function einvoice_call_job(p_action text default 'run') returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url    text;
  v_secret text;
begin
  if p_action is null or p_action not in ('run', 'reconcile') then
    raise exception 'einvoice_call_job: the action is run or reconcile';
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'einvoice_function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'einvoice_job_secret';
  if v_url is null or v_secret is null then
    raise exception 'einvoice_call_job: the Vault secrets einvoice_function_url and einvoice_job_secret are missing';
  end if;
  return net.http_post(
    url := v_url,
    body := jsonb_build_object('action', p_action),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-einvoice-job-secret', v_secret),
    timeout_milliseconds := 120000);
end $$;
revoke all on function einvoice_call_job(text) from public, anon, authenticated;

-- 23:00 UTC = 07:00 Malaysia time, after the 1st's business day of the old month has closed (06:00).
-- cron.schedule with a job name replaces that job's schedule and command.
select cron.schedule('einvoice-daily', '0 23 * * *', 'select public.einvoice_call_job(''run'')');

notify pgrst, 'reload schema';
select 'einvoice w5 cron applied' as result;
