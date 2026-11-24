# Menu back-office tidy-up (Feedme layout) and Feedme photos

Date: 2026-10-25 · Branch: `feature/pos-demo` · Builds on menu catalogs M1–M3, the pre-pilot hardening and the
packaging-fee / print-route menu data of 2026-10-25.

## Why

The owner finds the /menu back-office untidy and asked for it to follow Feedme's back-office layout, and for the
product photos that are still missing. Scope (owner, 2026-10-25): the menu back-office only — not POS settings,
not the HR pages.

## Owner decisions (2026-10-25)

1. Follow Feedme's structure (left sub-menu, one flat product table with photos, bulk edits); keep Craft OS's
   brown colours and type, not Feedme's orange.
2. Download the product photos from Feedme.

## 1. Photos from Feedme

**Finding:** the Feedme portal's menu store (`mf-menu-store` → `state.menu.modules.item[]`) has two photo fields:
`images[]` (39 items, imported on 2026-10-24) and `thumbnail` (295 items — a public URL, 292 on
`image.feedme.cc`, 3 on `firebasestorage.googleapis.com`, about 550–1500 px wide). The 2026-10-24 import read
`images` only, so 256 products with a Feedme photo still have none here.

**Change:** download every `thumbnail` of an item with no `images` (256 files) from the portal page the owner is
signed in to, name each `<item _id with ':' replaced by '_'>.jpg` (the same key as `menu_products.feedme_product_id`),
zip them, and import the zip on dev through the existing /menu/import **Photos** step (resized to 800 px WebP in
the `menu-images` bucket). The 39 photos imported earlier stay. Items with neither field (114, mostly add-ons and
event items) stay without a photo. The zip lives in the session scratchpad; for prod, rebuild it the same way
after the prod menu import. No code change. If the importer refuses a file (e.g. not a JPEG), list it and leave
that product without a photo.

## 2. Menu back-office layout

**Now:** a row of tabs on top (Products, Catalogs, Add-on groups, Categories, Schedules, Import from Feedme); the
product list is grouped by category with a select per row for SST and print route and a "Print whole category to"
select per group; no photos.

**Change:**

- **Left sub-menu** inside /menu (Feedme style), replacing the top tabs, in this order: Products, Categories,
  Add-on groups, Takeaway fees, Schedules, Print routes, Catalogs, Import from Feedme. The current page is
  highlighted. On a narrow screen (below 900 px) it becomes a horizontal scrolling strip above the page.
- **One page header** for every /menu page: the title with a count chip (e.g. "Products 410"), and the page's
  actions on the right (Products: "Import", "+ Add product").
- **Products page:** a filter row — Category, Catalog, "Show add-ons", "Show switched-off" — and a search box;
  then one flat table, sorted by category order then product order, with columns: select box, photo (48 px
  square; a grey placeholder when there is none), Product (name; variant count when more than one), Price
  (default variant), SST, Category, Sold in (catalog names, "+N" after two), Print route, Takeaway fee,
  Status (On / Off). A click on a row opens the product editor. A click on the photo opens the photo picker
  for that product (the editor's existing upload: 800 px WebP) and the new photo shows at once.
  Selecting rows shows a bulk bar: "N selected" · Set print route · Set SST · Set takeaway fee · Switch on ·
  Switch off · Clear. Each action asks for the value, writes with the existing `updateProducts` (chunks of
  100) and refreshes. The per-row selects and "Print whole category to" go away.
- **Takeaway fees page** (new, no new table): the products grouped by `takeaway_fee_sen` — one row per amount
  ("RM 1.00 · 97 products", "No fee · N products"; add-ons are not counted). Opening an amount lists its products (photo, name,
  category) with Remove (sets the fee to 0); "Add products" opens a picker (search + category filter, multi-select)
  that sets the amount; "+ New fee" asks an amount and opens the picker. Add-ons are left out.
- **Print routes page** (new, no new table): the same pattern grouped by `print_route` ("Bar · 36",
  "Kitchen · 61", "No ticket · N"; add-ons not counted); Remove sets the route to none; "+ New route" asks a route name. A hint
  says each branch maps a route name to a printer in POS settings.
- **Categories, Add-on groups, Schedules, Catalogs, Import:** the same header and table styling; behaviour
  unchanged.

## 3. Server

`menu_product_list` also returns `image_path` (and `image_updated_at`, for cache-busting the thumbnail URL). It
is re-created in a new migration `supabase/migration-2026-10-25-menu-list-photo.sql` (idempotent, same grants,
`notify pgrst, 'reload schema'`); the editor-fn file gets a re-run note. Nothing else changes on the server;
bulk edits use the existing `menu_products` update policy (Edit menu cap).

## Copy and style

All labels English. Craft OS colours (brown buttons, cream hover, border tokens) and fonts. Tables: sticky
header, row hover, right-aligned money. Empty states: "No products match." / "No products with this fee yet."

## Testing

- **Vitest:** the product table's pure view logic (filter, search, sort, "+N" catalogs, price of the default
  variant), grouping by fee and by route, bulk-selection state (select all visible, clear on filter change),
  the photo URL builder, the sub-menu's active item.
- **SQL:** run the new migration on craft-os-dev twice; the menu-editor verify and slots-photos verify still
  print VERIFY OK.
- **Browser on dev** (desktop 1440 px and iPad 1180 px): sub-menu on every page; products table shows photos
  after the import; filter + search; bulk set print route on 3 products and back; change one photo from the list;
  Takeaway fees and Print routes pages show the dev counts (RM 1.00 · 97, Bar · 36, Kitchen · 61) and add/remove
  works; the POS pad and QR page still show photos.
- **Photos:** after the import, count products with `image_path` on dev (expect 39 + 256 = 295 less any refused).

## Not in scope

POS settings and HR pages; Feedme's other menu pages (Subcategory, Variant, Order pacing, Cooking guide, Serving
sequence, Publish, Menu setting); named takeaway-fee templates (Feedme links products to named fees — here the
fee stays a per-product amount, grouped by value).

## Note for the owner

Feedme's own Takeaway page has three fees: "Packaging Fee" RM 1.06 on 45 items (the Grab products), "Packaging
Fee 2 set" RM 2.12 on 3 items and "Packaging Fees" RM 1.00 on 8 items. The 2026-10-25 decision (RM 1.00 on every
Craft Cafe drink and food item) charges more items than Feedme does today.
