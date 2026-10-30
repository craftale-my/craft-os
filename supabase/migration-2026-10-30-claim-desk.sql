-- ============================================================================
-- Claim Desk (2026-10-30). Idempotent — safe to run twice.
-- Reference: docs/claim-desk/ (prototype + 单据分类与入账指南.md)
--
-- 1. claims: Taobao / supplies claims carry CNY amount, rate, account and the
--    self-billed e-Invoice flag; the English claim PDF lives in claim-receipts.
-- 2. account_docs: the monthly Register (paper invoices, staff claims, received
--    MyInvois e-Invoices) with the 4 classification fields + voucher no.
-- 3. account_config / supplier_memory: chart of accounts with AutoCount codes,
--    and supplier → account memory.
-- 4. Capability manage_accounts (owner + admin by default; the owner can grant
--    it to another role in Settings → System Roles).
-- 5. Approved claims are copied into the Register by trigger.
-- 6. Private bucket account-docs for Register attachments.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. claims
-- ---------------------------------------------------------------------------
alter table claims add column if not exists source            text not null default 'manual';
alter table claims add column if not exists currency          text not null default 'MYR';
alter table claims add column if not exists foreign_amount    numeric(12,2);
alter table claims add column if not exists exchange_rate     numeric(12,6);
alter table claims add column if not exists rate_source       text;
alter table claims add column if not exists gl_account        text;
alter table claims add column if not exists self_billed_status text not null default 'not_required';
alter table claims add column if not exists details           jsonb not null default '{}'::jsonb;
alter table claims add column if not exists pdf_path          text;

alter table claims drop constraint if exists claims_claim_type_check;
alter table claims add  constraint claims_claim_type_check
  check (claim_type in ('transport','parking','meal','medical','phone','uniform','supplies','other'));

alter table claims drop constraint if exists claims_source_check;
alter table claims add  constraint claims_source_check
  check (source in ('manual','scan','taobao'));

alter table claims drop constraint if exists claims_self_billed_check;
alter table claims add  constraint claims_self_billed_check
  check (self_billed_status in ('not_required','pending','issued'));

alter table claims drop constraint if exists claims_foreign_check;
alter table claims add  constraint claims_foreign_check
  check (currency = 'MYR' or (foreign_amount is not null and exchange_rate > 0));

-- ---------------------------------------------------------------------------
-- 4. Capability (defined early: policies below use it)
-- ---------------------------------------------------------------------------
-- Same merge rule as the frontend (lookups.tsx buildRoleCaps): an explicit value
-- in system_role_permissions wins, otherwise the built-in default. Unlike
-- has_procurement_cap, an explicit false really does switch it off.
create or replace function has_accounts_cap() returns boolean
language sql security definer stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> 'manage_accounts')::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      s.system_role in ('owner','admin')
    )
    from staff s
    where s.id = auth.uid() and s.is_active
  ), false)
$$;

revoke execute on function has_accounts_cap() from public, anon;
grant  execute on function has_accounts_cap() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. account_docs (Register)
-- ---------------------------------------------------------------------------
create table if not exists account_docs (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,
  doc_type        text,
  platform        text,
  supplier        text,
  supplier_ref    text,
  doc_date        date not null default (now() at time zone 'Asia/Kuala_Lumpur')::date,
  currency        text not null default 'MYR',
  amount          numeric(14,2),
  rate            numeric(12,6),
  amount_myr      numeric(14,2),
  sst             numeric(14,2),
  description     text,
  gl_account      text,
  tax_treatment   text,
  payment         text,
  claimant        text,
  self_billed     text not null default 'Not required',
  self_billed_uuid text,
  voucher_no      text,
  status          text not null default 'Draft',
  notes           text,
  items           jsonb not null default '[]'::jsonb,
  files           jsonb not null default '[]'::jsonb,   -- [{bucket, path, name, type}]
  einvoice_uuid   text,
  einvoice        jsonb,                                -- MyInvois summary as received
  claim_id        uuid references claims(id) on delete set null,
  created_by      uuid references staff(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_by      uuid references staff(id) on delete set null,
  updated_at      timestamptz not null default now()
);

alter table account_docs drop constraint if exists account_docs_source_check;
alter table account_docs add  constraint account_docs_source_check
  check (source in ('paper','taobao','claim','einvoice'));

alter table account_docs drop constraint if exists account_docs_status_check;
alter table account_docs add  constraint account_docs_status_check
  check (status in ('Needs info','Draft','Reviewed','Posted to AutoCount','Cancelled'));

alter table account_docs drop constraint if exists account_docs_self_billed_check;
alter table account_docs add  constraint account_docs_self_billed_check
  check (self_billed in ('Not required','Required – pending','Issued'));

create unique index if not exists account_docs_einvoice_uuid_key on account_docs (einvoice_uuid) where einvoice_uuid is not null;
create unique index if not exists account_docs_claim_key         on account_docs (claim_id)      where claim_id is not null;
create unique index if not exists account_docs_voucher_key       on account_docs (voucher_no)    where voucher_no is not null and voucher_no <> '';
create index        if not exists account_docs_date_idx          on account_docs (doc_date desc);

alter table account_docs enable row level security;
revoke all on table account_docs from anon;

drop policy if exists "account_docs_all" on account_docs;
create policy "account_docs_all" on account_docs for all to authenticated
  using (has_accounts_cap()) with check (has_accounts_cap());

create or replace function account_docs_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  return new;
end;
$$;

drop trigger if exists account_docs_touch on account_docs;
create trigger account_docs_touch before update on account_docs
  for each row execute function account_docs_touch();

-- ---------------------------------------------------------------------------
-- 3. account_config + supplier_memory
-- ---------------------------------------------------------------------------
create table if not exists account_config (
  id          int primary key default 1 check (id = 1),
  accounts    jsonb not null default '[]'::jsonb,       -- [{name, code}]
  updated_at  timestamptz not null default now()
);

insert into account_config (id, accounts)
select 1, jsonb_agg(jsonb_build_object('name', n, 'code', '') order by o)
  from unnest(array[
    'Purchases (Cost of Sales)', 'Freight Inwards / Carriage Inwards', 'Packaging Materials',
    'Office Supplies & Stationery', 'Repair & Maintenance', 'Upkeep of Premises',
    'Transport & Delivery (Carriage Outwards)', 'Advertising & Promotion', 'Software & Subscriptions',
    'Telephone & Internet', 'Bank Charges', 'Payment Gateway / Merchant Fees',
    'Marketplace Commission & Fees (Shopee / Lazada)', 'Small Value Asset (≤ RM2,000)',
    'Fixed Asset – Equipment (PPE)', 'Staff Welfare', 'Entertainment', 'Sundry Expenses'
  ]) with ordinality as t(n, o)
on conflict (id) do nothing;

alter table account_config enable row level security;
revoke all on table account_config from anon;

-- Everyone signed in reads the account list (staff pick one on a Taobao claim).
drop policy if exists "account_config_read" on account_config;
create policy "account_config_read" on account_config for select to authenticated using (true);
drop policy if exists "account_config_write" on account_config;
create policy "account_config_write" on account_config for update to authenticated
  using (has_accounts_cap()) with check (has_accounts_cap());

create table if not exists supplier_memory (
  key           text primary key,                      -- lower-cased, punctuation stripped
  supplier      text not null,
  gl_account    text,
  tax_treatment text,
  platform      text,
  updated_at    timestamptz not null default now()
);

alter table supplier_memory enable row level security;
revoke all on table supplier_memory from anon;
drop policy if exists "supplier_memory_all" on supplier_memory;
create policy "supplier_memory_all" on supplier_memory for all to authenticated
  using (has_accounts_cap()) with check (has_accounts_cap());

-- ---------------------------------------------------------------------------
-- 5. Approved claims → Register
-- ---------------------------------------------------------------------------
-- Runs as definer: the approver (supervisor / HR) may not hold manage_accounts.
-- Any failure is downgraded to a warning so it can never block an approval.
create or replace function claims_to_register() returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_name   text;
  v_taobao boolean := new.source = 'taobao';
  v_files  jsonb := '[]'::jsonb;
begin
  begin
    if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
      select name into v_name from staff where id = new.staff_id;
      if new.pdf_path is not null then
        v_files := jsonb_build_array(jsonb_build_object('bucket','claim-receipts','path',new.pdf_path,'name',
          coalesce(nullif(new.details ->> 'pdf_name',''), 'claim.pdf'),'type','application/pdf'));
      elsif new.receipt_url is not null then
        v_files := jsonb_build_array(jsonb_build_object('url',new.receipt_url,'name','receipt'));
      end if;

      insert into account_docs (
        source, doc_type, platform, supplier, supplier_ref, doc_date, currency, amount, rate, amount_myr,
        description, gl_account, tax_treatment, payment, claimant, self_billed, status, notes, items, files, claim_id
      ) values (
        case when v_taobao then 'taobao' else 'claim' end,
        case when v_taobao then 'Foreign Purchase – Staff Expense Claim' else 'Cash Bill / Receipt' end,
        case when v_taobao then 'Taobao' else nullif(new.details ->> 'platform','') end,
        coalesce(nullif(new.details ->> 'seller',''), nullif(new.details ->> 'supplier',''),
                 case when v_taobao then 'Taobao seller' end),
        nullif(new.details ->> 'order_nos',''),
        new.claim_date,
        new.currency,
        coalesce(new.foreign_amount, new.amount),
        new.exchange_rate,
        new.amount,
        left(new.description, 500),
        new.gl_account,
        'Allowable expense (s33 ITA 1967)',
        'Staff-paid (Reimbursement)',
        v_name,
        case new.self_billed_status when 'pending' then 'Required – pending'
                                    when 'issued'  then 'Issued' else 'Not required' end,
        'Draft',
        'From staff claim (' || new.claim_type || ')',
        coalesce(new.details -> 'items', '[]'::jsonb),
        v_files,
        new.id
      )
      on conflict (claim_id) where claim_id is not null do update
        set status = case when account_docs.status = 'Cancelled' then 'Draft' else account_docs.status end;

    elsif new.status = 'rejected' and tg_op = 'UPDATE' and old.status = 'approved' then
      update account_docs set status = 'Cancelled',
             notes = trim(coalesce(notes,'') || ' [Claim rejected after approval]')
       where claim_id = new.id and status <> 'Posted to AutoCount';
    end if;
  exception when others then
    raise warning 'claims_to_register failed for claim %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists claims_to_register on claims;
create trigger claims_to_register after insert or update of status on claims
  for each row execute function claims_to_register();

-- ---------------------------------------------------------------------------
-- 6. Storage: private bucket for Register attachments
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('account-docs', 'account-docs', false)
on conflict (id) do nothing;

drop policy if exists "account_docs_files_all" on storage.objects;
create policy "account_docs_files_all" on storage.objects for all to authenticated
  using (bucket_id = 'account-docs' and has_accounts_cap())
  with check (bucket_id = 'account-docs' and has_accounts_cap());
