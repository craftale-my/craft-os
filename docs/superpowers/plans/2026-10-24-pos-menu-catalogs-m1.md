# POS · Menu catalogs M1 — Catalogs in ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every order is priced from a menu catalog. A branch prices dine-in, takeaway and QR orders from the catalogs set on POS settings; at the counter the cashier can switch a whole order to one of the branch's additional catalogs (Staff Meal, Grab Food, …) and sees that catalog's products and prices; the server re-checks the catalog, the product's availability in it and its prices, and records `orders.catalog_id`. All ten Feedme catalogs are imported from the export with their own products, prices and add-on prices. A new capability **Edit menu** (`manage_menu`, owner and admin) guards every menu write.

**Architecture:** One schema migration adds `menu_catalogs`, `catalog_products`, `catalog_variant_prices`, `catalog_option_prices`, `branch_catalogs` and `orders.catalog_id`, moves every menu write policy to `has_menu_cap('manage_menu')`, limits sold-out writes to the caller's branch, and backfills catalog **Craft Cafe** from today's menu on every active branch. One functions migration adds the internal resolver `pos_order_catalog` (the spec §3 refusals, word for word) and re-creates `pos_insert_order` (9 arguments), `place_counter_order` (+ `p_catalog_id uuid default null`), `place_table_order`, `qr_menu` (same JSON shape) and `menu_import` from their live text; it adds `save_branch_catalogs`, `menu_set_catalog_product` and `menu_import_catalogs`. On the client a pure `catalogs.ts` decides the default and the selectable catalogs, `buildPosMenu` reads availability and prices from the catalog, the order pad gets a catalog selector, a queued order carries an optional `catalogId`, POS settings gets a "Menu catalogs" section, `/menu/import` reads every sheet of the export and `/menu` edits a catalog's availability.

**Tech Stack:** React 19 + Vite 6 + TypeScript + Tailwind, Supabase (Postgres RLS, plpgsql `security definer` RPCs, Realtime), Vitest. No ESLint config in the repo; the gates are `npx tsc -b` and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md` — §2, §3, §6, §7, §8-M1, §9 (M1 items) and §10 bind this plan. Builds on Sub-plans 1–3 on `feature/pos-demo` (`docs/superpowers/plans/2026-10-22-pos-phase1-menu.md`, `2026-10-23-pos-phase1-ordering.md`, `2026-10-24-pos-phase1-checkout.md`). **Out of scope (M2 / M3):** `product_schedules` and every time-slot check, photos and the `menu-images` bucket, `menu_save_product`, `menu_save_group`, the four editor pages.

## Spec deltas (decided while planning, 2026-10-24)

- **"Not in a catalog" has two spellings:** no `catalog_products` row, or a row with `availability = 'hidden'`. Taking a product out of a catalog (on `/menu`, or a re-import that no longer lists it) sets `hidden`; the row and its prices stay, so nothing is deleted and putting it back restores its prices.
- **Resolver and words.** `pos_order_catalog(branch, order_type, source, requested)` is internal. Role = `qr` for QR orders, else the order type. Refusals: `This catalog is not available at this branch` (not the default for this order type and not one of the branch's `additional` catalogs, an additional catalog asked for on QR, or the catalog is inactive) and `No menu catalog is set for dine-in|takeaway|QR — set it in POS settings`. A resend (known `client_order_id`) is answered before the catalog is checked, as before.
- **The pad picks a catalog by itself only when it is the order type's active default**, and only from the branch's catalogs fetched for that opening of the pad (never a list loaded earlier). With no usable default it shows why — `No menu catalog is set for dine-in — set it in POS settings`, or `The dine-in catalog <name> is switched off — choose another in POS settings` — and the cashier may still pick an additional catalog on purpose; it never falls back to one silently.
- **The counter sends the chosen catalog's id**, the default included (the cashier saw that catalog's prices). An offline order queued before a manager changed the branch's default is therefore refused on flush and lands in the Rejected strip; "Edit" reopens it with its catalog. `null` (orders queued before M1, older app builds) = the branch's default for the order type.
- **A variant without a price in the order's catalog is not for sale in it** (`Item is not available: <product>`); the pad and QR leave it out. The spec says every active variant of a product in a catalog has a price; the import and `menu_set_catalog_product` keep that true, this rule covers variants added later.
- **Option availability stays on `modifier_options`** (master); only option prices are per catalog. Feedme's per-catalog "Order from" on variant rows (3 variants of included products are `NONE` in the export) and on add-on rows is not modelled.
- **Add-on links come from the `Default Catalog` column only.** The real export's 37 `itemLinkedAddon` sheets carry no other catalog column (checked 2026-10-24), so the "links that differ" report is empty for it; the parser still compares any catalog column it finds.
- **`menu_set_catalog_product(catalog, product, availability)`** is a small M1 RPC for `/menu` (put in → pre-fill missing prices from the default price; `hidden` → out). M2's `menu_save_product` replaces it.
- **`save_branch_catalogs` needs all three defaults** (`Choose the dine-in|takeaway|QR catalog`) and replaces the branch's rows in one go (they are settings; orders keep their own `catalog_id`). `branch_catalogs` also has a direct-write policy limited to a manager of that branch, as the settings tables of Sub-plan 3.
- **Catalog tables are written by `manage_menu` holders with insert and update policies only** (no delete policy), ready for M2; M1 writes them through the RPCs.
- **The order pad is never offline-cached** (unchanged): switching catalog reloads the menu from the server.
- **Leaving the catalog of an edited order that the branch no longer offers** keeps the lines the new catalog also sells ("Items not in <catalog> were removed") instead of clearing the cart; every other switch clears it after the confirm.
- **A switched-off catalog on POS settings:** a default that points at one is shown "(inactive)" and must be changed before saving; a ticked additional one is shown "(inactive)" so it can be unticked, and Save leaves it out, so it never blocks saving.
- **Rejected-strip names** come from `fetchProductNames()` (all active products) instead of a menu, since a stuck order may be from any catalog; the strip also names the order's catalog.
- **Task order differs from the suggested shape:** catalog-aware menu loading (Task 4) comes first, then POS settings (Task 5) and the import (Task 6), so the counter selector (Task 7) can be checked in the browser against the real Staff Meal and Grab Food catalogs.

## Global Constraints

- **Dev database first.** Every SQL file here is applied on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) by the controller from the owner's Chrome tab on the dashboard SQL editor; prod (`yfsoesxzurzjdwstszru`) is a separate, later step the owner decides. The migrations run on prod **before** any main deploy that carries this code. Seeds never run on prod. The worktree's `.env.local` points at dev.
- Every step that reads or writes the dev database is marked **(controller, craft-os-dev — …; the implementer does not touch the database)**; implementers run only local commands (`grep`, `npx tsc -b`, `npx vitest run`) and commit.
- All UI copy, field names and error messages in English (`english-product-copy` rule); code comments may be Chinese or English, matching the surrounding file.
- Money is integer sen. **The client sends ids only, never a price**: `place_counter_order` gets product, variant and option ids plus `p_catalog_id`; the server prices every line from the catalog and snapshots it on `order_items`. The server is the truth; client prices are a preview.
- Sub-plan 3's money rules are untouched: totals work on the snapshotted `order_items.unit_price_sen`, and the 22 vectors in `src/features/pos/checkout/billVectors.json` (and their copy in the checkout verify script) do not change.
- Every `security definer` function pins `set search_path = public, pg_temp`, revokes execute from `public, anon` (internal helpers also from `authenticated`) and grants only what is needed.
- A staff member counts as live only when `is_active and status = 'active'` (`pos_my_branch`, `pos_caller_branch`, `has_menu_cap`, `staff_has_cap`).
- **Capabilities:** `has_menu_cap(p_cap)` / `staff_has_cap(staff_id, cap)` mirror `buildRoleCaps` over `DEFAULT_SYSTEM_ROLE_CAPS` (the Owner's override in `system_role_permissions` wins). New: `manage_menu` = "Edit menu", default owner and admin. Menu-table writes and the menu RPCs need `manage_menu`; branch catalogs need `access_settings` for the caller's own branch; sold-out stays open to any live staff member, own branch only.
- **Nothing is hard-deleted:** products, variants, groups, options, categories and catalogs are deactivated; a product leaves a catalog as `hidden`. (`menu_import` still replaces the add-on options of the groups it imports, as since Sub-plan 1; their catalog prices go with them and the same import writes them again.)
- Migrations are idempotent (`if not exists`, constraints added by name only when missing, `create or replace`, `drop policy if exists`).
- **Re-run hazard.** Re-running an older migration puts back older definitions: `2026-10-22-pos-menu.sql` (has_menu_cap without the live-staff rule and `manage_menu`, menu edit policies on `access_settings`), `2026-10-22-pos-menu-import-fn.sql` (`menu_import` on `access_settings`), `2026-10-23-pos-ordering.sql` (sold-out writable for any branch), `2026-10-23-pos-ordering-fn.sql` / `2026-10-24-pos-checkout-fn.sql` (the old `qr_menu`, `place_table_order`, and an **old-signature twin** of `pos_insert_order` / `place_counter_order` next to the new one — PostgREST then cannot choose), `2026-10-24-pos-checkout*.sql` (has_menu_cap without `manage_menu`). After any such re-run, re-run `migration-2026-10-24-pos-checkout-fixes.sql`, then `migration-2026-10-24-pos-catalogs.sql` and `migration-2026-10-24-pos-catalogs-fn.sql`, in that order.
- **`branch_catalogs` has a direct-write policy for M2's sake only** (a manager of the branch). M1 writes it only through `save_branch_catalogs`, which validates; `pos_order_catalog` re-checks every order anyway, so a row written over REST cannot price an order from an inactive or foreign catalog.
- **Seeds that create a branch:** a branch created after the schema migration has no catalogs and refuses every order. After running a POS seed that creates a branch (e.g. `seed-2026-10-23-pos-demo-branch.sql` on a rebuilt dev database), re-run `migration-2026-10-24-pos-catalogs.sql`: its backfill gives the new branch Craft Cafe for dine-in, takeaway and QR.
- **No import on prod before the M1 client is deployed.** Between running the M1 SQL and the deploy, the old `/menu/import` calls `menu_import` alone: new products land in no catalog (so they cannot be sold) and re-created add-on options drop every catalog add-on price.
- Every write whose success is shown to a user goes through `writeOutcome` (`src/shared/lib/db-write.ts`) with `.select()`, or is an RPC whose error is thrown. Each settings section shows its outcome next to its own Save button (the Sub-plan 3 lesson).
- `tsconfig` has `noUnusedLocals` / `noUnusedParameters`: remove an import the moment it is no longer used.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Several sessions share the stash stack: never use a bare `git stash`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-24-pos-catalogs.sql` | Catalog tables, `orders.catalog_id`, RLS, `has_menu_cap` / `staff_has_cap` with `manage_menu` (canonical), menu and sold-out write policies, Craft Cafe backfill (Task 1) |
| `supabase/migration-2026-10-24-pos-catalogs-fn.sql` | `pos_order_catalog`; re-created `pos_insert_order`, `place_counter_order`, `place_table_order`, `qr_menu`, `menu_import`; new `save_branch_catalogs`, `menu_set_catalog_product`, `menu_import_catalogs` (Task 2) |
| `supabase/migration-2026-10-24-pos-catalogs-verify.sql` | Self-check of both files, rolled back (Task 3) |
| `supabase/migration-2026-10-22-pos-menu-verify.sql`, `-2026-10-23-pos-ordering-verify.sql`, `-2026-10-24-pos-checkout-verify.sql` | Edited for M1's intended changes: catalog fixtures, new signatures, A2 scope (Task 3) |
| `src/shared/types/index.ts`, `src/shared/types/capabilities.test.ts` | Capability `manage_menu` / "Edit menu" (Task 1) |
| `src/features/pos/order/catalogs.ts` (+test) | Pure: default catalog per order type, the pad's catalog list, settings form helpers, the server's words (Task 4) |
| `src/features/pos/order/cart.ts` (+test) | `buildPosMenu` takes the catalog's rows: availability, order, variant and add-on prices (Task 4) |
| `src/features/pos/order/posApi.ts` | `fetchPosMenu(branchId, catalogId)`, `fetchBranchCatalogs`, `saveBranchCatalogs`, `sendCounterOrder` with the catalog (Tasks 4, 5, 7) |
| `src/features/pos/order/OrderPad.tsx`, `PosPage.tsx` | Catalog selector, branch catalogs loaded on open and on every pad open, rejected orders keep their catalog (Tasks 4, 7) |
| `src/features/pos/offline/orderQueue.ts` (+test) | `QueuedOrder.catalogId?`, `counterOrderArgs` (Task 7) |
| `src/features/pos/order/rejectedOrder.ts` (+test) | `padFromRejected` (Task 7) |
| `src/features/pos/order/MenuCatalogsSection.tsx`, `PosSettingsPage.tsx` | POS settings → Menu catalogs (Task 5) |
| `src/features/pos/menu/feedmeExport.ts` (+test) | `buildCatalogsImport`: master from the Default sheets, one catalog per other sheet (Task 6) |
| `src/features/pos/menu/importView.ts` (+test), `MenuImportPage.tsx`, `menuApi.ts` | Per-catalog counts, master warning, typed confirmation, `importFeedme`, `countCatalogs` (Task 6) |
| `src/features/pos/menu/menuView.ts` (+test), `MenuPage.tsx`, `menuApi.ts`, `src/App.tsx`, `src/shared/lib/nav.ts` (+test) | `/menu` gated by `manage_menu`, catalog picker, availability per catalog (Task 8) |

`useOrderQueue.ts`, the QR app (`qr/`, `src/qr/QrApp.tsx`) and `posMenuFromQr` do not change: the queue hands the whole `QueuedOrder` to `sendCounterOrder`, and `qr_menu` keeps its JSON shape.

---

### Task 1: Catalog schema, `manage_menu`, policies and the Craft Cafe backfill (SQL + the capability in TypeScript, one commit)

**Files:**
- Create: `supabase/migration-2026-10-24-pos-catalogs.sql`
- Modify: `src/shared/types/index.ts` (Capability, CAPABILITIES, DEFAULT_SYSTEM_ROLE_CAPS)
- Test: `src/shared/types/capabilities.test.ts`

**Interfaces:**
- Consumes: `has_menu_cap` / `staff_has_cap` / `pos_caller_branch` as last defined in `supabase/migration-2026-10-24-pos-checkout-fixes.sql`; `menu_products`, `menu_variants`, `modifier_options` (Sub-plan 1); `branches`, `orders`, `branch_menu_status` (Sub-plan 2).
- Produces (later tasks select by these exact names):
  - `menu_catalogs(id, name unique, is_active, sort_order, feedme_catalog_name unique null, created_at)`
  - `catalog_products(catalog_id, product_id, availability 'all'|'counter_only'|'hidden', sort_order)` pk `(catalog_id, product_id)`
  - `catalog_variant_prices(catalog_id, variant_id, price_sen ≥ 0)` pk; `catalog_option_prices(catalog_id, option_id, price_delta_sen ≥ 0)` pk
  - `branch_catalogs(branch_id, role 'dine_in'|'takeaway'|'qr'|'additional', catalog_id)` pk `(branch_id, role, catalog_id)`; unique index `branch_catalogs_one_per_role` on `(branch_id, role) where role <> 'additional'`
  - `orders.catalog_id uuid` → `menu_catalogs` (constraint `orders_catalog_id_fkey`)
  - RLS: `menu_read` (select, authenticated) on all five; `<table>_insert` / `<table>_update` on the four company-wide tables gated on `has_menu_cap('manage_menu')`; `branch_catalogs_manage` (all) = own branch + `access_settings`; `menu_products_edit` / `menu_variants_edit` on `manage_menu`; `branch_menu_status_write` = `branch_id = pos_caller_branch()`
  - `has_menu_cap('manage_menu')`, `staff_has_cap(id, 'manage_menu')`: owner, admin; TS `Capability` `'manage_menu'`, label `Edit menu`
  - catalog `Craft Cafe` (`feedme_catalog_name = 'Craft Cafe'`) assigned to every active branch (a null `branches.is_active` counts as active) as `dine_in`, `takeaway`, `qr`

- [ ] **Step 1: Write the failing test.** Replace `src/shared/types/capabilities.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { CAPABILITIES, DEFAULT_SYSTEM_ROLE_CAPS, SYSTEM_ROLES } from './index'

describe('capabilities', () => {
  it('every role has a default for every capability in the matrix', () => {
    for (const role of SYSTEM_ROLES) {
      for (const c of CAPABILITIES) expect(typeof DEFAULT_SYSTEM_ROLE_CAPS[role][c.key], `${role}.${c.key}`).toBe('boolean')
    }
  })

  it('pos_supervise is in the System Roles matrix with its label', () => {
    expect(CAPABILITIES.find((c) => c.key === 'pos_supervise')?.label).toBe('Approve POS voids & refunds')
  })

  it('pos_supervise defaults match has_menu_cap / staff_has_cap in SQL', () => {
    expect(Object.fromEntries(SYSTEM_ROLES.map((r) => [r, DEFAULT_SYSTEM_ROLE_CAPS[r].pos_supervise]))).toEqual({
      owner: true, admin: true, hr: false, manager: true, supervisor: true, staff: false,
    })
  })

  it('manage_menu is in the System Roles matrix as "Edit menu"', () => {
    expect(CAPABILITIES.find((c) => c.key === 'manage_menu')?.label).toBe('Edit menu')
  })

  it('manage_menu defaults match has_menu_cap / staff_has_cap in SQL: owner and admin only', () => {
    expect(Object.fromEntries(SYSTEM_ROLES.map((r) => [r, DEFAULT_SYSTEM_ROLE_CAPS[r].manage_menu]))).toEqual({
      owner: true, admin: true, hr: false, manager: false, supervisor: false, staff: false,
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/shared/types/capabilities.test.ts` — Expected: FAIL, 2 failed (no `manage_menu` in `CAPABILITIES`, defaults `undefined`).

- [ ] **Step 3: Implement in TypeScript.** In `src/shared/types/index.ts` make exactly these replacements (each old text occurs once):

1. Replace

```ts
  | 'pos_supervise'    // approve POS voids & refunds with a PIN (SQL: has_menu_cap / staff_has_cap)
```

   with

```ts
  | 'pos_supervise'    // approve POS voids & refunds with a PIN (SQL: has_menu_cap / staff_has_cap)
  | 'manage_menu'      // edit the company-wide menu and its catalogs (SQL: has_menu_cap / staff_has_cap)
```

2. Replace

```ts
  { key: 'pos_supervise',       label: 'Approve POS voids & refunds' },
]
```

   with

```ts
  { key: 'pos_supervise',       label: 'Approve POS voids & refunds' },
  { key: 'manage_menu',         label: 'Edit menu' },
]
```

3. In `DEFAULT_SYSTEM_ROLE_CAPS` add one line after each role's `pos_supervise` line — the six old texts and their replacements:

| Old text (3 lines) | New text |
|---|---|
| `    pos_supervise: true,` / `  },` / `  admin: {` | `    pos_supervise: true,` / `    manage_menu: true,` / `  },` / `  admin: {` |
| `    pos_supervise: true,` / `  },` / `  hr: {` | `    pos_supervise: true,` / `    manage_menu: true,` / `  },` / `  hr: {` |
| `    pos_supervise: false,` / `  },` / `  manager: {` | `    pos_supervise: false,` / `    manage_menu: false,` / `  },` / `  manager: {` |
| `    pos_supervise: true,` / `  },` / `  supervisor: {` | `    pos_supervise: true,` / `    manage_menu: false,` / `  },` / `  supervisor: {` |
| `    pos_supervise: true,` / `  },` / `  staff: {` | `    pos_supervise: true,` / `    manage_menu: false,` / `  },` / `  staff: {` |
| `    pos_supervise: false,` / `  },` / `}` | `    pos_supervise: false,` / `    manage_menu: false,` / `  },` / `}` |

   (`/` separates lines. Result: owner and admin `true`; hr, manager, supervisor, staff `false`. Settings → System Roles shows the new column with no change to `Settings.tsx`, because it renders `CAPABILITIES`.)

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/shared/types` — Expected: PASS (`capabilities.test.ts` 5 tests). Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 5: Write the migration** `supabase/migration-2026-10-24-pos-catalogs.sql`:

```sql
-- ============================================================================
-- Craft OS — POS menu catalogs · M1 schema, permissions and backfill (2026-10-24)
-- Run on craft-os-dev after every earlier POS migration, INCLUDING
-- migration-2026-10-24-pos-checkout-fixes.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m1.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §2, §7
--
-- This file is now the canonical definition of has_menu_cap and staff_has_cap
-- (the checkout-fixes version plus manage_menu) and of the write policies on
-- menu_products, menu_variants and branch_menu_status. Re-running an older
-- migration that defines them (2026-10-22-pos-menu, 2026-10-23-pos-ordering,
-- 2026-10-24-pos-checkout, 2026-10-24-pos-checkout-fixes) puts the older versions
-- back — re-run this file and migration-2026-10-24-pos-catalogs-fn.sql afterwards.
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_caller_branch()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-checkout-fixes.sql first (pos_caller_branch is missing)';
  end if;
end $$;

-- ── Capability manage_menu ("Edit menu"): owner and admin by default ────────
-- The checkout-fixes rule (live staff only: is_active and status = 'active'; the
-- Owner's setting in system_role_permissions wins over the default) plus one
-- branch. Mirrors buildRoleCaps (src/shared/lib/lookups.tsx) over
-- DEFAULT_SYSTEM_ROLE_CAPS (src/shared/types/index.ts) — change the three together.
create or replace function has_menu_cap(p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        when 'manage_menu'     then s.system_role in ('owner','admin')
        else false
      end)
    from staff s
    where s.id = auth.uid() and s.is_active and s.status = 'active'
  ), false)
$$;

-- The same rule for any staff member. Internal.
create or replace function staff_has_cap(p_staff_id uuid, p_cap text) returns boolean
language sql security definer stable set search_path = public, pg_temp as $$
  select coalesce((
    select coalesce(
      (select (srp.permissions ->> p_cap)::boolean
         from system_role_permissions srp
        where srp.system_role = s.system_role),
      case p_cap
        when 'access_settings' then s.system_role in ('owner','admin','manager')
        when 'pos_supervise'   then s.system_role in ('owner','admin','manager','supervisor')
        when 'manage_menu'     then s.system_role in ('owner','admin')
        else false
      end)
    from staff s
    where s.id = p_staff_id and s.is_active and s.status = 'active'
  ), false)
$$;
revoke all on function staff_has_cap(uuid, text) from public, anon, authenticated;

-- ── Tables ──────────────────────────────────────────────────────────────────
-- A catalog picks products from the master list, each with its own channel and
-- price. Nothing here is ever deleted: a catalog is deactivated, a product is
-- set to 'hidden' in it. (The cascades only serve menu_import, which re-creates
-- the add-on options of every group it imports.)
create table if not exists menu_catalogs (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique check (length(trim(name)) between 1 and 60),
  is_active            boolean not null default true,
  sort_order           integer not null default 0,
  feedme_catalog_name  text unique,                                    -- the Feedme sheet it is imported from
  created_at           timestamptz not null default now()
);

create table if not exists catalog_products (
  catalog_id    uuid not null references menu_catalogs(id) on delete cascade,
  product_id    uuid not null references menu_products(id) on delete cascade,
  availability  text not null default 'all' check (availability in ('all', 'counter_only', 'hidden')),
  sort_order    integer not null default 0,
  primary key (catalog_id, product_id)
);
create index if not exists catalog_products_product_idx on catalog_products(product_id);

create table if not exists catalog_variant_prices (
  catalog_id  uuid not null references menu_catalogs(id) on delete cascade,
  variant_id  uuid not null references menu_variants(id) on delete cascade,
  price_sen   integer not null check (price_sen >= 0),
  primary key (catalog_id, variant_id)
);
create index if not exists catalog_variant_prices_variant_idx on catalog_variant_prices(variant_id);

-- no row = the option's own price_delta_sen
create table if not exists catalog_option_prices (
  catalog_id       uuid not null references menu_catalogs(id) on delete cascade,
  option_id        uuid not null references modifier_options(id) on delete cascade,
  price_delta_sen  integer not null check (price_delta_sen >= 0),
  primary key (catalog_id, option_id)
);
create index if not exists catalog_option_prices_option_idx on catalog_option_prices(option_id);

-- which catalog a branch prices each order type from, plus the catalogs a cashier may switch to
create table if not exists branch_catalogs (
  branch_id   uuid not null references branches(id),
  role        text not null check (role in ('dine_in', 'takeaway', 'qr', 'additional')),
  catalog_id  uuid not null references menu_catalogs(id),
  primary key (branch_id, role, catalog_id)
);
create unique index if not exists branch_catalogs_one_per_role on branch_catalogs(branch_id, role) where role <> 'additional';

-- the catalog an order was priced from (null on orders placed before M1)
alter table orders add column if not exists catalog_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_catalog_id_fkey') then
    alter table orders add constraint orders_catalog_id_fkey foreign key (catalog_id) references menu_catalogs(id);
  end if;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every signed-in staff member reads the catalogs (the QR page reads only through
-- qr_menu). The company-wide catalog tables are written by Edit menu holders —
-- insert and update only; branch_catalogs by a manager of that branch.
do $$
declare t text;
begin
  foreach t in array array['menu_catalogs','catalog_products','catalog_variant_prices',
                           'catalog_option_prices','branch_catalogs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists menu_read on %I', t);
    execute format('create policy menu_read on %I for select to authenticated using (true)', t);
  end loop;
  foreach t in array array['menu_catalogs','catalog_products','catalog_variant_prices','catalog_option_prices']
  loop
    execute format('drop policy if exists %I on %I', t || '_insert', t);
    execute format('create policy %I on %I for insert to authenticated with check (has_menu_cap(''manage_menu''))',
                   t || '_insert', t);
    execute format('drop policy if exists %I on %I', t || '_update', t);
    execute format('create policy %I on %I for update to authenticated using (has_menu_cap(''manage_menu'')) with check (has_menu_cap(''manage_menu''))',
                   t || '_update', t);
  end loop;
end $$;

drop policy if exists branch_catalogs_manage on branch_catalogs;
create policy branch_catalogs_manage on branch_catalogs for all to authenticated
  using      (branch_id = pos_caller_branch() and has_menu_cap('access_settings'))
  with check (branch_id = pos_caller_branch() and has_menu_cap('access_settings'));

-- /menu edits of the master list need Edit menu now (was access_settings)
drop policy if exists menu_products_edit on menu_products;
create policy menu_products_edit on menu_products for update to authenticated
  using (has_menu_cap('manage_menu')) with check (has_menu_cap('manage_menu'));
drop policy if exists menu_variants_edit on menu_variants;
create policy menu_variants_edit on menu_variants for update to authenticated
  using (has_menu_cap('manage_menu')) with check (has_menu_cap('manage_menu'));

-- sold-out: any live staff member, for their own branch only (was: any branch)
drop policy if exists branch_menu_status_write on branch_menu_status;
create policy branch_menu_status_write on branch_menu_status for all to authenticated
  using (branch_id = pos_caller_branch()) with check (branch_id = pos_caller_branch());

-- ── Backfill: catalog "Craft Cafe" from today's menu, once ──────────────────
-- So ordering keeps working before any re-import: the products that are not
-- hidden today, at today's prices. Skipped when the catalog already exists.
do $$
declare v_id uuid;
begin
  if not exists (select 1 from menu_catalogs where feedme_catalog_name = 'Craft Cafe' or name = 'Craft Cafe') then
    insert into menu_catalogs(name, feedme_catalog_name, sort_order) values ('Craft Cafe', 'Craft Cafe', 0)
    returning id into v_id;
    insert into catalog_products(catalog_id, product_id, availability, sort_order)
    select v_id, p.id, p.availability, p.sort_order
      from menu_products p where p.is_active and p.availability <> 'hidden';
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
    select v_id, v.id, v.price_sen
      from menu_variants v join catalog_products cp on cp.catalog_id = v_id and cp.product_id = v.product_id
     where v.is_active;
  end if;
end $$;

-- every active branch without a catalog for dine-in, takeaway or QR gets Craft Cafe for it
insert into branch_catalogs(branch_id, role, catalog_id)
select b.id, r.role, c.id
  from branches b
  cross join (values ('dine_in'), ('takeaway'), ('qr')) as r(role)
  join menu_catalogs c on c.feedme_catalog_name = 'Craft Cafe' and c.is_active
 where coalesce(b.is_active, true)                      -- branches.is_active is nullable; null counts as active
   and not exists (select 1 from branch_catalogs bc where bc.branch_id = b.id and bc.role = r.role);

select 'catalogs schema applied' as result;
```

- [ ] **Step 6: Local checks.** Run: `grep -c "when 'manage_menu'" supabase/migration-2026-10-24-pos-catalogs.sql` — Expected: `2`. Run: `grep -c "has_menu_cap('access_settings')" supabase/migration-2026-10-24-pos-catalogs.sql` — Expected: `2` (only `branch_catalogs_manage`). Run: `grep -n "for delete\|for all" supabase/migration-2026-10-24-pos-catalogs.sql` — Expected: exactly two lines, `branch_catalogs_manage` and `branch_menu_status_write`. Run: `npx vitest run` — Expected: all pass. The migration is applied on dev by the controller in Task 3.

- [ ] **Step 7: Commit**

```bash
git add supabase/migration-2026-10-24-pos-catalogs.sql src/shared/types/index.ts src/shared/types/capabilities.test.ts
git commit -m "feat(pos-menu): catalog tables, Edit menu capability, own-branch sold-out, Craft Cafe backfill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Catalog-aware ordering, QR menu, branch-catalog settings and the multi-catalog import (SQL functions)

**Files:**
- Create: `supabase/migration-2026-10-24-pos-catalogs-fn.sql`

**Interfaces:**
- Consumes: Task 1 tables and `has_menu_cap('manage_menu')`; `pos_my_branch()`, `pos_next_bill_no(uuid)` (Sub-plans 2–3); the live text of `pos_insert_order`, `place_counter_order`, `place_table_order` (`supabase/migration-2026-10-24-pos-checkout-fn.sql`), `qr_menu` (`supabase/migration-2026-10-23-pos-ordering-fn.sql`), `menu_import` (`supabase/migration-2026-10-22-pos-menu-import-fn.sql`).
- Produces (called by Tasks 3–8):
  - `pos_order_catalog(p_branch_id uuid, p_order_type text, p_source text, p_catalog_id uuid) returns uuid` — internal; raises `This catalog is not available at this branch` / `No menu catalog is set for dine-in|takeaway|QR — set it in POS settings`
  - `pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, p_catalog_id uuid) returns uuid` — internal; the old 8-argument signature is dropped
  - `place_counter_order(p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb, p_client_order_id uuid, p_catalog_id uuid default null) returns uuid` — staff; the old 5-argument signature is dropped; a call without `p_catalog_id` still works
  - `place_table_order(text, integer, jsonb, uuid)` — anon + staff, unchanged signature, priced from the branch's `qr` catalog
  - `qr_menu(text) returns jsonb` — same shape as before (`tableLabel, paused, needsPax, categories[{name, products[{id, name, description, soldOut, variants[{id, name, priceSen, isBase}], groups[{id, name, min, max, options[{id, name, priceDeltaSen, isDefault, available}]}]}]}]`), from the `qr` catalog, `availability = 'all'` only
  - `save_branch_catalogs(p jsonb) returns void` — `p = { dineIn, takeaway, qr: uuid, additional: uuid[] }`; `access_settings`, caller's branch; words `Only a manager can change the menu catalogs`, `Choose the dine-in|takeaway|QR catalog`, `This catalog is not available — refresh and try again`, `Invalid catalog settings`
  - `menu_set_catalog_product(p_catalog_id uuid, p_product_id uuid, p_availability text) returns void` — `manage_menu`; `Not allowed to edit the menu`, `Invalid availability`, `Catalog not found`, `Product not found`
  - `menu_import(jsonb)` — now `manage_menu`, otherwise unchanged
  - `menu_import_catalogs(p_payload jsonb) returns jsonb` — `manage_menu`; payload = `CatalogsImport` (Task 6): `menu_import`'s keys plus `catalogs: [{ name, sortOrder, products: [{ feedmeId, availability: 'all'|'counter_only', sortOrder, prices: [{ key, priceSen }] }], optionPrices: [{ groupFeedmeId, productFeedmeId, variantKey, priceSen }] }]`; returns `menu_import`'s counts plus `catalogs: [{ name, products, prices, optionPrices }]`; words `Not allowed to import the menu`, `Invalid import file…` (no name or product list, no order, a catalog twice, a product without availability or prices, a price that is not a whole number of sen ≥ 0, a product twice in one catalog), `Catalog <name> already exists under another Feedme name`, `Catalog <name>: <product> / <variant> has no price`
  - the file starts with a guard: run before `migration-2026-10-24-pos-catalogs.sql` it stops with `STOP: run migration-2026-10-24-pos-catalogs.sql first`

- [ ] **Step 1: Write the functions.** Every re-created function is its live text with only the lines marked `M1` changed (if a live file changed since this plan was written, copy it again and re-apply only the `M1` lines):

```sql
-- ============================================================================
-- Craft OS — POS menu catalogs · M1 functions (2026-10-24). Run on craft-os-dev
-- after migration-2026-10-24-pos-catalogs.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m1.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §3, §6
--
-- Canonical from here on: pos_insert_order (now 9 arguments), place_counter_order
-- (now 6, the last defaulting to null), place_table_order, qr_menu and menu_import.
-- Each is the live text (pos_insert_order / place_counter_order / place_table_order
-- from migration-2026-10-24-pos-checkout-fn.sql, qr_menu from
-- migration-2026-10-23-pos-ordering-fn.sql, menu_import from
-- migration-2026-10-22-pos-menu-import-fn.sql) with only the lines marked "M1"
-- changed. Re-running one of those files afterwards brings the old body back (for
-- pos_insert_order / place_counter_order as a second, old-signature function next
-- to the new one) — re-run this file afterwards.
-- ============================================================================

do $$ begin
  if to_regclass('public.branch_catalogs') is null or to_regprocedure('pos_caller_branch()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs.sql first (branch_catalogs is missing)';
  end if;
end $$;

-- ── Which catalog prices an order ──────────────────────────────────────────
-- The branch's catalog for the order's role (dine_in / takeaway; qr for QR orders)
-- when none is asked for or the default itself is asked for; at the counter also
-- one of the branch's 'additional' catalogs. Active catalogs only. Internal.
create or replace function pos_order_catalog(p_branch_id uuid, p_order_type text, p_source text, p_catalog_id uuid)
returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_role    text := case when p_source = 'qr' then 'qr' else p_order_type end;
  v_default uuid;
  v_active  boolean;
begin
  select bc.catalog_id, m.is_active into v_default, v_active
    from branch_catalogs bc join menu_catalogs m on m.id = bc.catalog_id
   where bc.branch_id = p_branch_id and bc.role = v_role;
  if p_catalog_id is null or p_catalog_id = v_default then
    if v_default is null then
      raise exception 'No menu catalog is set for % — set it in POS settings',
        case v_role when 'dine_in' then 'dine-in' when 'takeaway' then 'takeaway' else 'QR' end;
    end if;
    if not v_active then
      raise exception 'This catalog is not available at this branch';
    end if;
    return v_default;
  end if;
  if p_source = 'counter' and exists (
       select 1 from branch_catalogs bc join menu_catalogs m on m.id = bc.catalog_id and m.is_active
        where bc.branch_id = p_branch_id and bc.role = 'additional' and bc.catalog_id = p_catalog_id) then
    return p_catalog_id;
  end if;
  raise exception 'This catalog is not available at this branch';
end $$;
revoke all on function pos_order_catalog(uuid, text, text, uuid) from public, anon, authenticated;

-- ── The old signatures go: PostgREST must see one place_counter_order only ──
drop function if exists place_counter_order(uuid, text, integer, jsonb, uuid);
drop function if exists pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid);

-- ── pos_insert_order, re-created: the order's catalog decides what sells and
--    at what price; orders.catalog_id records it ─────────────────────────────
create or replace function pos_insert_order(
  p_branch_id uuid, p_table_id uuid, p_order_type text, p_pax integer,
  p_source text, p_placed_by uuid, p_items jsonb, p_client_order_id uuid,
  p_catalog_id uuid                     -- M1: the catalog asked for; null = the branch's default for this order
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing   uuid;
  v_bill_id    uuid;
  v_bill_no    text;
  v_order_id   uuid;
  v_order_no   text;
  v_label      text;
  v_item       jsonb;
  v_opt_id     uuid;
  v_opt_ids    uuid[];
  v_prod       menu_products;
  v_var        menu_variants;
  v_opt_row    record;
  v_grp        record;
  v_qty        numeric;
  v_n          integer;
  v_price      integer;
  v_mods       jsonb;
  v_allowed    text[] := case when p_source = 'qr' then array['all'] else array['all', 'counter_only'] end;
  v_catalog    uuid;                    -- M1
  v_avail      text;                    -- M1
  v_unit       integer;                 -- M1
begin
  if p_client_order_id is null then
    raise exception 'Order id is missing';
  end if;
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;                         -- resend: already in
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order has no items';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'Too many items in one order';
  end if;
  if p_order_type is null or p_order_type not in ('dine_in', 'takeaway') then
    raise exception 'Invalid order type';
  end if;
  if (p_order_type = 'dine_in') <> (p_table_id is not null) then
    raise exception 'Dine-in orders need a table; takeaway orders have none';
  end if;
  if p_pax is not null and (p_pax < 1 or p_pax > 99) then
    raise exception 'Invalid number of guests';
  end if;
  -- M1: the catalog this order is priced from; refuses one the branch does not offer for it
  v_catalog := pos_order_catalog(p_branch_id, p_order_type, p_source, p_catalog_id);

  -- ── validate every line before writing anything (bad input is always P0001 = final) ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item->'productId') is distinct from 'string'
       or jsonb_typeof(v_item->'variantId') is distinct from 'string'
       or (v_item->>'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_item->>'variantId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid item';
    end if;
    -- M1: the product must be in the catalog with an availability this source may order
    --     (menu_products.availability is no longer read)
    v_avail := null;
    select * into v_prod from menu_products
     where id = (v_item->>'productId')::uuid and is_active and not is_addon;
    if found then
      select cp.availability into v_avail from catalog_products cp
       where cp.catalog_id = v_catalog and cp.product_id = v_prod.id;
    end if;
    if v_avail is null or not (v_avail = any (v_allowed)) then
      raise exception 'Item is not available: %', coalesce(v_prod.name, v_item->>'productId');
    end if;
    if exists (select 1 from branch_menu_status s
                where s.branch_id = p_branch_id and s.product_id = v_prod.id and s.is_sold_out) then
      raise exception 'Sold out: %', v_prod.name;
    end if;
    select * into v_var from menu_variants
     where id = (v_item->>'variantId')::uuid and product_id = v_prod.id and is_active;
    -- M1: ...and the catalog must have a price for this variant
    if not found or not exists (select 1 from catalog_variant_prices cvp
                                 where cvp.catalog_id = v_catalog and cvp.variant_id = v_var.id) then
      raise exception 'Item is not available: %', v_prod.name;
    end if;
    if v_item->'qty' is not null then
      if jsonb_typeof(v_item->'qty') <> 'number' then raise exception 'Invalid quantity'; end if;
      v_qty := (v_item->'qty')::numeric;
      if v_qty < 1 or v_qty > 20 or v_qty <> trunc(v_qty) then raise exception 'Invalid quantity'; end if;
    end if;
    if v_item->'optionIds' is not null and jsonb_typeof(v_item->'optionIds') <> 'array' then
      raise exception 'Invalid add-ons';
    end if;
    -- each option must be a well-formed uuid string, appear once (compared as uuids, so
    -- letter case cannot sneak a duplicate past), belong to a group linked to this
    -- product, and be orderable here
    if exists (select 1 from jsonb_array_elements(coalesce(v_item->'optionIds', '[]'::jsonb)) e
                where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'Invalid add-ons';
    end if;
    select coalesce(array_agg(x.v::uuid), '{}') into v_opt_ids
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v);
    if cardinality(v_opt_ids) <> (select count(distinct u) from unnest(v_opt_ids) u) then
      raise exception 'Invalid add-ons';
    end if;
    foreach v_opt_id in array v_opt_ids loop
      select o.id, o.name, o.availability, o.product_id, g.name as group_name into v_opt_row
        from modifier_options o
        join modifier_groups g on g.id = o.group_id and g.is_active
        join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
       where o.id = v_opt_id;
      if not found then
        raise exception 'Add-on is not available for %', v_prod.name;
      end if;
      if not (v_opt_row.availability = any (v_allowed))
         or exists (select 1 from branch_menu_status s
                     where s.branch_id = p_branch_id and s.product_id = v_opt_row.product_id and s.is_sold_out) then
        raise exception 'Sold out: %', v_opt_row.name;
      end if;
    end loop;
    -- per linked group: min..max
    for v_grp in
      select g.name, g.min_select, g.max_select,
             (select count(*) from modifier_options o
               where o.group_id = g.id
                 and o.id = any (v_opt_ids)) as chosen
        from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id and g.is_active
       where pmg.product_id = v_prod.id
    loop
      if v_grp.chosen < v_grp.min_select then
        raise exception 'Choose at least % for %: %', v_grp.min_select, v_prod.name, v_grp.name;
      end if;
      if v_grp.chosen > v_grp.max_select then
        raise exception 'Choose at most % for %: %', v_grp.max_select, v_prod.name, v_grp.name;
      end if;
    end loop;
  end loop;

  -- ── bill + order share one savepoint: a concurrent resend that wins the
  --    client_order_id race rolls both back, so no orphan bill is left ──
  begin
    if p_table_id is not null then
      select label into v_label from dining_tables
       where id = p_table_id and branch_id = p_branch_id and is_active;
      if not found then raise exception 'Invalid table'; end if;
      select id, bill_no into v_bill_id, v_bill_no from bills
       where table_id = p_table_id and status = 'open';
      if v_bill_id is null then
        v_bill_no := pos_next_bill_no(p_branch_id);
        insert into bills(branch_id, bill_no, table_id, order_type, pax)
        values (p_branch_id, v_bill_no, p_table_id, 'dine_in', p_pax)
        on conflict (table_id) where status = 'open' and table_id is not null do nothing
        returning id into v_bill_id;
        if v_bill_id is null then                 -- lost the race: use the winner's bill
          select id, bill_no into v_bill_id, v_bill_no from bills
           where table_id = p_table_id and status = 'open';
        end if;
      elsif p_pax is not null then
        update bills set pax = p_pax where id = v_bill_id and pax is null;
      end if;
    else
      v_bill_no := pos_next_bill_no(p_branch_id);
      insert into bills(branch_id, bill_no, table_id, order_type, pax)
      values (p_branch_id, v_bill_no, null, 'takeaway', p_pax)
      returning id into v_bill_id;
    end if;

    -- serialise order numbering on this bill, and refuse a bill that was closed meanwhile
    perform 1 from bills where id = v_bill_id and status = 'open' for update;
    if not found then
      raise exception 'This bill was just closed. Please send the order again.';
    end if;
    select count(*) + 1 into v_n from orders where bill_id = v_bill_id;
    v_order_no := v_bill_no || '/' || v_n;
    insert into orders(bill_id, branch_id, order_no, source, placed_by, client_order_id, catalog_id)   -- M1: catalog_id
    values (v_bill_id, p_branch_id, v_order_no, p_source, p_placed_by, p_client_order_id, v_catalog)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from orders where client_order_id = p_client_order_id;
    if v_order_id is not null then return v_order_id; end if;
    raise;
  end;

  -- ── items: snapshot name, price, SST and modifiers from the menu ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from menu_products where id = (v_item->>'productId')::uuid;
    select * into v_var  from menu_variants where id = (v_item->>'variantId')::uuid;
    -- M1: the variant's price in this order's catalog
    select cvp.price_sen into v_unit from catalog_variant_prices cvp
     where cvp.catalog_id = v_catalog and cvp.variant_id = v_var.id;
    -- M1: an add-on costs the catalog's price when the catalog sets one, else the option's own
    select coalesce(jsonb_agg(jsonb_build_object(
             'optionId', o.id, 'group', g.name, 'name', o.name,
             'priceDeltaSen', coalesce(cop.price_delta_sen, o.price_delta_sen), 'route', ap.print_route)
             order by pmg.sort_order, g.name, o.sort_order, o.name), '[]'::jsonb),
           coalesce(sum(coalesce(cop.price_delta_sen, o.price_delta_sen)), 0)
      into v_mods, v_price
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v)
      join modifier_options o on o.id = x.v::uuid
      join modifier_groups g on g.id = o.group_id
      join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
      left join catalog_option_prices cop on cop.catalog_id = v_catalog and cop.option_id = o.id
      left join menu_products ap on ap.id = o.product_id;
    insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen,
                            sst_rate_bp, modifiers_snapshot, print_route, qty, note, takeaway_fee_sen)
    values (v_order_id, v_bill_id, v_prod.id, v_var.id,
            v_prod.name || case when v_var.feedme_variant_key <> '' then ' (' || v_var.name || ')' else '' end,
            v_unit + v_price, v_prod.sst_rate_bp, v_mods, v_prod.print_route,          -- M1: v_unit (was v_var.price_sen)
            coalesce((v_item->'qty')::numeric::integer, 1),
            nullif(trim(left(case when jsonb_typeof(v_item->'note') = 'string' then v_item->>'note' end, 200)), ''),
            -- Sub-plan 3: the packaging fee is fixed when the item is ordered (takeaway bills only)
            case when p_order_type = 'takeaway' then v_prod.takeaway_fee_sen else 0 end);
  end loop;

  -- ── tickets: one job per route, shaped exactly like TicketPayload (ticket.ts) ──
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select p_branch_id, v_order_id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', v_label, 'orderNo', v_order_no,
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              order by l.kind_order, l.name))
    from (
      -- the item on its own route, modifiers as sub-lines
      select oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods
        from order_items oi
       where oi.order_id = v_order_id and oi.print_route is not null
      union all
      -- a modifier whose add-on product prints somewhere else gets its own line there
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.order_id = v_order_id and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
   group by l.route;

  return v_order_id;
end $$;
revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid, uuid) from public, anon, authenticated;

-- ── place_counter_order, re-created: the cashier may name the catalog ───────
-- p_catalog_id null (an order queued on an iPad before catalogs existed, or an
-- older app) = the branch's default for the order type.
create or replace function place_counter_order(
  p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb, p_client_order_id uuid,
  p_catalog_id uuid default null                                         -- M1
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return pos_insert_order(pos_my_branch(), p_table_id, p_order_type, p_pax, 'counter', auth.uid(), p_items,
                          p_client_order_id, p_catalog_id);              -- M1: p_catalog_id
end $$;
revoke all on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid) from public, anon;
grant execute on function place_counter_order(uuid, text, integer, jsonb, uuid, uuid) to authenticated;

-- ── place_table_order, re-created: priced from the branch's qr catalog ──────
create or replace function place_table_order(p_token text, p_pax integer, p_items jsonb, p_client_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table   dining_tables;
  v_recent  integer;
  v_existing uuid;
begin
  select * into v_table from dining_tables where qr_token = p_token;
  if not found then raise exception 'Invalid table code'; end if;
  -- resend of an order that already went in: return it even if the table was paused since
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then return v_existing; end if;
  if not v_table.is_active then raise exception 'Invalid table code'; end if;
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
  -- Sub-plan 3: with the branch switch on, a table orders by QR only after staff open it
  if coalesce((select s.qr_requires_open_bill from branch_pos_settings s where s.branch_id = v_table.branch_id), false)
     and not exists (select 1 from bills b where b.table_id = v_table.id and b.status = 'open') then
    raise exception 'Please ask our staff to open your table before ordering.';
  end if;
  select count(*) into v_recent
    from orders o join bills b on b.id = o.bill_id
   where b.table_id = v_table.id and o.source = 'qr' and o.placed_at > now() - interval '1 minute';
  if v_recent >= 5 then
    raise exception 'Too many orders from this table. Please wait a minute.';
  end if;
  -- M1: a QR order is always priced from the branch's qr catalog (pos_order_catalog with source 'qr')
  return pos_insert_order(v_table.branch_id, v_table.id, 'dine_in', p_pax, 'qr', null, p_items, p_client_order_id, null);
end $$;
revoke all on function place_table_order(text, integer, jsonb, uuid) from public;
grant execute on function place_table_order(text, integer, jsonb, uuid) to anon, authenticated;

-- ── qr_menu, re-created: the branch's qr catalog, same JSON shape as before ─
create or replace function qr_menu(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'paused', t.qr_paused,
    'needsPax', not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open' and b.pax is not null),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'products', c.products) order by c.sort_order, c.name)
      from (
        select mc.name, mc.sort_order,
          jsonb_agg(jsonb_build_object(
            'id', p.id, 'name', p.name, 'description', p.description,
            'soldOut', coalesce(bms.is_sold_out, false),
            -- M1: the qr catalog's prices; a variant it has no price for is not offered
            'variants', (select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'priceSen', cvp.price_sen,
                                                             'isBase', v.feedme_variant_key = '')
                                          order by v.sort_order, v.name)
                           from menu_variants v
                           join catalog_variant_prices cvp on cvp.catalog_id = qc.catalog_id and cvp.variant_id = v.id
                          where v.product_id = p.id and v.is_active),
            'groups', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select,
                       'options', coalesce((
                         select jsonb_agg(jsonb_build_object(
                                  'id', o.id, 'name', o.name,
                                  'priceDeltaSen', coalesce(cop.price_delta_sen, o.price_delta_sen),   -- M1
                                  'isDefault', o.is_default,
                                  'available', o.availability = 'all' and not coalesce(obs.is_sold_out, false))
                                order by o.sort_order, o.name)
                           from modifier_options o
                           left join catalog_option_prices cop on cop.catalog_id = qc.catalog_id and cop.option_id = o.id   -- M1
                           left join branch_menu_status obs on obs.branch_id = t.branch_id and obs.product_id = o.product_id
                          where o.group_id = g.id and o.availability <> 'hidden'), '[]'::jsonb))
                     order by pmg.sort_order, g.name)
                from product_modifier_groups pmg
                join modifier_groups g on g.id = pmg.group_id and g.is_active
               where pmg.product_id = p.id), '[]'::jsonb)
          ) order by cp.sort_order, p.name) as products                             -- M1: the catalog's order
          -- M1: the products of the branch's qr catalog that QR may sell (was menu_products.availability = 'all')
          from catalog_products cp
          join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
          join menu_categories mc on mc.id = p.category_id and mc.is_active
          left join branch_menu_status bms on bms.branch_id = t.branch_id and bms.product_id = p.id
         where cp.catalog_id = qc.catalog_id and cp.availability = 'all'
           and exists (select 1 from menu_variants v
                         join catalog_variant_prices cvp on cvp.catalog_id = qc.catalog_id and cvp.variant_id = v.id
                        where v.product_id = p.id and v.is_active)
         group by mc.name, mc.sort_order
      ) c), '[]'::jsonb))
  from dining_tables t
  -- M1: the branch's qr catalog, if it is set and active (none = an empty menu; ordering says why)
  left join lateral (
    select bc.catalog_id from branch_catalogs bc
      join menu_catalogs m on m.id = bc.catalog_id and m.is_active
     where bc.branch_id = t.branch_id and bc.role = 'qr'
  ) qc on true
  where t.qr_token = p_token and t.is_active
$$;
revoke all on function qr_menu(text) from public;
grant execute on function qr_menu(text) to anon, authenticated;

-- ── POS settings → Menu catalogs: the caller's branch, managers only ───────
-- p: { dineIn: uuid, takeaway: uuid, qr: uuid, additional: uuid[] }. All three
-- defaults are required; the branch's rows are replaced in one go (they are
-- settings, not history: orders keep their own catalog_id).
create or replace function save_branch_catalogs(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_uuid   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_role   record;
  v_add    uuid[];
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the menu catalogs';
  end if;
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(coalesce(p->'additional', '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid catalog settings';
  end if;
  for v_role in select * from (values ('dineIn', 'dine-in'), ('takeaway', 'takeaway'), ('qr', 'QR')) as x(key, label) loop
    if jsonb_typeof(p->v_role.key) is distinct from 'string' then
      raise exception 'Choose the % catalog', v_role.label;
    end if;
    if (p->>v_role.key) !~* v_uuid then raise exception 'Invalid catalog settings'; end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p->'additional', '[]'::jsonb)) e
              where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~* v_uuid) then
    raise exception 'Invalid catalog settings';
  end if;
  select coalesce(array_agg(distinct x.v::uuid), '{}') into v_add
    from jsonb_array_elements_text(coalesce(p->'additional', '[]'::jsonb)) as x(v);
  if exists (select 1 from unnest(array[(p->>'dineIn')::uuid, (p->>'takeaway')::uuid, (p->>'qr')::uuid] || v_add) as c(id)
              where not exists (select 1 from menu_catalogs m where m.id = c.id and m.is_active)) then
    raise exception 'This catalog is not available — refresh and try again';
  end if;
  delete from branch_catalogs where branch_id = v_branch;
  insert into branch_catalogs(branch_id, role, catalog_id)
  select v_branch, r.role, r.id
    from (values ('dine_in', (p->>'dineIn')::uuid), ('takeaway', (p->>'takeaway')::uuid), ('qr', (p->>'qr')::uuid)) as r(role, id)
  union all
  select v_branch, 'additional', a.id from unnest(v_add) as a(id);
end $$;
revoke all on function save_branch_catalogs(jsonb) from public, anon;
grant execute on function save_branch_catalogs(jsonb) to authenticated;

-- ── menu_import, re-created: needs Edit menu ───────────────────────────────
create or replace function menu_import(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n_cat int; n_prod int; n_var int; n_grp int; n_opt int; n_link int;
begin
  if not has_menu_cap('manage_menu') then                -- M1: Edit menu (was access_settings)
    raise exception 'Not allowed to import the menu';
  end if;
  if p_payload is null
     or jsonb_typeof(p_payload->'categories') is distinct from 'array'
     or jsonb_typeof(p_payload->'products')   is distinct from 'array'
     or jsonb_typeof(p_payload->'groups')     is distinct from 'array'
     or jsonb_typeof(p_payload->'links')      is distinct from 'array' then
    raise exception 'Invalid import file';
  end if;
  -- a NULL/blank Feedme id never conflicts, so it would create a fresh row on every import
  if exists (select 1 from jsonb_array_elements(p_payload->'products') p where coalesce(p->>'feedmeId', '') = '')
     or exists (select 1 from jsonb_array_elements(p_payload->'groups') g where coalesce(g->>'feedmeId', '') = '')
     or exists (select 1 from jsonb_array_elements(p_payload->'categories') c where coalesce(c->>'name', '') = '') then
    raise exception 'Invalid import file: an item has no Feedme id';
  end if;

  -- categories
  insert into menu_categories(name, sort_order, is_active)
  select c.name, c."sortOrder", true
    from jsonb_to_recordset(p_payload->'categories') as c(name text, "sortOrder" int)
  on conflict (name) do update set sort_order = excluded.sort_order, is_active = true;
  get diagnostics n_cat = row_count;

  -- products — sst_rate_bp and print_route are Craft OS settings: not in the
  -- insert list, not in the update list, so a re-import never changes them
  insert into menu_products(feedme_product_id, name, internal_name, description, category_id,
                            availability, is_addon, takeaway_fee_sen, sort_order, is_active, updated_at)
  select p."feedmeId", p.name, p."internalName", p.description, mc.id,
         p.availability, p."isAddon", p."takeawayFeeSen", p."sortOrder", true, now()
    from jsonb_to_recordset(p_payload->'products') as p(
           "feedmeId" text, name text, "internalName" text, description text, category text,
           availability text, "isAddon" boolean, "takeawayFeeSen" int, "sortOrder" int)
    left join menu_categories mc on mc.name = p.category
  on conflict (feedme_product_id) do update set
    name = excluded.name, internal_name = excluded.internal_name, description = excluded.description,
    category_id = excluded.category_id, availability = excluded.availability, is_addon = excluded.is_addon,
    takeaway_fee_sen = excluded.takeaway_fee_sen, sort_order = excluded.sort_order,
    is_active = true, updated_at = now();
  get diagnostics n_prod = row_count;

  -- variants: upsert the file's, then switch off the imported products' others
  -- (dropped first: a second call in the same transaction — as in the verify
  -- script — would otherwise hit "relation already exists")
  drop table if exists pg_temp._imp_variants;
  create temp table pg_temp._imp_variants on commit drop as
  select mp.id as product_id, x.key, x.name, x."priceSen" as price_sen, x."sortOrder" as sort_order
    from jsonb_to_recordset(p_payload->'products') as p("feedmeId" text, variants jsonb)
    join menu_products mp on mp.feedme_product_id = p."feedmeId"
    cross join lateral jsonb_to_recordset(p.variants) as x(key text, name text, "priceSen" int, "sortOrder" int);

  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order, is_active)
  select product_id, key, name, price_sen, sort_order, true from pg_temp._imp_variants
  on conflict (product_id, feedme_variant_key) do update set
    name = excluded.name, price_sen = excluded.price_sen, sort_order = excluded.sort_order, is_active = true;
  get diagnostics n_var = row_count;

  update menu_variants mv set is_active = false
   where mv.product_id in (select distinct product_id from pg_temp._imp_variants)
     and not exists (select 1 from pg_temp._imp_variants iv
                      where iv.product_id = mv.product_id and iv.key = mv.feedme_variant_key);

  -- modifier groups
  insert into modifier_groups(feedme_group_id, name, min_select, max_select, stackable, sort_order, is_active)
  select g."feedmeId", g.name, g.min, g.max, g.stackable, g."sortOrder", true
    from jsonb_to_recordset(p_payload->'groups') as g(
           "feedmeId" text, name text, min int, max int, stackable boolean, "sortOrder" int)
  on conflict (feedme_group_id) do update set
    name = excluded.name, min_select = excluded.min_select, max_select = excluded.max_select,
    stackable = excluded.stackable, sort_order = excluded.sort_order, is_active = true;
  get diagnostics n_grp = row_count;

  -- options of the imported groups are replaced (orders keep their own snapshots)
  delete from modifier_options
   where group_id in (select mg.id from modifier_groups mg
                       where mg.feedme_group_id in (select g->>'feedmeId' from jsonb_array_elements(p_payload->'groups') g));

  insert into modifier_options(group_id, product_id, feedme_variant_key, name, price_delta_sen,
                               is_default, availability, sort_order)
  select mg.id, mp.id, coalesce(o."variantKey", ''), o.name, o."priceSen", o."isDefault", o.availability, o."sortOrder"
    from jsonb_to_recordset(p_payload->'groups') as g("feedmeId" text, options jsonb)
    join modifier_groups mg on mg.feedme_group_id = g."feedmeId"
    cross join lateral jsonb_to_recordset(g.options) as o(
           "productFeedmeId" text, "variantKey" text, name text, "priceSen" int,
           "isDefault" boolean, availability text, "sortOrder" int)
    left join menu_products mp on mp.feedme_product_id = o."productFeedmeId"
  on conflict (group_id, product_id, feedme_variant_key) do nothing;
  get diagnostics n_opt = row_count;

  -- links of the imported products are replaced
  delete from product_modifier_groups
   where product_id in (select mp.id from menu_products mp
                         where mp.feedme_product_id in (select p->>'feedmeId' from jsonb_array_elements(p_payload->'products') p));

  insert into product_modifier_groups(product_id, group_id, sort_order)
  select mp.id, mg.id, l."sortOrder"
    from jsonb_to_recordset(p_payload->'links') as l("productFeedmeId" text, "groupFeedmeId" text, "sortOrder" int)
    join menu_products mp on mp.feedme_product_id = l."productFeedmeId"
    join modifier_groups mg on mg.feedme_group_id = l."groupFeedmeId"
  on conflict do nothing;
  get diagnostics n_link = row_count;

  return jsonb_build_object('categories', n_cat, 'products', n_prod, 'variants', n_var,
                            'groups', n_grp, 'options', n_opt, 'links', n_link);
end $$;
revoke all on function menu_import(jsonb) from public, anon;
grant execute on function menu_import(jsonb) to authenticated;

-- ── /menu: put a product in a catalog, take it out, or change its channel ──
-- 'hidden' takes it out (the row and its prices stay, so nothing is lost);
-- 'all' / 'counter_only' puts it in, pre-filling any missing variant price
-- from the default price (menu_variants.price_sen).
create or replace function menu_set_catalog_product(p_catalog_id uuid, p_product_id uuid, p_availability text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('manage_menu') then
    raise exception 'Not allowed to edit the menu';
  end if;
  if p_availability is null or p_availability not in ('all', 'counter_only', 'hidden') then
    raise exception 'Invalid availability';
  end if;
  if not exists (select 1 from menu_catalogs where id = p_catalog_id) then
    raise exception 'Catalog not found';
  end if;
  if not exists (select 1 from menu_products where id = p_product_id and is_active) then
    raise exception 'Product not found';
  end if;
  insert into catalog_products(catalog_id, product_id, availability, sort_order)
  select p_catalog_id, p.id, p_availability, p.sort_order from menu_products p where p.id = p_product_id
  on conflict (catalog_id, product_id) do update set availability = excluded.availability;
  if p_availability <> 'hidden' then
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
    select p_catalog_id, v.id, v.price_sen from menu_variants v
     where v.product_id = p_product_id and v.is_active
    on conflict (catalog_id, variant_id) do nothing;
  end if;
end $$;
revoke all on function menu_set_catalog_product(uuid, uuid, text) from public, anon;
grant execute on function menu_set_catalog_product(uuid, uuid, text) to authenticated;

-- ── /menu/import: the whole Feedme export in one transaction ───────────────
-- p_payload = menu_import's payload (the Default Catalog / Default AddonGroup
-- master) plus catalogs: [{ name, sortOrder,
--   products: [{ feedmeId, availability 'all'|'counter_only', sortOrder, prices: [{ key, priceSen }] }],
--   optionPrices: [{ groupFeedmeId, productFeedmeId, variantKey, priceSen }] }]   (only prices that differ)
-- A catalog is matched by feedme_catalog_name. Its products not in the file are set
-- to 'hidden' (never deleted); catalogs not in the file and branch assignments are
-- left alone. Returns menu_import's counts plus catalogs: [{ name, products, prices, optionPrices }].
create or replace function menu_import_catalogs(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_master  jsonb;
  v_cat     record;
  v_id      uuid;
  v_report  jsonb := '[]'::jsonb;
  v_missing text;
  n_prod    integer;
  n_price   integer;
  n_opt     integer;
begin
  if not has_menu_cap('manage_menu') then
    raise exception 'Not allowed to import the menu';
  end if;
  if p_payload is null or jsonb_typeof(p_payload->'catalogs') is distinct from 'array' then
    raise exception 'Invalid import file';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
              where jsonb_typeof(c) <> 'object' or coalesce(trim(c->>'name'), '') = ''
                 or jsonb_typeof(c->'products') is distinct from 'array'
                 or jsonb_typeof(c->'optionPrices') is distinct from 'array') then
    raise exception 'Invalid import file: a catalog has no name or no product list';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
              where jsonb_typeof(c->'sortOrder') is distinct from 'number') then
    raise exception 'Invalid import file: a catalog has no order';
  end if;
  if (select count(*) from jsonb_array_elements(p_payload->'catalogs'))
     <> (select count(distinct trim(c->>'name')) from jsonb_array_elements(p_payload->'catalogs') c) then
    raise exception 'Invalid import file: a catalog appears twice';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
               cross join lateral jsonb_array_elements(c->'products') x
              where jsonb_typeof(x) <> 'object'
                 or coalesce(x->>'availability', '') not in ('all', 'counter_only')
                 or jsonb_typeof(x->'feedmeId') is distinct from 'string'
                 or jsonb_typeof(x->'sortOrder') is distinct from 'number'
                 or jsonb_typeof(x->'prices') is distinct from 'array') then
    raise exception 'Invalid import file: a catalog product has no availability or prices';
  end if;
  -- every price a whole number of sen, never negative (CASE: no cast before the type is known)
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
               cross join lateral (
                 select pr->'priceSen' as v from jsonb_array_elements(c->'products') x
                   cross join lateral jsonb_array_elements(x->'prices') pr
                 union all
                 select op->'priceSen' from jsonb_array_elements(c->'optionPrices') op) p
              where case when jsonb_typeof(p.v) = 'number'
                         then (p.v #>> '{}')::numeric < 0 or (p.v #>> '{}')::numeric <> trunc((p.v #>> '{}')::numeric)
                         else true end) then
    raise exception 'Invalid import file: a catalog price is not a whole number of sen';
  end if;
  if exists (select 1 from jsonb_array_elements(p_payload->'catalogs') c
              where (select count(*) from jsonb_array_elements(c->'products'))
                    <> (select count(distinct x->>'feedmeId') from jsonb_array_elements(c->'products') x)) then
    raise exception 'Invalid import file: a catalog lists a product twice';
  end if;

  -- the master first: products, variants and default prices, add-on groups, links
  v_master := menu_import(p_payload);

  drop table if exists pg_temp._imp_cat;
  create temp table pg_temp._imp_cat (
    product_id uuid primary key, availability text, sort_order integer, prices jsonb
  ) on commit drop;

  for v_cat in
    select trim(c->>'name') as name, coalesce((c->>'sortOrder')::integer, 0) as sort_order,
           c->'products' as products, c->'optionPrices' as option_prices
      from jsonb_array_elements(p_payload->'catalogs') c
  loop
    -- a catalog of that name made in Craft OS is adopted rather than duplicated; one of
    -- that name that already stands for another Feedme sheet is refused in plain words
    if not exists (select 1 from menu_catalogs where feedme_catalog_name = v_cat.name)
       and exists (select 1 from menu_catalogs where name = v_cat.name and feedme_catalog_name is not null) then
      raise exception 'Catalog % already exists under another Feedme name', v_cat.name;
    end if;
    update menu_catalogs set feedme_catalog_name = v_cat.name
     where name = v_cat.name and feedme_catalog_name is null;
    insert into menu_catalogs(name, feedme_catalog_name, sort_order, is_active)
    values (v_cat.name, v_cat.name, v_cat.sort_order, true)
    on conflict (feedme_catalog_name) do update set sort_order = excluded.sort_order, is_active = true
    returning id into v_id;

    delete from pg_temp._imp_cat;
    insert into pg_temp._imp_cat(product_id, availability, sort_order, prices)
    select mp.id, x.availability, x."sortOrder", x.prices
      from jsonb_to_recordset(v_cat.products) as x("feedmeId" text, availability text, "sortOrder" integer, prices jsonb)
      join menu_products mp on mp.feedme_product_id = x."feedmeId";
    get diagnostics n_prod = row_count;
    if n_prod <> jsonb_array_length(v_cat.products) then
      raise exception 'Invalid import file: catalog % lists a product that is not in the menu', v_cat.name;
    end if;

    -- the file decides what this catalog sells; whatever else it had becomes hidden
    update catalog_products cp set availability = 'hidden'
     where cp.catalog_id = v_id and cp.availability <> 'hidden'
       and not exists (select 1 from pg_temp._imp_cat i where i.product_id = cp.product_id);
    insert into catalog_products(catalog_id, product_id, availability, sort_order)
    select v_id, i.product_id, i.availability, i.sort_order from pg_temp._imp_cat i
    on conflict (catalog_id, product_id) do update
      set availability = excluded.availability, sort_order = excluded.sort_order;

    insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
    select v_id, mv.id, pr."priceSen"
      from pg_temp._imp_cat i
      cross join lateral jsonb_to_recordset(i.prices) as pr(key text, "priceSen" integer)
      join menu_variants mv on mv.product_id = i.product_id and mv.feedme_variant_key = coalesce(pr.key, '')
    on conflict (catalog_id, variant_id) do update set price_sen = excluded.price_sen;
    get diagnostics n_price = row_count;

    -- every active variant of a product the catalog sells needs a price
    select format('%s / %s', mp.name, mv.name) into v_missing
      from pg_temp._imp_cat i
      join menu_products mp on mp.id = i.product_id
      join menu_variants mv on mv.product_id = i.product_id and mv.is_active
     where not exists (select 1 from catalog_variant_prices c where c.catalog_id = v_id and c.variant_id = mv.id)
     order by mp.name, mv.name
     limit 1;
    if v_missing is not null then
      raise exception 'Catalog %: % has no price', v_cat.name, v_missing;
    end if;

    -- add-on prices that differ from the option's default (menu_import re-created the
    -- options of every imported group, so their old catalog prices are already gone)
    insert into catalog_option_prices(catalog_id, option_id, price_delta_sen)
    select v_id, o.id, op."priceSen"
      from jsonb_to_recordset(v_cat.option_prices)
             as op("groupFeedmeId" text, "productFeedmeId" text, "variantKey" text, "priceSen" integer)
      join modifier_groups g on g.feedme_group_id = op."groupFeedmeId"
      join menu_products ap on ap.feedme_product_id = op."productFeedmeId"
      join modifier_options o on o.group_id = g.id and o.product_id = ap.id
                             and o.feedme_variant_key = coalesce(op."variantKey", '')
    on conflict (catalog_id, option_id) do update set price_delta_sen = excluded.price_delta_sen;
    get diagnostics n_opt = row_count;

    v_report := v_report || jsonb_build_object('name', v_cat.name, 'products', n_prod,
                                               'prices', n_price, 'optionPrices', n_opt);
  end loop;

  return v_master || jsonb_build_object('catalogs', v_report);
end $$;
revoke all on function menu_import_catalogs(jsonb) from public, anon;
grant execute on function menu_import_catalogs(jsonb) to authenticated;

-- PostgREST picks up the new place_counter_order signature now, not at its next poll
notify pgrst, 'reload schema';

select 'catalog functions applied' as result;
```

- [ ] **Step 2: Check that only the M1 lines changed.** Run:

```bash
f() { awk -v n="$2" 'index($0, "create or replace function " n "(") == 1 {p=1} p {print} p && /^(end )?\$\$;$/ {exit}' "$1"; }
diff <(f supabase/migration-2026-10-24-pos-checkout-fn.sql pos_insert_order) <(f supabase/migration-2026-10-24-pos-catalogs-fn.sql pos_insert_order)
diff <(f supabase/migration-2026-10-24-pos-checkout-fn.sql place_table_order) <(f supabase/migration-2026-10-24-pos-catalogs-fn.sql place_table_order)
diff <(f supabase/migration-2026-10-23-pos-ordering-fn.sql qr_menu) <(f supabase/migration-2026-10-24-pos-catalogs-fn.sql qr_menu)
diff <(f supabase/migration-2026-10-22-pos-menu-import-fn.sql menu_import) <(f supabase/migration-2026-10-24-pos-catalogs-fn.sql menu_import)
diff <(f supabase/migration-2026-10-24-pos-checkout-fn.sql place_counter_order) <(f supabase/migration-2026-10-24-pos-catalogs-fn.sql place_counter_order)
diff <(f supabase/migration-2026-10-24-pos-checkout-fixes.sql has_menu_cap) <(f supabase/migration-2026-10-24-pos-catalogs.sql has_menu_cap)
diff <(f supabase/migration-2026-10-24-pos-checkout-fixes.sql staff_has_cap) <(f supabase/migration-2026-10-24-pos-catalogs.sql staff_has_cap)
```

Expected: every `>` hunk is a line marked `M1` or a continuation of one (the signature's new `p_catalog_id`, the three new declarations, the `pos_order_catalog` call, the catalog availability and price checks, `catalog_id` on the order, `v_unit` and the `coalesce(cop.price_delta_sen, o.price_delta_sen)` price, `qc` in `qr_menu`, `manage_menu` in `menu_import`, the new last argument of `place_counter_order` and its call); `has_menu_cap` and `staff_has_cap` differ only by the line `when 'manage_menu' then s.system_role in ('owner','admin')`; nothing else differs. Run: `grep -c "set search_path = public, pg_temp" supabase/migration-2026-10-24-pos-catalogs-fn.sql` — Expected: `9`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migration-2026-10-24-pos-catalogs-fn.sql
git commit -m "feat(pos-menu): orders priced from the branch's catalog; QR from the qr catalog; branch catalog settings and multi-catalog import RPCs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Verify script, the older verify scripts brought up to M1 — and applying everything on craft-os-dev (implementer + controller)

**Files:**
- Create: `supabase/migration-2026-10-24-pos-catalogs-verify.sql`
- Modify: `supabase/migration-2026-10-22-pos-menu-verify.sql` (A2), `supabase/migration-2026-10-23-pos-ordering-verify.sql` (catalog fixture, signatures, availability), `supabase/migration-2026-10-24-pos-checkout-verify.sql` (catalog fixture, signature)

**Interfaces:**
- Consumes: Tasks 1–2; the dev test login `76cbcf9f-905e-450d-9f5e-1c9e72a9373d` (owner).
- Produces: on dev, both M1 migrations applied and four verify scripts printing `VERIFY OK`. The error words checked here are the ones Tasks 4–8 show.

The script covers spec §9's M1 items: refused when the catalog is not the branch's or is inactive; QR cannot order `counter_only`; prices and add-on prices come from the catalog (default when the catalog sets none); `manage_menu` for every menu write (manager refused, owner allowed, resigned owner refused); sold-out writes limited to the own branch; the backfill produced Craft Cafe with today's prices. Plus: orders record their catalog, the takeaway catalog prices takeaways, additional catalogs at the counter only, the no-catalog words, resends, `qr_menu` (counter-only and hidden products left out, an inactive qr catalog gives an empty menu and a refusal), `menu_set_catalog_product` (including `Catalog not found` / `Product not found`), `save_branch_catalogs`, the `branch_catalogs` policy and the import (including malformed prices, a product twice in a catalog and a catalog-name clash). Every refusal is paired with the success it guards; the RLS writes run as `authenticated`.

- [ ] **Step 1: Write the verify script** `supabase/migration-2026-10-24-pos-catalogs-verify.sql`:

```sql
-- Self-check for the POS menu catalogs M1 migrations. Run on craft-os-dev after
-- migration-2026-10-24-pos-catalogs.sql and -pos-catalogs-fn.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Every refusal is paired with the success it guards, and the writes that RLS
-- decides run as `authenticated` (the DO block's own role bypasses RLS).
begin;

do $$
declare
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr     uuid := 'eeeeeeee-0000-0000-0000-000000000001';   -- manager of VERIFY: access_settings, no manage_menu
  v_cashier uuid := 'eeeeeeee-0000-0000-0000-000000000002';   -- staff of VERIFY
  v_far     uuid := 'eeeeeeee-0000-0000-0000-000000000003';   -- manager of VERIFY2
  v_boss    uuid := 'eeeeeeee-0000-0000-0000-000000000004';   -- a second owner, resigned in H
  v_first   uuid := 'ffffffff-0000-0000-0000-000000000001';   -- client_order_id of E1
  v_branch uuid; v_branch2 uuid;
  v_t1 dining_tables; v_w1 dining_tables;
  v_catg uuid; v_latte uuid; v_hot uuid; v_cold uuid; v_large uuid; v_toast uuid; v_toast_var uuid;
  v_oat uuid; v_milk uuid; v_opt uuid;
  c_dine uuid; c_take uuid; c_qr uuid; c_staff uuid; c_grab uuid; c_old uuid; v_cafe uuid;
  v_order uuid; v_order2 uuid; v_menu jsonb; v_res jsonb; v_payload jsonb; v_text text;
  n integer; r record;
begin
  -- ── A. schema, RLS, grants, search_path ──────────────────────────────────
  for r in select t from unnest(array['menu_catalogs','catalog_products','catalog_variant_prices',
                                      'catalog_option_prices','branch_catalogs']) as t loop
    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname = r.t and c.relrowsecurity) then
      raise exception 'FAIL schema: % missing or RLS off', r.t;
    end if;
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = 'menu_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no menu_read', r.t;
    end if;
  end loop;
  for r in select t from unnest(array['menu_catalogs','catalog_products','catalog_variant_prices','catalog_option_prices']) as t loop
    if exists (select 1 from pg_policies where tablename = r.t and cmd in ('DELETE', 'ALL')) then
      raise exception 'FAIL rls: rows of % can be deleted (nothing is hard-deleted)', r.t;
    end if;
    if not exists (select 1 from pg_policies where tablename = r.t and cmd = 'INSERT' and with_check like '%manage_menu%')
       or not exists (select 1 from pg_policies where tablename = r.t and cmd = 'UPDATE'
                       and qual like '%manage_menu%' and with_check like '%manage_menu%') then
      raise exception 'FAIL rls: writes to % are not gated on manage_menu', r.t;
    end if;
  end loop;
  for r in select t from unnest(array['menu_products','menu_variants']) as t loop
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = r.t || '_edit' and cmd = 'UPDATE'
                    and qual like '%manage_menu%' and with_check like '%manage_menu%') then
      raise exception 'FAIL rls: %_edit is not gated on manage_menu', r.t;
    end if;
  end loop;
  if not exists (select 1 from pg_policies where tablename = 'branch_menu_status' and policyname = 'branch_menu_status_write'
                  and qual like '%pos_caller_branch()%' and with_check like '%pos_caller_branch()%') then
    raise exception 'FAIL rls: sold-out writes are not limited to the caller''s branch';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'branch_catalogs' and policyname = 'branch_catalogs_manage'
                  and qual like '%pos_caller_branch()%' and qual like '%access_settings%'
                  and with_check like '%pos_caller_branch()%' and with_check like '%access_settings%') then
    raise exception 'FAIL rls: branch_catalogs writes are not limited to a manager of the branch';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'branch_catalogs_one_per_role') then
    raise exception 'FAIL schema: branch_catalogs_one_per_role is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_catalog_id_fkey') then
    raise exception 'FAIL schema: orders.catalog_id has no foreign key';
  end if;
  for r in select f from unnest(array['place_counter_order(uuid,text,integer,jsonb,uuid,uuid)', 'save_branch_catalogs(jsonb)',
                                      'menu_import_catalogs(jsonb)', 'menu_set_catalog_product(uuid,uuid,text)',
                                      'menu_import(jsonb)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array['pos_order_catalog(uuid,text,text,uuid)',
                                      'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)',
                                      'staff_has_cap(uuid,text)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['qr_menu(text)', 'place_table_order(text,integer,jsonb,uuid)']) as f loop
    if not has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon lost %', r.f; end if;
  end loop;
  if to_regprocedure('place_counter_order(uuid,text,integer,jsonb,uuid)') is not null
     or to_regprocedure('pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)') is not null then
    raise exception 'FAIL: an old ordering signature still exists (re-run migration-2026-10-24-pos-catalogs-fn.sql)';
  end if;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array['has_menu_cap','staff_has_cap','pos_order_catalog',
              'pos_insert_order','place_counter_order','place_table_order','qr_menu','save_branch_catalogs',
              'menu_import','menu_import_catalogs','menu_set_catalog_product'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;

  -- ── B. backfill: Craft Cafe from the menu as it was ───────────────────────
  select id into v_cafe from menu_catalogs where feedme_catalog_name = 'Craft Cafe';
  if v_cafe is null then raise exception 'FAIL backfill: there is no Craft Cafe catalog'; end if;
  -- always true, also after an import: whatever Craft Cafe sells has a price for each active variant
  if exists (select 1 from catalog_products cp join menu_variants v on v.product_id = cp.product_id and v.is_active
              where cp.catalog_id = v_cafe and cp.availability <> 'hidden'
                and not exists (select 1 from catalog_variant_prices p where p.catalog_id = v_cafe and p.variant_id = v.id)) then
    raise exception 'FAIL backfill: a Craft Cafe product has a variant without a price';
  end if;
  -- before any import (only the backfilled catalog exists): exactly today's menu and prices, on every active branch
  if (select count(*) from menu_catalogs) = 1 then
    if (select count(*) from catalog_products where catalog_id = v_cafe and availability <> 'hidden')
       <> (select count(*) from menu_products where is_active and availability <> 'hidden') then
      raise exception 'FAIL backfill: Craft Cafe does not hold every product that is not hidden';
    end if;
    if exists (select 1 from catalog_products cp join menu_products p on p.id = cp.product_id
                where cp.catalog_id = v_cafe and cp.availability <> p.availability) then
      raise exception 'FAIL backfill: an availability differs from menu_products';
    end if;
    if exists (select 1 from catalog_variant_prices cvp join menu_variants v on v.id = cvp.variant_id
                where cvp.catalog_id = v_cafe and cvp.price_sen <> v.price_sen) then
      raise exception 'FAIL backfill: a Craft Cafe price differs from today''s price';
    end if;
    if exists (select 1 from branches b cross join (values ('dine_in'), ('takeaway'), ('qr')) as x(role)
                where coalesce(b.is_active, true)
                  and not exists (select 1 from branch_catalogs bc
                                   where bc.branch_id = b.id and bc.role = x.role and bc.catalog_id = v_cafe)) then
      raise exception 'FAIL backfill: an active branch does not use Craft Cafe for dine-in, takeaway and QR';
    end if;
  end if;

  -- ── C. fixture: two branches, staff, a latte with a milk add-on, a toast, six catalogs ─
  update system_role_permissions set permissions = permissions - 'manage_menu';   -- code defaults for this run
  insert into branches(name, address) values ('VERIFY', 'verify') returning id into v_branch;
  insert into branches(name, address) values ('VERIFY2', 'far away') returning id into v_branch2;
  insert into dining_tables(branch_id, label) values (v_branch, 'V1') returning * into v_t1;
  insert into dining_tables(branch_id, label) values (v_branch2, 'W1') returning * into v_w1;
  insert into menu_categories(name) values ('VERIFY M1 CAT') returning id into v_catg;
  insert into menu_products(name, category_id, print_route, sst_rate_bp) values ('Verify Latte', v_catg, 'Bar', 600)
    returning id into v_latte;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values (v_latte, 'v/hot', 'HOT', 1200, 0)
    returning id into v_hot;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values (v_latte, 'v/cold', 'COLD', 1300, 1)
    returning id into v_cold;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify Toast', v_catg, 600) returning id into v_toast;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_toast, '', 'Regular', 800)
    returning id into v_toast_var;
  insert into menu_products(name, category_id, is_addon) values ('Verify Oat milk', v_catg, true) returning id into v_oat;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_oat, '', 'Regular', 200);
  insert into modifier_groups(name, min_select, max_select) values ('Milk', 0, 1) returning id into v_milk;
  insert into modifier_options(group_id, product_id, name, price_delta_sen) values (v_milk, v_oat, 'Oat milk', 200)
    returning id into v_opt;
  insert into product_modifier_groups(product_id, group_id) values (v_latte, v_milk);
  insert into menu_catalogs(name, sort_order) values ('VERIFY Dine', 901) returning id into c_dine;
  insert into menu_catalogs(name, sort_order) values ('VERIFY Take', 902) returning id into c_take;
  insert into menu_catalogs(name, sort_order) values ('VERIFY QR', 903) returning id into c_qr;
  insert into menu_catalogs(name, sort_order) values ('VERIFY Staff', 904) returning id into c_staff;
  insert into menu_catalogs(name, sort_order) values ('VERIFY Grab', 905) returning id into c_grab;
  insert into menu_catalogs(name, sort_order, is_active) values ('VERIFY Old', 906, false) returning id into c_old;
  insert into catalog_products(catalog_id, product_id, availability) values
    (c_dine, v_latte, 'all'), (c_dine, v_toast, 'counter_only'),
    (c_take, v_latte, 'all'),
    (c_qr, v_latte, 'all'), (c_qr, v_toast, 'counter_only'),
    (c_staff, v_latte, 'counter_only'), (c_staff, v_toast, 'all'),
    (c_grab, v_latte, 'all'), (c_old, v_latte, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values
    (c_dine, v_hot, 1210), (c_dine, v_cold, 1310), (c_dine, v_toast_var, 810),
    (c_take, v_hot, 1100), (c_take, v_cold, 1250),
    (c_qr, v_hot, 1500), (c_qr, v_cold, 1600), (c_qr, v_toast_var, 900),
    (c_staff, v_hot, 600), (c_staff, v_cold, 650), (c_staff, v_toast_var, 400),
    (c_grab, v_hot, 1700), (c_grab, v_cold, 1800),
    (c_old, v_hot, 100), (c_old, v_cold, 100);
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen) values (c_qr, v_opt, 300), (c_staff, v_opt, 0);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', c_dine), (v_branch, 'takeaway', c_take), (v_branch, 'qr', c_qr),
    (v_branch, 'additional', c_staff), (v_branch, 'additional', c_old);
  -- staff are inserted as 'staff' and promoted by the owner (staff_guard refuses anything else)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into auth.users (id) values (v_mgr), (v_cashier), (v_far), (v_boss);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,     'Verify M1 Manager', 'trainee', true, current_date, 'staff', v_branch),
    (v_cashier, 'Verify M1 Cashier', 'trainee', true, current_date, 'staff', v_branch),
    (v_far,     'Verify M1 Far',     'trainee', true, current_date, 'staff', v_branch2),
    (v_boss,    'Verify M1 Boss',    'trainee', true, current_date, 'staff', v_branch);
  update staff set system_role = 'manager' where id in (v_mgr, v_far);
  update staff set system_role = 'owner' where id = v_boss;
  update staff set branch_id = v_branch where id = v_owner;
  if not staff_has_cap(v_owner, 'manage_menu') then raise exception 'FAIL fixture: the test login (owner) lacks manage_menu'; end if;

  -- ── D. manage_menu: owner and admin only; has_menu_cap and staff_has_cap agree; Owner override ─
  for r in select * from (values ('owner', true), ('admin', true), ('hr', false), ('manager', false),
                                 ('supervisor', false), ('staff', false)) as x(role, expected) loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    update staff set system_role = r.role where id = v_cashier;
    perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
    if has_menu_cap('manage_menu') <> r.expected or staff_has_cap(v_cashier, 'manage_menu') <> r.expected then
      raise exception 'FAIL cap: % manage_menu should be %', r.role, r.expected;
    end if;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set system_role = 'staff' where id = v_cashier;
  insert into system_role_permissions(system_role, permissions) values ('manager', '{"manage_menu": true}')
  on conflict (system_role) do update set permissions = system_role_permissions.permissions || '{"manage_menu": true}';
  if not staff_has_cap(v_mgr, 'manage_menu') then raise exception 'FAIL cap: the Owner''s override is ignored'; end if;
  update system_role_permissions set permissions = permissions - 'manage_menu' where system_role = 'manager';
  if staff_has_cap(v_mgr, 'manage_menu') then raise exception 'FAIL cap: a manager holds manage_menu by default'; end if;

  -- ── E. counter orders: the catalog decides what sells and at what price ───
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  -- E1. no catalog asked for → the dine-in catalog: its prices, the add-on's default price (as a client: grants)
  set local role authenticated;
  v_order := place_counter_order(v_t1.id, 'dine_in', 2, jsonb_build_array(
    jsonb_build_object('productId', v_latte, 'variantId', v_cold, 'optionIds', jsonb_build_array(v_opt)),
    jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), v_first);
  reset role;
  if (select catalog_id from orders where id = v_order) is distinct from c_dine then
    raise exception 'FAIL E1: the order is not recorded with the dine-in catalog';
  end if;
  select string_agg(name_snapshot || '=' || unit_price_sen, ',' order by name_snapshot) into v_text
    from order_items where order_id = v_order;
  if v_text is distinct from 'Verify Latte (COLD)=1510,Verify Toast=810' then raise exception 'FAIL E1: prices %', v_text; end if;
  if (select modifiers_snapshot->0->>'priceDeltaSen' from order_items where order_id = v_order and product_id = v_latte) <> '200' then
    raise exception 'FAIL E1: the add-on snapshot must carry the price charged';
  end if;
  -- E2. a resend of E1 naming another catalog is still E1 (dedupe comes first)
  v_order2 := place_counter_order(v_t1.id, 'dine_in', 2, jsonb_build_array(
    jsonb_build_object('productId', v_latte, 'variantId', v_hot)), v_first, c_staff);
  if v_order2 <> v_order then raise exception 'FAIL E2: a resend created a second order'; end if;
  -- E3. takeaway → the takeaway catalog
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  if (select catalog_id from orders where id = v_order) is distinct from c_take
     or (select unit_price_sen from order_items where order_id = v_order) <> 1100 then
    raise exception 'FAIL E3: a takeaway is not priced from the takeaway catalog';
  end if;
  -- E4. a product the catalog does not sell is refused (the dine-in catalog sells it: E1)
  begin perform place_counter_order(null, 'takeaway', null,
          jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
    raise exception 'FAIL E4: sold a product that is not in the takeaway catalog';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Toast' then raise; end if; end;
  -- E5. an additional catalog: counter_only is fine at the counter, its prices and its add-on price (0, not the default 200)
  v_order := place_counter_order(v_t1.id, 'dine_in', null, jsonb_build_array(
    jsonb_build_object('productId', v_latte, 'variantId', v_cold, 'optionIds', jsonb_build_array(v_opt))), gen_random_uuid(), c_staff);
  if (select catalog_id from orders where id = v_order) is distinct from c_staff
     or (select unit_price_sen from order_items where order_id = v_order) <> 650
     or (select modifiers_snapshot->0->>'priceDeltaSen' from order_items where order_id = v_order) <> '0' then
    raise exception 'FAIL E5: the additional catalog''s prices were not used';
  end if;
  -- E6. naming the default itself is fine; another order type's default, a catalog the
  --     branch does not have, or an inactive additional one is refused
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_dine);
  if (select unit_price_sen from order_items where order_id = v_order) <> 1210 then raise exception 'FAIL E6: default named'; end if;
  for r in select * from (values (c_take), (c_grab), (c_old)) as x(cat) loop
    begin perform place_counter_order(v_t1.id, 'dine_in', null,
            jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), r.cat);
      raise exception 'FAIL E6: catalog % was accepted for a dine-in order here', r.cat;
    exception when raise_exception then if sqlerrm <> 'This catalog is not available at this branch' then raise; end if; end;
  end loop;
  update menu_catalogs set is_active = true where id = c_old;                -- the same additional catalog, active: allowed
  perform place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_old);
  update menu_catalogs set is_active = false where id = c_old;
  -- E7. an inactive default refuses the order type until it is active again
  update menu_catalogs set is_active = false where id = c_dine;
  begin perform place_counter_order(v_t1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL E7: an inactive dine-in catalog still sold';
  exception when raise_exception then if sqlerrm <> 'This catalog is not available at this branch' then raise; end if; end;
  update menu_catalogs set is_active = true where id = c_dine;
  -- E8. a variant the catalog has no price for is not for sale; with a price it is
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values (v_latte, 'v/large', 'LARGE', 1500, 2)
    returning id into v_large;
  begin perform place_counter_order(v_t1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_large)), gen_random_uuid());
    raise exception 'FAIL E8: sold a variant without a catalog price';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Latte' then raise; end if; end;
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (c_dine, v_large, 1510);
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_large)), gen_random_uuid());
  if (select unit_price_sen from order_items where order_id = v_order) <> 1510 then raise exception 'FAIL E8: large price'; end if;
  -- E9. hidden in the catalog = not for sale (the master availability is not read any more)
  update catalog_products set availability = 'hidden' where catalog_id = c_dine and product_id = v_toast;
  update menu_products set availability = 'all' where id = v_toast;
  begin perform place_counter_order(v_t1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
    raise exception 'FAIL E9: sold a product hidden in the catalog';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Toast' then raise; end if; end;
  update catalog_products set availability = 'counter_only' where catalog_id = c_dine and product_id = v_toast;
  update menu_products set availability = 'hidden' where id = v_toast;
  perform place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
  -- E10. a branch with no catalog for the order type says so; once set, it sells
  perform set_config('request.jwt.claims', json_build_object('sub', v_far, 'role', 'authenticated')::text, true);
  begin perform place_counter_order(v_w1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL E10: ordered at a branch with no dine-in catalog';
  exception when raise_exception then if sqlerrm <> 'No menu catalog is set for dine-in — set it in POS settings' then raise; end if; end;
  begin perform place_counter_order(null, 'takeaway', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL E10: ordered at a branch with no takeaway catalog';
  exception when raise_exception then if sqlerrm <> 'No menu catalog is set for takeaway — set it in POS settings' then raise; end if; end;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch2, 'dine_in', c_grab);
  v_order := place_counter_order(v_w1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  if (select catalog_id from orders where id = v_order) is distinct from c_grab
     or (select unit_price_sen from order_items where order_id = v_order) <> 1700 then
    raise exception 'FAIL E10: VERIFY2''s dine-in catalog was not used';
  end if;

  -- ── F. QR: the branch's qr catalog, 'all' products only ────────────────────
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  v_menu := qr_menu(v_t1.qr_token);
  reset role;
  select string_agg(p->>'name', ',' order by p->>'name') into v_text
    from jsonb_array_elements(v_menu->'categories') c cross join lateral jsonb_array_elements(c->'products') p
   where c->>'name' = 'VERIFY M1 CAT';
  if v_text is distinct from 'Verify Latte' then raise exception 'FAIL F1: QR lists %, expected the QR catalog''s ''all'' products', v_text; end if;
  -- LARGE has no QR price, so it is not offered; the add-on shows the catalog's 300
  select string_agg((v->>'name') || '=' || (v->>'priceSen'), ',' order by v->>'name') into v_text
    from jsonb_array_elements(v_menu->'categories') c cross join lateral jsonb_array_elements(c->'products') p
    cross join lateral jsonb_array_elements(p->'variants') v
   where p->>'id' = v_latte::text;
  if v_text is distinct from 'COLD=1600,HOT=1500' then raise exception 'FAIL F1: QR variants %', v_text; end if;
  if (select p->'groups'->0->'options'->0->>'priceDeltaSen'
        from jsonb_array_elements(v_menu->'categories') c cross join lateral jsonb_array_elements(c->'products') p
       where p->>'id' = v_latte::text) <> '300' then
    raise exception 'FAIL F1: the QR add-on price is not the catalog''s';
  end if;
  -- F2. a QR order is priced from the qr catalog
  v_order := place_table_order(v_t1.qr_token, null, jsonb_build_array(jsonb_build_object(
    'productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt))), gen_random_uuid());
  if (select catalog_id from orders where id = v_order) is distinct from c_qr
     or (select unit_price_sen from order_items where order_id = v_order) <> 1800 then
    raise exception 'FAIL F2: the QR order was not priced from the qr catalog';
  end if;
  -- F3. QR cannot order counter_only; once the qr catalog says 'all', it can
  begin perform place_table_order(v_t1.qr_token, null,
          jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
    raise exception 'FAIL F3: QR ordered a counter_only product';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Toast' then raise; end if; end;
  update catalog_products set availability = 'all' where catalog_id = c_qr and product_id = v_toast;
  v_order := place_table_order(v_t1.qr_token, null,
    jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
  if (select unit_price_sen from order_items where order_id = v_order) <> 900 then raise exception 'FAIL F3: QR toast price'; end if;
  -- F4. hidden in the qr catalog: not on the QR menu and not orderable
  update catalog_products set availability = 'hidden' where catalog_id = c_qr and product_id = v_toast;
  if exists (select 1 from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
               cross join lateral jsonb_array_elements(c->'products') p where p->>'id' = v_toast::text) then
    raise exception 'FAIL F4: a product hidden in the qr catalog is on the QR menu';
  end if;
  begin perform place_table_order(v_t1.qr_token, null,
          jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
    raise exception 'FAIL F4: QR ordered a product hidden in the qr catalog';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Toast' then raise; end if; end;
  -- F5. an inactive qr catalog: an empty menu and a refusal; active again, it orders (F2)
  update menu_catalogs set is_active = false where id = c_qr;
  if jsonb_array_length(qr_menu(v_t1.qr_token)->'categories') <> 0 then raise exception 'FAIL F5: a menu from an inactive qr catalog'; end if;
  begin perform place_table_order(v_t1.qr_token, null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL F5: QR ordered from an inactive qr catalog';
  exception when raise_exception then if sqlerrm <> 'This catalog is not available at this branch' then raise; end if; end;
  update menu_catalogs set is_active = true where id = c_qr;
  -- F6. no qr catalog: an empty menu and a clear refusal; back again, it orders
  delete from branch_catalogs where branch_id = v_branch and role = 'qr';
  if jsonb_array_length(qr_menu(v_t1.qr_token)->'categories') <> 0 then raise exception 'FAIL F6: a menu without a qr catalog'; end if;
  begin perform place_table_order(v_t1.qr_token, null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL F6: QR ordered with no qr catalog';
  exception when raise_exception then if sqlerrm <> 'No menu catalog is set for QR — set it in POS settings' then raise; end if; end;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch, 'qr', c_qr);

  -- ── G. sold-out: own branch only, and it applies in every catalog ──────────
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch2, v_toast, false);   -- VERIFY2's row
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch2, v_latte, true);
    raise exception 'FAIL G: a cashier marked another branch''s product sold out';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  update branch_menu_status set is_sold_out = true where branch_id = v_branch2 and product_id = v_toast;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL G: a cashier changed another branch''s sold-out'; end if;
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch, v_latte, true);   -- own branch: allowed
  reset role;
  begin perform place_counter_order(v_t1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_staff);
    raise exception 'FAIL G: sold out ignored in an additional catalog';
  exception when raise_exception then if sqlerrm <> 'Sold out: Verify Latte' then raise; end if; end;
  delete from branch_menu_status where branch_id = v_branch and product_id = v_latte;

  -- ── H. every menu write needs manage_menu: manager refused, owner allowed, resigned owner refused ─
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set status = 'resigned' where id = v_boss;                    -- is_active stays true, as in real life
  for r in select * from (values (v_mgr, false, 'manager'), (v_owner, true, 'owner'), (v_boss, false, 'resigned owner'))
                          as x(who, allowed, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update menu_products set sst_rate_bp = 0 where id = v_toast;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: menu_products update gave % rows', r.label, n; end if;
    update menu_variants set name = 'Regular' where id = v_toast_var;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: menu_variants update gave % rows', r.label, n; end if;
    update menu_catalogs set sort_order = 950 where id = c_grab;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: menu_catalogs update gave % rows', r.label, n; end if;
    update catalog_products set sort_order = 5 where catalog_id = c_dine and product_id = v_toast;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: catalog_products update gave % rows', r.label, n; end if;
    update catalog_variant_prices set price_sen = 811 where catalog_id = c_dine and variant_id = v_toast_var;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: catalog_variant_prices update gave % rows', r.label, n; end if;
    update catalog_option_prices set price_delta_sen = 300 where catalog_id = c_qr and option_id = v_opt;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: catalog_option_prices update gave % rows', r.label, n; end if;
    begin
      insert into menu_catalogs(name) values ('VERIFY by ' || r.label);
      insert into catalog_products(catalog_id, product_id, availability) values (c_take, v_toast, 'all');
      insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (c_take, v_toast_var, 800);
      insert into catalog_option_prices(catalog_id, option_id, price_delta_sen) values (c_take, v_opt, 150);
      if not r.allowed then raise exception 'FAIL H %: inserted catalog rows', r.label; end if;
    exception when insufficient_privilege then
      if r.allowed or sqlerrm not like '%row-level security%' then raise; end if;
    end;
    begin
      perform menu_set_catalog_product(c_grab, v_toast, 'counter_only');
      if not r.allowed then raise exception 'FAIL H %: menu_set_catalog_product was allowed', r.label; end if;
    exception when raise_exception then
      if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if;
    end;
    begin
      perform menu_import_catalogs('{"categories": [], "products": [], "groups": [], "links": [], "catalogs": []}'::jsonb);
      if not r.allowed then raise exception 'FAIL H %: menu_import_catalogs was allowed', r.label; end if;
    exception when raise_exception then
      if r.allowed or sqlerrm <> 'Not allowed to import the menu' then raise; end if;
    end;
    begin
      perform menu_import('{"categories": [], "products": [], "groups": [], "links": []}'::jsonb);
      if not r.allowed then raise exception 'FAIL H %: menu_import was allowed', r.label; end if;
    exception when raise_exception then
      if r.allowed or sqlerrm <> 'Not allowed to import the menu' then raise; end if;
    end;
    reset role;
  end loop;
  -- H2. putting a product in a catalog pre-fills the default price; taking it out keeps the row as hidden
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  if (select availability from catalog_products where catalog_id = c_grab and product_id = v_toast) is distinct from 'counter_only'
     or (select price_sen from catalog_variant_prices where catalog_id = c_grab and variant_id = v_toast_var) is distinct from 800 then
    raise exception 'FAIL H2: including a product did not pre-fill its default price';
  end if;
  perform menu_set_catalog_product(c_grab, v_toast, 'hidden');
  if (select availability from catalog_products where catalog_id = c_grab and product_id = v_toast) is distinct from 'hidden'
     or not exists (select 1 from catalog_variant_prices where catalog_id = c_grab and variant_id = v_toast_var) then
    raise exception 'FAIL H2: taking a product out must keep its row (hidden) and its price';
  end if;
  begin perform menu_set_catalog_product(c_grab, v_toast, 'sometimes'); raise exception 'FAIL H2: bad availability accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid availability' then raise; end if; end;
  begin perform menu_set_catalog_product(gen_random_uuid(), v_toast, 'all'); raise exception 'FAIL H2: unknown catalog accepted';
  exception when raise_exception then if sqlerrm <> 'Catalog not found' then raise; end if; end;
  begin perform menu_set_catalog_product(c_grab, gen_random_uuid(), 'all'); raise exception 'FAIL H2: unknown product accepted';
  exception when raise_exception then if sqlerrm <> 'Product not found' then raise; end if; end;

  -- ── I. branch catalogs: a manager of the branch only ──────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  begin perform save_branch_catalogs(jsonb_build_object('dineIn', c_dine, 'takeaway', c_take, 'qr', c_qr, 'additional', '[]'::jsonb));
    raise exception 'FAIL I: a cashier saved the branch catalogs';
  exception when raise_exception then if sqlerrm <> 'Only a manager can change the menu catalogs' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  begin perform save_branch_catalogs(jsonb_build_object('dineIn', c_dine, 'takeaway', c_take, 'qr', null, 'additional', '[]'::jsonb));
    raise exception 'FAIL I: saved without a QR catalog';
  exception when raise_exception then if sqlerrm <> 'Choose the QR catalog' then raise; end if; end;
  begin perform save_branch_catalogs(jsonb_build_object('dineIn', c_dine, 'takeaway', c_take, 'qr', c_qr, 'additional', jsonb_build_array(c_old)));
    raise exception 'FAIL I: saved an inactive catalog';
  exception when raise_exception then if sqlerrm <> 'This catalog is not available — refresh and try again' then raise; end if; end;
  begin perform save_branch_catalogs(jsonb_build_object('dineIn', 'nope', 'takeaway', c_take, 'qr', c_qr, 'additional', '[]'::jsonb));
    raise exception 'FAIL I: saved a malformed id';
  exception when raise_exception then if sqlerrm <> 'Invalid catalog settings' then raise; end if; end;
  set local role authenticated;
  perform save_branch_catalogs(jsonb_build_object('dineIn', c_dine, 'takeaway', c_dine, 'qr', c_qr,
                                                  'additional', jsonb_build_array(c_staff, c_grab, c_staff)));
  reset role;
  select string_agg(role || ':' || (select name from menu_catalogs m where m.id = catalog_id), ',' order by role, catalog_id::text)
    into v_text from branch_catalogs where branch_id = v_branch;
  if (select count(*) from branch_catalogs where branch_id = v_branch) <> 5
     or (select catalog_id from branch_catalogs where branch_id = v_branch and role = 'takeaway') <> c_dine
     or exists (select 1 from branch_catalogs where branch_id = v_branch and catalog_id = c_old)
     or (select count(*) from branch_catalogs where branch_id = v_branch2) <> 1 then
    raise exception 'FAIL I: saved rows %', v_text;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  if (select catalog_id from orders where id = v_order) is distinct from c_dine then
    raise exception 'FAIL I: a takeaway did not follow the new takeaway catalog';
  end if;
  -- direct writes: a manager of another branch and a cashier are refused; a manager's own branch is fine
  perform set_config('request.jwt.claims', json_build_object('sub', v_far, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch, 'additional', c_take);
    raise exception 'FAIL I: a manager of another branch changed this branch''s catalogs';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch2, 'additional', c_staff);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  begin insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch, 'additional', c_take);
    raise exception 'FAIL I: a cashier changed the branch catalogs';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  reset role;
  begin insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch, 'dine_in', c_grab);
    raise exception 'FAIL I: a branch got two dine-in catalogs';
  exception when unique_violation then null; end;

  -- ── J. the multi-catalog import ───────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_payload := $j${
    "categories": [{"name": "VERIFY M1 IMP", "sortOrder": 0}],
    "products": [
      {"feedmeId": "verify-m1-latte", "name": "Imp Latte", "internalName": null, "description": null, "category": "VERIFY M1 IMP",
       "availability": "all", "isAddon": false, "takeawayFeeSen": 0, "sortOrder": 0,
       "variants": [{"key": "k/hot", "name": "HOT", "priceSen": 1000, "sortOrder": 0},
                    {"key": "k/cold", "name": "COLD", "priceSen": 1100, "sortOrder": 1}]},
      {"feedmeId": "verify-m1-toast", "name": "Imp Toast", "internalName": null, "description": null, "category": "VERIFY M1 IMP",
       "availability": "all", "isAddon": false, "takeawayFeeSen": 0, "sortOrder": 1,
       "variants": [{"key": "", "name": "Regular", "priceSen": 700, "sortOrder": 0}]},
      {"feedmeId": "verify-m1-oat", "name": "Imp Oat", "internalName": null, "description": null, "category": "VERIFY M1 IMP",
       "availability": "all", "isAddon": true, "takeawayFeeSen": 0, "sortOrder": 2,
       "variants": [{"key": "", "name": "Regular", "priceSen": 200, "sortOrder": 0}]}
    ],
    "groups": [{"feedmeId": "verify-m1-milk", "name": "Imp Milk", "min": 0, "max": 1, "stackable": false, "sortOrder": 0,
                "options": [{"productFeedmeId": "verify-m1-oat", "variantKey": "", "name": "Imp Oat", "priceSen": 200,
                             "isDefault": false, "availability": "all", "sortOrder": 0}]}],
    "links": [{"productFeedmeId": "verify-m1-latte", "groupFeedmeId": "verify-m1-milk", "sortOrder": 0}],
    "catalogs": [
      {"name": "VERIFY Feedme A", "sortOrder": 0,
       "products": [{"feedmeId": "verify-m1-latte", "availability": "all", "sortOrder": 0,
                     "prices": [{"key": "k/hot", "priceSen": 1000}, {"key": "k/cold", "priceSen": 1150}]}],
       "optionPrices": [{"groupFeedmeId": "verify-m1-milk", "productFeedmeId": "verify-m1-oat", "variantKey": "", "priceSen": 250}]},
      {"name": "VERIFY Feedme B", "sortOrder": 1,
       "products": [{"feedmeId": "verify-m1-latte", "availability": "counter_only", "sortOrder": 1,
                     "prices": [{"key": "k/hot", "priceSen": 900}, {"key": "k/cold", "priceSen": 950}]},
                    {"feedmeId": "verify-m1-toast", "availability": "all", "sortOrder": 0,
                     "prices": [{"key": "", "priceSen": 650}]}],
       "optionPrices": []}
    ]
  }$j$;
  set local role authenticated;
  v_res := menu_import_catalogs(v_payload);
  reset role;
  if (v_res->>'products')::int <> 3
     or v_res->'catalogs' is distinct from '[{"name": "VERIFY Feedme A", "products": 1, "prices": 2, "optionPrices": 1},
                                             {"name": "VERIFY Feedme B", "products": 2, "prices": 3, "optionPrices": 0}]'::jsonb then
    raise exception 'FAIL J1: import report %', v_res;
  end if;
  select string_agg(c.name || '/' || p.name || '/' || cp.availability || '/' ||
                    (select string_agg(v.name || '=' || cvp.price_sen, '+' order by v.name)
                       from catalog_variant_prices cvp join menu_variants v on v.id = cvp.variant_id
                      where cvp.catalog_id = c.id and v.product_id = p.id), ',' order by c.name, p.name)
    into v_text
    from catalog_products cp join menu_catalogs c on c.id = cp.catalog_id join menu_products p on p.id = cp.product_id
   where c.feedme_catalog_name like 'VERIFY Feedme %';
  if v_text is distinct from 'VERIFY Feedme A/Imp Latte/all/COLD=1150+HOT=1000,'
                             'VERIFY Feedme B/Imp Latte/counter_only/COLD=950+HOT=900,VERIFY Feedme B/Imp Toast/all/Regular=650' then
    raise exception 'FAIL J1: catalogs after import %', v_text;
  end if;
  if (select cop.price_delta_sen from catalog_option_prices cop join menu_catalogs c on c.id = cop.catalog_id
       where c.name = 'VERIFY Feedme A') is distinct from 250 then
    raise exception 'FAIL J1: the add-on price of catalog A';
  end if;
  if exists (select 1 from branch_catalogs bc join menu_catalogs c on c.id = bc.catalog_id where c.name like 'VERIFY Feedme %') then
    raise exception 'FAIL J1: the import assigned a catalog to a branch';
  end if;
  -- J2. importing again: what the file drops from a catalog is hidden, never deleted; nothing doubles
  v_payload := jsonb_set(v_payload, '{catalogs,0,products}',
    '[{"feedmeId": "verify-m1-toast", "availability": "all", "sortOrder": 0, "prices": [{"key": "", "priceSen": 600}]}]'::jsonb);
  perform menu_import_catalogs(v_payload);
  select string_agg(p.name || '/' || cp.availability, ',' order by p.name) into v_text
    from catalog_products cp join menu_catalogs c on c.id = cp.catalog_id join menu_products p on p.id = cp.product_id
   where c.name = 'VERIFY Feedme A';
  if v_text is distinct from 'Imp Latte/hidden,Imp Toast/all'
     or (select count(*) from menu_catalogs where name like 'VERIFY Feedme %') <> 2
     or (select cop.price_delta_sen from catalog_option_prices cop join menu_catalogs c on c.id = cop.catalog_id
          where c.name = 'VERIFY Feedme A') is distinct from 250 then
    raise exception 'FAIL J2: re-import gave %', v_text;
  end if;
  -- J3. a catalog missing a variant price is refused and leaves nothing behind
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs}', (v_payload->'catalogs') ||
      '[{"name": "VERIFY Feedme C", "sortOrder": 2, "optionPrices": [],
         "products": [{"feedmeId": "verify-m1-latte", "availability": "all", "sortOrder": 0,
                       "prices": [{"key": "k/hot", "priceSen": 1000}]}]}]'::jsonb));
    raise exception 'FAIL J3: a catalog without every variant price was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Catalog VERIFY Feedme C: Imp Latte / COLD has no price' then raise; end if;
  end;
  if exists (select 1 from menu_catalogs where name = 'VERIFY Feedme C') then raise exception 'FAIL J3: a refused import left a catalog'; end if;
  -- J4. malformed catalogs
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,0,products,0,availability}', '"hidden"'::jsonb));
    raise exception 'FAIL J4: availability hidden accepted in the file';
  exception when raise_exception then
    if sqlerrm <> 'Invalid import file: a catalog product has no availability or prices' then raise; end if;
  end;
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,1,name}', '"VERIFY Feedme A"'::jsonb));
    raise exception 'FAIL J4: a catalog listed twice was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid import file: a catalog appears twice' then raise; end if;
  end;
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,1,products,0,prices,0,priceSen}', '-1'::jsonb));
    raise exception 'FAIL J4: a negative price was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid import file: a catalog price is not a whole number of sen' then raise; end if;
  end;
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,1,products}',
      (v_payload #> '{catalogs,1,products}') || (v_payload #> '{catalogs,1,products,0}')));
    raise exception 'FAIL J4: a product listed twice in one catalog was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid import file: a catalog lists a product twice' then raise; end if;
  end;
  -- J5. a Craft OS catalog of the same name that stands for another Feedme sheet is refused in plain words
  insert into menu_catalogs(name, feedme_catalog_name) values ('VERIFY Feedme D', 'VERIFY Elsewhere');
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,1,name}', '"VERIFY Feedme D"'::jsonb));
    raise exception 'FAIL J5: a catalog name clash was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Catalog VERIFY Feedme D already exists under another Feedme name' then raise; end if;
  end;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 2: Bring the ordering verify script up to M1** (`supabase/migration-2026-10-23-pos-ordering-verify.sql`). Its fixture branch has no catalog, its grant checks name the old signatures, and it switches `menu_products.availability`, which ordering no longer reads. Exact edits:

1. Replace `  v_items   jsonb;` with:

```sql
  v_items   jsonb;
  v_catalog uuid;
```

2. Replace `'place_counter_order(uuid,text,integer,jsonb,uuid)'` (once) with `'place_counter_order(uuid,text,integer,jsonb,uuid,uuid)'`.
3. Replace both occurrences of `'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)'` with `'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)'`.
4. Replace `  insert into product_modifier_groups(product_id, group_id) values (v_latte, v_milk);` with:

```sql
  insert into product_modifier_groups(product_id, group_id) values (v_latte, v_milk);
  -- M1 (catalogs): the VERIFY branch sells the latte from one catalog for dine-in, takeaway and QR, at the default prices
  insert into menu_catalogs(name) values ('VERIFY O CATALOG') returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_latte, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_hot, 1200), (v_catalog, v_cold, 1300);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
```

5. Replace both occurrences of `update menu_products set availability = 'counter_only' where id = v_latte;` with `update catalog_products set availability = 'counter_only' where catalog_id = v_catalog and product_id = v_latte;`
6. Replace `update menu_products set availability = 'all' where id = v_latte;` (once) with `update catalog_products set availability = 'all' where catalog_id = v_catalog and product_id = v_latte;`

- [ ] **Step 3: Bring the checkout verify script up to M1** (`supabase/migration-2026-10-24-pos-checkout-verify.sql`). Exact edits:

1. Replace `  v_cat uuid; v_plate uuid; v_plate_var uuid;` with `  v_cat uuid; v_plate uuid; v_plate_var uuid; v_catalog uuid;`
2. Replace `'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)'` (once) with `'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)'`.
3. Replace `    returning id into v_plate_var;` (once) with:

```sql
    returning id into v_plate_var;
  -- M1 (catalogs): the VERIFY branch sells the plate from one catalog for dine-in, takeaway and QR, at the default price
  insert into menu_catalogs(name) values ('VERIFY C CATALOG') returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_plate, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_plate_var, 2000);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', v_catalog), (v_branch, 'takeaway', v_catalog), (v_branch, 'qr', v_catalog);
```

   The 22 vectors and every expected total stay as they are (the plate still costs 2000).

- [ ] **Step 4: Bring the menu verify script up to M1** (`supabase/migration-2026-10-22-pos-menu-verify.sql`). Its A2 matches table names `like 'menu_%'`, which now also catches `menu_catalogs` and its insert policy. Replace

```sql
  -- A2. nobody but RPCs inserts or deletes
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename like any (array['menu_%','modifier_%','product_modifier_groups'])
```

with

```sql
  -- A2. nobody but RPCs inserts or deletes (the six master tables; M1's catalog tables have their own checks)
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('menu_categories','menu_products','menu_variants',
                                'modifier_groups','modifier_options','product_modifier_groups')
```

   Nothing else in it changes: B1 still expects `Not allowed…` from a user with no role, B2–B9 run as the owner (who holds `manage_menu`), C2 still finds `has_menu_cap` in the two edit policies.

- [ ] **Step 5: Local checks.** Run: `grep -c "VERIFY OK" supabase/migration-2026-10-24-pos-catalogs-verify.sql` — Expected: `3` (the header comment, the notice and the final select). Run: `grep -c "pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)'" supabase/*-verify.sql | grep -v ':0'` — Expected: no output. Run: `grep -c "catalog_id = v_catalog and product_id = v_latte" supabase/migration-2026-10-23-pos-ordering-verify.sql` — Expected: `3`. Run: `npx vitest run src/features/pos/checkout` — Expected: PASS (the vectors file is untouched, so `bill.test.ts`'s byte-for-byte check against the checkout verify script still passes).

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-10-24-pos-catalogs-verify.sql supabase/migration-2026-10-22-pos-menu-verify.sql supabase/migration-2026-10-23-pos-ordering-verify.sql supabase/migration-2026-10-24-pos-checkout-verify.sql
git commit -m "test(pos-menu): verify script for catalogs M1; earlier verify scripts get catalog fixtures and the new signatures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7 (controller, craft-os-dev — dashboard SQL editor in the owner's Chrome tab; the implementer does not touch the database):** confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`) — never the prod project. Load each file with `window.monaco.editor.getModels()[0].setValue(...)` and run it with `cmd+Return`, in order:
  1. `migration-2026-10-24-pos-catalogs.sql` → one row `catalogs schema applied` (if the dashboard warns about RLS or a destructive statement, it is the `drop policy if exists` lines — run anyway).
  2. `migration-2026-10-24-pos-catalogs-fn.sql` → `catalog functions applied`.
  3. The backfill, before anything else touches catalogs:

```sql
select (select count(*) from catalog_products cp join menu_catalogs c on c.id = cp.catalog_id
         where c.name = 'Craft Cafe' and cp.availability <> 'hidden')                          as in_craft_cafe,
       (select count(*) from menu_products where is_active and availability <> 'hidden')        as visible_today,
       (select count(*) from catalog_variant_prices cvp join menu_catalogs c on c.id = cvp.catalog_id
          join menu_variants v on v.id = cvp.variant_id
         where c.name = 'Craft Cafe' and cvp.price_sen <> v.price_sen)                          as price_mismatches,
       (select count(distinct branch_id) from branch_catalogs)                                  as branches_with_catalogs,
       (select count(*) from branches where coalesce(is_active, true))                          as active_branches;
```

     Expected: `in_craft_cafe = visible_today` (248 if dev's menu is still the 2026-10-22 import of the Craft Cafe sheet), `price_mismatches = 0`, `branches_with_catalogs = active_branches`.
  4. `migration-2026-10-24-pos-catalogs-verify.sql` → `VERIFY OK`.
  5. Regression, each → `VERIFY OK`: `migration-2026-10-22-pos-menu-verify.sql`, `migration-2026-10-23-pos-ordering-verify.sql`, `migration-2026-10-24-pos-checkout-verify.sql`.

  If a script stops with `FAIL …`, the message names the check: fix the function or migration file (implementer, new commit), re-run that file, then re-run the verify. Until Task 4 lands, the POS counter still reads the master availability for its menu but the server prices from Craft Cafe — the two agree because Craft Cafe was just made from the master. Record the outcome in the ledger.

---

### Task 4: Catalog resolution and catalog-aware menu loading (pure `catalogs.ts`, `buildPosMenu`, `fetchPosMenu`)

**Files:**
- Create: `src/features/pos/order/catalogs.ts`, `src/features/pos/order/catalogs.test.ts`
- Modify: `src/features/pos/order/cart.ts`, `src/features/pos/order/cart.test.ts`, `src/features/pos/order/posApi.ts`, `src/features/pos/order/OrderPad.tsx`, `src/features/pos/order/PosPage.tsx`

**Interfaces:**
- Consumes: Task 1 tables (read under `menu_read`); `fetchProductNames(): Promise<{ id: string; name: string }[]>` (`src/features/pos/checkout/checkoutApi.ts`); `OrderType` (`src/features/pos/offline/orderQueue.ts`).
- Produces:
  - `catalogs.ts`: `type CatalogRole = 'dine_in'|'takeaway'|'qr'|'additional'`, `type DefaultRole = Exclude<CatalogRole,'additional'>`, `interface CatalogRow { id; name; is_active; sort_order }`, `interface BranchCatalogRow { role: CatalogRole; catalog_id: string }`, `interface BranchCatalogs { catalogs: CatalogRow[]; assignments: BranchCatalogRow[] }`, `interface CatalogChoice { id; name; isDefault: boolean; offered: boolean }` (`offered` is false only for an edited order's catalog the branch no longer offers), `interface BranchCatalogSettings { dineIn: string|null; takeaway: string|null; qr: string|null; additional: string[] }`, `SWITCH_CATALOG_CONFIRM = 'Switching catalog clears the cart'`, `noCatalogMessage(role: DefaultRole): string`, `activeCatalogs(catalogs): CatalogRow[]`, `defaultCatalogId(rows, role: DefaultRole): string|null`, `defaultCatalogProblem(rows, catalogs, role: DefaultRole): string|null` (none set, or `The dine-in catalog <name> is switched off — choose another in POS settings`), `selectableCatalogs(rows, catalogs, orderType: OrderType, keepId: string|null = null): CatalogChoice[]` (an inactive default is left out, so then no entry `isDefault`), `catalogSettingsFrom(rows): BranchCatalogSettings`, `catalogSettingsProblem(s, catalogs: CatalogRow[] = []): string|null`, `settingsToSave(s, catalogs): BranchCatalogSettings` (drops switched-off additional catalogs), `additionalChoices(s, catalogs): CatalogRow[]` (active catalogs plus switched-off ones still ticked), `toggleAdditional(s, id, on): BranchCatalogSettings`
  - `cart.ts`: `ProductRow` loses `availability` and `menu_variants[].price_sen`; new `CatalogProductRow { product_id; availability; sort_order }`, `VariantPriceRow { variant_id; price_sen }`, `OptionPriceRow { option_id; price_delta_sen }`, `CatalogRows { products; prices; optionPrices }`; `buildPosMenu(products, groups, links, soldOut, mode, catalog: CatalogRows): PosMenu`
  - `posApi.ts`: `fetchPosMenu(branchId: string, catalogId: string): Promise<PosMenu>`, `fetchBranchCatalogs(branchId: string): Promise<BranchCatalogs>`
  - `OrderPad` props (interim, replaced in Task 7): `catalogId: string | null`, `catalogsLoaded: boolean`

- [ ] **Step 1: Write the failing test** `src/features/pos/order/catalogs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  activeCatalogs, additionalChoices, catalogSettingsFrom, catalogSettingsProblem, defaultCatalogId, defaultCatalogProblem,
  noCatalogMessage, selectableCatalogs, settingsToSave, toggleAdditional, type BranchCatalogRow, type CatalogRow,
} from './catalogs'

const cat = (id: string, name: string, sort_order: number, is_active = true): CatalogRow => ({ id, name, sort_order, is_active })
const catalogs = [
  cat('c-cafe', 'Craft Cafe', 0), cat('c-take', 'Takeaway Menu', 1), cat('c-staff', 'Staff Meal', 3),
  cat('c-grab', 'Grab Food', 2), cat('c-old', 'Old Promo', 4, false),
]
const rows: BranchCatalogRow[] = [
  { role: 'dine_in', catalog_id: 'c-cafe' }, { role: 'takeaway', catalog_id: 'c-take' }, { role: 'qr', catalog_id: 'c-cafe' },
  { role: 'additional', catalog_id: 'c-staff' }, { role: 'additional', catalog_id: 'c-grab' },
  { role: 'additional', catalog_id: 'c-old' }, { role: 'additional', catalog_id: 'c-cafe' },
]
const cafeOff = catalogs.map((c) => (c.id === 'c-cafe' ? { ...c, is_active: false } : c))

describe('defaultCatalogId', () => {
  it('is the branch catalog for the role, or null', () => {
    expect(defaultCatalogId(rows, 'dine_in')).toBe('c-cafe')
    expect(defaultCatalogId(rows, 'takeaway')).toBe('c-take')
    expect(defaultCatalogId([], 'qr')).toBeNull()
  })
})

describe('defaultCatalogProblem', () => {
  it('is null for an active default, else the reason in the pad\'s words', () => {
    expect(defaultCatalogProblem(rows, catalogs, 'dine_in')).toBeNull()
    expect(defaultCatalogProblem([], catalogs, 'takeaway')).toBe('No menu catalog is set for takeaway — set it in POS settings')
    expect(defaultCatalogProblem(rows, cafeOff, 'dine_in')).toBe('The dine-in catalog Craft Cafe is switched off — choose another in POS settings')
  })
})

describe('selectableCatalogs', () => {
  it('puts the order type default first, then active additional catalogs in catalog order, each once', () => {
    expect(selectableCatalogs(rows, catalogs, 'dine_in')).toEqual([
      { id: 'c-cafe', name: 'Craft Cafe', isDefault: true, offered: true },
      { id: 'c-grab', name: 'Grab Food', isDefault: false, offered: true },
      { id: 'c-staff', name: 'Staff Meal', isDefault: false, offered: true },
    ])
  })

  it('a takeaway starts from the takeaway catalog; another type\'s default is offered only if it is additional', () => {
    expect(selectableCatalogs(rows, catalogs, 'takeaway').map((c) => c.id)).toEqual(['c-take', 'c-cafe', 'c-grab', 'c-staff'])
  })

  it('with an inactive or missing default nothing is the default, so the pad waits for a pick', () => {
    const off = selectableCatalogs(rows, cafeOff, 'dine_in')
    expect(off.map((c) => c.id)).toEqual(['c-grab', 'c-staff'])
    expect(off.some((c) => c.isDefault)).toBe(false)
    expect(selectableCatalogs(rows.filter((r) => r.role !== 'takeaway'), catalogs, 'takeaway').some((c) => c.isDefault)).toBe(false)
    expect(selectableCatalogs([], catalogs, 'dine_in')).toEqual([])
  })

  it('keeps the catalog of an order being edited even when it is no longer offered', () => {
    expect(selectableCatalogs(rows, catalogs, 'dine_in', 'c-old')[3]).toEqual({ id: 'c-old', name: 'Old Promo', isDefault: false, offered: false })
    expect(selectableCatalogs(rows, catalogs, 'dine_in', 'c-gone')[3]).toEqual({ id: 'c-gone', name: 'Unknown catalog', isDefault: false, offered: false })
    expect(selectableCatalogs(rows, catalogs, 'dine_in', 'c-staff')).toHaveLength(3)
  })
})

describe('settings', () => {
  it('reads the branch rows into the form and lists active catalogs in order', () => {
    expect(catalogSettingsFrom(rows)).toEqual({ dineIn: 'c-cafe', takeaway: 'c-take', qr: 'c-cafe', additional: ['c-staff', 'c-grab', 'c-old', 'c-cafe'] })
    expect(activeCatalogs(catalogs).map((c) => c.id)).toEqual(['c-cafe', 'c-take', 'c-grab', 'c-staff'])
  })

  it('needs all three defaults, in the server\'s words, and says when one is switched off', () => {
    const ok = catalogSettingsFrom(rows)
    expect(catalogSettingsProblem(ok, catalogs)).toBeNull()
    expect(catalogSettingsProblem({ ...ok, dineIn: null })).toBe('Choose the dine-in catalog')
    expect(catalogSettingsProblem({ ...ok, takeaway: null })).toBe('Choose the takeaway catalog')
    expect(catalogSettingsProblem({ ...ok, qr: null })).toBe('Choose the QR catalog')
    expect(catalogSettingsProblem({ ...ok, qr: 'c-old' }, catalogs)).toBe('The QR catalog Old Promo is switched off — choose another')
  })

  it('shows a switched-off additional catalog only while it is ticked, and never sends it', () => {
    const ok = catalogSettingsFrom(rows)
    expect(additionalChoices(ok, catalogs).map((c) => c.id)).toEqual(['c-cafe', 'c-take', 'c-grab', 'c-staff', 'c-old'])
    expect(additionalChoices(toggleAdditional(ok, 'c-old', false), catalogs).map((c) => c.id)).not.toContain('c-old')
    expect(settingsToSave(ok, catalogs).additional).toEqual(['c-staff', 'c-grab', 'c-cafe'])
  })

  it('ticks and unticks an additional catalog without repeats', () => {
    const s = { dineIn: 'a', takeaway: 'a', qr: 'a', additional: ['x'] }
    expect(toggleAdditional(s, 'x', true).additional).toEqual(['x'])
    expect(toggleAdditional(s, 'y', true).additional).toEqual(['x', 'y'])
    expect(toggleAdditional(s, 'x', false).additional).toEqual([])
  })
})

describe('noCatalogMessage', () => {
  it('uses the server\'s words', () => {
    expect(noCatalogMessage('dine_in')).toBe('No menu catalog is set for dine-in — set it in POS settings')
    expect(noCatalogMessage('takeaway')).toBe('No menu catalog is set for takeaway — set it in POS settings')
    expect(noCatalogMessage('qr')).toBe('No menu catalog is set for QR — set it in POS settings')
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/order/catalogs.test.ts` — Expected: FAIL (`Failed to resolve import "./catalogs"`).

- [ ] **Step 3: Write** `src/features/pos/order/catalogs.ts`:

```ts
// src/features/pos/order/catalogs.ts
/** Which menu catalog prices an order. Mirrors pos_order_catalog
 *  (supabase/migration-2026-10-24-pos-catalogs-fn.sql): the branch's catalog for
 *  the order type is the default, and at the counter the cashier may switch the
 *  whole order to one of the branch's additional catalogs. Same words as the server. */
import type { OrderType } from '../offline/orderQueue'

export type CatalogRole = 'dine_in' | 'takeaway' | 'qr' | 'additional'
export type DefaultRole = Exclude<CatalogRole, 'additional'>
export interface CatalogRow { id: string; name: string; is_active: boolean; sort_order: number }
export interface BranchCatalogRow { role: CatalogRole; catalog_id: string }
export interface BranchCatalogs { catalogs: CatalogRow[]; assignments: BranchCatalogRow[] }
/** One entry of the order pad's catalog list. `offered` is false only for the catalog
 *  of an edited order that the branch no longer offers. */
export interface CatalogChoice { id: string; name: string; isDefault: boolean; offered: boolean }
/** What save_branch_catalogs takes (POS settings → Menu catalogs). */
export interface BranchCatalogSettings { dineIn: string | null; takeaway: string | null; qr: string | null; additional: string[] }

export const SWITCH_CATALOG_CONFIRM = 'Switching catalog clears the cart'

const ROLE_WORDS: Record<DefaultRole, string> = { dine_in: 'dine-in', takeaway: 'takeaway', qr: 'QR' }

/** pos_order_catalog's words when the branch has no catalog for the role. */
export function noCatalogMessage(role: DefaultRole): string {
  return `No menu catalog is set for ${ROLE_WORDS[role]} — set it in POS settings`
}

const bySort = (a: CatalogRow, b: CatalogRow) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)

/** Active catalogs in their order (what the settings selects and ticks offer). */
export function activeCatalogs(catalogs: CatalogRow[]): CatalogRow[] {
  return catalogs.filter((c) => c.is_active).sort(bySort)
}

export function defaultCatalogId(rows: BranchCatalogRow[], role: DefaultRole): string | null {
  return rows.find((r) => r.role === role)?.catalog_id ?? null
}

/** Why the order type has no usable default (null when it has one): none is set, or
 *  the one set is switched off. The pad shows this and waits for an explicit pick. */
export function defaultCatalogProblem(rows: BranchCatalogRow[], catalogs: CatalogRow[], role: DefaultRole): string | null {
  const id = defaultCatalogId(rows, role)
  if (!id) return noCatalogMessage(role)
  const c = catalogs.find((x) => x.id === id)
  if (!c) return noCatalogMessage(role)
  return c.is_active ? null : `The ${ROLE_WORDS[role]} catalog ${c.name} is switched off — choose another in POS settings`
}

/** The order pad's catalog list: the order type's default first (only when it is
 *  active), then the branch's additional catalogs in catalog order — active ones only,
 *  each once. An order being edited keeps its own catalog even when it is no longer
 *  offered (`offered: false`; the server would refuse it in its own words). */
export function selectableCatalogs(
  rows: BranchCatalogRow[], catalogs: CatalogRow[], orderType: OrderType, keepId: string | null = null,
): CatalogChoice[] {
  const byId = new Map(catalogs.map((c) => [c.id, c]))
  const out: CatalogChoice[] = []
  const def = byId.get(defaultCatalogId(rows, orderType) ?? '')
  if (def?.is_active) out.push({ id: def.id, name: def.name, isDefault: true, offered: true })
  const extra = rows
    .filter((r) => r.role === 'additional')
    .map((r) => byId.get(r.catalog_id))
    .filter((c): c is CatalogRow => c !== undefined && c.is_active)
    .sort(bySort)
  for (const c of extra) if (!out.some((o) => o.id === c.id)) out.push({ id: c.id, name: c.name, isDefault: false, offered: true })
  if (keepId && !out.some((o) => o.id === keepId)) {
    out.push({ id: keepId, name: byId.get(keepId)?.name ?? 'Unknown catalog', isDefault: false, offered: false })
  }
  return out
}

export function catalogSettingsFrom(rows: BranchCatalogRow[]): BranchCatalogSettings {
  return {
    dineIn: defaultCatalogId(rows, 'dine_in'),
    takeaway: defaultCatalogId(rows, 'takeaway'),
    qr: defaultCatalogId(rows, 'qr'),
    additional: rows.filter((r) => r.role === 'additional').map((r) => r.catalog_id),
  }
}

/** Same words as save_branch_catalogs, plus a clearer one for a default that was switched off. */
export function catalogSettingsProblem(s: BranchCatalogSettings, catalogs: CatalogRow[] = []): string | null {
  const roles: [DefaultRole, string | null][] = [['dine_in', s.dineIn], ['takeaway', s.takeaway], ['qr', s.qr]]
  for (const [role, id] of roles) {
    if (!id) return `Choose the ${ROLE_WORDS[role]} catalog`
    const c = catalogs.find((x) => x.id === id)
    if (c && !c.is_active) return `The ${ROLE_WORDS[role]} catalog ${c.name} is switched off — choose another`
  }
  return null
}

/** What Save sends: a ticked additional catalog that was switched off since is dropped
 *  (the server refuses inactive catalogs), so it never blocks saving the rest. */
export function settingsToSave(s: BranchCatalogSettings, catalogs: CatalogRow[]): BranchCatalogSettings {
  const active = new Set(catalogs.filter((c) => c.is_active).map((c) => c.id))
  return { ...s, additional: s.additional.filter((id) => active.has(id)) }
}

/** The additional tick boxes: every active catalog, plus any switched-off catalog that is
 *  still ticked (shown so it can be unticked), in catalog order. */
export function additionalChoices(s: BranchCatalogSettings, catalogs: CatalogRow[]): CatalogRow[] {
  return catalogs.filter((c) => c.is_active || s.additional.includes(c.id)).sort(bySort)
}

export function toggleAdditional(s: BranchCatalogSettings, id: string, on: boolean): BranchCatalogSettings {
  return { ...s, additional: on ? [...new Set([...s.additional, id])] : s.additional.filter((x) => x !== id) }
}
```

- [ ] **Step 4: Run it to verify it passes.** Run: `npx vitest run src/features/pos/order/catalogs.test.ts` — Expected: PASS (11 tests).

- [ ] **Step 5: Write the failing cart test.** Replace `src/features/pos/order/cart.test.ts` with (the `describe('lines')` and `describe('posMenuFromQr')` blocks are the existing ones; only their two `buildPosMenu` calls gain `catalog`):

```ts
import { describe, it, expect } from 'vitest'
import {
  buildPosMenu, posMenuFromQr, defaultLine, linePriceSen, validateLine, lineLabel, cartSubtotalSen, cartKey, formatSen,
  type CatalogRows, type ProductRow, type GroupRow, type LinkRow,
} from './cart'

const latte: ProductRow = {
  id: 'p-latte', name: 'Coffee Latte ', description: null, is_addon: false, is_active: true, sort_order: 2,
  category: { name: 'MILK COFFEE', sort_order: 1 },
  menu_variants: [
    { id: 'v-cold', name: 'COLD', is_active: true, sort_order: 1, feedme_variant_key: 'v/cold' },
    { id: 'v-hot', name: 'HOT', is_active: true, sort_order: 0, feedme_variant_key: 'v/hot' },
    { id: 'v-old', name: 'OLD', is_active: false, sort_order: 9, feedme_variant_key: 'v/old' },
  ],
}
const water: ProductRow = {
  id: 'p-water', name: 'Sky Juice', description: null, is_addon: false, is_active: true, sort_order: 0,
  category: { name: 'TEA', sort_order: 2 },
  menu_variants: [{ id: 'v-water', name: 'Sky Juice', is_active: true, sort_order: 0, feedme_variant_key: '' }],
}
const oat: ProductRow = { ...water, id: 'p-oat', name: 'Oat milk', is_addon: true, menu_variants: [] }
const hidden: ProductRow = { ...water, id: 'p-hidden', name: 'Secret', menu_variants: [{ ...water.menu_variants[0], id: 'v-hidden' }] }
const elsewhere: ProductRow = { ...water, id: 'p-elsewhere', name: 'Grab only', menu_variants: [{ ...water.menu_variants[0], id: 'v-elsewhere' }] }
const milk: GroupRow = {
  id: 'g-milk', name: 'Milk', min_select: 0, max_select: 1, is_active: true, sort_order: 0,
  modifier_options: [
    { id: 'o-oat', name: 'Oat milk', price_delta_sen: 200, is_default: false, availability: 'all', sort_order: 1, product_id: 'p-oat' },
    { id: 'o-full', name: 'Full cream', price_delta_sen: 0, is_default: true, availability: 'all', sort_order: 0, product_id: null },
    { id: 'o-secret', name: 'Hidden', price_delta_sen: 0, is_default: false, availability: 'hidden', sort_order: 2, product_id: null },
  ],
}
const links: LinkRow[] = [{ product_id: 'p-latte', group_id: 'g-milk', sort_order: 0 }]
// the order's catalog: latte everywhere, water at the counter only, the secret hidden, 'elsewhere' not in it
const catalog: CatalogRows = {
  products: [
    { product_id: 'p-latte', availability: 'all', sort_order: 2 },
    { product_id: 'p-water', availability: 'counter_only', sort_order: 0 },
    { product_id: 'p-oat', availability: 'all', sort_order: 5 },
    { product_id: 'p-hidden', availability: 'hidden', sort_order: 1 },
  ],
  prices: [
    { variant_id: 'v-cold', price_sen: 1400 }, { variant_id: 'v-hot', price_sen: 1200 }, { variant_id: 'v-old', price_sen: 1 },
    { variant_id: 'v-water', price_sen: 100 }, { variant_id: 'v-hidden', price_sen: 100 }, { variant_id: 'v-elsewhere', price_sen: 100 },
  ],
  optionPrices: [],
}

describe('buildPosMenu', () => {
  it('groups by category in sort order, hides add-ons, hidden and variant-less products', () => {
    const m = buildPosMenu([water, latte, oat, hidden], [milk], links, [], 'counter', catalog)
    expect(m.categories.map((c) => c.name)).toEqual(['MILK COFFEE', 'TEA'])
    expect(m.categories[1].products.map((p) => p.name)).toEqual(['Sky Juice'])
    const p = m.categories[0].products[0]
    expect(p.name).toBe('Coffee Latte')                       // trimmed
    expect(p.variants.map((v) => v.name)).toEqual(['HOT', 'COLD'])  // active only, by sort_order
    expect(p.variants.map((v) => v.priceSen)).toEqual([1200, 1400])  // the catalog's prices
    expect(p.groups[0].options.map((o) => o.name)).toEqual(['Full cream', 'Oat milk'])  // hidden option dropped
  })

  it('orders products inside a category by the catalog\'s sort_order then name, whatever the input order', () => {
    const a = { ...water, id: 'p-a', name: 'B tea', sort_order: 9 }
    const b = { ...water, id: 'p-b', name: 'A tea', sort_order: 0 }
    const c = { ...water, id: 'p-c', name: 'Z first', sort_order: 5 }
    const cat: CatalogRows = {
      products: [{ product_id: 'p-a', availability: 'all', sort_order: 1 }, { product_id: 'p-b', availability: 'all', sort_order: 1 },
                 { product_id: 'p-c', availability: 'all', sort_order: 0 }],
      prices: [{ variant_id: 'v-water', price_sen: 100 }],
      optionPrices: [],
    }
    const m = buildPosMenu([a, b, c], [], [], [], 'counter', cat)
    expect(m.categories[0].products.map((p) => p.name)).toEqual(['Z first', 'A tea', 'B tea'])
  })

  it('qr mode drops counter_only products and marks sold-out products and options', () => {
    const m = buildPosMenu([water, latte, oat], [milk], links, [{ product_id: 'p-oat', is_sold_out: true }], 'qr', catalog)
    expect(m.categories.map((c) => c.name)).toEqual(['MILK COFFEE'])
    const p = m.categories[0].products[0]
    expect(p.soldOut).toBe(false)
    expect(p.groups[0].options.find((o) => o.id === 'o-oat')?.available).toBe(false)
  })

  it('leaves out products the catalog does not sell, whatever the master list says', () => {
    const m = buildPosMenu([latte, elsewhere], [milk], links, [], 'counter', catalog)
    expect(m.categories.flatMap((c) => c.products.map((p) => p.id))).toEqual(['p-latte'])
  })

  it('offers only the variants the catalog prices, and drops a product with none', () => {
    const cat = { ...catalog, prices: catalog.prices.filter((p) => p.variant_id !== 'v-cold' && p.variant_id !== 'v-water') }
    const m = buildPosMenu([latte, water], [milk], links, [], 'counter', cat)
    expect(m.categories.map((c) => c.name)).toEqual(['MILK COFFEE'])
    expect(m.categories[0].products[0].variants.map((v) => v.id)).toEqual(['v-hot'])
  })

  it('an add-on costs the catalog\'s price when it sets one (0 included), else its own', () => {
    const cat = { ...catalog, optionPrices: [{ option_id: 'o-oat', price_delta_sen: 0 }] }
    const p = buildPosMenu([latte], [milk], links, [], 'counter', cat).categories[0].products[0]
    expect(p.groups[0].options.find((o) => o.id === 'o-oat')?.priceDeltaSen).toBe(0)
    expect(linePriceSen(p, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] })).toBe(1400)
    const plain = buildPosMenu([latte], [milk], links, [], 'counter', catalog).categories[0].products[0]
    expect(plain.groups[0].options.find((o) => o.id === 'o-oat')?.priceDeltaSen).toBe(200)
  })
})

describe('lines', () => {
  const menu = buildPosMenu([latte], [milk], links, [], 'counter', catalog)
  const p = menu.categories[0].products[0]

  it('defaultLine picks the first variant and the default options', () => {
    expect(defaultLine(p)).toEqual({ productId: 'p-latte', variantId: 'v-hot', qty: 1, note: null, optionIds: ['o-full'] })
  })

  it('prices variant + modifiers', () => {
    expect(linePriceSen(p, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] })).toBe(1600)
    expect(linePriceSen(p, { ...defaultLine(p), variantId: 'v-nope' })).toBeNull()
  })

  it('validates with the server’s words', () => {
    const ok = defaultLine(p)
    expect(validateLine(p, ok)).toBeNull()
    expect(validateLine(p, { ...ok, optionIds: ['o-oat', 'o-oat'] })).toBe('Invalid add-ons')
    expect(validateLine(p, { ...ok, optionIds: ['o-oat', 'o-full'] })).toBe('Choose at most 1 for Coffee Latte: Milk')
    expect(validateLine({ ...p, groups: [{ ...p.groups[0], min: 1 }] }, { ...ok, optionIds: [] })).toBe('Choose at least 1 for Coffee Latte: Milk')
    expect(validateLine(p, { ...ok, optionIds: ['o-nope'] })).toBe('Add-on is not available for Coffee Latte')
    expect(validateLine(p, { ...ok, qty: 21 })).toBe('Invalid quantity')
    expect(validateLine({ ...p, soldOut: true }, ok)).toBe('Sold out: Coffee Latte')
  })

  it('labels like the server snapshot', () => {
    expect(lineLabel(p, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] })).toEqual({ name: 'Coffee Latte (COLD)', mods: ['Oat milk'] })
    const single = buildPosMenu([water], [], [], [], 'counter', catalog).categories[0].products[0]
    expect(lineLabel(single, defaultLine(single)).name).toBe('Sky Juice')   // base variant: no suffix
  })

  it('lists modifiers in menu order, not in the order they were tapped', () => {
    const two = { ...p, groups: [{ ...p.groups[0], max: 2 }] }
    expect(lineLabel(two, { ...defaultLine(two), optionIds: ['o-oat', 'o-full'] }).mods).toEqual(['Full cream', 'Oat milk'])
  })

  it('subtotal and a stable key', () => {
    const lines = [{ ...defaultLine(p), qty: 2 }, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] }]
    expect(cartSubtotalSen(menu, lines)).toBe(2400 + 1600)
    expect(cartKey(lines)).toBe(cartKey([...lines].map((l) => ({ ...l, optionIds: [...l.optionIds] }))))
    expect(cartKey(lines)).not.toBe(cartKey(lines.slice(1)))
  })

  it('formats sen as ringgit', () => {
    expect(formatSen(1250)).toBe('RM 12.50')
    expect(formatSen(0)).toBe('RM 0.00')
  })
})

describe('posMenuFromQr', () => {
  it('maps the qr_menu json', () => {
    const m = posMenuFromQr({
      tableLabel: 'T1', paused: false, needsPax: true,
      categories: [{ name: 'TEA', products: [{ id: 'p', name: 'Tea', description: null, soldOut: true,
        variants: [{ id: 'v', name: 'HOT', priceSen: 1000, isBase: true }],
        groups: [{ id: 'g', name: 'Sugar', min: 1, max: 1, options: [{ id: 'o', name: 'Less', priceDeltaSen: 0, isDefault: true, available: true }] }] }] }],
    })
    const p = m.categories[0].products[0]
    expect(p.soldOut).toBe(true)
    expect(p.variants[0].isBase).toBe(true)      // the server says which variant is the base (feedme key '')
    expect(defaultLine(p).optionIds).toEqual(['o'])
  })
})
```

- [ ] **Step 6: Run it to verify it fails.** Run: `npx vitest run src/features/pos/order/cart.test.ts` — Expected: FAIL (the old builder reads `row.availability` and `price_sen`, which the new fixture rows no longer have, so it lists no products).

- [ ] **Step 7: Make `buildPosMenu` read the catalog.** In `src/features/pos/order/cart.ts` make these replacements (each old text occurs once):

1. In the header comment replace `rules here mirror pos_insert_order (migration-2026-10-23-pos-ordering-fn.sql)` with `rules here mirror pos_insert_order (migration-2026-10-24-pos-catalogs-fn.sql)`.
2. Replace the `ProductRow` interface (from `// ── flat rows as posApi.fetchPosMenu returns them` to its closing `}`) with:

```ts
// ── flat rows as posApi.fetchPosMenu returns them ──────────────────────────
/** The master product. Its availability and default prices are not read here:
 *  the order's catalog decides both (CatalogRows). */
export interface ProductRow {
  id: string
  name: string
  description: string | null
  is_addon: boolean
  is_active: boolean
  sort_order: number
  category: { name: string; sort_order: number } | null
  menu_variants: { id: string; name: string; is_active: boolean; sort_order: number; feedme_variant_key: string }[]
}
```

3. Replace `export interface SoldOutRow { product_id: string; is_sold_out: boolean }` with:

```ts
export interface SoldOutRow { product_id: string; is_sold_out: boolean }
/** One catalog's rows: which products it sells on which channel, in which order,
 *  at which variant prices, and the add-on prices it overrides. */
export interface CatalogProductRow { product_id: string; availability: Availability; sort_order: number }
export interface VariantPriceRow { variant_id: string; price_sen: number }
export interface OptionPriceRow { option_id: string; price_delta_sen: number }
export interface CatalogRows { products: CatalogProductRow[]; prices: VariantPriceRow[]; optionPrices: OptionPriceRow[] }
```

4. Replace

```ts
export function buildPosMenu(
  products: ProductRow[], groups: GroupRow[], links: LinkRow[], soldOut: SoldOutRow[], mode: OrderMode,
): PosMenu {
  const soldOutIds = new Set(soldOut.filter((s) => s.is_sold_out).map((s) => s.product_id))
```

   with

```ts
export function buildPosMenu(
  products: ProductRow[], groups: GroupRow[], links: LinkRow[], soldOut: SoldOutRow[], mode: OrderMode, catalog: CatalogRows,
): PosMenu {
  const soldOutIds = new Set(soldOut.filter((s) => s.is_sold_out).map((s) => s.product_id))
  const inCatalog = new Map(catalog.products.map((c) => [c.product_id, c]))
  const priceOf = new Map(catalog.prices.map((p) => [p.variant_id, p.price_sen]))
  const optionPriceOf = new Map(catalog.optionPrices.map((o) => [o.option_id, o.price_delta_sen]))
```

5. Replace

```ts
  const cats = new Map<string, { sort: number; products: PosProduct[] }>()
  for (const row of [...products].sort(bySort)) {
    if (!row.is_active || row.is_addon || !allowed(mode, row.availability)) continue
    const variants = row.menu_variants.filter((v) => v.is_active).sort(bySort)
    if (variants.length === 0) continue
```

   with

```ts
  // the catalog's products this channel may sell, in the catalog's order (as qr_menu sorts them)
  const visible = products
    .flatMap((row) => {
      const c = inCatalog.get(row.id)
      return c && row.is_active && !row.is_addon && allowed(mode, c.availability) ? [{ row, sort: c.sort_order }] : []
    })
    .sort((a, b) => a.sort - b.sort || a.row.name.localeCompare(b.row.name))
  const cats = new Map<string, { sort: number; products: PosProduct[] }>()
  for (const { row } of visible) {
    // a variant the catalog has no price for is not for sale in it (the server refuses it too)
    const variants = row.menu_variants.filter((v) => v.is_active && priceOf.has(v.id)).sort(bySort)
    if (variants.length === 0) continue
```

6. Replace `id: o.id, name: o.name.trim(), priceDeltaSen: o.price_delta_sen, isDefault: o.is_default,` with `id: o.id, name: o.name.trim(), priceDeltaSen: optionPriceOf.get(o.id) ?? o.price_delta_sen, isDefault: o.is_default,`
7. Replace `variants: variants.map((v) => ({ id: v.id, name: v.name.trim(), priceSen: v.price_sen, isBase: v.feedme_variant_key === '' })),` with `variants: variants.map((v) => ({ id: v.id, name: v.name.trim(), priceSen: priceOf.get(v.id) as number, isBase: v.feedme_variant_key === '' })),`
8. Replace `  // products were visited in sort_order/name order (as qr_menu sorts them); categories by sort then name` with `  // categories by sort then name`.

- [ ] **Step 8: Run it to verify it passes.** Run: `npx vitest run src/features/pos/order/cart.test.ts` — Expected: PASS (14 tests).

- [ ] **Step 9: Load the menu of a catalog.** In `src/features/pos/order/posApi.ts`:

1. Replace `import { buildPosMenu, type GroupRow, type LinkRow, type PosMenu, type ProductRow, type SoldOutRow } from './cart'` with:

```ts
import {
  buildPosMenu, type CatalogProductRow, type GroupRow, type LinkRow, type OptionPriceRow, type PosMenu, type ProductRow,
  type SoldOutRow, type VariantPriceRow,
} from './cart'
import type { BranchCatalogRow, BranchCatalogs, CatalogRow } from './catalogs'
```

2. Replace the whole `fetchPosMenu` function (from `/** Three flat reads (RLS menu_read) shaped by the pure builder. */` to its closing `}`) with:

```ts
/** The counter menu of one catalog: flat reads (RLS menu_read) shaped by the pure
 *  builder. Products and prices come from the catalog, never from the master list. */
export async function fetchPosMenu(branchId: string, catalogId: string): Promise<PosMenu> {
  const [p, g, l, s, cp, vp, op] = await Promise.all([
    supabase.from('menu_products')
      .select('id, name, description, is_addon, is_active, sort_order, category:menu_categories(name, sort_order), ' +
              'menu_variants(id, name, is_active, sort_order, feedme_variant_key)')
      .eq('is_active', true).order('sort_order').order('name'),
    supabase.from('modifier_groups')
      .select('id, name, min_select, max_select, is_active, sort_order, ' +
              'modifier_options(id, name, price_delta_sen, is_default, availability, sort_order, product_id)'),
    supabase.from('product_modifier_groups').select('product_id, group_id, sort_order'),
    supabase.from('branch_menu_status').select('product_id, is_sold_out').eq('branch_id', branchId),
    supabase.from('catalog_products').select('product_id, availability, sort_order').eq('catalog_id', catalogId),
    supabase.from('catalog_variant_prices').select('variant_id, price_sen').eq('catalog_id', catalogId),
    supabase.from('catalog_option_prices').select('option_id, price_delta_sen').eq('catalog_id', catalogId),
  ])
  for (const r of [p, g, l, s, cp, vp, op]) if (r.error) fail(r.error)
  return buildPosMenu(
    (p.data ?? []) as unknown as ProductRow[], (g.data ?? []) as unknown as GroupRow[],
    (l.data ?? []) as LinkRow[], (s.data ?? []) as SoldOutRow[], 'counter',
    {
      products: (cp.data ?? []) as CatalogProductRow[],
      prices: (vp.data ?? []) as VariantPriceRow[],
      optionPrices: (op.data ?? []) as OptionPriceRow[],
    },
  )
}

/** Every catalog (for names) and this branch's assignments. */
export async function fetchBranchCatalogs(branchId: string): Promise<BranchCatalogs> {
  const [c, a] = await Promise.all([
    supabase.from('menu_catalogs').select('id, name, is_active, sort_order').order('sort_order').order('name'),
    supabase.from('branch_catalogs').select('role, catalog_id').eq('branch_id', branchId),
  ])
  if (c.error) fail(c.error)
  if (a.error) fail(a.error)
  return { catalogs: (c.data ?? []) as CatalogRow[], assignments: (a.data ?? []) as BranchCatalogRow[] }
}
```

- [ ] **Step 10: The order pad loads the order type's catalog** (interim: no selector yet, and if the catalogs cannot be fetched the pad keeps saying "Loading menu…" — Task 7 replaces both). In `src/features/pos/order/OrderPad.tsx`:

1. After the line `import { cartSubtotalSen, findProduct, formatSen, lineLabel, linePriceSen, validateLine, defaultLine, type OrderLine, type PosMenu, type PosProduct } from './cart'` add `import { noCatalogMessage } from './catalogs'`.
2. Replace

```tsx
export default function OrderPad({ branchId, mode, initialLines, submit, onClose, onSent }: {
  branchId: string; mode: Mode; initialLines?: OrderLine[]
```

   with

```tsx
export default function OrderPad({ branchId, mode, catalogId, catalogsLoaded, initialLines, submit, onClose, onSent }: {
  branchId: string; mode: Mode
  /** The branch's catalog for this order type; null = none set (or not loaded yet). */
  catalogId: string | null; catalogsLoaded: boolean
  initialLines?: OrderLine[]
```

3. Replace

```tsx
  const load = async () => {
    try { setMenu(await fetchPosMenu(branchId)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps
```

   with

```tsx
  const load = async () => {
    if (!catalogId) { setMenu(null); return }
    try { setMenu(await fetchPosMenu(branchId, catalogId)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void load() }, [branchId, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps
  const noCatalog = catalogsLoaded && !catalogId
```

4. Replace `          {!menu && !error && <p className="text-brown-muted">Loading menu…</p>}` with:

```tsx
          {noCatalog && <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">{noCatalogMessage(mode.orderType)}</p>}
          {!menu && !error && !noCatalog && <p className="text-brown-muted">Loading menu…</p>}
```

- [ ] **Step 11: PosPage loads the branch's catalogs.** In `src/features/pos/order/PosPage.tsx`:

1. Replace `import { fetchBranchName, fetchOpenBills, fetchPosMenu, fetchTables, type OpenBillRow, type TableRow } from './posApi'` with `import { fetchBranchCatalogs, fetchBranchName, fetchOpenBills, fetchTables, type OpenBillRow, type TableRow } from './posApi'`.
2. Replace `import { findProduct, type OrderLine, type PosMenu } from './cart'` with:

```tsx
import type { OrderLine } from './cart'
import { defaultCatalogId, type BranchCatalogs } from './catalogs'
```

3. Replace `import { fetchBillingConfig, type BillingConfig } from '../checkout/checkoutApi'` with `import { fetchBillingConfig, fetchProductNames, type BillingConfig } from '../checkout/checkoutApi'`.
4. Replace `  const [stuckMenu, setStuckMenu] = useState<PosMenu | null>(null)` with:

```tsx
  const [stuckNames, setStuckNames] = useState<Map<string, string> | null>(null)
  const [branchCatalogs, setBranchCatalogs] = useState<BranchCatalogs | null>(null)
```

5. Replace

```tsx
  useEffect(() => {
    if (hasStuck && branchId && !stuckMenu) fetchPosMenu(branchId).then(setStuckMenu, () => undefined)
  }, [hasStuck, branchId, stuckMenu])
```

   with

```tsx
  useEffect(() => {
    if (hasStuck && !stuckNames) fetchProductNames().then((rows) => setStuckNames(new Map(rows.map((r) => [r.id, r.name]))), () => undefined)
  }, [hasStuck, stuckNames])
  // the branch's catalogs: once on open, and again every time the order pad opens
  const loadCatalogs = useCallback(() => {
    if (branchId) fetchBranchCatalogs(branchId).then(setBranchCatalogs, (e) => setError(e instanceof Error ? e.message : String(e)))
  }, [branchId])
  useEffect(() => { loadCatalogs() }, [loadCatalogs])
  useEffect(() => { if (pad) loadCatalogs() }, [pad, loadCatalogs])
```

6. Replace ``            const names = o.items.map((l) => `${l.qty} × ${(stuckMenu && findProduct(stuckMenu, l.productId)?.name) || 'Unknown item'}`).join(', ')`` with ``            const names = o.items.map((l) => `${l.qty} × ${stuckNames?.get(l.productId) || 'Unknown item'}`).join(', ')``.
7. Replace `        <OrderPad branchId={branchId} mode={pad} initialLines={padLines} submit={submitFromPad} onClose={closePad}` with:

```tsx
        <OrderPad branchId={branchId} mode={pad} initialLines={padLines} submit={submitFromPad} onClose={closePad}
          catalogId={branchCatalogs ? defaultCatalogId(branchCatalogs.assignments, pad.orderType) : null}
          catalogsLoaded={branchCatalogs !== null}
```

- [ ] **Step 12: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add src/features/pos/order/catalogs.ts src/features/pos/order/catalogs.test.ts src/features/pos/order/cart.ts src/features/pos/order/cart.test.ts src/features/pos/order/posApi.ts src/features/pos/order/OrderPad.tsx src/features/pos/order/PosPage.tsx
git commit -m "feat(pos-menu): the counter menu comes from the branch's catalog for the order type

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 14 (controller, craft-os-dev — browser on the dev server; the implementer does not touch the database):** start the dev server (`.claude/launch.json` entry `craft-os-dev`), sign in with the test login, open `/pos`. Open a table → **New order**: the pad shows the Craft Cafe menu with the same products and prices as before (Craft Cafe was backfilled from them). Add one item → Send → the bill panel shows it at that price; in the dev SQL editor `select o.order_no, c.name from orders o join menu_catalogs c on c.id = o.catalog_id order by o.placed_at desc limit 1` → the order and `Craft Cafe`. Do the same with **Takeaway**. In the network panel the pad reads `catalog_products`, `catalog_variant_prices` and `catalog_option_prices` with `catalog_id=eq.<Craft Cafe id>`.

---

### Task 5: POS settings — "Menu catalogs" section

**Files:**
- Create: `src/features/pos/order/MenuCatalogsSection.tsx`
- Modify: `src/features/pos/order/posApi.ts`, `src/features/pos/order/PosSettingsPage.tsx`

**Interfaces:**
- Consumes: `save_branch_catalogs(p jsonb)` (Task 2); `fetchBranchCatalogs`, `activeCatalogs`, `additionalChoices`, `catalogSettingsFrom`, `catalogSettingsProblem`, `settingsToSave`, `toggleAdditional`, `BranchCatalogSettings`, `CatalogRow` (Task 4). The pure helpers are already tested in `catalogs.test.ts` (Task 4), including the switched-off cases: a ticked inactive additional catalog is listed "(inactive)" so it can be unticked, and Save leaves it out; a default pointing at an inactive catalog must be changed first.
- Produces: `saveBranchCatalogs(s: BranchCatalogSettings): Promise<void>` (posApi); `MenuCatalogsSection({ branchId })` on `/pos/settings` (route already gated by `access_settings`), outcome banner `Menu catalogs saved` or the server's words beside its own Save button.

- [ ] **Step 1: The API call.** In `src/features/pos/order/posApi.ts`:

1. Replace `import type { BranchCatalogRow, BranchCatalogs, CatalogRow } from './catalogs'` with `import type { BranchCatalogRow, BranchCatalogSettings, BranchCatalogs, CatalogRow } from './catalogs'`.
2. Directly after the `fetchBranchCatalogs` function add:

```ts

/** POS settings → Menu catalogs, for the caller's own branch (save_branch_catalogs checks access_settings). */
export async function saveBranchCatalogs(s: BranchCatalogSettings): Promise<void> {
  const { error } = await supabase.rpc('save_branch_catalogs', { p: s })
  if (error) fail(error)
}
```

- [ ] **Step 2: Write the section** `src/features/pos/order/MenuCatalogsSection.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { fetchBranchCatalogs, saveBranchCatalogs } from './posApi'
import {
  activeCatalogs, additionalChoices, catalogSettingsFrom, catalogSettingsProblem, settingsToSave, toggleAdditional,
  type BranchCatalogSettings, type CatalogRow,
} from './catalogs'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const box = 'rounded-xl border border-border bg-card p-4'
const input = 'rounded border border-border p-1'
const DEFAULTS: { key: 'dineIn' | 'takeaway' | 'qr'; label: string }[] = [
  { key: 'dineIn', label: 'Dine-in orders' },
  { key: 'takeaway', label: 'Takeaway orders' },
  { key: 'qr', label: 'QR orders (customers’ phones)' },
]

/** POS settings → Menu catalogs: which catalog prices each kind of order at this
 *  branch, and which catalogs a cashier may switch an order to. access_settings
 *  holders, own branch only (save_branch_catalogs). The outcome shows beside Save. */
export default function MenuCatalogsSection({ branchId }: { branchId: string }) {
  const [catalogs, setCatalogs] = useState<CatalogRow[]>([])
  const [form, setForm] = useState<BranchCatalogSettings | null>(null)
  const [outcome, setOutcome] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    const { catalogs: c, assignments } = await fetchBranchCatalogs(branchId)
    setCatalogs(c)
    setForm(catalogSettingsFrom(assignments))
  }
  useEffect(() => { load().catch((e) => setOutcome({ kind: 'error', text: msg(e) })) }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const change = (next: BranchCatalogSettings) => { setForm(next); setOutcome(null) }
  const save = async () => {
    if (!form) return
    setOutcome(null)
    const problem = catalogSettingsProblem(form, catalogs)
    if (problem) { setOutcome({ kind: 'error', text: problem }); return }
    setSaving(true)
    try {
      await saveBranchCatalogs(settingsToSave(form, catalogs))     // a ticked catalog switched off since is dropped
      await load()
      setOutcome({ kind: 'ok', text: 'Menu catalogs saved' })
    } catch (e) {
      setOutcome({ kind: 'error', text: msg(e) })
    } finally { setSaving(false) }
  }

  const active = activeCatalogs(catalogs)
  // a saved catalog that was switched off since still shows, so the select never lies
  const optionsFor = (id: string | null) => {
    const extra = id && !active.some((c) => c.id === id) ? catalogs.filter((c) => c.id === id) : []
    return [...active, ...extra]
  }
  return (
    <section className={box}>
      <h2 className="font-semibold">Menu catalogs</h2>
      <p className="text-xs text-brown-muted">
        Which catalog prices each kind of order at this branch. A cashier can switch a whole order to one of the
        additional catalogs (for example Staff Meal, or Grab Food to key a Grab order by hand).
      </p>
      {!form ? <p className="mt-2 text-sm text-brown-muted">Loading…</p> : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {DEFAULTS.map(({ key, label }) => (
              <label key={key} className="block text-sm">{label}
                <select className={`${input} mt-1 w-full`} value={form[key] ?? ''}
                  onChange={(e) => change({ ...form, [key]: e.target.value || null })}>
                  <option value="">Choose…</option>
                  {optionsFor(form[key]).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.is_active ? '' : ' (inactive)'}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="mt-3 text-sm">
            <div className="text-xs text-brown-muted">Additional catalogs cashiers may switch to</div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {additionalChoices(form, catalogs).map((c) => (
                <label key={c.id} className={c.is_active ? '' : 'text-brown-muted'}>
                  <input type="checkbox" checked={form.additional.includes(c.id)}
                    onChange={(e) => change(toggleAdditional(form, c.id, e.target.checked))} /> {c.name}{c.is_active ? '' : ' (inactive)'}
                </label>
              ))}
            </div>
            {additionalChoices(form, catalogs).some((c) => !c.is_active) && (
              <p className="mt-1 text-xs text-brown-muted">
                An inactive catalog is not offered to cashiers; it is taken off this list when you save.
              </p>
            )}
          </div>
        </>
      )}
      {outcome && (outcome.kind === 'error'
        ? <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">{outcome.text}</p>
        : <p role="status" className="mt-3 rounded bg-green-50 p-3 text-sm text-green-800">{outcome.text}</p>)}
      <button disabled={!form || saving} onClick={() => void save()}
        className="mt-3 rounded bg-brown-btn px-3 py-2 text-sm text-white disabled:opacity-40">
        {saving ? 'Saving…' : 'Save menu catalogs'}
      </button>
    </section>
  )
}
```

- [ ] **Step 3: Put it on the page.** In `src/features/pos/order/PosSettingsPage.tsx`:

1. Replace `import CheckoutSettings from '../checkout/CheckoutSettings'` with:

```tsx
import CheckoutSettings from '../checkout/CheckoutSettings'
import MenuCatalogsSection from './MenuCatalogsSection'
```

2. Replace `      <CheckoutSettings branchId={branchId} routes={routes.map((r) => r.route)} tables={tables} />` with:

```tsx
      <MenuCatalogsSection branchId={branchId} />

      <CheckoutSettings branchId={branchId} routes={routes.map((r) => r.route)} tables={tables} />
```

- [ ] **Step 4: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/order/MenuCatalogsSection.tsx src/features/pos/order/posApi.ts src/features/pos/order/PosSettingsPage.tsx
git commit -m "feat(pos-menu): POS settings section for the branch's dine-in, takeaway, QR and additional catalogs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6 (controller, craft-os-dev — browser on the dev server and the SQL editor; the implementer does not touch the database):** test login → `/pos/settings`. **Menu catalogs** shows Craft Cafe in all three selects and one tick box (Craft Cafe, unticked). Set Dine-in to "Choose…" → **Save menu catalogs** → red "Choose the dine-in catalog" right under the section, nothing saved. Choose Craft Cafe again, tick Craft Cafe as additional → Save → green "Menu catalogs saved"; `select role, catalog_id from branch_catalogs where branch_id = (select branch_id from staff where id = '76cbcf9f-905e-450d-9f5e-1c9e72a9373d')` → four rows (`dine_in`, `takeaway`, `qr`, `additional`). Untick it → Save → three rows. Editing a select clears the banner. **Switched-off catalogs:** in the SQL editor `insert into menu_catalogs(name) values ('Dev check')`; reload, tick **Dev check** → Save → four rows (Dev check is additional); then `update menu_catalogs set is_active = false where name = 'Dev check'`; reload → the tick shows "Dev check (inactive)", still ticked, with the note under it; change nothing and **Save menu catalogs** → "Menu catalogs saved" and the `branch_catalogs` query shows three rows (it was left out); reload → Dev check is gone from the list. Clean up the dev-only test row: `delete from menu_catalogs where name = 'Dev check'`. (The real catalogs to tick arrive with the import in Task 6.)

---

### Task 6: Multi-catalog import — every sheet of the Feedme export

**Files:**
- Create: `src/features/pos/menu/importView.ts`, `src/features/pos/menu/importView.test.ts`
- Modify: `src/features/pos/menu/feedmeExport.ts`, `src/features/pos/menu/feedmeExport.test.ts`, `src/features/pos/menu/menuApi.ts`, `src/features/pos/menu/MenuImportPage.tsx`

**Interfaces:**
- Consumes: `menu_import_catalogs(jsonb)` (Task 2); `readFeedmeExport`, `buildMenuImport`, `columns`, `sheetOf`, `clean`, `toSen`, `MenuImport`, `ImportProduct` (existing `feedmeExport.ts`); the test helpers `MENU_HEADER`, `GROUP_HEADER`, `menuRow`, `groupRow` (existing `feedmeExport.test.ts`).
- Produces:
  - `feedmeExport.ts`: `MASTER_MENU_SHEET = 'Default Catalog'`, `MASTER_ADDON_SHEET = 'Default AddonGroup'`, `ImportCatalogProduct`, `ImportOptionPrice`, `ImportCatalog`, `CatalogsImport extends MenuImport { catalogs: ImportCatalog[] }` (exactly the payload of `menu_import_catalogs`), `buildMenuImport(files, catalog, addonSheet = catalog)`, `buildCatalogsImport(files): { payload: CatalogsImport; warnings: string[] }`; `FEEDME_CATALOG` is removed
  - `importView.ts`: `IMPORT_CONFIRM_WORD = 'IMPORT'`, `MASTER_WARNING` (spec §6 text), `catalogSummary(c): { name, products, counterOnly, optionPrices }`, `canImport(existingCatalogs: number, typed: string): boolean`
  - `menuApi.ts`: `ImportReport`, `importFeedme(payload: CatalogsImport): Promise<ImportReport>`, `countCatalogs(): Promise<number>`; `importMenu` is removed

Facts from the real export (`books_22-10-2026_19-36.zip`, checked 2026-10-24): `menu_*.xlsx` has `Default Catalog` and ten catalog sheets with identical columns, each listing all 409 products (526 rows with variants), same Product ID / Variant key rows in every sheet, no blank Selling price; membership is the base row's `Order from` (`ALL`, `POS_ONLY`; `NONE` = out). `addonGroup_*.xlsx` has `Default AddonGroup` plus the same ten names, the same 172 option rows in each. `itemLinkedAddon_*.xlsx` has one sheet per group with the columns Group ID, Item ID, Item Name, Default Catalog.

- [ ] **Step 1: Write the failing tests.** In `src/features/pos/menu/feedmeExport.test.ts`:

1. Replace `import { buildMenuImport, clean, readFeedmeExport, toSen, type FeedmeFiles } from './feedmeExport'` with `import { buildCatalogsImport, buildMenuImport, clean, readFeedmeExport, toSen, type FeedmeFiles } from './feedmeExport'`.
2. Directly above `describe('readFeedmeExport', () => {` add:

```ts
// Three catalogs, as Feedme exports them: every sheet lists every product with its own
// "Order from" and price; NONE leaves a product out of that catalog.
function catalogFiles(): FeedmeFiles {
  const sheet = (rows: { tea: [string, string, string]; don: [string, string]; cake: [string, string] }) => [
    MENU_HEADER,
    menuRow('product_tea', 'Apple Tea', '', '', 'TEA', rows.tea[0], '10'),
    menuRow('product_tea', 'Apple Tea', 'variant_x/0', 'HOT', 'TEA', rows.tea[0], rows.tea[1]),
    menuRow('product_tea', 'Apple Tea', 'variant_x/1', 'COLD', 'TEA', rows.tea[0], rows.tea[2]),
    menuRow('product_don', 'Smoked Duck DON', '', '', 'DONBURI', rows.don[0], rows.don[1], '1.06'),
    menuRow('product_cake', 'Burnt Cheesecake', '', '', 'CAKE', rows.cake[0], rows.cake[1]),
    menuRow('item_egg', 'Salted Egg', '', '', 'ADDON', 'ALL', '0'),
  ]
  const addon = (eggPrice: string) => [GROUP_HEADER, groupRow('group_sauce', 'Sauce | Choose One', '1', '1', 'item_egg', 'Salted Egg', eggPrice)]
  return {
    menu: {
      'Default Catalog': sheet({ tea: ['ALL', '10', '11.5'], don: ['ALL', '24'], cake: ['NONE', '15'] }),
      'Craft Cafe': sheet({ tea: ['ALL', '10', '11.5'], don: ['POS_ONLY', '24'], cake: ['NONE', '15'] }),
      'Grab Food': sheet({ tea: ['ALL', '11', '13'], don: ['NONE', '24'], cake: ['ALL', '17'] }),
      'Staff Meal': sheet({ tea: ['POS_ONLY', '10', '11.5'], don: ['ALL', '20'], cake: ['NONE', '15'] }),
    },
    addonGroup: { 'Default AddonGroup': addon('0'), 'Craft Cafe': addon('0'), 'Grab Food': addon('1.5') },
    itemLinkedAddon: {
      '1. Sauce | Choose One': [
        ['Group ID', 'Item ID', 'Item Name', 'Default Catalog', 'Grab Food'],
        ['group_sauce', 'product_don', 'Smoked Duck DON', 'T', ''],
      ],
    },
  }
}

describe('buildCatalogsImport', () => {
  const { payload, warnings } = buildCatalogsImport(catalogFiles())
  const catalog = (name: string) => payload.catalogs.find((c) => c.name === name)!

  it('takes the master list from the Default sheets, every product included', () => {
    expect(payload.products.map((p) => p.feedmeId)).toEqual(['product_tea', 'product_don', 'product_cake', 'item_egg'])
    expect(payload.groups.map((g) => g.feedmeId)).toEqual(['group_sauce'])
    expect(payload.links).toEqual([{ productFeedmeId: 'product_don', groupFeedmeId: 'group_sauce', sortOrder: 0 }])
  })

  it('makes one catalog per other sheet, in sheet order', () => {
    expect(payload.catalogs.map((c) => [c.name, c.sortOrder])).toEqual([['Craft Cafe', 0], ['Grab Food', 1], ['Staff Meal', 2]])
  })

  it('includes ALL and POS_ONLY products with a price for every variant, and leaves NONE out', () => {
    expect(catalog('Craft Cafe').products).toEqual([
      { feedmeId: 'product_tea', availability: 'all', sortOrder: 0, prices: [{ key: 'variant_x/0', priceSen: 1000 }, { key: 'variant_x/1', priceSen: 1150 }] },
      { feedmeId: 'product_don', availability: 'counter_only', sortOrder: 3, prices: [{ key: '', priceSen: 2400 }] },
      { feedmeId: 'item_egg', availability: 'all', sortOrder: 5, prices: [{ key: '', priceSen: 0 }] },
    ])
    expect(catalog('Staff Meal').products.map((p) => [p.feedmeId, p.availability])).toEqual(
      [['product_tea', 'counter_only'], ['product_don', 'all'], ['item_egg', 'all']])
  })

  it('takes each catalog\'s own prices', () => {
    expect(catalog('Grab Food').products.find((p) => p.feedmeId === 'product_tea')!.prices)
      .toEqual([{ key: 'variant_x/0', priceSen: 1100 }, { key: 'variant_x/1', priceSen: 1300 }])
    expect(catalog('Grab Food').products.find((p) => p.feedmeId === 'product_cake')!.prices).toEqual([{ key: '', priceSen: 1700 }])
    expect(catalog('Staff Meal').products.find((p) => p.feedmeId === 'product_don')!.prices).toEqual([{ key: '', priceSen: 2000 }])
  })

  it('keeps only the add-on prices that differ from the default, and says when a catalog has no add-on sheet', () => {
    expect(catalog('Grab Food').optionPrices).toEqual([{ groupFeedmeId: 'group_sauce', productFeedmeId: 'item_egg', variantKey: '', priceSen: 150 }])
    expect(catalog('Craft Cafe').optionPrices).toEqual([])
    expect(warnings).toContain('Staff Meal: no add-on price sheet — add-ons use their default prices')
  })

  it('reports catalog link columns that differ from the Default Catalog', () => {
    expect(warnings).toContain('Grab Food: 1 add-on link differs from the Default Catalog — Craft OS uses the Default Catalog links for every catalog')
  })

  it('leaves out a product with a variant that has no usable price, and says so', () => {
    const f = catalogFiles()
    f.menu['Grab Food'][3][13] = 'abc'                       // Apple Tea / COLD
    const r = buildCatalogsImport(f)
    expect(r.payload.catalogs.find((c) => c.name === 'Grab Food')!.products.map((p) => p.feedmeId)).toEqual(['product_cake', 'item_egg'])
    expect(r.warnings).toContain('Grab Food: Apple Tea / COLD has no price — left out of this catalog')
  })

  it('fails clearly without the master sheet or without any catalog sheet', () => {
    const noMaster = catalogFiles()
    delete noMaster.menu['Default Catalog']
    expect(() => buildCatalogsImport(noMaster)).toThrow('Sheet "Default Catalog" not found in the menu file')
    const onlyMaster = catalogFiles()
    onlyMaster.menu = { 'Default Catalog': onlyMaster.menu['Default Catalog'] }
    expect(() => buildCatalogsImport(onlyMaster)).toThrow('The menu file has no catalog sheets — is this a Feedme menu export?')
  })
})
```

Create `src/features/pos/menu/importView.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { canImport, catalogSummary } from './importView'

describe('catalogSummary', () => {
  it('counts the products, the counter-only ones and the add-on prices of a catalog', () => {
    expect(catalogSummary({
      name: 'Grab Food', sortOrder: 1,
      products: [
        { feedmeId: 'a', availability: 'all', sortOrder: 0, prices: [] },
        { feedmeId: 'b', availability: 'counter_only', sortOrder: 1, prices: [] },
      ],
      optionPrices: [{ groupFeedmeId: 'g', productFeedmeId: 'x', variantKey: '', priceSen: 150 }],
    })).toEqual({ name: 'Grab Food', products: 2, counterOnly: 1, optionPrices: 1 })
  })
})

describe('canImport', () => {
  it('needs the typed word only when catalogs already exist', () => {
    expect(canImport(0, '')).toBe(true)
    expect(canImport(1, '')).toBe(false)
    expect(canImport(1, 'import')).toBe(false)
    expect(canImport(1, ' IMPORT ')).toBe(true)
  })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/menu` — Expected: FAIL (`buildCatalogsImport is not a function`; `Failed to resolve import "./importView"`).

- [ ] **Step 3: Read every sheet.** In `src/features/pos/menu/feedmeExport.ts`:

1. Replace

```ts
export interface FeedmeFiles { menu: Workbook; addonGroup: Workbook; itemLinkedAddon: Workbook }

/** The Feedme catalog whose "Order from" decides the shop's menu (user's choice, 2026-10-22). */
export const FEEDME_CATALOG = 'Craft Cafe'
```

   with

```ts
export interface FeedmeFiles { menu: Workbook; addonGroup: Workbook; itemLinkedAddon: Workbook }

/** Feedme's master sheets (every product, default prices, every add-on group). */
export const MASTER_MENU_SHEET = 'Default Catalog'
export const MASTER_ADDON_SHEET = 'Default AddonGroup'

/** One Feedme catalog sheet as menu_import_catalogs takes it: only the products the
 *  catalog sells (base row "Order from" ALL / POS_ONLY), a price for every variant
 *  of the master product, and the add-on prices that differ from the default. */
export interface ImportCatalogProduct {
  feedmeId: string
  availability: 'all' | 'counter_only'
  sortOrder: number
  prices: { key: string; priceSen: number }[]
}
export interface ImportOptionPrice { groupFeedmeId: string; productFeedmeId: string; variantKey: string; priceSen: number }
export interface ImportCatalog { name: string; sortOrder: number; products: ImportCatalogProduct[]; optionPrices: ImportOptionPrice[] }
export interface CatalogsImport extends MenuImport { catalogs: ImportCatalog[] }
```

2. Replace `export function buildMenuImport(files: FeedmeFiles, catalog: string): { payload: MenuImport; warnings: string[] } {` with:

```ts
/** The master list from one menu sheet and one add-on sheet (by default the sheet of
 *  the same name); add-on links from the link sheets' column named `catalog`. */
export function buildMenuImport(
  files: FeedmeFiles, catalog: string, addonSheet: string = catalog,
): { payload: MenuImport; warnings: string[] } {
```

3. Replace `  const addon = sheetOf(files.addonGroup, catalog, 'the add-on group file')` with `  const addon = sheetOf(files.addonGroup, addonSheet, 'the add-on group file')`.
4. Append at the end of the file:

```ts
/** The whole export: the master from the Default sheets plus one catalog per other
 *  sheet of the menu file (every sheet lists every product; verified 2026-10-24). */
export function buildCatalogsImport(files: FeedmeFiles): { payload: CatalogsImport; warnings: string[] } {
  const { payload: master, warnings } = buildMenuImport(files, MASTER_MENU_SHEET, MASTER_ADDON_SHEET)
  const products = new Map(master.products.map((p) => [p.feedmeId, p]))
  const optionDefaults = new Map<string, number>()            // "group|item|variant" → default price
  for (const g of master.groups) for (const o of g.options) optionDefaults.set(`${g.feedmeId}|${o.productFeedmeId}|${o.variantKey}`, o.priceSen)
  const names = Object.keys(files.menu).filter((n) => n !== MASTER_MENU_SHEET)
  if (names.length === 0) throw new Error('The menu file has no catalog sheets — is this a Feedme menu export?')
  const catalogs = names.map((name, sortOrder) => readCatalog(files, name, sortOrder, products, optionDefaults, warnings))
  warnLinkDifferences(files, warnings)
  return { payload: { ...master, catalogs }, warnings }
}

function readCatalog(
  files: FeedmeFiles, name: string, sortOrder: number, products: Map<string, ImportProduct>,
  optionDefaults: Map<string, number>, warnings: string[],
): ImportCatalog {
  const sheet = sheetOf(files.menu, name, 'the menu file')
  const mc = columns(sheet[0], ['Product ID', 'Variant key', 'Order from', 'Selling price'])
  const rows = new Map<string, { orderFrom: string; row: number; prices: Map<string, number | null> }>()
  sheet.slice(1).forEach((r, i) => {
    const id = clean(r[mc['Product ID']])
    if (!id) return
    const key = clean(r[mc['Variant key']])
    const price = toSen(r[mc['Selling price']])
    let entry = rows.get(id)
    if (!key) {
      if (entry) return                                   // a second base row: the master already warned
      entry = { orderFrom: clean(r[mc['Order from']]).toUpperCase(), row: i, prices: new Map() }
      rows.set(id, entry)
    }
    if (!entry) return                                    // a variant row before its base row: the master warned
    if (!entry.prices.has(key)) entry.prices.set(key, price)
  })

  const out: ImportCatalogProduct[] = []
  for (const [id, e] of rows) {
    if (e.orderFrom !== 'ALL' && e.orderFrom !== 'POS_ONLY') continue      // NONE (or blank): not in this catalog
    const p = products.get(id)
    if (!p) continue                                                        // skipped in the master, which said why
    const prices: { key: string; priceSen: number }[] = []
    const missing = p.variants.find((v) => {
      const price = e.prices.get(v.key) ?? null
      if (price !== null) prices.push({ key: v.key, priceSen: price })
      return price === null
    })
    if (missing) {
      warnings.push(`${name}: ${p.name} / ${missing.name} has no price — left out of this catalog`)
      continue
    }
    out.push({ feedmeId: id, availability: e.orderFrom === 'ALL' ? 'all' : 'counter_only', sortOrder: e.row, prices })
  }

  const optionPrices: ImportOptionPrice[] = []
  const addon = files.addonGroup[name]
  if (!addon || addon.length === 0) {
    warnings.push(`${name}: no add-on price sheet — add-ons use their default prices`)
  } else {
    const gc = columns(addon[0], ['Group ID', 'Item ID', 'Variant Key', 'Item price'])
    const seen = new Set<string>()
    for (const r of addon.slice(1)) {
      const groupFeedmeId = clean(r[gc['Group ID']])
      const productFeedmeId = clean(r[gc['Item ID']])
      const variantKey = clean(r[gc['Variant Key']])
      const k = `${groupFeedmeId}|${productFeedmeId}|${variantKey}`
      const def = optionDefaults.get(k)
      if (def === undefined || seen.has(k)) continue
      seen.add(k)
      const priceSen = toSen(r[gc['Item price']]) ?? 0                      // as the master reads it
      if (priceSen !== def) optionPrices.push({ groupFeedmeId, productFeedmeId, variantKey, priceSen })
    }
  }
  return { name, sortOrder, products: out, optionPrices }
}

/** Links stay global (the Default Catalog column). A link sheet that also carries
 *  catalog columns is compared, so the report says where Feedme differed. */
function warnLinkDifferences(files: FeedmeFiles, warnings: string[]): void {
  const diffs = new Map<string, number>()
  for (const sheet of Object.values(files.itemLinkedAddon)) {
    if (sheet.length === 0) continue
    const header = sheet[0].map((h) => clean(h))
    const master = header.indexOf(MASTER_MENU_SHEET)
    if (master < 0) continue
    header.forEach((h, j) => {
      if (j === master || h === '' || h === 'Group ID' || h === 'Item ID' || h === 'Item Name') return
      for (const r of sheet.slice(1)) {
        if (clean(r[j]).toUpperCase() !== clean(r[master]).toUpperCase()) diffs.set(h, (diffs.get(h) ?? 0) + 1)
      }
    })
  }
  for (const [catalog, n] of diffs) {
    warnings.push(`${catalog}: ${n} add-on link${n === 1 ? ' differs' : 's differ'} from the Default Catalog — Craft OS uses the Default Catalog links for every catalog`)
  }
}
```

Create `src/features/pos/menu/importView.ts`:

```ts
import type { ImportCatalog } from './feedmeExport'

/** What the person types before an import overwrites catalogs that already exist. */
export const IMPORT_CONFIRM_WORD = 'IMPORT'
export const MASTER_WARNING =
  'Craft OS is the master of the menu. Importing again overwrites names, prices and catalogs you changed here.'

export interface CatalogSummary { name: string; products: number; counterOnly: number; optionPrices: number }

export function catalogSummary(c: ImportCatalog): CatalogSummary {
  return {
    name: c.name,
    products: c.products.length,
    counterOnly: c.products.filter((p) => p.availability === 'counter_only').length,
    optionPrices: c.optionPrices.length,
  }
}

/** A first import needs no typing; once any catalog exists the word must be typed. */
export function canImport(existingCatalogs: number, typed: string): boolean {
  return existingCatalogs === 0 || typed.trim() === IMPORT_CONFIRM_WORD
}
```

- [ ] **Step 4: Run them to verify they pass.** Run: `npx vitest run src/features/pos/menu` — Expected: PASS (`feedmeExport.test.ts` 27 tests, `importView.test.ts` 2; the existing 19 `buildMenuImport` / `readFeedmeExport` tests are unchanged).

- [ ] **Step 5: The API.** In `src/features/pos/menu/menuApi.ts`:

1. Replace `import type { Availability, MenuImport } from './feedmeExport'` with `import type { Availability, CatalogsImport } from './feedmeExport'`.
2. Replace the whole `importMenu` function with:

```ts
/** What menu_import_catalogs answers. */
export interface ImportReport {
  categories: number
  products: number
  variants: number
  groups: number
  options: number
  links: number
  catalogs: { name: string; products: number; prices: number; optionPrices: number }[]
}

/** The whole Feedme export in one transaction (manage_menu). */
export async function importFeedme(payload: CatalogsImport): Promise<ImportReport> {
  const { data, error } = await supabase.rpc('menu_import_catalogs', { p_payload: payload })
  if (error) throw new Error(error.message)
  return data as ImportReport
}

/** How many catalogs exist (a re-import must be confirmed by typing). */
export async function countCatalogs(): Promise<number> {
  const { count, error } = await supabase.from('menu_catalogs').select('id', { count: 'exact', head: true })
  if (error) throw new Error(error.message)
  return count ?? 0
}
```

- [ ] **Step 6: The page.** Replace `src/features/pos/menu/MenuImportPage.tsx` with:

```tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { buildCatalogsImport, readFeedmeExport, type CatalogsImport } from './feedmeExport'
import { countCatalogs, importFeedme, type ImportReport } from './menuApi'
import { IMPORT_CONFIRM_WORD, MASTER_WARNING, canImport, catalogSummary } from './importView'

type Stage =
  | { kind: 'pick' }
  | { kind: 'preview'; fileName: string; payload: CatalogsImport; warnings: string[]; existingCatalogs: number }
  | { kind: 'importing' }
  | { kind: 'done'; report: ImportReport }

const th = 'px-3 py-1 text-left font-normal text-gray-500'
const td = 'px-3 py-1'

export default function MenuImportPage() {
  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let files
      try {
        files = readFeedmeExport(bytes)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // fflate's own errors ("invalid zip data", "unexpected EOF") mean the file is not a zip at all;
        // readFeedmeExport's messages already say which workbook is missing, so pass those through
        const notAZip = /invalid zip|unexpected eof/i.test(msg)
        throw new Error(notAZip ? 'That file is not a Feedme export zip (books_….zip).' : msg)
      }
      const { payload, warnings } = buildCatalogsImport(files)
      const existingCatalogs = await countCatalogs()
      setTyped('')
      setStage({ kind: 'preview', fileName: file.name, payload, warnings, existingCatalogs })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: 'pick' })
    }
  }

  const confirm = async (payload: CatalogsImport) => {
    setStage({ kind: 'importing' })
    try {
      setStage({ kind: 'done', report: await importFeedme(payload) })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStage({ kind: 'pick' })
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <Link to="/menu" className="text-sm underline">← Menu</Link>
      <h1 className="text-2xl font-semibold">Import menu from Feedme</h1>
      <p className="text-sm text-gray-500">
        In the Feedme portal go to Menu → Products → Export and choose the downloaded <code>books_….zip</code>.
        The import loads every product from the “Default Catalog” sheet and every Feedme catalog with its own products
        and prices. SST and print routes set in Craft OS are kept, and nothing is deleted: a product a catalog no longer
        sells is hidden in it. Branch assignments are not imported — choose each branch’s catalogs in POS settings.
      </p>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {stage.kind === 'pick' && (
        <input type="file" accept=".zip" onChange={(e) => void onFile(e.target.files?.[0])} />
      )}

      {stage.kind === 'preview' && (
        <div className="space-y-3 rounded border border-border p-4">
          <p className="text-sm">
            <b>{stage.fileName}</b>: {stage.payload.products.length} products ({' '}
            {stage.payload.products.filter((p) => p.isAddon).length} add-on items),{' '}
            {stage.payload.products.reduce((n, p) => n + p.variants.length, 0)} variants,{' '}
            {stage.payload.categories.length} categories, {stage.payload.groups.length} add-on groups,{' '}
            {stage.payload.groups.reduce((n, g) => n + g.options.length, 0)} add-on options,{' '}
            {stage.payload.links.length} product ↔ add-on links, {stage.payload.catalogs.length} catalogs.
          </p>
          <table className="w-full text-sm">
            <thead><tr><th className={th}>Catalog</th><th className={th}>Products</th><th className={th}>Counter only</th><th className={th}>Own add-on prices</th></tr></thead>
            <tbody>
              {stage.payload.catalogs.map(catalogSummary).map((c) => (
                <tr key={c.name} className="border-t border-border">
                  <td className={td}>{c.name}</td><td className={td}>{c.products}</td>
                  <td className={td}>{c.counterOnly}</td><td className={td}>{c.optionPrices}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {stage.warnings.length > 0 && (
            <details className="text-sm">
              <summary>{stage.warnings.length} warnings</summary>
              <ul className="mt-2 list-disc pl-5">
                {stage.warnings.slice(0, 100).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <p role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-900">{MASTER_WARNING}</p>
          {stage.existingCatalogs > 0 && (
            <label className="block text-sm">
              {stage.existingCatalogs} catalog{stage.existingCatalogs === 1 ? '' : 's'} already exist. Type <b>{IMPORT_CONFIRM_WORD}</b> to overwrite them.
              <input className="ml-2 rounded border border-border px-2 py-1" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </label>
          )}
          <div className="flex gap-2">
            <button
              disabled={!canImport(stage.existingCatalogs, typed)}
              className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover disabled:opacity-40"
              onClick={() => void confirm(stage.payload)}
            >
              Import {stage.payload.products.length} products and {stage.payload.catalogs.length} catalogs
            </button>
            <button className="rounded border border-border px-4 py-2 text-sm" onClick={() => setStage({ kind: 'pick' })}>
              Choose another file
            </button>
          </div>
        </div>
      )}

      {stage.kind === 'importing' && <p className="text-sm">Importing…</p>}

      {stage.kind === 'done' && (
        <div className="space-y-2 rounded border border-border p-4 text-sm">
          <p>
            Synced: {stage.report.products} products, {stage.report.variants} variants, {stage.report.groups} add-on groups,{' '}
            {stage.report.options} add-on options, {stage.report.links} links.
          </p>
          <table className="w-full">
            <thead><tr><th className={th}>Catalog</th><th className={th}>Products</th><th className={th}>Prices</th><th className={th}>Own add-on prices</th></tr></thead>
            <tbody>
              {stage.report.catalogs.map((c) => (
                <tr key={c.name} className="border-t border-border">
                  <td className={td}>{c.name}</td><td className={td}>{c.products}</td>
                  <td className={td}>{c.prices}</td><td className={td}>{c.optionPrices}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>Next: choose each branch’s catalogs in <Link to="/pos/settings" className="underline">POS settings</Link>.</p>
          <Link to="/menu" className="underline">Open the menu</Link>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Run the gates.** Run: `grep -rn "FEEDME_CATALOG\|importMenu" src` — Expected: no output. Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/menu/feedmeExport.ts src/features/pos/menu/feedmeExport.test.ts src/features/pos/menu/importView.ts src/features/pos/menu/importView.test.ts src/features/pos/menu/menuApi.ts src/features/pos/menu/MenuImportPage.tsx
git commit -m "feat(pos-menu): import every Feedme catalog with its own products and prices; typed confirmation once catalogs exist

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9 (controller, craft-os-dev — browser on the dev server and the SQL editor; the implementer does not touch the database):** the built-in browser cannot drive the macOS file picker, so **the owner picks the file**: test login → `/menu/import` → the owner chooses `~/Downloads/books_22-10-2026_19-36.zip`. The preview reads `409 products (…), … 10 catalogs`, shows no warnings, and its table (in the file's sheet order, Dino Meal first) lists Products per catalog: **Craft Cafe 248, Staff Meal 251, Grab Mart 130, Grab Mart Puchong 118, Delivery express 95, Craftale Bar 85, Grab Food 66, Grab Food Puchong 65, Craftale 55, Dino Meal 24** (spec §6; the parser gave exactly these on the real file while planning). "Own add-on prices" is non-zero for Grab Food, Grab Mart Puchong and Grab Food Puchong only. The amber warning "Craft OS is the master of the menu. Importing again overwrites names, prices and catalogs you changed here." shows, and because Craft Cafe exists the button stays disabled until `IMPORT` is typed. Import → the done table repeats the ten product counts. Then in the SQL editor:

```sql
select c.name, count(*) filter (where cp.availability <> 'hidden') as products,
       count(*) filter (where cp.availability = 'counter_only') as counter_only,
       (select count(*) from catalog_option_prices o where o.catalog_id = c.id) as own_addon_prices
  from menu_catalogs c left join catalog_products cp on cp.catalog_id = c.id
 group by c.id, c.name order by products desc;
```

  Expected: exactly ten rows with the counts above (Craft Cafe is the backfilled catalog, matched by `feedme_catalog_name`, not a second one). Every included product is fully priced: `select count(*) from catalog_products cp join menu_variants v on v.product_id = cp.product_id and v.is_active where cp.availability <> 'hidden' and not exists (select 1 from catalog_variant_prices p where p.catalog_id = cp.catalog_id and p.variant_id = v.id)` → `0`. Branches were not touched: `select count(*) from branch_catalogs bc join menu_catalogs c on c.id = bc.catalog_id where c.name <> 'Craft Cafe'` → `0`. Re-run `migration-2026-10-24-pos-catalogs-verify.sql` → `VERIFY OK` (its backfill comparison is skipped now that more than one catalog exists). Finally `/pos/settings` → **Menu catalogs** → tick **Staff Meal** and **Grab Food** as additional → Save → "Menu catalogs saved" (Task 7's browser check uses them).

---

### Task 7: Counter catalog selector — switch the whole order, queue it with its catalog, keep it on edit

**Files:**
- Create: `src/features/pos/order/rejectedOrder.ts`, `src/features/pos/order/rejectedOrder.test.ts`
- Modify: `src/features/pos/offline/orderQueue.ts`, `src/features/pos/offline/orderQueue.test.ts`, `src/features/pos/order/posApi.ts`, `src/features/pos/order/OrderPad.tsx`, `src/features/pos/order/PosPage.tsx`

**Interfaces:**
- Consumes: `place_counter_order(…, p_catalog_id)` (Task 2); `selectableCatalogs`, `defaultCatalogProblem`, `noCatalogMessage`, `SWITCH_CATALOG_CONFIRM`, `CatalogChoice`, `BranchCatalogs`, `fetchBranchCatalogs`, `fetchPosMenu(branchId, catalogId)` (Task 4).
- Produces:
  - `QueuedOrder.catalogId?: string | null` — optional, so orders already in IndexedDB from before M1 still load and send (`null` → the server's default)
  - `newQueuedOrder(orderType, tableId, pax, items, now = Date.now(), id = crypto.randomUUID(), catalogId: string | null = null)`
  - `counterOrderArgs(o: QueuedOrder)` → `{ p_table_id, p_order_type, p_pax, p_items, p_client_order_id, p_catalog_id }` (used by `sendCounterOrder`; `useOrderQueue` is unchanged — it passes the whole order to the sender on every flush)
  - `padFromRejected(o: QueuedOrder): { mode: PadMode; lines: OrderLine[]; catalogId: string | null }`
  - `OrderPad` props (final, replacing Task 4's `catalogId` / `catalogsLoaded`): `catalogs: CatalogChoice[] | null` (null until fetched for this opening), `defaultProblem: string | null`, `catalogsError: string | null`, `onRetryCatalogs: () => void`, `initialCatalogId?: string | null`. The pad auto-selects only the entry with `isDefault`; with none it shows `defaultProblem` and a "Choose a catalog…" placeholder until the cashier picks one; leaving an `offered: false` catalog keeps the lines the new catalog sells
  - `defaultCatalogProblem` (Task 4) supplies the words: `No menu catalog is set for <role> — set it in POS settings` or `The <role> catalog <name> is switched off — choose another in POS settings`

- [ ] **Step 1: Write the failing tests.** In `src/features/pos/offline/orderQueue.test.ts`:

1. Replace `  flushQueue, newQueuedOrder, enqueue, toSendResult,` with `  flushQueue, newQueuedOrder, enqueue, toSendResult, counterOrderArgs,`.
2. Replace

```ts
    expect(order).toEqual({ clientOrderId: 'id', orderType: 'dine_in', tableId: 't1', pax: 4, items: [line], queuedAt: 5, failedReason: null })
  })
})
```

   with

```ts
    expect(order).toEqual({ clientOrderId: 'id', orderType: 'dine_in', tableId: 't1', pax: 4, items: [line], queuedAt: 5, failedReason: null, catalogId: null })
  })

  it('carries the catalog the cart was priced from', () => {
    expect(newQueuedOrder('takeaway', null, null, [line], 5, 'id', 'c-staff').catalogId).toBe('c-staff')
  })
})

describe('counterOrderArgs', () => {
  it('sends the catalog with the order', () => {
    expect(counterOrderArgs(newQueuedOrder('dine_in', 't1', 2, [line], 5, 'id', 'c-grab'))).toEqual({
      p_table_id: 't1', p_order_type: 'dine_in', p_pax: 2, p_items: [line], p_client_order_id: 'id', p_catalog_id: 'c-grab',
    })
  })

  it('sends null for an order queued before catalogs (the server uses the branch default)', () => {
    const { catalogId: _drop, ...legacy } = newQueuedOrder('takeaway', null, null, [line], 5, 'old')
    void _drop
    expect(counterOrderArgs(legacy as QueuedOrder).p_catalog_id).toBeNull()
  })
})
```

Create `src/features/pos/order/rejectedOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { newQueuedOrder } from '../offline/orderQueue'
import { padFromRejected } from './rejectedOrder'

const line = { productId: 'p1', variantId: 'v1', qty: 2, note: null, optionIds: [] }

describe('padFromRejected', () => {
  it('reopens a table order with its lines, guests and catalog', () => {
    expect(padFromRejected(newQueuedOrder('dine_in', 't-5', 3, [line], 1, 'a', 'c-staff'))).toEqual({
      mode: { orderType: 'dine_in', tableId: 't-5', needsPax: true, initialPax: 3 }, lines: [line], catalogId: 'c-staff',
    })
  })

  it('reopens a takeaway; an order queued before catalogs has none', () => {
    const { catalogId: _drop, ...legacy } = newQueuedOrder('takeaway', null, null, [line], 1, 'b')
    void _drop
    expect(padFromRejected(legacy)).toEqual({ mode: { orderType: 'takeaway' }, lines: [line], catalogId: null })
  })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/offline/orderQueue.test.ts src/features/pos/order/rejectedOrder.test.ts` — Expected: FAIL (`counterOrderArgs is not a function`, `Failed to resolve import "./rejectedOrder"`, `catalogId` missing).

- [ ] **Step 3: The queue carries the catalog.** In `src/features/pos/offline/orderQueue.ts`:

1. Replace

```ts
  queuedAt: number
  failedReason: string | null // set when the server rejected it; never resent automatically
}
```

   with

```ts
  queuedAt: number
  failedReason: string | null // set when the server rejected it; never resent automatically
  /** The menu catalog the cart was priced from. Absent on orders queued before
   *  catalogs existed: the server then uses the branch's default for the order type. */
  catalogId?: string | null
}
```

2. Replace

```ts
  now: number = Date.now(),
  id: string = crypto.randomUUID(),
): QueuedOrder {
  return {
    clientOrderId: id, orderType, tableId, pax,
    items: items.map((l) => ({ ...l, optionIds: [...l.optionIds] })),
    queuedAt: now, failedReason: null,
  }
}
```

   with

```ts
  now: number = Date.now(),
  id: string = crypto.randomUUID(),
  catalogId: string | null = null,
): QueuedOrder {
  return {
    clientOrderId: id, orderType, tableId, pax,
    items: items.map((l) => ({ ...l, optionIds: [...l.optionIds] })),
    queuedAt: now, failedReason: null, catalogId,
  }
}

/** The arguments of place_counter_order for a queued order. */
export function counterOrderArgs(o: QueuedOrder) {
  return {
    p_table_id: o.tableId, p_order_type: o.orderType, p_pax: o.pax, p_items: o.items,
    p_client_order_id: o.clientOrderId, p_catalog_id: o.catalogId ?? null,
  }
}
```

Create `src/features/pos/order/rejectedOrder.ts`:

```ts
// src/features/pos/order/rejectedOrder.ts
import type { QueuedOrder } from '../offline/orderQueue'
import type { OrderLine } from './cart'
import type { PadMode } from './OrderPad'

/** How the order pad reopens a rejected queued order: same table or takeaway, same
 *  lines, and the same catalog (null for an order queued before catalogs existed,
 *  which the pad then prices from the branch default). */
export function padFromRejected(o: QueuedOrder): { mode: PadMode; lines: OrderLine[]; catalogId: string | null } {
  return {
    mode: o.tableId
      ? { orderType: 'dine_in', tableId: o.tableId, needsPax: o.pax != null, initialPax: o.pax ?? undefined }
      : { orderType: 'takeaway' },
    lines: o.items,
    catalogId: o.catalogId ?? null,
  }
}
```

- [ ] **Step 4: Run them to verify they pass.** Run: `npx vitest run src/features/pos/offline src/features/pos/order/rejectedOrder.test.ts` — Expected: PASS (`orderQueue.test.ts` 21 tests, `rejectedOrder.test.ts` 2; `idbStore.test.ts` unchanged).

- [ ] **Step 5: Send the catalog.** In `src/features/pos/order/posApi.ts`:

1. Replace `import { toSendResult, type QueuedOrder, type SendResult, type OrderType } from '../offline/orderQueue'` with `import { counterOrderArgs, toSendResult, type QueuedOrder, type SendResult, type OrderType } from '../offline/orderQueue'`.
2. Replace

```ts
      .rpc('place_counter_order', {
        p_table_id: o.tableId, p_order_type: o.orderType, p_pax: o.pax, p_items: o.items, p_client_order_id: o.clientOrderId,
      })
```

   with `      .rpc('place_counter_order', counterOrderArgs(o))`.

- [ ] **Step 6: The order pad with its catalog selector.** It picks only the order type's default by itself; it drops a catalog the freshly fetched list no longer offers while the cart is empty (belt and braces for the PosPage fix below); with no usable default it says why and waits for a pick; if the catalogs could not be fetched it shows the error with Retry; and leaving an edited order's no-longer-offered catalog keeps the lines the new catalog also sells. Replace `src/features/pos/order/OrderPad.tsx` with:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchPosMenu, setSoldOut } from './posApi'
import { cartSubtotalSen, findProduct, formatSen, lineLabel, linePriceSen, validateLine, defaultLine, type OrderLine, type PosMenu, type PosProduct } from './cart'
import { noCatalogMessage, SWITCH_CATALOG_CONFIRM, type CatalogChoice } from './catalogs'
import { newQueuedOrder } from '../offline/orderQueue'
import type { QueuedOrder } from '../offline/orderQueue'
import type { SubmitResult } from './useOrderQueue'
import LineSheet from './LineSheet'

export type PadMode = ({ orderType: 'dine_in'; tableId: string; needsPax: boolean; initialPax?: number } | { orderType: 'takeaway' })
type Mode = PadMode

export default function OrderPad({
  branchId, mode, catalogs, defaultProblem, catalogsError, onRetryCatalogs, initialCatalogId, initialLines, submit, onClose, onSent,
}: {
  branchId: string; mode: Mode
  /** What this order may be priced from, the order type's default first; null until the
   *  branch's catalogs have been fetched for this pad (never a stale list). */
  catalogs: CatalogChoice[] | null
  /** Why the order type has no usable default (none set, or switched off); null when it has one. */
  defaultProblem: string | null
  /** The branch's catalogs could not be fetched and this iPad has no earlier list. */
  catalogsError: string | null
  onRetryCatalogs: () => void
  /** A rejected order being edited keeps its catalog. */
  initialCatalogId?: string | null
  initialLines?: OrderLine[]
  submit: (o: QueuedOrder) => Promise<SubmitResult>
  onClose: () => void; onSent: () => void
}) {
  const [catalogId, setCatalogId] = useState<string | null>(initialCatalogId ?? null)
  const [menu, setMenu] = useState<PosMenu | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<OrderLine[]>(initialLines ?? [])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [pax, setPax] = useState<string>(mode.orderType === 'dine_in' && mode.initialPax ? String(mode.initialPax) : '')
  const [soldOutMode, setSoldOutMode] = useState(false)
  const [sending, setSending] = useState(false)
  const [carry, setCarry] = useState<{ lines: OrderLine[]; to: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const loadSeq = useRef(0)

  useEffect(() => { setError(null) }, [lines, pax])

  // Only the order type's default is ever picked for the cashier. With no usable default
  // the pad says why and waits for an explicit pick (never an additional catalog by itself).
  useEffect(() => {
    if (!catalogs) return
    const def = catalogs.find((c) => c.isDefault)
    // belt and braces: a catalog the fresh list does not offer, that is not the edited
    // order's own, is dropped while the cart is still empty
    if (catalogId !== null && catalogId !== (initialCatalogId ?? null) && lines.length === 0
        && !catalogs.some((c) => c.id === catalogId)) {
      setCatalogId(def?.id ?? null)
      return
    }
    if (catalogId === null && def) setCatalogId(def.id)
  }, [catalogs, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    const seq = ++loadSeq.current                // a slow reply for the previous catalog must not win
    if (!catalogId) { setMenu(null); return }
    try {
      const m = await fetchPosMenu(branchId, catalogId)
      if (seq === loadSeq.current) { setMenu(m); setError(null) }
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => { void load() }, [branchId, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const current = catalogs?.find((c) => c.id === catalogId) ?? null
  const noCatalog = catalogs !== null && catalogId === null

  // One order = one catalog: switching starts the cart again. Leaving the catalog of an
  // edited order that the branch no longer offers keeps what the new catalog also sells.
  const switchCatalog = (id: string) => {
    if (!id || id === catalogId) return
    if (lines.length > 0 && current && !current.offered) setCarry({ lines, to: id })
    else if (lines.length > 0 && !window.confirm(SWITCH_CATALOG_CONFIRM)) return
    setLines([]); setSheet(null); setMenu(null); setCategory(null); setNotice(null); setCatalogId(id)
  }
  useEffect(() => {
    if (!carry || !menu || carry.to !== catalogId) return
    const kept = carry.lines.filter((l) => {
      const p = findProduct(menu, l.productId)
      return p !== undefined && validateLine(p, l) === null
    })
    setLines(kept)
    if (kept.length < carry.lines.length) setNotice(`Items not in ${current?.name ?? 'this catalog'} were removed`)
    setCarry(null)
  }, [menu, carry, catalogId]) // eslint-disable-line react-hooks/exhaustive-deps

  const products = useMemo(() => {
    if (!menu) return []
    const all = menu.categories.flatMap((c) => c.products.map((p) => ({ ...p, category: c.name })))
    const q = search.trim().toLowerCase()
    return all.filter((p) => (q ? p.name.toLowerCase().includes(q) : !category || p.category === category))
  }, [menu, category, search])

  const tap = async (p: PosProduct) => {
    if (soldOutMode) {
      try { await setSoldOut(branchId, p.id, !p.soldOut); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
      return
    }
    if (p.soldOut) return
    if (p.variants.length === 1 && p.groups.length === 0) setLines((ls) => [...ls, defaultLine(p)])
    else setSheet({ product: p, index: null })
  }

  const send = async () => {
    if (!menu || lines.length === 0) return
    if (!catalogId) { setError(noCatalogMessage(mode.orderType)); return }
    const needPax = mode.orderType === 'dine_in' && mode.needsPax
    const paxNum = needPax ? Number(pax) : null
    if (needPax && (!Number.isInteger(paxNum) || (paxNum as number) < 1 || (paxNum as number) > 99)) { setError('Enter the number of guests (1–99)'); return }
    for (const l of lines) {
      const p = findProduct(menu, l.productId)
      const problem = p ? validateLine(p, l) : 'Item is no longer on the menu'
      if (problem) { setError(problem); return }
    }
    setSending(true)
    try {
      const res = await submit(newQueuedOrder(mode.orderType, mode.orderType === 'dine_in' ? mode.tableId : null, paxNum, lines,
        Date.now(), crypto.randomUUID(), catalogId))
      if (res.rejectedReason) { setError(`Rejected: ${res.rejectedReason} — fix the order and send again`); await load(); return }
      setLines([]); setError(null); onSent()
    } catch (e) {
      setError(`Order NOT saved on this iPad: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setSending(false) }
  }

  const subtotal = menu ? cartSubtotalSen(menu, lines) : 0
  return (
    <div className="fixed inset-0 z-10 grid grid-cols-[1fr_360px] bg-cream">
      <div className="flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border bg-card p-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-2">← Tables</button>
          {catalogs && catalogs.length > 0 && (
            <select aria-label="Catalog" value={catalogId ?? ''} onChange={(e) => switchCatalog(e.target.value)}
              className={`rounded-lg border p-2 text-sm ${current && !current.isDefault ? 'border-amber-500 bg-amber-50' : 'border-border'}`}>
              {catalogId === null && <option value="" disabled>Choose a catalog…</option>}
              {catalogs.map((c) => <option key={c.id} value={c.id}>{c.name}{c.offered ? '' : ' (no longer offered)'}</option>)}
            </select>
          )}
          <input className="flex-1 rounded-lg border border-border p-2 text-sm" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={() => setSoldOutMode((v) => !v)} className={`rounded-lg px-3 py-2 text-sm ${soldOutMode ? 'bg-red-600 text-white' : 'border border-border'}`}>
            {soldOutMode ? 'Tap items to mark sold out · Done' : 'Sold out…'}
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-border bg-card p-2">
          {menu?.categories.map((c) => (
            <button key={c.name} onClick={() => { setCategory(c.name); setSearch('') }}
              className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name && !search ? 'bg-brown-btn text-white' : 'border border-border'}`}>
              {c.name}
            </button>
          ))}
        </div>
        {error && <p className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {notice && <p className="m-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{notice}</p>}
        <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto p-2">
          {catalogs === null && catalogsError && (
            <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">
              Could not load the menu catalogs: {catalogsError}{' '}
              <button className="underline" onClick={onRetryCatalogs}>Retry</button>
            </p>
          )}
          {noCatalog && (
            <p className="col-span-4 rounded bg-red-50 p-2 text-sm text-red-700">
              {defaultProblem ?? noCatalogMessage(mode.orderType)}
              {catalogs.length > 0 && ' — or choose a catalog above for this order.'}
            </p>
          )}
          {!menu && !error && !noCatalog && !(catalogs === null && catalogsError) && <p className="text-brown-muted">Loading menu…</p>}
          {products.map((p) => (
            <button key={p.id} onClick={() => void tap(p)}
              className={`min-h-20 rounded-xl border p-2 text-left text-sm ${p.soldOut ? 'border-red-300 bg-red-50 text-red-700' : 'border-border bg-card'}`}>
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-brown-muted">{p.variants.length > 1 ? `${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))} –` : formatSen(p.variants[0].priceSen)}{p.soldOut && ' · SOLD OUT'}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col border-l border-border bg-card">
        <div className="border-b border-border p-3 font-semibold">
          {mode.orderType === 'takeaway' ? 'Takeaway' : 'Dine-in'} order
          {current && <span className={`ml-2 text-sm font-normal ${current.isDefault ? 'text-brown-muted' : 'text-amber-700'}`}>· {current.name}</span>}
        </div>
        <div className="flex-1 overflow-y-auto p-3 text-sm">
          {lines.map((l, i) => {
            const p = menu ? findProduct(menu, l.productId) : undefined
            if (!p) return (
              <div key={i} className="mb-2 flex justify-between text-red-700">
                <span>Unavailable item</span>
                <button className="text-xs underline" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>remove</button>
              </div>
            )
            const { name, mods } = lineLabel(p, l)
            const unit = linePriceSen(p, l) ?? 0
            return (
              <div key={i} className="mb-2 flex justify-between">
                <button className="text-left" onClick={() => setSheet({ product: p, index: i })}>
                  {l.qty} × {name}
                  {mods.map((m) => <div key={m} className="pl-4 text-xs text-brown-muted">+ {m}</div>)}
                  {l.note && <div className="pl-4 text-xs italic text-brown-muted">* {l.note}</div>}
                </button>
                <div className="text-right">
                  <div>{formatSen(unit * l.qty)}</div>
                  <button className="text-xs text-red-700 underline" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>remove</button>
                </div>
              </div>
            )
          })}
          {lines.length === 0 && <p className="text-brown-muted">Tap items to add them.</p>}
        </div>
        <div className="border-t border-border p-3">
          {mode.orderType === 'dine_in' && mode.needsPax && (
            <label className="mb-2 block text-sm">Guests
              <input inputMode="numeric" className="ml-2 w-16 rounded border border-border p-1" value={pax} onChange={(e) => setPax(e.target.value)} />
            </label>
          )}
          <div className="flex justify-between text-sm"><span>Subtotal</span><b>{formatSen(subtotal)}</b></div>
          <button disabled={sending || lines.length === 0} onClick={() => void send()}
            className="mt-2 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {sending ? 'Saving…' : 'Send order'}
          </button>
        </div>
      </div>

      {sheet && (
        <LineSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          onCancel={() => setSheet(null)}
          onDone={(line) => { setLines((ls) => sheet.index === null ? [...ls, line] : ls.map((x, k) => (k === sheet.index ? line : x))); setSheet(null) }} />
      )}
    </div>
  )
}
```

- [ ] **Step 7: PosPage hands the pad freshly fetched catalogs and keeps a rejected order's catalog.** In `src/features/pos/order/PosPage.tsx` (as left by Task 4). The pad must never pick a catalog from a list loaded before it opened: a default changed on another device since `/pos` was opened would be used and the order refused. So the pad gets `null` (it shows "Loading menu…") until the fetch made for this opening returns; offline it falls back to the last list this iPad saw, and with none it shows the error with **Retry**.

1. Replace `import { defaultCatalogId, type BranchCatalogs } from './catalogs'` with:

```tsx
import { defaultCatalogProblem, selectableCatalogs, type BranchCatalogs } from './catalogs'
import { padFromRejected } from './rejectedOrder'
```

2. Replace `  const [padLines, setPadLines] = useState<OrderLine[] | undefined>(undefined)` with:

```tsx
  const [padLines, setPadLines] = useState<OrderLine[] | undefined>(undefined)
  const [padCatalogId, setPadCatalogId] = useState<string | null>(null)
  const [padCatalogs, setPadCatalogs] = useState<BranchCatalogs | null>(null)
  const [padCatalogsError, setPadCatalogsError] = useState<string | null>(null)
  const [padCatalogsTry, setPadCatalogsTry] = useState(0)
```

3. Replace `  useEffect(() => { if (pad) loadCatalogs() }, [pad, loadCatalogs])` (Task 4's line; the mount-time `loadCatalogs` stays for the Rejected strip) with:

```tsx
  // The pad gets the branch's catalogs only once they have been fetched for THIS opening,
  // so a default changed on another device since /pos was opened is never used.
  // Offline: the last list this iPad saw; with none, the pad shows the error and Retry.
  useEffect(() => {
    setPadCatalogs(null); setPadCatalogsError(null)
    if (!pad || !branchId) return
    let live = true
    fetchBranchCatalogs(branchId).then(
      (c) => { if (live) { setBranchCatalogs(c); setPadCatalogs(c) } },
      (e) => {
        if (!live) return
        if (branchCatalogs) setPadCatalogs(branchCatalogs)
        else setPadCatalogsError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => { live = false }
  }, [pad, branchId, padCatalogsTry]) // eslint-disable-line react-hooks/exhaustive-deps
```

4. Replace

```tsx
  const editRejected = (o: QueuedOrder) => {
    editingFrom.current = o.clientOrderId
    setPadLines(o.items)
    setPad(o.tableId ? { orderType: 'dine_in', tableId: o.tableId, needsPax: o.pax != null, initialPax: o.pax ?? undefined } : { orderType: 'takeaway' })
  }
  const closePad = () => { setPad(null); setPadLines(undefined); editingFrom.current = null }
```

   with

```tsx
  const editRejected = (o: QueuedOrder) => {
    editingFrom.current = o.clientOrderId
    const p = padFromRejected(o)
    setPadLines(p.lines)
    setPadCatalogId(p.catalogId)
    setPad(p.mode)
  }
  const closePad = () => { setPad(null); setPadLines(undefined); setPadCatalogId(null); editingFrom.current = null }
```

5. Replace ``            const where = o.tableId ? `Table ${tables.find((t) => t.id === o.tableId)?.label ?? '?'}` : 'Takeaway'`` with:

```tsx
            const where = o.tableId ? `Table ${tables.find((t) => t.id === o.tableId)?.label ?? '?'}` : 'Takeaway'
            const catalog = o.catalogId ? branchCatalogs?.catalogs.find((c) => c.id === o.catalogId)?.name : null
```

6. Replace `                Rejected: {o.failedReason} · {where} · {n} item{n === 1 ? '' : 's'} ({names}){' '}` with ``                Rejected: {o.failedReason} · {where}{catalog ? ` · ${catalog}` : ''} · {n} item{n === 1 ? '' : 's'} ({names}){' '}``.
7. Replace

```tsx
          catalogId={branchCatalogs ? defaultCatalogId(branchCatalogs.assignments, pad.orderType) : null}
          catalogsLoaded={branchCatalogs !== null}
```

   with

```tsx
          catalogs={padCatalogs ? selectableCatalogs(padCatalogs.assignments, padCatalogs.catalogs, pad.orderType, padCatalogId) : null}
          defaultProblem={padCatalogs ? defaultCatalogProblem(padCatalogs.assignments, padCatalogs.catalogs, pad.orderType) : null}
          catalogsError={padCatalogsError}
          onRetryCatalogs={() => setPadCatalogsTry((n) => n + 1)}
          initialCatalogId={padCatalogId}
```

- [ ] **Step 8: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/offline/orderQueue.ts src/features/pos/offline/orderQueue.test.ts src/features/pos/order/rejectedOrder.ts src/features/pos/order/rejectedOrder.test.ts src/features/pos/order/posApi.ts src/features/pos/order/OrderPad.tsx src/features/pos/order/PosPage.tsx
git commit -m "feat(pos-menu): counter catalog selector; an order is queued and sent with its catalog and keeps it when edited

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10 (controller, craft-os-dev — browser on the dev server and the SQL editor; the implementer does not touch the database):** after Task 6 Step 9 (Staff Meal and Grab Food are additional at the test login's branch). In the export Staff Meal's prices equal Craft Cafe's; Grab Food's differ for some items. Pick the test items:

```sql
-- a product priced differently in Grab Food than in Craft Cafe
select p.name, v.name as variant, cc.price_sen as craft_cafe, gf.price_sen as grab_food
  from menu_variants v join menu_products p on p.id = v.product_id and not p.is_addon
  join catalog_variant_prices cc on cc.variant_id = v.id and cc.catalog_id = (select id from menu_catalogs where name = 'Craft Cafe')
  join catalog_variant_prices gf on gf.variant_id = v.id and gf.catalog_id = (select id from menu_catalogs where name = 'Grab Food')
  join catalog_products a on a.catalog_id = cc.catalog_id and a.product_id = p.id and a.availability <> 'hidden'
  join catalog_products b on b.catalog_id = gf.catalog_id and b.product_id = p.id and b.availability <> 'hidden'
 where cc.price_sen <> gf.price_sen limit 3;
-- a product Staff Meal sells and Craft Cafe does not
select p.name from catalog_products sm join menu_products p on p.id = sm.product_id and not p.is_addon
 where sm.catalog_id = (select id from menu_catalogs where name = 'Staff Meal') and sm.availability <> 'hidden'
   and not exists (select 1 from catalog_products cc where cc.product_id = sm.product_id and cc.availability <> 'hidden'
                    and cc.catalog_id = (select id from menu_catalogs where name = 'Craft Cafe'))
 limit 3;
```

  Then on `/pos`: open an empty table → **New order**. The Catalog select reads **Craft Cafe** and also lists Grab Food and Staff Meal. Add the first product of the first query → its Craft Cafe price. Switch to **Grab Food** → the dialog "Switching catalog clears the cart" → OK → the cart is empty, the select turns amber and the header reads "Dine-in order · Grab Food". Add the same product → the Grab Food price → Send → the bill panel shows the Grab Food price; `select c.name, oi.unit_price_sen from orders o join menu_catalogs c on c.id = o.catalog_id join order_items oi on oi.order_id = o.id order by o.placed_at desc limit 1` → `Grab Food | <grab_food>`. Add items to the same table again with **Staff Meal** and the second query's product → sent; the bill now holds orders from two catalogs. Switch catalogs with an empty cart → no dialog. Cancel the dialog once → the cart and catalog stay. **Takeaway:** in `/pos/settings` set Takeaway orders to **Staff Meal** → Save → back on `/pos` → **Takeaway** → the select starts on Staff Meal → send → `orders.catalog_id` = Staff Meal; set Takeaway back to Craft Cafe → Save. **Rejected order keeps its catalog:** open a Grab Food order, add an item, then (second tab) mark that item **Sold out…** → send in the first tab → "Rejected: Sold out: … — fix the order and send again"; the pad still shows Grab Food and its prices. (The strip's **Edit** path for orders rejected while offline is covered by `rejectedOrder.test.ts` and `selectableCatalogs`' keep-catalog test.) Unmark the sold-out item.

  **A default changed elsewhere is used at once:** keep `/pos` open in tab A (do not reload it). In tab B (`/pos/settings`) set Takeaway orders to **Grab Food** → Save. In tab A tap **Takeaway** → "Loading menu…" for a moment, then the select starts on **Grab Food** (not Craft Cafe) with Grab Food prices; send one item → `orders.catalog_id` = Grab Food. Set Takeaway back to Craft Cafe in tab B.

  **No usable default:** in the SQL editor `update menu_catalogs set is_active = false where name = 'Craft Cafe'` (dev only, for this check). Reopen a table's **New order** → no products, the red line "The dine-in catalog Craft Cafe is switched off — choose another in POS settings — or choose a catalog above for this order.", the select shows "Choose a catalog…" (nothing is picked for the cashier). Choose **Staff Meal** → its menu loads and an order sends with `orders.catalog_id` = Staff Meal. `update menu_catalogs set is_active = true where name = 'Craft Cafe'` straight after.

  **Edit on a rejected order whose catalog is no longer offered keeps what still sells.** An offline rejection cannot be produced on demand in the browser pane, so the controller plants one in the iPad's queue. Pick two Grab Food items without a required add-on, one that Staff Meal also sells and one it does not:

```sql
select p.name, p.id as product_id, v.id as variant_id,
       exists (select 1 from catalog_products s where s.product_id = p.id and s.availability <> 'hidden'
                 and s.catalog_id = (select id from menu_catalogs where name = 'Staff Meal')) as in_staff_meal,
       (select id from menu_catalogs where name = 'Grab Food') as grab_food_id
  from catalog_products g join menu_products p on p.id = g.product_id and not p.is_addon
  join menu_variants v on v.product_id = p.id and v.is_active
 where g.catalog_id = (select id from menu_catalogs where name = 'Grab Food') and g.availability <> 'hidden'
   and not exists (select 1 from product_modifier_groups pmg join modifier_groups mg on mg.id = pmg.group_id
                    where pmg.product_id = p.id and mg.min_select > 0)
 order by in_staff_meal desc, p.name limit 20;
```

  In `/pos/settings` untick **Grab Food** → Save. On `/pos`, run in the page (javascript tool), with the ids from the query:

```js
await new Promise((ok, fail) => {
  const r = indexedDB.open('craft-pos-v2', 1)
  r.onsuccess = () => {
    const tx = r.result.transaction('order-queue', 'readwrite')
    tx.objectStore('order-queue').put({
      clientOrderId: crypto.randomUUID(), orderType: 'takeaway', tableId: null, pax: null, queuedAt: Date.now(),
      failedReason: 'This catalog is not available at this branch', catalogId: '<grab_food_id>',
      items: [
        { productId: '<product in Staff Meal>', variantId: '<its variant>', qty: 1, note: null, optionIds: [] },
        { productId: '<product not in Staff Meal>', variantId: '<its variant>', qty: 1, note: null, optionIds: [] },
      ],
    })
    tx.oncomplete = ok; tx.onerror = () => fail(tx.error)
  }
  r.onerror = () => fail(r.error)
})
```

  Reload `/pos` → the strip reads "Rejected: This catalog is not available at this branch · Takeaway · Grab Food · 2 items (…)". **Edit** → the pad opens on "Grab Food (no longer offered)" with both lines at Grab Food prices. Choose **Staff Meal** → no confirm dialog; the line Staff Meal sells stays (at its Staff Meal price), the other is gone, and the amber line reads "Items not in Staff Meal were removed". Send → sent, and the planted order leaves the strip. Tick Grab Food again in `/pos/settings`.

---

### Task 8: `/menu` in M1 — Edit menu only, a catalog picker, availability per catalog

**Files:**
- Modify: `src/features/pos/menu/menuApi.ts`, `src/features/pos/menu/menuView.ts`, `src/features/pos/menu/menuView.test.ts`, `src/features/pos/menu/MenuPage.tsx`, `src/App.tsx`, `src/shared/lib/nav.ts`, `src/shared/lib/nav.test.ts`

**Interfaces:**
- Consumes: `menu_set_catalog_product` (Task 2); `CatalogRow` (Task 4); RLS `menu_products_edit` on `manage_menu` (Task 1).
- Produces: `menuApi.ts`: `MenuProductRow` without `availability`, `ProductPatch = Partial<Pick<MenuProductRow, 'sst_rate_bp' | 'print_route'>>`, `CatalogEntries { catalogId; availability: Map<string, Availability>; prices: Map<string, number> }`, `fetchCatalogs(): Promise<CatalogRow[]>`, `fetchCatalogEntries(catalogId): Promise<CatalogEntries>`, `setCatalogAvailability(catalogId, productId, availability): Promise<void>`; `menuView.ts`: `CATALOG_AVAILABILITY_LABELS` (replaces `AVAILABILITY_LABELS`), `catalogAvailability(entries, productId): Availability`, `formatCatalogPrice(variants, prices): string`; `/menu` and `/menu/import` need `manage_menu`, and so does the nav entry "Menu".

- [ ] **Step 1: Write the failing tests.**

In `src/features/pos/menu/menuView.test.ts`:

1. Replace `import { formatPrice, groupMenu } from './menuView'` with `import { catalogAvailability, formatCatalogPrice, formatPrice, groupMenu } from './menuView'`.
2. In `row()` replace `    id: over.name ?? 'x', name: 'x', availability: 'all', is_addon: false, sst_rate_bp: 600, print_route: null,` with `    id: over.name ?? 'x', name: 'x', is_addon: false, sst_rate_bp: 600, print_route: null,`.
3. Directly above `describe('groupMenu', () => {` add:

```ts
describe('catalog columns', () => {
  it('reads a product with no row in the catalog as not in it', () => {
    const entries = new Map([['p1', 'counter_only' as const]])
    expect(catalogAvailability(entries, 'p1')).toBe('counter_only')
    expect(catalogAvailability(entries, 'p2')).toBe('hidden')
  })

  it('shows the catalog\'s prices of active variants only', () => {
    const variants = [{ id: 'a', is_active: true }, { id: 'b', is_active: true }, { id: 'c', is_active: false }, { id: 'd', is_active: true }]
    const prices = new Map([['a', 1000], ['b', 1250], ['c', 1]])
    expect(formatCatalogPrice(variants, prices)).toBe('RM 10.00 – 12.50')
    expect(formatCatalogPrice(variants, new Map())).toBe('—')
  })
})

```

In `src/shared/lib/nav.test.ts`:

1. Replace `  it('POS groups the register, menu and tables & printers; staff see only the register', () => {` with `  it('POS groups the register, menu and POS settings; staff see only the register', () => {`.
2. Replace `    expect(pos(canWith('access_settings'))).toEqual(['pos-register', 'menu', 'pos-settings'])` with:

```ts
    expect(pos(canWith('access_settings'))).toEqual(['pos-register', 'pos-settings'])
    expect(pos(canWith('manage_menu'))).toEqual(['pos-register', 'menu'])
    expect(pos(canWith('access_settings', 'manage_menu'))).toEqual(['pos-register', 'menu', 'pos-settings'])
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/menu/menuView.test.ts src/shared/lib/nav.test.ts` — Expected: FAIL (`catalogAvailability is not a function`; the nav still shows Menu for `access_settings`).

- [ ] **Step 3: Gate the page.** In `src/shared/lib/nav.ts` replace `      { id: 'menu',         label: 'Menu',              to: '/menu', activePaths: ['/menu'], cap: 'access_settings' },` with `      { id: 'menu',         label: 'Menu',              to: '/menu', activePaths: ['/menu'], cap: 'manage_menu' },`. In `src/App.tsx`, in the two route blocks `path="/menu"` and `path="/menu/import"`, replace `<ProtectedRoute requireCap="access_settings">` with `<ProtectedRoute requireCap="manage_menu">` (only those two; `/pos/settings` and `/settings` keep `access_settings`).

- [ ] **Step 4: The view helpers.** In `src/features/pos/menu/menuView.ts`:

1. Replace

```ts
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  all: 'Counter + QR',
  counter_only: 'Counter only',
  hidden: 'Hidden',
}
```

   with

```ts
/** A product in one catalog; 'hidden' = the catalog does not sell it. */
export const CATALOG_AVAILABILITY_LABELS: Record<Availability, string> = {
  hidden: 'Not in this catalog',
  all: 'Counter + QR',
  counter_only: 'Counter only',
}
```

2. Directly above `export function groupMenu(` add:

```ts
/** No row in the catalog reads as not in it. */
export function catalogAvailability(entries: Map<string, Availability>, productId: string): Availability {
  return entries.get(productId) ?? 'hidden'
}

/** The catalog's prices of the active variants it prices ('—' when none). */
export function formatCatalogPrice(variants: Pick<MenuVariantRow, 'id' | 'is_active'>[], prices: Map<string, number>): string {
  return formatPrice(variants.filter((v) => prices.has(v.id)).map((v) => ({ price_sen: prices.get(v.id) as number, is_active: v.is_active })))
}

```

- [ ] **Step 5: The API.** In `src/features/pos/menu/menuApi.ts`:

1. Replace `import type { Availability, CatalogsImport } from './feedmeExport'` with:

```ts
import type { Availability, CatalogsImport } from './feedmeExport'
import type { CatalogRow } from '../order/catalogs'
```

2. Replace

```ts
export interface MenuProductRow {
  id: string
  name: string
  availability: Availability
  is_addon: boolean
```

   with

```ts
/** A master product. Its own availability is not read any more: each catalog says
 *  whether it sells the product (CatalogEntries). */
export interface MenuProductRow {
  id: string
  name: string
  is_addon: boolean
```

3. Replace `export type ProductPatch = Partial<Pick<MenuProductRow, 'availability' | 'sst_rate_bp' | 'print_route'>>` with:

```ts
export type ProductPatch = Partial<Pick<MenuProductRow, 'sst_rate_bp' | 'print_route'>>
/** One catalog on /menu: product id → availability, variant id → price. */
export interface CatalogEntries { catalogId: string; availability: Map<string, Availability>; prices: Map<string, number> }
```

4. In `fetchMenu` replace `      'id, name, availability, is_addon, sst_rate_bp, print_route, takeaway_fee_sen, sort_order, ' +` with `      'id, name, is_addon, sst_rate_bp, print_route, takeaway_fee_sen, sort_order, ' +`.
5. Directly above `/** What menu_import_catalogs answers. */` add:

```ts
export async function fetchCatalogs(): Promise<CatalogRow[]> {
  const { data, error } = await supabase.from('menu_catalogs').select('id, name, is_active, sort_order').order('sort_order').order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as CatalogRow[]
}

export async function fetchCatalogEntries(catalogId: string): Promise<CatalogEntries> {
  const [p, v] = await Promise.all([
    supabase.from('catalog_products').select('product_id, availability').eq('catalog_id', catalogId),
    supabase.from('catalog_variant_prices').select('variant_id, price_sen').eq('catalog_id', catalogId),
  ])
  if (p.error) throw new Error(p.error.message)
  if (v.error) throw new Error(v.error.message)
  return {
    catalogId,
    availability: new Map((p.data ?? []).map((r) => [r.product_id as string, r.availability as Availability])),
    prices: new Map((v.data ?? []).map((r) => [r.variant_id as string, r.price_sen as number])),
  }
}

/** In or out of a catalog, and on which channel (menu_set_catalog_product: manage_menu;
 *  putting a product in pre-fills its prices from the default price). */
export async function setCatalogAvailability(catalogId: string, productId: string, availability: Availability): Promise<void> {
  const { error } = await supabase.rpc('menu_set_catalog_product', {
    p_catalog_id: catalogId, p_product_id: productId, p_availability: availability,
  })
  if (error) throw new Error(`Catalog change failed: ${error.message}`)
}

```

- [ ] **Step 6: The page.** Replace `src/features/pos/menu/MenuPage.tsx` with:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchCatalogEntries, fetchCatalogs, fetchMenu, setCatalogAvailability, updateProducts,
  type CatalogEntries, type MenuProductRow, type ProductPatch,
} from './menuApi'
import {
  CATALOG_AVAILABILITY_LABELS, PRINT_ROUTES, SST_CHOICES, catalogAvailability, formatCatalogPrice, formatPrice, groupMenu,
} from './menuView'
import type { Availability } from './feedmeExport'
import type { CatalogRow } from '../order/catalogs'

const select = 'rounded border border-border bg-card px-2 py-1 text-sm'
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function MenuPage() {
  const [rows, setRows] = useState<MenuProductRow[] | null>(null)
  const [catalogs, setCatalogs] = useState<CatalogRow[]>([])
  const [catalogId, setCatalogId] = useState<string | null>(null)
  const [entries, setEntries] = useState<CatalogEntries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showAddons, setShowAddons] = useState(false)

  const load = useCallback(() => {
    Promise.all([fetchMenu(), fetchCatalogs()])
      .then(([r, c]) => {
        setRows(r)
        setCatalogs(c)
        setCatalogId((cur) => cur ?? c.find((x) => x.is_active)?.id ?? c[0]?.id ?? null)
        setError(null)
      })
      .catch((e) => setError(msg(e)))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  const loadEntries = useCallback((id: string) => {
    fetchCatalogEntries(id).then(setEntries, (e) => setError(msg(e)))
  }, [])
  useEffect(() => {
    if (catalogId) loadEntries(catalogId)
  }, [catalogId, loadEntries])

  const sections = useMemo(() => groupMenu(rows ?? [], { showAddons, search }), [rows, showAddons, search])
  // entries of a catalog that is no longer the chosen one are never shown
  const shown = entries && entries.catalogId === catalogId ? entries : null
  const current = catalogs.find((c) => c.id === catalogId) ?? null
  const inCatalog = shown ? [...shown.availability.values()].filter((a) => a !== 'hidden').length : 0

  const save = async (ids: string[], patch: ProductPatch) => {
    const before = rows
    setRows((rs) => rs?.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)) ?? rs)
    try {
      await updateProducts(ids, patch)
      setError(null)
    } catch (e) {
      setRows(before)
      setError(msg(e))
    }
  }

  const setAvailability = async (productId: string, availability: Availability) => {
    if (!shown) return
    const before = shown
    setEntries({ ...shown, availability: new Map(shown.availability).set(productId, availability) })
    try {
      await setCatalogAvailability(shown.catalogId, productId, availability)
      setError(null)
      loadEntries(shown.catalogId)          // a product put in has its prices pre-filled on the server
    } catch (e) {
      setEntries(before)
      setError(msg(e))
    }
  }

  if (rows === null && !error) return <p className="p-6 text-sm">Loading menu…</p>

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Menu</h1>
          <p className="text-sm text-gray-500">
            {rows?.length ?? 0} products. Each catalog decides which products it sells and on which channel; SST and print
            route apply in every catalog. Editing names, prices and add-ons here comes in the next menu update — until then
            they change only by importing from Feedme.
          </p>
        </div>
        <Link to="/menu/import" className="rounded bg-brown-btn px-4 py-2 text-sm text-white hover:bg-brown-btn-hover">
          Import from Feedme
        </Link>
      </div>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          Catalog
          <select className={select} value={catalogId ?? ''} onChange={(e) => setCatalogId(e.target.value || null)}>
            {catalogs.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.is_active ? '' : ' (inactive)'}</option>
            ))}
          </select>
        </label>
        {current && shown && <span className="text-sm text-gray-500">{inCatalog} products in {current.name}</span>}
        <input
          className="w-64 rounded border border-border px-3 py-2 text-sm"
          placeholder="Search products"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showAddons} onChange={(e) => setShowAddons(e.target.checked)} />
          Show add-on items
        </label>
      </div>

      {rows?.length === 0 && (
        <p className="rounded border border-border p-6 text-sm">No menu yet — use “Import from Feedme”.</p>
      )}

      {sections.map((section) => (
        <section key={section.title} className="rounded border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
            <h2 className="font-medium">
              {section.title} <span className="text-sm text-gray-500">({section.products.length})</span>
            </h2>
            <label className="flex items-center gap-2 text-sm">
              Print whole category to
              <select
                className={select}
                value=""
                onChange={(e) =>
                  void save(
                    // the whole category, not just the rows the search/add-on filter is showing
                    (rows ?? []).filter((r) => (r.category?.name ?? 'Uncategorised') === section.title).map((p) => p.id),
                    { print_route: e.target.value || null },
                  )
                }
              >
                <option value="" disabled>Choose…</option>
                {PRINT_ROUTES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-gray-500">
              <tr>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Price{current ? ` in ${current.name}` : ''}</th>
                <th className="px-4 py-2">In {current?.name ?? 'catalog'}</th>
                <th className="px-4 py-2">SST</th>
                <th className="px-4 py-2">Print route</th>
              </tr>
            </thead>
            <tbody>
              {section.products.map((p) => {
                const availability = shown ? catalogAvailability(shown.availability, p.id) : null
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-2">
                      {p.name}
                      {p.menu_variants.filter((v) => v.is_active).length > 1 && (
                        <span className="ml-2 text-xs text-gray-500">
                          {p.menu_variants.filter((v) => v.is_active).map((v) => v.name).join(' / ')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {shown && availability !== 'hidden'
                        ? formatCatalogPrice(p.menu_variants, shown.prices)
                        : <span className="text-gray-400">Default {formatPrice(p.menu_variants)}</span>}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className={select}
                        disabled={!shown}
                        value={availability ?? 'hidden'}
                        onChange={(e) => void setAvailability(p.id, e.target.value as Availability)}
                      >
                        {(Object.keys(CATALOG_AVAILABILITY_LABELS) as Availability[]).map((a) => (
                          <option key={a} value={a}>{CATALOG_AVAILABILITY_LABELS[a]}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className={select}
                        value={p.sst_rate_bp}
                        onChange={(e) => void save([p.id], { sst_rate_bp: Number(e.target.value) })}
                      >
                        {SST_CHOICES.map((c) => (
                          <option key={c.bp} value={c.bp}>{c.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className={select}
                        value={p.print_route ?? ''}
                        onChange={(e) => void save([p.id], { print_route: e.target.value || null })}
                      >
                        <option value="">Not printed</option>
                        {PRINT_ROUTES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 7: Run the gates.** Run: `grep -rn "AVAILABILITY_LABELS" src | grep -v CATALOG_AVAILABILITY_LABELS` — Expected: no output. Run: `npx vitest run src/features/pos/menu src/shared/lib/nav.test.ts` — Expected: PASS (`menuView.test.ts` 6, `nav.test.ts` 18). Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/menu/menuApi.ts src/features/pos/menu/menuView.ts src/features/pos/menu/menuView.test.ts src/features/pos/menu/MenuPage.tsx src/App.tsx src/shared/lib/nav.ts src/shared/lib/nav.test.ts
git commit -m "feat(pos-menu): /menu needs Edit menu and sets each catalog's availability; SST and print route stay on the product

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9 (controller, craft-os-dev — browser on the dev server and the SQL editor; the implementer does not touch the database):** test login (owner) → the nav's POS group shows **Menu** → `/menu`. The Catalog picker starts on Craft Cafe and says "248 products in Craft Cafe"; the Price column shows Craft Cafe prices, products not in it show "Default RM …" in grey. Pick **Grab Food** → "66 products in Grab Food" and Grab Food's prices. Choose a product that shows "Not in this catalog" → set **Counter only** → its price appears (the default price, pre-filled); `select availability from catalog_products where catalog_id = (select id from menu_catalogs where name = 'Grab Food') and product_id = (select id from menu_products where name = '<that product>')` → `counter_only`. On `/pos` a Grab Food order now offers it; a QR page does not (counter only). Back on `/menu` set it to **Not in this catalog** → the same query → `hidden` (the row stays). Change a product's SST and print route → still saved on the product for every catalog (`select sst_rate_bp, print_route from menu_products where name = …`). Settings → System Roles shows a column **Edit menu** ticked for Owner and Admin only. If a manager login exists on dev: the nav has no Menu, `/menu` redirects, and POS settings → Menu catalogs still works for them.

---

## Execution notes for the controller

- Tasks 1–3 are SQL plus the capability; they land on dev together in Task 3 Step 7. Tasks 4–8 each end with `npx tsc -b`, `npx vitest run` and a browser check on dev. Task 7's browser check needs Task 6's import and Staff Meal / Grab Food ticked on POS settings.
- Every step that reads or writes craft-os-dev (Task 3 Step 7, Task 4 Step 14, Task 5 Step 6, Task 6 Step 9, Task 7 Step 10, Task 8 Step 9) is the controller's; implementers stop at `tsc` / `vitest` / commit.
- Between Task 3 and Task 4 the deployed client still builds its menu from `menu_products.availability`; the server already prices from Craft Cafe, which was made from that same data, so nothing a cashier sees changes.
- **Prod rollout (owner's decision, later):** in order, after Sub-plans 1–3 and `migration-2026-10-24-pos-checkout-fixes.sql`: `migration-2026-10-24-pos-catalogs.sql`, then `migration-2026-10-24-pos-catalogs-fn.sql`, before the first deploy from main that carries this code (an older client keeps working: `place_counter_order` without `p_catalog_id` prices from the branch default). Only after that deploy, import the export on prod's `/menu/import` (never with the old client: see Global Constraints) and set each branch's catalogs on POS settings (Open point 7). After a seed that creates a branch, re-run `migration-2026-10-24-pos-catalogs.sql`. The verify scripts are dev-only.

## Open points (choices made while planning, 2026-10-24 — each can be changed later)

1. **Owner default (assumed, can be changed): Staff Meal is priced as exported**, i.e. the same as Craft Cafe (no row differs; Staff Meal differs only in what it sells, 251 vs 248 products, 44 counter-only). A staff discount belongs to the later discount feature, not to catalog prices. Task 7's price check therefore uses Grab Food.
2. **Per-catalog "Order from" on variant rows and add-on rows is not modelled.** In the export 3 variants of otherwise-included products are `NONE` in Craft Cafe, Staff Meal, Delivery express, Grab Mart and Grab Mart Puchong, and Grab Mart Puchong marks some add-on rows `POS_ONLY`. M1 sells those variants and add-ons in every catalog that sells the product. M2 could model a variant out of a catalog as "no price row" (the ordering rule already refuses a variant without a catalog price).
3. **The counter sends the chosen catalog's id even when it is the default.** An offline order queued before a manager changes the branch's default is refused on flush ("This catalog is not available at this branch") and must be edited; **Edit** then keeps the lines the newly chosen catalog also sells. Sending `null` for the default would price it from the new default instead, at prices the cashier never saw.
4. **`save_branch_catalogs` requires all three defaults**, so a branch cannot "turn QR off" through catalogs (pausing tables does that). The settings selects start on "Choose…" only for a branch that has no row.
5. **The backfill assigns Craft Cafe to every active branch missing a role, on every run of the schema migration** — on prod that is all three outlets (matching Feedme today, where all three use Craft Cafe for every order type). A branch created later gets it on the next re-run too.
6. **A re-import overwrites product names, prices, availability per catalog and add-on prices, but not a catalog's name** (matched by `feedme_catalog_name`), its active flag is set back on, and catalogs not in the file are untouched. Products a catalog no longer lists become `hidden`.
7. **Owner default (assumed, can be changed): on prod the additional catalogs follow Feedme's current usage.** All three outlets: Staff Meal and Dino Meal. Cheras and Puchong also: Grab Food, Grab Mart, Delivery express. Puchong also: Grab Food Puchong and Grab Mart Puchong. Craftale and Craftale Bar are assigned nowhere. Dine-in, takeaway and QR stay Craft Cafe everywhere (the backfill). Dev's Demo branch gets Staff Meal and Grab Food only (Task 6 Step 9).
8. **The typed confirmation word is `IMPORT`.**
9. **PostgREST's row cap (1000 by default)** limits each flat read of the pad: today 409 products and at most 526 variant prices per catalog fit. A catalog with more than 1000 priced variants would be cut short — M2 should read the pad's menu through one RPC.
10. **`menu_import` still replaces the add-on options of every group it imports** (Sub-plan 1 behaviour): option ids change on each import, so an offline order queued with old option ids is rejected after an import, and catalog add-on prices are rewritten by the same import. M2's group editor should upsert options instead.
11. **`menu_products.availability` is still written by the import** (from the Default Catalog sheet) but read by nothing; the column is dropped in a later clean-up migration (spec §2).
12. **The checkout-fixes migration's header still calls itself canonical for `has_menu_cap` / `staff_has_cap`.** The new schema migration's header says it now is; the applied fixes file was not edited. The re-run order in Global Constraints covers it.
13. **`/pos/settings` stays on `access_settings`** (managers keep branch catalogs and sold-out, spec §7); only `/menu` and `/menu/import` move to `manage_menu`. A manager who opens `/menu` by URL is redirected by `ProtectedRoute`.
