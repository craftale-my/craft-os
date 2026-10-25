# Menu back-office tidy-up (Feedme layout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give /menu Feedme's back-office layout in Craft OS colours: a left sub-menu (Products, Categories, Add-on groups, Takeaway fees, Schedules, Print routes, Catalogs, Import from Feedme), one page header with a count chip on every page, a flat Products table with photos (click a photo to change it) and a bulk bar (print route, SST, takeaway fee, on/off), and two new grouped pages, **Takeaway fees** and **Print routes**, with no new table.

**Architecture:** One idempotent migration, `supabase/migration-2026-10-25-menu-list-photo.sql`, re-creates `menu_product_list` with `image_path` and `image_updated_at` added (Task 1). Nothing else changes on the server. Bulk edits and the grouped pages write through the existing `updateProducts(ids, patch)` (chunks of 100, `menu_products` update policy = Edit menu). The client's view logic is pure and tested: `productTable.ts` (flat rows, cells, selection reducer), `productGroups.ts` (group by fee / route, "+ New" parsing), `photo.ts` (`versionedPhotoUrl`), `menuView.ts` (sub-menu order and active item). Components: `MenuShell.tsx` (sub-menu frame around every /menu route), `PageHeader` and table classes in `editorUi.tsx`, `useMenuData.ts` (list + lookups load), `ProductTable.tsx`, `BulkBar.tsx`, the rewritten `ProductListPage.tsx`, and `ProductPicker.tsx` + `ProductGroupsView.tsx` shared by `TakeawayFeesPage.tsx` and `PrintRoutesPage.tsx`.

**Tech Stack:** React 19, Vite 6, TypeScript (strict, `noUnusedLocals`, `noUnusedParameters`, lib ES2020), Tailwind 3.4, react-router-dom 7, supabase-js, Vitest 2 (node environment). No ESLint config; the gates are `npx tsc -b` (no output) and `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-10-25-menu-backoffice-tidy-design.md` (commit `b549d96`). This plan covers its sections **2 (Menu back-office layout)**, **3 (Server)** and **Testing**. Section 1 (Photos from Feedme: the download and the zip import on dev) is done by the controller without code and is **not** in this plan; neither is its "Photos" count check.

## Resolutions (decided while planning, 2026-10-25)

- **"Default variant"** has no flag in the data: it is the first switched-on variant in variant order (`sort_order`, then name — the order `menu_product_list` already returns). No switched-on variant → "—". The Product cell shows "N variants" under the name when more than one variant is switched on.
- **Selection:** a filter or search change clears the ticks (spec); a bulk action that succeeds clears them too (the rows it switched off may leave the view). Set print route / Set SST / Set takeaway fee ask for the value in an inline row under the bar; Switch on applies at once; Switch off asks `window.confirm` first (it takes products off the counter and QR). After every bulk write — also a failed one, since earlier chunks of 100 may be written — the list is read again.
- **Print route choices** in the bulk bar: Feedme's four (`PRINT_ROUTES`: Bar, Kitchen, Bakery, Front House), then any other name a product already uses (A–Z), then "No ticket" (null).
- **Grouped pages** count every product that is not an add-on item, switched-off ones too (marked "(off)"): the dev figures RM 1.00 · 97, Bar · 36, Kitchen · 61 were set on all non-add-on Craft Cafe products. Groups sort by amount (fees) or name (routes), with **"No fee" / "No ticket" last**. That last group can be opened to see its products but has no Remove (it would change nothing) and no Add products (adding to "none" is Remove from another group); a note says so.
- **"+ New fee"** must be above RM 0.00 ("Enter the fee in RM, e.g. 1.50" / "A fee must be more than RM 0.00 — Remove takes a product off its fee"). An amount already in use simply opens that group with the picker. **"+ New route"** is a name (`nameProblem('Route', …, 40)`: required, at most 40 characters); a name already in use, letter case ignored, opens that route with its stored spelling, because each branch maps the exact name to a printer.
- **Count chips:** Products = every product (410 on dev), Categories / Add-on groups / Schedules / Catalogs = their rows, Takeaway fees / Print routes = the amounts / routes in use (the "none" group not counted). The editors, the catalog grid and the import get the same header with no chip and their Back link as the action.
- **"Same header and table styling"** for Categories, Add-on groups, Schedules, Catalogs and Import: every page gets `PageHeader`; the table classes (`tableBoxCls`, sticky `theadCls`, `rowCls` hover, `numCls` right-aligned numbers) are applied to the one real table among them (Add-on groups). Categories, Schedules and Catalogs are card lists with per-row actions and stay card lists — behaviour unchanged.
- **Products header actions:** "Import" is a link to `/menu/import`; "+ Add product" goes to `/menu/products/new`.
- **Photo from the list:** the row's photo button opens one hidden file input; the file goes through the editor's `uploadProductPhoto` (800 px WebP, `menu-images`, `menu_set_product_image`), then `menu_product_extras` re-reads that one product and patches its row (a full reload if that read fails). The thumbnail URL is `publicPhotoUrl(path)` + `?v=<image_updated_at in ms>`; paths are already random per upload, so the version is only a guard against a stale cache, as the spec asks.
- **pg-safeupdate scan:** `src/features/pos/sqlSafeUpdate.test.ts` reads only `migration-*-pos-*.sql`, so the new `migration-…-menu-list-photo.sql` would be skipped. The scan's pattern widens to `(pos|menu)` and one new test checks the new file's function list and its grants, `search_path`, STOP guard and closing `notify`.
- **Narrow screens:** below 900 px (Tailwind `min-[900px]:` variants) the sub-menu is a strip above the page that scrolls sideways. At iPad 1180 px the app sidebar (240 px) and the sub-menu (176 px) leave ~730 px: the Products table scrolls sideways inside its own box; the page itself never scrolls sideways.

## Global Constraints

- **Dev database only, by the controller.** The SQL is applied on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) by the controller from the owner's Chrome tab on the dashboard SQL editor; the implementer never touches any database, never pushes, never uses a bare `git stash`. Prod is a later step the owner decides: there the migration runs right before the first deploy that carries Task 5 (until then the Products page simply shows no photos — `image_path` is `undefined`).
- **SQL rules:** canonical SQL function = the newest migration that re-creates it; `menu_product_list` moves from `migration-2026-10-24-pos-menu-editor-fn.sql` to the new file, whose header says so, and the editor-fn header gets a re-run note. The new file is idempotent (`create or replace`), `security definer`, `set search_path = public, pg_temp`, `revoke all … from public, anon` + `grant execute … to authenticated`, STOPs (raises) when `menu_products.image_path` is missing, and ends with `notify pgrst, 'reload schema';` before its final `select`. Every UPDATE/DELETE has a WHERE (the new file has none).
- **No new server objects** besides that re-created function: no table, column, policy or RPC. Bulk edits use `updateProducts` and the existing `menu_products_edit` policy (Edit menu, `has_menu_cap('manage_menu')`); `/menu/*` is already gated on `manage_menu` in `src/App.tsx`, so pages do no cap check of their own.
- **Copy is English**, exactly the spec's where it names it: "Products", "Categories", "Add-on groups", "Takeaway fees", "Schedules", "Print routes", "Catalogs", "Import from Feedme", "Import", "+ Add product", "Show add-ons", "Show switched-off", "N selected", "Set print route", "Set SST", "Set takeaway fee", "Switch on", "Switch off", "Clear", "On" / "Off", "RM 1.00 · 97 products", "No fee", "No ticket", "Remove", "Add products", "+ New fee", "+ New route", "No products match.", "No products with this fee yet.".
- **Colours and type:** Craft OS tokens only (`bg-brown-btn`, `hover:bg-brown-btn-hover`, `hover:bg-cream`, `border-border`, `bg-card`, `text-brown-muted`, `text-brown-faint`, `bg-border` for the grey photo placeholder, `shadow-card`); no orange (`#C4813A` / `xp`), no new fonts. Buttons reuse `btnCls` / `linkBtnCls` / `inputCls` from `editorUi.tsx`.
- **Tables:** sticky header, row hover, money right-aligned (`numCls`), 48 px square photo on Products (`h-12 w-12`, `object-cover`, `loading="lazy"`).
- **Small focused files:** no `.ts` / `.tsx` file this plan creates or rewrites passes ~250 lines. Match the surrounding comment density: a `/** … */` doc comment per component and per exported function, short end-of-line comments only where a reason is not obvious.
- **UI lessons from M1–M3:** every write button is disabled while it runs and a ref refuses a second click in the same render; every input has a visible label or an `aria-label`; an older load reply never lands last (`loadSeq`); errors show in `OutcomeLine` next to what made them, with "Try again" for a failed load.
- **TypeScript:** lib is ES2020 — no `Array.prototype.at`, no `findLast`. Remove an import the moment it is unused (`noUnusedLocals`).
- **Gates after every task:** `npx tsc -b` prints nothing; `npx vitest run` passes. Baseline at `b549d96`: **104 files, 905 tests**. Expected after each task: T1 104/907, T2 105/920, T3 106/925, T4 106/927, T5 106/927, T6 106/927.
- **Commits:** one per task, message as given, ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- **Shared worktree:** `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`. Every replacement below quotes its old text; if one does not match, another session changed the file since `b549d96` — read it and apply the same change to what is there.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migration-2026-10-25-menu-list-photo.sql` (new) | `menu_product_list` with `image_path`, `image_updated_at` | 1 |
| `supabase/migration-2026-10-24-pos-menu-editor-fn.sql` | Header re-run note only | 1 |
| `src/features/pos/sqlSafeUpdate.test.ts` | Scans `-menu-` migrations too; checks the new file | 1 |
| `src/features/pos/menu/menuApi.ts` | `MenuProductRow` gains the photo fields; `ProductPatch` gains fee and on/off | 1 |
| `src/features/pos/menu/menuView.test.ts` | Row helper gains the photo fields (T1); sub-menu tests (T4) | 1, 4 |
| `src/features/pos/menu/testing/menuRow.ts` (new) | Test helper: one `MenuProductRow` | 2 |
| `src/features/pos/menu/productTable.ts` (+ `.test.ts`, new) | Flat rows, cell texts, route choices, selection reducer | 2 |
| `src/features/pos/menu/photo.ts` (+ test) | `versionedPhotoUrl` | 2 |
| `src/features/pos/menu/photoUpload.ts` | `productThumbUrl` | 2 |
| `src/features/pos/menu/productGroups.ts` (+ `.test.ts`, new) | Group by fee / by route; "+ New fee" / "+ New route" parsing | 3 |
| `src/features/pos/menu/menuView.ts` | `MENU_TABS` in Feedme's order; `menuTab` knows the two new pages | 4 |
| `src/features/pos/menu/MenuShell.tsx` (new) | Left sub-menu (strip below 900 px) around every /menu page | 4 |
| `src/features/pos/menu/MenuTabs.tsx` | Deleted | 4 |
| `src/features/pos/menu/editorUi.tsx` | `PageHeader` and the table classes | 4 |
| `src/features/pos/menu/MenuRoutes.tsx` | Wraps the routes in `MenuShell` (T4); two new routes (T6) | 4, 6 |
| `CategoriesPage`, `GroupListPage`, `SchedulesPage`, `CatalogsPage`, `MenuImportPage`, `ProductEditorPage`, `GroupEditorPage`, `ScheduleEditorPage`, `CatalogGridPage` (`.tsx`) | `PageHeader` instead of `MenuTabs` + own header; Add-on groups table classes | 4 |
| `src/features/pos/menu/useMenuData.ts` (new) | Loads `fetchMenu` + `fetchLookups` together | 5 |
| `src/features/pos/menu/ProductTable.tsx` (new) | The flat Products table | 5 |
| `src/features/pos/menu/BulkBar.tsx` (new) | "N selected" bar and its value row | 5 |
| `src/features/pos/menu/ProductListPage.tsx` | Rewritten: header, filters, bulk bar, table, photo picker | 4 (interim), 5 |
| `src/features/pos/menu/ProductPicker.tsx` (new) | "Add products": search + category, multi-select | 6 |
| `src/features/pos/menu/ProductGroupsView.tsx` (new) | The grouped page (list of values → products of one value) | 6 |
| `src/features/pos/menu/TakeawayFeesPage.tsx`, `PrintRoutesPage.tsx` (new) | Their `GroupedValue` configs | 6 |

---

### Task 1: `menu_product_list` returns the photo (SQL), the pg-safeupdate scan, the row type — and applying it on craft-os-dev (implementer + controller)

**Model tier:** cheap (the plan carries every line); the controller runs Step 8.

**Files:**
- Create: `supabase/migration-2026-10-25-menu-list-photo.sql`
- Modify: `supabase/migration-2026-10-24-pos-menu-editor-fn.sql` (header lines 14–16)
- Modify: `src/features/pos/sqlSafeUpdate.test.ts` (line 10, the file list, a new `it` at the end)
- Modify: `src/features/pos/menu/menuApi.ts` (lines 17–22, 32–34)
- Modify: `src/features/pos/menu/menuView.test.ts` (lines 5–11)

**Interfaces:**
- Consumes: `menu_require_editor()` (editor-fn), `menu_products.image_path` / `image_updated_at` (slots-photos).
- Produces: RPC `menu_product_list()` → each element also has `image_path: string | null`, `image_updated_at: string | null` (ISO timestamptz). TypeScript:
  ```ts
  interface MenuProductRow { /* …existing… */ image_path: string | null; image_updated_at: string | null }
  type ProductPatch = Partial<Pick<MenuProductRow, 'sst_rate_bp' | 'print_route' | 'takeaway_fee_sen' | 'is_active'>>
  ```

- [ ] **Step 1: Write the failing test** — in `src/features/pos/sqlSafeUpdate.test.ts`:

Replace

```ts
const POS_MIGRATION = /^migration-.*-pos-.*\.sql$/
```

with

```ts
// the menu back-office's own migrations (migration-*-menu-*.sql) are scanned too
const POS_MIGRATION = /^migration-.*-(pos|menu)-.*\.sql$/
```

Replace

```ts
      'migration-2026-10-25-pos-hardening.sql',
    ]))
  })
```

with

```ts
      'migration-2026-10-25-pos-hardening.sql',
      'migration-2026-10-25-menu-list-photo.sql',
    ]))
  })
```

Replace the end of the file

```ts
      'claim_print_job', 'finish_print_job', 'requeue_print_job',
    ]))
  })
})
```

with

```ts
      'claim_print_job', 'finish_print_job', 'requeue_print_job',
    ]))
  })

  it('scans the menu back-office tidy-up: menu_product_list with photos, same grants, a STOP guard', () => {
    const sql = readFileSync(new URL('migration-2026-10-25-menu-list-photo.sql', SUPABASE), 'utf8')
    expect(functionBodies(sql).map((b) => b.name)).toEqual(['menu_product_list'])
    expect(sql).toMatch(/security definer set search_path = public, pg_temp as \$\$/)
    expect(sql).toMatch(/'image_path', p\.image_path, 'image_updated_at', p\.image_updated_at/)
    expect(sql).toMatch(/revoke all on function menu_product_list\(\) from public, anon;/)
    expect(sql).toMatch(/grant execute on function menu_product_list\(\) to authenticated;/)
    expect(sql).toMatch(/raise exception 'STOP: menu_products\.image_path is missing/)
    expect(sql).toMatch(/notify pgrst, 'reload schema';\s*select '[^']+' as result;\s*$/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: FAIL — "reads the POS function migrations" (the list lacks `migration-2026-10-25-menu-list-photo.sql`) and the new test (`ENOENT: no such file or directory … migration-2026-10-25-menu-list-photo.sql`).

- [ ] **Step 3: Write the migration** — create `supabase/migration-2026-10-25-menu-list-photo.sql`:

```sql
-- ============================================================================
-- Craft OS — menu back-office tidy-up (2026-10-25): the Products list shows photos.
-- Run on craft-os-dev after migration-2026-10-24-pos-menu-editor-fn.sql and
-- migration-2026-10-24-pos-slots-photos.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-25-menu-backoffice-tidy.md
-- Design: docs/superpowers/specs/2026-10-25-menu-backoffice-tidy-design.md §3
--
-- Canonical from here on: menu_product_list (from migration-2026-10-24-pos-menu-editor-fn.sql),
-- re-created from its live text with only the marked line added — each product's image_path
-- and image_updated_at (the thumbnail's cache-buster). Re-running the editor-fn file brings
-- back the list without photos: re-run this file afterwards.
-- Nothing else changes on the server: the Products page's bulk edits and the Takeaway fees
-- and Print routes pages write through the existing menu_products update policy (Edit menu).
-- No DELETE / UPDATE here (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_products' and column_name = 'image_path')
     or not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_products' and column_name = 'image_updated_at') then
    raise exception 'STOP: menu_products.image_path is missing — run migration-2026-10-24-pos-slots-photos.sql first';
  end if;
  if to_regprocedure('menu_require_editor()') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-menu-editor-fn.sql first (menu_require_editor is missing)';
  end if;
end $$;

-- The Products page: every product, switched-off ones too, in one JSON value (no 1000-row cap).
create or replace function menu_product_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform menu_require_editor();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'is_active', p.is_active, 'is_addon', p.is_addon,
             'sst_rate_bp', p.sst_rate_bp, 'print_route', p.print_route, 'takeaway_fee_sen', p.takeaway_fee_sen,
             'sort_order', p.sort_order, 'category_id', p.category_id,
             'image_path', p.image_path, 'image_updated_at', p.image_updated_at,          -- 2026-10-25: the list's photo
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

-- PostgREST picks up the new list now, not at its next poll
notify pgrst, 'reload schema';

select 'menu list photo applied' as result;
```

- [ ] **Step 4: Add the re-run note to the editor-fn header** — in `supabase/migration-2026-10-24-pos-menu-editor-fn.sql` replace

```sql
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================
```

with

```sql
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- Re-run note (2026-10-25): menu_product_list is canonical in
-- migration-2026-10-25-menu-list-photo.sql (it adds each product's photo). Re-running
-- this file brings back the list without photos — re-run that file afterwards.
-- ============================================================================
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS, including `migration-2026-10-25-menu-list-photo.sql: every DELETE / UPDATE inside a function has a WHERE` and the new test.

- [ ] **Step 6: The row type and the patch type** — in `src/features/pos/menu/menuApi.ts` replace

```ts
  category_id: string | null
  category: { name: string; sort_order: number } | null
  menu_variants: MenuVariantRow[]
  catalog_ids: string[]
}
export type ProductPatch = Partial<Pick<MenuProductRow, 'sst_rate_bp' | 'print_route'>>
```

with

```ts
  category_id: string | null
  /** the product photo: a path in the menu-images bucket, and when it was set (the thumbnail's cache-buster) */
  image_path: string | null
  image_updated_at: string | null
  category: { name: string; sort_order: number } | null
  menu_variants: MenuVariantRow[]
  catalog_ids: string[]
}
/** What the Products page's bulk bar and the Takeaway fees / Print routes pages change. */
export type ProductPatch = Partial<Pick<MenuProductRow, 'sst_rate_bp' | 'print_route' | 'takeaway_fee_sen' | 'is_active'>>
```

and replace

```ts
/** One patch for many products (e.g. a whole category's print route), written in
```

with

```ts
/** One patch for many products (the bulk bar, Takeaway fees, Print routes), written in
```

In `src/features/pos/menu/menuView.test.ts` replace

```ts
    takeaway_fee_sen: 0, sort_order: 0, category_id: 'tea', category: { name: 'TEA', sort_order: 0 }, menu_variants: [],
    catalog_ids: [], ...over,
```

with

```ts
    takeaway_fee_sen: 0, sort_order: 0, category_id: 'tea', category: { name: 'TEA', sort_order: 0 }, image_path: null,
    image_updated_at: null, menu_variants: [], catalog_ids: [], ...over,
```

- [ ] **Step 7: Gates and commit**

Run: `npx tsc -b` → no output. Run: `npx vitest run` → `Test Files  104 passed (104)`, `Tests  907 passed (907)`.

```bash
git add supabase/migration-2026-10-25-menu-list-photo.sql supabase/migration-2026-10-24-pos-menu-editor-fn.sql \
  src/features/pos/sqlSafeUpdate.test.ts src/features/pos/menu/menuApi.ts src/features/pos/menu/menuView.test.ts
git commit -m "feat(menu-sql): menu_product_list returns each product's photo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8 (controller, craft-os-dev — dashboard SQL editor in the owner's Chrome tab; the implementer does not touch the database):** confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`), never prod. Apply `supabase/migration-2026-10-25-menu-list-photo.sql` twice → both runs answer `menu list photo applied`. Then run `supabase/migration-2026-10-24-pos-menu-editor-verify.sql` and `supabase/migration-2026-10-24-pos-slots-photos-verify.sql` → each prints **VERIFY OK**. Then `select pg_get_functiondef('menu_product_list()'::regprocedure) like '%image_updated_at%' as has_photo;` → `true`.

---

### Task 2: The Products table's pure view logic and the photo URL builder

**Model tier:** cheap.

**Files:**
- Create: `src/features/pos/menu/testing/menuRow.ts`
- Create: `src/features/pos/menu/productTable.ts`
- Test: `src/features/pos/menu/productTable.test.ts` (new)
- Modify: `src/features/pos/menu/photo.ts` (append), `src/features/pos/menu/photo.test.ts`
- Modify: `src/features/pos/menu/photoUpload.ts` (lines 7, 10)

**Interfaces:**
- Consumes: `MenuProductRow`, `MenuVariantRow` (Task 1); `groupMenu`, `MenuFilter`, `PRINT_ROUTES` (`menuView.ts`).
- Produces (`productTable.ts`):
  ```ts
  export const NO_FILTER: MenuFilter
  export function tableRows(rows: MenuProductRow[], f: MenuFilter): MenuProductRow[]
  export const ringgit: (sen: number) => string                      // "RM 1.00"
  export function defaultPrice(variants: Pick<MenuVariantRow, 'name' | 'price_sen' | 'is_active' | 'sort_order'>[]): string
  export function variantCountText(variants: Pick<MenuVariantRow, 'is_active'>[]): string
  export function soldInText(names: string[]): string
  export const sstText: (bp: number) => string
  export const feeText: (sen: number) => string
  export const routeText: (route: string | null) => string
  export function routeChoices(rows: Pick<MenuProductRow, 'print_route'>[]): string[]
  export interface TableState { filter: MenuFilter; selected: ReadonlySet<string> }
  export type TableAction = { type: 'filter'; patch: Partial<MenuFilter> } | { type: 'toggle'; id: string }
    | { type: 'toggleAll'; visibleIds: string[] } | { type: 'clear' }
  export function tableReducer(s: TableState, a: TableAction): TableState
  export function headerState(selected: ReadonlySet<string>, visibleIds: string[]): 'all' | 'some' | 'none'
  ```
  `photo.ts`: `export function versionedPhotoUrl(url: string, updatedAt: string | null): string`.
  `photoUpload.ts`: `export const productThumbUrl: (path: string, updatedAt: string | null) => string`.
  `testing/menuRow.ts`: `export function menuRow(over: Partial<MenuProductRow>): MenuProductRow`.

- [ ] **Step 1: The test helper** — create `src/features/pos/menu/testing/menuRow.ts`:

```ts
// src/features/pos/menu/testing/menuRow.ts
import type { MenuProductRow } from '../menuApi'

/** One product as menu_product_list returns it: a switched-on TEA drink with no photo, unless `over` says otherwise. */
export function menuRow(over: Partial<MenuProductRow>): MenuProductRow {
  return {
    id: over.name ?? 'x', name: 'x', is_active: true, is_addon: false, sst_rate_bp: 600, print_route: null,
    takeaway_fee_sen: 0, sort_order: 0, category_id: 'tea', category: { name: 'TEA', sort_order: 0 }, image_path: null,
    image_updated_at: null, menu_variants: [], catalog_ids: [], ...over,
  }
}
```

- [ ] **Step 2: Write the failing tests** — create `src/features/pos/menu/productTable.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  NO_FILTER, defaultPrice, feeText, headerState, routeChoices, routeText, soldInText, sstText, tableReducer, tableRows,
  variantCountText, type TableState,
} from './productTable'
import { menuRow as row } from './testing/menuRow'

const v = (name: string, price_sen: number, sort_order: number, is_active = true) => ({ id: name, name, price_sen, is_active, sort_order })

describe('tableRows', () => {
  const rows = [
    row({ name: 'Smoked Duck DON', sort_order: 1, category_id: 'don', category: { name: 'DONBURI', sort_order: 1 } }),
    row({ name: 'Lychee Rose', sort_order: 2 }),
    row({ name: 'Apple Tea', sort_order: 1 }),
    row({ name: 'Oat milk', is_addon: true, category_id: 'addon', category: { name: 'ADDON', sort_order: 2 } }),
    row({ name: 'Old Tea', sort_order: 3, is_active: false }),
    row({ name: 'Mystery', category_id: null, category: null }),
  ]

  it('is one flat list: category order, then product order, uncategorised last', () => {
    expect(tableRows(rows, NO_FILTER).map((r) => r.name)).toEqual(['Apple Tea', 'Lychee Rose', 'Smoked Duck DON', 'Mystery'])
  })

  it('applies the filters and the search', () => {
    expect(tableRows(rows, { ...NO_FILTER, showAddons: true, showInactive: true }).map((r) => r.name))
      .toEqual(['Apple Tea', 'Lychee Rose', 'Old Tea', 'Smoked Duck DON', 'Oat milk', 'Mystery'])
    expect(tableRows(rows, { ...NO_FILTER, search: 'TEA' }).map((r) => r.name)).toEqual(['Apple Tea'])
    expect(tableRows(rows, { ...NO_FILTER, categoryId: 'don' }).map((r) => r.name)).toEqual(['Smoked Duck DON'])
  })
})

describe('cells', () => {
  it('prices the default variant: the first switched-on one in variant order', () => {
    expect(defaultPrice([v('Large', 1450, 1), v('Regular', 1250, 0)])).toBe('RM 12.50')
    expect(defaultPrice([v('Regular', 1250, 0, false), v('Large', 1450, 1)])).toBe('RM 14.50')
    expect(defaultPrice([v('Regular', 1250, 0, false)])).toBe('—')
    expect(defaultPrice([])).toBe('—')
  })

  it('counts the switched-on variants when there is more than one', () => {
    expect(variantCountText([v('a', 1, 0), v('b', 1, 1), v('c', 1, 2, false)])).toBe('2 variants')
    expect(variantCountText([v('a', 1, 0), v('b', 1, 1, false)])).toBe('')
    expect(variantCountText([])).toBe('')
  })

  it('names two catalogs, then +N', () => {
    expect(soldInText([])).toBe('No catalog')
    expect(soldInText(['Craft Cafe'])).toBe('Craft Cafe')
    expect(soldInText(['Craft Cafe', 'Grab Food'])).toBe('Craft Cafe, Grab Food')
    expect(soldInText(['Craft Cafe', 'Grab Food', 'QR', 'Staff Meal'])).toBe('Craft Cafe, Grab Food +2')
  })

  it('writes SST, takeaway fee and print route the way the table shows them', () => {
    expect(sstText(600)).toBe('6%')
    expect(sstText(0)).toBe('0%')
    expect(feeText(100)).toBe('RM 1.00')
    expect(feeText(0)).toBe('—')
    expect(routeText('Bar')).toBe('Bar')
    expect(routeText(null)).toBe('No ticket')
  })

  it("offers Feedme's print routes, then the other names products use, A–Z", () => {
    expect(routeChoices([{ print_route: 'Kitchen' }, { print_route: 'Pastry' }, { print_route: null }, { print_route: 'Dessert' }]))
      .toEqual(['Bar', 'Kitchen', 'Bakery', 'Front House', 'Dessert', 'Pastry'])
    expect(routeChoices([])).toEqual(['Bar', 'Kitchen', 'Bakery', 'Front House'])
  })
})

describe('tableReducer', () => {
  const start: TableState = { filter: NO_FILTER, selected: new Set() }

  it('ticks and unticks one row', () => {
    const s = tableReducer(start, { type: 'toggle', id: 'a' })
    expect([...s.selected]).toEqual(['a'])
    expect([...tableReducer(s, { type: 'toggle', id: 'a' }).selected]).toEqual([])
  })

  it('select all ticks every visible row; a second time unticks them', () => {
    const some = tableReducer(start, { type: 'toggle', id: 'a' })
    const all = tableReducer(some, { type: 'toggleAll', visibleIds: ['a', 'b', 'c'] })
    expect([...all.selected].sort()).toEqual(['a', 'b', 'c'])
    expect(tableReducer(all, { type: 'toggleAll', visibleIds: ['a', 'b', 'c'] }).selected.size).toBe(0)
    expect(tableReducer(start, { type: 'toggleAll', visibleIds: [] }).selected.size).toBe(0)
  })

  it('a filter or search change clears the ticks and keeps the other filters', () => {
    const ticked = tableReducer({ ...start, filter: { ...NO_FILTER, showAddons: true } }, { type: 'toggle', id: 'a' })
    const s = tableReducer(ticked, { type: 'filter', patch: { search: 'latte' } })
    expect(s.selected.size).toBe(0)
    expect(s.filter).toEqual({ ...NO_FILTER, showAddons: true, search: 'latte' })
  })

  it('Clear unticks everything', () => {
    const s = tableReducer(tableReducer(start, { type: 'toggle', id: 'a' }), { type: 'toggle', id: 'b' })
    expect(tableReducer(s, { type: 'clear' }).selected.size).toBe(0)
  })
})

describe('headerState', () => {
  it('says whether all, some or none of the visible rows are ticked', () => {
    expect(headerState(new Set(['a', 'b']), ['a', 'b'])).toBe('all')
    expect(headerState(new Set(['a']), ['a', 'b'])).toBe('some')
    expect(headerState(new Set(), ['a', 'b'])).toBe('none')
    expect(headerState(new Set(), [])).toBe('none')
  })
})
```

Append to the `describe('photo rules', …)` block of `src/features/pos/menu/photo.test.ts` — replace

```ts
    expect(imageTypeFromName('notes.txt')).toBe('')
    expect(imageTypeFromName('8812')).toBe('')
  })
})
```

with

```ts
    expect(imageTypeFromName('notes.txt')).toBe('')
    expect(imageTypeFromName('8812')).toBe('')
  })
  it('versions a photo URL by when the photo was set, so a cached older picture never shows', () => {
    const url = 'https://x.supabase.co/storage/v1/object/public/menu-images/products/p/abcdefgh.webp'
    const ms = Date.parse('2026-10-25T03:00:00.123Z')
    expect(versionedPhotoUrl(url, '2026-10-25T03:00:00.123456+00:00')).toBe(`${url}?v=${ms}`)
    expect(versionedPhotoUrl(`${url}?a=1`, '2026-10-25T03:00:00.123Z')).toBe(`${url}?a=1&v=${ms}`)
    expect(versionedPhotoUrl(url, null)).toBe(url)
    expect(versionedPhotoUrl(url, 'not a date')).toBe(url)
  })
})
```

and change its import to

```ts
import {
  PHOTO_MAX_HEIGHT, PHOTO_MAX_INPUT_BYTES, PHOTO_MAX_WIDTH, PHOTO_QUALITY, imageTypeFromName, photoInputProblem, photoPath, resizeTarget,
  versionedPhotoUrl,
} from './photo'
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/features/pos/menu/productTable.test.ts src/features/pos/menu/photo.test.ts`
Expected: FAIL — `Failed to resolve import "./productTable"` and `versionedPhotoUrl is not a function` (or not exported).

- [ ] **Step 4: Write `src/features/pos/menu/productTable.ts`**

```ts
// src/features/pos/menu/productTable.ts
/** The Products page's flat table (Feedme's layout), pure so it is tested: which rows show and in
 *  what order, what each cell says, and which rows the bulk bar acts on. */
import type { MenuProductRow, MenuVariantRow } from './menuApi'
import { PRINT_ROUTES, groupMenu, type MenuFilter } from './menuView'

export const NO_FILTER: MenuFilter = { search: '', showAddons: false, showInactive: false, categoryId: null, catalogId: null }

/** The rows the filters show, flat: category order, then product order (groupMenu's order). */
export function tableRows(rows: MenuProductRow[], f: MenuFilter): MenuProductRow[] {
  return groupMenu(rows, f).flatMap((s) => s.products)
}

export const ringgit = (sen: number): string => `RM ${(sen / 100).toFixed(2)}`

/** The default variant's price: the first switched-on variant in variant order; '—' when none is on. */
export function defaultPrice(variants: Pick<MenuVariantRow, 'name' | 'price_sen' | 'is_active' | 'sort_order'>[]): string {
  const first = variants
    .filter((v) => v.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))[0]
  return first ? ringgit(first.price_sen) : '—'
}

/** "3 variants" under the name when more than one variant is switched on; '' otherwise. */
export function variantCountText(variants: Pick<MenuVariantRow, 'is_active'>[]): string {
  const n = variants.filter((v) => v.is_active).length
  return n > 1 ? `${n} variants` : ''
}

/** The Sold in cell: up to two catalog names, then "+N"; "No catalog" when none sells it. */
export function soldInText(names: string[]): string {
  if (names.length === 0) return 'No catalog'
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

export const sstText = (bp: number): string => `${bp / 100}%`
export const feeText = (sen: number): string => (sen > 0 ? ringgit(sen) : '—')
export const routeText = (route: string | null): string => route ?? 'No ticket'

/** The print routes the bulk bar offers: Feedme's four, then any other name a product uses (A–Z). */
export function routeChoices(rows: Pick<MenuProductRow, 'print_route'>[]): string[] {
  const known: readonly string[] = PRINT_ROUTES
  const extra = new Set<string>()
  for (const r of rows) if (r.print_route && !known.includes(r.print_route)) extra.add(r.print_route)
  return [...known, ...[...extra].sort((a, b) => a.localeCompare(b))]
}

/** The filters and the ticked rows. A filter change clears the ticks: the bulk bar acts only on rows on screen. */
export interface TableState { filter: MenuFilter; selected: ReadonlySet<string> }
export type TableAction =
  | { type: 'filter'; patch: Partial<MenuFilter> }
  | { type: 'toggle'; id: string }
  | { type: 'toggleAll'; visibleIds: string[] }
  | { type: 'clear' }

const NONE: ReadonlySet<string> = new Set()

export function tableReducer(s: TableState, a: TableAction): TableState {
  switch (a.type) {
    case 'filter':
      return { filter: { ...s.filter, ...a.patch }, selected: NONE }
    case 'toggle': {
      const next = new Set(s.selected)
      if (next.has(a.id)) next.delete(a.id)
      else next.add(a.id)
      return { ...s, selected: next }
    }
    case 'toggleAll': {
      const all = a.visibleIds.length > 0 && a.visibleIds.every((id) => s.selected.has(id))
      return { ...s, selected: all ? NONE : new Set(a.visibleIds) }
    }
    case 'clear':
      return { ...s, selected: NONE }
  }
}

/** The header tick box: every visible row ticked, some of them, or none. */
export function headerState(selected: ReadonlySet<string>, visibleIds: string[]): 'all' | 'some' | 'none' {
  const n = visibleIds.filter((id) => selected.has(id)).length
  return n === 0 ? 'none' : n === visibleIds.length ? 'all' : 'some'
}
```

Append to `src/features/pos/menu/photo.ts`:

```ts

/** The public URL with the time the photo was set as a version (?v=<ms>), so a browser never shows
 *  a cached older picture; unchanged when that time is missing or unreadable. */
export function versionedPhotoUrl(url: string, updatedAt: string | null): string {
  const ms = updatedAt ? Date.parse(updatedAt) : NaN
  if (Number.isNaN(ms)) return url
  return `${url}${url.includes('?') ? '&' : '?'}v=${ms}`
}
```

In `src/features/pos/menu/photoUpload.ts` replace

```ts
import { PHOTO_BUCKET, photoInputProblem, photoPath } from './photo'
```

with

```ts
import { PHOTO_BUCKET, photoInputProblem, photoPath, versionedPhotoUrl } from './photo'
```

and replace

```ts
export const publicPhotoUrl = (path: string): string => supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl
```

with

```ts
export const publicPhotoUrl = (path: string): string => supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl
/** A list thumbnail (Products, Takeaway fees, Print routes): the public URL, versioned by when the photo was set. */
export const productThumbUrl = (path: string, updatedAt: string | null): string => versionedPhotoUrl(publicPhotoUrl(path), updatedAt)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/pos/menu/productTable.test.ts src/features/pos/menu/photo.test.ts`
Expected: PASS — 12 tests in `productTable.test.ts`, 6 in `photo.test.ts`.

- [ ] **Step 6: Gates and commit**

Run: `npx tsc -b` → no output. Run: `npx vitest run` → `Test Files  105 passed (105)`, `Tests  920 passed (920)`.

```bash
git add src/features/pos/menu/testing/menuRow.ts src/features/pos/menu/productTable.ts src/features/pos/menu/productTable.test.ts \
  src/features/pos/menu/photo.ts src/features/pos/menu/photo.test.ts src/features/pos/menu/photoUpload.ts
git commit -m "feat(menu): Products table view logic, selection reducer and versioned photo URLs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Grouping by takeaway fee and by print route (pure)

**Model tier:** cheap.

**Files:**
- Create: `src/features/pos/menu/productGroups.ts`
- Test: `src/features/pos/menu/productGroups.test.ts` (new)

**Interfaces:**
- Consumes: `NO_FILTER`, `tableRows`, `ringgit`, `routeText` (Task 2); `cleanName`, `inputToSen`, `nameProblem` (`menuForms.ts`); `menuRow` (Task 2, tests).
- Produces:
  ```ts
  export interface ProductGroup<V> { value: V; label: string; products: MenuProductRow[] }
  export type NewValue<V> = { value: V } | { problem: string }
  export const feeLabel: (sen: number) => string                    // "RM 1.00" | "No fee"
  export function groupByFee(rows: MenuProductRow[]): ProductGroup<number>[]
  export function groupByRoute(rows: MenuProductRow[]): ProductGroup<string | null>[]
  export function parseNewFee(text: string): NewValue<number>
  export function parseNewRoute(text: string, existing: string[]): NewValue<string>
  ```

- [ ] **Step 1: Write the failing tests** — create `src/features/pos/menu/productGroups.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { groupByFee, groupByRoute, parseNewFee, parseNewRoute } from './productGroups'
import { menuRow as row } from './testing/menuRow'

const rows = [
  row({ name: 'Latte', takeaway_fee_sen: 100, print_route: 'Bar', sort_order: 1 }),
  row({ name: 'Mocha', takeaway_fee_sen: 100, print_route: 'Bar', sort_order: 2, is_active: false }),
  row({ name: 'Grab Latte', takeaway_fee_sen: 106, print_route: 'Bar', sort_order: 3 }),
  row({ name: 'Duck DON', takeaway_fee_sen: 100, print_route: 'Kitchen', category_id: 'don', category: { name: 'DONBURI', sort_order: 1 } }),
  row({ name: 'Croissant', category_id: 'bakery', category: { name: 'BAKERY', sort_order: 2 } }),
  row({ name: 'Oat milk', is_addon: true, takeaway_fee_sen: 100, print_route: 'Bar' }),
]

describe('groupByFee', () => {
  it('one group per amount, lowest first, No fee last; add-on items left out, switched-off products counted', () => {
    const g = groupByFee(rows)
    expect(g.map((x) => [x.label, x.products.length])).toEqual([['RM 1.00', 3], ['RM 1.06', 1], ['No fee', 1]])
    expect(g.map((x) => x.value)).toEqual([100, 106, 0])
    expect(g[0].products.map((p) => p.name)).toEqual(['Latte', 'Mocha', 'Duck DON'])
  })
})

describe('groupByRoute', () => {
  it('one group per route name, A–Z, No ticket last', () => {
    const g = groupByRoute(rows)
    expect(g.map((x) => [x.label, x.products.length])).toEqual([['Bar', 3], ['Kitchen', 1], ['No ticket', 1]])
    expect(g[g.length - 1].value).toBeNull()
  })

  it('has no group for an empty menu', () => {
    expect(groupByRoute([])).toEqual([])
    expect(groupByFee([row({ name: 'Oat milk', is_addon: true })])).toEqual([])
  })
})

describe('+ New', () => {
  it('a new fee is an amount in RM above zero', () => {
    expect(parseNewFee('1.50')).toEqual({ value: 150 })
    expect(parseNewFee('RM 2')).toEqual({ value: 200 })
    expect(parseNewFee('abc')).toEqual({ problem: 'Enter the fee in RM, e.g. 1.50' })
    expect(parseNewFee('')).toEqual({ problem: 'Enter the fee in RM, e.g. 1.50' })
    expect(parseNewFee('0')).toEqual({ problem: 'A fee must be more than RM 0.00 — Remove takes a product off its fee' })
  })

  it('a new route is a name; one already in use keeps its spelling', () => {
    expect(parseNewRoute('  Pastry   bar ', ['Bar', 'Kitchen'])).toEqual({ value: 'Pastry bar' })
    expect(parseNewRoute('bar', ['Bar', 'Kitchen'])).toEqual({ value: 'Bar' })
    expect(parseNewRoute('   ', ['Bar'])).toEqual({ problem: 'Route name is required' })
    expect(parseNewRoute('x'.repeat(41), ['Bar'])).toEqual({ problem: 'Route name is too long (at most 40 characters)' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/menu/productGroups.test.ts`
Expected: FAIL — `Failed to resolve import "./productGroups"`.

- [ ] **Step 3: Write `src/features/pos/menu/productGroups.ts`**

```ts
// src/features/pos/menu/productGroups.ts
/** The Takeaway fees and Print routes pages, pure so they are tested. Neither has a table of its
 *  own: the fee and the route live on each product, so the pages group the products by that value.
 *  Add-on items are left out (they sell only inside an add-on group); switched-off products count. */
import type { MenuProductRow } from './menuApi'
import { cleanName, inputToSen, nameProblem } from './menuForms'
import { NO_FILTER, ringgit, routeText, tableRows } from './productTable'

export interface ProductGroup<V> { value: V; label: string; products: MenuProductRow[] }
/** What a "+ New" box answers: the value to open, or why it cannot be one. */
export type NewValue<V> = { value: V } | { problem: string }

export const feeLabel = (sen: number): string => (sen > 0 ? ringgit(sen) : 'No fee')

/** Every product that is not an add-on item, in menu order, bucketed by `valueOf`; `none`'s group last. */
function groupBy<V>(
  rows: MenuProductRow[], valueOf: (r: MenuProductRow) => V, label: (v: V) => string, none: V, order: (a: V, b: V) => number,
): ProductGroup<V>[] {
  const buckets = new Map<V, MenuProductRow[]>()
  for (const r of tableRows(rows, { ...NO_FILTER, showInactive: true })) {
    const v = valueOf(r)
    const list = buckets.get(v)
    if (list) list.push(r)
    else buckets.set(v, [r])
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => Number(a === none) - Number(b === none) || order(a, b))
    .map(([value, products]) => ({ value, label: label(value), products }))
}

/** By takeaway fee: lowest amount first, "No fee" last. */
export function groupByFee(rows: MenuProductRow[]): ProductGroup<number>[] {
  return groupBy(rows, (r) => r.takeaway_fee_sen, feeLabel, 0, (a, b) => a - b)
}

/** By print route: names A–Z, "No ticket" last. */
export function groupByRoute(rows: MenuProductRow[]): ProductGroup<string | null>[] {
  return groupBy(rows, (r) => r.print_route, routeText, null, (a, b) => (a ?? '').localeCompare(b ?? ''))
}

/** "+ New fee": an amount in RM above zero ("1.50", "RM 2"). */
export function parseNewFee(text: string): NewValue<number> {
  const sen = inputToSen(text)
  if (sen === null) return { problem: 'Enter the fee in RM, e.g. 1.50' }
  if (sen === 0) return { problem: 'A fee must be more than RM 0.00 — Remove takes a product off its fee' }
  return { value: sen }
}

/** "+ New route": a name of at most 40 characters. A name already in use (letter case ignored) is
 *  that route, spelled as stored: each branch maps the exact name to a printer in POS settings. */
export function parseNewRoute(text: string, existing: string[]): NewValue<string> {
  const problem = nameProblem('Route', text, 40)
  if (problem) return { problem }
  const name = cleanName(text)
  return { value: existing.find((r) => r.toLowerCase() === name.toLowerCase()) ?? name }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/menu/productGroups.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Gates and commit**

Run: `npx tsc -b` → no output. Run: `npx vitest run` → `Test Files  106 passed (106)`, `Tests  925 passed (925)`.

```bash
git add src/features/pos/menu/productGroups.ts src/features/pos/menu/productGroups.test.ts
git commit -m "feat(menu): group products by takeaway fee and by print route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The left sub-menu and one page header on every /menu page

**Model tier:** cheap.

**Files:**
- Modify: `src/features/pos/menu/menuView.ts` (lines 17–34), `src/features/pos/menu/menuView.test.ts` (lines 2, 31–43)
- Create: `src/features/pos/menu/MenuShell.tsx`
- Delete: `src/features/pos/menu/MenuTabs.tsx`
- Modify: `src/features/pos/menu/editorUi.tsx` (append), `src/features/pos/menu/MenuRoutes.tsx`
- Modify: `CategoriesPage.tsx`, `GroupListPage.tsx`, `SchedulesPage.tsx`, `CatalogsPage.tsx`, `MenuImportPage.tsx`, `ProductEditorPage.tsx`, `GroupEditorPage.tsx`, `ScheduleEditorPage.tsx`, `CatalogGridPage.tsx`, `ProductListPage.tsx` (all in `src/features/pos/menu/`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // menuView.ts
  export type MenuTab = 'products' | 'categories' | 'groups' | 'fees' | 'schedules' | 'routes' | 'catalogs' | 'import'
  export const MENU_TABS: { id: MenuTab; label: string; to: string }[]   // paths /menu/takeaway-fees and /menu/print-routes are new
  export function menuTab(pathname: string): MenuTab
  // editorUi.tsx
  export function PageHeader(props: { title: string; count?: number | null; hint?: ReactNode; children?: ReactNode }): JSX.Element
  export const tableBoxCls, tableCls, theadCls, thCls, tdCls, rowCls, numCls: string
  // MenuShell.tsx
  export default function MenuShell({ children }: { children: ReactNode }): JSX.Element
  ```

- [ ] **Step 1: Write the failing test** — in `src/features/pos/menu/menuView.test.ts` replace the import line

```ts
import { UNCATEGORISED, formatPrice, groupMenu, menuTab, soldIn, type MenuFilter } from './menuView'
```

with

```ts
import { MENU_TABS, UNCATEGORISED, formatPrice, groupMenu, menuTab, soldIn, type MenuFilter } from './menuView'
```

and replace the whole `describe('menuTab', …)` block

```ts
describe('menuTab', () => {
  it('maps every /menu path to its tab', () => {
    expect(menuTab('/menu')).toBe('products')
    expect(menuTab('/menu/')).toBe('products')
    expect(menuTab('/menu/products/new')).toBe('products')
    expect(menuTab('/menu/catalogs/abc')).toBe('catalogs')
    expect(menuTab('/menu/groups/new')).toBe('groups')
    expect(menuTab('/menu/categories')).toBe('categories')
    expect(menuTab('/menu/schedules')).toBe('schedules')
    expect(menuTab('/menu/schedules/abc')).toBe('schedules')
    expect(menuTab('/menu/import')).toBe('import')
  })
})
```

with

```ts
describe('the /menu sub-menu', () => {
  it("lists the pages in Feedme's order", () => {
    expect(MENU_TABS.map((t) => t.label)).toEqual([
      'Products', 'Categories', 'Add-on groups', 'Takeaway fees', 'Schedules', 'Print routes', 'Catalogs', 'Import from Feedme',
    ])
    expect(MENU_TABS.map((t) => t.to)).toEqual([
      '/menu', '/menu/categories', '/menu/groups', '/menu/takeaway-fees', '/menu/schedules', '/menu/print-routes',
      '/menu/catalogs', '/menu/import',
    ])
  })

  it('highlights the page a path belongs to', () => {
    expect(menuTab('/menu')).toBe('products')
    expect(menuTab('/menu/')).toBe('products')
    expect(menuTab('/menu/products/new')).toBe('products')
    expect(menuTab('/menu/catalogs/abc')).toBe('catalogs')
    expect(menuTab('/menu/groups/new')).toBe('groups')
    expect(menuTab('/menu/categories')).toBe('categories')
    expect(menuTab('/menu/schedules')).toBe('schedules')
    expect(menuTab('/menu/schedules/abc')).toBe('schedules')
    expect(menuTab('/menu/takeaway-fees')).toBe('fees')
    expect(menuTab('/menu/print-routes')).toBe('routes')
    expect(menuTab('/menu/import')).toBe('import')
  })

  it('every item highlights itself', () => {
    for (const t of MENU_TABS) expect(menuTab(t.to)).toBe(t.id)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/pos/menu/menuView.test.ts`
Expected: FAIL — the labels list lacks 'Takeaway fees' / 'Print routes' / 'Import from Feedme', and `menuTab('/menu/takeaway-fees')` is `'products'`.

- [ ] **Step 3: The sub-menu data** — in `src/features/pos/menu/menuView.ts` replace

```ts
/** The /menu sub-navigation. `menuTab()` decides which tab a path belongs to. */
export type MenuTab = 'products' | 'catalogs' | 'groups' | 'categories' | 'schedules' | 'import'
export const MENU_TABS: { id: Exclude<MenuTab, 'import'>; label: string; to: string }[] = [
  { id: 'products', label: 'Products', to: '/menu' },
  { id: 'catalogs', label: 'Catalogs', to: '/menu/catalogs' },
  { id: 'groups', label: 'Add-on groups', to: '/menu/groups' },
  { id: 'categories', label: 'Categories', to: '/menu/categories' },
  { id: 'schedules', label: 'Schedules', to: '/menu/schedules' },
]
export function menuTab(pathname: string): MenuTab {
  const rest = pathname.replace(/^\/menu\/?/, '')
  if (rest.startsWith('catalogs')) return 'catalogs'
  if (rest.startsWith('groups')) return 'groups'
  if (rest.startsWith('categories')) return 'categories'
  if (rest.startsWith('schedules')) return 'schedules'
  if (rest.startsWith('import')) return 'import'
  return 'products'
}
```

with

```ts
/** The /menu sub-menu, in Feedme's order. `menuTab()` decides which item a path belongs to. */
export type MenuTab = 'products' | 'categories' | 'groups' | 'fees' | 'schedules' | 'routes' | 'catalogs' | 'import'
export const MENU_TABS: { id: MenuTab; label: string; to: string }[] = [
  { id: 'products', label: 'Products', to: '/menu' },
  { id: 'categories', label: 'Categories', to: '/menu/categories' },
  { id: 'groups', label: 'Add-on groups', to: '/menu/groups' },
  { id: 'fees', label: 'Takeaway fees', to: '/menu/takeaway-fees' },
  { id: 'schedules', label: 'Schedules', to: '/menu/schedules' },
  { id: 'routes', label: 'Print routes', to: '/menu/print-routes' },
  { id: 'catalogs', label: 'Catalogs', to: '/menu/catalogs' },
  { id: 'import', label: 'Import from Feedme', to: '/menu/import' },
]
export function menuTab(pathname: string): MenuTab {
  const rest = pathname.replace(/^\/menu\/?/, '')
  if (rest.startsWith('catalogs')) return 'catalogs'
  if (rest.startsWith('groups')) return 'groups'
  if (rest.startsWith('categories')) return 'categories'
  if (rest.startsWith('schedules')) return 'schedules'
  if (rest.startsWith('takeaway-fees')) return 'fees'
  if (rest.startsWith('print-routes')) return 'routes'
  if (rest.startsWith('import')) return 'import'
  return 'products'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/pos/menu/menuView.test.ts`
Expected: PASS.

- [ ] **Step 5: The shell** — create `src/features/pos/menu/MenuShell.tsx`:

```tsx
// src/features/pos/menu/MenuShell.tsx
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MENU_TABS, menuTab } from './menuView'

// A strip above the page that scrolls sideways; from 900 px a column on the left.
const NAV_CLS = [
  'flex gap-1 overflow-x-auto border-b border-border bg-card px-4 py-2',
  'min-[900px]:sticky min-[900px]:top-0 min-[900px]:min-h-screen min-[900px]:w-44 min-[900px]:shrink-0 min-[900px]:flex-col',
  'min-[900px]:overflow-visible min-[900px]:border-b-0 min-[900px]:border-r min-[900px]:px-2 min-[900px]:py-6',
].join(' ')

/** The frame of every /menu page (Feedme's back-office layout): the sub-menu with the current page
 *  highlighted, and the page beside it. Below 900 px the sub-menu becomes a strip above the page. */
export default function MenuShell({ children }: { children: ReactNode }) {
  const tab = menuTab(useLocation().pathname)
  return (
    <div className="min-[900px]:flex min-[900px]:items-start">
      <nav aria-label="Menu pages" className={NAV_CLS}>
        {MENU_TABS.map((t) => (
          <Link key={t.id} to={t.to} aria-current={tab === t.id ? 'page' : undefined}
            className={`shrink-0 whitespace-nowrap rounded px-3 py-2 text-sm ${tab === t.id ? 'bg-brown-btn text-white' : 'hover:bg-cream'}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
```

- [ ] **Step 6: The header and the table classes** — append to `src/features/pos/menu/editorUi.tsx`:

```tsx

/** The header every /menu page shares: the title with a count chip, a hint under it, and the page's
 *  actions on the right. */
export function PageHeader({ title, count, hint, children }: {
  title: string; count?: number | null; hint?: ReactNode; children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {title}
          {count != null && (
            <span className="rounded-full border border-border bg-card px-2 py-0.5 text-sm font-medium text-brown-muted">{count}</span>
          )}
        </h1>
        {hint && <p className="mt-1 text-sm text-brown-muted">{hint}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

/** /menu tables: a box that scrolls on its own (so the header can stick), row hover, numbers right-aligned. */
export const tableBoxCls = 'max-h-[calc(100vh-14rem)] overflow-auto rounded-xl border border-border bg-card'
export const tableCls = 'w-full text-sm'
export const theadCls = 'sticky top-0 z-10 bg-card text-left text-brown-muted shadow-[0_1px_0_theme(colors.border)]'
export const thCls = 'px-3 py-2 font-medium'
export const tdCls = 'px-3 py-2 align-middle'
export const rowCls = 'border-t border-border hover:bg-cream'
export const numCls = 'text-right tabular-nums'
```

- [ ] **Step 7: Wrap the routes, delete the tabs** — replace the whole of `src/features/pos/menu/MenuRoutes.tsx` with:

```tsx
// src/features/pos/menu/MenuRoutes.tsx
import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import MenuShell from './MenuShell'
import ProductListPage from './ProductListPage'
import ProductEditorPage from './ProductEditorPage'
import CatalogsPage from './CatalogsPage'
import CatalogGridPage from './CatalogGridPage'
import GroupListPage from './GroupListPage'
import GroupEditorPage from './GroupEditorPage'
import CategoriesPage from './CategoriesPage'
import SchedulesPage from './SchedulesPage'
import ScheduleEditorPage from './ScheduleEditorPage'
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

function ScheduleEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <ScheduleEditorPage key={id ?? 'new'} scheduleId={id ?? null} />
}

function GroupEditorRoute() {
  const { id } = useParams<{ id: string }>()
  return <GroupEditorPage key={id ?? 'new'} groupId={id ?? null} />
}

/** Everything under /menu (App.tsx gates it on Edit menu), inside the sub-menu frame. */
export default function MenuRoutes() {
  return (
    <MenuShell>
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
        <Route path="schedules" element={<SchedulesPage />} />
        <Route path="schedules/new" element={<ScheduleEditorRoute />} />
        <Route path="schedules/:id" element={<ScheduleEditorRoute />} />
        <Route path="import" element={<MenuImportPage />} />
        <Route path="*" element={<Navigate to="/menu" replace />} />
      </Routes>
    </MenuShell>
  )
}
```

Until Task 6 the two new sub-menu items fall through to `*` and land on Products; that is expected.

Then run: `git rm src/features/pos/menu/MenuTabs.tsx`

- [ ] **Step 8: Every page drops `MenuTabs` and takes `PageHeader`** — in each file below, delete the line `import MenuTabs from './MenuTabs'` and make the replacements shown.

`CategoriesPage.tsx` — import:
`import { OutcomeLine, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'` →
`import { OutcomeLine, PageHeader, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'`; header:

```tsx
      <MenuTabs />
      <div>
        <h1 className="text-2xl font-semibold">Categories</h1>
        <p className="text-sm text-brown-muted">The order here is the order of the counter and the QR menu.</p>
      </div>
```
→
```tsx
      <PageHeader title="Categories" count={categories?.length} hint="The order here is the order of the counter and the QR menu." />
```

`GroupListPage.tsx` — import:
`import { OutcomeLine, btnCls, errorText } from './editorUi'` →
`import { OutcomeLine, PageHeader, btnCls, errorText, numCls, rowCls, tableBoxCls, tableCls, tdCls, thCls, theadCls } from './editorUi'`; header:

```tsx
      <MenuTabs />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Add-on groups</h1>
          <p className="text-sm text-brown-muted">Choices offered with a product (milk, sugar level, extra shot…), with a price per catalog.</p>
        </div>
        <Link to="/menu/groups/new" className={btnCls}>New add-on group</Link>
      </div>
```
→
```tsx
      <PageHeader title="Add-on groups" count={groups?.length}
        hint="Choices offered with a product (milk, sugar level, extra shot…), with a price per catalog.">
        <Link to="/menu/groups/new" className={btnCls}>New add-on group</Link>
      </PageHeader>
```
and the table:

```tsx
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
```
→
```tsx
      {sorted.length > 0 && (
        <div className={tableBoxCls}>
          <table className={tableCls}>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Group</th><th className={thCls}>Choose</th>
                <th className={`${thCls} ${numCls}`}>Options on</th><th className={thCls}>Used by</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((g) => (
                <tr key={g.id} className={`${rowCls} ${g.isActive ? '' : 'text-brown-faint'}`}>
                  <td className={tdCls}><Link to={`/menu/groups/${g.id}`} className="hover:underline">{g.name}</Link>{g.isActive ? '' : ' (off)'}</td>
                  <td className={tdCls}>{g.min}–{g.max}</td>
                  <td className={`${tdCls} ${numCls}`}>{g.optionCount}</td>
                  <td className={tdCls}>{g.productCount} product{g.productCount === 1 ? '' : 's'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
```

`SchedulesPage.tsx` — import:
`import { OutcomeLine, btnCls, errorText, linkBtnCls, type Outcome } from './editorUi'` →
`import { OutcomeLine, PageHeader, btnCls, errorText, linkBtnCls, type Outcome } from './editorUi'`; header:

```tsx
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Schedules</h1>
          <p className="text-sm text-brown-muted">
            A product that follows a schedule sells only inside its time windows: hidden on QR and greyed out at the counter
            outside them. A product that follows none sells at any time.
          </p>
        </div>
        <Link to="/menu/schedules/new" className={btnCls}>New schedule</Link>
      </div>
```
→
```tsx
      <PageHeader title="Schedules" count={schedules?.length}
        hint="A product that follows a schedule sells only inside its time windows: hidden on QR and greyed out at the counter outside them. A product that follows none sells at any time.">
        <Link to="/menu/schedules/new" className={btnCls}>New schedule</Link>
      </PageHeader>
```

`CatalogsPage.tsx` — import:
`import { OutcomeLine, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'` →
`import { OutcomeLine, PageHeader, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'`; header:

```tsx
      <MenuTabs />
      <div>
        <h1 className="text-2xl font-semibold">Catalogs</h1>
        <p className="text-sm text-brown-muted">
          A catalog picks products from the menu and sells them at its own prices. Which catalog a branch uses for each
          kind of order is set in POS settings.
        </p>
      </div>
```
→
```tsx
      <PageHeader title="Catalogs" count={catalogs?.length}
        hint="A catalog picks products from the menu and sells them at its own prices. Which catalog a branch uses for each kind of order is set in POS settings." />
```

`MenuImportPage.tsx` — replace the line `import MenuTabs from './MenuTabs'` with `import { PageHeader } from './editorUi'`; then

```tsx
      <MenuTabs />
      <h1 className="text-2xl font-semibold">Import menu from Feedme</h1>
```
→
```tsx
      <PageHeader title="Import menu from Feedme" />
```

`ProductEditorPage.tsx` — import:
`import { OutcomeLine, btnCls, errorText, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'` →
`import { OutcomeLine, PageHeader, btnCls, errorText, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'`; header:

```tsx
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{productId ? form?.name || 'Product' : 'New product'}</h1>
        <Link to="/menu" className="text-sm underline">Back to products</Link>
      </div>
```
→
```tsx
      <PageHeader title={productId ? form?.name || 'Product' : 'New product'}>
        <Link to="/menu" className="text-sm underline">Back to products</Link>
      </PageHeader>
```

`GroupEditorPage.tsx` — import:
`import { OutcomeLine, Section, btnCls, errorText, inputCls, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'` →
`import { OutcomeLine, PageHeader, Section, btnCls, errorText, inputCls, useSavedNotice, useUnsavedWarning, type Outcome } from './editorUi'`; header:

```tsx
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{groupId ? form?.name || 'Add-on group' : 'New add-on group'}</h1>
        <Link to="/menu/groups" className="text-sm underline">Back to add-on groups</Link>
      </div>
```
→
```tsx
      <PageHeader title={groupId ? form?.name || 'Add-on group' : 'New add-on group'}>
        <Link to="/menu/groups" className="text-sm underline">Back to add-on groups</Link>
      </PageHeader>
```

`ScheduleEditorPage.tsx` — the same import change as `GroupEditorPage.tsx` (its editorUi import line is identical); header:

```tsx
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{scheduleId ? form?.name || 'Schedule' : 'New schedule'}</h1>
        <Link to="/menu/schedules" className="text-sm underline">Back to schedules</Link>
      </div>
```
→
```tsx
      <PageHeader title={scheduleId ? form?.name || 'Schedule' : 'New schedule'}>
        <Link to="/menu/schedules" className="text-sm underline">Back to schedules</Link>
      </PageHeader>
```

`CatalogGridPage.tsx` — import:
`import { OutcomeLine, errorText, inputCls } from './editorUi'` → `import { OutcomeLine, PageHeader, errorText, inputCls } from './editorUi'`; header:

```tsx
      <MenuTabs />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{grid?.catalog.name ?? 'Catalog'}{grid && !grid.catalog.isActive ? ' (off)' : ''}</h1>
          {grid && <p className="text-sm text-brown-muted">Sells {sold} of {grid.products.length} products. Grey prices are the default prices.</p>}
        </div>
        <Link to="/menu/catalogs" className="text-sm underline">Back to catalogs</Link>
      </div>
```
→
```tsx
      <PageHeader title={`${grid?.catalog.name ?? 'Catalog'}${grid && !grid.catalog.isActive ? ' (off)' : ''}`}
        hint={grid ? `Sells ${sold} of ${grid.products.length} products. Grey prices are the default prices.` : undefined}>
        <Link to="/menu/catalogs" className="text-sm underline">Back to catalogs</Link>
      </PageHeader>
```

`ProductListPage.tsx` (interim; Task 5 rewrites it) — delete the import line, then replace
`<div className="mx-auto max-w-6xl space-y-4 p-6"><MenuTabs /><p className="text-sm">Loading menu…</p></div>` with
`<div className="mx-auto max-w-6xl space-y-4 p-6"><p className="text-sm">Loading menu…</p></div>`, then delete the remaining line `      <MenuTabs />`.

- [ ] **Step 9: Gates and commit**

Run: `grep -rn "MenuTabs" src` → no output.
Run: `npx tsc -b` → no output. Run: `npx vitest run` → `Test Files  106 passed (106)`, `Tests  927 passed (927)`.

```bash
git add -A src/features/pos/menu
git commit -m "feat(menu): left sub-menu in Feedme's order and one page header on every /menu page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Products page — flat table with photos and the bulk bar

**Model tier:** cheap.

**Files:**
- Create: `src/features/pos/menu/useMenuData.ts`, `src/features/pos/menu/ProductTable.tsx`, `src/features/pos/menu/BulkBar.tsx`
- Rewrite: `src/features/pos/menu/ProductListPage.tsx`

**Interfaces:**
- Consumes: `MenuProductRow`, `ProductPatch`, `updateProducts` (Task 1 / `menuApi.ts`); `NO_FILTER`, `tableRows`, `tableReducer`, `headerState`, `routeChoices`, `defaultPrice`, `variantCountText`, `soldInText`, `sstText`, `feeText`, `routeText`, `ringgit` (Task 2); `productThumbUrl` (Task 2); `PageHeader`, table classes (Task 4); `uploadProductPhoto` (`photoUpload.ts`); `fetchProductExtras` (`slotsApi.ts`, returns `{ imagePath, imageUpdatedAt, scheduleIds }`); `fetchLookups` (`menuEditorApi.ts`); `soldIn`, `SST_CHOICES`, `UNCATEGORISED` (`menuView.ts`); `inputToSen` (`menuForms.ts`).
- Produces:
  ```ts
  // useMenuData.ts — Task 6 uses it too
  export function useMenuData(): {
    rows: MenuProductRow[] | null
    setRows: Dispatch<SetStateAction<MenuProductRow[] | null>>
    lookups: MenuLookups | null
    loadError: string | null
    load: () => Promise<void>            // never rejects: a failure lands in loadError
  }
  ```

- [ ] **Step 1: The shared load** — create `src/features/pos/menu/useMenuData.ts`:

```ts
// src/features/pos/menu/useMenuData.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchMenu, type MenuProductRow } from './menuApi'
import { fetchLookups, type MenuLookups } from './menuEditorApi'
import { errorText } from './editorUi'

/** Every product and the lookups, loaded together (Products, Takeaway fees, Print routes). `load`
 *  never rejects — a failure lands in `loadError` — and an older reply never lands last. */
export function useMenuData() {
  const [rows, setRows] = useState<MenuProductRow[] | null>(null)
  const [lookups, setLookups] = useState<MenuLookups | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadSeq = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current
    try {
      const [r, l] = await Promise.all([fetchMenu(), fetchLookups()])
      if (seq !== loadSeq.current) return
      setRows(r)
      setLookups(l)
      setLoadError(null)
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(errorText(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])
  return { rows, setRows, lookups, loadError, load }
}
```

- [ ] **Step 2: The table** — create `src/features/pos/menu/ProductTable.tsx`:

```tsx
// src/features/pos/menu/ProductTable.tsx
import type { MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import type { MenuProductRow } from './menuApi'
import type { LookupCatalog } from './menuEditorApi'
import { soldIn } from './menuView'
import { defaultPrice, feeText, headerState, routeText, soldInText, sstText, variantCountText } from './productTable'
import { productThumbUrl } from './photoUpload'
import { numCls, rowCls, tableBoxCls, tableCls, tdCls, thCls, theadCls } from './editorUi'

const stop = (e: MouseEvent) => e.stopPropagation()

/** The Products page's one flat table (Feedme's layout). A click on a row opens the product editor;
 *  the tick box and the photo do their own thing instead. */
export default function ProductTable({ rows, catalogs, selected, locked, uploadingId, onToggle, onToggleAll, onOpen, onPhoto }: {
  rows: MenuProductRow[]
  catalogs: LookupCatalog[]
  selected: ReadonlySet<string>
  locked: boolean
  /** the product whose new photo is uploading */
  uploadingId: string | null
  onToggle: (id: string) => void
  onToggleAll: () => void
  onOpen: (id: string) => void
  /** opens the photo picker for this product */
  onPhoto: (id: string) => void
}) {
  const head = headerState(selected, rows.map((r) => r.id))
  return (
    <div className={tableBoxCls}>
      <table className={tableCls}>
        <thead className={theadCls}>
          <tr>
            <th className={`${thCls} w-10`}>
              <input type="checkbox" aria-label="Select every product shown" disabled={locked || rows.length === 0}
                checked={head === 'all'} ref={(el) => { if (el) el.indeterminate = head === 'some' }} onChange={onToggleAll} />
            </th>
            <th className={`${thCls} w-16`}>Photo</th>
            <th className={thCls}>Product</th>
            <th className={`${thCls} ${numCls}`}>Price</th>
            <th className={thCls}>SST</th>
            <th className={thCls}>Category</th>
            <th className={thCls}>Sold in</th>
            <th className={thCls}>Print route</th>
            <th className={`${thCls} ${numCls}`}>Takeaway fee</th>
            <th className={thCls}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const names = soldIn(p.catalog_ids, catalogs)
            const variants = variantCountText(p.menu_variants)
            return (
              <tr key={p.id} className={`${rowCls} cursor-pointer ${p.is_active ? '' : 'text-brown-faint'}`} onClick={() => onOpen(p.id)}>
                <td className={tdCls} onClick={stop}>
                  <input type="checkbox" aria-label={`Select ${p.name}`} disabled={locked}
                    checked={selected.has(p.id)} onChange={() => onToggle(p.id)} />
                </td>
                <td className={tdCls} onClick={stop}>
                  <button type="button" disabled={locked} onClick={() => onPhoto(p.id)}
                    aria-label={p.image_path ? `Change the photo of ${p.name}` : `Add a photo of ${p.name}`}
                    className="block h-12 w-12 overflow-hidden rounded border border-border bg-border hover:opacity-80 disabled:cursor-wait">
                    {uploadingId === p.id
                      ? <span className="flex h-full items-center justify-center text-[10px] text-brown-muted">Uploading…</span>
                      : p.image_path && (
                        <img src={productThumbUrl(p.image_path, p.image_updated_at)} alt="" loading="lazy" className="h-full w-full object-cover" />
                      )}
                  </button>
                </td>
                <td className={tdCls}>
                  <Link to={`/menu/products/${p.id}`} onClick={stop} className="font-medium underline-offset-2 hover:underline">{p.name}</Link>
                  {p.is_addon && <span className="ml-2 text-xs text-brown-muted">add-on item</span>}
                  {variants && <span className="block text-xs text-brown-muted">{variants}</span>}
                </td>
                <td className={`${tdCls} ${numCls} whitespace-nowrap`}>{defaultPrice(p.menu_variants)}</td>
                <td className={tdCls}>{sstText(p.sst_rate_bp)}</td>
                <td className={tdCls}>{p.category?.name ?? 'Uncategorised'}</td>
                <td className={`${tdCls} ${names.length === 0 ? 'text-brown-faint' : ''}`} title={names.join(', ')}>{soldInText(names)}</td>
                <td className={tdCls}>{routeText(p.print_route)}</td>
                <td className={`${tdCls} ${numCls} whitespace-nowrap`}>{feeText(p.takeaway_fee_sen)}</td>
                <td className={tdCls}>{p.is_active ? 'On' : 'Off'}</td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr><td colSpan={10} className={`${tdCls} text-brown-muted`}>No products match.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 3: The bulk bar** — create `src/features/pos/menu/BulkBar.tsx`:

```tsx
// src/features/pos/menu/BulkBar.tsx
import { useState } from 'react'
import type { ProductPatch } from './menuApi'
import { SST_CHOICES } from './menuView'
import { inputToSen } from './menuForms'
import { ringgit } from './productTable'
import { btnCls, inputCls, linkBtnCls } from './editorUi'

type Asking = 'route' | 'sst' | 'fee' | null

/** Shown while rows are ticked: one change for every ticked product. Set print route, Set SST and
 *  Set takeaway fee ask for the value first; Switch on applies at once, Switch off asks to confirm. */
export default function BulkBar({ count, routes, busy, onApply, onClear }: {
  count: number
  /** the print routes to offer (routeChoices) */
  routes: string[]
  busy: boolean
  /** `what` is the outcome's wording, e.g. "Print route set to Bar" */
  onApply: (patch: ProductPatch, what: string) => void
  onClear: () => void
}) {
  const [asking, setAsking] = useState<Asking>(null)
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const ask = (a: Asking, initial: string) => { setAsking(a); setValue(initial); setProblem(null) }

  const apply = () => {
    if (asking === 'route') onApply({ print_route: value || null }, `Print route set to ${value || 'No ticket'}`)
    else if (asking === 'sst') onApply({ sst_rate_bp: Number(value) }, `SST set to ${Number(value) / 100}%`)
    else if (asking === 'fee') {
      const sen = inputToSen(value)
      if (sen === null) { setProblem('Enter the fee in RM, e.g. 1.00 (0 for no fee)'); return }
      onApply({ takeaway_fee_sen: sen }, `Takeaway fee set to ${ringgit(sen)}`)
    }
    setAsking(null)
  }
  const switchOff = () => {
    const what = `${count} product${count === 1 ? '' : 's'}`
    if (window.confirm(`Switch off ${what}? They leave the counter and the QR menu until you switch them back on.`)) {
      onApply({ is_active: false }, 'Switched off')
    }
  }

  return (
    <div role="region" aria-label="Bulk edit" className="space-y-2 rounded-xl border border-border bg-card p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{count} selected</span>
        <button className={linkBtnCls} disabled={busy} onClick={() => ask('route', routes[0] ?? '')}>Set print route</button>
        <button className={linkBtnCls} disabled={busy} onClick={() => ask('sst', String(SST_CHOICES[0].bp))}>Set SST</button>
        <button className={linkBtnCls} disabled={busy} onClick={() => ask('fee', '1.00')}>Set takeaway fee</button>
        <button className={linkBtnCls} disabled={busy} onClick={() => onApply({ is_active: true }, 'Switched on')}>Switch on</button>
        <button className={linkBtnCls} disabled={busy} onClick={switchOff}>Switch off</button>
        <button className="text-sm underline" disabled={busy} onClick={() => { setAsking(null); onClear() }}>Clear</button>
      </div>
      {asking && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {asking === 'route' && (
            <select className={inputCls} aria-label="Print route" value={value} onChange={(e) => setValue(e.target.value)}>
              {routes.map((r) => <option key={r} value={r}>{r}</option>)}
              <option value="">No ticket</option>
            </select>
          )}
          {asking === 'sst' && (
            <select className={inputCls} aria-label="SST" value={value} onChange={(e) => setValue(e.target.value)}>
              {SST_CHOICES.map((c) => <option key={c.bp} value={c.bp}>{c.label}</option>)}
            </select>
          )}
          {asking === 'fee' && (
            <label className="flex items-center gap-2">RM
              <input className={`${inputCls} w-24`} inputMode="decimal" aria-label="Takeaway fee in RM" value={value} autoFocus
                onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
            </label>
          )}
          <button className={btnCls} disabled={busy} onClick={apply}>Apply to {count}</button>
          <button className="text-sm underline" onClick={() => setAsking(null)}>Cancel</button>
          {problem && <span role="alert" className="text-red-700">{problem}</span>}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: The page** — replace the whole of `src/features/pos/menu/ProductListPage.tsx` with:

```tsx
// src/features/pos/menu/ProductListPage.tsx
import { useMemo, useReducer, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { updateProducts, type ProductPatch } from './menuApi'
import { fetchProductExtras } from './slotsApi'
import { uploadProductPhoto } from './photoUpload'
import { UNCATEGORISED, type MenuFilter } from './menuView'
import { NO_FILTER, routeChoices, tableReducer, tableRows } from './productTable'
import { useMenuData } from './useMenuData'
import ProductTable from './ProductTable'
import BulkBar from './BulkBar'
import { OutcomeLine, PageHeader, btnCls, errorText, inputCls, linkBtnCls, type Outcome } from './editorUi'

/** /menu — every product in one flat table (Feedme's layout): filters and a search, a photo per row
 *  (a click changes it), and a bulk bar for print route, SST, takeaway fee and on/off on the ticked
 *  rows. A row opens the product editor, where variants, add-on groups and catalog prices are edited. */
export default function ProductListPage() {
  const navigate = useNavigate()
  const { rows, setRows, lookups, loadError, load } = useMenuData()
  const [state, dispatch] = useReducer(tableReducer, { filter: NO_FILTER, selected: new Set<string>() })
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                                           // a second click in the same render is refused too
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const photoInput = useRef<HTMLInputElement>(null)
  const photoFor = useRef<string | null>(null)                           // the product the picker was opened for

  const visible = useMemo(() => tableRows(rows ?? [], state.filter), [rows, state.filter])
  const routes = useMemo(() => routeChoices(rows ?? []), [rows])
  const set = (patch: Partial<MenuFilter>) => dispatch({ type: 'filter', patch })
  const locked = busy || uploadingId !== null || rows === null

  /** One patch for every ticked product (updateProducts writes 100 at a time), then the list is read
   *  again — after a failure too, since earlier chunks may already be written. */
  const apply = async (patch: ProductPatch, what: string) => {
    const ids = [...state.selected]
    if (ids.length === 0 || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setOutcome(null)
    try {
      await updateProducts(ids, patch)
      dispatch({ type: 'clear' })
      setOutcome({ kind: 'ok', text: `${what} for ${ids.length} product${ids.length === 1 ? '' : 's'}` })
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      await load()
      busyRef.current = false
      setBusy(false)
    }
  }

  const pickPhoto = (id: string) => {
    if (busyRef.current) return
    photoFor.current = id
    photoInput.current?.click()
  }
  /** The editor's upload (resized to 800 px WebP); the new photo then shows in its row at once. */
  const uploadPhoto = async (file: File | undefined) => {
    const id = photoFor.current
    if (!file || !id || busyRef.current) return
    busyRef.current = true
    setUploadingId(id)
    setOutcome(null)
    const name = rows?.find((r) => r.id === id)?.name ?? 'the product'
    try {
      const { warning } = await uploadProductPhoto(id, file)
      setOutcome(warning ? { kind: 'error', text: warning } : { kind: 'ok', text: `Photo of ${name} saved` })
      try {
        const x = await fetchProductExtras(id)
        setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, image_path: x.imagePath, image_updated_at: x.imageUpdatedAt } : r)) ?? rs)
      } catch {
        await load()                                                      // the photo is saved: show it from a full reload
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
      await load()                                                        // the product may point at the new file after all
    } finally {
      busyRef.current = false
      setUploadingId(null)
    }
  }

  const f = state.filter
  return (
    <div className="space-y-4 p-6">
      <PageHeader title="Products" count={rows?.length}
        hint="SST, print route and takeaway fee apply in every catalog. Open a product to edit its variants, add-on groups and catalog prices.">
        <Link to="/menu/import" className={linkBtnCls}>Import</Link>
        <Link to="/menu/products/new" className={btnCls}>+ Add product</Link>
      </PageHeader>

      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={() => void load()}>Try again</button>
        </div>
      )}
      <OutcomeLine outcome={outcome} />

      <div className="flex flex-wrap items-center gap-3">
        <select className={inputCls} aria-label="Category" value={f.categoryId ?? ''} onChange={(e) => set({ categoryId: e.target.value || null })}>
          <option value="">All categories</option>
          <option value={UNCATEGORISED}>Uncategorised</option>
          {lookups?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
        <select className={inputCls} aria-label="Catalog" value={f.catalogId ?? ''} onChange={(e) => set({ catalogId: e.target.value || null })}>
          <option value="">All catalogs</option>
          {lookups?.catalogs.map((c) => <option key={c.id} value={c.id}>Sold in {c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.showAddons} onChange={(e) => set({ showAddons: e.target.checked })} /> Show add-ons
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.showInactive} onChange={(e) => set({ showInactive: e.target.checked })} /> Show switched-off
        </label>
        <input className={`${inputCls} w-64 min-[900px]:ml-auto`} type="search" placeholder="Search products" aria-label="Search products"
          value={f.search} onChange={(e) => set({ search: e.target.value })} />
      </div>

      {state.selected.size > 0 && (
        <BulkBar count={state.selected.size} routes={routes} busy={busy}
          onApply={(patch, what) => void apply(patch, what)} onClear={() => dispatch({ type: 'clear' })} />
      )}

      {rows === null && !loadError && <p className="text-sm">Loading menu…</p>}
      {rows?.length === 0 && (
        <p className="rounded border border-border bg-card p-6 text-sm">No menu yet — use “Import” or “+ Add product”.</p>
      )}
      {rows !== null && rows.length > 0 && (
        <ProductTable rows={visible} catalogs={lookups?.catalogs ?? []} selected={state.selected} locked={locked}
          uploadingId={uploadingId}
          onToggle={(id) => dispatch({ type: 'toggle', id })}
          onToggleAll={() => dispatch({ type: 'toggleAll', visibleIds: visible.map((r) => r.id) })}
          onOpen={(id) => navigate(`/menu/products/${id}`)}
          onPhoto={pickPhoto} />
      )}
      <input ref={photoInput} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-label="Product photo"
        onChange={(e) => { void uploadPhoto(e.target.files?.[0]); e.target.value = '' }} />
    </div>
  )
}
```

- [ ] **Step 5: Gates and commit**

Run: `wc -l src/features/pos/menu/ProductListPage.tsx src/features/pos/menu/ProductTable.tsx src/features/pos/menu/BulkBar.tsx` → each under 250.
Run: `npx tsc -b` → no output. Run: `npx vitest run` → `Test Files  106 passed (106)`, `Tests  927 passed (927)`.

```bash
git add src/features/pos/menu/useMenuData.ts src/features/pos/menu/ProductTable.tsx src/features/pos/menu/BulkBar.tsx \
  src/features/pos/menu/ProductListPage.tsx
git commit -m "feat(menu): Products as one flat table with photos and a bulk bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Takeaway fees and Print routes pages

**Model tier:** cheap.

**Files:**
- Create: `src/features/pos/menu/ProductPicker.tsx`, `src/features/pos/menu/ProductGroupsView.tsx`, `src/features/pos/menu/TakeawayFeesPage.tsx`, `src/features/pos/menu/PrintRoutesPage.tsx`
- Modify: `src/features/pos/menu/MenuRoutes.tsx`

**Interfaces:**
- Consumes: `useMenuData` (Task 5); `ProductGroup`, `NewValue`, `groupByFee`, `groupByRoute`, `feeLabel`, `parseNewFee`, `parseNewRoute` (Task 3); `NO_FILTER`, `tableRows`, `routeChoices`, `routeText` (Task 2); `productThumbUrl` (Task 2); `updateProducts`, `ProductPatch` (Task 1); `PageHeader`, table classes (Task 4); `LookupCategory` (`menuEditorApi.ts`).
- Produces:
  ```ts
  // ProductGroupsView.tsx
  export interface GroupedValue<V> {
    title: string; hint: ReactNode
    group: (rows: MenuProductRow[]) => ProductGroup<V>[]
    none: V; valueOf: (p: MenuProductRow) => V; patch: (v: V) => ProductPatch; label: (v: V) => string
    allLabel: string; newButton: string; newPrompt: string
    parseNew: (text: string, rows: MenuProductRow[]) => NewValue<V>
    emptyText: string; noneNote: string
  }
  export default function ProductGroupsView<V extends number | string | null>({ cfg }: { cfg: GroupedValue<V> }): JSX.Element
  ```
  Routes `/menu/takeaway-fees` and `/menu/print-routes`.

- [ ] **Step 1: The picker** — create `src/features/pos/menu/ProductPicker.tsx`:

```tsx
// src/features/pos/menu/ProductPicker.tsx
import { useState } from 'react'
import type { MenuProductRow } from './menuApi'
import type { LookupCategory } from './menuEditorApi'
import { NO_FILTER, tableRows } from './productTable'
import { btnCls, inputCls } from './editorUi'

/** "Add products": a search and a category filter, tick several, add them all at once. Add-on items
 *  and the products already in the group are not offered; `current` says where each one is now. */
export default function ProductPicker({ rows, categories, exclude, current, busy, onAdd, onClose }: {
  rows: MenuProductRow[]
  categories: LookupCategory[]
  exclude: (p: MenuProductRow) => boolean
  current: (p: MenuProductRow) => string
  busy: boolean
  onAdd: (ids: string[]) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const shown = tableRows(rows, { ...NO_FILTER, showInactive: true, search, categoryId }).filter((p) => !exclude(p))
  const toggle = (id: string) => setTicked((t) => {
    const next = new Set(t)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">Add products</h3>
        <input className={`${inputCls} w-56`} type="search" placeholder="Search products" aria-label="Search products to add"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={inputCls} aria-label="Category" value={categoryId ?? ''} onChange={(e) => setCategoryId(e.target.value || null)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (off)'}</option>)}
        </select>
      </div>
      <ul className="max-h-80 space-y-1 overflow-y-auto text-sm">
        {shown.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-cream">
              <input type="checkbox" checked={ticked.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="flex-1">{p.name}{p.is_active ? '' : ' (off)'}</span>
              <span className="text-xs text-brown-muted">{p.category?.name ?? 'Uncategorised'} · now {current(p)}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 && <li className="text-brown-muted">No products match.</li>}
      </ul>
      <div className="flex items-center gap-2">
        <button className={btnCls} disabled={busy || ticked.size === 0} onClick={() => onAdd([...ticked])}>
          Add {ticked.size} product{ticked.size === 1 ? '' : 's'}
        </button>
        <button className="text-sm underline" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: The grouped page** — create `src/features/pos/menu/ProductGroupsView.tsx`:

```tsx
// src/features/pos/menu/ProductGroupsView.tsx
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { updateProducts, type MenuProductRow, type ProductPatch } from './menuApi'
import type { NewValue, ProductGroup } from './productGroups'
import { productThumbUrl } from './photoUpload'
import { useMenuData } from './useMenuData'
import ProductPicker from './ProductPicker'
import {
  OutcomeLine, PageHeader, btnCls, errorText, inputCls, linkBtnCls, rowCls, tableBoxCls, tableCls, tdCls, thCls, theadCls, type Outcome,
} from './editorUi'

/** One value that lives on each product (the takeaway fee, the print route), shown as a grouped page. */
export interface GroupedValue<V> {
  title: string
  hint: ReactNode
  /** the products by value, the "none" group last (groupByFee / groupByRoute) */
  group: (rows: MenuProductRow[]) => ProductGroup<V>[]
  /** the value that means none (no fee, no ticket): Remove sets it; its group is listed, not edited */
  none: V
  valueOf: (p: MenuProductRow) => V
  patch: (v: V) => ProductPatch
  label: (v: V) => string
  /** the way back from an open group, e.g. "All fees" */
  allLabel: string
  newButton: string
  newPrompt: string
  parseNew: (text: string, rows: MenuProductRow[]) => NewValue<V>
  emptyText: string
  noneNote: string
}

const plural = (n: number) => `${n} product${n === 1 ? '' : 's'}`

/** The Takeaway fees and Print routes pages: one row per value ("RM 1.00 · 97 products"). Open a value
 *  to see its products, Remove one (back to none) or Add products from a picker; "+ New" asks a value
 *  and opens the picker. Every change is one updateProducts call, then the list is read again. */
export default function ProductGroupsView<V extends number | string | null>({ cfg }: { cfg: GroupedValue<V> }) {
  const { rows, lookups, loadError, load } = useMenuData()
  const [open, setOpen] = useState<{ value: V } | null>(null)        // wrapped: null is a value (no ticket)
  const [picking, setPicking] = useState(false)
  const [newText, setNewText] = useState<string | null>(null)        // null = the "+ New" box is closed
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)                                       // a second click in the same render is refused too
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const groups = useMemo(() => cfg.group(rows ?? []), [cfg, rows])
  const locked = busy || rows === null
  // an open value with no products (a new one, or its last one removed) still shows, empty
  const openGroup: ProductGroup<V> | null = open
    ? groups.find((g) => g.value === open.value) ?? { value: open.value, label: cfg.label(open.value), products: [] }
    : null
  const isNone = openGroup !== null && openGroup.value === cfg.none

  const show = (value: V) => { setOpen({ value }); setPicking(false); setOutcome(null) }
  const back = () => { setOpen(null); setPicking(false); setOutcome(null) }

  const write = async (ids: string[], value: V, ok: string) => {
    if (busyRef.current || ids.length === 0) return
    busyRef.current = true
    setBusy(true)
    setOutcome(null)
    try {
      await updateProducts(ids, cfg.patch(value))
      setPicking(false)
      setOutcome({ kind: 'ok', text: ok })
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      await load()                                                    // after a failure too: earlier chunks may be written
      busyRef.current = false
      setBusy(false)
    }
  }

  const startNew = () => {
    const r = cfg.parseNew(newText ?? '', rows ?? [])
    if ('problem' in r) { setOutcome({ kind: 'error', text: r.problem }); return }
    setNewText(null)
    setOpen({ value: r.value })
    setPicking(true)
    setOutcome(null)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <PageHeader title={cfg.title} count={rows ? groups.filter((g) => g.value !== cfg.none).length : null} hint={cfg.hint}>
        {!openGroup && newText === null && (
          <button className={btnCls} disabled={locked} onClick={() => { setNewText(''); setOutcome(null) }}>{cfg.newButton}</button>
        )}
      </PageHeader>
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={busy} onClick={() => void load()}>Try again</button>
        </div>
      )}
      <OutcomeLine outcome={outcome} />
      {newText !== null && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm">
          <label className="flex items-center gap-2">{cfg.newPrompt}
            <input className={`${inputCls} w-40`} value={newText} autoFocus
              onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && startNew()} />
          </label>
          <button className={btnCls} disabled={locked} onClick={startNew}>Choose products</button>
          <button className="text-sm underline" onClick={() => setNewText(null)}>Cancel</button>
        </div>
      )}
      {rows === null && !loadError && <p className="text-sm">Loading…</p>}

      {rows && !openGroup && (
        <div className={tableBoxCls}>
          <table className={tableCls}>
            <tbody>
              {groups.map((g) => (
                <tr key={String(g.value)} className={`${rowCls} cursor-pointer first:border-t-0`} onClick={() => show(g.value)}>
                  <td className={tdCls}>
                    <span className="font-medium">{g.label}</span>
                    <span className="text-brown-muted"> · {plural(g.products.length)}</span>
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <button className={linkBtnCls} onClick={(e) => { e.stopPropagation(); show(g.value) }}>Open</button>
                  </td>
                </tr>
              ))}
              {groups.length === 0 && <tr><td className={`${tdCls} text-brown-muted`}>No products yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {rows && openGroup && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button className="text-sm underline" disabled={busy} onClick={back}>← {cfg.allLabel}</button>
            <h2 className="text-lg font-semibold">{openGroup.label} · {plural(openGroup.products.length)}</h2>
            {!isNone && !picking && (
              <button className={`${btnCls} ml-auto`} disabled={locked} onClick={() => setPicking(true)}>Add products</button>
            )}
          </div>
          {isNone && <p className="text-sm text-brown-muted">{cfg.noneNote}</p>}
          {picking && !isNone && (
            <ProductPicker rows={rows} categories={lookups?.categories ?? []} busy={busy}
              exclude={(p) => cfg.valueOf(p) === openGroup.value} current={(p) => cfg.label(cfg.valueOf(p))}
              onAdd={(ids) => void write(ids, openGroup.value, `Added ${plural(ids.length)} to ${openGroup.label}`)}
              onClose={() => setPicking(false)} />
          )}
          <div className={tableBoxCls}>
            <table className={tableCls}>
              <thead className={theadCls}>
                <tr><th className={`${thCls} w-14`}>Photo</th><th className={thCls}>Product</th><th className={thCls}>Category</th><th className={thCls} /></tr>
              </thead>
              <tbody>
                {openGroup.products.map((p) => (
                  <tr key={p.id} className={`${rowCls} ${p.is_active ? '' : 'text-brown-faint'}`}>
                    <td className={tdCls}>
                      <div className="h-10 w-10 overflow-hidden rounded border border-border bg-border">
                        {p.image_path && (
                          <img src={productThumbUrl(p.image_path, p.image_updated_at)} alt="" loading="lazy" className="h-full w-full object-cover" />
                        )}
                      </div>
                    </td>
                    <td className={tdCls}>
                      <Link to={`/menu/products/${p.id}`} className="hover:underline">{p.name}</Link>{p.is_active ? '' : ' (off)'}
                    </td>
                    <td className={tdCls}>{p.category?.name ?? 'Uncategorised'}</td>
                    <td className={`${tdCls} text-right`}>
                      {!isNone && (
                        <button className={linkBtnCls} disabled={locked} aria-label={`Remove ${p.name}`}
                          onClick={() => void write([p.id], cfg.none, `${p.name} removed from ${openGroup.label}`)}>Remove</button>
                      )}
                    </td>
                  </tr>
                ))}
                {openGroup.products.length === 0 && (
                  <tr><td colSpan={4} className={`${tdCls} text-brown-muted`}>{cfg.emptyText}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
```

- [ ] **Step 3: The two pages** — create `src/features/pos/menu/TakeawayFeesPage.tsx`:

```tsx
// src/features/pos/menu/TakeawayFeesPage.tsx
import { feeLabel, groupByFee, parseNewFee } from './productGroups'
import ProductGroupsView, { type GroupedValue } from './ProductGroupsView'

/** /menu/takeaway-fees (Feedme's Takeaway page): the packaging fee a takeaway order adds per item,
 *  grouped by amount. No table of its own — each product keeps its own amount. */
const FEES: GroupedValue<number> = {
  title: 'Takeaway fees',
  hint: 'Added per item to takeaway orders. Products are grouped by their fee; add-on items are left out.',
  group: groupByFee,
  none: 0,
  valueOf: (p) => p.takeaway_fee_sen,
  patch: (sen) => ({ takeaway_fee_sen: sen }),
  label: feeLabel,
  allLabel: 'All fees',
  newButton: '+ New fee',
  newPrompt: 'Fee in RM',
  parseNew: (text) => parseNewFee(text),
  emptyText: 'No products with this fee yet.',
  noneNote: 'These products add no fee to a takeaway order. To give them one, open a fee and use Add products.',
}

export default function TakeawayFeesPage() {
  return <ProductGroupsView cfg={FEES} />
}
```

Create `src/features/pos/menu/PrintRoutesPage.tsx`:

```tsx
// src/features/pos/menu/PrintRoutesPage.tsx
import { groupByRoute, parseNewRoute } from './productGroups'
import { routeChoices, routeText } from './productTable'
import ProductGroupsView, { type GroupedValue } from './ProductGroupsView'

/** /menu/print-routes: which kitchen ticket each product prints on, grouped by route name. No table
 *  of its own — each product keeps its route name, and each branch maps the name to a printer. */
const ROUTES: GroupedValue<string | null> = {
  title: 'Print routes',
  hint: 'Each branch maps a route name to a printer in POS settings. Products with no route print no kitchen ticket; add-on items are left out.',
  group: groupByRoute,
  none: null,
  valueOf: (p) => p.print_route,
  patch: (route) => ({ print_route: route }),
  label: routeText,
  allLabel: 'All routes',
  newButton: '+ New route',
  newPrompt: 'Route name',
  parseNew: (text, rows) => parseNewRoute(text, routeChoices(rows)),
  emptyText: 'No products on this route yet.',
  noneNote: 'These products print no kitchen ticket. To print them, open a route and use Add products.',
}

export default function PrintRoutesPage() {
  return <ProductGroupsView cfg={ROUTES} />
}
```

- [ ] **Step 4: The routes** — in `src/features/pos/menu/MenuRoutes.tsx` replace

```tsx
import MenuImportPage from './MenuImportPage'
```

with

```tsx
import MenuImportPage from './MenuImportPage'
import TakeawayFeesPage from './TakeawayFeesPage'
import PrintRoutesPage from './PrintRoutesPage'
```

and replace

```tsx
        <Route path="categories" element={<CategoriesPage />} />
```

with

```tsx
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="takeaway-fees" element={<TakeawayFeesPage />} />
        <Route path="print-routes" element={<PrintRoutesPage />} />
```

- [ ] **Step 5: Gates and commit**

Run: `wc -l src/features/pos/menu/ProductGroupsView.tsx src/features/pos/menu/ProductPicker.tsx` → each under 250.
Run: `npx tsc -b` → no output. Run: `npx vitest run` → `Test Files  106 passed (106)`, `Tests  927 passed (927)`.

```bash
git add src/features/pos/menu/ProductPicker.tsx src/features/pos/menu/ProductGroupsView.tsx \
  src/features/pos/menu/TakeawayFeesPage.tsx src/features/pos/menu/PrintRoutesPage.tsx src/features/pos/menu/MenuRoutes.tsx
git commit -m "feat(menu): Takeaway fees and Print routes pages, grouped by value with add and remove

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final verification (controller, craft-os-dev; after Task 6 and after the controller's Section 1 photo import)

- [ ] **Step 1: Gates on the branch head.** `npx tsc -b` → no output; `npx vitest run` → `Test Files  106 passed (106)`, `Tests  927 passed (927)`; `grep -rn "MenuTabs" src` → no output.
- [ ] **Step 2: Start the dev server** with the launch entry `pos-menu-dev` (port 5174) and sign in as the dev owner. Confirm in the network panel that Supabase requests go to `egznnbjmicebbhwasloy.supabase.co` (craft-os-dev), never prod. Run every check below at **desktop 1440 px** and again at **iPad 1180 px** (`resize_window` width 1180, height 820); reset to desktop at the end.
- [ ] **Step 3: Sub-menu on every page.** Visit `/menu`, `/menu/categories`, `/menu/groups`, `/menu/takeaway-fees`, `/menu/schedules`, `/menu/print-routes`, `/menu/catalogs`, `/menu/import`, plus one product editor, one add-on group editor, one schedule editor and one catalog grid: the left sub-menu lists the eight items in that order, the current one is highlighted (brown), the page has the header (title + count chip where it has one). At a width below 900 px (e.g. 800) the sub-menu is a strip above the page that scrolls sideways and the page does not scroll sideways.
- [ ] **Step 4: Products table.** Header "Products 410" with "Import" and "+ Add product"; one flat table sorted by category then product order; photos show for the products that have one (after the Section 1 import), a grey square for the rest; Price is the default variant's price, right-aligned; "Sold in" shows "+N" after two names; Print route shows Bar / Kitchen / No ticket; Takeaway fee RM 1.00 or "—"; Status On/Off. The header row stays put while the table scrolls; rows highlight on hover. At 1180 px the table scrolls sideways inside its box only.
- [ ] **Step 5: Filter + search.** Category = one category, Catalog = Craft Cafe, "Show add-ons" on/off, "Show switched-off" on/off and a search each narrow the table; a search with no match shows "No products match."; ticking a row and then changing any filter clears the ticks (the bulk bar disappears).
- [ ] **Step 6: Bulk print route on 3 products and back.** Note three products' current routes (pick ones on Bar); tick them → "3 selected"; Set print route → Kitchen → Apply to 3 → "Print route set to Kitchen for 3 products" and the three rows show Kitchen; Print routes page shows Bar · 33, Kitchen · 64. Then set them back to Bar the same way → Bar · 36, Kitchen · 61 again. (Set SST, Set takeaway fee, Switch on/off: open each value row and Cancel — no write.)
- [ ] **Step 7: Change one photo from the list.** Click a product's photo → the file picker opens; choose a JPEG → "Uploading…" in that cell, then the new photo shows in the row at once and "Photo of <name> saved"; open that product's editor → the Photo section shows the same picture. (Use a `[TEST]` product or put the original photo back afterwards.)
- [ ] **Step 8: Takeaway fees page.** Rows "RM 1.00 · 97 products" and "No fee · N products" (N = 410 − add-on items − 97); open RM 1.00 → 97 products with photo, name, category and Remove; Remove one → 96; Add products → search it, tick, "Add 1 product" → 97 again. "+ New fee" with "0" shows the error; with "2.50" opens an empty "RM 2.50 · 0 products" ("No products with this fee yet.") with the picker; Cancel and "← All fees" → no RM 2.50 row (nothing was written).
- [ ] **Step 9: Print routes page.** Rows "Bar · 36 products", "Kitchen · 61 products", "No ticket · N products" and the POS-settings hint; open Kitchen, Remove one → 60, add it back → 61; "+ New route" with "bar" opens Bar (stored spelling) with the picker; Cancel.
- [ ] **Step 10: POS pad and QR still show photos.** Open the POS pad (`/pos`) on the demo branch and the QR page for one of its tables: product photos show as before.
- [ ] **Step 11: Console.** No errors in the browser console on any /menu page during Steps 3–9.

---

## Self-review

**Spec coverage**

| Spec | Where |
|---|---|
| §2 left sub-menu, order, highlight, strip below 900 px | Task 4 (`MENU_TABS`, `menuTab`, `MenuShell`); Final Step 3 |
| §2 one page header with count chip and actions | Task 4 (`PageHeader` on every page); Task 5 ("Import", "+ Add product") |
| §2 Products filter row + search | Task 5 Step 4; Task 2 (`tableRows`) |
| §2 flat table, sort, columns (photo 48 px, variant count, default price, SST, category, Sold in "+N", route, fee, status) | Task 2 (cells), Task 5 (`ProductTable`) |
| §2 row opens editor; photo click opens picker, 800 px WebP, shows at once | Task 5 (`onOpen`, `pickPhoto` / `uploadPhoto`) |
| §2 bulk bar: N selected, route, SST, fee, on, off, Clear; asks value; `updateProducts`; refresh | Task 5 (`BulkBar`, `apply`); Task 2 (`tableReducer`) |
| §2 per-row selects and "Print whole category to" removed | Task 5 Step 4 (page rewritten without them) |
| §2 Takeaway fees page (group by `takeaway_fee_sen`, add-ons left out, Remove → 0, Add products picker, + New fee) | Tasks 3, 6 |
| §2 Print routes page (group by `print_route`, Remove → none, + New route, POS-settings hint) | Tasks 3, 6 |
| §2 other pages: same header and table styling, behaviour unchanged | Task 4 Step 8 |
| §3 `menu_product_list` + `image_path`, `image_updated_at`; new idempotent migration; same grants; notify; re-run note | Task 1 |
| Copy and style: English, Craft OS colours, sticky header, row hover, right-aligned money, the two empty states | Global Constraints; Tasks 4–6 |
| Testing — Vitest: filter, search, sort, "+N", default price, group by fee / route, select all visible, clear on filter change, photo URL builder, sub-menu active item | Tasks 2, 3, 4 |
| Testing — SQL twice on dev + both verifies VERIFY OK | Task 1 Step 8 |
| Testing — browser on dev, 1440 px and 1180 px | Final verification Steps 2–11 |
| §1 Photos from Feedme and the Photos count | Not in this plan (controller, no code) |

**Placeholder scan:** no TBD / TODO / "similar to"; every code step has the full code or the exact old → new text.

**Type consistency:** `MenuProductRow.image_path` / `image_updated_at` (T1) are read by `menuRow` (T2), `ProductTable` (T5) and `ProductGroupsView` (T6); `ProductPatch` keys `takeaway_fee_sen` / `is_active` (T1) are written by `BulkBar` (T5) and the page configs (T6); `NO_FILTER`, `tableRows`, `ringgit`, `routeText`, `routeChoices` (T2) match their uses in T3, T5, T6; `ProductGroup<V>` / `NewValue<V>` (T3) match `GroupedValue<V>` (T6); `useMenuData()` returns `{ rows, setRows, lookups, loadError, load }` (T5) as T6 destructures it; `PageHeader` props `title`, `count`, `hint`, `children` (T4) match every call; `MenuTab` ids `fees` / `routes` (T4) match the paths `/menu/takeaway-fees` / `/menu/print-routes` routed in T6.
