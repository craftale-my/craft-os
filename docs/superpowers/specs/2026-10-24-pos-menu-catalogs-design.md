# POS · Menu catalogs, time slots and product photos (design)

Date: 2026-10-24. Builds on the menu (Sub-plan 1), ordering (Sub-plan 2) and checkout (Sub-plan 3) on branch `feature/pos-demo`. Informed by the Feedme back office (`docs/superpowers/research/2026-10-23-feedme-back-office-teardown.md` §1) and its live Publish and Catalog-usage pages, read 2026-10-24.

**Owner decisions (brainstorm 2026-10-24):**
1. Bring over **all 10 Feedme catalogs** (Craft Cafe, Craftale, Craftale Bar, Staff Meal, Dino Meal, Delivery express, Grab Food, Grab Mart, Grab Food Puchong, Grab Mart Puchong).
2. An **additional catalog** is used by switching the whole order to it on the iPad (e.g. Staff Meal for a staff lunch, Grab Food to key a Grab order by hand); prices follow the chosen catalog.
3. **Craft OS becomes the master of the menu.** Feedme is imported once; after that products, prices and catalogs are edited in Craft OS. (Accepted consequence: while Feedme still takes Grab orders and stays as the fallback, its menu drifts unless someone also edits it there.)
4. The first editor is **complete**, modifier groups included.
5. **Time slots are set on products**: days of the week + a time window, several per product. Outside a slot the product is hidden on QR and greyed out on the counter.
6. **Photos are copied once from Feedme**, then uploaded in Craft OS. Photos show on the QR page; the counter keeps text tiles.
7. A new capability **"Edit menu"** (`manage_menu`), default Owner and Admin only, because the menu is company-wide.

## 1. How Feedme does it (what we mirror)

- One **master product list** (409 products).
- **Catalogs** pick a subset of products, each with its own selling price and "Order from" (All / POS only / None). Add-on option prices are also per catalog.
- Each **outlet** uses catalogs by order type. Today all three outlets use *Craft Cafe* for Dine-in, Takeaway and Pickup. Staff Meal, Dino Meal, Grab Food/Mart (Cheras, Puchong) and Delivery express are **Additional** at the outlets. Craftale (48) and Craftale Bar (38) are not assigned to any outlet.
- The export (`books_*.zip`) has one sheet per catalog in `menu_*.xlsx` and `addonGroup_*.xlsx`, plus a `Default Catalog` / `Default AddonGroup` sheet (the master list). It carries **no schedulers and no photos**.

## 2. Data model

Existing tables stay; the master product layer keeps name, description, category, SST, print route, takeaway fee, variants and modifier links for every catalog.

| Table / column | Purpose |
|---|---|
| `menu_catalogs (id, name unique, is_active, sort_order, feedme_catalog_name unique null, created_at)` | A catalog. |
| `catalog_products (catalog_id, product_id, availability in ('all','counter_only','hidden'), sort_order; pk catalog_id+product_id)` | Which products a catalog sells and on which channels. |
| `catalog_variant_prices (catalog_id, variant_id, price_sen ≥ 0; pk)` | Selling price of each variant in a catalog. Required for every active variant of a product in the catalog. |
| `catalog_option_prices (catalog_id, option_id, price_delta_sen ≥ 0; pk)` | Optional per-catalog add-on price; without a row the option's `price_delta_sen` applies. |
| `branch_catalogs (branch_id, role in ('dine_in','takeaway','qr','additional'), catalog_id; pk branch_id+role+catalog_id; unique (branch_id, role) where role <> 'additional')` | Which catalog a branch uses per order type, plus the additional catalogs the cashier may switch to. |
| `orders.catalog_id uuid references menu_catalogs` | The catalog the order was priced from (null on orders placed before this change). |
| `product_schedules (id, product_id, days smallint[] (ISO 1=Mon…7=Sun), start_time time, end_time time, check start_time <> end_time)` | Time slots. No row = always available. `end_time < start_time` crosses midnight; `days` refer to the day the slot starts. |
| `menu_products.image_path text`, `image_updated_at timestamptz` | Path of the product photo in the `menu-images` bucket. |

- `menu_variants.price_sen` stays as the **default price**: it pre-fills a catalog's price when a product is added to a catalog.
- `menu_products.availability` is **no longer read** once catalogs exist (ordering, QR and the counter read `catalog_products.availability`). It is kept until a later clean-up migration drops it.
- Sold-out stays per branch (`branch_menu_status`) and applies in every catalog. Its write policy is tightened to the caller's own branch (`branch_id = pos_caller_branch()`), closing the gap noted in the exploration.
- Nothing is hard-deleted: products, variants, groups, options, categories and catalogs are deactivated, because old orders reference them.

**Backfill (in the M1 migration, so dev and prod keep working before any re-import):** create catalog `Craft Cafe` from today's menu (`catalog_products` from `menu_products.availability`, `catalog_variant_prices` from `menu_variants.price_sen`), and assign it to every active branch as `dine_in`, `takeaway` and `qr`.

## 3. Ordering with catalogs

**Counter iPad.** The order pad gets a catalog selector at the top. Default: the branch's `dine_in` catalog for a table order, `takeaway` for a takeaway order. The list adds the branch's `additional` catalogs. Switching reloads products and prices; if the cart is not empty the cashier confirms "Switching catalog clears the cart". One order = one catalog; a bill may hold orders from different catalogs. A rejected offline order keeps its catalog when edited.

**QR.** The customer page always uses the branch's `qr` catalog and shows only `availability = 'all'` products, with photos.

**Server checks (`pos_insert_order`, `place_counter_order`, `place_table_order`).** The client sends ids only, as today, plus `p_catalog_id` on the counter path.
1. The catalog is active and assigned to the branch: the default for this order type, or an `additional` catalog (counter only). Otherwise refuse "This catalog is not available at this branch". A branch with no catalog for the role is refused "No menu catalog is set for <role> — set it in POS settings".
2. The product is in the catalog with an availability the source allows (QR: `all`; counter: `all`, `counter_only`).
3. The product is inside one of its time slots now (Asia/Kuala_Lumpur), or has none. Otherwise refuse "<name> is not available at this time".
4. Variant price = `catalog_variant_prices`; option delta = `catalog_option_prices` or the option's default. Snapshotted on `order_items` as today; `orders.catalog_id` is recorded.
5. Sold-out, min/max per group, add-on availability: unchanged.

Offline orders are checked with the server's clock when they are sent; one that misses its slot lands in the existing "Rejected" strip.

**Time slots on screen.** QR hides products outside their slots. The counter greys them out with "Available 08:00–11:30" (the next slot today). Both re-evaluate every minute while open.

Money rules (Sub-plan 3) are unchanged: they work on snapshotted prices.

## 4. Menu back office (`/menu`)

Gated by `manage_menu`. Four pages:

- **Products**: list with search and category/catalog filters. Product editor: name, internal name, description, category, SST rate, print route, takeaway fee, photo, variants (add, rename, reorder, deactivate, default price), linked modifier groups (add, reorder, remove), time slots, and a **Catalogs** table (one row per catalog: included, availability, price per variant; adding pre-fills default prices). Saved in one transaction by `menu_save_product(jsonb)`.
- **Catalogs**: create, duplicate (copies products, prices, option prices), rename, reorder, deactivate. Opening a catalog lists every product with included / availability / variant prices editable in the grid (one row saved at a time).
- **Modifier groups**: create and edit name, min, max, stackable, and options (name, price delta, linked add-on product, default, availability, order), with per-catalog option prices in an expandable section. Saved by `menu_save_group(jsonb)`.
- **Categories**: create, rename, reorder, deactivate.

Every save reports its outcome next to the section that made it (the Sub-plan 3 lesson). Server functions validate everything (prices ≥ 0, min ≤ max, at least one active variant, a product in a catalog has a price for each active variant).

**Branch catalogs** live on **POS settings** (section "Menu catalogs"): dine-in, takeaway and QR catalog selects plus additional-catalog ticks. Gated by `access_settings` for the caller's own branch only.

## 5. Photos

- Bucket `menu-images`, public read; insert/update/delete only for `has_menu_cap('manage_menu')`. Path `products/<product_id>/<random>.webp`.
- One photo per product. Uploads are resized in the browser to 800 px wide WebP (quality 0.8) before upload; input must be an image under 10 MB. Replacing a photo uploads a new file and deletes the old one.
- **Copy from Feedme (one-off, M3):** with the owner signed in to the Feedme portal, the controller reads each product's photo URL keyed by Feedme product ID and, with the owner's permission for the download, saves them as one zip named `<feedme_product_id>.<ext>`. `/menu/import` gets a **Photos** step: pick the zip → each file is matched by `feedme_product_id`, resized and uploaded; the page lists unmatched files and products still without a photo. No secrets or service keys are involved. **Unverified:** that the portal exposes each photo's URL together with the Feedme product ID; M3 starts by checking this, and if it does not, photos are uploaded by hand in the product editor.

## 6. Import becomes "initial load"

`/menu/import` reads **every** catalog sheet:
- `Default Catalog` → master products and default prices; `Default AddonGroup` → groups and default option prices.
- Each other sheet → a catalog (matched by `feedme_catalog_name`). **Every sheet lists all 409 products** (verified on the real export 2026-10-24); a product is in the catalog when its base row's `Order from` is `ALL` or `POS_ONLY` (→ `all` / `counter_only`), and left out when it is `NONE`. `Selling price` → variant prices; the catalog's `addonGroup` sheet → `catalog_option_prices` where the price differs from the default. Included base products per sheet: Craft Cafe 248, Staff Meal 251, Grab Mart 130, Grab Mart Puchong 118, Delivery express 95, Craftale Bar 85, Grab Food 66, Grab Food Puchong 65, Craftale 55, Dino Meal 24 (Feedme's own "Catalog usage" counts are lower because they leave out add-on-only items).
- Product–group links stay global and are taken from the `Default Catalog` column of `itemLinkedAddon`; the import report lists links that differ in other catalogs.
- Branch assignments are **not** imported (set on POS settings).
- `Default Catalog` holds all 409 master products (526 rows with variants), never a blank price, and the same columns as the catalog sheets (verified 2026-10-24). Its `Order from` is not a catalog of ours; it only sets the master `menu_products.availability`, which nothing reads after M1.

Because Craft OS is now the master, the page warns "Craft OS is the master of the menu. Importing again overwrites names, prices and catalogs you changed here." and asks for a typed confirmation when any catalog already exists.

## 7. Permissions

- New capability `manage_menu` ("Edit menu"), defaults: owner, admin. Added to `DEFAULT_SYSTEM_ROLE_CAPS`, the System Roles screen and `has_menu_cap` (with the live-staff rule). All menu-table writes and the menu RPCs require it; today's `access_settings` write policies on menu tables are replaced. Managers keep sold-out (counter) and branch catalog settings.
- Reads stay open to signed-in staff; QR reads only through `qr_menu`.

## 8. Phases (one implementation plan each)

- **M1 — Catalogs in ordering:** tables, backfill, `manage_menu`, branch catalogs on POS settings, catalog-aware `pos_insert_order`/`place_*`/`qr_menu`/`fetchPosMenu`, counter catalog selector, full multi-catalog import. Deliverable: Staff Meal and Grab prices usable at the counter.
- **M2 — Menu editor:** the four `/menu` pages, `menu_save_product`, `menu_save_group`.
- **M3 — Time slots and photos:** `product_schedules` (editor, server check, counter grey-out, QR hide), `menu-images` bucket, upload in the product editor, QR photos, Feedme photo copy.

## 9. Testing

- **Vitest:** catalog resolution for a branch/order type; slot evaluation (days, midnight crossing, Malaysia time); multi-sheet export parsing against a fixture with three catalogs; resize parameters; editor form validation.
- **SQL verify script (dev only):** refused when the catalog is not the branch's or is inactive; QR cannot order `counter_only`; price and option delta come from the catalog; schedule refusal including a midnight-crossing slot; `manage_menu` required for every write (manager refused, owner allowed, resigned owner refused); branch sold-out write limited to own branch; backfill produced Craft Cafe with today's prices. Earlier verify scripts (menu, ordering, checkout) must still pass.
- **Browser on dev:** switch to Staff Meal at the counter and see its prices on the bill; QR shows photos and hides an out-of-slot product; editor round trip (add product → add to two catalogs with different prices → order it in each).

## 10. Rollout notes

- Same rule as earlier sub-plans: these migrations run on prod before any main deploy that carries the code; seeds never on prod.
- The menu `availability` column and the `access_settings` menu policies change meaning in M1; re-running the 2026-10-22 menu migration afterwards would restore old policies (same re-run hazard as the checkout fixes file).
- Grab orders still arrive in Feedme; Feedme's menu is no longer maintained from Craft OS.
