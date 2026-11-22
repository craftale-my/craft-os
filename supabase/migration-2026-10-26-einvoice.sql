-- ============================================================================
-- Craft OS — MyInvois e-Invoice skeleton (2026-10-26): schema and functions.
-- Run on craft-os-dev after every earlier POS migration (hardening included).
-- Idempotent — safe to re-run.
-- Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md
--
-- New: einvoice_settings (one row: the company as the supplier), einvoice_documents,
-- einvoice_bill_links and einvoice_refund_links (a bill or refund sits in one live
-- document only), and three service-role-only functions the Edge Function `einvoice`
-- calls: einvoice_bill_source, einvoice_unlinked_paid_bills, einvoice_create_document.
-- Clients only read (owner/admin/manager through access_settings); every write goes
-- through the Edge Function, which holds the MyInvois credentials.
-- ============================================================================

do $$ begin
  if to_regclass('public.bills') is null or to_regclass('public.refunds') is null then
    raise exception 'STOP: run the POS ordering and checkout migrations first';
  end if;
  if to_regprocedure('public.has_menu_cap(text)') is null then
    raise exception 'STOP: has_menu_cap(text) is missing — run migration-2026-10-24-pos-checkout-fixes.sql first';
  end if;
end $$;

-- ── The company as the supplier on every document ──────────────────────────
create table if not exists einvoice_settings (
  id                 boolean primary key default true check (id),
  environment        text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  supplier_name      text,
  supplier_tin       text,
  supplier_brn       text,
  supplier_sst_no    text not null default 'NA',
  supplier_ttx_no    text not null default 'NA',
  msic_code          text check (msic_code ~ '^[0-9]{5}$'),
  business_activity  text,
  address_line       text,
  city               text,
  postcode           text,
  state_code         text check (state_code ~ '^(0[1-9]|1[0-7])$'),   -- LHDN state codes 01–17
  country_code       text not null default 'MYS',
  phone              text,
  email              text,
  updated_at         timestamptz not null default now()
);
insert into einvoice_settings (id) values (true) on conflict (id) do nothing;

-- ── Documents sent (or about to be sent) to MyInvois ───────────────────────
create table if not exists einvoice_documents (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('invoice', 'credit_note', 'consolidated_invoice', 'consolidated_credit_note')),
  environment     text not null check (environment in ('sandbox', 'production')),
  branch_id       uuid not null references branches(id),
  code_number     text not null unique,                 -- our document ID, sent as Invoice.ID and codeNumber
  bill_id         uuid references bills(id),            -- invoice / credit_note: the one bill
  period_start    date,                                  -- consolidated: Malaysia-time month covered
  period_end      date,
  buyer           jsonb,                                 -- null = General Public
  total_sen       integer not null,
  status          text not null default 'draft'
                  check (status in ('draft', 'submitted', 'valid', 'invalid', 'rejected', 'cancelled')),
  payload         jsonb,                                 -- the UBL JSON exactly as submitted
  submission_uid  text,
  lhdn_uuid       text unique,
  long_id         text,                                  -- with lhdn_uuid makes the validation link on the receipt
  errors          jsonb,
  created_by      uuid references staff(id),
  created_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  validated_at    timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists einvoice_documents_branch_idx on einvoice_documents(branch_id, created_at desc);
create index if not exists einvoice_documents_pending_idx on einvoice_documents(status) where status = 'submitted';

-- A bill or refund is covered by at most one live document. Rejected or invalid
-- documents give theirs back (the Edge Function deletes the links).
create table if not exists einvoice_bill_links (
  bill_id      uuid primary key references bills(id),
  document_id  uuid not null references einvoice_documents(id) on delete cascade
);
create index if not exists einvoice_bill_links_doc_idx on einvoice_bill_links(document_id);

create table if not exists einvoice_refund_links (
  refund_id    uuid primary key references refunds(id),
  document_id  uuid not null references einvoice_documents(id) on delete cascade
);
create index if not exists einvoice_refund_links_doc_idx on einvoice_refund_links(document_id);

-- ── RLS: owner/admin/manager read; settings also editable by them ──────────
do $$
declare t text;
begin
  foreach t in array array['einvoice_settings','einvoice_documents','einvoice_bill_links','einvoice_refund_links']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists einvoice_read on %I', t);
    execute format('create policy einvoice_read on %I for select to authenticated using (has_menu_cap(''access_settings''))', t);
  end loop;
end $$;
drop policy if exists einvoice_settings_write on einvoice_settings;
create policy einvoice_settings_write on einvoice_settings for update to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));

-- ── One bill, as the single-invoice builder needs it ───────────────────────
-- { bill: {id, branchId, billNo, status, closedAt, totalSen}, totals, items: [{name, qty, unitPriceSen, sstRateBp}] }
-- totals is the snapshot checkout_bill stored; older bills fall back to pos_bill_totals.
create or replace function einvoice_bill_source(p_bill_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'bill', jsonb_build_object('id', b.id, 'branchId', b.branch_id, 'billNo', b.bill_no, 'status', b.status,
                               'closedAt', b.closed_at, 'totalSen', b.total_sen),
    'totals', coalesce(b.totals, pos_bill_totals(b.id)),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', oi.name_snapshot, 'qty', oi.qty,
                                          'unitPriceSen', oi.unit_price_sen, 'sstRateBp', oi.sst_rate_bp)
                       order by oi.id)
        from order_items oi where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb))
  from bills b where b.id = p_bill_id
$$;
revoke all on function einvoice_bill_source(uuid) from public, anon, authenticated;
grant execute on function einvoice_bill_source(uuid) to service_role;

-- ── A branch's paid bills in one Malaysia-time month with no live document ─
create or replace function einvoice_unlinked_paid_bills(p_branch_id uuid, p_month date)
returns table (id uuid, bill_no text, day date, totals jsonb, total_sen integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select b.id, b.bill_no, (b.closed_at at time zone 'Asia/Kuala_Lumpur')::date,
         coalesce(b.totals, pos_bill_totals(b.id)), b.total_sen
    from bills b
   where b.branch_id = p_branch_id
     and b.status = 'paid'
     and b.closed_at >= (date_trunc('month', p_month)::timestamp at time zone 'Asia/Kuala_Lumpur')
     and b.closed_at <  ((date_trunc('month', p_month) + interval '1 month')::timestamp at time zone 'Asia/Kuala_Lumpur')
     and not exists (select 1 from einvoice_bill_links l where l.bill_id = b.id)
   order by b.closed_at, b.bill_no
$$;
revoke all on function einvoice_unlinked_paid_bills(uuid, date) from public, anon, authenticated;
grant execute on function einvoice_unlinked_paid_bills(uuid, date) to service_role;

-- ── Create a draft document and claim its bills in one transaction ─────────
-- p_doc: { kind, environment, branchId, billId?, periodStart?, periodEnd?, buyer?, totalSen, createdBy? }
-- A bill already linked to a live document makes the whole call fail: nothing is
-- reported twice. code_number = INV|CN|CON|CCN-<YYMMDD MYT>-<6 hex>.
create or replace function einvoice_create_document(p_doc jsonb, p_bill_ids uuid[], p_refund_ids uuid[])
returns einvoice_documents
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id   uuid := gen_random_uuid();
  v_kind text := p_doc->>'kind';
  v_row  einvoice_documents;
begin
  insert into einvoice_documents (id, kind, environment, branch_id, code_number, bill_id,
                                  period_start, period_end, buyer, total_sen, created_by)
  values (v_id, v_kind, p_doc->>'environment', (p_doc->>'branchId')::uuid,
          case v_kind when 'invoice' then 'INV' when 'credit_note' then 'CN'
                      when 'consolidated_invoice' then 'CON' else 'CCN' end
            || '-' || to_char(now() at time zone 'Asia/Kuala_Lumpur', 'YYMMDD')
            || '-' || upper(substr(replace(v_id::text, '-', ''), 1, 6)),
          (p_doc->>'billId')::uuid, (p_doc->>'periodStart')::date, (p_doc->>'periodEnd')::date,
          case when jsonb_typeof(p_doc->'buyer') = 'object' then p_doc->'buyer' end,
          (p_doc->>'totalSen')::integer, (p_doc->>'createdBy')::uuid)
  returning * into v_row;

  begin
    insert into einvoice_bill_links (bill_id, document_id)
    select unnest(coalesce(p_bill_ids, '{}')), v_id;
    insert into einvoice_refund_links (refund_id, document_id)
    select unnest(coalesce(p_refund_ids, '{}')), v_id;
  exception when unique_violation then
    raise exception 'A bill or refund in this document already has a live e-invoice';
  end;
  return v_row;
end $$;
revoke all on function einvoice_create_document(jsonb, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function einvoice_create_document(jsonb, uuid[], uuid[]) to service_role;
