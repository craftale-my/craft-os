# POS · Menu catalogs M2 — Menu editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner (capability **Edit menu**, `manage_menu`) runs the whole menu from Craft OS. `/menu` has four pages behind one sub-navigation: **Products** (list, plus an editor that saves a product, its variants, its add-on groups and its price in every catalog in one transaction), **Catalogs** (create, duplicate, rename, reorder, switch off; a catalog page that edits each product's availability and prices one row at a time), **Add-on groups** (options, defaults, min/max, per-catalog option prices) and **Categories** (create, rename, reorder, switch off). The server validates everything and is the truth; an order placed after an edit is priced from it, orders already placed keep their snapshot. The order pad reads its menu in one call.

**Architecture:** One functions migration, `supabase/migration-2026-10-24-pos-menu-editor-fn.sql`, adds **only new functions**: internal helpers (`menu_require_editor`, `menu_clean_name`, `menu_sen`, `menu_uuid`, `menu_new_variant_key`, `menu_check_catalog_prices`), editor reads that each return one JSON value (`menu_editor_lookups`, `menu_product_list`, `menu_product_detail`, `menu_group_detail`, `menu_catalog_grid`), editor writes (`menu_save_product`, `menu_save_group`, `menu_save_catalog`, `menu_duplicate_catalog`, `menu_reorder_catalogs`, `menu_set_catalog_active`, `menu_save_catalog_row`, `menu_save_category`, `menu_reorder_categories`, `menu_set_category_active`) and the pad's `pos_menu_rows`. No table, column, policy or earlier function changes: switching an option off uses the existing `modifier_options.availability = 'hidden'`, which `pos_insert_order`, `qr_menu` and `buildPosMenu` already honour. On the client, pure modules (`menuForms`, `productForm`, `groupForm`, `catalogGrid`, `listAdmin`, `menuView`) hold every rule and every form → payload conversion, with Vitest tests; the pages under `/menu/*` (one `MenuRoutes` behind the Edit menu gate in `App.tsx`) are thin and split into section components.

**Tech Stack:** React 19 + Vite 6 + TypeScript + Tailwind, Supabase (Postgres RLS, plpgsql `security definer` RPCs, Realtime), Vitest. No ESLint config in the repo; the gates are `npx tsc -b` and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md` — §2, §4, §7, §8-M2, §9 (M2 items) and §10 bind this plan. Builds on M1 (`docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m1.md`, head `f2cbd29`). **Out of scope (M3):** `product_schedules` and every time-slot check, photos, the `menu-images` bucket, the photo upload and the Feedme photo copy. The product editor leaves their places: `ProductEditorPage` renders its sections from top to bottom with a marked spot for **Photo** (after Details) and **Time slots** (after Add-on groups), and `ProductSection` / `ProductForm` / `menu_save_product` grow then (M3 re-creates `menu_save_product`, and says so).

## Spec deltas (decided while planning, 2026-10-24; plan review `.superpowers/sdd/m2-plan-review.md` applied the same day)

- **Switching an option off = `availability = 'hidden'`.** `modifier_options` already has `availability` (`all` / `counter_only` / `hidden`), and every reader already leaves `hidden` out: `pos_insert_order` refuses it (`Sold out: <option>`, M1 words), `qr_menu` lists only `availability <> 'hidden'`, `buildPosMenu` drops it. So no `is_active` column is added and **no M1 function is re-created**. The group editor shows it as "Offered: Counter + QR / Counter only / Off".
- **What is deleted:** nothing that an order refers to. Two kinds of *configuration* rows are deleted when the owner removes them: a product's link to an add-on group (`product_modifier_groups`; orders snapshot the group name) and a catalog's add-on price override (`catalog_option_prices`; without it the option's own price applies, as the spec says). Products, variants, groups, options, categories and catalogs are only switched off; a product leaves a catalog as `hidden` with its prices kept (M1 rule); catalog variant prices are never deleted.
- **Every saved variant (option) must be in the payload.** `menu_save_product` / `menu_save_group` refuse a payload that leaves one out (`The product changed since you opened it — refresh and try again`, `The add-on group changed since you opened it — refresh and try again`). That keeps "nothing is dropped" true and catches two people editing at once.
- **Variant keys are made by the server.** A new product sold in exactly one active variant gets the base key `''` for it (tickets print the product name alone); every other new variant gets `cos-` + 12 hex characters. When a save leaves a product with more than one active variant, an active variant still keyed `''` is re-keyed `cos-…`, so tickets name every variant ("Toast (Regular)", "Toast (Large)"). Keys of existing variants never change otherwise. Options created in the editor get the variant key `''`; an option keeps its key while it keeps its add-on item.
- **The catalog price rule is checked after the writes, over every catalog that sells the product** — also catalogs the payload does not list (`<Catalog>: enter a price for <Variant>`). A price row of a switched-off variant is kept.
- **The Products page (M1 `/menu`) keeps the SST and print-route quick edits and "Print whole category to"**, because setting them up for 400 imported products one editor at a time is slow; **its catalog picker and per-catalog availability column go**: a catalog's products and prices are edited on the catalog's page (row by row) and in the product editor (catalog by catalog). The list gets category and "sold in" filters and shows switched-off products on request. `menu_set_catalog_product` (M1) is no longer called by the client; it stays in the database.
- **"Modifier groups" are called "Add-on groups" on screen** (Feedme's word and the pad's: "Add-on is not available…"). Routes are `/menu/groups…`.
- **Editor reads are RPCs that need Edit menu and return one JSON value** (lesson 4: PostgREST caps a read at 1,000 rows). The tables stay readable by every signed-in staff member through M1's `menu_read` policies.
- **The order pad reads its menu through `pos_menu_rows(catalog)`** — the same rows `buildPosMenu` took from seven flat reads, as one JSON value (closes M1 Open point 9). It also leaves out products of a switched-off category, as `qr_menu` already does. Sold-out is the caller's own branch (`pos_my_branch`), so `fetchPosMenu` takes the catalog id only.
- **A switched-off category hides its products on the counter and the QR page; the server does not refuse them** (an order queued offline before the switch still goes in). The Categories page asks before switching off a category that has products.
- **A catalog that an active branch uses for dine-in, takeaway or QR cannot be switched off** (`<Catalog> is the dine-in catalog of <Branch> — choose another in POS settings first`); an additional catalog can (the pad stops offering it, M1).
- **Duplicating a catalog** copies every `catalog_products` row (hidden ones too), every variant price and every option override; the copy is active, has no Feedme name and is assigned to no branch. A new catalog or category goes last; reordering sends the whole list (`The catalog list changed — refresh and try again` when it does not match).
- **A new product goes last** in the master list and last in each catalog that sells it; reordering products inside a category is not part of M2 (Open point 4).
- **A category is required to save a product** (`Choose a category`). An imported product without one gets one at its first edit.
- **Product editor: one Save for the whole product** (one transaction). Problems show inside the section they belong to after the first Save; the outcome shows next to the Save button. Add-on group editor: same. Both editors ask before the tab is closed or reloaded with unsaved changes (`beforeunload`); a "created" message passed through navigation state is shown once and cleared.
- **A save sends only what changed** (review I-3). For a saved product the editor sends every variant, but only the details (name, category, SST, print route, takeaway fee, on/off, add-on flag…) and the catalogs the owner changed — every catalog when a variant was added or switched on. `menu_save_product` keeps a stored detail whose key is left out (an existing product only) and, as before, leaves catalogs that are not listed alone. So saving an editor tab opened earlier never undoes a price changed meanwhile on the catalog page, or SST / print route changed on the Products page.
- **Only boxes the owner can see count** (review Minor 4). A catalog that does not sell the product and a switched-off variant have no visible price boxes; what may be typed there is neither checked nor sent (the stored prices stay). Same on the catalog page.
- **Products a catalog sells without a price for one of their active variants are counted** (review I-1): `menu_editor_lookups` gives each catalog an `unpricedCount`; the Catalogs page shows "N products have no price — open to fix" in red, and the catalog page shows the problem on each such row before anyone edits it. Craft OS keeps the M1 import as it is, so a re-import can cause this in catalogs made here (Open point 7).
- **The import warning lists exactly what a re-import loses** (review I-2, Feedme behaviour: one master, no merge). `MASTER_WARNING` in `importView.ts` replaces spec §6's one-line wording.
- **Min and max are whole numbers from 0 to 99 / 1 to 99** and the words say so (`Min must be a whole number from 0 to 99`, `Max must be a whole number from 1 to 99`), on both sides.
- **A category's product count leaves out add-on items** (they are not on the counter or QR), so the switch-off confirmation is right. Catalogs, Categories and the catalog page: each row's action shows its outcome on that row. Every Save button is disabled while its save runs.
- **Prices are typed in RM** and parsed by `parseRinggit` (`src/features/pos/checkout/tender.ts`, Sub-plan 3): `12`, `12.5`, `RM 12.50`, commas ignored, at most RM 999 999.99. The server takes whole sen from 0 to 99 999 999.
- `modifier_groups.stackable` is kept and editable but labelled "kept from Feedme; the counter does not use it yet".

## Global Constraints

- **Dev database first.** The SQL here is applied on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) by the controller from the owner's Chrome tab on the dashboard SQL editor; prod (`yfsoesxzurzjdwstszru`) is a later step the owner decides. The migration runs on prod **before** any main deploy that carries this code — the order pad calls `pos_menu_rows` from Task 3 on. Seeds never run on prod; the verify script is dev-only.
- Every step that reads or writes the dev database is marked **(controller, craft-os-dev — …; the implementer does not touch the database)**; implementers run only local commands (`grep`, `npx tsc -b`, `npx vitest run`) and commit.
- All UI copy, field names and error messages in English (`english-product-copy` rule); code comments may be Chinese or English, matching the surrounding file.
- **Money is integer sen.** The client sends ids and values (names, sen, flags); the server validates everything and is the truth. Orders still send ids only (`place_counter_order`), and the server prices them from the catalog; Sub-plan 3's money rules and the 22 vectors in `src/features/pos/checkout/billVectors.json` (and their copy in the checkout verify script) do not change.
- **Every `security definer` function** pins `set search_path = public, pg_temp`, checks Edit menu through `menu_require_editor()` → `has_menu_cap('manage_menu')` (live staff only: `is_active and status = 'active'`; the Owner's override in `system_role_permissions` wins), revokes execute from `public, anon` and grants `authenticated`; internal helpers are revoked from `authenticated` too. `pos_menu_rows` needs live staff with a branch (`pos_my_branch`), not Edit menu.
- **Nothing is hard-deleted** that an order refers to (Spec deltas: the two configuration rows are the only deletes).
- **pg-safeupdate:** Supabase's API role refuses a DELETE or UPDATE without WHERE even inside a function (the SQL editor does not, so a verify script cannot catch it). Every DELETE / UPDATE in the new file has a WHERE (`where true` where all rows are meant); `src/features/pos/sqlSafeUpdate.test.ts` scans every `migration-*-pos-*.sql` (the new file included, Task 1 makes that explicit).
- **Migrations are idempotent** (`create or replace function` only; the file creates no table, column, policy or trigger).
- **Re-run hazard.** This file re-creates no earlier function, so re-running it never puts anything older back, and re-running an earlier file never removes it. But the editor depends on M1's canonical `has_menu_cap`: re-running `migration-2026-10-22-pos-menu.sql` or a checkout file brings back a `has_menu_cap` without `manage_menu`, and every editor function then answers `Not allowed to edit the menu` to everyone. After any such re-run, re-run `migration-2026-10-24-pos-checkout-fixes.sql`, `migration-2026-10-24-pos-catalogs.sql`, `migration-2026-10-24-pos-catalogs-fn.sql`, then this file (its STOP guard checks that `has_menu_cap` knows `manage_menu`).
- **Craft OS is the master of the menu.** `/menu/import` keeps its typed confirmation, and its warning (`MASTER_WARNING`, rewritten in Task 4) lists everything a re-import resets (Open point 2).
- **Staff fixtures in verify scripts** are created after `request.jwt.claims` is set to the dev owner `76cbcf9f-905e-450d-9f5e-1c9e72a9373d` (the staff authority guard from `feature/staff-private` lets only an owner give a non-`staff` role), inserted as `staff` and promoted by the owner.
- Every write whose success is shown goes through an RPC whose error is thrown, or through `writeOutcome` with `.select()` (the Products page's quick edits keep M1's `updateProducts`). Every load keyed by a selection (a product, a group, a catalog) drops a stale reply: a sequence ref, and the page is keyed by its route id. Every Save is disabled while it runs.
- `tsconfig` has `noUnusedLocals` / `noUnusedParameters`: remove an import the moment it is no longer used.
- Components stay focused: no file this plan creates or rewrites passes ~250 lines (pages are split into section components).
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Several sessions share the stash stack: never use a bare `git stash`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-24-pos-menu-editor-fn.sql` | Every M2 function (Task 1) |
| `src/features/pos/sqlSafeUpdate.test.ts` | Names the new file and its write functions in the pg-safeupdate scan (Task 1) |
| `supabase/migration-2026-10-24-pos-menu-editor-verify.sql` | Self-check, rolled back (Task 2) |
| `src/features/pos/order/posApi.ts`, `OrderPad.tsx` | `fetchPosMenu(catalogId)` through `pos_menu_rows` (Task 3) |
| `src/features/pos/menu/menuEditorApi.ts` | Types and RPC wrappers of every editor call (Task 4) |
| `src/features/pos/menu/menuApi.ts` | `fetchMenu` through `menu_product_list`; M1's catalog-entry calls go (Task 4) |
| `src/features/pos/menu/menuView.ts` (+test) | Tabs, list filters, "sold in" names; M1's catalog-column helpers go (Task 4) |
| `src/features/pos/menu/editorUi.tsx`, `MenuTabs.tsx`, `MenuRoutes.tsx` | Shared look and outcome line, sub-navigation, routes under `/menu/*` (Task 4; routes grow in Tasks 5–8) |
| `src/features/pos/menu/ProductListPage.tsx` (was `MenuPage.tsx`) | Products page (Task 4) |
| `src/App.tsx`, `src/features/pos/menu/MenuImportPage.tsx` | `/menu/*` behind Edit menu; the import page shows the tabs (Task 4) |
| `src/features/pos/menu/importView.ts` (+test) | `MASTER_WARNING` lists what a re-import resets (Task 4) |
| `src/features/pos/menu/menuForms.ts` (+test) | Names, RM ↔ sen, reorder, refs (Task 5) |
| `src/features/pos/menu/productForm.ts` (+test) | Product form ↔ detail ↔ payload, every product rule (Task 5) |
| `src/features/pos/menu/ProductEditorPage.tsx`, `product/DetailsSection.tsx`, `product/VariantsSection.tsx`, `product/GroupsSection.tsx`, `product/CatalogsSection.tsx` | Product editor (Task 5) |
| `src/features/pos/menu/groupForm.ts` (+test) | Group form ↔ detail ↔ payload, every group rule (Task 6) |
| `src/features/pos/menu/GroupListPage.tsx`, `GroupEditorPage.tsx`, `group/OptionsSection.tsx` | Add-on groups (Task 6) |
| `src/features/pos/menu/listAdmin.ts` (+test), `catalogGrid.ts` (+test) | Names and order of catalogs / categories; one catalog-page row (Task 7) |
| `src/features/pos/menu/CatalogsPage.tsx`, `CatalogGridPage.tsx`, `catalog/GridRow.tsx` | Catalogs (Task 7) |
| `src/features/pos/menu/CategoriesPage.tsx` | Categories (Task 8) |

`cart.ts` (`buildPosMenu`), the QR app, `qr_menu`, `pos_insert_order`, `place_*`, `menu_import*`, POS settings and every RLS policy do not change.

**Test counts** (checked while planning on a scratch copy of `src` at `f2cbd29`, by replaying this document task by task): baseline 85 files / 732 tests. After Task 1: 85 / 734. Tasks 2–3: 85 / 734. Task 4: 85 / 734 (`menuView.test.ts` 8 → 7, `importView.test.ts` 2 → 3). Task 5: 87 / 757. Task 6: 88 / 765. Task 7: 90 / 775. Task 8: 90 / 775. `npx tsc -b` prints nothing after every task.

---

### Task 1: The menu editor's server functions (SQL) and the pg-safeupdate scan

**Files:**
- Create: `supabase/migration-2026-10-24-pos-menu-editor-fn.sql`
- Modify: `src/features/pos/sqlSafeUpdate.test.ts`

**Interfaces:**
- Consumes: M1's `has_menu_cap` / `pos_my_branch`, `menu_catalogs`, `catalog_products`, `catalog_variant_prices`, `catalog_option_prices`, `branch_catalogs`; Sub-plan 1's menu tables.
- Produces (later tasks call these exact names and shapes; JSON keys are camelCase unless noted):
  - `menu_editor_lookups() → { categories: [{id,name,isActive,sortOrder,productCount}], catalogs: [{id,name,isActive,sortOrder,feedmeName,productCount,unpricedCount,uses:[{branch,role}]}], groups: [{id,name,isActive,min,max,optionCount,productCount}], addOns: [{id,name,isActive}] }`
  - `menu_product_list() → [MenuProductRow]` (snake_case, the shape of `MenuProductRow` in `menuApi.ts`, plus `is_active`, `category_id`, `catalog_ids`)
  - `menu_product_detail(p_product_id uuid) → { id,name,internalName,description,categoryId,sstRateBp,printRoute,takeawayFeeSen,isActive,isAddon,feedmeProductId, variants:[{id,name,priceSen,isActive}], groupIds:[uuid], catalogs:[{catalogId,availability,prices:{<variantId>:sen}}] }` — one entry per catalog
  - `menu_save_product(p jsonb) → uuid` — for an existing product every detail key is optional (left out = kept); `variants`, `groupIds`, `catalogs` are always arrays; catalogs left out are untouched. `menu_group_detail(p_group_id uuid) → jsonb`, `menu_save_group(p jsonb) → uuid` (payloads in the function comments)
  - `menu_save_catalog(p_id uuid, p_name text) → uuid` (null id = create), `menu_duplicate_catalog(p_source_id uuid, p_name text) → uuid`, `menu_reorder_catalogs(p_ids uuid[])`, `menu_set_catalog_active(p_id uuid, p_active boolean)`, `menu_catalog_grid(p_catalog_id uuid) → { catalog:{id,name,isActive}, products:[{id,name,category,categorySort,availability,variants:[{id,name,isActive,defaultSen,priceSen|null}]}] }`, `menu_save_catalog_row(p jsonb)`
  - `menu_save_category(p_id uuid, p_name text) → uuid`, `menu_reorder_categories(p_ids uuid[])`, `menu_set_category_active(p_id uuid, p_active boolean)`
  - `pos_menu_rows(p_catalog_id uuid) → { products, groups, links, soldOut, catalog: { products, prices, optionPrices } }` (snake_case rows: exactly `ProductRow`, `GroupRow`, `LinkRow`, `SoldOutRow`, `CatalogRows` of `cart.ts`)
  - Refusal words (the client shows them as they are): `Not allowed to edit the menu`; `Invalid product`; `Product name is required`; `Product name is too long (at most 120 characters)`; `Choose a category`; `Invalid SST rate`; `Invalid takeaway fee`; `Internal name is too long (at most 120 characters)`; `Description is too long (at most 1000 characters)`; `Print route name is too long (at most 40 characters)`; `Too many variants (at most 30)`; `Variant name is required`; `Variant name is too long (at most 60 characters)`; `Invalid default price for <variant>`; `Variant not found — refresh and try again`; `The product changed since you opened it — refresh and try again`; `A product needs at least one active variant`; `Two variants are called <first of the twins>`; `Too many add-on groups (at most 30)`; `An add-on group is linked twice`; `Add-on group not found — refresh and try again`; `Catalog not found — refresh and try again`; `Invalid availability`; `<Catalog>: invalid price for <variant>`; `<Catalog>: enter a price for <variant>`; `Product not found — refresh and try again`; `Product not found` / `Add-on group not found` / `Catalog not found` (detail reads); `Invalid add-on group`; `Add-on group name is required`; `Add-on group name is too long (at most 80 characters)`; `Min must be a whole number from 0 to 99`; `Max must be a whole number from 1 to 99`; `Min cannot be more than max`; `Too many options (at most 100)`; `Option not found — refresh and try again`; `Option name is required`; `Option name is too long (at most 80 characters)`; `Invalid price for <option>`; `Add-on item not found — refresh and try again`; `The add-on group changed since you opened it — refresh and try again`; `Two options use the same add-on item: <item>`; `Two options use the same add-on item — change one and save again` (a swap that collides while writing); `A switched-off option cannot be the default: <option>`; `At most <n> option(s) can be the default`; `Min is <n> but only <m> option is / options are on`; `<Catalog>: invalid price for <option>` (an option override); `Catalog name is required` / `… is too long (at most 60 characters)`; `A catalog called <name> already exists`; `The catalog list changed — refresh and try again`; `<Catalog> is the dine-in|takeaway|QR catalog of <Branch> — choose another in POS settings first`; `Invalid catalog`; `Invalid catalog row`; `Invalid category`; `Category name is required`; `A category called <name> already exists`; `Category not found — refresh and try again`; `The category list changed — refresh and try again`.

- [ ] **Step 1: Make the pg-safeupdate scan name the new file.** In `src/features/pos/sqlSafeUpdate.test.ts` make exactly these replacements (each old text occurs once):

1. Replace

```ts
      'migration-2026-10-24-pos-checkout-fn.sql',
    ]))
```

   with

```ts
      'migration-2026-10-24-pos-checkout-fn.sql',
      'migration-2026-10-24-pos-menu-editor-fn.sql',
    ]))
```

2. Replace

```ts
    expect(names).toEqual(expect.arrayContaining(['pos_insert_order', 'menu_import', 'menu_import_catalogs', 'save_branch_catalogs']))
  })
```

   with

```ts
    expect(names).toEqual(expect.arrayContaining(['pos_insert_order', 'menu_import', 'menu_import_catalogs', 'save_branch_catalogs']))
  })

  it('scans every write function of the menu editor (M2)', () => {
    const sql = readFileSync(new URL('migration-2026-10-24-pos-menu-editor-fn.sql', SUPABASE), 'utf8')
    const names = functionBodies(sql).map((b) => b.name)
    expect(names).toEqual(expect.arrayContaining([
      'menu_save_product', 'menu_save_group', 'menu_save_catalog', 'menu_duplicate_catalog', 'menu_reorder_catalogs',
      'menu_set_catalog_active', 'menu_save_catalog_row', 'menu_save_category', 'menu_reorder_categories',
      'menu_set_category_active',
    ]))
  })
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` — Expected: FAIL, 2 failed (`reads the POS function migrations` misses the new file; the new test cannot read it: `ENOENT`).

- [ ] **Step 3: Write the migration** `supabase/migration-2026-10-24-pos-menu-editor-fn.sql`:

```sql
-- ============================================================================
-- Craft OS — POS menu catalogs · M2 menu editor functions (2026-10-24). Run on
-- craft-os-dev after migration-2026-10-24-pos-catalogs.sql and
-- migration-2026-10-24-pos-catalogs-fn.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-menu-catalogs-m2.md
-- Design: docs/superpowers/specs/2026-10-24-pos-menu-catalogs-design.md §2, §4, §7
--
-- Only NEW functions: no function, table, column or policy of an earlier file is
-- re-created or changed, so re-running this file never puts anything older back.
-- Every editor function needs Edit menu (has_menu_cap('manage_menu'), live staff
-- only) and answers 'Not allowed to edit the menu' otherwise. Nothing is deleted
-- except configuration that no order refers to: a product's link to an add-on
-- group, and a catalog's add-on price override (orders snapshot names and prices).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('menu_set_catalog_product(uuid,uuid,text)') is null
     or to_regprocedure('pos_order_catalog(uuid,text,text,uuid)') is null
     or to_regprocedure('pos_my_branch()') is null
     or to_regclass('public.catalog_option_prices') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-catalogs.sql and migration-2026-10-24-pos-catalogs-fn.sql first (the M1 catalog functions are missing)';
  end if;
  if pg_get_functiondef('has_menu_cap(text)'::regprocedure) not like '%manage_menu%' then
    raise exception 'STOP: has_menu_cap does not know manage_menu — re-run migration-2026-10-24-pos-catalogs.sql first';
  end if;
end $$;

-- ── Internal helpers ───────────────────────────────────────────────────────
create or replace function menu_require_editor() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not has_menu_cap('manage_menu') then
    raise exception 'Not allowed to edit the menu';
  end if;
end $$;
revoke all on function menu_require_editor() from public, anon, authenticated;

-- A name as the editor shows it: trimmed, inner spaces collapsed. Same words as
-- nameProblem() in src/features/pos/menu/menuForms.ts.
create or replace function menu_clean_name(p_name text, p_what text, p_max integer) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if v = '' then raise exception '% name is required', p_what; end if;
  if length(v) > p_max then raise exception '% name is too long (at most % characters)', p_what, p_max; end if;
  return v;
end $$;
revoke all on function menu_clean_name(text, text, integer) from public, anon, authenticated;

-- A whole number of sen from 0 to 99 999 999 (RM 999 999.99), else null.
create or replace function menu_sen(p_value jsonb) returns integer
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v numeric;
begin
  if jsonb_typeof(p_value) is distinct from 'number' then return null; end if;
  v := (p_value #>> '{}')::numeric;
  if v < 0 or v > 99999999 or v <> trunc(v) then return null; end if;
  return v::integer;
end $$;
revoke all on function menu_sen(jsonb) from public, anon, authenticated;

-- A uuid given as a JSON string, else null (plpgsql: the cast runs only after the check).
create or replace function menu_uuid(p_value jsonb) returns uuid
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string'
     or (p_value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return (p_value #>> '{}')::uuid;
end $$;
revoke all on function menu_uuid(jsonb) from public, anon, authenticated;

-- The key of a variant made in Craft OS. menu_variants.feedme_variant_key is unique
-- per product and '' marks the base (only) variant, whose name tickets leave out.
create or replace function menu_new_variant_key() returns text
language sql volatile set search_path = public, pg_temp as $$
  select 'cos-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
$$;
revoke all on function menu_new_variant_key() from public, anon, authenticated;

-- Spec §2: a product a catalog sells has a price there for each of its active
-- variants. Checked after every write that could break it; raises the first gap.
create or replace function menu_check_catalog_prices(p_product_id uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_missing text;
begin
  select format('%s: enter a price for %s', m.name, v.name) into v_missing
    from catalog_products cp
    join menu_catalogs m on m.id = cp.catalog_id
    join menu_variants v on v.product_id = cp.product_id and v.is_active
   where cp.product_id = p_product_id and cp.availability <> 'hidden'
     and not exists (select 1 from catalog_variant_prices cvp where cvp.catalog_id = cp.catalog_id and cvp.variant_id = v.id)
   order by m.sort_order, m.name, v.sort_order, v.name
   limit 1;
  if v_missing is not null then
    raise exception '%', v_missing;
  end if;
end $$;
revoke all on function menu_check_catalog_prices(uuid) from public, anon, authenticated;

-- ── Reads for the editor pages (one JSON value each: PostgREST's 1000-row cap
--    never cuts them short) ──────────────────────────────────────────────────
-- Categories, catalogs (with where they are used), add-on groups and add-on items.
create or replace function menu_editor_lookups() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return jsonb_build_object(
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'name', c.name, 'isActive', c.is_active, 'sortOrder', c.sort_order,
               'productCount', (select count(*) from menu_products p
                                 where p.category_id = c.id and p.is_active and not p.is_addon))
             order by c.sort_order, c.name)
        from menu_categories c), '[]'::jsonb),
    'catalogs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'isActive', m.is_active, 'sortOrder', m.sort_order,
               'feedmeName', m.feedme_catalog_name,
               'productCount', (select count(*) from catalog_products cp
                                  join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
                                 where cp.catalog_id = m.id and cp.availability <> 'hidden'),
               -- products the catalog sells with an active variant it has no price for: the pad and
               -- QR leave them out (a re-import can cause it in catalogs made here, Open point 7)
               'unpricedCount', (select count(*) from catalog_products cp
                                   join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
                                  where cp.catalog_id = m.id and cp.availability <> 'hidden'
                                    and exists (select 1 from menu_variants v
                                                 where v.product_id = p.id and v.is_active
                                                   and not exists (select 1 from catalog_variant_prices cvp
                                                                    where cvp.catalog_id = m.id and cvp.variant_id = v.id))),
               'uses', coalesce((select jsonb_agg(jsonb_build_object('branch', b.name, 'role', bc.role) order by b.name, bc.role)
                                   from branch_catalogs bc join branches b on b.id = bc.branch_id and coalesce(b.is_active, true)
                                  where bc.catalog_id = m.id), '[]'::jsonb))
             order by m.sort_order, m.name)
        from menu_catalogs m), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'isActive', g.is_active, 'min', g.min_select, 'max', g.max_select,
               'optionCount', (select count(*) from modifier_options o where o.group_id = g.id and o.availability <> 'hidden'),
               'productCount', (select count(*) from product_modifier_groups pmg
                                  join menu_products p on p.id = pmg.product_id and p.is_active
                                 where pmg.group_id = g.id))
             order by g.sort_order, g.name)
        from modifier_groups g), '[]'::jsonb),
    'addOns', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'isActive', p.is_active) order by p.name)
        from menu_products p where p.is_addon), '[]'::jsonb));
end $$;
revoke all on function menu_editor_lookups() from public, anon;
grant execute on function menu_editor_lookups() to authenticated;

-- The Products page: every product (switched-off ones too) in the shape of
-- MenuProductRow (src/features/pos/menu/menuApi.ts), plus the catalogs that sell it.
create or replace function menu_product_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'is_active', p.is_active, 'is_addon', p.is_addon,
             'sst_rate_bp', p.sst_rate_bp, 'print_route', p.print_route, 'takeaway_fee_sen', p.takeaway_fee_sen,
             'sort_order', p.sort_order, 'category_id', p.category_id,
             'category', case when c.id is null then null
                              else jsonb_build_object('name', c.name, 'sort_order', c.sort_order) end,
             'menu_variants', coalesce((select jsonb_agg(jsonb_build_object(
                                                'id', v.id, 'name', v.name, 'price_sen', v.price_sen,
                                                'is_active', v.is_active, 'sort_order', v.sort_order)
                                              order by v.sort_order, v.name)
                                         from menu_variants v where v.product_id = p.id), '[]'::jsonb),
             'catalog_ids', coalesce((select jsonb_agg(cp.catalog_id)
                                       from catalog_products cp
                                      where cp.product_id = p.id and cp.availability <> 'hidden'), '[]'::jsonb))
           order by p.sort_order, p.name)
      from menu_products p
      left join menu_categories c on c.id = p.category_id), '[]'::jsonb);
end $$;
revoke all on function menu_product_list() from public, anon;
grant execute on function menu_product_list() to authenticated;

-- The product editor: the product, its variants (in order), its add-on groups (in
-- order) and one entry per catalog (every catalog; 'hidden' when it does not sell it).
create or replace function menu_product_detail(p_product_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform menu_require_editor();
  select jsonb_build_object(
           'id', p.id, 'name', p.name, 'internalName', p.internal_name, 'description', p.description,
           'categoryId', p.category_id, 'sstRateBp', p.sst_rate_bp, 'printRoute', p.print_route,
           'takeawayFeeSen', p.takeaway_fee_sen, 'isActive', p.is_active, 'isAddon', p.is_addon,
           'feedmeProductId', p.feedme_product_id,
           'variants', coalesce((select jsonb_agg(jsonb_build_object('id', mv.id, 'name', mv.name, 'priceSen', mv.price_sen,
                                                                     'isActive', mv.is_active)
                                                  order by mv.sort_order, mv.name)
                                   from menu_variants mv where mv.product_id = p.id), '[]'::jsonb),
           'groupIds', coalesce((select jsonb_agg(pmg.group_id order by pmg.sort_order, g.name)
                                   from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id
                                  where pmg.product_id = p.id), '[]'::jsonb),
           'catalogs', coalesce((select jsonb_agg(jsonb_build_object(
                                          'catalogId', m.id,
                                          'availability', coalesce(cp.availability, 'hidden'),
                                          'prices', coalesce((select jsonb_object_agg(cvp.variant_id::text, cvp.price_sen)
                                                                from catalog_variant_prices cvp
                                                                join menu_variants mv on mv.id = cvp.variant_id and mv.product_id = p.id
                                                               where cvp.catalog_id = m.id), '{}'::jsonb))
                                        order by m.sort_order, m.name)
                                   from menu_catalogs m
                                   left join catalog_products cp on cp.catalog_id = m.id and cp.product_id = p.id), '[]'::jsonb))
    into v
    from menu_products p
   where p.id = p_product_id;
  if v is null then
    raise exception 'Product not found';
  end if;
  return v;
end $$;
revoke all on function menu_product_detail(uuid) from public, anon;
grant execute on function menu_product_detail(uuid) to authenticated;

-- ── Save a product in one transaction (spec §4) ────────────────────────────
-- p = { id: uuid|null (null = new), name, internalName, description, categoryId,
--       sstRateBp, printRoute, takeawayFeeSen, isActive, isAddon,
--       variants: [{ ref, id: uuid|null, name, priceSen, isActive }]          (array order = order on screen)
--       groupIds: [uuid]                                                     (array order = order on screen)
--       catalogs: [{ catalogId, availability: 'all'|'counter_only'|'hidden',
--                    prices: [{ ref, priceSen }] }] }                        (ref = a variant's ref)
-- An existing variant's ref is its id; a new one's is any other string. Every
-- existing variant must be listed (switched off, never dropped). Catalogs left out
-- are not touched. For an existing product a detail key that is left out keeps its
-- stored value (the editor sends only what changed, so a save never undoes an edit
-- made meanwhile on the Products or catalog page); a new product needs them all.
-- Returns the product id.
create or replace function menu_save_product(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id       uuid;
  v_new      boolean;
  v_name     text;
  v_internal text;
  v_desc     text;
  v_cat      uuid;
  v_sst      integer;
  v_route    text;
  v_fee      integer;
  v_groups   uuid[];
  v_el       record;
  v_pr       record;
  v_vid      uuid;
  v_vname    text;
  v_price    integer;
  v_catalog  uuid;
  v_avail    text;
  v_cname    text;
  v_text     text;
  v_cur      menu_products;
  v_on       boolean;
  v_addon    boolean;
begin
  perform menu_require_editor();
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(p->'variants') is distinct from 'array'
     or jsonb_typeof(p->'groupIds') is distinct from 'array'
     or jsonb_typeof(p->'catalogs') is distinct from 'array' then
    raise exception 'Invalid product';
  end if;

  -- ── the product ──
  v_new := coalesce(jsonb_typeof(p->'id'), 'null') = 'null';
  if not v_new then
    v_id := menu_uuid(p->'id');
    select * into v_cur from menu_products where id = v_id;
    if v_id is null or not found then
      raise exception 'Product not found — refresh and try again';
    end if;
  end if;
  -- each detail: the payload's value when the key is there (always for a new product), else the stored one
  if v_new or p ? 'name' then v_name := menu_clean_name(p->>'name', 'Product', 120); else v_name := v_cur.name; end if;
  if v_new or p ? 'internalName' then
    v_internal := nullif(trim(coalesce(p->>'internalName', '')), '');
    if length(v_internal) > 120 then raise exception 'Internal name is too long (at most 120 characters)'; end if;
  else v_internal := v_cur.internal_name; end if;
  if v_new or p ? 'description' then
    v_desc := nullif(trim(coalesce(p->>'description', '')), '');
    if length(v_desc) > 1000 then raise exception 'Description is too long (at most 1000 characters)'; end if;
  else v_desc := v_cur.description; end if;
  v_cat := case when v_new or p ? 'categoryId' then menu_uuid(p->'categoryId') else v_cur.category_id end;
  if v_cat is null or not exists (select 1 from menu_categories where id = v_cat) then
    raise exception 'Choose a category';
  end if;
  if v_new or p ? 'sstRateBp' then
    v_sst := menu_sen(p->'sstRateBp');
    if v_sst is null or v_sst > 10000 then raise exception 'Invalid SST rate'; end if;
  else v_sst := v_cur.sst_rate_bp; end if;
  if v_new or p ? 'printRoute' then
    if coalesce(jsonb_typeof(p->'printRoute'), 'null') not in ('null', 'string') then raise exception 'Invalid product'; end if;
    v_route := nullif(trim(coalesce(p->>'printRoute', '')), '');
    if length(v_route) > 40 then raise exception 'Print route name is too long (at most 40 characters)'; end if;
  else v_route := v_cur.print_route; end if;
  if v_new or p ? 'takeawayFeeSen' then
    v_fee := menu_sen(p->'takeawayFeeSen');
    if v_fee is null then raise exception 'Invalid takeaway fee'; end if;
  else v_fee := v_cur.takeaway_fee_sen; end if;
  if v_new or p ? 'isActive' then
    if jsonb_typeof(p->'isActive') is distinct from 'boolean' then raise exception 'Invalid product'; end if;
    v_on := (p->>'isActive')::boolean;
  else v_on := v_cur.is_active; end if;
  if v_new or p ? 'isAddon' then
    if jsonb_typeof(p->'isAddon') is distinct from 'boolean' then raise exception 'Invalid product'; end if;
    v_addon := (p->>'isAddon')::boolean;
  else v_addon := v_cur.is_addon; end if;

  -- ── variants, in the order given ──
  if jsonb_array_length(p->'variants') > 30 then raise exception 'Too many variants (at most 30)'; end if;
  drop table if exists pg_temp._ms_var;
  create temp table pg_temp._ms_var (
    ref text primary key, id uuid unique, name text not null, price_sen integer not null,
    is_active boolean not null, sort_order integer not null
  ) on commit drop;
  for v_el in select e.v, e.ord from jsonb_array_elements(p->'variants') with ordinality as e(v, ord) loop
    if jsonb_typeof(v_el.v) <> 'object' or jsonb_typeof(v_el.v->'ref') is distinct from 'string'
       or coalesce(v_el.v->>'ref', '') = '' or jsonb_typeof(v_el.v->'isActive') is distinct from 'boolean' then
      raise exception 'Invalid product';
    end if;
    v_vid := null;
    if coalesce(jsonb_typeof(v_el.v->'id'), 'null') <> 'null' then
      v_vid := menu_uuid(v_el.v->'id');
      if v_vid is null or v_new or not exists (select 1 from menu_variants where id = v_vid and product_id = v_id) then
        raise exception 'Variant not found — refresh and try again';
      end if;
    end if;
    v_vname := menu_clean_name(v_el.v->>'name', 'Variant', 60);
    v_price := menu_sen(v_el.v->'priceSen');
    if v_price is null then raise exception 'Invalid default price for %', v_vname; end if;
    begin
      insert into pg_temp._ms_var(ref, id, name, price_sen, is_active, sort_order)
      values (v_el.v->>'ref', v_vid, v_vname, v_price, (v_el.v->>'isActive')::boolean, v_el.ord - 1);
    exception when unique_violation then
      raise exception 'Invalid product';                       -- a ref or a variant id twice
    end;
  end loop;
  if not v_new and exists (select 1 from menu_variants mv where mv.product_id = v_id
                             and not exists (select 1 from pg_temp._ms_var t where t.id = mv.id)) then
    raise exception 'The product changed since you opened it — refresh and try again';
  end if;
  if not exists (select 1 from pg_temp._ms_var where is_active) then
    raise exception 'A product needs at least one active variant';
  end if;
  select t.name into v_text from pg_temp._ms_var t
   where t.is_active and lower(t.name) in (select lower(x.name) from pg_temp._ms_var x where x.is_active
                                            group by lower(x.name) having count(*) > 1)
   order by t.sort_order limit 1;                              -- the first of the twins, as the editor names it
  if v_text is not null then raise exception 'Two variants are called %', v_text; end if;

  -- ── add-on groups, in the order given ──
  if jsonb_array_length(p->'groupIds') > 30 then raise exception 'Too many add-on groups (at most 30)'; end if;
  if exists (select 1 from jsonb_array_elements(p->'groupIds') g where menu_uuid(g) is null) then
    raise exception 'Invalid product';
  end if;
  select coalesce(array_agg(menu_uuid(g.v) order by g.ord), '{}') into v_groups
    from jsonb_array_elements(p->'groupIds') with ordinality as g(v, ord);
  if cardinality(v_groups) <> (select count(distinct u) from unnest(v_groups) u) then
    raise exception 'An add-on group is linked twice';
  end if;
  if exists (select 1 from unnest(v_groups) u where not exists (select 1 from modifier_groups g where g.id = u)) then
    raise exception 'Add-on group not found — refresh and try again';
  end if;

  -- ── catalogs: availability and prices ──
  drop table if exists pg_temp._ms_cat;
  create temp table pg_temp._ms_cat (catalog_id uuid primary key, availability text not null) on commit drop;
  drop table if exists pg_temp._ms_price;
  create temp table pg_temp._ms_price (
    catalog_id uuid not null, ref text not null, price_sen integer not null, primary key (catalog_id, ref)
  ) on commit drop;
  for v_el in select e.v from jsonb_array_elements(p->'catalogs') as e(v) loop
    if jsonb_typeof(v_el.v) <> 'object' or jsonb_typeof(v_el.v->'prices') is distinct from 'array' then
      raise exception 'Invalid product';
    end if;
    v_catalog := menu_uuid(v_el.v->'catalogId');
    select name into v_cname from menu_catalogs where id = v_catalog;
    if v_cname is null then raise exception 'Catalog not found — refresh and try again'; end if;
    v_avail := v_el.v->>'availability';
    if v_avail is null or v_avail not in ('all', 'counter_only', 'hidden') then
      raise exception 'Invalid availability';
    end if;
    begin
      insert into pg_temp._ms_cat(catalog_id, availability) values (v_catalog, v_avail);
    exception when unique_violation then
      raise exception 'Invalid product';                       -- a catalog twice
    end;
    for v_pr in select x.v from jsonb_array_elements(v_el.v->'prices') as x(v) loop
      if jsonb_typeof(v_pr.v) <> 'object'
         or not exists (select 1 from pg_temp._ms_var t where t.ref = v_pr.v->>'ref') then
        raise exception 'Invalid product';
      end if;
      v_price := menu_sen(v_pr.v->'priceSen');
      if v_price is null then
        raise exception '%: invalid price for %', v_cname, (select t.name from pg_temp._ms_var t where t.ref = v_pr.v->>'ref');
      end if;
      begin
        insert into pg_temp._ms_price(catalog_id, ref, price_sen) values (v_catalog, v_pr.v->>'ref', v_price);
      exception when unique_violation then
        raise exception 'Invalid product';                     -- a variant priced twice in one catalog
      end;
    end loop;
  end loop;

  -- ── write: the product ──
  if v_new then
    insert into menu_products(name, internal_name, description, category_id, sst_rate_bp, print_route,
                              takeaway_fee_sen, is_active, is_addon, sort_order)
    values (v_name, v_internal, v_desc, v_cat, v_sst, v_route, v_fee, v_on, v_addon,
            coalesce((select max(sort_order) + 1 from menu_products), 0))
    returning id into v_id;
  else
    update menu_products
       set name = v_name, internal_name = v_internal, description = v_desc, category_id = v_cat,
           sst_rate_bp = v_sst, print_route = v_route, takeaway_fee_sen = v_fee,
           is_active = v_on, is_addon = v_addon, updated_at = now()
     where id = v_id;
  end if;

  -- ── write: variants. Existing ones keep their key; a new product sold in one variant
  --    gets the base ('') key for it, every other new variant a 'cos-…' key ──
  update menu_variants mv
     set name = t.name, price_sen = t.price_sen, sort_order = t.sort_order, is_active = t.is_active
    from pg_temp._ms_var t
   where t.id is not null and mv.id = t.id;
  for v_el in select t.ref, t.name, t.price_sen, t.is_active, t.sort_order
                from pg_temp._ms_var t where t.id is null order by t.sort_order loop
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order, is_active)
    values (v_id,
            case when v_new and v_el.is_active and (select count(*) from pg_temp._ms_var where is_active) = 1
                 then '' else menu_new_variant_key() end,
            v_el.name, v_el.price_sen, v_el.sort_order, v_el.is_active)
    returning id into v_vid;
    update pg_temp._ms_var set id = v_vid where ref = v_el.ref;
  end loop;
  -- a product sold in more than one variant has no base variant: tickets must name each one
  if (select count(*) from menu_variants where product_id = v_id and is_active) > 1 then
    update menu_variants set feedme_variant_key = menu_new_variant_key()
     where product_id = v_id and is_active and feedme_variant_key = '';
  end if;

  -- ── write: add-on group links (configuration: a removed link is deleted) ──
  delete from product_modifier_groups where product_id = v_id and not (group_id = any (v_groups));
  insert into product_modifier_groups(product_id, group_id, sort_order)
  select v_id, g.id, g.ord - 1 from unnest(v_groups) with ordinality as g(id, ord)
  on conflict (product_id, group_id) do update set sort_order = excluded.sort_order;

  -- ── write: catalogs. Out of a catalog = 'hidden'; the row and its prices stay ──
  update catalog_products cp set availability = c.availability
    from pg_temp._ms_cat c
   where cp.catalog_id = c.catalog_id and cp.product_id = v_id;
  insert into catalog_products(catalog_id, product_id, availability, sort_order)
  select c.catalog_id, v_id, c.availability,
         coalesce((select max(x.sort_order) + 1 from catalog_products x where x.catalog_id = c.catalog_id), 0)
    from pg_temp._ms_cat c
   where c.availability <> 'hidden'
     and not exists (select 1 from catalog_products cp where cp.catalog_id = c.catalog_id and cp.product_id = v_id);
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
  select pr.catalog_id, t.id, pr.price_sen
    from pg_temp._ms_price pr join pg_temp._ms_var t on t.ref = pr.ref
  on conflict (catalog_id, variant_id) do update set price_sen = excluded.price_sen;

  -- every catalog that sells it (listed or not) prices every active variant
  perform menu_check_catalog_prices(v_id);
  return v_id;
end $$;
revoke all on function menu_save_product(jsonb) from public, anon;
grant execute on function menu_save_product(jsonb) to authenticated;

-- ── Add-on groups ──────────────────────────────────────────────────────────
-- The group editor: the group, its options in order (each with its per-catalog
-- price overrides) and the active products that use it.
create or replace function menu_group_detail(p_group_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
begin
  perform menu_require_editor();
  select jsonb_build_object(
           'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select, 'stackable', g.stackable,
           'isActive', g.is_active, 'feedmeGroupId', g.feedme_group_id,
           'options', coalesce((select jsonb_agg(jsonb_build_object(
                                         'id', o.id, 'name', o.name, 'priceDeltaSen', o.price_delta_sen,
                                         'productId', o.product_id, 'isDefault', o.is_default, 'availability', o.availability,
                                         'catalogPrices', coalesce((select jsonb_object_agg(cop.catalog_id::text, cop.price_delta_sen)
                                                                      from catalog_option_prices cop
                                                                     where cop.option_id = o.id), '{}'::jsonb))
                                       order by o.sort_order, o.name)
                                  from modifier_options o where o.group_id = g.id), '[]'::jsonb),
           'usedBy', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
                                 from product_modifier_groups pmg
                                 join menu_products p on p.id = pmg.product_id and p.is_active
                                where pmg.group_id = g.id), '[]'::jsonb))
    into v
    from modifier_groups g
   where g.id = p_group_id;
  if v is null then
    raise exception 'Add-on group not found';
  end if;
  return v;
end $$;
revoke all on function menu_group_detail(uuid) from public, anon;
grant execute on function menu_group_detail(uuid) to authenticated;

-- p = { id: uuid|null, name, min, max, stackable, isActive,
--       options: [{ ref, id: uuid|null, name, priceDeltaSen, productId: uuid|null, isDefault,
--                   availability: 'all'|'counter_only'|'hidden' }]           (array order = order on screen)
--       catalogPrices: [{ catalogId, ref, priceDeltaSen }] }                 (every override the group keeps)
-- An option is never deleted (order snapshots name it): 'hidden' switches it off.
-- A catalog override that is not listed any more is removed (the option's own price
-- applies again). Returns the group id.
create or replace function menu_save_group(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id      uuid;
  v_new     boolean;
  v_name    text;
  v_min     integer;
  v_max     integer;
  v_on      integer;
  v_el      record;
  v_oid     uuid;
  v_oname   text;
  v_price   integer;
  v_prod    uuid;
  v_avail   text;
  v_key     text;
  v_catalog uuid;
  v_cname   text;
  v_text    text;
begin
  perform menu_require_editor();
  if jsonb_typeof(p) is distinct from 'object'
     or jsonb_typeof(p->'options') is distinct from 'array'
     or jsonb_typeof(p->'catalogPrices') is distinct from 'array'
     or jsonb_typeof(p->'stackable') is distinct from 'boolean'
     or jsonb_typeof(p->'isActive') is distinct from 'boolean' then
    raise exception 'Invalid add-on group';
  end if;
  v_new := coalesce(jsonb_typeof(p->'id'), 'null') = 'null';
  if not v_new then
    v_id := menu_uuid(p->'id');
    if v_id is null or not exists (select 1 from modifier_groups where id = v_id) then
      raise exception 'Add-on group not found — refresh and try again';
    end if;
  end if;
  v_name := menu_clean_name(p->>'name', 'Add-on group', 80);
  v_min := menu_sen(p->'min');
  if v_min is null or v_min > 99 then raise exception 'Min must be a whole number from 0 to 99'; end if;
  v_max := menu_sen(p->'max');
  if v_max is null or v_max < 1 or v_max > 99 then raise exception 'Max must be a whole number from 1 to 99'; end if;
  if v_min > v_max then raise exception 'Min cannot be more than max'; end if;

  -- ── options, in the order given ──
  if jsonb_array_length(p->'options') > 100 then raise exception 'Too many options (at most 100)'; end if;
  drop table if exists pg_temp._mg_opt;
  create temp table pg_temp._mg_opt (
    ref text primary key, id uuid unique, name text not null, price_sen integer not null, product_id uuid,
    variant_key text not null, is_default boolean not null, availability text not null, sort_order integer not null
  ) on commit drop;
  for v_el in select e.v, e.ord from jsonb_array_elements(p->'options') with ordinality as e(v, ord) loop
    if jsonb_typeof(v_el.v) <> 'object' or jsonb_typeof(v_el.v->'ref') is distinct from 'string'
       or coalesce(v_el.v->>'ref', '') = '' or jsonb_typeof(v_el.v->'isDefault') is distinct from 'boolean' then
      raise exception 'Invalid add-on group';
    end if;
    v_oid := null;
    v_key := '';
    if coalesce(jsonb_typeof(v_el.v->'id'), 'null') <> 'null' then
      v_oid := menu_uuid(v_el.v->'id');
      if v_oid is null or v_new or not exists (select 1 from modifier_options where id = v_oid and group_id = v_id) then
        raise exception 'Option not found — refresh and try again';
      end if;
    end if;
    v_oname := menu_clean_name(v_el.v->>'name', 'Option', 80);
    v_price := menu_sen(v_el.v->'priceDeltaSen');
    if v_price is null then raise exception 'Invalid price for %', v_oname; end if;
    v_prod := null;
    if coalesce(jsonb_typeof(v_el.v->'productId'), 'null') <> 'null' then
      v_prod := menu_uuid(v_el.v->'productId');
      if v_prod is null or not exists (select 1 from menu_products where id = v_prod) then
        raise exception 'Add-on item not found — refresh and try again';
      end if;
    end if;
    -- an option keeps its add-on variant key while it keeps its add-on item
    if v_oid is not null then
      select o.feedme_variant_key into v_key from modifier_options o
       where o.id = v_oid and o.product_id is not distinct from v_prod;
      v_key := coalesce(v_key, '');
    end if;
    v_avail := v_el.v->>'availability';
    if v_avail is null or v_avail not in ('all', 'counter_only', 'hidden') then
      raise exception 'Invalid availability';
    end if;
    begin
      insert into pg_temp._mg_opt(ref, id, name, price_sen, product_id, variant_key, is_default, availability, sort_order)
      values (v_el.v->>'ref', v_oid, v_oname, v_price, v_prod, v_key, (v_el.v->>'isDefault')::boolean, v_avail, v_el.ord - 1);
    exception when unique_violation then
      raise exception 'Invalid add-on group';                  -- a ref or an option id twice
    end;
  end loop;
  if not v_new and exists (select 1 from modifier_options o where o.group_id = v_id
                             and not exists (select 1 from pg_temp._mg_opt t where t.id = o.id)) then
    raise exception 'The add-on group changed since you opened it — refresh and try again';
  end if;
  select mp.name into v_text
    from pg_temp._mg_opt t join menu_products mp on mp.id = t.product_id
   group by mp.name, t.product_id, t.variant_key having count(*) > 1
   order by mp.name limit 1;
  if v_text is not null then raise exception 'Two options use the same add-on item: %', v_text; end if;
  select t.name into v_text from pg_temp._mg_opt t where t.is_default and t.availability = 'hidden'
   order by t.sort_order limit 1;
  if v_text is not null then raise exception 'A switched-off option cannot be the default: %', v_text; end if;
  if (select count(*) from pg_temp._mg_opt where is_default) > v_max then
    raise exception 'At most % % the default', v_max, case when v_max = 1 then 'option can be' else 'options can be' end;
  end if;
  select count(*) into v_on from pg_temp._mg_opt where availability <> 'hidden';
  if (p->>'isActive')::boolean and v_min > v_on then
    raise exception 'Min is % but only % % on', v_min, v_on, case when v_on = 1 then 'option is' else 'options are' end;
  end if;

  -- ── catalog overrides ──
  drop table if exists pg_temp._mg_price;
  create temp table pg_temp._mg_price (
    catalog_id uuid not null, ref text not null, price_sen integer not null, primary key (catalog_id, ref)
  ) on commit drop;
  for v_el in select e.v from jsonb_array_elements(p->'catalogPrices') as e(v) loop
    if jsonb_typeof(v_el.v) <> 'object'
       or not exists (select 1 from pg_temp._mg_opt t where t.ref = v_el.v->>'ref') then
      raise exception 'Invalid add-on group';
    end if;
    v_catalog := menu_uuid(v_el.v->'catalogId');
    select name into v_cname from menu_catalogs where id = v_catalog;
    if v_cname is null then raise exception 'Catalog not found — refresh and try again'; end if;
    v_price := menu_sen(v_el.v->'priceDeltaSen');
    if v_price is null then
      raise exception '%: invalid price for %', v_cname, (select t.name from pg_temp._mg_opt t where t.ref = v_el.v->>'ref');
    end if;
    begin
      insert into pg_temp._mg_price(catalog_id, ref, price_sen) values (v_catalog, v_el.v->>'ref', v_price);
    exception when unique_violation then
      raise exception 'Invalid add-on group';                  -- an option priced twice in one catalog
    end;
  end loop;

  -- ── write: the group ──
  if v_new then
    insert into modifier_groups(name, min_select, max_select, stackable, is_active, sort_order)
    values (v_name, v_min, v_max, (p->>'stackable')::boolean, (p->>'isActive')::boolean,
            coalesce((select max(sort_order) + 1 from modifier_groups), 0))
    returning id into v_id;
  else
    update modifier_groups
       set name = v_name, min_select = v_min, max_select = v_max,
           stackable = (p->>'stackable')::boolean, is_active = (p->>'isActive')::boolean
     where id = v_id;
  end if;

  -- ── write: options ──
  begin
    update modifier_options o
       set name = t.name, price_delta_sen = t.price_sen, product_id = t.product_id, feedme_variant_key = t.variant_key,
           is_default = t.is_default, availability = t.availability, sort_order = t.sort_order
      from pg_temp._mg_opt t
     where t.id is not null and o.id = t.id;
    for v_el in select t.ref, t.name, t.price_sen, t.product_id, t.variant_key, t.is_default, t.availability, t.sort_order
                  from pg_temp._mg_opt t where t.id is null order by t.sort_order loop
      insert into modifier_options(group_id, product_id, feedme_variant_key, name, price_delta_sen, is_default, availability, sort_order)
      values (v_id, v_el.product_id, v_el.variant_key, v_el.name, v_el.price_sen, v_el.is_default, v_el.availability, v_el.sort_order)
      returning id into v_oid;
      update pg_temp._mg_opt set id = v_oid where ref = v_el.ref;
    end loop;
  exception when unique_violation then
    raise exception 'Two options use the same add-on item — change one and save again';
  end;

  -- ── write: catalog overrides (the listed ones are the whole set) ──
  delete from catalog_option_prices cop
   where cop.option_id in (select o.id from modifier_options o where o.group_id = v_id)
     and not exists (select 1 from pg_temp._mg_price x join pg_temp._mg_opt t on t.ref = x.ref
                      where x.catalog_id = cop.catalog_id and t.id = cop.option_id);
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen)
  select x.catalog_id, t.id, x.price_sen
    from pg_temp._mg_price x join pg_temp._mg_opt t on t.ref = x.ref
  on conflict (catalog_id, option_id) do update set price_delta_sen = excluded.price_delta_sen;
  return v_id;
end $$;
revoke all on function menu_save_group(jsonb) from public, anon;
grant execute on function menu_save_group(jsonb) to authenticated;

-- ── Catalogs ───────────────────────────────────────────────────────────────
-- Create (p_id null) or rename. The Feedme name a catalog was imported under is
-- kept, so a re-import still finds it (and leaves the new name alone).
create or replace function menu_save_catalog(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_id   uuid;
begin
  perform menu_require_editor();
  v_name := menu_clean_name(p_name, 'Catalog', 60);
  if exists (select 1 from menu_catalogs where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A catalog called % already exists', v_name;
  end if;
  if p_id is null then
    insert into menu_catalogs(name, sort_order)
    values (v_name, coalesce((select max(sort_order) + 1 from menu_catalogs), 0))
    returning id into v_id;
  else
    update menu_catalogs set name = v_name where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Catalog not found — refresh and try again'; end if;
  end if;
  return v_id;
end $$;
revoke all on function menu_save_catalog(uuid, text) from public, anon;
grant execute on function menu_save_catalog(uuid, text) to authenticated;

-- A new active catalog with the source's products (hidden ones too), variant prices
-- and add-on price overrides. Not linked to Feedme, not assigned to any branch.
create or replace function menu_duplicate_catalog(p_source_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  perform menu_require_editor();
  if not exists (select 1 from menu_catalogs where id = p_source_id) then
    raise exception 'Catalog not found — refresh and try again';
  end if;
  v_id := menu_save_catalog(null, p_name);
  insert into catalog_products(catalog_id, product_id, availability, sort_order)
  select v_id, cp.product_id, cp.availability, cp.sort_order from catalog_products cp where cp.catalog_id = p_source_id;
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen)
  select v_id, cvp.variant_id, cvp.price_sen from catalog_variant_prices cvp where cvp.catalog_id = p_source_id;
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen)
  select v_id, cop.option_id, cop.price_delta_sen from catalog_option_prices cop where cop.catalog_id = p_source_id;
  return v_id;
end $$;
revoke all on function menu_duplicate_catalog(uuid, text) from public, anon;
grant execute on function menu_duplicate_catalog(uuid, text) to authenticated;

-- The new order of every catalog (each id exactly once).
create or replace function menu_reorder_catalogs(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_ids is null
     or cardinality(p_ids) <> (select count(distinct u) from unnest(p_ids) u)
     or cardinality(p_ids) <> (select count(*) from menu_catalogs)
     or exists (select 1 from unnest(p_ids) u where not exists (select 1 from menu_catalogs m where m.id = u)) then
    raise exception 'The catalog list changed — refresh and try again';
  end if;
  update menu_catalogs m set sort_order = x.ord - 1
    from unnest(p_ids) with ordinality as x(id, ord)
   where m.id = x.id;
end $$;
revoke all on function menu_reorder_catalogs(uuid[]) from public, anon;
grant execute on function menu_reorder_catalogs(uuid[]) to authenticated;

-- Switch a catalog off or on. A catalog that an active branch uses for dine-in,
-- takeaway or QR cannot be switched off (that branch could not take those orders).
create or replace function menu_set_catalog_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_use  text;
begin
  perform menu_require_editor();
  if p_active is null then raise exception 'Invalid catalog'; end if;
  select name into v_name from menu_catalogs where id = p_id;
  if v_name is null then raise exception 'Catalog not found — refresh and try again'; end if;
  if not p_active then
    select format('%s is the %s catalog of %s — choose another in POS settings first', v_name,
                  case bc.role when 'dine_in' then 'dine-in' when 'takeaway' then 'takeaway' else 'QR' end, b.name)
      into v_use
      from branch_catalogs bc join branches b on b.id = bc.branch_id and coalesce(b.is_active, true)
     where bc.catalog_id = p_id and bc.role <> 'additional'
     order by b.name, bc.role
     limit 1;
    if v_use is not null then raise exception '%', v_use; end if;
  end if;
  update menu_catalogs set is_active = p_active where id = p_id;
end $$;
revoke all on function menu_set_catalog_active(uuid, boolean) from public, anon;
grant execute on function menu_set_catalog_active(uuid, boolean) to authenticated;

-- The catalog page: every active product that is not an add-on item, in category
-- order, with its availability in this catalog and each variant's default and
-- catalog price (null = no price in this catalog).
create or replace function menu_catalog_grid(p_catalog_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_cat menu_catalogs;
begin
  perform menu_require_editor();
  select * into v_cat from menu_catalogs where id = p_catalog_id;
  if not found then raise exception 'Catalog not found'; end if;
  return jsonb_build_object(
    'catalog', jsonb_build_object('id', v_cat.id, 'name', v_cat.name, 'isActive', v_cat.is_active),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name,
               'category', coalesce(c.name, 'Uncategorised'), 'categorySort', coalesce(c.sort_order, 9999),
               'availability', coalesce(cp.availability, 'hidden'),
               'variants', coalesce((select jsonb_agg(jsonb_build_object(
                                              'id', v.id, 'name', v.name, 'isActive', v.is_active,
                                              'defaultSen', v.price_sen, 'priceSen', cvp.price_sen)
                                            order by v.sort_order, v.name)
                                       from menu_variants v
                                       left join catalog_variant_prices cvp on cvp.catalog_id = p_catalog_id and cvp.variant_id = v.id
                                      where v.product_id = p.id), '[]'::jsonb))
             order by coalesce(c.sort_order, 9999), coalesce(c.name, 'Uncategorised'), coalesce(cp.sort_order, p.sort_order), p.name)
        from menu_products p
        left join menu_categories c on c.id = p.category_id
        left join catalog_products cp on cp.catalog_id = p_catalog_id and cp.product_id = p.id
       where p.is_active and not p.is_addon), '[]'::jsonb));
end $$;
revoke all on function menu_catalog_grid(uuid) from public, anon;
grant execute on function menu_catalog_grid(uuid) to authenticated;

-- One row of the catalog page: p = { catalogId, productId, availability,
-- prices: [{ variantId, priceSen }] }. Same rule as the product editor.
create or replace function menu_save_catalog_row(p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_catalog uuid;
  v_product uuid;
  v_avail   text;
  v_cname   text;
  v_el      record;
  v_vid     uuid;
  v_vname   text;
  v_price   integer;
begin
  perform menu_require_editor();
  if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'prices') is distinct from 'array' then
    raise exception 'Invalid catalog row';
  end if;
  v_catalog := menu_uuid(p->'catalogId');
  select name into v_cname from menu_catalogs where id = v_catalog;
  if v_cname is null then raise exception 'Catalog not found — refresh and try again'; end if;
  v_product := menu_uuid(p->'productId');
  if v_product is null or not exists (select 1 from menu_products where id = v_product and is_active) then
    raise exception 'Product not found — refresh and try again';
  end if;
  v_avail := p->>'availability';
  if v_avail is null or v_avail not in ('all', 'counter_only', 'hidden') then
    raise exception 'Invalid availability';
  end if;
  if (select count(*) from jsonb_array_elements(p->'prices'))
     <> (select count(distinct x->>'variantId') from jsonb_array_elements(p->'prices') x) then
    raise exception 'Invalid catalog row';
  end if;
  for v_el in select e.v from jsonb_array_elements(p->'prices') as e(v) loop
    v_vid := menu_uuid(v_el.v->'variantId');
    select name into v_vname from menu_variants where id = v_vid and product_id = v_product;
    if v_vname is null then raise exception 'Variant not found — refresh and try again'; end if;
    v_price := menu_sen(v_el.v->'priceSen');
    if v_price is null then raise exception '%: invalid price for %', v_cname, v_vname; end if;
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_vid, v_price)
    on conflict (catalog_id, variant_id) do update set price_sen = excluded.price_sen;
  end loop;
  update catalog_products set availability = v_avail where catalog_id = v_catalog and product_id = v_product;
  if not found and v_avail <> 'hidden' then
    insert into catalog_products(catalog_id, product_id, availability, sort_order)
    values (v_catalog, v_product, v_avail,
            coalesce((select max(x.sort_order) + 1 from catalog_products x where x.catalog_id = v_catalog), 0));
  end if;
  perform menu_check_catalog_prices(v_product);
end $$;
revoke all on function menu_save_catalog_row(jsonb) from public, anon;
grant execute on function menu_save_catalog_row(jsonb) to authenticated;

-- ── Categories ─────────────────────────────────────────────────────────────
-- Create (p_id null) or rename. (A re-import matches categories by name: it brings
-- a renamed Feedme category back under its old name.)
create or replace function menu_save_category(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name text;
  v_id   uuid;
begin
  perform menu_require_editor();
  v_name := menu_clean_name(p_name, 'Category', 60);
  if exists (select 1 from menu_categories where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A category called % already exists', v_name;
  end if;
  if p_id is null then
    insert into menu_categories(name, sort_order)
    values (v_name, coalesce((select max(sort_order) + 1 from menu_categories), 0))
    returning id into v_id;
  else
    update menu_categories set name = v_name where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Category not found — refresh and try again'; end if;
  end if;
  return v_id;
end $$;
revoke all on function menu_save_category(uuid, text) from public, anon;
grant execute on function menu_save_category(uuid, text) to authenticated;

create or replace function menu_reorder_categories(p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_ids is null
     or cardinality(p_ids) <> (select count(distinct u) from unnest(p_ids) u)
     or cardinality(p_ids) <> (select count(*) from menu_categories)
     or exists (select 1 from unnest(p_ids) u where not exists (select 1 from menu_categories c where c.id = u)) then
    raise exception 'The category list changed — refresh and try again';
  end if;
  update menu_categories c set sort_order = x.ord - 1
    from unnest(p_ids) with ordinality as x(id, ord)
   where c.id = x.id;
end $$;
revoke all on function menu_reorder_categories(uuid[]) from public, anon;
grant execute on function menu_reorder_categories(uuid[]) to authenticated;

-- A switched-off category takes its products off the counter (pos_menu_rows) and
-- the QR page (qr_menu); they stay in their catalogs and come back when it is on.
create or replace function menu_set_category_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  if p_active is null then raise exception 'Invalid category'; end if;
  update menu_categories set is_active = p_active where id = p_id;
  if not found then raise exception 'Category not found — refresh and try again'; end if;
end $$;
revoke all on function menu_set_category_active(uuid, boolean) from public, anon;
grant execute on function menu_set_category_active(uuid, boolean) to authenticated;

-- ── The order pad's menu in one read ───────────────────────────────────────
-- The rows buildPosMenu (src/features/pos/order/cart.ts) takes, for one catalog,
-- as one JSON value (PostgREST's 1000-row cap cut the flat reads short past 1000
-- links or prices). Products of switched-off categories are left out, as on QR.
-- Live staff with a branch only (pos_my_branch); sold-out is the caller's branch.
create or replace function pos_menu_rows(p_catalog_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'description', p.description, 'is_addon', p.is_addon,
               'is_active', p.is_active, 'sort_order', p.sort_order,
               'category', case when c.id is null then null
                                else jsonb_build_object('name', c.name, 'sort_order', c.sort_order) end,
               'menu_variants', coalesce((select jsonb_agg(jsonb_build_object(
                                                  'id', v.id, 'name', v.name, 'is_active', v.is_active,
                                                  'sort_order', v.sort_order, 'feedme_variant_key', v.feedme_variant_key))
                                           from menu_variants v where v.product_id = p.id), '[]'::jsonb)))
        from catalog_products cp
        join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
        left join menu_categories c on c.id = p.category_id
       where cp.catalog_id = p_catalog_id and cp.availability <> 'hidden'
         and (c.id is null or c.is_active)), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'name', g.name, 'min_select', g.min_select, 'max_select', g.max_select,
               'is_active', g.is_active, 'sort_order', g.sort_order,
               'modifier_options', coalesce((select jsonb_agg(jsonb_build_object(
                                                     'id', o.id, 'name', o.name, 'price_delta_sen', o.price_delta_sen,
                                                     'is_default', o.is_default, 'availability', o.availability,
                                                     'sort_order', o.sort_order, 'product_id', o.product_id))
                                              from modifier_options o where o.group_id = g.id), '[]'::jsonb)))
        from modifier_groups g where g.is_active), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', pmg.product_id, 'group_id', pmg.group_id, 'sort_order', pmg.sort_order))
        from product_modifier_groups pmg
       where exists (select 1 from catalog_products cp
                      where cp.catalog_id = p_catalog_id and cp.product_id = pmg.product_id and cp.availability <> 'hidden')), '[]'::jsonb),
    'soldOut', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', s.product_id, 'is_sold_out', s.is_sold_out))
        from branch_menu_status s where s.branch_id = v_branch and s.is_sold_out), '[]'::jsonb),
    'catalog', jsonb_build_object(
      'products', coalesce((
        select jsonb_agg(jsonb_build_object('product_id', cp.product_id, 'availability', cp.availability, 'sort_order', cp.sort_order))
          from catalog_products cp where cp.catalog_id = p_catalog_id and cp.availability <> 'hidden'), '[]'::jsonb),
      'prices', coalesce((
        select jsonb_agg(jsonb_build_object('variant_id', cvp.variant_id, 'price_sen', cvp.price_sen))
          from catalog_variant_prices cvp where cvp.catalog_id = p_catalog_id), '[]'::jsonb),
      'optionPrices', coalesce((
        select jsonb_agg(jsonb_build_object('option_id', cop.option_id, 'price_delta_sen', cop.price_delta_sen))
          from catalog_option_prices cop where cop.catalog_id = p_catalog_id), '[]'::jsonb)));
end $$;
revoke all on function pos_menu_rows(uuid) from public, anon;
grant execute on function pos_menu_rows(uuid) to authenticated;

select 'menu editor functions applied' as result;
```

- [ ] **Step 4: Run the scan.** Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` — Expected: PASS, 18 tests (the file's 16 plus the new file's own row and the new test). If a statement is listed, add its WHERE — never silence the scan. Run: `grep -c "set search_path = public, pg_temp" supabase/migration-2026-10-24-pos-menu-editor-fn.sql` — Expected: `22` (every function). Run: `npx vitest run` — Expected: 85 files, 734 tests pass. Run: `npx tsc -b` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-10-24-pos-menu-editor-fn.sql src/features/pos/sqlSafeUpdate.test.ts
git commit -m "feat(pos-menu): M2 editor functions — save product, group, catalog row, catalogs and categories; the pad's menu in one call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Verify script — and applying the editor functions on craft-os-dev (implementer + controller)

**Files:**
- Create: `supabase/migration-2026-10-24-pos-menu-editor-verify.sql`

**Interfaces:**
- Consumes: Task 1; the dev test login `76cbcf9f-905e-450d-9f5e-1c9e72a9373d` (owner).
- Produces: on dev, the M2 functions applied and five verify scripts printing `VERIFY OK` (menu, ordering, checkout, catalogs, menu editor).

The script covers spec §9's M2 items and every refusal of Task 1, each paired with the success it guards: grants, internal helpers and `search_path` (A); `menu_save_product` — every refusal, none of which leaves anything behind, a two-variant product in three catalogs with its keys, order and prices, the detail read, the base key and the re-key, a catalog not in the payload (C); **an order placed after an edit gets the new price while an earlier order keeps its snapshot**, Dine vs Grab prices of the new product, a switched-off variant (D); `menu_save_group` — every refusal, the Grab-only override charged in Grab only, an option switched off (row kept, refused by ordering, gone from QR, `hidden` in the pad's rows, the old order's snapshot intact), an override removed (E); catalogs — create / rename / duplicate (with hidden rows and overrides, unassigned) / reorder / switch off refused for a branch default / an additional one switched off stops selling / the catalog page read / one row saved (F); categories — create / rename / reorder reaching the pad's rows / switch off hiding the product on the pad and QR (G); `pos_menu_rows` for a cashier, as `authenticated` (H); the list reads, including the category count without add-on items (I); a save that leaves out details and catalogs keeps what the Products and catalog pages changed meanwhile, the base key for a new product's one active variant, and a re-import leaving a catalog made here with one unpriced product that `unpricedCount` reports (J); **Edit menu on every editor function: manager refused, owner allowed, resigned owner refused**, plus the Owner's override (K). A temporary `pg_temp.expect_error(sql, message, label)` keeps each refusal to one line; it disappears with the rollback.

- [ ] **Step 1: Write the verify script** `supabase/migration-2026-10-24-pos-menu-editor-verify.sql`:

```sql
-- Self-check for the POS menu editor (M2). Run on craft-os-dev after
-- migration-2026-10-24-pos-menu-editor-fn.sql. Everything is rolled back.
-- Success = a result row "VERIFY OK". Every refusal is paired with the success it
-- guards; the manage_menu checks call each function as `authenticated` (grants too).
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
-- A temporary function: it disappears with the rollback below.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm <> p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

do $$
declare
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr     uuid := 'dddddddd-0000-0000-0000-000000000001';   -- manager of VERIFY M2: no manage_menu
  v_cashier uuid := 'dddddddd-0000-0000-0000-000000000002';   -- staff of VERIFY M2
  v_boss    uuid := 'dddddddd-0000-0000-0000-000000000003';   -- a second owner, resigned in K
  v_branch uuid; v_t1 dining_tables;
  v_drinks uuid; v_food uuid; v_newcat uuid;
  c_dine uuid; c_take uuid; c_qr uuid; c_grab uuid; c_new uuid; c_copy uuid;
  v_oat uuid; v_syrup uuid;
  v_milk uuid; v_opt_oat uuid; v_opt_soy uuid; v_other_group uuid; v_other_opt uuid;
  v_latte uuid; v_hot uuid; v_cold uuid; v_toast uuid; v_reg uuid; v_large uuid;
  v_order uuid; v_order2 uuid; v_old_order uuid;
  v_p jsonb; v_p2 jsonb; v_g jsonb; v_res jsonb; v_text text; v_id uuid; n integer; r record;
  v_ids uuid[];
  v_bun uuid; v_bun_reg uuid;
begin
  -- ── A. grants, internal helpers, search_path ──────────────────────────────
  for r in select f from unnest(array[
             'menu_editor_lookups()', 'menu_product_list()', 'menu_product_detail(uuid)', 'menu_save_product(jsonb)',
             'menu_group_detail(uuid)', 'menu_save_group(jsonb)', 'menu_save_catalog(uuid,text)',
             'menu_duplicate_catalog(uuid,text)', 'menu_reorder_catalogs(uuid[])', 'menu_set_catalog_active(uuid,boolean)',
             'menu_catalog_grid(uuid)', 'menu_save_catalog_row(jsonb)', 'menu_save_category(uuid,text)',
             'menu_reorder_categories(uuid[])', 'menu_set_category_active(uuid,boolean)', 'pos_menu_rows(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array[
             'menu_require_editor()', 'menu_clean_name(text,text,integer)', 'menu_sen(jsonb)', 'menu_uuid(jsonb)',
             'menu_new_variant_key()', 'menu_check_catalog_prices(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'menu_require_editor','menu_clean_name','menu_sen','menu_uuid','menu_new_variant_key','menu_check_catalog_prices',
              'menu_editor_lookups','menu_product_list','menu_product_detail','menu_save_product','menu_group_detail',
              'menu_save_group','menu_save_catalog','menu_duplicate_catalog','menu_reorder_catalogs','menu_set_catalog_active',
              'menu_catalog_grid','menu_save_catalog_row','menu_save_category','menu_reorder_categories',
              'menu_set_category_active','pos_menu_rows'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  -- M2 adds no policy: menu writes still go through RPCs only (the menu verify's A2 stays true)
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('menu_categories','menu_products','menu_variants','modifier_groups','modifier_options',
                                'product_modifier_groups')
              and cmd in ('INSERT','DELETE','ALL')) then
    raise exception 'FAIL rls: a master menu table can be inserted into or deleted from directly';
  end if;

  -- ── B. fixture: a branch with four catalogs, two add-on items, staff ──────
  update system_role_permissions set permissions = permissions - 'manage_menu';   -- code defaults for this run
  insert into branches(name, address) values ('VERIFY M2', 'verify') returning id into v_branch;
  insert into dining_tables(branch_id, label) values (v_branch, 'M2') returning * into v_t1;
  insert into menu_categories(name, sort_order) values ('VERIFY M2 DRINKS', 900) returning id into v_drinks;
  insert into menu_categories(name, sort_order) values ('VERIFY M2 FOOD', 901) returning id into v_food;
  insert into menu_products(name, category_id, is_addon) values ('Verify M2 Oat milk', v_drinks, true) returning id into v_oat;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_oat, '', 'Regular', 200);
  insert into menu_products(name, category_id, is_addon) values ('Verify M2 Syrup', v_drinks, true) returning id into v_syrup;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_syrup, '', 'Regular', 100);
  insert into modifier_groups(name, min_select, max_select) values ('Verify M2 Other', 0, 1) returning id into v_other_group;
  insert into modifier_options(group_id, name, price_delta_sen) values (v_other_group, 'Other', 0) returning id into v_other_opt;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M2 Dine', 900) returning id into c_dine;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M2 Take', 901) returning id into c_take;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M2 QR', 902) returning id into c_qr;
  insert into menu_catalogs(name, sort_order, feedme_catalog_name) values ('VERIFY M2 Grab', 903, 'VERIFY M2 Feedme Grab')
    returning id into c_grab;
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', c_dine), (v_branch, 'takeaway', c_take), (v_branch, 'qr', c_qr), (v_branch, 'additional', c_grab);
  -- staff are inserted as 'staff' and promoted by the owner (the staff guard refuses anything else)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into auth.users (id) values (v_mgr), (v_cashier), (v_boss);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,     'Verify M2 Manager', 'trainee', true, current_date, 'staff', v_branch),
    (v_cashier, 'Verify M2 Cashier', 'trainee', true, current_date, 'staff', v_branch),
    (v_boss,    'Verify M2 Boss',    'trainee', true, current_date, 'staff', v_branch);
  update staff set system_role = 'manager' where id = v_mgr;
  update staff set system_role = 'owner' where id = v_boss;
  update staff set branch_id = v_branch where id = v_owner;
  if not staff_has_cap(v_owner, 'manage_menu') then raise exception 'FAIL fixture: the test login (owner) lacks manage_menu'; end if;

  -- ── C. menu_save_product: a new product with two variants in three catalogs ─
  v_p := jsonb_build_object(
    'id', null, 'name', '  Verify   M2 Latte ', 'internalName', ' latte ', 'description', null,
    'categoryId', v_drinks, 'sstRateBp', 600, 'printRoute', 'Bar', 'takeawayFeeSen', 50, 'isActive', true, 'isAddon', false,
    'variants', jsonb_build_array(
      jsonb_build_object('ref', 'h', 'id', null, 'name', 'Hot', 'priceSen', 1200, 'isActive', true),
      jsonb_build_object('ref', 'c', 'id', null, 'name', 'Cold', 'priceSen', 1300, 'isActive', true)),
    'groupIds', '[]'::jsonb,
    'catalogs', jsonb_build_array(
      jsonb_build_object('catalogId', c_dine, 'availability', 'all', 'prices', jsonb_build_array(
        jsonb_build_object('ref', 'h', 'priceSen', 1210), jsonb_build_object('ref', 'c', 'priceSen', 1310))),
      jsonb_build_object('catalogId', c_grab, 'availability', 'counter_only', 'prices', jsonb_build_array(
        jsonb_build_object('ref', 'h', 'priceSen', 1700), jsonb_build_object('ref', 'c', 'priceSen', 1800))),
      jsonb_build_object('catalogId', c_qr, 'availability', 'all', 'prices', jsonb_build_array(
        jsonb_build_object('ref', 'h', 'priceSen', 1500), jsonb_build_object('ref', 'c', 'priceSen', 1600))),
      jsonb_build_object('catalogId', c_take, 'availability', 'hidden', 'prices', '[]'::jsonb)));
  -- C1. every refusal leaves nothing behind, and says why in the editor's words
  select count(*) into n from menu_products;
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', '[]'), 'Invalid product', 'C1 not an object');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{name}', '"   "')),
    'Product name is required', 'C1 blank name');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{name}', to_jsonb(repeat('x', 121)))),
    'Product name is too long (at most 120 characters)', 'C1 long name');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{categoryId}', 'null')),
    'Choose a category', 'C1 no category');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{categoryId}', to_jsonb(gen_random_uuid()))),
    'Choose a category', 'C1 unknown category');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{sstRateBp}', '10001')),
    'Invalid SST rate', 'C1 SST');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{isActive}', '"yes"')),
    'Invalid product', 'C1 on/off not a boolean');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{takeawayFeeSen}', '-1')),
    'Invalid takeaway fee', 'C1 takeaway fee');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)',
      jsonb_set(jsonb_set(v_p, '{variants,0,isActive}', 'false'), '{variants,1,isActive}', 'false')),
    'A product needs at least one active variant', 'C1 no active variant');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants}', '[]')),
    'A product needs at least one active variant', 'C1 no variant');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,1,name}', '" hot"')),
    'Two variants are called Hot', 'C1 twin variants');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,name}', '""')),
    'Variant name is required', 'C1 blank variant');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,priceSen}', '12.5')),
    'Invalid default price for Hot', 'C1 fractional sen');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,priceSen}', '-100')),
    'Invalid default price for Hot', 'C1 negative price');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,priceSen}', '"12"')),
    'Invalid default price for Hot', 'C1 price as text');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,1,ref}', '"h"')),
    'Invalid product', 'C1 ref twice');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,id}', to_jsonb(v_other_opt))),
    'Variant not found — refresh and try again', 'C1 variant id on a new product');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)',
      jsonb_set(v_p, '{catalogs,0,prices}', '[{"ref": "h", "priceSen": 1210}]')),
    'VERIFY M2 Dine: enter a price for Cold', 'C1 missing catalog price');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,prices,0,priceSen}', '-5')),
    'VERIFY M2 Dine: invalid price for Hot', 'C1 negative catalog price');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,prices,1,ref}', '"h"')),
    'Invalid product', 'C1 a variant priced twice');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,prices,1,ref}', '"zz"')),
    'Invalid product', 'C1 a price for no variant');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,catalogId}', to_jsonb(gen_random_uuid()))),
    'Catalog not found — refresh and try again', 'C1 unknown catalog');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,1,catalogId}', to_jsonb(c_dine))),
    'Invalid product', 'C1 a catalog twice');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,availability}', '"sometimes"')),
    'Invalid availability', 'C1 availability');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{groupIds}', jsonb_build_array(gen_random_uuid()))),
    'Add-on group not found — refresh and try again', 'C1 unknown group');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{groupIds}', jsonb_build_array(v_other_group, v_other_group))),
    'An add-on group is linked twice', 'C1 group twice');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{id}', to_jsonb(gen_random_uuid()))),
    'Product not found — refresh and try again', 'C1 unknown product');
  if (select count(*) from menu_products) <> n then raise exception 'FAIL C1: a refused save left a product behind'; end if;

  -- C2. the save: one product, two keyed variants in order, three catalogs (the hidden one gets no row)
  v_latte := menu_save_product(v_p);
  if (select name || '|' || internal_name || '|' || print_route || '|' || takeaway_fee_sen || '|' || sst_rate_bp
        from menu_products where id = v_latte) is distinct from 'Verify M2 Latte|latte|Bar|50|600' then
    raise exception 'FAIL C2: the product was not saved as given (names are trimmed)';
  end if;
  select id into v_hot from menu_variants where product_id = v_latte and name = 'Hot';
  select id into v_cold from menu_variants where product_id = v_latte and name = 'Cold';
  if (select string_agg(name || ':' || price_sen || ':' || sort_order, ',' order by sort_order) from menu_variants where product_id = v_latte)
     is distinct from 'Hot:1200:0,Cold:1300:1' then
    raise exception 'FAIL C2: variants not saved in order with their default prices';
  end if;
  if exists (select 1 from menu_variants where product_id = v_latte and feedme_variant_key not like 'cos-%')
     or (select count(distinct feedme_variant_key) from menu_variants where product_id = v_latte) <> 2 then
    raise exception 'FAIL C2: a product sold in two variants must key both cos-… (tickets name each)';
  end if;
  if (select string_agg(m.name || '=' || cp.availability, ',' order by m.sort_order)
        from catalog_products cp join menu_catalogs m on m.id = cp.catalog_id where cp.product_id = v_latte)
     is distinct from 'VERIFY M2 Dine=all,VERIFY M2 QR=all,VERIFY M2 Grab=counter_only' then
    raise exception 'FAIL C2: catalog rows %', (select string_agg(catalog_id::text, ',') from catalog_products where product_id = v_latte);
  end if;
  if (select price_sen from catalog_variant_prices where catalog_id = c_dine and variant_id = v_hot) <> 1210
     or (select price_sen from catalog_variant_prices where catalog_id = c_grab and variant_id = v_cold) <> 1800 then
    raise exception 'FAIL C2: catalog prices not saved';
  end if;
  -- C3. the editor reads it back: every catalog listed, hidden where it does not sell it
  v_res := menu_product_detail(v_latte);
  if jsonb_array_length(v_res->'catalogs') <> (select count(*) from menu_catalogs)
     or (select c->>'availability' from jsonb_array_elements(v_res->'catalogs') c where c->>'catalogId' = c_take::text) <> 'hidden'
     or (select (c->'prices'->>v_hot::text)::int from jsonb_array_elements(v_res->'catalogs') c where c->>'catalogId' = c_dine::text) <> 1210
     or v_res->'variants'->0->>'name' <> 'Hot' or v_res->>'categoryId' <> v_drinks::text then
    raise exception 'FAIL C3: menu_product_detail %', v_res;
  end if;
  perform pg_temp.expect_error(format('select menu_product_detail(%L)', gen_random_uuid()), 'Product not found', 'C3 unknown product');

  -- C4. one variant → the base ('') key; a second one later → both keyed, the base too
  v_toast := menu_save_product(jsonb_build_object(
    'id', null, 'name', 'Verify M2 Toast', 'categoryId', v_food, 'sstRateBp', 0, 'printRoute', null, 'takeawayFeeSen', 0,
    'isActive', true, 'isAddon', false, 'groupIds', '[]'::jsonb,
    'variants', jsonb_build_array(jsonb_build_object('ref', 'r', 'name', 'Regular', 'priceSen', 800, 'isActive', true)),
    'catalogs', jsonb_build_array(jsonb_build_object('catalogId', c_dine, 'availability', 'all',
                                                     'prices', '[{"ref": "r", "priceSen": 810}]'::jsonb))));
  select id into v_reg from menu_variants where product_id = v_toast;
  if (select feedme_variant_key from menu_variants where id = v_reg) <> '' then
    raise exception 'FAIL C4: a new single-variant product must use the base key';
  end if;
  v_p2 := jsonb_build_object(
    'id', v_toast, 'name', 'Verify M2 Toast', 'categoryId', v_food, 'sstRateBp', 0, 'printRoute', null, 'takeawayFeeSen', 0,
    'isActive', true, 'isAddon', false, 'groupIds', '[]'::jsonb,
    'variants', jsonb_build_array(
      jsonb_build_object('ref', v_reg, 'id', v_reg, 'name', 'Regular', 'priceSen', 800, 'isActive', true),
      jsonb_build_object('ref', 'l', 'id', null, 'name', 'Large', 'priceSen', 1000, 'isActive', true)),
    'catalogs', '[]'::jsonb);
  -- a catalog left out of the payload still needs the new variant's price (it already sells the toast)
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', v_p2),
    'VERIFY M2 Dine: enter a price for Large', 'C4 a catalog not in the payload');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p2, '{variants}', v_p2->'variants'->1 || '[]'::jsonb)),
    'The product changed since you opened it — refresh and try again', 'C4 a variant left out');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p2, '{variants,1,id}', to_jsonb(v_hot))),
    'Variant not found — refresh and try again', 'C4 another product''s variant');
  perform menu_save_product(jsonb_set(v_p2, '{catalogs}', jsonb_build_array(jsonb_build_object('catalogId', c_dine, 'availability', 'all',
    'prices', jsonb_build_array(jsonb_build_object('ref', v_reg, 'priceSen', 810), jsonb_build_object('ref', 'l', 'priceSen', 1050))))));
  select id into v_large from menu_variants where product_id = v_toast and name = 'Large';
  if exists (select 1 from menu_variants where product_id = v_toast and feedme_variant_key = '') then
    raise exception 'FAIL C4: a product with two active variants still has a base variant';
  end if;
  if (select price_sen from catalog_variant_prices where catalog_id = c_dine and variant_id = v_large) <> 1050 then
    raise exception 'FAIL C4: the new variant''s catalog price was not saved';
  end if;

  -- ── D. an edit prices the next order; orders already placed keep their snapshot ─
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_old_order := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_grab);
  if (select unit_price_sen from order_items where order_id = v_old_order) <> 1210
     or (select unit_price_sen from order_items where order_id = v_order) <> 1700
     or (select name_snapshot from order_items where order_id = v_order) <> 'Verify M2 Latte (Hot)' then
    raise exception 'FAIL D: Dine and Grab prices of the new product (1210 / 1700)';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_p := jsonb_set(jsonb_set(v_p, '{id}', to_jsonb(v_latte)), '{variants}', jsonb_build_array(
    jsonb_build_object('ref', v_hot, 'id', v_hot, 'name', 'Hot', 'priceSen', 1200, 'isActive', true),
    jsonb_build_object('ref', v_cold, 'id', v_cold, 'name', 'Cold', 'priceSen', 1300, 'isActive', true)));
  v_p := jsonb_set(v_p, '{catalogs}', jsonb_build_array(
    jsonb_build_object('catalogId', c_dine, 'availability', 'all', 'prices', jsonb_build_array(
      jsonb_build_object('ref', v_hot, 'priceSen', 1250), jsonb_build_object('ref', v_cold, 'priceSen', 1310))),
    jsonb_build_object('catalogId', c_grab, 'availability', 'counter_only', 'prices', jsonb_build_array(
      jsonb_build_object('ref', v_hot, 'priceSen', 1700), jsonb_build_object('ref', v_cold, 'priceSen', 1800))),
    jsonb_build_object('catalogId', c_qr, 'availability', 'all', 'prices', jsonb_build_array(
      jsonb_build_object('ref', v_hot, 'priceSen', 1500), jsonb_build_object('ref', v_cold, 'priceSen', 1600)))));
  perform menu_save_product(v_p);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  if (select unit_price_sen from order_items where order_id = v_order) <> 1250 then
    raise exception 'FAIL D: an order after the edit is not at the new price';
  end if;
  if (select unit_price_sen from order_items where order_id = v_old_order) <> 1210 then
    raise exception 'FAIL D: an order placed before the edit changed price';
  end if;
  -- D2. a switched-off variant stops selling; its row and catalog price stay
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_save_product(jsonb_set(v_p, '{variants,1,isActive}', 'false'));
  if not exists (select 1 from menu_variants where id = v_cold and not is_active)
     or not exists (select 1 from catalog_variant_prices where catalog_id = c_dine and variant_id = v_cold) then
    raise exception 'FAIL D2: switching a variant off must keep it and its prices';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, null, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_cold)), gen_random_uuid()),
    'Item is not available: Verify M2 Latte', 'D2 a switched-off variant');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_save_product(v_p);                                             -- Cold back on

  -- ── E. add-on groups ──────────────────────────────────────────────────────
  v_g := jsonb_build_object('id', null, 'name', ' Verify M2 Milk ', 'min', 0, 'max', 1, 'stackable', false, 'isActive', true,
    'options', jsonb_build_array(
      jsonb_build_object('ref', 'o', 'id', null, 'name', 'Oat', 'priceDeltaSen', 200, 'productId', v_oat, 'isDefault', false, 'availability', 'all'),
      jsonb_build_object('ref', 's', 'id', null, 'name', 'Soy', 'priceDeltaSen', 150, 'productId', null, 'isDefault', false, 'availability', 'all')),
    'catalogPrices', jsonb_build_array(jsonb_build_object('catalogId', c_grab, 'ref', 'o', 'priceDeltaSen', 300)));
  -- E1. refusals
  select count(*) into n from modifier_groups;
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', '"x"'), 'Invalid add-on group', 'E1 not an object');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{name}', '""')),
    'Add-on group name is required', 'E1 blank name');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(jsonb_set(v_g, '{min}', '2'), '{max}', '1')),
    'Min cannot be more than max', 'E1 min > max');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{max}', '0')),
    'Max must be a whole number from 1 to 99', 'E1 max 0');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{min}', '-1')),
    'Min must be a whole number from 0 to 99', 'E1 min -1');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(jsonb_set(v_g, '{min}', '100'), '{max}', '100')),
    'Min must be a whole number from 0 to 99', 'E1 min 100');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{min}', '0.5')),
    'Min must be a whole number from 0 to 99', 'E1 min 0.5');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(jsonb_set(v_g, '{min}', '3'), '{max}', '3')),
    'Min is 3 but only 2 options are on', 'E1 min above the options that are on');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)',
      jsonb_set(jsonb_set(jsonb_set(v_g, '{min}', '2'), '{max}', '2'), '{options,1,availability}', '"hidden"')),
    'Min is 2 but only 1 option is on', 'E1 min above the one option that is on');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)',
      jsonb_set(jsonb_set(v_g, '{options,1,availability}', '"hidden"'), '{options,1,isDefault}', 'true')),
    'A switched-off option cannot be the default: Soy', 'E1 hidden default');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)',
      jsonb_set(jsonb_set(v_g, '{options,0,isDefault}', 'true'), '{options,1,isDefault}', 'true')),
    'At most 1 option can be the default', 'E1 two defaults, max 1');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,name}', '"  "')),
    'Option name is required', 'E1 blank option');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,priceDeltaSen}', '1.5')),
    'Invalid price for Soy', 'E1 option price');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,productId}', to_jsonb(v_oat))),
    'Two options use the same add-on item: Verify M2 Oat milk', 'E1 one add-on item twice');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,productId}', to_jsonb(gen_random_uuid()))),
    'Add-on item not found — refresh and try again', 'E1 unknown add-on item');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,availability}', '"never"')),
    'Invalid availability', 'E1 availability');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,id}', to_jsonb(v_other_opt))),
    'Option not found — refresh and try again', 'E1 option id on a new group');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{catalogPrices,0,catalogId}', to_jsonb(gen_random_uuid()))),
    'Catalog not found — refresh and try again', 'E1 unknown catalog');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{catalogPrices,0,priceDeltaSen}', '-1')),
    'VERIFY M2 Grab: invalid price for Oat', 'E1 negative catalog price');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{catalogPrices,0,ref}', '"zz"')),
    'Invalid add-on group', 'E1 a price for no option');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{id}', to_jsonb(gen_random_uuid()))),
    'Add-on group not found — refresh and try again', 'E1 unknown group');
  if (select count(*) from modifier_groups) <> n then raise exception 'FAIL E1: a refused save left a group behind'; end if;
  -- E2. the save, linked to the latte, and an override that only Grab charges
  v_milk := menu_save_group(v_g);
  select id into v_opt_oat from modifier_options where group_id = v_milk and name = 'Oat';
  select id into v_opt_soy from modifier_options where group_id = v_milk and name = 'Soy';
  if (select name from modifier_groups where id = v_milk) <> 'Verify M2 Milk'
     or (select string_agg(name || ':' || sort_order, ',' order by sort_order) from modifier_options where group_id = v_milk) <> 'Oat:0,Soy:1'
     or (select price_delta_sen from catalog_option_prices where catalog_id = c_grab and option_id = v_opt_oat) <> 300 then
    raise exception 'FAIL E2: group, options or override not saved';
  end if;
  perform menu_save_product(jsonb_set(v_p, '{groupIds}', jsonb_build_array(v_milk)));
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(v_t1.id, 'dine_in', null, jsonb_build_array(jsonb_build_object(
    'productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt_oat))), gen_random_uuid(), c_grab);
  v_order2 := place_counter_order(v_t1.id, 'dine_in', null, jsonb_build_array(jsonb_build_object(
    'productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt_soy))), gen_random_uuid());
  if (select unit_price_sen from order_items where order_id = v_order) <> 2000
     or (select unit_price_sen from order_items where order_id = v_order2) <> 1400 then
    raise exception 'FAIL E2: Grab charges its Oat override (1700 + 300), Dine the default Soy (1250 + 150)';
  end if;
  -- E3. Soy switched off: the row stays, the pad and QR stop offering it, an old order still shows it
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_g := jsonb_build_object('id', v_milk, 'name', 'Verify M2 Milk', 'min', 0, 'max', 1, 'stackable', false, 'isActive', true,
    'options', jsonb_build_array(
      jsonb_build_object('ref', v_opt_oat, 'id', v_opt_oat, 'name', 'Oat', 'priceDeltaSen', 200, 'productId', v_oat, 'isDefault', false, 'availability', 'all'),
      jsonb_build_object('ref', v_opt_soy, 'id', v_opt_soy, 'name', 'Soy', 'priceDeltaSen', 150, 'productId', null, 'isDefault', false, 'availability', 'hidden')),
    'catalogPrices', jsonb_build_array(jsonb_build_object('catalogId', c_grab, 'ref', v_opt_oat, 'priceDeltaSen', 300)));
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options}', v_g->'options'->0 || '[]'::jsonb)),
    'The add-on group changed since you opened it — refresh and try again', 'E3 an option left out');
  perform menu_save_group(v_g);
  if not exists (select 1 from modifier_options where id = v_opt_soy and availability = 'hidden') then
    raise exception 'FAIL E3: switching an option off must keep it';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, null, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt_soy))),
      gen_random_uuid()),
    'Sold out: Soy', 'E3 ordering a switched-off option');
  if (select modifiers_snapshot->0->>'name' from order_items where order_id = v_order2) <> 'Soy' then
    raise exception 'FAIL E3: the old order lost its add-on snapshot';
  end if;
  if exists (select 1 from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
               cross join jsonb_array_elements(c->'products') pr cross join jsonb_array_elements(pr->'groups') g
               cross join jsonb_array_elements(g->'options') o
              where o->>'id' = v_opt_soy::text) then
    raise exception 'FAIL E3: QR still offers a switched-off option';
  end if;
  if (select o->>'availability' from jsonb_array_elements(pos_menu_rows(c_dine)->'groups') g
        cross join jsonb_array_elements(g->'modifier_options') o where o->>'id' = v_opt_soy::text) <> 'hidden' then
    raise exception 'FAIL E3: the pad''s rows must carry the option as hidden (buildPosMenu drops it)';
  end if;
  -- E4. an override no longer listed is removed: Grab charges Oat's own price again
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_save_group(jsonb_set(v_g, '{catalogPrices}', '[]'));
  if exists (select 1 from catalog_option_prices where option_id = v_opt_oat) then
    raise exception 'FAIL E4: a removed override is still there';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(v_t1.id, 'dine_in', null, jsonb_build_array(jsonb_build_object(
    'productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt_oat))), gen_random_uuid(), c_grab);
  if (select unit_price_sen from order_items where order_id = v_order) <> 1900 then
    raise exception 'FAIL E4: Grab must charge the default Oat price once its override is gone';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  -- E5. the editor reads it back
  v_res := menu_group_detail(v_milk);
  if v_res->'options'->1->>'availability' <> 'hidden' or v_res->'options'->0->>'productId' <> v_oat::text
     or not exists (select 1 from jsonb_array_elements(v_res->'usedBy') u where u->>'id' = v_latte::text) then
    raise exception 'FAIL E5: menu_group_detail %', v_res;
  end if;
  perform pg_temp.expect_error(format('select menu_group_detail(%L)', gen_random_uuid()), 'Add-on group not found', 'E5 unknown group');

  -- ── F. catalogs ───────────────────────────────────────────────────────────
  c_new := menu_save_catalog(null, ' VERIFY M2  New ');
  if (select name from menu_catalogs where id = c_new) <> 'VERIFY M2 New'
     or (select sort_order from menu_catalogs where id = c_new) <> (select max(sort_order) from menu_catalogs) then
    raise exception 'FAIL F1: a new catalog is named as typed (trimmed) and goes last';
  end if;
  perform pg_temp.expect_error(format('select menu_save_catalog(null, %L)', 'verify m2 new'),
    'A catalog called verify m2 new already exists', 'F1 duplicate name');
  perform pg_temp.expect_error(format('select menu_save_catalog(null, %L)', '  '), 'Catalog name is required', 'F1 blank');
  perform pg_temp.expect_error(format('select menu_save_catalog(null, %L)', repeat('x', 61)),
    'Catalog name is too long (at most 60 characters)', 'F1 long');
  perform menu_save_catalog(c_new, 'VERIFY M2 Renamed');
  perform menu_save_catalog(c_new, 'verify m2 renamed');                     -- its own name in other letters is fine
  perform pg_temp.expect_error(format('select menu_save_catalog(%L, %L)', gen_random_uuid(), 'VERIFY M2 Ghost'),
    'Catalog not found — refresh and try again', 'F1 rename unknown');
  -- F2. duplicate: products (hidden ones too), prices and add-on overrides; no Feedme name, no branch
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen) values (c_grab, v_opt_oat, 250);
  c_copy := menu_duplicate_catalog(c_grab, 'VERIFY M2 Grab copy');
  if (select count(*) from catalog_products where catalog_id = c_copy) <> (select count(*) from catalog_products where catalog_id = c_grab)
     or (select count(*) from catalog_variant_prices where catalog_id = c_copy) <> (select count(*) from catalog_variant_prices where catalog_id = c_grab)
     or (select price_delta_sen from catalog_option_prices where catalog_id = c_copy and option_id = v_opt_oat) <> 250
     or (select availability from catalog_products where catalog_id = c_copy and product_id = v_latte) <> 'counter_only'
     or (select feedme_catalog_name from menu_catalogs where id = c_copy) is not null
     or not (select is_active from menu_catalogs where id = c_copy)
     or exists (select 1 from branch_catalogs where catalog_id = c_copy) then
    raise exception 'FAIL F2: the duplicate is not a full, unassigned copy';
  end if;
  perform pg_temp.expect_error(format('select menu_duplicate_catalog(%L, %L)', gen_random_uuid(), 'VERIFY M2 X'),
    'Catalog not found — refresh and try again', 'F2 unknown source');
  perform pg_temp.expect_error(format('select menu_duplicate_catalog(%L, %L)', c_grab, 'VERIFY M2 Dine'),
    'A catalog called VERIFY M2 Dine already exists', 'F2 name taken');
  -- F3. reorder: every catalog exactly once
  select array_agg(id order by sort_order desc, name desc) into v_ids from menu_catalogs;
  perform menu_reorder_catalogs(v_ids);
  if exists (select 1 from unnest(v_ids) with ordinality x(id, ord) join menu_catalogs m on m.id = x.id where m.sort_order <> x.ord - 1) then
    raise exception 'FAIL F3: catalogs not in the new order';
  end if;
  perform pg_temp.expect_error(format('select menu_reorder_catalogs(%L::uuid[])', v_ids[2:]),
    'The catalog list changed — refresh and try again', 'F3 one missing');
  perform pg_temp.expect_error(format('select menu_reorder_catalogs(%L::uuid[])', v_ids[2:] || v_ids[2]),
    'The catalog list changed — refresh and try again', 'F3 one twice');
  -- F4. switching off: not a branch's default; an additional one stops selling at the counter
  perform pg_temp.expect_error(format('select menu_set_catalog_active(%L, false)', c_dine),
    'VERIFY M2 Dine is the dine-in catalog of VERIFY M2 — choose another in POS settings first', 'F4 a default');
  perform menu_set_catalog_active(c_grab, false);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select place_counter_order(null, %L, null, %L::jsonb, %L, %L)', 'takeaway',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_grab),
    'This catalog is not available at this branch', 'F4 a switched-off catalog');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_set_catalog_active(c_grab, true);
  perform pg_temp.expect_error(format('select menu_set_catalog_active(%L, true)', gen_random_uuid()),
    'Catalog not found — refresh and try again', 'F4 unknown');
  -- F5. the catalog page: every active non-add-on product, with its availability and both prices
  v_res := menu_catalog_grid(c_grab);
  if (select pr->>'availability' from jsonb_array_elements(v_res->'products') pr where pr->>'id' = v_latte::text) <> 'counter_only'
     or (select (v->>'priceSen')::int from jsonb_array_elements(v_res->'products') pr cross join jsonb_array_elements(pr->'variants') v
          where v->>'id' = v_hot::text) <> 1700
     or (select (v->>'defaultSen')::int from jsonb_array_elements(v_res->'products') pr cross join jsonb_array_elements(pr->'variants') v
          where v->>'id' = v_hot::text) <> 1200
     or (select pr->>'availability' from jsonb_array_elements(v_res->'products') pr where pr->>'id' = v_toast::text) <> 'hidden'
     or (select v->>'priceSen' from jsonb_array_elements(v_res->'products') pr cross join jsonb_array_elements(pr->'variants') v
          where v->>'id' = v_large::text) is not null
     or exists (select 1 from jsonb_array_elements(v_res->'products') pr where pr->>'id' = v_oat::text) then
    raise exception 'FAIL F5: menu_catalog_grid %', v_res;
  end if;
  -- F6. one row saved: in with a price for every active variant, out keeps the row
  v_p2 := jsonb_build_object('catalogId', c_grab, 'productId', v_toast, 'availability', 'all', 'prices', jsonb_build_array(
    jsonb_build_object('variantId', v_reg, 'priceSen', 900), jsonb_build_object('variantId', v_large, 'priceSen', 1100)));
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{prices}', v_p2->'prices'->0 || '[]'::jsonb)),
    'VERIFY M2 Grab: enter a price for Large', 'F6 a missing price');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{prices,0,priceSen}', '9.5')),
    'VERIFY M2 Grab: invalid price for Regular', 'F6 a bad price');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{prices,0,variantId}', to_jsonb(v_hot))),
    'Variant not found — refresh and try again', 'F6 another product''s variant');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{prices,1,variantId}', to_jsonb(v_reg))),
    'Invalid catalog row', 'F6 a variant twice');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{catalogId}', to_jsonb(gen_random_uuid()))),
    'Catalog not found — refresh and try again', 'F6 unknown catalog');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{productId}', to_jsonb(v_oat))),
    'Variant not found — refresh and try again', 'F6 prices of another product');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{productId}', to_jsonb(gen_random_uuid()))),
    'Product not found — refresh and try again', 'F6 unknown product');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{availability}', '"soon"')),
    'Invalid availability', 'F6 availability');
  perform menu_save_catalog_row(v_p2);
  if (select availability from catalog_products where catalog_id = c_grab and product_id = v_toast) <> 'all'
     or (select price_sen from catalog_variant_prices where catalog_id = c_grab and variant_id = v_large) <> 1100 then
    raise exception 'FAIL F6: the row was not saved';
  end if;
  perform menu_save_catalog_row(jsonb_set(jsonb_set(v_p2, '{availability}', '"hidden"'), '{prices}', '[]'));
  if (select availability from catalog_products where catalog_id = c_grab and product_id = v_toast) <> 'hidden'
     or not exists (select 1 from catalog_variant_prices where catalog_id = c_grab and variant_id = v_large) then
    raise exception 'FAIL F6: taking a product out must keep its row (hidden) and prices';
  end if;

  -- ── G. categories ─────────────────────────────────────────────────────────
  v_newcat := menu_save_category(null, 'VERIFY M2 NEW');
  if (select sort_order from menu_categories where id = v_newcat) <> (select max(sort_order) from menu_categories) then
    raise exception 'FAIL G1: a new category goes last';
  end if;
  perform pg_temp.expect_error(format('select menu_save_category(null, %L)', 'verify m2 drinks'),
    'A category called verify m2 drinks already exists', 'G1 duplicate');
  perform pg_temp.expect_error(format('select menu_save_category(null, %L)', ''), 'Category name is required', 'G1 blank');
  perform menu_save_category(v_newcat, 'VERIFY M2 RENAMED');
  perform pg_temp.expect_error(format('select menu_save_category(%L, %L)', gen_random_uuid(), 'VERIFY M2 GHOST'),
    'Category not found — refresh and try again', 'G1 rename unknown');
  -- G2. reorder reaches the pad: FOOD before DRINKS
  select array_agg(id order by case id when v_food then 0 when v_drinks then 1 else 2 end, sort_order, name) into v_ids from menu_categories;
  perform menu_reorder_categories(v_ids);
  if (select sort_order from menu_categories where id = v_food) >= (select sort_order from menu_categories where id = v_drinks)
     or (select (pr->'category'->>'sort_order')::int from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_toast::text)
        >= (select (pr->'category'->>'sort_order')::int from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_latte::text) then
    raise exception 'FAIL G2: the new category order does not reach the pad''s rows';
  end if;
  perform pg_temp.expect_error(format('select menu_reorder_categories(%L::uuid[])', v_ids[2:]),
    'The category list changed — refresh and try again', 'G2 one missing');
  -- G3. switched off: its products leave the pad and QR, and come back
  perform menu_set_category_active(v_drinks, false);
  if exists (select 1 from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_latte::text)
     or exists (select 1 from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
                  cross join jsonb_array_elements(c->'products') pr where pr->>'id' = v_latte::text) then
    raise exception 'FAIL G3: a switched-off category''s product is still offered';
  end if;
  perform menu_set_category_active(v_drinks, true);
  if not exists (select 1 from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_latte::text)
     or not exists (select 1 from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
                      cross join jsonb_array_elements(c->'products') pr where pr->>'id' = v_latte::text) then
    raise exception 'FAIL G3: switching the category back on did not bring the product back';
  end if;
  perform pg_temp.expect_error(format('select menu_set_category_active(%L, false)', gen_random_uuid()),
    'Category not found — refresh and try again', 'G3 unknown');

  -- ── H. the pad's rows ─────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch, v_toast, true);
  set local role authenticated;
  v_res := pos_menu_rows(c_dine);
  reset role;
  if not exists (select 1 from jsonb_array_elements(v_res->'links') l where l->>'product_id' = v_latte::text and l->>'group_id' = v_milk::text)
     or (select (x->>'price_sen')::int from jsonb_array_elements(v_res->'catalog'->'prices') x where x->>'variant_id' = v_hot::text) <> 1250
     or not exists (select 1 from jsonb_array_elements(v_res->'soldOut') s where s->>'product_id' = v_toast::text)
     or exists (select 1 from jsonb_array_elements(v_res->'products') pr where pr->>'id' = v_oat::text)
     or not exists (select 1 from jsonb_array_elements(v_res->'catalog'->'products') x
                     where x->>'product_id' = v_latte::text and x->>'availability' = 'all') then
    raise exception 'FAIL H: pos_menu_rows %', v_res;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select pos_menu_rows(%L)', c_dine), 'Your account is not active', 'H not staff');

  -- ── I. what the list pages read ───────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_res := menu_editor_lookups();
  if not exists (select 1 from jsonb_array_elements(v_res->'catalogs') c, jsonb_array_elements(c->'uses') u
                  where c->>'id' = c_dine::text and u->>'branch' = 'VERIFY M2' and u->>'role' = 'dine_in')
     or (select (c->>'productCount')::int from jsonb_array_elements(v_res->'categories') c where c->>'id' = v_drinks::text) <> 1   -- the latte; add-on items are not counted
     or (select (g->>'optionCount')::int from jsonb_array_elements(v_res->'groups') g where g->>'id' = v_milk::text) <> 1
     or (select (g->>'productCount')::int from jsonb_array_elements(v_res->'groups') g where g->>'id' = v_milk::text) <> 1
     or not exists (select 1 from jsonb_array_elements(v_res->'addOns') a where a->>'id' = v_oat::text) then
    raise exception 'FAIL I: menu_editor_lookups %', v_res;
  end if;
  v_res := (select x from jsonb_array_elements(menu_product_list()) x where x->>'id' = v_latte::text);
  if v_res is null or not (v_res->'catalog_ids' @> jsonb_build_array(c_dine, c_grab, c_qr)) or v_res->'catalog_ids' @> jsonb_build_array(c_take)
     or v_res->>'category_id' <> v_drinks::text or jsonb_array_length(v_res->'menu_variants') <> 2 then
    raise exception 'FAIL I: menu_product_list %', v_res;
  end if;

  -- ── J. what the editor sends: only what changed, and what a re-import leaves behind ─
  -- J1. a save without detail keys keeps what the Products and catalog pages changed meanwhile
  update menu_products set sst_rate_bp = 0, print_route = 'Kitchen' where id = v_latte;   -- as the Products page does
  perform menu_save_catalog_row(jsonb_build_object('catalogId', c_grab, 'productId', v_latte, 'availability', 'counter_only',
    'prices', jsonb_build_array(jsonb_build_object('variantId', v_hot, 'priceSen', 1777), jsonb_build_object('variantId', v_cold, 'priceSen', 1800))));
  perform menu_save_product(jsonb_build_object('id', v_latte, 'name', 'Verify M2 Latte 2', 'variants', v_p->'variants',
    'groupIds', jsonb_build_array(v_milk), 'catalogs', '[]'::jsonb));
  if (select name || '|' || sst_rate_bp || '|' || print_route || '|' || category_id from menu_products where id = v_latte)
       is distinct from 'Verify M2 Latte 2|0|Kitchen|' || v_drinks
     or (select price_sen from catalog_variant_prices where catalog_id = c_grab and variant_id = v_hot) <> 1777 then
    raise exception 'FAIL J1: a save that left out details or a catalog changed them';
  end if;
  -- J2. a new product sold in one variant (another one off) gets the base key for it
  v_id := menu_save_product(jsonb_build_object(
    'id', null, 'name', 'Verify M2 Scone', 'categoryId', v_food, 'sstRateBp', 0, 'printRoute', null, 'takeawayFeeSen', 0,
    'isActive', true, 'isAddon', false, 'groupIds', '[]'::jsonb, 'catalogs', '[]'::jsonb,
    'variants', jsonb_build_array(jsonb_build_object('ref', 'r', 'name', 'Regular', 'priceSen', 600, 'isActive', true),
                                  jsonb_build_object('ref', 'x', 'name', 'Jumbo', 'priceSen', 900, 'isActive', false))));
  if (select feedme_variant_key from menu_variants where product_id = v_id and name = 'Regular') <> '' then
    raise exception 'FAIL J2: the one active variant of a new product must use the base key';
  end if;
  -- J3. a re-import can leave a catalog made here without a price: the lookups count it (Open point 7)
  insert into menu_products(name, category_id, feedme_product_id) values ('Verify M2 Bun', v_food, 'VERIFY-M2-FM-1') returning id into v_bun;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_bun, '', 'Regular', 500) returning id into v_bun_reg;
  perform menu_save_catalog_row(jsonb_build_object('catalogId', c_new, 'productId', v_bun, 'availability', 'all',
    'prices', jsonb_build_array(jsonb_build_object('variantId', v_bun_reg, 'priceSen', 550))));
  perform menu_save_product(jsonb_build_object('id', v_bun, 'groupIds', '[]'::jsonb,
    'variants', jsonb_build_array(jsonb_build_object('ref', v_bun_reg, 'id', v_bun_reg, 'name', 'Regular', 'priceSen', 500, 'isActive', true),
                                  jsonb_build_object('ref', 'l', 'name', 'Large', 'priceSen', 600, 'isActive', true)),
    'catalogs', jsonb_build_array(jsonb_build_object('catalogId', c_new, 'availability', 'all', 'prices', jsonb_build_array(
      jsonb_build_object('ref', v_bun_reg, 'priceSen', 550), jsonb_build_object('ref', 'l', 'priceSen', 650))))));
  if (select (c->>'unpricedCount')::int from jsonb_array_elements(menu_editor_lookups()->'catalogs') c where c->>'id' = c_new::text) <> 0 then
    raise exception 'FAIL J3: a fully priced catalog reports unpriced products';
  end if;
  perform menu_import_catalogs(jsonb_build_object(
    'categories', jsonb_build_array(jsonb_build_object('name', 'VERIFY M2 FOOD', 'sortOrder', 901)),
    'products', jsonb_build_array(jsonb_build_object('feedmeId', 'VERIFY-M2-FM-1', 'name', 'Verify M2 Bun', 'internalName', null,
      'description', null, 'category', 'VERIFY M2 FOOD', 'availability', 'all', 'isAddon', false, 'takeawayFeeSen', 0, 'sortOrder', 0,
      'variants', jsonb_build_array(jsonb_build_object('key', '', 'name', 'Regular', 'priceSen', 500, 'sortOrder', 0)))),
    'groups', '[]'::jsonb, 'links', '[]'::jsonb, 'catalogs', '[]'::jsonb));
  if (select count(*) from menu_variants where product_id = v_bun and is_active) <> 1
     or (select (c->>'unpricedCount')::int from jsonb_array_elements(menu_editor_lookups()->'catalogs') c where c->>'id' = c_new::text) <> 1 then
    raise exception 'FAIL J3: after a re-import the catalog made here should report one unpriced product';
  end if;

  -- ── K. Edit menu for every editor function: manager refused, owner allowed, resigned owner refused ─
  update staff set status = 'resigned' where id = v_boss;                    -- is_active stays true, as in real life
  select array_agg(id order by sort_order, name) into v_ids from menu_catalogs;
  for r in select * from (values (v_mgr, false, 'manager'), (v_owner, true, 'owner'), (v_boss, false, 'resigned owner'))
                          as x(who, allowed, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform menu_editor_lookups();
      if not r.allowed then raise exception 'FAIL K %: menu_editor_lookups', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_product_list();
      if not r.allowed then raise exception 'FAIL K %: menu_product_list', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_product_detail(v_latte);
      if not r.allowed then raise exception 'FAIL K %: menu_product_detail', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_product(v_p);
      if not r.allowed then raise exception 'FAIL K %: menu_save_product', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_group_detail(v_milk);
      if not r.allowed then raise exception 'FAIL K %: menu_group_detail', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_group(v_g);
      if not r.allowed then raise exception 'FAIL K %: menu_save_group', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_catalog(c_new, 'VERIFY M2 Renamed');
      if not r.allowed then raise exception 'FAIL K %: menu_save_catalog', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_duplicate_catalog(c_new, 'VERIFY M2 copy by ' || r.label);
      if not r.allowed then raise exception 'FAIL K %: menu_duplicate_catalog', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_reorder_catalogs(v_ids || (select array_agg(id) from menu_catalogs where name like 'VERIFY M2 copy by %'));
      if not r.allowed then raise exception 'FAIL K %: menu_reorder_catalogs', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_set_catalog_active(c_new, true);
      if not r.allowed then raise exception 'FAIL K %: menu_set_catalog_active', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_catalog_grid(c_grab);
      if not r.allowed then raise exception 'FAIL K %: menu_catalog_grid', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_catalog_row(v_p2);
      if not r.allowed then raise exception 'FAIL K %: menu_save_catalog_row', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_category(v_newcat, 'VERIFY M2 RENAMED');
      if not r.allowed then raise exception 'FAIL K %: menu_save_category', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_reorder_categories((select array_agg(id order by sort_order, name) from menu_categories));
      if not r.allowed then raise exception 'FAIL K %: menu_reorder_categories', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_set_category_active(v_newcat, true);
      if not r.allowed then raise exception 'FAIL K %: menu_set_category_active', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    reset role;
  end loop;
  -- the Owner's override gives a manager Edit menu (has_menu_cap is the one rule)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into system_role_permissions(system_role, permissions) values ('manager', '{"manage_menu": true}')
  on conflict (system_role) do update set permissions = system_role_permissions.permissions || '{"manage_menu": true}';
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  perform menu_editor_lookups();

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 2: Local checks.** Run: `grep -c "VERIFY OK" supabase/migration-2026-10-24-pos-menu-editor-verify.sql` — Expected: `3` (header, notice, final select). Run: `grep -c "perform pg_temp.expect_error" supabase/migration-2026-10-24-pos-menu-editor-verify.sql` — Expected: `81`. Run: `grep -n "insert into staff" -B2 supabase/migration-2026-10-24-pos-menu-editor-verify.sql | grep -c "v_owner"` — Expected: `1` (the owner's claims are set right before the staff fixtures). Run: `npx vitest run` — Expected: 85 files, 734 tests pass (the scan ignores `-verify` files).

- [ ] **Step 3: Commit**

```bash
git add supabase/migration-2026-10-24-pos-menu-editor-verify.sql
git commit -m "test(pos-menu): verify script for the M2 menu editor functions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4 (controller, craft-os-dev — dashboard SQL editor in the owner's Chrome tab; the implementer does not touch the database):** confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`) — never the prod project. Load each file with `window.monaco.editor.getModels()[0].setValue(...)` and run it with `cmd+Return`, in order:
  1. `migration-2026-10-24-pos-menu-editor-fn.sql` → one row `menu editor functions applied`. Run it a **second time** → the same row (idempotent). A `STOP: …` error names the M1 file to re-run first.
  2. `migration-2026-10-24-pos-menu-editor-verify.sql` → `VERIFY OK`.
  3. Regression, each → `VERIFY OK`: `migration-2026-10-22-pos-menu-verify.sql`, `migration-2026-10-23-pos-ordering-verify.sql`, `migration-2026-10-24-pos-checkout-verify.sql`, `migration-2026-10-24-pos-catalogs-verify.sql`.
  4. The pad's one read on the real menu, as the dev owner (rolled back, like the verify scripts; the editor shows the select's row):

```sql
begin;
select set_config('request.jwt.claims', json_build_object('sub', '76cbcf9f-905e-450d-9f5e-1c9e72a9373d', 'role', 'authenticated')::text, true);
select jsonb_array_length(r->'products')             as pad_products,
       jsonb_array_length(r->'catalog'->'prices')    as pad_prices,
       jsonb_array_length(r->'links')                as pad_links,
       pg_size_pretty(length(r::text)::bigint)       as pad_json,
       jsonb_array_length(menu_product_list())       as listed_products,
       (select count(*) from menu_products)          as all_products,
       (select count(*) from catalog_products cp join menu_products p on p.id = cp.product_id and p.is_active and not p.is_addon
          join menu_catalogs c on c.id = cp.catalog_id
         where c.name = 'Craft Cafe' and cp.availability <> 'hidden')  as craft_cafe_sells
  from (select pos_menu_rows((select id from menu_catalogs where name = 'Craft Cafe')) as r) x;
rollback;
```

     Expected: `pad_products = craft_cafe_sells` (fewer only if a category is switched off), `listed_products = all_products` (409 unless products were added since), `pad_json` well under 1 MB. If `pos_menu_rows` says `Your account has no branch`, give the dev owner a branch in Team first (the pad needs one anyway).

  If a script stops with `FAIL …`, the message names the check: fix the function file (implementer, new commit), re-run it, then re-run the verify. Record the outcome in the ledger.

---

### Task 3: The order pad reads its menu in one call (`pos_menu_rows`)

**Files:**
- Modify: `src/features/pos/order/posApi.ts`, `src/features/pos/order/OrderPad.tsx`

**Interfaces:**
- Consumes: `pos_menu_rows` (Task 1, applied in Task 2); `buildPosMenu` and its row types (`cart.ts`, unchanged).
- Produces: `fetchPosMenu(catalogId: string): Promise<PosMenu>` — same menu as before, from one RPC; products of a switched-off category left out.

`buildPosMenu` and its tests stay exactly as they are: the RPC returns the rows it already takes.

- [ ] **Step 1: Implement.** In `src/features/pos/order/posApi.ts` make exactly these replacements:

1. Replace

```ts
import {
  buildPosMenu, type CatalogProductRow, type GroupRow, type LinkRow, type OptionPriceRow, type PosMenu, type ProductRow,
  type SoldOutRow, type VariantPriceRow,
} from './cart'
```

   with

```ts
import { buildPosMenu, type CatalogRows, type GroupRow, type LinkRow, type PosMenu, type ProductRow, type SoldOutRow } from './cart'
```

2. Replace the whole `fetchPosMenu` function with its comment — from the line `/** The counter menu of one catalog: flat reads (RLS menu_read) shaped by the pure` down to its closing `}` (the line before `/** Every catalog (for names) and this branch's assignments. */`) — with:

```ts
/** What pos_menu_rows returns: the flat rows buildPosMenu takes, in one JSON value. */
interface PosMenuRows {
  products: ProductRow[]
  groups: GroupRow[]
  links: LinkRow[]
  soldOut: SoldOutRow[]
  catalog: CatalogRows
}

/** The counter menu of one catalog in one call (pos_menu_rows: one JSON value, so
 *  PostgREST's 1000-row cap never cuts it short), shaped by the pure builder. Products
 *  and prices come from the catalog; sold-out is the caller's own branch. */
export async function fetchPosMenu(catalogId: string): Promise<PosMenu> {
  const { data, error } = await supabase.rpc('pos_menu_rows', { p_catalog_id: catalogId })
  if (error) fail(error)
  const rows = data as PosMenuRows
  return buildPosMenu(rows.products, rows.groups, rows.links, rows.soldOut, 'counter', rows.catalog)
}
```

   In `src/features/pos/order/OrderPad.tsx` replace `      const m = await fetchPosMenu(branchId, id)` (once) with `      const m = await fetchPosMenu(id)`. (`branchId` stays: the pad still uses it for sold-out writes and its load effect.)

- [ ] **Step 2: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run src/features/pos/order` — Expected: PASS (`cart.test.ts` unchanged). Run: `grep -n "from('menu_\|from('modifier\|from('catalog_\|from('product_modifier" src/features/pos/order/posApi.ts` — Expected: two lines — `menu_catalogs` in `fetchBranchCatalogs` (ten rows) and `menu_products` in `fetchMenuRoutes` (Open point 6). Run: `npx vitest run` — Expected: 85 files, 734 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/features/pos/order/posApi.ts src/features/pos/order/OrderPad.tsx
git commit -m "feat(pos): the order pad reads its catalog's menu in one call (pos_menu_rows), past PostgREST's 1000-row cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4 (controller, craft-os-dev — browser on the dev server; the implementer does not touch the database):** test login → `/pos` → open a table → the pad shows Craft Cafe's categories, products and prices exactly as before (compare three prices with `/menu`). Switch the order to **Grab Food** → Grab prices. Mark a product sold out, close and reopen the pad → greyed as before. DevTools → Network: each pad load is one `rpc/pos_menu_rows` request (no `menu_products?select=…` reads). Send one order → it lands on the bill at the pad's price.

---

### Task 4: `/menu` shell — sub-navigation, the Products page, the editor API

**Files:**
- Create: `src/features/pos/menu/menuEditorApi.ts`, `src/features/pos/menu/editorUi.tsx`, `src/features/pos/menu/MenuTabs.tsx`, `src/features/pos/menu/MenuRoutes.tsx`
- Rename + rewrite: `src/features/pos/menu/MenuPage.tsx` → `src/features/pos/menu/ProductListPage.tsx`
- Modify: `src/features/pos/menu/menuApi.ts`, `src/features/pos/menu/menuView.ts`, `src/features/pos/menu/importView.ts`, `src/App.tsx`, `src/features/pos/menu/MenuImportPage.tsx`
- Test: `src/features/pos/menu/menuView.test.ts`, `src/features/pos/menu/importView.test.ts`

**Interfaces:**
- Consumes: `menu_editor_lookups`, `menu_product_list` (Task 1).
- Produces: `MenuLookups`, `ProductDetail`, `ProductPayload`, `GroupDetail`, `GroupPayload`, `CatalogGrid`, `GridProduct`, `CatalogRowPayload` and one wrapper per RPC (`fetchLookups`, `fetchProductDetail`, `saveProduct`, `fetchGroupDetail`, `saveGroup`, `saveCatalog`, `duplicateCatalog`, `reorderCatalogs`, `setCatalogActive`, `fetchCatalogGrid`, `saveCatalogRow`, `saveCategory`, `reorderCategories`, `setCategoryActive`); `MenuProductRow` with `is_active`, `category_id`, `catalog_ids`; `menuTab(pathname)`, `MENU_TABS`, `soldIn`, `groupMenu(rows, MenuFilter)`; `editorUi`'s `inputCls`, `btnCls`, `linkBtnCls`, `Outcome`, `errorText`, `OutcomeLine`, `Section`; `useUnsavedWarning`, `useSavedNotice`; `MASTER_WARNING` listing what a re-import resets; routes `/menu` and `/menu/import` through `MenuRoutes`.

- [ ] **Step 1: Write the failing test.** Replace `src/features/pos/menu/menuView.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { formatPrice, groupMenu, menuTab, soldIn, type MenuFilter } from './menuView'
import type { MenuProductRow } from './menuApi'

function row(over: Partial<MenuProductRow>): MenuProductRow {
  return {
    id: over.name ?? 'x', name: 'x', is_active: true, is_addon: false, sst_rate_bp: 600, print_route: null,
    takeaway_fee_sen: 0, sort_order: 0, category_id: 'tea', category: { name: 'TEA', sort_order: 0 }, menu_variants: [],
    catalog_ids: [], ...over,
  }
}
const v = (price_sen: number, is_active = true) => ({ id: String(price_sen), name: 'v', price_sen, is_active, sort_order: 0 })
const all: MenuFilter = { search: '', showAddons: false, showInactive: false, categoryId: null, catalogId: null }

describe('formatPrice', () => {
  it('shows one price, a range, or a dash, ignoring switched-off variants', () => {
    expect(formatPrice([v(1000)])).toBe('RM 10.00')
    expect(formatPrice([v(1000), v(1150), v(900, false)])).toBe('RM 10.00 – 11.50')
    expect(formatPrice([v(900, false)])).toBe('—')
  })
})

describe('soldIn', () => {
  it('names the catalogs that sell a product, in catalog order', () => {
    const catalogs = [{ id: 'g', name: 'Grab Food', sortOrder: 6 }, { id: 'c', name: 'Craft Cafe', sortOrder: 0 }, { id: 's', name: 'Staff Meal', sortOrder: 3 }]
    expect(soldIn(['g', 'c'], catalogs)).toEqual(['Craft Cafe', 'Grab Food'])
    expect(soldIn([], catalogs)).toEqual([])
  })
})

describe('menuTab', () => {
  it('maps every /menu path to its tab', () => {
    expect(menuTab('/menu')).toBe('products')
    expect(menuTab('/menu/')).toBe('products')
    expect(menuTab('/menu/products/new')).toBe('products')
    expect(menuTab('/menu/catalogs/abc')).toBe('catalogs')
    expect(menuTab('/menu/groups/new')).toBe('groups')
    expect(menuTab('/menu/categories')).toBe('categories')
    expect(menuTab('/menu/import')).toBe('import')
  })
})

describe('groupMenu', () => {
  const rows = [
    row({ name: 'Oat milk', is_addon: true, category_id: 'addon', category: { name: 'ADDON', sort_order: 2 } }),
    row({ name: 'Smoked Duck DON', sort_order: 1, category_id: 'don', category: { name: 'DONBURI', sort_order: 1 }, catalog_ids: ['grab'] }),
    row({ name: 'Lychee Rose', sort_order: 2, catalog_ids: ['cafe', 'grab'] }),
    row({ name: 'Apple Tea', sort_order: 1, catalog_ids: ['cafe'] }),
    row({ name: 'Old Tea', is_active: false }),
    row({ name: 'Mystery', category_id: null, category: null }),
  ]

  it('orders sections by category and products by sort order, hiding add-ons and switched-off products by default', () => {
    const s = groupMenu(rows, all)
    expect(s.map((x) => x.title)).toEqual(['TEA', 'DONBURI', 'Uncategorised'])
    expect(s[0].products.map((p) => p.name)).toEqual(['Apple Tea', 'Lychee Rose'])
  })

  it('shows add-ons and switched-off products when asked', () => {
    expect(groupMenu(rows, { ...all, showAddons: true }).map((x) => x.title)).toContain('ADDON')
    expect(groupMenu(rows, { ...all, showInactive: true })[0].products.map((p) => p.name)).toContain('Old Tea')
  })

  it('filters by name, case-insensitively', () => {
    const s = groupMenu(rows, { ...all, search: 'duck' })
    expect(s).toHaveLength(1)
    expect(s[0].products[0].name).toBe('Smoked Duck DON')
  })

  it('filters by category and by the catalog that sells it', () => {
    expect(groupMenu(rows, { ...all, categoryId: 'don' }).map((x) => x.title)).toEqual(['DONBURI'])
    expect(groupMenu(rows, { ...all, catalogId: 'grab' }).flatMap((x) => x.products.map((p) => p.name)))
      .toEqual(['Lychee Rose', 'Smoked Duck DON'])
  })
})
```

   Replace `src/features/pos/menu/importView.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { MASTER_WARNING, canImport, catalogSummary } from './importView'

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

describe('MASTER_WARNING', () => {
  it('names everything a re-import loses', () => {
    for (const part of [
      'names, prices and which products each Feedme catalog sells are overwritten',
      'add-on options added here to Feedme add-on groups are deleted with their catalog prices',
      'options, products and categories you switched off come back on',
      'variants added here are switched off',
      'add-on groups linked to each imported product are replaced',
      'may lack a price',
    ]) expect(MASTER_WARNING, part).toContain(part)
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

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/menu/menuView.test.ts src/features/pos/menu/importView.test.ts` — Expected: FAIL (`menuTab` and `soldIn` are not exported; `groupMenu` ignores the new filters; `MASTER_WARNING` does not name what a re-import loses).

- [ ] **Step 3: Implement the view helpers.** Replace `src/features/pos/menu/menuView.ts` with:

```ts
import type { Availability } from './feedmeExport'
import type { MenuProductRow, MenuVariantRow } from './menuApi'

/** Feedme's print routes at Craft Cafe (portal → Menu → Print route, 2026-10-22). */
export const PRINT_ROUTES = ['Bar', 'Kitchen', 'Bakery', 'Front House'] as const
export const SST_CHOICES = [
  { bp: 600, label: '6%' },
  { bp: 0, label: '0%' },
] as const
/** A product in one catalog; 'hidden' = the catalog does not sell it. */
export const CATALOG_AVAILABILITY_LABELS: Record<Availability, string> = {
  hidden: 'Not in this catalog',
  all: 'Counter + QR',
  counter_only: 'Counter only',
}

/** The /menu sub-navigation. `match` decides which tab a path belongs to. */
export type MenuTab = 'products' | 'catalogs' | 'groups' | 'categories' | 'import'
export const MENU_TABS: { id: Exclude<MenuTab, 'import'>; label: string; to: string }[] = [
  { id: 'products', label: 'Products', to: '/menu' },
  { id: 'catalogs', label: 'Catalogs', to: '/menu/catalogs' },
  { id: 'groups', label: 'Add-on groups', to: '/menu/groups' },
  { id: 'categories', label: 'Categories', to: '/menu/categories' },
]
export function menuTab(pathname: string): MenuTab {
  const rest = pathname.replace(/^\/menu\/?/, '')
  if (rest.startsWith('catalogs')) return 'catalogs'
  if (rest.startsWith('groups')) return 'groups'
  if (rest.startsWith('categories')) return 'categories'
  if (rest.startsWith('import')) return 'import'
  return 'products'
}

export interface MenuSection { title: string; products: MenuProductRow[] }
export interface MenuFilter {
  search: string
  showAddons: boolean
  showInactive: boolean
  categoryId: string | null
  /** only the products this catalog sells */
  catalogId: string | null
}

const rm = (sen: number) => (sen / 100).toFixed(2)

export function formatPrice(variants: Pick<MenuVariantRow, 'price_sen' | 'is_active'>[]): string {
  const prices = variants.filter((v) => v.is_active).map((v) => v.price_sen)
  if (prices.length === 0) return '—'
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  return lo === hi ? `RM ${rm(lo)}` : `RM ${rm(lo)} – ${rm(hi)}`
}

/** The names of the catalogs that sell a product, in catalog order. */
export function soldIn(catalogIds: string[], catalogs: { id: string; name: string; sortOrder: number }[]): string[] {
  return catalogs
    .filter((c) => catalogIds.includes(c.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((c) => c.name)
}

export function groupMenu(rows: MenuProductRow[], f: MenuFilter): MenuSection[] {
  const q = f.search.trim().toLowerCase()
  const sections = new Map<string, { order: number; products: MenuProductRow[] }>()
  for (const r of rows) {
    if (!f.showAddons && r.is_addon) continue
    if (!f.showInactive && !r.is_active) continue
    if (f.categoryId && r.category_id !== f.categoryId) continue
    if (f.catalogId && !r.catalog_ids.includes(f.catalogId)) continue
    if (q && !r.name.toLowerCase().includes(q)) continue
    const title = r.category?.name ?? 'Uncategorised'
    if (!sections.has(title)) sections.set(title, { order: r.category?.sort_order ?? Number.MAX_SAFE_INTEGER, products: [] })
    sections.get(title)!.products.push(r)
  }
  return [...sections.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([title, s]) => ({
      title,
      products: s.products.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    }))
}
```

   (`initialCatalogId`, `SHOP_CATALOG_NAME`, `catalogAvailability` and `formatCatalogPrice` go with M1's catalog picker; `PRINT_ROUTES` stays exported for POS settings.)

   Only `MASTER_WARNING` and its comment change (the import page already shows it above the import button). Replace `src/features/pos/menu/importView.ts` with:

```ts
import type { ImportCatalog } from './feedmeExport'

/** What the person types before an import overwrites catalogs that already exist. */
export const IMPORT_CONFIRM_WORD = 'IMPORT'
/** A re-import resets the menu to Feedme (as Feedme itself has one master and no merge).
 *  This says exactly what is lost, so nobody presses Import without knowing. */
export const MASTER_WARNING =
  'Craft OS is the master of the menu. Importing again resets it to Feedme: product names, prices and which products ' +
  'each Feedme catalog sells are overwritten; add-on options added here to Feedme add-on groups are deleted with their ' +
  'catalog prices; options, products and categories you switched off come back on; variants added here are switched ' +
  'off; the add-on groups linked to each imported product are replaced with Feedme\'s. Catalogs made here keep their ' +
  'prices but may lack a price for a variant Feedme brings back — the Catalogs page counts those products.'

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

- [ ] **Step 4: The list read.** Replace `src/features/pos/menu/menuApi.ts` with:

```ts
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { CatalogsImport } from './feedmeExport'

export interface MenuVariantRow { id: string; name: string; price_sen: number; is_active: boolean; sort_order: number }
/** A master product as the Products page lists it (menu_product_list). `catalog_ids`
 *  are the catalogs that sell it (availability other than hidden). */
export interface MenuProductRow {
  id: string
  name: string
  is_active: boolean
  is_addon: boolean
  sst_rate_bp: number
  print_route: string | null
  takeaway_fee_sen: number
  sort_order: number
  category_id: string | null
  category: { name: string; sort_order: number } | null
  menu_variants: MenuVariantRow[]
  catalog_ids: string[]
}
export type ProductPatch = Partial<Pick<MenuProductRow, 'sst_rate_bp' | 'print_route'>>

/** Every product, switched-off ones too, in one call (menu_product_list: one JSON
 *  value, so PostgREST's 1000-row cap never cuts the list short). Edit menu only. */
export async function fetchMenu(): Promise<MenuProductRow[]> {
  const { data, error } = await supabase.rpc('menu_product_list')
  if (error) throw new Error(error.message)
  return (data ?? []) as MenuProductRow[]
}

/** One patch for many products (e.g. a whole category's print route). */
export async function updateProducts(ids: string[], patch: ProductPatch): Promise<void> {
  if (ids.length === 0) return
  const res = await supabase
    .from('menu_products')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .in('id', ids)
    .select('id')
  const outcome = writeOutcome(res)
  if (!outcome.ok) throw new Error(`Menu change failed: ${outcome.reason}`)
  if ((res.data ?? []).length !== ids.length) throw new Error('Some products were not updated — refresh and try again.')
}

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

- [ ] **Step 5: The editor's API module.** Create `src/features/pos/menu/menuEditorApi.ts`:

```ts
// src/features/pos/menu/menuEditorApi.ts
/** The menu editor's server calls (supabase/migration-2026-10-24-pos-menu-editor-fn.sql).
 *  Every read is one RPC that returns one JSON value, so PostgREST's 1000-row cap
 *  never cuts it short; every write is one RPC that validates everything and answers
 *  in the words the editor shows. All of them need Edit menu (manage_menu). */
import { supabase } from '../../../shared/lib/supabase'
import type { Availability } from './feedmeExport'

export type CatalogRole = 'dine_in' | 'takeaway' | 'qr' | 'additional'

export interface LookupCategory { id: string; name: string; isActive: boolean; sortOrder: number; productCount: number }
export interface LookupCatalog {
  id: string
  name: string
  isActive: boolean
  sortOrder: number
  feedmeName: string | null
  productCount: number
  /** products it sells with an active variant it has no price for (the pad and QR leave them out) */
  unpricedCount: number
  uses: { branch: string; role: CatalogRole }[]
}
export interface LookupGroup {
  id: string
  name: string
  isActive: boolean
  min: number
  max: number
  optionCount: number
  productCount: number
}
export interface LookupAddOn { id: string; name: string; isActive: boolean }
/** menu_editor_lookups: everything the pickers and the list pages need. */
export interface MenuLookups {
  categories: LookupCategory[]
  catalogs: LookupCatalog[]
  groups: LookupGroup[]
  addOns: LookupAddOn[]
}

/** menu_product_detail. `catalogs` has one entry per catalog; prices are by variant id. */
export interface ProductDetail {
  id: string
  name: string
  internalName: string | null
  description: string | null
  categoryId: string | null
  sstRateBp: number
  printRoute: string | null
  takeawayFeeSen: number
  isActive: boolean
  isAddon: boolean
  feedmeProductId: string | null
  variants: { id: string; name: string; priceSen: number; isActive: boolean }[]
  groupIds: string[]
  catalogs: { catalogId: string; availability: Availability; prices: Record<string, number> }[]
}
/** The product's own fields. menu_save_product keeps a stored value whose key is left out
 *  (an existing product only), so the editor sends only what the owner changed. */
export interface ProductDetails {
  name: string
  internalName: string | null
  description: string | null
  categoryId: string | null
  sstRateBp: number
  printRoute: string | null
  takeawayFeeSen: number
  isActive: boolean
  isAddon: boolean
}
/** menu_save_product. A variant's `ref` is its id when it exists, any other string when new.
 *  Every variant is always sent; catalogs left out are not touched. */
export interface ProductPayload extends Partial<ProductDetails> {
  id: string | null
  variants: { ref: string; id: string | null; name: string; priceSen: number; isActive: boolean }[]
  groupIds: string[]
  catalogs: { catalogId: string; availability: Availability; prices: { ref: string; priceSen: number }[] }[]
}

/** menu_group_detail. `catalogPrices` holds only the catalogs that override the price. */
export interface GroupDetail {
  id: string
  name: string
  min: number
  max: number
  stackable: boolean
  isActive: boolean
  feedmeGroupId: string | null
  options: {
    id: string
    name: string
    priceDeltaSen: number
    productId: string | null
    isDefault: boolean
    availability: Availability
    catalogPrices: Record<string, number>
  }[]
  usedBy: { id: string; name: string }[]
}
/** menu_save_group. `catalogPrices` is the whole set of overrides the group keeps. */
export interface GroupPayload {
  id: string | null
  name: string
  min: number
  max: number
  stackable: boolean
  isActive: boolean
  options: {
    ref: string
    id: string | null
    name: string
    priceDeltaSen: number
    productId: string | null
    isDefault: boolean
    availability: Availability
  }[]
  catalogPrices: { catalogId: string; ref: string; priceDeltaSen: number }[]
}

/** menu_catalog_grid: every active product that is not an add-on item. */
export interface GridVariant { id: string; name: string; isActive: boolean; defaultSen: number; priceSen: number | null }
export interface GridProduct {
  id: string
  name: string
  category: string
  categorySort: number
  availability: Availability
  variants: GridVariant[]
}
export interface CatalogGrid { catalog: { id: string; name: string; isActive: boolean }; products: GridProduct[] }
/** menu_save_catalog_row */
export interface CatalogRowPayload {
  catalogId: string
  productId: string
  availability: Availability
  prices: { variantId: string; priceSen: number }[]
}

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data as T
}

export const fetchLookups = () => call<MenuLookups>('menu_editor_lookups')
export const fetchProductDetail = (id: string) => call<ProductDetail>('menu_product_detail', { p_product_id: id })
export const saveProduct = (p: ProductPayload) => call<string>('menu_save_product', { p })
export const fetchGroupDetail = (id: string) => call<GroupDetail>('menu_group_detail', { p_group_id: id })
export const saveGroup = (p: GroupPayload) => call<string>('menu_save_group', { p })
export const saveCatalog = (id: string | null, name: string) => call<string>('menu_save_catalog', { p_id: id, p_name: name })
export const duplicateCatalog = (sourceId: string, name: string) =>
  call<string>('menu_duplicate_catalog', { p_source_id: sourceId, p_name: name })
export const reorderCatalogs = (ids: string[]) => call<null>('menu_reorder_catalogs', { p_ids: ids })
export const setCatalogActive = (id: string, active: boolean) => call<null>('menu_set_catalog_active', { p_id: id, p_active: active })
export const fetchCatalogGrid = (id: string) => call<CatalogGrid>('menu_catalog_grid', { p_catalog_id: id })
export const saveCatalogRow = (p: CatalogRowPayload) => call<null>('menu_save_catalog_row', { p })
export const saveCategory = (id: string | null, name: string) => call<string>('menu_save_category', { p_id: id, p_name: name })
export const reorderCategories = (ids: string[]) => call<null>('menu_reorder_categories', { p_ids: ids })
export const setCategoryActive = (id: string, active: boolean) => call<null>('menu_set_category_active', { p_id: id, p_active: active })
```

- [ ] **Step 6: Shared pieces, tabs and routes.** Create `src/features/pos/menu/editorUi.tsx`:

```tsx
// src/features/pos/menu/editorUi.tsx
/** Small pieces every /menu page shares: the look of inputs and buttons, and the
 *  outcome line a save shows next to the section that made it. */
import { useEffect, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export const inputCls = 'rounded border border-border bg-card px-2 py-1 text-sm'
export const btnCls = 'rounded bg-brown-btn px-3 py-2 text-sm text-white hover:bg-brown-btn-hover disabled:opacity-40'
export const linkBtnCls = 'rounded border border-border px-2 py-1 text-sm hover:bg-cream disabled:opacity-40'

export type Outcome = { kind: 'ok' | 'error'; text: string }
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null
  return outcome.kind === 'error'
    ? <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{outcome.text}</p>
    : <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">{outcome.text}</p>
}

/** While `dirty`, closing or reloading the tab asks first (the browser's own prompt). */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}

/** The "saved" message a create passes on through navigation state, read once: it is
 *  then cleared, so a reload does not show it again. */
export function useSavedNotice(): string | null {
  const location = useLocation()
  const navigate = useNavigate()
  const saved = (location.state as { saved?: string } | null)?.saved ?? null
  useEffect(() => {
    if (saved) navigate(location.pathname, { replace: true, state: null })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return saved
}

/** A titled box; `problem` is the first thing in it that stops a save. */
export function Section({ title, hint, problem, children }: {
  title: string; hint?: string; problem?: string | null; children: ReactNode
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {hint && <p className="text-xs text-brown-muted">{hint}</p>}
      </div>
      {children}
      {problem && <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{problem}</p>}
    </section>
  )
}
```

   Create `src/features/pos/menu/MenuTabs.tsx`:

```tsx
// src/features/pos/menu/MenuTabs.tsx
import { Link, useLocation } from 'react-router-dom'
import { MENU_TABS, menuTab } from './menuView'

/** The /menu sub-navigation: Products, Catalogs, Add-on groups, Categories, and the import. */
export default function MenuTabs() {
  const tab = menuTab(useLocation().pathname)
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
      {MENU_TABS.map((t) => (
        <Link key={t.id} to={t.to} aria-current={tab === t.id ? 'page' : undefined}
          className={`rounded px-3 py-1.5 text-sm ${tab === t.id ? 'bg-brown-btn text-white' : 'hover:bg-cream'}`}>
          {t.label}
        </Link>
      ))}
      <Link to="/menu/import" aria-current={tab === 'import' ? 'page' : undefined}
        className={`ml-auto rounded px-3 py-1.5 text-sm ${tab === 'import' ? 'bg-brown-btn text-white' : 'underline'}`}>
        Import from Feedme
      </Link>
    </nav>
  )
}
```

   Create `src/features/pos/menu/MenuRoutes.tsx`:

```tsx
// src/features/pos/menu/MenuRoutes.tsx
import { Navigate, Route, Routes } from 'react-router-dom'
import ProductListPage from './ProductListPage'
import MenuImportPage from './MenuImportPage'

/** Everything under /menu (App.tsx gates it on Edit menu). */
export default function MenuRoutes() {
  return (
    <Routes>
      <Route index element={<ProductListPage />} />
      <Route path="import" element={<MenuImportPage />} />
      <Route path="*" element={<Navigate to="/menu" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 7: The Products page.** Run: `git mv src/features/pos/menu/MenuPage.tsx src/features/pos/menu/ProductListPage.tsx`, then replace its content with:

```tsx
// src/features/pos/menu/ProductListPage.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchMenu, updateProducts, type MenuProductRow, type ProductPatch } from './menuApi'
import { fetchLookups, type MenuLookups } from './menuEditorApi'
import { PRINT_ROUTES, SST_CHOICES, formatPrice, groupMenu, soldIn, type MenuFilter } from './menuView'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText, inputCls, type Outcome } from './editorUi'

/** /menu — the master product list. Each row opens the product editor; SST and the
 *  print route stay editable here (and the print route for a whole category at once)
 *  because setting them up for 400 imported products one editor at a time is slow.
 *  Which catalogs sell a product, and at what price, is edited in the product editor
 *  or on a catalog's page. */
export default function ProductListPage() {
  const [rows, setRows] = useState<MenuProductRow[] | null>(null)
  const [lookups, setLookups] = useState<MenuLookups | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<MenuFilter>({ search: '', showAddons: false, showInactive: false, categoryId: null, catalogId: null })
  const [busy, setBusy] = useState<Set<string>>(new Set())                    // product ids being saved
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})       // by section title

  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(() => {
    const seq = ++loadSeq.current
    Promise.all([fetchMenu(), fetchLookups()])
      .then(([r, l]) => { if (seq === loadSeq.current) { setRows(r); setLookups(l); setLoadError(null) } })
      .catch((e) => { if (seq === loadSeq.current) setLoadError(errorText(e)) })
  }, [])
  useEffect(() => { load() }, [load])

  const sections = useMemo(() => groupMenu(rows ?? [], filter), [rows, filter])

  /** A quick edit of one or more products; the outcome shows on the section that made it. */
  const save = async (section: string, ids: string[], patch: ProductPatch) => {
    if (ids.length === 0 || ids.some((id) => busy.has(id))) return
    const before = rows
    setBusy((b) => new Set([...b, ...ids]))
    setRows((rs) => rs?.map((r) => (ids.includes(r.id) ? { ...r, ...patch } : r)) ?? rs)
    try {
      await updateProducts(ids, patch)
      setOutcomes((o) => ({ ...o, [section]: { kind: 'ok', text: ids.length === 1 ? 'Saved' : `Saved for ${ids.length} products` } }))
    } catch (e) {
      setRows(before)
      setOutcomes((o) => ({ ...o, [section]: { kind: 'error', text: errorText(e) } }))
    } finally {
      setBusy((b) => new Set([...b].filter((id) => !ids.includes(id))))
    }
  }

  if (rows === null && !loadError) return <div className="mx-auto max-w-6xl space-y-4 p-6"><MenuTabs /><p className="text-sm">Loading menu…</p></div>

  const set = (patch: Partial<MenuFilter>) => setFilter((f) => ({ ...f, ...patch }))
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-sm text-brown-muted">
            {rows?.length ?? 0} products. SST and print route apply in every catalog; open a product to edit its
            variants, add-on groups and catalog prices.
          </p>
        </div>
        <Link to="/menu/products/new" className={btnCls}>New product</Link>
      </div>

      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={load}>Try again</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input className={`${inputCls} w-56`} placeholder="Search products" value={filter.search}
          onChange={(e) => set({ search: e.target.value })} />
        <select className={inputCls} value={filter.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || null })}>
          <option value="">All categories</option>
          {lookups?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
        <select className={inputCls} value={filter.catalogId ?? ''} onChange={(e) => set({ catalogId: e.target.value || null })}>
          <option value="">Any catalog</option>
          {lookups?.catalogs.map((c) => <option key={c.id} value={c.id}>Sold in {c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filter.showAddons} onChange={(e) => set({ showAddons: e.target.checked })} />
          Show add-on items
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={filter.showInactive} onChange={(e) => set({ showInactive: e.target.checked })} />
          Show switched-off products
        </label>
      </div>

      {rows?.length === 0 && (
        <p className="rounded border border-border p-6 text-sm">No menu yet — use “Import from Feedme” or “New product”.</p>
      )}

      {sections.map((section) => (
        <section key={section.title} className="rounded border border-border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
            <h2 className="font-medium">
              {section.title} <span className="text-sm text-brown-muted">({section.products.length})</span>
            </h2>
            <label className="flex items-center gap-2 text-sm">
              Print whole category to
              <select className={inputCls} value=""
                onChange={(e) => void save(section.title,
                  // the whole category, not just the rows the filters are showing
                  (rows ?? []).filter((r) => (r.category?.name ?? 'Uncategorised') === section.title).map((p) => p.id),
                  { print_route: e.target.value || null })}>
                <option value="" disabled>Choose…</option>
                {PRINT_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </div>
          {outcomes[section.title] && <div className="px-4 pt-2"><OutcomeLine outcome={outcomes[section.title]} /></div>}
          <table className="w-full text-sm">
            <thead className="text-left text-brown-muted">
              <tr>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Default price</th>
                <th className="px-4 py-2">Sold in</th>
                <th className="px-4 py-2">SST</th>
                <th className="px-4 py-2">Print route</th>
              </tr>
            </thead>
            <tbody>
              {section.products.map((p) => {
                const names = soldIn(p.catalog_ids, lookups?.catalogs ?? [])
                const active = p.menu_variants.filter((v) => v.is_active)
                return (
                  <tr key={p.id} className={`border-t border-border ${p.is_active ? '' : 'text-brown-faint'}`}>
                    <td className="px-4 py-2">
                      <Link to={`/menu/products/${p.id}`} className="underline-offset-2 hover:underline">{p.name}</Link>
                      {!p.is_active && <span className="ml-2 text-xs">(off)</span>}
                      {active.length > 1 && <span className="ml-2 text-xs text-brown-muted">{active.map((v) => v.name).join(' / ')}</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">{formatPrice(p.menu_variants)}</td>
                    <td className="px-4 py-2" title={names.join(', ')}>
                      {names.length === 0 ? <span className="text-brown-faint">No catalog</span>
                        : names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`}
                    </td>
                    <td className="px-4 py-2">
                      <select className={inputCls} value={p.sst_rate_bp} disabled={busy.has(p.id)}
                        onChange={(e) => void save(section.title, [p.id], { sst_rate_bp: Number(e.target.value) })}>
                        {SST_CHOICES.map((c) => <option key={c.bp} value={c.bp}>{c.label}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select className={inputCls} value={p.print_route ?? ''} disabled={busy.has(p.id)}
                        onChange={(e) => void save(section.title, [p.id], { print_route: e.target.value || null })}>
                        <option value="">Not printed</option>
                        {PRINT_ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}
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

- [ ] **Step 8: Route `/menu/*`.** In `src/App.tsx` make exactly these replacements:

1. Replace

```tsx
import MenuPage from './features/pos/menu/MenuPage'
import MenuImportPage from './features/pos/menu/MenuImportPage'
```

   with

```tsx
import MenuRoutes from './features/pos/menu/MenuRoutes'
```

2. Replace

```tsx
      <Route
        path="/menu"
        element={
          <ProtectedRoute requireCap="manage_menu">
            <AppLayout><MenuPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/menu/import"
        element={
          <ProtectedRoute requireCap="manage_menu">
            <AppLayout><MenuImportPage /></AppLayout>
          </ProtectedRoute>
        }
      />
```

   with

```tsx
      <Route
        path="/menu/*"
        element={
          <ProtectedRoute requireCap="manage_menu">
            <AppLayout><MenuRoutes /></AppLayout>
          </ProtectedRoute>
        }
      />
```

   In `src/features/pos/menu/MenuImportPage.tsx` replace `      <Link to="/menu" className="text-sm underline">← Menu</Link>` with `      <MenuTabs />`, and replace `import { IMPORT_CONFIRM_WORD, MASTER_WARNING, canImport, catalogSummary } from './importView'` with that line followed by `import MenuTabs from './MenuTabs'` on the next line. (`Link` stays imported: the done screen still uses it.) The sidebar needs nothing: its Menu leaf matches every path under `/menu`.

- [ ] **Step 9: Run the gates.** Run: `npx vitest run src/features/pos/menu/menuView.test.ts src/features/pos/menu/importView.test.ts` — Expected: PASS, 7 + 3 tests. Run: `npx tsc -b` — Expected: no output. Run: `grep -rn "from './MenuPage'\|fetchCatalogEntries\|SHOP_CATALOG_NAME" src` — Expected: no output. Run: `npx vitest run` — Expected: 85 files, 734 tests pass.

- [ ] **Step 10: Commit**

```bash
git add -A src/features/pos/menu src/App.tsx
git commit -m "feat(pos-menu): /menu gets Products, Catalogs, Add-on groups and Categories tabs; the Products page lists every product from one read; the import warning lists what a re-import resets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11 (controller, craft-os-dev — browser on the dev server; the implementer does not touch the database):** test login → **Menu** → the tabs show, **Products** is selected; the subtitle counts every product (409 on dev unless added since). Filter **Sold in Grab Food** → only Grab Food's products (M1 counted 66); pick a category → only that category; tick **Show switched-off products** → greyed rows marked "(off)" if any. Change one product's SST → "Saved" appears on that category's box; `select sst_rate_bp from menu_products where name = '<it>'` → the new value; set it back. **Print whole category to → Kitchen** on a small category → "Saved for N products". Click **Import from Feedme** → the import page with the tabs on top; pick the export zip → the amber warning lists what a re-import resets (do not import). A product name links to `/menu/products/<id>`, which redirects to `/menu` until Task 5. If a manager login exists: no Menu in the nav, `/menu/catalogs` redirects.

---

### Task 5: Product editor — one save for the product, its variants, its add-on groups and its catalog prices

**Files:**
- Create: `src/features/pos/menu/menuForms.ts`, `src/features/pos/menu/productForm.ts`, `src/features/pos/menu/ProductEditorPage.tsx`, `src/features/pos/menu/product/DetailsSection.tsx`, `src/features/pos/menu/product/VariantsSection.tsx`, `src/features/pos/menu/product/GroupsSection.tsx`, `src/features/pos/menu/product/CatalogsSection.tsx`
- Modify: `src/features/pos/menu/MenuRoutes.tsx`
- Test: `src/features/pos/menu/menuForms.test.ts`, `src/features/pos/menu/productForm.test.ts`

**Interfaces:**
- Consumes: `fetchLookups`, `fetchProductDetail`, `saveProduct` (Task 4); `parseRinggit` (`checkout/tender.ts`).
- Produces: `cleanName`, `nameProblem`, `senToInput`, `inputToSen`, `moveItem`, `nextRef` (used again in Tasks 6–8); `ProductForm`, `ProductSection` (`'details' | 'variants' | 'groups' | 'catalogs'`; M3 adds `'photo' | 'slots'`), `emptyProductForm`, `productFormFromDetail`, `productProblems`, `productPayload` and the edit helpers; routes `/menu/products/new`, `/menu/products/:id`.

- [ ] **Step 1: Write the failing tests.** Create `src/features/pos/menu/menuForms.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cleanName, inputToSen, moveItem, nameProblem, nextRef, senToInput } from './menuForms'

describe('names', () => {
  it('trims and collapses spaces like the server', () => {
    expect(cleanName('  Iced   Latte ')).toBe('Iced Latte')
  })
  it('uses the server\'s words for a blank or long name', () => {
    expect(nameProblem('Variant', '   ', 60)).toBe('Variant name is required')
    expect(nameProblem('Catalog', 'x'.repeat(61), 60)).toBe('Catalog name is too long (at most 60 characters)')
    expect(nameProblem('Catalog', ` ${'x'.repeat(60)} `, 60)).toBeNull()
  })
})

describe('money', () => {
  it('turns sen into a price box and back', () => {
    expect(senToInput(1250)).toBe('12.50')
    expect(senToInput(0)).toBe('0.00')
    expect(inputToSen('12.50')).toBe(1250)
    expect(inputToSen('12.5')).toBe(1250)
    expect(inputToSen('12')).toBe(1200)
    expect(inputToSen('RM 7.05')).toBe(705)
    expect(inputToSen('0')).toBe(0)
  })
  it('refuses what is not a whole number of sen from 0 up', () => {
    for (const bad of ['', ' ', '-1', '12.555', 'abc', '1e3', '1234567']) expect(inputToSen(bad), bad).toBeNull()
  })
})

describe('moveItem', () => {
  it('moves up and down, and leaves the list alone at the ends', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    const list = ['a', 'b']
    expect(moveItem(list, 0, -1)).toBe(list)
    expect(moveItem(list, 1, 1)).toBe(list)
  })
})

describe('nextRef', () => {
  it('never reuses a ref', () => {
    expect(nextRef([])).toBe('new-1')
    expect(nextRef([{ ref: 'new-1' }, { ref: 'abc' }, { ref: 'new-3' }])).toBe('new-2')
  })
})
```

   Create `src/features/pos/menu/productForm.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  addGroup, addVariant, emptyProductForm, fillCatalogBlanks, moveGroup, moveVariant, productFormDirty, productFormFromDetail,
  productPayload, productProblems, removeGroup, removeNewVariant, setCatalogAvailability, setCatalogPrice, updateVariant, type ProductForm,
} from './productForm'
import type { ProductDetail } from './menuEditorApi'

const names: Record<string, string> = { cafe: 'Craft Cafe', grab: 'Grab Food', staff: 'Staff Meal' }
const catalogName = (id: string) => names[id] ?? id
const problems = (f: ProductForm) => productProblems(f, catalogName)
const messages = (f: ProductForm) => problems(f).map((p) => p.message)

const detail: ProductDetail = {
  id: 'p1', name: 'Latte', internalName: null, description: 'Double shot', categoryId: 'coffee', sstRateBp: 600,
  printRoute: 'Bar', takeawayFeeSen: 50, isActive: true, isAddon: false, feedmeProductId: 'fm-1',
  variants: [
    { id: 'v-hot', name: 'Hot', priceSen: 1200, isActive: true },
    { id: 'v-cold', name: 'Cold', priceSen: 1300, isActive: true },
    { id: 'v-old', name: 'Large', priceSen: 1500, isActive: false },
  ],
  groupIds: ['g-milk', 'g-sugar'],
  catalogs: [
    { catalogId: 'grab', availability: 'counter_only', prices: { 'v-hot': 1700, 'v-cold': 1800 } },
    { catalogId: 'cafe', availability: 'all', prices: { 'v-hot': 1210, 'v-cold': 1310, 'v-old': 1 } },
  ],
}
const saved = () => productFormFromDetail(detail, ['cafe', 'staff', 'grab'])

describe('the form of a saved product', () => {
  it('shows prices as RM text and lists every catalog in the given order, hidden where it is not sold', () => {
    const f = saved()
    expect(f.takeawayFee).toBe('0.50')
    expect(f.variants.map((v) => [v.ref, v.price])).toEqual([['v-hot', '12.00'], ['v-cold', '13.00'], ['v-old', '15.00']])
    expect(f.catalogs.map((c) => [c.catalogId, c.availability])).toEqual([['cafe', 'all'], ['staff', 'hidden'], ['grab', 'counter_only']])
    expect(f.catalogs[0].prices).toEqual({ 'v-hot': '12.10', 'v-cold': '13.10', 'v-old': '0.01' })
    expect(problems(f)).toEqual([])
  })

  it('turns back into the payload menu_save_product takes, ids as refs, prices in sen', () => {
    const p = productPayload(saved())                                       // nothing to compare with: everything is sent
    expect(p.id).toBe('p1')
    expect(p.takeawayFeeSen).toBe(50)
    expect(p.variants[0]).toEqual({ ref: 'v-hot', id: 'v-hot', name: 'Hot', priceSen: 1200, isActive: true })
    // a switched-off variant's price is not shown, so it is not sent (the server keeps it)
    expect(p.catalogs[0]).toEqual({ catalogId: 'cafe', availability: 'all', prices: [
      { ref: 'v-hot', priceSen: 1210 }, { ref: 'v-cold', priceSen: 1310 },
    ] })
    expect(p.catalogs[1]).toEqual({ catalogId: 'staff', availability: 'hidden', prices: [] })
    expect(p.groupIds).toEqual(['g-milk', 'g-sugar'])
  })
})

describe('a new product', () => {
  it('starts with one Regular variant, in no catalog, and asks for a name, a category and a price', () => {
    const f = emptyProductForm(['cafe', 'grab'])
    expect(f.variants).toEqual([{ ref: 'new-1', id: null, name: 'Regular', price: '', isActive: true }])
    expect(f.catalogs.every((c) => c.availability === 'hidden')).toBe(true)
    expect(messages(f)).toEqual([
      'Product name is required', 'Choose a category', 'Enter the default price of Regular in RM, e.g. 12.50',
    ])
  })

  it('cleans names and drops blank optional text in the payload', () => {
    const f = { ...emptyProductForm(['cafe'], 'coffee'), name: '  Iced   Latte ', internalName: '  ', variants: [
      { ref: 'new-1', id: null, name: ' Regular ', price: '9.5', isActive: true },
    ] }
    const p = productPayload(f)
    expect(p.name).toBe('Iced Latte')
    expect(p.internalName).toBeNull()
    expect(p.description).toBeNull()
    expect(p.variants).toEqual([{ ref: 'new-1', id: null, name: 'Regular', priceSen: 950, isActive: true }])
  })
})

describe('variants', () => {
  it('adds a blank variant with a fresh ref and moves it', () => {
    let f = addVariant(saved())
    expect(f.variants[3]).toEqual({ ref: 'new-1', id: null, name: '', price: '', isActive: true })
    f = moveVariant(f, 3, -1)
    expect(f.variants.map((v) => v.ref)).toEqual(['v-hot', 'v-cold', 'new-1', 'v-old'])
  })

  it('removes only an unsaved variant (with its catalog prices); a saved one is switched off instead', () => {
    let f = setCatalogPrice(addVariant(saved()), 'cafe', 'new-1', '14.00')
    f = removeNewVariant(f, 'new-1')
    expect(f.variants).toHaveLength(3)
    expect(f.catalogs[0].prices['new-1']).toBeUndefined()
    expect(removeNewVariant(f, 'v-hot')).toBe(f)
  })

  it('needs at least one active variant, a name and an amount for each, no twins among the active ones', () => {
    let f = updateVariant(updateVariant(saved(), 'v-hot', { isActive: false }), 'v-cold', { isActive: false })
    expect(messages(f)).toEqual(['A product needs at least one active variant'])
    f = updateVariant(saved(), 'v-cold', { name: ' hot ' })
    expect(messages(f)).toEqual(['Two variants are called Hot'])
    f = updateVariant(saved(), 'v-old', { name: 'hot' })                    // a switched-off twin is fine
    expect(messages(f)).toEqual([])
    f = updateVariant(addVariant(saved()), 'new-1', { price: '1.234' })
    expect(problems(f).filter((p) => p.section === 'variants').map((p) => p.message)).toEqual([
      'Variant name is required', 'Enter the default price of the new variant in RM, e.g. 12.50',
    ])
  })
})

describe('catalogs', () => {
  it('putting the product in a catalog pre-fills blank prices of active variants with their default prices', () => {
    const f = setCatalogAvailability(saved(), 'staff', 'all')
    expect(f.catalogs[1]).toEqual({ catalogId: 'staff', availability: 'all', prices: { 'v-hot': '12.00', 'v-cold': '13.00' } })
    // switching channel inside a catalog keeps its own prices
    const g = setCatalogAvailability(saved(), 'grab', 'all')
    expect(g.catalogs[2].prices).toEqual({ 'v-hot': '17.00', 'v-cold': '18.00' })
  })

  it('requires a price for every active variant in every catalog that sells the product', () => {
    let f = addVariant(saved())
    f = updateVariant(f, 'new-1', { name: 'Large', price: '15' })
    expect(messages(f)).toEqual(['Craft Cafe: enter a price for Large', 'Grab Food: enter a price for Large'])
    expect(problems(f).every((p) => p.section === 'catalogs')).toBe(true)
    f = fillCatalogBlanks(fillCatalogBlanks(f, 'cafe'), 'grab')
    expect(f.catalogs[0].prices['new-1']).toBe('15.00')
    expect(messages(f)).toEqual([])
  })

  it('ignores what is typed in a catalog that does not sell the product, and sends no prices for it', () => {
    let f = setCatalogPrice(saved(), 'cafe', 'v-hot', 'twelve')
    expect(messages(f)).toEqual(['Craft Cafe: the price of Hot is not an amount in RM'])
    f = setCatalogAvailability(f, 'cafe', 'hidden')                          // the box is disabled now
    expect(messages(f)).toEqual([])
    expect(productPayload(f, saved()).catalogs).toEqual([{ catalogId: 'cafe', availability: 'hidden', prices: [] }])
  })
})

describe('a save sends only what changed (an edit made meanwhile elsewhere survives)', () => {
  it('sends no detail and no catalog when only a variant name changed', () => {
    const p = productPayload(updateVariant(saved(), 'v-hot', { name: 'Hot drink' }), saved())
    expect(p).toEqual({
      id: 'p1',
      variants: [
        { ref: 'v-hot', id: 'v-hot', name: 'Hot drink', priceSen: 1200, isActive: true },
        { ref: 'v-cold', id: 'v-cold', name: 'Cold', priceSen: 1300, isActive: true },
        { ref: 'v-old', id: 'v-old', name: 'Large', priceSen: 1500, isActive: false },
      ],
      groupIds: ['g-milk', 'g-sugar'],
      catalogs: [],
    })
  })

  it('sends a changed detail and a changed catalog only ("17" and "17.00" are the same price)', () => {
    let f = { ...saved(), sstRateBp: 0, takeawayFee: '0.5' }
    f = setCatalogPrice(f, 'grab', 'v-hot', '17')
    expect(productPayload(f, saved())).toMatchObject({ sstRateBp: 0, catalogs: [] })
    expect(productPayload(f, saved()).name).toBeUndefined()
    f = setCatalogPrice(f, 'cafe', 'v-cold', '13.50')
    expect(productPayload(f, saved()).catalogs.map((c) => c.catalogId)).toEqual(['cafe'])
  })

  it('sends every catalog when a variant was added or switched on', () => {
    const added = productPayload(updateVariant(addVariant(saved()), 'new-1', { name: 'Large', price: '15' }), saved())
    expect(added.catalogs.map((c) => c.catalogId)).toEqual(['cafe', 'staff', 'grab'])
    const on = productPayload(updateVariant(saved(), 'v-old', { isActive: true }), saved())
    expect(on.catalogs).toHaveLength(3)
  })

  it('a new product sends everything', () => {
    const f = { ...emptyProductForm(['cafe'], 'coffee'), name: 'Mocha', variants: [{ ref: 'new-1', id: null, name: 'Regular', price: '9', isActive: true }] }
    expect(productPayload(f, f)).toMatchObject({ id: null, name: 'Mocha', categoryId: 'coffee', sstRateBp: 600, takeawayFeeSen: 0 })
  })

  it('knows when the form differs from the one loaded', () => {
    expect(productFormDirty(saved(), saved())).toBe(false)
    expect(productFormDirty({ ...saved(), name: 'Latte!' }, saved())).toBe(true)
    expect(productFormDirty(saved(), null)).toBe(true)
  })
})

describe('add-on groups', () => {
  it('adds once, removes and reorders', () => {
    let f = addGroup(saved(), 'g-milk')
    expect(f.groupIds).toEqual(['g-milk', 'g-sugar'])
    f = moveGroup(addGroup(f, 'g-syrup'), 2, -2)
    expect(f.groupIds).toEqual(['g-syrup', 'g-milk', 'g-sugar'])
    expect(removeGroup(f, 'g-milk').groupIds).toEqual(['g-syrup', 'g-sugar'])
  })
})

describe('details', () => {
  it('checks the takeaway fee and the lengths the server allows', () => {
    const f = { ...saved(), takeawayFee: '-1', internalName: 'x'.repeat(121), name: 'y'.repeat(121) }
    expect(problems(f)).toEqual([
      { section: 'details', message: 'Product name is too long (at most 120 characters)' },
      { section: 'details', message: 'Internal name is too long (at most 120 characters)' },
      { section: 'details', message: 'Enter the takeaway fee in RM, e.g. 0.50' },
    ])
  })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/menu/menuForms.test.ts src/features/pos/menu/productForm.test.ts` — Expected: FAIL, both files: `Failed to resolve import "./menuForms"` / `"./productForm"`.

- [ ] **Step 3: Implement the form modules.** Create `src/features/pos/menu/menuForms.ts`:

```ts
// src/features/pos/menu/menuForms.ts
/** Helpers every /menu form shares. The words match the server's
 *  (supabase/migration-2026-10-24-pos-menu-editor-fn.sql), so a problem reads the same
 *  whether the page or the server finds it. */
import { parseRinggit } from '../checkout/tender'

/** A name as the server stores it: trimmed, inner spaces collapsed (menu_clean_name). */
export const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').trim()

/** menu_clean_name's words, e.g. "Variant name is required". */
export function nameProblem(what: string, raw: string, max: number): string | null {
  const v = cleanName(raw)
  if (v === '') return `${what} name is required`
  if (v.length > max) return `${what} name is too long (at most ${max} characters)`
  return null
}

/** sen → what a price box shows ("12.50"). */
export const senToInput = (sen: number): string => (sen / 100).toFixed(2)

/** A price box → sen: "12", "12.5", "RM 12.50" (whole sen, up to RM 999 999.99); null otherwise. */
export const inputToSen = (text: string): number | null => parseRinggit(text)

/** The list with the item at `index` moved by `delta` places; the same list when it cannot move. */
export function moveItem<T>(list: T[], index: number, delta: number): T[] {
  const to = index + delta
  if (index < 0 || index >= list.length || to < 0 || to >= list.length || delta === 0) return list
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item)
  return next
}

/** A ref for a new row that no row uses yet: new-1, new-2, … */
export function nextRef(rows: { ref: string }[]): string {
  let n = 1
  while (rows.some((r) => r.ref === `new-${n}`)) n++
  return `new-${n}`
}
```

   Create `src/features/pos/menu/productForm.ts`:

```ts
// src/features/pos/menu/productForm.ts
/** The product editor's form: pure, so every rule is tested. The server
 *  (menu_save_product) checks all of it again with the same words; this only lets
 *  the owner see a problem next to its section before pressing Save. */
import type { Availability } from './feedmeExport'
import type { ProductDetail, ProductDetails, ProductPayload } from './menuEditorApi'
import { cleanName, inputToSen, moveItem, nameProblem, nextRef, senToInput } from './menuForms'

/** A variant row. `ref` is the variant id once saved, new-N before. Prices are box text. */
export interface VariantForm { ref: string; id: string | null; name: string; price: string; isActive: boolean }
/** One catalog: availability and the price box of each variant (by ref; blank = none). */
export interface CatalogForm { catalogId: string; availability: Availability; prices: Record<string, string> }
export interface ProductForm {
  id: string | null
  name: string
  internalName: string
  description: string
  categoryId: string | null
  sstRateBp: number
  printRoute: string | null
  takeawayFee: string
  isActive: boolean
  isAddon: boolean
  variants: VariantForm[]
  groupIds: string[]
  catalogs: CatalogForm[]
}
/** The editor's sections, top to bottom. M3 adds 'slots' and 'photo' here. */
export type ProductSection = 'details' | 'variants' | 'groups' | 'catalogs'
export interface ProductProblem { section: ProductSection; message: string }

export const MAX_VARIANTS = 30
export const MAX_GROUPS = 30

/** A new product: one active "Regular" variant, in no catalog. */
export function emptyProductForm(catalogIds: string[], categoryId: string | null = null): ProductForm {
  return {
    id: null, name: '', internalName: '', description: '', categoryId, sstRateBp: 600, printRoute: null,
    takeawayFee: '0.00', isActive: true, isAddon: false,
    variants: [{ ref: 'new-1', id: null, name: 'Regular', price: '', isActive: true }],
    groupIds: [],
    catalogs: catalogIds.map((catalogId) => ({ catalogId, availability: 'hidden', prices: {} })),
  }
}

/** The form for a saved product. Catalogs come in `catalogIds` order (the lookups'). */
export function productFormFromDetail(d: ProductDetail, catalogIds: string[]): ProductForm {
  const byCatalog = new Map(d.catalogs.map((c) => [c.catalogId, c]))
  return {
    id: d.id, name: d.name, internalName: d.internalName ?? '', description: d.description ?? '',
    categoryId: d.categoryId, sstRateBp: d.sstRateBp, printRoute: d.printRoute, takeawayFee: senToInput(d.takeawayFeeSen),
    isActive: d.isActive, isAddon: d.isAddon,
    variants: d.variants.map((v) => ({ ref: v.id, id: v.id, name: v.name, price: senToInput(v.priceSen), isActive: v.isActive })),
    groupIds: [...d.groupIds],
    catalogs: catalogIds.map((catalogId) => {
      const c = byCatalog.get(catalogId)
      const prices: Record<string, string> = {}
      for (const v of d.variants) {
        const sen = c?.prices[v.id]
        if (sen !== undefined) prices[v.id] = senToInput(sen)
      }
      return { catalogId, availability: c?.availability ?? 'hidden', prices }
    }),
  }
}

// ── variants ────────────────────────────────────────────────────────────────
export function addVariant(f: ProductForm): ProductForm {
  return { ...f, variants: [...f.variants, { ref: nextRef(f.variants), id: null, name: '', price: '', isActive: true }] }
}

export function updateVariant(f: ProductForm, ref: string, patch: Partial<Pick<VariantForm, 'name' | 'price' | 'isActive'>>): ProductForm {
  return { ...f, variants: f.variants.map((v) => (v.ref === ref ? { ...v, ...patch } : v)) }
}

export function moveVariant(f: ProductForm, index: number, delta: number): ProductForm {
  return { ...f, variants: moveItem(f.variants, index, delta) }
}

/** Only a variant that was never saved can be removed; a saved one is switched off. */
export function removeNewVariant(f: ProductForm, ref: string): ProductForm {
  if (f.variants.find((v) => v.ref === ref)?.id !== null) return f
  return {
    ...f,
    variants: f.variants.filter((v) => v.ref !== ref),
    catalogs: f.catalogs.map((c) => {
      const prices = { ...c.prices }
      delete prices[ref]
      return { ...c, prices }
    }),
  }
}

// ── add-on groups ───────────────────────────────────────────────────────────
export function addGroup(f: ProductForm, groupId: string): ProductForm {
  return f.groupIds.includes(groupId) ? f : { ...f, groupIds: [...f.groupIds, groupId] }
}
export function removeGroup(f: ProductForm, groupId: string): ProductForm {
  return { ...f, groupIds: f.groupIds.filter((g) => g !== groupId) }
}
export function moveGroup(f: ProductForm, index: number, delta: number): ProductForm {
  return { ...f, groupIds: moveItem(f.groupIds, index, delta) }
}

// ── catalogs ────────────────────────────────────────────────────────────────
function patchCatalog(f: ProductForm, catalogId: string, fn: (c: CatalogForm) => CatalogForm): ProductForm {
  return { ...f, catalogs: f.catalogs.map((c) => (c.catalogId === catalogId ? fn(c) : c)) }
}

/** Blank price boxes of active variants take the variant's default price (when it is an amount). */
function fillBlanks(f: ProductForm, c: CatalogForm): CatalogForm {
  const prices = { ...c.prices }
  for (const v of f.variants) {
    const sen = inputToSen(v.price)
    if (v.isActive && (prices[v.ref] ?? '').trim() === '' && sen !== null) prices[v.ref] = senToInput(sen)
  }
  return { ...c, prices }
}

/** Putting a product in a catalog pre-fills its blank prices with the default prices (spec §4). */
export function setCatalogAvailability(f: ProductForm, catalogId: string, availability: Availability): ProductForm {
  return patchCatalog(f, catalogId, (c) => {
    const next = { ...c, availability }
    return c.availability === 'hidden' && availability !== 'hidden' ? fillBlanks(f, next) : next
  })
}

export function setCatalogPrice(f: ProductForm, catalogId: string, ref: string, text: string): ProductForm {
  return patchCatalog(f, catalogId, (c) => ({ ...c, prices: { ...c.prices, [ref]: text } }))
}

/** "Use default prices": fills the catalog's blank boxes (e.g. after a variant was added). */
export function fillCatalogBlanks(f: ProductForm, catalogId: string): ProductForm {
  return patchCatalog(f, catalogId, (c) => fillBlanks(f, c))
}

// ── problems and payload ───────────────────────────────────────────────────
const variantLabel = (v: VariantForm) => cleanName(v.name) || 'the new variant'

/** Every problem that would stop a save, in section order. `catalogName` names a catalog. */
export function productProblems(f: ProductForm, catalogName: (id: string) => string): ProductProblem[] {
  const out: ProductProblem[] = []
  const add = (section: ProductSection, message: string | null) => { if (message) out.push({ section, message }) }

  add('details', nameProblem('Product', f.name, 120))
  if (!f.categoryId) add('details', 'Choose a category')
  if (f.internalName.trim().length > 120) add('details', 'Internal name is too long (at most 120 characters)')
  if (f.description.trim().length > 1000) add('details', 'Description is too long (at most 1000 characters)')
  if (inputToSen(f.takeawayFee) === null) add('details', 'Enter the takeaway fee in RM, e.g. 0.50')

  if (f.variants.length > MAX_VARIANTS) add('variants', `Too many variants (at most ${MAX_VARIANTS})`)
  for (const v of f.variants) {
    add('variants', nameProblem('Variant', v.name, 60))
    if (inputToSen(v.price) === null) add('variants', `Enter the default price of ${variantLabel(v)} in RM, e.g. 12.50`)
  }
  const active = f.variants.filter((v) => v.isActive)
  if (active.length === 0) add('variants', 'A product needs at least one active variant')
  const first = new Map<string, string>()                    // lower-case name → the first variant's name
  for (const v of active) {
    const key = cleanName(v.name).toLowerCase()
    if (!key) continue
    if (first.has(key)) add('variants', `Two variants are called ${first.get(key)}`)
    else first.set(key, cleanName(v.name))
  }

  if (f.groupIds.length > MAX_GROUPS) add('groups', `Too many add-on groups (at most ${MAX_GROUPS})`)

  // only boxes the owner can see count: a catalog that sells the product, an active variant
  for (const c of f.catalogs) {
    if (c.availability === 'hidden') continue
    for (const v of active) {
      const text = (c.prices[v.ref] ?? '').trim()
      if (text === '') add('catalogs', `${catalogName(c.catalogId)}: enter a price for ${variantLabel(v)}`)
      else if (inputToSen(text) === null) add('catalogs', `${catalogName(c.catalogId)}: the price of ${variantLabel(v)} is not an amount in RM`)
    }
  }
  return out
}

/** A catalog's price boxes as sen, for comparing (a blank or hidden box counts as no price). */
function catalogKey(f: ProductForm, c: CatalogForm | undefined): string {
  if (!c) return ''
  const prices = c.availability === 'hidden' ? [] : f.variants.filter((v) => v.isActive)
    .map((v) => `${v.ref}=${inputToSen((c.prices[v.ref] ?? '').trim()) ?? ''}`)
  return `${c.availability}|${prices.join(',')}`
}

/** The product's own fields as menu_save_product takes them. */
function details(f: ProductForm, sen: (text: string) => number): ProductDetails {
  return {
    name: cleanName(f.name),
    internalName: f.internalName.trim() || null,
    description: f.description.trim() || null,
    categoryId: f.categoryId,
    sstRateBp: f.sstRateBp,
    printRoute: f.printRoute,
    takeawayFeeSen: sen(f.takeawayFee),
    isActive: f.isActive,
    isAddon: f.isAddon,
  }
}

/** The form differs from the one loaded (the editor then warns before the page is left). */
export function productFormDirty(f: ProductForm, loaded: ProductForm | null): boolean {
  return loaded === null || JSON.stringify(f) !== JSON.stringify(loaded)
}

/** What menu_save_product takes. Call it only when productProblems() is empty.
 *  For a saved product (`loaded` = the form as it was loaded) only the details and the
 *  catalogs the owner changed are sent — plus every catalog when a variant was added or
 *  switched on — so a save never undoes what the Products or catalog page changed
 *  meanwhile. Every variant is always sent. Hidden catalogs and switched-off variants
 *  send no prices (their boxes are not shown). */
export function productPayload(f: ProductForm, loaded: ProductForm | null = null): ProductPayload {
  const sen = (text: string): number => {
    const v = inputToSen(text)
    if (v === null) throw new Error(`"${text}" is not an amount in RM`)
    return v
  }
  const isNew = f.id === null || loaded === null
  const mine = details(f, sen)
  let changed: Partial<ProductDetails> = mine
  if (!isNew) {
    const before = details(loaded, (t) => inputToSen(t) ?? -1)
    changed = Object.fromEntries((Object.keys(mine) as (keyof ProductDetails)[])
      .filter((k) => mine[k] !== before[k]).map((k) => [k, mine[k]])) as Partial<ProductDetails>
  }
  const wasOn = new Set(loaded?.variants.filter((v) => v.isActive).map((v) => v.ref) ?? [])
  const variantsGrew = f.variants.some((v) => v.isActive && !wasOn.has(v.ref))
  const catalogs = isNew || variantsGrew
    ? f.catalogs
    : f.catalogs.filter((c) => catalogKey(f, c) !== catalogKey(loaded, loaded.catalogs.find((x) => x.catalogId === c.catalogId)))
  return {
    id: f.id,
    ...changed,
    variants: f.variants.map((v) => ({ ref: v.ref, id: v.id, name: cleanName(v.name), priceSen: sen(v.price), isActive: v.isActive })),
    groupIds: [...f.groupIds],
    catalogs: catalogs.map((c) => ({
      catalogId: c.catalogId,
      availability: c.availability,
      prices: c.availability === 'hidden' ? [] : f.variants.flatMap((v) => {
        const text = (c.prices[v.ref] ?? '').trim()
        return !v.isActive || text === '' ? [] : [{ ref: v.ref, priceSen: sen(text) }]
      }),
    })),
  }
}
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/features/pos/menu/menuForms.test.ts src/features/pos/menu/productForm.test.ts` — Expected: PASS, 6 + 17 tests.

- [ ] **Step 5: The sections.** Create `src/features/pos/menu/product/DetailsSection.tsx`:

```tsx
// src/features/pos/menu/product/DetailsSection.tsx
import type { LookupCategory } from '../menuEditorApi'
import type { ProductForm } from '../productForm'
import { PRINT_ROUTES, SST_CHOICES } from '../menuView'
import { Section, inputCls } from '../editorUi'

/** Name, category, on/off, SST, print route and takeaway fee: the same in every catalog. */
export default function DetailsSection({ form, onChange, categories, problem }: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  categories: LookupCategory[]
  problem: string | null
}) {
  const set = (patch: Partial<ProductForm>) => onChange({ ...form, ...patch })
  // active categories, plus the product's own even when it is switched off
  const choices = categories.filter((c) => c.isActive || c.id === form.categoryId)
  const routes: string[] = [...PRINT_ROUTES]
  if (form.printRoute && !routes.includes(form.printRoute)) routes.push(form.printRoute)
  return (
    <Section title="Details" hint="These apply in every catalog." problem={problem}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">Name
          <input className={`${inputCls} mt-1 w-full`} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="block text-sm">Internal name <span className="text-brown-muted">(optional)</span>
          <input className={`${inputCls} mt-1 w-full`} value={form.internalName} onChange={(e) => set({ internalName: e.target.value })} />
        </label>
        <label className="block text-sm sm:col-span-2">Description <span className="text-brown-muted">(optional, shown on QR)</span>
          <textarea className={`${inputCls} mt-1 w-full`} rows={2} value={form.description}
            onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className="block text-sm">Category
          <select className={`${inputCls} mt-1 w-full`} value={form.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || null })}>
            <option value="">Choose…</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (off)'}</option>)}
          </select>
        </label>
        <label className="block text-sm">Print route
          <select className={`${inputCls} mt-1 w-full`} value={form.printRoute ?? ''} onChange={(e) => set({ printRoute: e.target.value || null })}>
            <option value="">Not printed</option>
            {routes.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="block text-sm">SST
          <select className={`${inputCls} mt-1 w-full`} value={form.sstRateBp} onChange={(e) => set({ sstRateBp: Number(e.target.value) })}>
            {SST_CHOICES.map((c) => <option key={c.bp} value={c.bp}>{c.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">Takeaway packaging fee (RM)
          <input className={`${inputCls} mt-1 w-full`} inputMode="decimal" value={form.takeawayFee}
            onChange={(e) => set({ takeawayFee: e.target.value })} />
        </label>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
          On sale (a switched-off product is hidden in every catalog)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={form.isAddon} onChange={(e) => set({ isAddon: e.target.checked })} />
          Add-on item (sold only as an option of an add-on group)
        </label>
      </div>
    </Section>
  )
}
```

   Create `src/features/pos/menu/product/VariantsSection.tsx`:

```tsx
// src/features/pos/menu/product/VariantsSection.tsx
import { MAX_VARIANTS, addVariant, moveVariant, removeNewVariant, updateVariant, type ProductForm } from '../productForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** Variants in their order on the pad. A saved variant is never deleted (orders name
 *  it): it is switched off. The default price pre-fills a catalog's price. */
export default function VariantsSection({ form, onChange, problem }: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  problem: string | null
}) {
  return (
    <Section title="Variants"
      hint="The default price fills in a catalog's price when the product is put in that catalog. A saved variant cannot be deleted — switch it off."
      problem={problem}>
      <table className="w-full text-sm">
        <thead className="text-left text-brown-muted">
          <tr><th className="py-1">Name</th><th className="py-1">Default price (RM)</th><th className="py-1">On</th><th /></tr>
        </thead>
        <tbody>
          {form.variants.map((v, i) => (
            <tr key={v.ref} className="border-t border-border">
              <td className="py-1 pr-2">
                <input className={`${inputCls} w-full`} value={v.name} placeholder="e.g. Hot"
                  onChange={(e) => onChange(updateVariant(form, v.ref, { name: e.target.value }))} />
              </td>
              <td className="py-1 pr-2">
                <input className={`${inputCls} w-28`} inputMode="decimal" value={v.price}
                  onChange={(e) => onChange(updateVariant(form, v.ref, { price: e.target.value }))} />
              </td>
              <td className="py-1 pr-2">
                <input type="checkbox" aria-label={`${v.name || 'Variant'} on`} checked={v.isActive}
                  onChange={(e) => onChange(updateVariant(form, v.ref, { isActive: e.target.checked }))} />
              </td>
              <td className="whitespace-nowrap py-1 text-right">
                <button type="button" className={linkBtnCls} disabled={i === 0} aria-label="Move up"
                  onClick={() => onChange(moveVariant(form, i, -1))}>↑</button>{' '}
                <button type="button" className={linkBtnCls} disabled={i === form.variants.length - 1} aria-label="Move down"
                  onClick={() => onChange(moveVariant(form, i, 1))}>↓</button>{' '}
                {v.id === null && (
                  <button type="button" className={linkBtnCls} onClick={() => onChange(removeNewVariant(form, v.ref))}>Remove</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={linkBtnCls} disabled={form.variants.length >= MAX_VARIANTS}
        onClick={() => onChange(addVariant(form))}>Add variant</button>
    </Section>
  )
}
```

   Create `src/features/pos/menu/product/GroupsSection.tsx`:

```tsx
// src/features/pos/menu/product/GroupsSection.tsx
import { Link } from 'react-router-dom'
import type { LookupGroup } from '../menuEditorApi'
import { MAX_GROUPS, addGroup, moveGroup, removeGroup, type ProductForm } from '../productForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** The add-on groups the pad and QR offer with this product, in their order. */
export default function GroupsSection({ form, onChange, groups, problem }: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  groups: LookupGroup[]
  problem: string | null
}) {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const unlinked = groups.filter((g) => !form.groupIds.includes(g.id))
  return (
    <Section title="Add-on groups" hint="Edit a group's options and prices on the Add-on groups page." problem={problem}>
      {form.groupIds.length === 0 && <p className="text-sm text-brown-muted">No add-on groups.</p>}
      <ul className="space-y-1 text-sm">
        {form.groupIds.map((id, i) => {
          const g = byId.get(id)
          return (
            <li key={id} className="flex items-center gap-2">
              <span className="flex-1">
                {g ? <Link to={`/menu/groups/${id}`} className="hover:underline">{g.name}</Link> : 'Unknown group'}
                {g && <span className="ml-2 text-xs text-brown-muted">choose {g.min}–{g.max}{g.isActive ? '' : ' · off'}</span>}
              </span>
              <button type="button" className={linkBtnCls} disabled={i === 0} aria-label="Move up"
                onClick={() => onChange(moveGroup(form, i, -1))}>↑</button>
              <button type="button" className={linkBtnCls} disabled={i === form.groupIds.length - 1} aria-label="Move down"
                onClick={() => onChange(moveGroup(form, i, 1))}>↓</button>
              <button type="button" className={linkBtnCls} onClick={() => onChange(removeGroup(form, id))}>Remove</button>
            </li>
          )
        })}
      </ul>
      <select className={inputCls} value="" disabled={form.groupIds.length >= MAX_GROUPS}
        onChange={(e) => e.target.value && onChange(addGroup(form, e.target.value))}>
        <option value="">Add an add-on group…</option>
        {unlinked.map((g) => <option key={g.id} value={g.id}>{g.name}{g.isActive ? '' : ' (off)'}</option>)}
      </select>
    </Section>
  )
}
```

   Create `src/features/pos/menu/product/CatalogsSection.tsx`:

```tsx
// src/features/pos/menu/product/CatalogsSection.tsx
import type { Availability } from '../feedmeExport'
import type { LookupCatalog } from '../menuEditorApi'
import { CATALOG_AVAILABILITY_LABELS } from '../menuView'
import { fillCatalogBlanks, setCatalogAvailability, setCatalogPrice, type ProductForm } from '../productForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** One row per catalog: does it sell the product, on which channel, at what price per
 *  active variant. Putting the product in a catalog pre-fills the default prices. */
export default function CatalogsSection({ form, onChange, catalogs, problem }: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  catalogs: LookupCatalog[]
  problem: string | null
}) {
  const byId = new Map(catalogs.map((c) => [c.id, c]))
  const variants = form.variants.filter((v) => v.isActive)
  return (
    <Section title="Catalogs"
      hint="Each catalog sells the product at its own prices. A catalog that sells it needs a price for every active variant."
      problem={problem}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-brown-muted">
            <tr>
              <th className="py-1 pr-2">Catalog</th>
              <th className="py-1 pr-2">Sells it</th>
              {variants.map((v) => <th key={v.ref} className="py-1 pr-2">{v.name || 'New variant'} (RM)</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {form.catalogs.map((c) => {
              const cat = byId.get(c.catalogId)
              const sells = c.availability !== 'hidden'
              const blanks = sells && variants.some((v) => (c.prices[v.ref] ?? '').trim() === '')
              return (
                <tr key={c.catalogId} className={`border-t border-border ${cat?.isActive === false ? 'text-brown-faint' : ''}`}>
                  <td className="py-1 pr-2">{cat?.name ?? 'Unknown catalog'}{cat?.isActive === false ? ' (off)' : ''}</td>
                  <td className="py-1 pr-2">
                    <select className={inputCls} value={c.availability}
                      onChange={(e) => onChange(setCatalogAvailability(form, c.catalogId, e.target.value as Availability))}>
                      {(Object.keys(CATALOG_AVAILABILITY_LABELS) as Availability[]).map((a) => (
                        <option key={a} value={a}>{CATALOG_AVAILABILITY_LABELS[a]}</option>
                      ))}
                    </select>
                  </td>
                  {variants.map((v) => (
                    <td key={v.ref} className="py-1 pr-2">
                      <input className={`${inputCls} w-24`} inputMode="decimal" disabled={!sells}
                        aria-label={`${cat?.name ?? 'Catalog'} price of ${v.name}`}
                        value={c.prices[v.ref] ?? ''}
                        onChange={(e) => onChange(setCatalogPrice(form, c.catalogId, v.ref, e.target.value))} />
                    </td>
                  ))}
                  <td className="py-1 text-right">
                    {blanks && (
                      <button type="button" className={linkBtnCls} onClick={() => onChange(fillCatalogBlanks(form, c.catalogId))}>
                        Use default prices
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Section>
  )
}
```

- [ ] **Step 6: The page and its routes.** Create `src/features/pos/menu/ProductEditorPage.tsx`:

```tsx
// src/features/pos/menu/ProductEditorPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchLookups, fetchProductDetail, saveProduct, type MenuLookups } from './menuEditorApi'
import {
  emptyProductForm, productFormDirty, productFormFromDetail, productPayload, productProblems, type ProductForm, type ProductSection,
} from './productForm'
import MenuTabs from './MenuTabs'
import DetailsSection from './product/DetailsSection'
import VariantsSection from './product/VariantsSection'
import GroupsSection from './product/GroupsSection'
import CatalogsSection from './product/CatalogsSection'
import { OutcomeLine, btnCls, errorText, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'

/** /menu/products/new and /menu/products/:id. Everything is saved at once by
 *  menu_save_product (one transaction); a problem shows in its own section, the
 *  outcome next to Save. The route remounts this page per product (MenuRoutes keys it). */
export default function ProductEditorPage({ productId }: { productId: string | null }) {
  const navigate = useNavigate()
  const savedNotice = useSavedNotice()
  const [lookups, setLookups] = useState<MenuLookups | null>(null)
  const [form, setForm] = useState<ProductForm | null>(null)
  const [loaded, setLoaded] = useState<ProductForm | null>(null)    // the form as loaded: a save sends only changes
  const [feedmeId, setFeedmeId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tried, setTried] = useState(false)                          // problems show after the first Save
  const [outcome, setOutcome] = useState<Outcome | null>(savedNotice ? { kind: 'ok', text: savedNotice } : null)
  const loadSeq = useRef(0)

  /** Loads lookups and the product; a reply to an older load is dropped. */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const [l, d] = await Promise.all([fetchLookups(), productId ? fetchProductDetail(productId) : Promise.resolve(null)])
    if (seq !== loadSeq.current) return
    const ids = l.catalogs.map((c) => c.id)
    setLookups(l)
    setFeedmeId(d?.feedmeProductId ?? null)
    const f = d ? productFormFromDetail(d, ids) : emptyProductForm(ids)
    setForm(f)
    setLoaded(d ? f : null)
    setLoadError(null)
  }, [productId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const change = (next: ProductForm) => { setForm(next); setOutcome(null) }
  const catalogName = (id: string) => lookups?.catalogs.find((c) => c.id === id)?.name ?? 'A catalog'
  const problems = form ? productProblems(form, catalogName) : []
  useUnsavedWarning(!!form && !saving && productFormDirty(form, loaded) && (loaded !== null || form.name.trim() !== ''))
  const problemOf = (section: ProductSection) => (tried ? problems.find((p) => p.section === section)?.message ?? null : null)

  const save = async () => {
    if (!form || saving) return
    setTried(true)
    if (problems.length > 0) { setOutcome({ kind: 'error', text: 'Not saved — fix the problems marked above.' }); return }
    setSaving(true)
    setOutcome(null)
    try {
      const id = await saveProduct(productPayload(form, loaded))
      if (!form.id) {
        navigate(`/menu/products/${id}`, { replace: true, state: { saved: 'Product created' } })
        return
      }
      try {
        await load()
        setTried(false)
        setOutcome({ kind: 'ok', text: 'Saved' })
      } catch (e) {
        setOutcome({ kind: 'error', text: `Saved, but reloading failed: ${errorText(e)}` })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{productId ? form?.name || 'Product' : 'New product'}</h1>
        <Link to="/menu" className="text-sm underline">Back to products</Link>
      </div>
      {feedmeId && (
        <p className="text-xs text-brown-muted">
          Imported from Feedme. Craft OS is the master of the menu: importing again overwrites what you change here.
        </p>
      )}
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={() => load().catch((e) => setLoadError(errorText(e)))}>Try again</button>
        </div>
      )}
      {!form || !lookups ? (!loadError && <p className="text-sm">Loading…</p>) : (
        <>
          {/* Sections top to bottom. M3 adds "Time slots" after Add-on groups and "Photo" after Details. */}
          <DetailsSection form={form} onChange={change} categories={lookups.categories} problem={problemOf('details')} />
          <VariantsSection form={form} onChange={change} problem={problemOf('variants')} />
          <GroupsSection form={form} onChange={change} groups={lookups.groups} problem={problemOf('groups')} />
          <CatalogsSection form={form} onChange={change} catalogs={lookups.catalogs} problem={problemOf('catalogs')} />
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-cream py-3">
            <button className={btnCls} disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : form.id ? 'Save product' : 'Create product'}
            </button>
            <OutcomeLine outcome={outcome} />
          </div>
        </>
      )}
    </div>
  )
}
```

   Replace `src/features/pos/menu/MenuRoutes.tsx` with:

```tsx
// src/features/pos/menu/MenuRoutes.tsx
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import ProductListPage from './ProductListPage'
import ProductEditorPage from './ProductEditorPage'
import MenuImportPage from './MenuImportPage'

/** A fresh editor per product: nothing typed for one product can leak into another. */
function ProductEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <ProductEditorPage key={id ?? 'new'} productId={id ?? null} />
}

/** Everything under /menu (App.tsx gates it on Edit menu). */
export default function MenuRoutes() {
  return (
    <Routes>
      <Route index element={<ProductListPage />} />
      <Route path="products/new" element={<ProductEditorRoute />} />
      <Route path="products/:id" element={<ProductEditorRoute />} />
      <Route path="import" element={<MenuImportPage />} />
      <Route path="*" element={<Navigate to="/menu" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 7: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 87 files, 757 tests pass. Run: `wc -l src/features/pos/menu/*.ts* src/features/pos/menu/product/*.tsx | sort -n | tail -4` — Expected: no file of this plan over ~250 lines (`feedmeExport.ts` is M1's).

- [ ] **Step 8: Commit**

```bash
git add src/features/pos/menu
git commit -m "feat(pos-menu): product editor — details, variants, add-on groups and every catalog's prices saved in one transaction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9 (controller, craft-os-dev — browser on the dev server and the SQL editor; the implementer does not touch the database):** **Products → New product**. Press **Create product** at once → under Details "Product name is required", under Variants "Enter the default price of Regular in RM, e.g. 12.50", and next to the button "Not saved — fix the problems marked above."; nothing is created. Fill: name `[TEST] Iced Latte`, a drinks category, print route Bar; variants: rename Regular → `Hot` RM `12`, **Add variant** `Cold` RM `13`. Catalogs: **Craft Cafe → Counter + QR** (the boxes fill with 12.00 / 13.00), change Hot to `12.50`; **Grab Food → Counter only**, type `17` and `18`. Clear Grab Food's Cold box → Create → under Catalogs "Grab Food: enter a price for Cold"; type `18` again → **Create product** → the URL becomes `/menu/products/<id>`, "Product created" next to the button, the form shows both variants and both catalogs. SQL: `select name, feedme_variant_key, price_sen from menu_variants where product_id = '<id>' order by sort_order` → Hot 1200 and Cold 1300, both keys `cos-…`; `select c.name, cp.availability from catalog_products cp join menu_catalogs c on c.id = cp.catalog_id where cp.product_id = '<id>'` → Craft Cafe `all`, Grab Food `counter_only`. **Order it at the counter in each catalog:** `/pos` (Demo branch, where Grab Food is an additional catalog from M1) → a table → Craft Cafe → `[TEST] Iced Latte` Hot → RM 12.50 → send; new order on the same table → switch to **Grab Food** → Hot → RM 17.00 → send; the bill shows `[TEST] Iced Latte (Hot)` at 12.50 and at 17.00. Back in the editor set Craft Cafe Hot to `13.00` → **Save product** → "Saved"; order Hot in Craft Cafe again → RM 13.00, and the first line on the bill still says 12.50. Reload the editor → "Product created" does not come back. Type in the name box, then try to close the tab → the browser asks first; undo the typing. Leave the product on for Tasks 6–8.

---

### Task 6: Add-on groups — options, defaults, min/max, a price per catalog

**Files:**
- Create: `src/features/pos/menu/groupForm.ts`, `src/features/pos/menu/GroupListPage.tsx`, `src/features/pos/menu/GroupEditorPage.tsx`, `src/features/pos/menu/group/OptionsSection.tsx`
- Modify: `src/features/pos/menu/MenuRoutes.tsx`
- Test: `src/features/pos/menu/groupForm.test.ts`

**Interfaces:**
- Consumes: `fetchLookups`, `fetchGroupDetail`, `saveGroup` (Task 4); `menuForms` (Task 5).
- Produces: `GroupForm`, `OptionForm`, `GroupSection`, `OPTION_AVAILABILITY_LABELS`, `emptyGroupForm`, `groupFormFromDetail`, `groupProblems`, `groupPayload` and the edit helpers; routes `/menu/groups`, `/menu/groups/new`, `/menu/groups/:id`.

- [ ] **Step 1: Write the failing test.** Create `src/features/pos/menu/groupForm.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  addOption, emptyGroupForm, groupFormFromDetail, groupPayload, groupProblems, moveOption, removeNewOption,
  setOptionCatalogPrice, updateOption, type GroupForm,
} from './groupForm'
import type { GroupDetail } from './menuEditorApi'

const catalogName = (id: string) => ({ grab: 'Grab Food', cafe: 'Craft Cafe' } as Record<string, string>)[id] ?? id
const messages = (f: GroupForm) => groupProblems(f, catalogName).map((p) => p.message)

const detail: GroupDetail = {
  id: 'g1', name: 'Milk', min: 0, max: 1, stackable: false, isActive: true, feedmeGroupId: 'fg-1',
  options: [
    { id: 'o-full', name: 'Full cream', priceDeltaSen: 0, productId: null, isDefault: true, availability: 'all', catalogPrices: {} },
    { id: 'o-oat', name: 'Oat milk', priceDeltaSen: 200, productId: 'p-oat', isDefault: false, availability: 'all', catalogPrices: { grab: 300 } },
  ],
  usedBy: [{ id: 'p1', name: 'Latte' }],
}
const saved = () => groupFormFromDetail(detail)

describe('the form of a saved group', () => {
  it('shows prices as RM text, catalog overrides by catalog, and has no problems', () => {
    const f = saved()
    expect(f.min).toBe('0')
    expect(f.options[1]).toEqual({
      ref: 'o-oat', id: 'o-oat', name: 'Oat milk', price: '2.00', productId: 'p-oat', isDefault: false,
      availability: 'all', catalogPrices: { grab: '3.00' },
    })
    expect(messages(f)).toEqual([])
  })

  it('turns back into the payload: the overrides typed are the whole set', () => {
    let f = setOptionCatalogPrice(saved(), 'o-full', 'cafe', '0.50')
    f = setOptionCatalogPrice(f, 'o-oat', 'grab', '')                        // blank = back to the option's own price
    expect(groupPayload(f)).toEqual({
      id: 'g1', name: 'Milk', min: 0, max: 1, stackable: false, isActive: true,
      options: [
        { ref: 'o-full', id: 'o-full', name: 'Full cream', priceDeltaSen: 0, productId: null, isDefault: true, availability: 'all' },
        { ref: 'o-oat', id: 'o-oat', name: 'Oat milk', priceDeltaSen: 200, productId: 'p-oat', isDefault: false, availability: 'all' },
      ],
      catalogPrices: [{ catalogId: 'cafe', ref: 'o-full', priceDeltaSen: 50 }],
    })
  })
})

describe('options', () => {
  it('adds a blank option or one named after an add-on item, and moves it', () => {
    let f = addOption(saved())
    expect(f.options[2]).toMatchObject({ ref: 'new-1', id: null, name: '', price: '0.00', productId: null, availability: 'all' })
    f = addOption(f, { id: 'p-soy', name: 'Soy milk' })
    expect(f.options[3]).toMatchObject({ ref: 'new-2', name: 'Soy milk', productId: 'p-soy' })
    expect(moveOption(f, 3, -3).options.map((o) => o.ref)).toEqual(['new-2', 'o-full', 'o-oat', 'new-1'])
  })

  it('removes only an unsaved option; a saved one is switched off instead', () => {
    const f = addOption(saved())
    expect(removeNewOption(f, 'new-1').options).toHaveLength(2)
    expect(removeNewOption(f, 'o-oat')).toBe(f)
  })

  it('needs a name and an amount, keeps defaults on and within max, and checks typed catalog prices', () => {
    let f = updateOption(addOption(saved()), 'new-1', { price: 'free' })
    expect(messages(f)).toEqual(['Option name is required', 'Enter the price of the new option in RM, e.g. 1.00'])
    f = updateOption(saved(), 'o-full', { availability: 'hidden' })
    expect(messages(f)).toEqual(['A switched-off option cannot be the default: Full cream'])
    f = updateOption(saved(), 'o-oat', { isDefault: true })
    expect(messages(f)).toEqual(['At most 1 option can be the default'])
    f = { ...updateOption(saved(), 'o-oat', { isDefault: true }), max: '1' }
    expect(groupProblems(f, catalogName).every((p) => p.section === 'options')).toBe(true)
    f = setOptionCatalogPrice(saved(), 'o-oat', 'grab', '3.333')
    expect(messages(f)).toEqual(['Grab Food: the price of Oat milk is not an amount in RM'])
  })
})

describe('min and max', () => {
  it('uses the server\'s words', () => {
    expect(messages({ ...saved(), min: '-1' })).toEqual(['Min must be a whole number from 0 to 99'])
    expect(messages({ ...saved(), min: '1.5' })).toEqual(['Min must be a whole number from 0 to 99'])
    expect(messages({ ...saved(), max: '0' })).toEqual(['Max must be a whole number from 1 to 99'])
    expect(messages({ ...saved(), min: '100', max: '100' })).toEqual([
      'Min must be a whole number from 0 to 99', 'Max must be a whole number from 1 to 99',
    ])
    expect(messages({ ...saved(), min: '2', max: '1' })).toEqual(['Min cannot be more than max'])
  })

  it('min cannot ask for more options than are on (only for a group that is on)', () => {
    expect(messages({ ...saved(), min: '3', max: '3' })).toEqual(['Min is 3 but only 2 options are on'])
    const one = updateOption(saved(), 'o-oat', { availability: 'hidden' })
    expect(messages({ ...one, min: '2', max: '2' })).toEqual(['Min is 2 but only 1 option is on'])
    expect(messages({ ...one, min: '2', max: '2', isActive: false })).toEqual([])
  })

  it('a new group starts at choose 0–1 and only needs a name', () => {
    expect(messages(emptyGroupForm())).toEqual(['Add-on group name is required'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run src/features/pos/menu/groupForm.test.ts` — Expected: FAIL, `Failed to resolve import "./groupForm"`.

- [ ] **Step 3: Implement.** Create `src/features/pos/menu/groupForm.ts`:

```ts
// src/features/pos/menu/groupForm.ts
/** The add-on group editor's form: pure, so every rule is tested. menu_save_group
 *  checks all of it again with the same words. An option is never deleted (orders
 *  name it): it is switched off ('hidden'). */
import type { Availability } from './feedmeExport'
import type { GroupDetail, GroupPayload } from './menuEditorApi'
import { cleanName, inputToSen, moveItem, nameProblem, nextRef, senToInput } from './menuForms'

/** An option row. Catalog prices are box text by catalog id; blank = the option's own price. */
export interface OptionForm {
  ref: string
  id: string | null
  name: string
  price: string
  productId: string | null
  isDefault: boolean
  availability: Availability
  catalogPrices: Record<string, string>
}
export interface GroupForm {
  id: string | null
  name: string
  min: string
  max: string
  stackable: boolean
  isActive: boolean
  options: OptionForm[]
}
export type GroupSection = 'details' | 'options'
export interface GroupProblem { section: GroupSection; message: string }

export const MAX_OPTIONS = 100
export const OPTION_AVAILABILITY_LABELS: Record<Availability, string> = {
  all: 'Counter + QR',
  counter_only: 'Counter only',
  hidden: 'Off',
}

export function emptyGroupForm(): GroupForm {
  return { id: null, name: '', min: '0', max: '1', stackable: false, isActive: true, options: [] }
}

export function groupFormFromDetail(d: GroupDetail): GroupForm {
  return {
    id: d.id, name: d.name, min: String(d.min), max: String(d.max), stackable: d.stackable, isActive: d.isActive,
    options: d.options.map((o) => ({
      ref: o.id, id: o.id, name: o.name, price: senToInput(o.priceDeltaSen), productId: o.productId,
      isDefault: o.isDefault, availability: o.availability,
      catalogPrices: Object.fromEntries(Object.entries(o.catalogPrices).map(([c, sen]) => [c, senToInput(sen)])),
    })),
  }
}

/** A new option; picking an add-on item names the option after it. */
export function addOption(f: GroupForm, addOn: { id: string; name: string } | null = null): GroupForm {
  return {
    ...f,
    options: [...f.options, {
      ref: nextRef(f.options), id: null, name: addOn?.name ?? '', price: '0.00', productId: addOn?.id ?? null,
      isDefault: false, availability: 'all', catalogPrices: {},
    }],
  }
}

export function updateOption(
  f: GroupForm, ref: string, patch: Partial<Pick<OptionForm, 'name' | 'price' | 'productId' | 'isDefault' | 'availability'>>,
): GroupForm {
  return { ...f, options: f.options.map((o) => (o.ref === ref ? { ...o, ...patch } : o)) }
}

export function moveOption(f: GroupForm, index: number, delta: number): GroupForm {
  return { ...f, options: moveItem(f.options, index, delta) }
}

/** Only an option that was never saved can be removed; a saved one is switched off. */
export function removeNewOption(f: GroupForm, ref: string): GroupForm {
  if (f.options.find((o) => o.ref === ref)?.id !== null) return f
  return { ...f, options: f.options.filter((o) => o.ref !== ref) }
}

export function setOptionCatalogPrice(f: GroupForm, ref: string, catalogId: string, text: string): GroupForm {
  return { ...f, options: f.options.map((o) => (o.ref === ref ? { ...o, catalogPrices: { ...o.catalogPrices, [catalogId]: text } } : o)) }
}

const whole = (text: string): number | null => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : null)
const optionLabel = (o: OptionForm) => cleanName(o.name) || 'the new option'

/** Every problem that would stop a save, in section order. */
export function groupProblems(f: GroupForm, catalogName: (id: string) => string): GroupProblem[] {
  const out: GroupProblem[] = []
  const add = (section: GroupSection, message: string | null) => { if (message) out.push({ section, message }) }
  const min = whole(f.min)
  const max = whole(f.max)
  const on = f.options.filter((o) => o.availability !== 'hidden').length

  add('details', nameProblem('Add-on group', f.name, 80))
  if (min === null) add('details', 'Min must be a whole number from 0 to 99')
  if (max === null || max < 1) add('details', 'Max must be a whole number from 1 to 99')
  if (min !== null && max !== null && max >= 1) {
    if (min > max) add('details', 'Min cannot be more than max')
    else if (f.isActive && min > on) add('details', `Min is ${min} but only ${on} ${on === 1 ? 'option is' : 'options are'} on`)
  }

  if (f.options.length > MAX_OPTIONS) add('options', `Too many options (at most ${MAX_OPTIONS})`)
  for (const o of f.options) {
    add('options', nameProblem('Option', o.name, 80))
    if (inputToSen(o.price) === null) add('options', `Enter the price of ${optionLabel(o)} in RM, e.g. 1.00`)
    if (o.isDefault && o.availability === 'hidden') add('options', `A switched-off option cannot be the default: ${optionLabel(o)}`)
    for (const [catalogId, text] of Object.entries(o.catalogPrices)) {
      if (text.trim() !== '' && inputToSen(text) === null) {
        add('options', `${catalogName(catalogId)}: the price of ${optionLabel(o)} is not an amount in RM`)
      }
    }
  }
  const defaults = f.options.filter((o) => o.isDefault).length
  if (max !== null && max >= 1 && defaults > max) {
    add('options', `At most ${max} ${max === 1 ? 'option can be' : 'options can be'} the default`)
  }
  return out
}

/** What menu_save_group takes. Call it only when groupProblems() is empty. */
export function groupPayload(f: GroupForm): GroupPayload {
  const sen = (text: string): number => {
    const v = inputToSen(text)
    if (v === null) throw new Error(`"${text}" is not an amount in RM`)
    return v
  }
  return {
    id: f.id,
    name: cleanName(f.name),
    min: Number(f.min.trim()),
    max: Number(f.max.trim()),
    stackable: f.stackable,
    isActive: f.isActive,
    options: f.options.map((o) => ({
      ref: o.ref, id: o.id, name: cleanName(o.name), priceDeltaSen: sen(o.price), productId: o.productId,
      isDefault: o.isDefault, availability: o.availability,
    })),
    catalogPrices: f.options.flatMap((o) =>
      Object.entries(o.catalogPrices)
        .filter(([, text]) => text.trim() !== '')
        .map(([catalogId, text]) => ({ catalogId, ref: o.ref, priceDeltaSen: sen(text) }))),
  }
}
```

- [ ] **Step 4: Run the test.** Run: `npx vitest run src/features/pos/menu/groupForm.test.ts` — Expected: PASS, 8 tests.

- [ ] **Step 5: The pages.** Create `src/features/pos/menu/group/OptionsSection.tsx`:

```tsx
// src/features/pos/menu/group/OptionsSection.tsx
import { Fragment, useState } from 'react'
import type { Availability } from '../feedmeExport'
import type { LookupAddOn, LookupCatalog } from '../menuEditorApi'
import {
  MAX_OPTIONS, OPTION_AVAILABILITY_LABELS, addOption, moveOption, removeNewOption, setOptionCatalogPrice, updateOption,
  type GroupForm,
} from '../groupForm'
import { Section, inputCls, linkBtnCls } from '../editorUi'

/** The options in their order, each with its own price and, behind "Catalog prices",
 *  a price per catalog (blank = the option's own price). */
export default function OptionsSection({ form, onChange, addOns, catalogs, problem }: {
  form: GroupForm
  onChange: (f: GroupForm) => void
  addOns: LookupAddOn[]
  catalogs: LookupCatalog[]
  problem: string | null
}) {
  const [open, setOpen] = useState<string | null>(null)                    // the option showing its catalog prices
  const addOnName = new Map(addOns.map((a) => [a.id, a.name]))
  return (
    <Section title="Options"
      hint="An add-on item links the option to a product: its sold-out switch and print route then apply. A saved option cannot be deleted — switch it off."
      problem={problem}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-brown-muted">
            <tr>
              <th className="py-1 pr-2">Name</th><th className="py-1 pr-2">Add-on item</th><th className="py-1 pr-2">Price (RM)</th>
              <th className="py-1 pr-2">Default</th><th className="py-1 pr-2">Offered</th><th />
            </tr>
          </thead>
          <tbody>
            {form.options.map((o, i) => (
              <Fragment key={o.ref}>
                <tr className="border-t border-border">
                  <td className="py-1 pr-2">
                    <input className={`${inputCls} w-full`} value={o.name}
                      onChange={(e) => onChange(updateOption(form, o.ref, { name: e.target.value }))} />
                  </td>
                  <td className="py-1 pr-2">
                    <select className={inputCls} value={o.productId ?? ''}
                      onChange={(e) => onChange(updateOption(form, o.ref, { productId: e.target.value || null }))}>
                      <option value="">None</option>
                      {o.productId && !addOnName.has(o.productId) && <option value={o.productId}>(not an add-on item)</option>}
                      {addOns.map((a) => <option key={a.id} value={a.id}>{a.name}{a.isActive ? '' : ' (off)'}</option>)}
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    <input className={`${inputCls} w-20`} inputMode="decimal" value={o.price}
                      onChange={(e) => onChange(updateOption(form, o.ref, { price: e.target.value }))} />
                  </td>
                  <td className="py-1 pr-2">
                    <input type="checkbox" aria-label={`${o.name || 'Option'} is a default`} checked={o.isDefault}
                      onChange={(e) => onChange(updateOption(form, o.ref, { isDefault: e.target.checked }))} />
                  </td>
                  <td className="py-1 pr-2">
                    <select className={inputCls} value={o.availability}
                      onChange={(e) => onChange(updateOption(form, o.ref, { availability: e.target.value as Availability }))}>
                      {(Object.keys(OPTION_AVAILABILITY_LABELS) as Availability[]).map((a) => (
                        <option key={a} value={a}>{OPTION_AVAILABILITY_LABELS[a]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="whitespace-nowrap py-1 text-right">
                    <button type="button" className={linkBtnCls} onClick={() => setOpen(open === o.ref ? null : o.ref)}>
                      Catalog prices{Object.values(o.catalogPrices).some((t) => t.trim() !== '') ? ' •' : ''}
                    </button>{' '}
                    <button type="button" className={linkBtnCls} disabled={i === 0} aria-label="Move up"
                      onClick={() => onChange(moveOption(form, i, -1))}>↑</button>{' '}
                    <button type="button" className={linkBtnCls} disabled={i === form.options.length - 1} aria-label="Move down"
                      onClick={() => onChange(moveOption(form, i, 1))}>↓</button>{' '}
                    {o.id === null && (
                      <button type="button" className={linkBtnCls} onClick={() => onChange(removeNewOption(form, o.ref))}>Remove</button>
                    )}
                  </td>
                </tr>
                {open === o.ref && (
                  <tr>
                    <td colSpan={6} className="bg-cream px-3 py-2">
                      <div className="text-xs text-brown-muted">Price in each catalog — leave blank to charge RM {o.price || '…'}</div>
                      <div className="mt-1 flex flex-wrap gap-3">
                        {catalogs.map((c) => (
                          <label key={c.id} className="text-xs">{c.name}{c.isActive ? '' : ' (off)'}
                            <input className={`${inputCls} ml-1 w-20`} inputMode="decimal" value={o.catalogPrices[c.id] ?? ''}
                              onChange={(e) => onChange(setOptionCatalogPrice(form, o.ref, c.id, e.target.value))} />
                          </label>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={linkBtnCls} disabled={form.options.length >= MAX_OPTIONS}
          onClick={() => onChange(addOption(form))}>Add option</button>
        <select className={inputCls} value="" disabled={form.options.length >= MAX_OPTIONS}
          onChange={(e) => {
            const a = addOns.find((x) => x.id === e.target.value)
            if (a) onChange(addOption(form, { id: a.id, name: a.name }))
          }}>
          <option value="">Add an add-on item as an option…</option>
          {addOns.filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
    </Section>
  )
}
```

   Create `src/features/pos/menu/GroupEditorPage.tsx`:

```tsx
// src/features/pos/menu/GroupEditorPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchGroupDetail, fetchLookups, saveGroup, type GroupDetail, type MenuLookups } from './menuEditorApi'
import { emptyGroupForm, groupFormFromDetail, groupPayload, groupProblems, type GroupForm, type GroupSection } from './groupForm'
import MenuTabs from './MenuTabs'
import OptionsSection from './group/OptionsSection'
import { OutcomeLine, Section, btnCls, errorText, inputCls, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'

/** /menu/groups/new and /menu/groups/:id. Saved at once by menu_save_group. */
export default function GroupEditorPage({ groupId }: { groupId: string | null }) {
  const navigate = useNavigate()
  const savedNotice = useSavedNotice()
  const [lookups, setLookups] = useState<MenuLookups | null>(null)
  const [form, setForm] = useState<GroupForm | null>(null)
  const [loaded, setLoaded] = useState<GroupForm | null>(null)
  const [usedBy, setUsedBy] = useState<GroupDetail['usedBy']>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tried, setTried] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(savedNotice ? { kind: 'ok', text: savedNotice } : null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const [l, d] = await Promise.all([fetchLookups(), groupId ? fetchGroupDetail(groupId) : Promise.resolve(null)])
    if (seq !== loadSeq.current) return
    setLookups(l)
    setUsedBy(d?.usedBy ?? [])
    const f = d ? groupFormFromDetail(d) : emptyGroupForm()
    setForm(f)
    setLoaded(f)
    setLoadError(null)
  }, [groupId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const change = (next: GroupForm) => { setForm(next); setOutcome(null) }
  const catalogName = (id: string) => lookups?.catalogs.find((c) => c.id === id)?.name ?? 'A catalog'
  const problems = form ? groupProblems(form, catalogName) : []
  useUnsavedWarning(!!form && !saving && JSON.stringify(form) !== JSON.stringify(loaded))
  const problemOf = (s: GroupSection) => (tried ? problems.find((p) => p.section === s)?.message ?? null : null)

  const save = async () => {
    if (!form || saving) return
    setTried(true)
    if (problems.length > 0) { setOutcome({ kind: 'error', text: 'Not saved — fix the problems marked above.' }); return }
    setSaving(true)
    setOutcome(null)
    try {
      const id = await saveGroup(groupPayload(form))
      if (!form.id) {
        navigate(`/menu/groups/${id}`, { replace: true, state: { saved: 'Add-on group created' } })
        return
      }
      try {
        await load()
        setTried(false)
        setOutcome({ kind: 'ok', text: 'Saved' })
      } catch (e) {
        setOutcome({ kind: 'error', text: `Saved, but reloading failed: ${errorText(e)}` })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      setSaving(false)
    }
  }

  const set = (patch: Partial<GroupForm>) => form && change({ ...form, ...patch })
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{groupId ? form?.name || 'Add-on group' : 'New add-on group'}</h1>
        <Link to="/menu/groups" className="text-sm underline">Back to add-on groups</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={() => load().catch((e) => setLoadError(errorText(e)))}>Try again</button>
        </div>
      )}
      {!form || !lookups ? (!loadError && <p className="text-sm">Loading…</p>) : (
        <>
          <Section title="Group" problem={problemOf('details')}
            hint={usedBy.length === 0 ? 'No product uses this group yet — add it in a product’s editor.'
              : `Used by ${usedBy.length} product${usedBy.length === 1 ? '' : 's'}: ${usedBy.slice(0, 8).map((p) => p.name).join(', ')}${usedBy.length > 8 ? ', …' : ''}`}>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block text-sm sm:col-span-3">Name
                <input className={`${inputCls} mt-1 w-full`} value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label className="block text-sm">Choose at least
                <input className={`${inputCls} mt-1 w-full`} inputMode="numeric" value={form.min} onChange={(e) => set({ min: e.target.value })} />
              </label>
              <label className="block text-sm">Choose at most
                <input className={`${inputCls} mt-1 w-full`} inputMode="numeric" value={form.max} onChange={(e) => set({ max: e.target.value })} />
              </label>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
                On (a switched-off group is left off every product)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={form.stackable} onChange={(e) => set({ stackable: e.target.checked })} />
                Stackable (kept from Feedme; the counter does not use it yet)
              </label>
            </div>
          </Section>
          <OptionsSection form={form} onChange={change} addOns={lookups.addOns} catalogs={lookups.catalogs} problem={problemOf('options')} />
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-cream py-3">
            <button className={btnCls} disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : form.id ? 'Save add-on group' : 'Create add-on group'}
            </button>
            <OutcomeLine outcome={outcome} />
          </div>
        </>
      )}
    </div>
  )
}
```

   Create `src/features/pos/menu/GroupListPage.tsx`:

```tsx
// src/features/pos/menu/GroupListPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchLookups, type LookupGroup } from './menuEditorApi'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText } from './editorUi'

/** /menu/groups — every add-on group, switched-off ones last. */
export default function GroupListPage() {
  const [groups, setGroups] = useState<LookupGroup[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(() => {
    const seq = ++loadSeq.current
    fetchLookups().then(
      (l) => { if (seq === loadSeq.current) { setGroups(l.groups); setLoadError(null) } },
      (e) => { if (seq === loadSeq.current) setLoadError(errorText(e)) },
    )
  }, [])
  useEffect(() => { load() }, [load])

  const sorted = [...(groups ?? [])].sort((a, b) => Number(b.isActive) - Number(a.isActive))
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Add-on groups</h1>
          <p className="text-sm text-brown-muted">Choices offered with a product (milk, sugar level, extra shot…), with a price per catalog.</p>
        </div>
        <Link to="/menu/groups/new" className={btnCls}>New add-on group</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={load}>Try again</button>
        </div>
      )}
      {groups === null && !loadError && <p className="text-sm">Loading…</p>}
      {groups?.length === 0 && <p className="rounded border border-border p-6 text-sm">No add-on groups yet.</p>}
      {sorted.length > 0 && (
        <table className="w-full rounded border border-border bg-card text-sm">
          <thead className="text-left text-brown-muted">
            <tr><th className="px-4 py-2">Group</th><th className="px-4 py-2">Choose</th><th className="px-4 py-2">Options on</th><th className="px-4 py-2">Used by</th></tr>
          </thead>
          <tbody>
            {sorted.map((g) => (
              <tr key={g.id} className={`border-t border-border ${g.isActive ? '' : 'text-brown-faint'}`}>
                <td className="px-4 py-2"><Link to={`/menu/groups/${g.id}`} className="hover:underline">{g.name}</Link>{g.isActive ? '' : ' (off)'}</td>
                <td className="px-4 py-2">{g.min}–{g.max}</td>
                <td className="px-4 py-2">{g.optionCount}</td>
                <td className="px-4 py-2">{g.productCount} product{g.productCount === 1 ? '' : 's'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
```

   Replace `src/features/pos/menu/MenuRoutes.tsx` with:

```tsx
// src/features/pos/menu/MenuRoutes.tsx
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import ProductListPage from './ProductListPage'
import ProductEditorPage from './ProductEditorPage'
import GroupListPage from './GroupListPage'
import GroupEditorPage from './GroupEditorPage'
import MenuImportPage from './MenuImportPage'

/** A fresh editor per product: nothing typed for one product can leak into another. */
function ProductEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <ProductEditorPage key={id ?? 'new'} productId={id ?? null} />
}

function GroupEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <GroupEditorPage key={id ?? 'new'} groupId={id ?? null} />
}

/** Everything under /menu (App.tsx gates it on Edit menu). */
export default function MenuRoutes() {
  return (
    <Routes>
      <Route index element={<ProductListPage />} />
      <Route path="products/new" element={<ProductEditorRoute />} />
      <Route path="products/:id" element={<ProductEditorRoute />} />
      <Route path="groups" element={<GroupListPage />} />
      <Route path="groups/new" element={<GroupEditorRoute />} />
      <Route path="groups/:id" element={<GroupEditorRoute />} />
      <Route path="import" element={<MenuImportPage />} />
      <Route path="*" element={<Navigate to="/menu" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 6: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 88 files, 765 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/menu
git commit -m "feat(pos-menu): add-on group editor — options, defaults, min/max and per-catalog option prices; options are switched off, never deleted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8 (controller, craft-os-dev — browser on the dev server, a phone or second tab for QR, and the SQL editor; the implementer does not touch the database):** **Add-on groups** → the list shows every imported group with "Choose", "Options on" and "Used by". **New add-on group** `[TEST] Milk`, min `0`, max `1`; **Add option** `Full cream` RM `0`, tick Default; **Add an add-on item as an option…** → an oat-milk add-on item if dev has one (else **Add option** `Oat` RM `2`), price `2.00`; its **Catalog prices** → Grab Food `3.00`. Set min `2` → **Create add-on group** → under Group "Min cannot be more than max", nothing saved; set min `3` and max `3` → "Min is 3 but only 2 options are on"; set min `0` and max `1` → **Create add-on group** → "Add-on group created". Open `[TEST] Iced Latte` → Add-on groups → add `[TEST] Milk` → Save. **Order it:** `/pos` → Craft Cafe → the latte, Oat → line RM 13.00 + 2.00 → send; Grab Food → Oat → 17.00 + 3.00 → send. **Switch Oat off:** group → Oat → Offered **Off** → Save → "Saved"; `select availability from modifier_options where name = '<Oat option name>' and group_id = '<group id>'` → `hidden` (the row is still there). Reopen the pad → Oat is not offered (Full cream is); open the QR page of a table at the branch → the latte's Milk choice lists Full cream only. The bill from before still shows "Oat" under the two latte lines. Try Default on the switched-off Oat → Save → under Options "A switched-off option cannot be the default: Oat".

---

### Task 7: Catalogs — create, duplicate, rename, reorder, switch off; a catalog's products and prices row by row

**Files:**
- Create: `src/features/pos/menu/listAdmin.ts`, `src/features/pos/menu/catalogGrid.ts`, `src/features/pos/menu/CatalogsPage.tsx`, `src/features/pos/menu/CatalogGridPage.tsx`, `src/features/pos/menu/catalog/GridRow.tsx`
- Modify: `src/features/pos/menu/MenuRoutes.tsx`
- Test: `src/features/pos/menu/listAdmin.test.ts`, `src/features/pos/menu/catalogGrid.test.ts`

**Interfaces:**
- Consumes: `fetchLookups`, `saveCatalog`, `duplicateCatalog`, `reorderCatalogs`, `setCatalogActive`, `fetchCatalogGrid`, `saveCatalogRow` (Task 4); `menuForms` (Task 5); `CATALOG_AVAILABILITY_LABELS` (`menuView`).
- Produces: `listNameProblem`, `reorderedIds`, `copyName`, `catalogUseText` (Categories reuse the first two in Task 8); `gridRowForm`, `gridRowDirty`, `setGridAvailability`, `gridRowProblem`, `gridRowPayload`, `gridProductAfterSave`, `gridSections`; routes `/menu/catalogs`, `/menu/catalogs/:id`.

- [ ] **Step 1: Write the failing tests.** Create `src/features/pos/menu/listAdmin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { catalogUseText, copyName, listNameProblem, reorderedIds } from './listAdmin'

const rows = [{ id: 'c', name: 'Craft Cafe' }, { id: 'g', name: 'Grab Food' }, { id: 's', name: 'Staff Meal' }]

describe('listNameProblem', () => {
  it('uses the server\'s words: required, too long, taken (letter case ignored)', () => {
    expect(listNameProblem('Catalog', '  ', rows, null)).toBe('Catalog name is required')
    expect(listNameProblem('Category', 'x'.repeat(61), rows, null)).toBe('Category name is too long (at most 60 characters)')
    expect(listNameProblem('Catalog', ' grab  food ', rows, null)).toBe('A catalog called grab food already exists')
    expect(listNameProblem('Catalog', 'Grab Mart', rows, null)).toBeNull()
  })
  it('lets a row keep its own name in other letters', () => {
    expect(listNameProblem('Catalog', 'GRAB FOOD', rows, 'g')).toBeNull()
  })
})

describe('reorderedIds', () => {
  it('gives the full new order, or null at the ends', () => {
    expect(reorderedIds(rows, 1, -1)).toEqual(['g', 'c', 's'])
    expect(reorderedIds(rows, 2, 1)).toBeNull()
  })
})

describe('copyName', () => {
  it('finds the first free "copy" name', () => {
    expect(copyName('Grab Food', rows)).toBe('Grab Food copy')
    expect(copyName('Grab Food', [...rows, { name: 'grab food COPY' }, { name: 'Grab Food copy 2' }])).toBe('Grab Food copy 3')
  })
})

describe('catalogUseText', () => {
  it('lists each branch once, roles in a fixed order', () => {
    expect(catalogUseText([
      { branch: 'Puchong', role: 'additional' }, { branch: 'Cheras', role: 'qr' },
      { branch: 'Cheras', role: 'dine_in' }, { branch: 'Cheras', role: 'takeaway' },
    ])).toBe('Cheras: dine-in, takeaway, QR · Puchong: additional')
    expect(catalogUseText([])).toBe('Not used by any branch')
  })
})
```

   Create `src/features/pos/menu/catalogGrid.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  gridProductAfterSave, gridRowDirty, gridRowForm, gridRowPayload, gridRowProblem, gridSections, setGridAvailability,
} from './catalogGrid'
import type { GridProduct } from './menuEditorApi'

const latte: GridProduct = {
  id: 'p-latte', name: 'Latte', category: 'COFFEE', categorySort: 1, availability: 'all',
  variants: [
    { id: 'v-hot', name: 'Hot', isActive: true, defaultSen: 1200, priceSen: 1700 },
    { id: 'v-cold', name: 'Cold', isActive: true, defaultSen: 1300, priceSen: 1800 },
    { id: 'v-old', name: 'Large', isActive: false, defaultSen: 1500, priceSen: null },
  ],
}
const toast: GridProduct = {
  id: 'p-toast', name: 'Kaya Toast', category: 'FOOD', categorySort: 2, availability: 'hidden',
  variants: [{ id: 'v-reg', name: 'Regular', isActive: true, defaultSen: 800, priceSen: null }],
}

describe('a grid row', () => {
  it('starts from the catalog\'s prices and is clean', () => {
    const f = gridRowForm(latte)
    expect(f).toEqual({ availability: 'all', prices: { 'v-hot': '17.00', 'v-cold': '18.00' } })
    expect(gridRowDirty(f, latte)).toBe(false)
    expect(gridRowDirty({ ...f, prices: { ...f.prices, 'v-hot': '17' } }, latte)).toBe(false)
    expect(gridRowDirty({ ...f, prices: { ...f.prices, 'v-hot': '17.50' } }, latte)).toBe(true)
    expect(gridRowDirty({ ...f, availability: 'counter_only' }, latte)).toBe(true)
  })

  it('putting a product in pre-fills its default prices; a priced one keeps its prices', () => {
    expect(setGridAvailability(gridRowForm(toast), toast, 'counter_only')).toEqual({ availability: 'counter_only', prices: { 'v-reg': '8.00' } })
    expect(setGridAvailability(gridRowForm(latte), latte, 'counter_only').prices).toEqual({ 'v-hot': '17.00', 'v-cold': '18.00' })
  })

  it('needs a price for every active variant while the catalog sells it, and amounts only', () => {
    expect(gridRowProblem({ availability: 'all', prices: { 'v-hot': '17' } }, latte, 'Grab Food')).toBe('Grab Food: enter a price for Cold')
    expect(gridRowProblem({ availability: 'hidden', prices: { 'v-hot': 'abc' } }, latte, 'Grab Food')).toBeNull()
    expect(gridRowProblem({ availability: 'all', prices: { 'v-hot': '17', 'v-cold': '18', 'v-old': 'abc' } }, latte, 'Grab Food')).toBeNull()
    expect(gridRowProblem({ availability: 'all', prices: { 'v-hot': '17', 'v-cold': 'abc' } }, latte, 'Grab Food'))
      .toBe('Grab Food: the price of Cold is not an amount in RM')
  })

  it('sends ids and sen, and is clean again once saved', () => {
    const f = { availability: 'counter_only' as const, prices: { 'v-hot': '17.5', 'v-cold': '18.00' } }
    expect(gridRowPayload(f, latte, 'grab')).toEqual({
      catalogId: 'grab', productId: 'p-latte', availability: 'counter_only',
      prices: [{ variantId: 'v-hot', priceSen: 1750 }, { variantId: 'v-cold', priceSen: 1800 }],
    })
    const after = gridProductAfterSave(latte, f)
    expect(after.availability).toBe('counter_only')
    expect(after.variants.map((v) => v.priceSen)).toEqual([1750, 1800, null])
    expect(gridRowDirty(f, after)).toBe(false)
    // out of the catalog: no prices are sent, the stored ones stay
    expect(gridRowPayload({ availability: 'hidden', prices: { 'v-hot': '1' } }, latte, 'grab').prices).toEqual([])
    expect(gridProductAfterSave(latte, { availability: 'hidden', prices: {} }).variants.map((v) => v.priceSen)).toEqual([1700, 1800, null])
  })
})

describe('gridSections', () => {
  it('groups by category in the server\'s order and filters by name and in / out', () => {
    expect(gridSections([latte, toast], '', 'all').map((s) => s.title)).toEqual(['COFFEE', 'FOOD'])
    expect(gridSections([latte, toast], '', 'in').map((s) => s.products.map((p) => p.id))).toEqual([['p-latte']])
    expect(gridSections([latte, toast], '', 'out').map((s) => s.title)).toEqual(['FOOD'])
    expect(gridSections([latte, toast], 'KAYA', 'all').map((s) => s.title)).toEqual(['FOOD'])
  })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run src/features/pos/menu/listAdmin.test.ts src/features/pos/menu/catalogGrid.test.ts` — Expected: FAIL, `Failed to resolve import "./listAdmin"` / `"./catalogGrid"`.

- [ ] **Step 3: Implement.** Create `src/features/pos/menu/listAdmin.ts`:

```ts
// src/features/pos/menu/listAdmin.ts
/** Pure helpers for the Catalogs and Categories pages: names, order, where a catalog is used. */
import type { CatalogRole } from './menuEditorApi'
import { cleanName, moveItem, nameProblem } from './menuForms'

/** menu_save_catalog / menu_save_category's words: required, at most 60 characters,
 *  no other row of that name (letter case ignored). */
export function listNameProblem(
  what: 'Catalog' | 'Category', raw: string, rows: { id: string; name: string }[], selfId: string | null,
): string | null {
  const problem = nameProblem(what, raw, 60)
  if (problem) return problem
  const name = cleanName(raw)
  return rows.some((r) => r.id !== selfId && r.name.toLowerCase() === name.toLowerCase())
    ? `A ${what.toLowerCase()} called ${name} already exists`
    : null
}

/** The ids in their new order after moving one row, or null when it cannot move. */
export function reorderedIds(rows: { id: string }[], index: number, delta: number): string[] | null {
  const next = moveItem(rows, index, delta)
  return next === rows ? null : next.map((r) => r.id)
}

/** "Catalog copy", then "Catalog copy 2", … — the first name no row uses. */
export function copyName(name: string, rows: { name: string }[]): string {
  const taken = new Set(rows.map((r) => r.name.toLowerCase()))
  let candidate = `${name} copy`
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} copy ${n}`
  return candidate
}

const ROLE_WORDS: Record<CatalogRole, string> = { dine_in: 'dine-in', takeaway: 'takeaway', qr: 'QR', additional: 'additional' }
const ROLE_ORDER: CatalogRole[] = ['dine_in', 'takeaway', 'qr', 'additional']

/** Where a catalog is used, per branch: "Cheras: dine-in, takeaway, QR · Puchong: additional". */
export function catalogUseText(uses: { branch: string; role: CatalogRole }[]): string {
  if (uses.length === 0) return 'Not used by any branch'
  const byBranch = new Map<string, CatalogRole[]>()
  for (const u of uses) byBranch.set(u.branch, [...(byBranch.get(u.branch) ?? []), u.role])
  return [...byBranch.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([branch, roles]) => `${branch}: ${[...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)).map((r) => ROLE_WORDS[r]).join(', ')}`)
    .join(' · ')
}
```

   Create `src/features/pos/menu/catalogGrid.ts`:

```ts
// src/features/pos/menu/catalogGrid.ts
/** One row of a catalog's page: does the catalog sell the product, on which channel, at
 *  what price per variant. Pure; menu_save_catalog_row checks it again in the same words. */
import type { Availability } from './feedmeExport'
import type { CatalogRowPayload, GridProduct } from './menuEditorApi'
import { inputToSen, senToInput } from './menuForms'

/** Price boxes by variant id; blank = no price in this catalog. */
export interface GridRowForm { availability: Availability; prices: Record<string, string> }

export function gridRowForm(p: GridProduct): GridRowForm {
  const prices: Record<string, string> = {}
  for (const v of p.variants) if (v.priceSen !== null) prices[v.id] = senToInput(v.priceSen)
  return { availability: p.availability, prices }
}

const norm = (text: string | undefined) => {
  const t = (text ?? '').trim()
  const sen = inputToSen(t)
  return sen === null ? t : String(sen)
}

/** Changed since it was loaded or last saved ("12" and "12.00" are the same price). */
export function gridRowDirty(form: GridRowForm, p: GridProduct): boolean {
  const base = gridRowForm(p)
  return form.availability !== base.availability || p.variants.some((v) => norm(form.prices[v.id]) !== norm(base.prices[v.id]))
}

/** Putting the product in the catalog pre-fills blank prices of active variants with their default price. */
export function setGridAvailability(form: GridRowForm, p: GridProduct, availability: Availability): GridRowForm {
  if (form.availability !== 'hidden' || availability === 'hidden') return { ...form, availability }
  const prices = { ...form.prices }
  for (const v of p.variants) if (v.isActive && (prices[v.id] ?? '').trim() === '') prices[v.id] = senToInput(v.defaultSen)
  return { availability, prices }
}

/** Only boxes the owner can see count: a row that sells the product, its active variants. */
export function gridRowProblem(form: GridRowForm, p: GridProduct, catalogName: string): string | null {
  if (form.availability === 'hidden') return null
  for (const v of p.variants.filter((x) => x.isActive)) {
    const text = (form.prices[v.id] ?? '').trim()
    if (text === '') return `${catalogName}: enter a price for ${v.name}`
    if (inputToSen(text) === null) return `${catalogName}: the price of ${v.name} is not an amount in RM`
  }
  return null
}

/** What menu_save_catalog_row takes. Call it only when gridRowProblem() is null. A row that
 *  does not sell the product, and a switched-off variant, send no prices (the server keeps them). */
export function gridRowPayload(form: GridRowForm, p: GridProduct, catalogId: string): CatalogRowPayload {
  return {
    catalogId,
    productId: p.id,
    availability: form.availability,
    prices: form.availability === 'hidden' ? [] : p.variants.flatMap((v) => {
      const sen = v.isActive ? inputToSen((form.prices[v.id] ?? '').trim()) : null
      return sen === null ? [] : [{ variantId: v.id, priceSen: sen }]
    }),
  }
}

/** The product as the server now holds it, so the row is clean again without reloading the grid.
 *  Only the prices gridRowPayload sent change (prices are never deleted). */
export function gridProductAfterSave(p: GridProduct, form: GridRowForm): GridProduct {
  const sent = new Map(gridRowPayload(form, p, '').prices.map((x) => [x.variantId, x.priceSen]))
  return { ...p, availability: form.availability, variants: p.variants.map((v) => ({ ...v, priceSen: sent.get(v.id) ?? v.priceSen })) }
}

export type GridShow = 'all' | 'in' | 'out'
export interface GridSection { title: string; products: GridProduct[] }

/** Rows by category in the server's order, filtered by name and by in / out of the catalog. */
export function gridSections(products: GridProduct[], search: string, show: GridShow): GridSection[] {
  const q = search.trim().toLowerCase()
  const out: GridSection[] = []
  for (const p of products) {
    const sells = p.availability !== 'hidden'
    if ((show === 'in' && !sells) || (show === 'out' && sells)) continue
    if (q && !p.name.toLowerCase().includes(q)) continue
    const last = out[out.length - 1]
    if (last && last.title === p.category) last.products.push(p)
    else out.push({ title: p.category, products: [p] })
  }
  return out
}
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/features/pos/menu/listAdmin.test.ts src/features/pos/menu/catalogGrid.test.ts` — Expected: PASS, 5 + 5 tests.

- [ ] **Step 5: The pages.** Create `src/features/pos/menu/CatalogsPage.tsx`:

```tsx
// src/features/pos/menu/CatalogsPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  duplicateCatalog, fetchLookups, reorderCatalogs, saveCatalog, setCatalogActive, type LookupCatalog,
} from './menuEditorApi'
import { catalogUseText, copyName, listNameProblem, reorderedIds } from './listAdmin'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'

type Editing = { id: string; mode: 'rename' | 'duplicate'; name: string } | null

/** /menu/catalogs — create, rename, duplicate, reorder and switch catalogs on or off.
 *  Each action shows its outcome on its own row; one action runs at a time. */
export default function CatalogsPage() {
  const [catalogs, setCatalogs] = useState<LookupCatalog[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<Editing>(null)
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})          // by catalog id; 'new' for the create form

  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const l = await fetchLookups()
    if (seq !== loadSeq.current) return
    setCatalogs(l.catalogs)
    setLoadError(null)
  }, [])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  /** Runs one action, then reloads; the outcome lands on `key`'s row. */
  const run = async (key: string, action: () => Promise<unknown>, ok: string) => {
    if (busy) return
    setBusy(true)
    setOutcomes((o) => { const n = { ...o }; delete n[key]; return n })
    try {
      await action()
      setEditing(null)
      try {
        await load()
        setOutcomes((o) => ({ ...o, [key]: { kind: 'ok', text: ok } }))
      } catch (e) {
        setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: `Saved, but reloading failed: ${errorText(e)}` } }))
      }
    } catch (e) {
      setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: errorText(e) } }))
    } finally {
      setBusy(false)
    }
  }
  const fail = (key: string, text: string) => setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text } }))

  const create = () => {
    const problem = listNameProblem('Catalog', newName, catalogs ?? [], null)
    if (problem) return fail('new', problem)
    void run('new', async () => { await saveCatalog(null, newName); setNewName('') }, 'Catalog created — open it to choose its products and prices')
  }
  const confirmEdit = (c: LookupCatalog) => {
    if (!editing) return
    const problem = listNameProblem('Catalog', editing.name, catalogs ?? [], editing.mode === 'rename' ? c.id : null)
    if (problem) return fail(c.id, problem)
    if (editing.mode === 'rename') void run(c.id, () => saveCatalog(c.id, editing.name), 'Renamed')
    else void run(c.id, () => duplicateCatalog(c.id, editing.name), `Copied to ${editing.name.trim()}`)
  }
  const move = (index: number, delta: number) => {
    const ids = catalogs && reorderedIds(catalogs, index, delta)
    if (ids) void run(ids[index + delta], () => reorderCatalogs(ids), 'Moved')
  }
  // a catalog a branch prices dine-in, takeaway or QR orders from is refused by the server, in its words
  const toggle = (c: LookupCatalog) =>
    void run(c.id, () => setCatalogActive(c.id, !c.isActive), c.isActive ? 'Switched off' : 'Switched on')

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <MenuTabs />
      <div>
        <h1 className="text-2xl font-semibold">Catalogs</h1>
        <p className="text-sm text-brown-muted">
          A catalog picks products from the menu and sells them at its own prices. Which catalog a branch uses for each
          kind of order is set in POS settings.
        </p>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={() => load().catch((e) => setLoadError(errorText(e)))}>Try again</button>
        </div>
      )}
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-64`} placeholder="New catalog name" value={newName}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className={btnCls} disabled={busy} onClick={create}>Create catalog</button>
        </div>
        <OutcomeLine outcome={outcomes.new ?? null} />
      </div>
      {catalogs === null && !loadError && <p className="text-sm">Loading…</p>}
      <ul className="space-y-2">
        {catalogs?.map((c, i) => (
          <li key={c.id} className={`space-y-2 rounded-xl border border-border bg-card p-3 ${c.isActive ? '' : 'text-brown-faint'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                <Link to={`/menu/catalogs/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                {!c.isActive && <span className="ml-2 text-xs">(off)</span>}
                <div className="text-xs text-brown-muted">
                  {c.productCount} products · {catalogUseText(c.uses)}{c.feedmeName ? ` · Feedme: ${c.feedmeName}` : ''}
                </div>
                {c.unpricedCount > 0 && (
                  <Link to={`/menu/catalogs/${c.id}`} className="text-xs text-red-700 underline">
                    {c.unpricedCount} product{c.unpricedCount === 1 ? ' has' : 's have'} no price — open to fix
                  </Link>
                )}
              </div>
              <Link to={`/menu/catalogs/${c.id}`} className={linkBtnCls}>Products and prices</Link>
              <button className={linkBtnCls} disabled={busy} onClick={() => setEditing({ id: c.id, mode: 'rename', name: c.name })}>Rename</button>
              <button className={linkBtnCls} disabled={busy}
                onClick={() => setEditing({ id: c.id, mode: 'duplicate', name: copyName(c.name, catalogs) })}>Duplicate</button>
              <button className={linkBtnCls} disabled={busy || i === 0} aria-label="Move up" onClick={() => move(i, -1)}>↑</button>
              <button className={linkBtnCls} disabled={busy || i === catalogs.length - 1} aria-label="Move down" onClick={() => move(i, 1)}>↓</button>
              <button className={linkBtnCls} disabled={busy} onClick={() => toggle(c)}>{c.isActive ? 'Switch off' : 'Switch on'}</button>
            </div>
            {editing?.id === c.id && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">{editing.mode === 'rename' ? 'New name' : 'Name of the copy'}</span>
                <input className={`${inputCls} w-64`} value={editing.name} autoFocus
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && confirmEdit(c)} />
                <button className={btnCls} disabled={busy} onClick={() => confirmEdit(c)}>
                  {editing.mode === 'rename' ? 'Save name' : 'Duplicate with products and prices'}
                </button>
                <button className="text-sm underline" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            )}
            <OutcomeLine outcome={outcomes[c.id] ?? null} />
          </li>
        ))}
      </ul>
    </div>
  )
}
```

   Create `src/features/pos/menu/catalog/GridRow.tsx`:

```tsx
// src/features/pos/menu/catalog/GridRow.tsx
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Availability } from '../feedmeExport'
import { saveCatalogRow, type GridProduct } from '../menuEditorApi'
import { CATALOG_AVAILABILITY_LABELS } from '../menuView'
import {
  gridProductAfterSave, gridRowDirty, gridRowForm, gridRowPayload, gridRowProblem, setGridAvailability, type GridRowForm,
} from '../catalogGrid'
import { OutcomeLine, errorText, inputCls, linkBtnCls, type Outcome } from '../editorUi'

/** One product in one catalog, saved on its own (menu_save_catalog_row). The outcome
 *  shows on the row; a second tap while it saves does nothing. */
export default function GridRow({ product, catalogId, catalogName, onSaved }: {
  product: GridProduct
  catalogId: string
  catalogName: string
  onSaved: (p: GridProduct) => void
}) {
  const [form, setForm] = useState<GridRowForm>(() => gridRowForm(product))
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  useEffect(() => { setForm(gridRowForm(product)) }, [product])   // a saved or reloaded product resets the row

  const dirty = gridRowDirty(form, product)
  const sells = form.availability !== 'hidden'
  // a saved row that breaks the price rule (e.g. after a re-import) says so before anyone edits it
  const standing = useMemo(
    () => (!dirty && sells ? gridRowProblem(form, product, catalogName) : null), [dirty, sells, form, product, catalogName])
  const variants = product.variants.filter((v) => v.isActive)
  const change = (next: GridRowForm) => { setForm(next); setOutcome(null) }

  const save = async () => {
    if (saving) return
    const problem = gridRowProblem(form, product, catalogName)
    if (problem) { setOutcome({ kind: 'error', text: problem }); return }
    setSaving(true)
    try {
      await saveCatalogRow(gridRowPayload(form, product, catalogId))
      onSaved(gridProductAfterSave(product, form))
      setOutcome({ kind: 'ok', text: 'Saved' })
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2"><Link to={`/menu/products/${product.id}`} className="hover:underline">{product.name}</Link></td>
      <td className="px-3 py-2">
        <select className={inputCls} value={form.availability}
          onChange={(e) => change(setGridAvailability(form, product, e.target.value as Availability))}>
          {(Object.keys(CATALOG_AVAILABILITY_LABELS) as Availability[]).map((a) => (
            <option key={a} value={a}>{CATALOG_AVAILABILITY_LABELS[a]}</option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-2">
          {variants.map((v) => (
            <label key={v.id} className="text-xs">{variants.length > 1 ? v.name : 'Price'}
              <input className={`${inputCls} ml-1 w-20`} inputMode="decimal" disabled={!sells}
                placeholder={(v.defaultSen / 100).toFixed(2)} value={form.prices[v.id] ?? ''}
                onChange={(e) => change({ ...form, prices: { ...form.prices, [v.id]: e.target.value } })} />
            </label>
          ))}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-start gap-1">
          <button className={linkBtnCls} disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
          <OutcomeLine outcome={outcome ?? (standing ? { kind: 'error', text: `${standing} — the pad and QR leave it out` } : null)} />
        </div>
      </td>
    </tr>
  )
}
```

   Create `src/features/pos/menu/CatalogGridPage.tsx`:

```tsx
// src/features/pos/menu/CatalogGridPage.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchCatalogGrid, type CatalogGrid, type GridProduct } from './menuEditorApi'
import { gridSections, type GridShow } from './catalogGrid'
import MenuTabs from './MenuTabs'
import GridRow from './catalog/GridRow'
import { OutcomeLine, errorText, inputCls } from './editorUi'

/** /menu/catalogs/:id — every product with this catalog's availability and prices,
 *  one row saved at a time. The route remounts this page per catalog (MenuRoutes keys it). */
export default function CatalogGridPage({ catalogId }: { catalogId: string }) {
  const [grid, setGrid] = useState<CatalogGrid | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [show, setShow] = useState<GridShow>('all')
  const loadSeq = useRef(0)

  const load = useCallback(() => {
    const seq = ++loadSeq.current
    fetchCatalogGrid(catalogId).then(
      (g) => { if (seq === loadSeq.current) { setGrid(g); setLoadError(null) } },
      (e) => { if (seq === loadSeq.current) setLoadError(errorText(e)) },
    )
  }, [catalogId])
  useEffect(() => { load() }, [load])

  const sections = useMemo(() => gridSections(grid?.products ?? [], search, show), [grid, search, show])
  const sold = grid?.products.filter((p) => p.availability !== 'hidden').length ?? 0
  const onSaved = useCallback((p: GridProduct) => {
    setGrid((g) => (g ? { ...g, products: g.products.map((x) => (x.id === p.id ? p : x)) } : g))
  }, [])

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{grid?.catalog.name ?? 'Catalog'}{grid && !grid.catalog.isActive ? ' (off)' : ''}</h1>
          {grid && <p className="text-sm text-brown-muted">Sells {sold} of {grid.products.length} products. Grey prices are the default prices.</p>}
        </div>
        <Link to="/menu/catalogs" className="text-sm underline">Back to catalogs</Link>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={load}>Try again</button>
        </div>
      )}
      {!grid ? (!loadError && <p className="text-sm">Loading…</p>) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input className={`${inputCls} w-56`} placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className={inputCls} value={show} onChange={(e) => setShow(e.target.value as GridShow)}>
              <option value="all">All products</option>
              <option value="in">In this catalog</option>
              <option value="out">Not in this catalog</option>
            </select>
          </div>
          {sections.map((s) => (
            <section key={s.title} className="rounded border border-border bg-card">
              <h2 className="border-b border-border px-3 py-2 font-medium">{s.title}</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-brown-muted">
                  <tr><th className="px-3 py-1">Product</th><th className="px-3 py-1">In {grid.catalog.name}</th><th className="px-3 py-1">Prices (RM)</th><th /></tr>
                </thead>
                <tbody>
                  {s.products.map((p) => (
                    <GridRow key={p.id} product={p} catalogId={grid.catalog.id} catalogName={grid.catalog.name} onSaved={onSaved} />
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </>
      )}
    </div>
  )
}
```

   Replace `src/features/pos/menu/MenuRoutes.tsx` with:

```tsx
// src/features/pos/menu/MenuRoutes.tsx
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import ProductListPage from './ProductListPage'
import ProductEditorPage from './ProductEditorPage'
import CatalogsPage from './CatalogsPage'
import CatalogGridPage from './CatalogGridPage'
import GroupListPage from './GroupListPage'
import GroupEditorPage from './GroupEditorPage'
import MenuImportPage from './MenuImportPage'

/** A fresh editor per product: nothing typed for one product can leak into another. */
function ProductEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <ProductEditorPage key={id ?? 'new'} productId={id ?? null} />
}

function CatalogGridRoute() {
  const { id = '' } = useParams<{ id: string }>()
  return <CatalogGridPage key={id} catalogId={id} />
}

function GroupEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <GroupEditorPage key={id ?? 'new'} groupId={id ?? null} />
}

/** Everything under /menu (App.tsx gates it on Edit menu). */
export default function MenuRoutes() {
  return (
    <Routes>
      <Route index element={<ProductListPage />} />
      <Route path="products/new" element={<ProductEditorRoute />} />
      <Route path="products/:id" element={<ProductEditorRoute />} />
      <Route path="catalogs" element={<CatalogsPage />} />
      <Route path="catalogs/:id" element={<CatalogGridRoute />} />
      <Route path="groups" element={<GroupListPage />} />
      <Route path="groups/new" element={<GroupEditorRoute />} />
      <Route path="groups/:id" element={<GroupEditorRoute />} />
      <Route path="import" element={<MenuImportPage />} />
      <Route path="*" element={<Navigate to="/menu" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 6: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 90 files, 775 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/menu
git commit -m "feat(pos-menu): catalogs page — create, duplicate, rename, reorder, switch off; each catalog's products and prices saved row by row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8 (controller, craft-os-dev — browser on the dev server and the SQL editor; the implementer does not touch the database):** **Catalogs** → ten catalogs in order, each with its product count and where it is used: the M1 backfill gave Craft Cafe to **every active branch**, so its line lists each of them, `Demo: dine-in, takeaway, QR` among them (`select name from branches where coalesce(is_active, true) order by name` gives the list); no catalog shows a red "no price" line. **Duplicate** on Grab Food → the name box says `Grab Food copy` → **Duplicate with products and prices** → "Copied to Grab Food copy" on Grab Food's row; the copy shows the same product count and "Not used by any branch". **Rename** the copy to `[TEST] Grab Food 2` → "Renamed"; rename it to `grab food` → "A catalog called grab food already exists" on its row, nothing saved. **↑** on it → it moves up one place and stays there after a reload. **Switch off** Craft Cafe → its row says "Craft Cafe is the dine-in catalog of <branch> — choose another in POS settings first", where `<branch>` is the first active branch by name that uses it (not necessarily Demo); nothing changes; **Switch off** the copy → "(off)". Open **Grab Food** (Products and prices) → "Sells 66 of N products"; filter **Not in this catalog**, pick a product → **Counter + QR** → its boxes fill with the default price (grey placeholders show it too) → change one → **Save** → "Saved" on that row; SQL `select availability from catalog_products where catalog_id = (select id from menu_catalogs where name = 'Grab Food') and product_id = (select id from menu_products where name = '<it>')` → `all`. Clear a price of a product it sells → Save → "Grab Food: enter a price for …" on the row. On `/pos`, a Grab Food order now offers that product at the typed price. **A stale editor tab does not undo it:** open `[TEST] Iced Latte`'s editor in a second tab; in this tab set its Grab Food Hot price to `17.50` on the Grab Food page → Save; in the second (older) tab change only the name to `[TEST] Iced Latte 2` → **Save product** → reload Grab Food's page → Hot is still 17.50. **An unpriced product is flagged:** stand in for a variant a re-import brings back — SQL `insert into menu_variants(product_id, feedme_variant_key, name, price_sen) select id, 'test-unpriced', 'Large', 1400 from menu_products where name = '[TEST] Iced Latte 2'` → Catalogs shows "1 product has no price — open to fix" on Craft Cafe and Grab Food; open Grab Food → the latte's row says "Grab Food: enter a price for Large — the pad and QR leave it out", and the pad's Grab Food order no longer offers the latte; type `19` → **Save** → the line goes; in the latte's editor untick **On** for Large → **Save product** → Craft Cafe's red line goes too. Set the earlier product back to **Not in this catalog** → Save.

---

### Task 8: Categories — create, rename, reorder, switch off

**Files:**
- Create: `src/features/pos/menu/CategoriesPage.tsx`
- Modify: `src/features/pos/menu/MenuRoutes.tsx`

**Interfaces:**
- Consumes: `fetchLookups`, `saveCategory`, `reorderCategories`, `setCategoryActive` (Task 4); `listNameProblem`, `reorderedIds` (Task 7).
- Produces: route `/menu/categories`. The four `/menu` pages are complete.

- [ ] **Step 1: The page.** Create `src/features/pos/menu/CategoriesPage.tsx`:

```tsx
// src/features/pos/menu/CategoriesPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchLookups, reorderCategories, saveCategory, setCategoryActive, type LookupCategory } from './menuEditorApi'
import { listNameProblem, reorderedIds } from './listAdmin'
import MenuTabs from './MenuTabs'
import { OutcomeLine, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'

/** /menu/categories — create, rename, reorder (the order of the pad and QR) and switch
 *  categories on or off. Each action shows its outcome on its own row; one runs at a time. */
export default function CategoriesPage() {
  const [categories, setCategories] = useState<LookupCategory[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})          // by category id; 'new' for the create form

  const loadSeq = useRef(0)                                               // an older reply never lands last
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const l = await fetchLookups()
    if (seq !== loadSeq.current) return
    setCategories(l.categories)
    setLoadError(null)
  }, [])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const run = async (key: string, action: () => Promise<unknown>, ok: string) => {
    if (busy) return
    setBusy(true)
    setOutcomes((o) => { const n = { ...o }; delete n[key]; return n })
    try {
      await action()
      setRenaming(null)
      try {
        await load()
        setOutcomes((o) => ({ ...o, [key]: { kind: 'ok', text: ok } }))
      } catch (e) {
        setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: `Saved, but reloading failed: ${errorText(e)}` } }))
      }
    } catch (e) {
      setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text: errorText(e) } }))
    } finally {
      setBusy(false)
    }
  }
  const fail = (key: string, text: string) => setOutcomes((o) => ({ ...o, [key]: { kind: 'error', text } }))

  const create = () => {
    const problem = listNameProblem('Category', newName, categories ?? [], null)
    if (problem) return fail('new', problem)
    void run('new', async () => { await saveCategory(null, newName); setNewName('') }, 'Category created')
  }
  const rename = (c: LookupCategory) => {
    if (!renaming) return
    const problem = listNameProblem('Category', renaming.name, categories ?? [], c.id)
    if (problem) return fail(c.id, problem)
    void run(c.id, () => saveCategory(c.id, renaming.name), 'Renamed')
  }
  const move = (index: number, delta: number) => {
    const ids = categories && reorderedIds(categories, index, delta)
    if (ids) void run(ids[index + delta], () => reorderCategories(ids), 'Moved')
  }
  const toggle = (c: LookupCategory) => {
    if (c.isActive && c.productCount > 0
        && !window.confirm(`${c.productCount} products in ${c.name} leave the counter and the QR menu until you switch it back on.`)) return
    void run(c.id, () => setCategoryActive(c.id, !c.isActive), c.isActive ? 'Switched off' : 'Switched on')
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <MenuTabs />
      <div>
        <h1 className="text-2xl font-semibold">Categories</h1>
        <p className="text-sm text-brown-muted">The order here is the order of the counter and the QR menu.</p>
      </div>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={() => load().catch((e) => setLoadError(errorText(e)))}>Try again</button>
        </div>
      )}
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${inputCls} w-64`} placeholder="New category name" value={newName}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className={btnCls} disabled={busy} onClick={create}>Create category</button>
        </div>
        <OutcomeLine outcome={outcomes.new ?? null} />
      </div>
      {categories === null && !loadError && <p className="text-sm">Loading…</p>}
      <ul className="space-y-2">
        {categories?.map((c, i) => (
          <li key={c.id} className={`space-y-2 rounded-xl border border-border bg-card p-3 ${c.isActive ? '' : 'text-brown-faint'}`}>
            <div className="flex flex-wrap items-center gap-2">
              {renaming?.id === c.id ? (
                <>
                  <input className={`${inputCls} w-64`} value={renaming.name} autoFocus
                    onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && rename(c)} />
                  <button className={btnCls} disabled={busy} onClick={() => rename(c)}>Save name</button>
                  <button className="text-sm underline" onClick={() => setRenaming(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <span className="flex-1">
                    <span className="font-medium">{c.name}</span>{c.isActive ? '' : ' (off)'}
                    <span className="ml-2 text-xs text-brown-muted">{c.productCount} product{c.productCount === 1 ? '' : 's'}</span>
                  </span>
                  <button className={linkBtnCls} disabled={busy} onClick={() => setRenaming({ id: c.id, name: c.name })}>Rename</button>
                  <button className={linkBtnCls} disabled={busy || i === 0} aria-label="Move up" onClick={() => move(i, -1)}>↑</button>
                  <button className={linkBtnCls} disabled={busy || i === categories.length - 1} aria-label="Move down" onClick={() => move(i, 1)}>↓</button>
                  <button className={linkBtnCls} disabled={busy} onClick={() => toggle(c)}>{c.isActive ? 'Switch off' : 'Switch on'}</button>
                </>
              )}
            </div>
            <OutcomeLine outcome={outcomes[c.id] ?? null} />
          </li>
        ))}
      </ul>
    </div>
  )
}
```

   Replace `src/features/pos/menu/MenuRoutes.tsx` with:

```tsx
// src/features/pos/menu/MenuRoutes.tsx
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import ProductListPage from './ProductListPage'
import ProductEditorPage from './ProductEditorPage'
import CatalogsPage from './CatalogsPage'
import CatalogGridPage from './CatalogGridPage'
import GroupListPage from './GroupListPage'
import GroupEditorPage from './GroupEditorPage'
import CategoriesPage from './CategoriesPage'
import MenuImportPage from './MenuImportPage'

/** A fresh editor per product: nothing typed for one product can leak into another. */
function ProductEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <ProductEditorPage key={id ?? 'new'} productId={id ?? null} />
}

function CatalogGridRoute() {
  const { id = '' } = useParams<{ id: string }>()
  return <CatalogGridPage key={id} catalogId={id} />
}

function GroupEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <GroupEditorPage key={id ?? 'new'} groupId={id ?? null} />
}

/** Everything under /menu (App.tsx gates it on Edit menu). */
export default function MenuRoutes() {
  return (
    <Routes>
      <Route index element={<ProductListPage />} />
      <Route path="products/new" element={<ProductEditorRoute />} />
      <Route path="products/:id" element={<ProductEditorRoute />} />
      <Route path="catalogs" element={<CatalogsPage />} />
      <Route path="catalogs/:id" element={<CatalogGridRoute />} />
      <Route path="groups" element={<GroupListPage />} />
      <Route path="groups/new" element={<GroupEditorRoute />} />
      <Route path="groups/:id" element={<GroupEditorRoute />} />
      <Route path="categories" element={<CategoriesPage />} />
      <Route path="import" element={<MenuImportPage />} />
      <Route path="*" element={<Navigate to="/menu" replace />} />
    </Routes>
  )
}
```

- [ ] **Step 2: Run the gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run` — Expected: 90 files, 775 tests pass. Run: `grep -c "path=" src/features/pos/menu/MenuRoutes.tsx` — Expected: `10` (plus the index route).

- [ ] **Step 3: Commit**

```bash
git add src/features/pos/menu
git commit -m "feat(pos-menu): categories page — create, rename, reorder (the order of the counter and QR), switch off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4 (controller, craft-os-dev — browser on the dev server and a QR page; the implementer does not touch the database):** **Categories** → every category with its product count. Create `[TEST] SEASONAL` → "Category created", it is last; create `[test] seasonal` → "A category called [test] seasonal already exists". Move `[TEST] Iced Latte`'s category to the top with **↑** (each click shows "Moved" on that row) → open the pad → that category is first in the category strip; open a table's QR page → first there too. **Switch off** that category → the confirm says how many products leave the counter and QR → OK → "(off)"; reopen the pad → the latte and its category are gone (QR too); **Switch on** → back. Move the category back to where it was. Finally switch off the `[TEST]` rows made in Tasks 5–8 (product: untick **On sale**; group: untick **On**; catalog `[TEST] Grab Food 2`: already off; category `[TEST] SEASONAL`: **Switch off**) — nothing is deleted.

---

## Execution notes for the controller

- Task 1 is SQL plus the scan; Task 2 writes the verify and lands the SQL on dev (Step 4). Tasks 3–8 each end with `npx tsc -b`, `npx vitest run` and a browser check on dev, which needs Task 2's SQL. Task 3 must not reach any deployed build before the SQL is on that build's database (the pad would fail with "Could not find the function public.pos_menu_rows").
- Every step that reads or writes craft-os-dev (Task 2 Step 4, Task 3 Step 4, Task 4 Step 11, Task 5 Step 9, Task 6 Step 8, Task 7 Step 8, Task 8 Step 4) is the controller's; implementers stop at `tsc` / `vitest` / commit.
- **Checked while planning:** the migration and the verify script were run on a throwaway local PostgreSQL 18 (Supabase stubs: `auth.uid()` from `request.jwt.claims`, `anon` / `authenticated` roles with Supabase's default grants, `pgcrypto` in `extensions`, the `supabase_realtime` publication, a copy of `feature/staff-private`'s staff authority guard) after every earlier POS migration: the file applies twice, its STOP guard fires on a database without M1, and all five verify scripts print `VERIFY OK`; mutating six rules in the functions (category filter, re-key, catalog price check, override removal, the kept detail of a partial save, the unpriced count) makes the M2 verify fail at the matching check. pg-safeupdate itself was not available there — the Vitest scan stands in for it. A failure on dev therefore points at something dev-specific; read the `FAIL` text before changing the function.
- `[TEST]` rows made in the browser checks stay on dev, switched off (Task 8 Step 4).
- **Prod rollout (owner's decision, later):** after M1 is on prod, run `migration-2026-10-24-pos-menu-editor-fn.sql` on prod **before** the first deploy from main that carries Tasks 3–8. The verify script is dev-only. Nothing to backfill.

## Open points (choices made while planning, 2026-10-24 — each can be changed later)

Choices marked **assumed — Feedme behaviour (owner asleep, 2026-10-24)** follow how Feedme's back office behaves (teardown §1), as the owner asked for open choices.

1. **Switching an option off reuses `availability = 'hidden'`** instead of a new `modifier_options.is_active` — Feedme's per-option "Order from" All / POS / None. Every reader already honours it, so no M1 function is re-created. **Assumed — Feedme behaviour (owner asleep, 2026-10-24).**
2. **A re-import resets the menu to Feedme; nothing protects edits made here** (Feedme has one master and no merge). `menu_import` still replaces the options of every group it imports, so a re-import: overwrites product names, prices and which products each Feedme catalog sells; deletes add-on options added in Craft OS to Feedme groups, with their catalog prices; switches options, products and categories that were switched off here back on; switches off variants added here (and brings back Feedme's); replaces each imported product's add-on group links with Feedme's; changes option ids (carts and offline-queued orders holding old ids are refused "Add-on is not available"). The import page's `MASTER_WARNING` lists these (Task 4), and the typed confirmation stays. **Assumed — Feedme behaviour (owner asleep, 2026-10-24).** An upsert-by-name import that keeps Craft OS edits is a later choice.
3. **A switched-off category only hides its products** on the counter and QR; the server still accepts them (offline orders queued before the switch). Switching off the product itself stops sales outright. Products with **no category** (legacy imports only — a save now requires one) still show on the counter under "Uncategorised" (`pos_menu_rows` keeps them, as `buildPosMenu` did) but not on QR (`qr_menu` joins categories); giving them a category fixes both.
4. **Products cannot be reordered inside a category or a catalog in M2** (Feedme drag-orders categories and add-on groups only). A new product goes last; imported products keep Feedme's order. **Assumed — Feedme behaviour (owner asleep, 2026-10-24).**
5. **`menu_set_catalog_product` (M1) is no longer called by the client.** It stays (the M1 verify script calls it); a clean-up migration can drop it with `menu_products.availability`.
6. **Two small unpaged reads remain:** `fetchProductNames` (checkout, rejected-strip names) and `fetchMenuRoutes` (print-route check) read `menu_products` directly. Both are under the 1,000-row cap while the menu has fewer than 1,000 products (409 today); move them to RPCs if the menu grows past ~900.
7. **Variant keys and re-imports.** The model is Feedme's — a product with variants has only keyed variants and no base one — so a product that gains a second active variant loses its base key. **Assumed — Feedme behaviour (owner asleep, 2026-10-24).** Consequences: (a) a re-import brings Feedme's base row back as a new variant and switches the Craft OS ones off; (b) that new variant, or any variant Feedme added since, is priced only in the ten Feedme catalogs, so **a catalog made or duplicated here then sells the product without a price for it, and the pad and QR leave the product out of that catalog** — `unpricedCount` on the Catalogs page and the flagged rows on the catalog page show exactly which products to price (review I-1; the verify's J3 reproduces it); (c) cosmetic: a product left with one active `cos-` variant keeps printing its variant name ("Toast (Regular)").
8. **`stackable` is stored and editable but not used** by the counter or QR (as since Sub-plan 1); Feedme stores it too. **Assumed — Feedme behaviour (owner asleep, 2026-10-24).**
9. **Unsaved changes:** both editors now ask before the tab is closed or reloaded with unsaved changes (`beforeunload`). Moving to another `/menu` page inside the app does not ask (React Router's in-app blocker would need a data router); add it if owners lose edits that way.
10. **Product names are not unique**, as in Feedme. **Assumed — Feedme behaviour (owner asleep, 2026-10-24).**
11. **A variant cannot be taken out of one catalog only** (M1 Open point 2 stands): prices are never deleted, so a variant is either on (priced in every catalog that sells the product) or off everywhere.
12. **Catalog "used by" lists active branches only** (`coalesce(branches.is_active, true)`), and so does the switch-off refusal.
13. **The server is the truth by convention, not yet by policy** (review Minor 10). M1's `<catalog table>_insert` / `_update` policies and `menu_products_edit` / `menu_variants_edit` still let an Edit menu holder write those tables directly over REST, past `menu_save_*` validation (e.g. a catalog row without prices). M2 adds no direct write; the Products page's SST / print-route quick edits still use `menu_products_edit`. Once those move to an RPC, a policy clean-up can drop the direct write policies.
14. **Only changed details and catalogs are sent** (review I-3), so a stale editor tab no longer undoes other edits; two people editing the same field of the same product still last-write-wins (no version check), and variants and add-on group links are always sent whole (a variant added in another tab makes the save refuse with "The product changed since you opened it"; a variant renamed or a link changed there is overwritten).
