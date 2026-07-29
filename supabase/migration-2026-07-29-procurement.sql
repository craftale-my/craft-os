-- ============================================================================
-- Craft OS — Procurement & Inventory, Phase 1 (2026-07-29)
--
-- 在 dev Supabase 项目的 SQL editor 里整份执行。幂等 — 可重复运行。
-- 对应设计文档:docs/superpowers/specs/2026-07-29-procurement-inventory-design.md
--
-- 结构:
--   Part 1: 权限辅助函数
--   Part 2: 主数据 (suppliers, items)
--   Part 3: 采购单 (purchase_orders, purchase_order_items) + 单号生成
--   Part 4: 收货 (receivings, receiving_items)
--   Part 5: 价格历史 (item_price_history)
--   Part 6: 库存 (inventory_transactions + inventory_balances view)
--   Part 7: 收货事务 RPC (submit_receiving)
--   Part 8: RLS 策略
--   Part 9: Storage bucket
-- ============================================================================


-- ── Part 1: 权限辅助函数 ─────────────────────────────────────────────────────

-- 当前用户的分店。
create or replace function current_branch_id() returns uuid
language sql security definer stable as $$
  select branch_id from staff where id = auth.uid()
$$;

-- 采购能力检查。内置默认值镜像 src/shared/types/index.ts 的
-- DEFAULT_SYSTEM_ROLE_CAPS;Owner 在 Settings → System Roles 里显式打开某能力
-- (存进 system_role_permissions)时 RLS 也跟着放行。
--
-- 注意:矩阵里「关掉」某能力只影响前端 UI,不会收紧 RLS —— 代码默认值不在 SQL
-- 里,DB 侧无法完整复现「默认 + 覆盖」的合并语义。刻意取舍,见设计文档第一节。
create or replace function has_procurement_cap(p_cap text) returns boolean
language sql security definer stable as $$
  select coalesce((
    select
      -- Owner 在能力矩阵里的显式 true
      coalesce((
        select (srp.permissions ->> p_cap)::boolean
        from system_role_permissions srp
        where srp.system_role = s.system_role
      ), false)
      or
      -- 内置默认
      case p_cap
        when 'manage_procurement' then
          s.system_role in ('owner','admin','manager') or s.rank = 'manager'
        when 'use_procurement' then
          s.system_role in ('owner','admin','manager','supervisor')
          or s.rank in ('manager','supervisor')
        else false
      end
    from staff s
    where s.id = auth.uid()
  ), false)
$$;

-- 分店访问检查。全分店角色恒真;其余只能访问自己 branch_id 的数据。
create or replace function can_access_branch(p_branch_id uuid) returns boolean
language sql security definer stable as $$
  select coalesce((
    select
      (s.system_role in ('owner','admin','manager','hr') or s.rank = 'manager')
      or (s.branch_id is not null and s.branch_id = p_branch_id)
    from staff s
    where s.id = auth.uid()
  ), false)
$$;


-- ── Part 2: 主数据 ───────────────────────────────────────────────────────────

create table if not exists suppliers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  contact_person text,
  phone          text,
  whatsapp       text,
  email          text,
  address        text,
  payment_terms  text,
  status         text not null default 'active'
                   check (status in ('active','inactive')),
  created_at     timestamptz not null default now()
);

-- Phase 2 会加成品/半成品 (finished, semi_finished) 到 category。
create table if not exists items (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  name_zh         text,
  category        text not null default 'raw'
                    check (category in ('raw','packaging','other')),
  supplier_id     uuid references suppliers(id) on delete set null,
  purchase_unit   text not null,                  -- 采购单位:包 / 箱 / 桶
  base_unit       text not null,                  -- 基础单位:g / kg / ml / L / pcs
  conversion_rate numeric not null default 1
                    check (conversion_rate > 0),   -- 1 采购单位 = X 基础单位
  latest_price    numeric check (latest_price >= 0),
  min_stock_alert numeric not null default 0
                    check (min_stock_alert >= 0),  -- 基础单位
  status          text not null default 'active'
                    check (status in ('active','inactive')),
  created_at      timestamptz not null default now()
);

create index if not exists items_supplier_idx on items (supplier_id);


-- ── Part 3: 采购单 ───────────────────────────────────────────────────────────

create table if not exists purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  po_number    text not null unique,
  supplier_id  uuid not null references suppliers(id),
  branch_id    uuid not null references branches(id),
  created_by   uuid references staff(id),
  status       text not null default 'draft'
                 check (status in ('draft','sent','partially_received','received','cancelled')),
  total_amount numeric not null default 0,
  notes        text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

create index if not exists purchase_orders_branch_status_idx
  on purchase_orders (branch_id, status);

create table if not exists purchase_order_items (
  id                uuid primary key default gen_random_uuid(),
  po_id             uuid not null references purchase_orders(id) on delete cascade,
  item_id           uuid not null references items(id),
  quantity_ordered  numeric not null check (quantity_ordered > 0),  -- 采购单位
  unit_price        numeric not null default 0 check (unit_price >= 0),
  received_quantity numeric not null default 0,
  shortage_quantity numeric not null default 0
);

create index if not exists purchase_order_items_po_idx on purchase_order_items (po_id);

-- 单号 PO-YYYYMMDD-XXX。advisory lock 序列化同一天的并发插入,避免撞号。
create or replace function next_po_number() returns text
language plpgsql security definer as $$
declare
  v_date text := to_char(now() at time zone 'Asia/Kuala_Lumpur', 'YYYYMMDD');
  v_seq  int;
begin
  perform pg_advisory_xact_lock(hashtext('po_number_' || v_date));
  -- 'PO-YYYYMMDD-XXX' → 序号从第 13 个字符开始
  select coalesce(max(substring(po_number from 13)::int), 0) + 1
    into v_seq
    from purchase_orders
   where po_number like 'PO-' || v_date || '-%';
  return 'PO-' || v_date || '-' || lpad(v_seq::text, 3, '0');
end;
$$;

create or replace function set_po_number() returns trigger
language plpgsql as $$
begin
  if NEW.po_number is null or NEW.po_number = '' then
    NEW.po_number := next_po_number();
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_set_po_number on purchase_orders;
create trigger trg_set_po_number before insert on purchase_orders
  for each row execute function set_po_number();


-- ── Part 4: 收货 ─────────────────────────────────────────────────────────────

create table if not exists receivings (
  id                uuid primary key default gen_random_uuid(),
  po_id             uuid not null references purchase_orders(id) on delete cascade,
  received_by       uuid references staff(id),
  received_at       timestamptz not null default now(),
  invoice_photo_url text not null,          -- 必填
  goods_photo_url   text,
  notes             text,
  has_discrepancy   boolean not null default false
);

-- Phase 1: 一张 PO 只收一次。短缺记录后关单,不支持分批到货。
create unique index if not exists receivings_one_per_po on receivings (po_id);

create table if not exists receiving_items (
  id                uuid primary key default gen_random_uuid(),
  receiving_id      uuid not null references receivings(id) on delete cascade,
  po_item_id        uuid not null references purchase_order_items(id) on delete cascade,
  expected_quantity numeric not null,                              -- = PO 下单数量
  actual_quantity   numeric not null check (actual_quantity >= 0), -- 实收
  shortage          numeric not null default 0,
  unit_price        numeric not null default 0 check (unit_price >= 0)  -- 本次 invoice 单价
);

create index if not exists receiving_items_receiving_idx on receiving_items (receiving_id);


-- ── Part 5: 价格历史 ─────────────────────────────────────────────────────────

create table if not exists item_price_history (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null references items(id) on delete cascade,
  price        numeric not null check (price >= 0),
  recorded_at  timestamptz not null default now(),
  source       text not null default 'manual'
                 check (source in ('receiving','manual')),
  receiving_id uuid references receivings(id) on delete set null
);

create index if not exists item_price_history_item_idx
  on item_price_history (item_id, recorded_at);


-- ── Part 6: 库存 ─────────────────────────────────────────────────────────────

-- quantity 一律基础单位,入正出负。Phase 2 会加 production/sales/wastage/stocktake。
create table if not exists inventory_transactions (
  id               uuid primary key default gen_random_uuid(),
  item_id          uuid not null references items(id),
  branch_id        uuid not null references branches(id),
  transaction_type text not null
                     check (transaction_type in ('stock_in','adjustment')),
  quantity         numeric not null,
  reference_type   text,        -- 'receiving' | 'manual'
  reference_id     uuid,
  created_by       uuid references staff(id),
  created_at       timestamptz not null default now(),
  notes            text
);

create index if not exists inventory_transactions_item_branch_idx
  on inventory_transactions (item_id, branch_id, created_at);

-- 余额不单独存表,按 item + branch 汇总。
-- cross join 保证零库存物料也出现(否则新物料在库存页看不到,也无从比警戒线)。
--
-- security_invoker = true 必须加:视图默认以 owner 权限执行会绕过底层表 RLS,
-- supervisor 的分店过滤就失效了。
drop view if exists inventory_balances;
create view inventory_balances with (security_invoker = true) as
select
  i.id                       as item_id,
  b.id                       as branch_id,
  coalesce(sum(t.quantity), 0) as balance
from items i
cross join branches b
left join inventory_transactions t
       on t.item_id = i.id and t.branch_id = b.id
where i.status = 'active'
  and b.is_active
group by i.id, b.id;


-- ── Part 7: 收货事务 RPC ─────────────────────────────────────────────────────

-- 收货要一次性完成 5 件事(receiving / receiving_items / inventory_transactions /
-- item_price_history + latest_price / PO 状态)。Supabase JS 没有客户端事务,分开
-- 写一旦中途失败就会留下「库存加了但 PO 还是 sent」的脏数据 —— 所以整个操作收敛
-- 成这一个 security definer 函数,跑在单个事务里。
--
-- p_lines 形如:[{"po_item_id":"uuid","actual_quantity":10,"unit_price":45.00}, ...]
create or replace function submit_receiving(
  p_po_id             uuid,
  p_invoice_photo_url text,
  p_goods_photo_url   text,
  p_notes             text,
  p_lines             jsonb
) returns uuid
language plpgsql security definer as $$
declare
  v_receiving_id    uuid;
  v_branch_id       uuid;
  v_status          text;
  v_has_discrepancy boolean := false;
  v_line            jsonb;
  v_po_item         purchase_order_items%rowtype;
  v_actual          numeric;
  v_price           numeric;
  v_shortage        numeric;
  v_conv            numeric;
begin
  -- 锁住 PO 行,防止并发重复收货(配合 receivings(po_id) 唯一索引)
  select branch_id, status into v_branch_id, v_status
    from purchase_orders where id = p_po_id
    for update;

  if not found then
    raise exception 'Purchase order not found';
  end if;

  if not has_procurement_cap('use_procurement') or not can_access_branch(v_branch_id) then
    raise exception 'Not authorised to receive against this purchase order';
  end if;

  if v_status <> 'sent' then
    raise exception 'Purchase order must be in "sent" status to receive (current: %)', v_status;
  end if;

  if coalesce(p_invoice_photo_url, '') = '' then
    raise exception 'Invoice photo is required';
  end if;

  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then
    raise exception 'At least one line is required';
  end if;

  insert into receivings (po_id, received_by, invoice_photo_url, goods_photo_url, notes)
  values (p_po_id, auth.uid(), p_invoice_photo_url,
          nullif(p_goods_photo_url, ''), nullif(p_notes, ''))
  returning id into v_receiving_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_po_item
      from purchase_order_items
     where id = (v_line->>'po_item_id')::uuid
       and po_id = p_po_id;

    if not found then
      raise exception 'PO line % does not belong to this purchase order', v_line->>'po_item_id';
    end if;

    v_actual := (v_line->>'actual_quantity')::numeric;
    v_price  := coalesce((v_line->>'unit_price')::numeric, v_po_item.unit_price);

    if v_actual is null or v_actual < 0 then
      raise exception 'Received quantity must be zero or more';
    end if;

    v_shortage := greatest(v_po_item.quantity_ordered - v_actual, 0);
    if v_shortage > 0 then
      v_has_discrepancy := true;
    end if;

    insert into receiving_items
      (receiving_id, po_item_id, expected_quantity, actual_quantity, shortage, unit_price)
    values
      (v_receiving_id, v_po_item.id, v_po_item.quantity_ordered, v_actual, v_shortage, v_price);

    -- 注意:不覆盖 purchase_order_items.unit_price —— 那是下单时谈好的价,
    -- 留着才能跟 invoice 实际价对比。
    update purchase_order_items
       set received_quantity = v_actual,
           shortage_quantity = v_shortage
     where id = v_po_item.id;

    select conversion_rate into v_conv from items where id = v_po_item.item_id;

    -- 换算成基础单位入库
    if v_actual > 0 then
      insert into inventory_transactions
        (item_id, branch_id, transaction_type, quantity, reference_type, reference_id, created_by)
      values
        (v_po_item.item_id, v_branch_id, 'stock_in', v_actual * v_conv,
         'receiving', v_receiving_id, auth.uid());
    end if;

    insert into item_price_history (item_id, price, source, receiving_id)
    values (v_po_item.item_id, v_price, 'receiving', v_receiving_id);

    update items set latest_price = v_price where id = v_po_item.item_id;
  end loop;

  update receivings set has_discrepancy = v_has_discrepancy where id = v_receiving_id;

  update purchase_orders
     set status = case when v_has_discrepancy then 'partially_received' else 'received' end
   where id = p_po_id;

  return v_receiving_id;
end;
$$;

revoke all on function submit_receiving(uuid, text, text, text, jsonb) from public;
grant execute on function submit_receiving(uuid, text, text, text, jsonb) to authenticated;


-- ── Part 8: RLS ──────────────────────────────────────────────────────────────

alter table suppliers              enable row level security;
alter table items                  enable row level security;
alter table item_price_history     enable row level security;
alter table purchase_orders        enable row level security;
alter table purchase_order_items   enable row level security;
alter table receivings             enable row level security;
alter table receiving_items        enable row level security;
alter table inventory_transactions enable row level security;

-- Suppliers / Items:采购用户可读(下单需要),仅管理员可写。
drop policy if exists "suppliers_select" on suppliers;
create policy "suppliers_select" on suppliers for select to authenticated
  using (has_procurement_cap('use_procurement'));
drop policy if exists "suppliers_manage" on suppliers;
create policy "suppliers_manage" on suppliers for all to authenticated
  using (has_procurement_cap('manage_procurement'))
  with check (has_procurement_cap('manage_procurement'));

drop policy if exists "items_select" on items;
create policy "items_select" on items for select to authenticated
  using (has_procurement_cap('use_procurement'));
drop policy if exists "items_manage" on items;
create policy "items_manage" on items for all to authenticated
  using (has_procurement_cap('manage_procurement'))
  with check (has_procurement_cap('manage_procurement'));

-- 价格历史:采购用户可读;手工补录仅管理员。收货写入走 RPC(security definer)。
drop policy if exists "item_price_history_select" on item_price_history;
create policy "item_price_history_select" on item_price_history for select to authenticated
  using (has_procurement_cap('use_procurement'));
drop policy if exists "item_price_history_insert" on item_price_history;
create policy "item_price_history_insert" on item_price_history for insert to authenticated
  with check (has_procurement_cap('manage_procurement') and source = 'manual');

-- 采购单:按分店隔离。
drop policy if exists "purchase_orders_select" on purchase_orders;
create policy "purchase_orders_select" on purchase_orders for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

drop policy if exists "purchase_orders_insert" on purchase_orders;
create policy "purchase_orders_insert" on purchase_orders for insert to authenticated
  with check (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

-- 只有未收货的单能直接改(draft → sent、cancel、编辑内容)。received /
-- partially_received 的状态转换由 submit_receiving RPC 完成(security definer,
-- 绕过 RLS),所以这里不必也不应该放开已收货的单。
drop policy if exists "purchase_orders_update" on purchase_orders;
create policy "purchase_orders_update" on purchase_orders for update to authenticated
  using (
    has_procurement_cap('use_procurement')
    and can_access_branch(branch_id)
    and status in ('draft','sent')
  )
  with check (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

-- 只有 draft 能删,且限本人或管理员。
drop policy if exists "purchase_orders_delete" on purchase_orders;
create policy "purchase_orders_delete" on purchase_orders for delete to authenticated
  using (
    status = 'draft'
    and can_access_branch(branch_id)
    and (created_by = auth.uid() or has_procurement_cap('manage_procurement'))
  );

-- 明细跟随父单的分店范围:可读范围 = 父单可读范围。
drop policy if exists "purchase_order_items_all" on purchase_order_items;
drop policy if exists "purchase_order_items_select" on purchase_order_items;
create policy "purchase_order_items_select" on purchase_order_items for select to authenticated
  using (
    exists (
      select 1 from purchase_orders p
      where p.id = po_id
        and has_procurement_cap('use_procurement')
        and can_access_branch(p.branch_id)
    )
  );

-- 但写入只允许在未收货的单上 —— 否则能改掉已收货单据的明细,库存流水就对不上账了。
-- 收货时对明细的更新走 submit_receiving RPC。
drop policy if exists "purchase_order_items_write" on purchase_order_items;
create policy "purchase_order_items_write" on purchase_order_items for all to authenticated
  using (
    exists (
      select 1 from purchase_orders p
      where p.id = po_id
        and has_procurement_cap('use_procurement')
        and can_access_branch(p.branch_id)
        and p.status in ('draft','sent')
    )
  )
  with check (
    exists (
      select 1 from purchase_orders p
      where p.id = po_id
        and has_procurement_cap('use_procurement')
        and can_access_branch(p.branch_id)
        and p.status in ('draft','sent')
    )
  );

-- 收货记录:只读。写入一律走 submit_receiving RPC,保证库存流水永远有来源单据。
drop policy if exists "receivings_select" on receivings;
create policy "receivings_select" on receivings for select to authenticated
  using (
    exists (
      select 1 from purchase_orders p
      where p.id = po_id
        and has_procurement_cap('use_procurement')
        and can_access_branch(p.branch_id)
    )
  );

drop policy if exists "receiving_items_select" on receiving_items;
create policy "receiving_items_select" on receiving_items for select to authenticated
  using (
    exists (
      select 1
        from receivings r
        join purchase_orders p on p.id = r.po_id
       where r.id = receiving_id
         and has_procurement_cap('use_procurement')
         and can_access_branch(p.branch_id)
    )
  );

-- 库存流水:按分店可读;stock_in 只能由 RPC 写入,手工调整仅管理员。
-- (Phase 1 没有调整 UI,策略先放着以免日后被锁死。)
drop policy if exists "inventory_transactions_select" on inventory_transactions;
create policy "inventory_transactions_select" on inventory_transactions for select to authenticated
  using (has_procurement_cap('use_procurement') and can_access_branch(branch_id));

drop policy if exists "inventory_transactions_adjust" on inventory_transactions;
create policy "inventory_transactions_adjust" on inventory_transactions for insert to authenticated
  with check (
    has_procurement_cap('manage_procurement')
    and can_access_branch(branch_id)
    and transaction_type = 'adjustment'
  );


-- ── Part 9: Storage ──────────────────────────────────────────────────────────

-- public bucket,与现有 claim-receipts / leave-attachments 一致。
-- 注意:invoice 照片含供应商报价,public 意味着知道 URL 就能看。路径带 UUID 不可猜。
-- Phase 2 建议整体改私有 bucket + signed URL。
insert into storage.buckets (id, name, public)
values ('receiving-photos', 'receiving-photos', true)
on conflict (id) do nothing;

drop policy if exists "receiving_photos_read" on storage.objects;
create policy "receiving_photos_read" on storage.objects for select
  using (bucket_id = 'receiving-photos');

drop policy if exists "receiving_photos_write" on storage.objects;
create policy "receiving_photos_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'receiving-photos' and has_procurement_cap('use_procurement'));
