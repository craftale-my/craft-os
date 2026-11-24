# Feedme Back Office (portal.feedme.cc) — Teardown

Recorded 2026-10-23 from Craftale's own merchant login (business **Craft Cafe**, outlets Cheras / Kepong / Puchong), read-only: no setting was saved. The goal is a faithful map of what Feedme's back office does, screen by screen, so Craft OS's POS can be checked against it. The iPad POS front end is a separate teardown (to follow).

What this document deliberately leaves out: bank accounts, phone numbers, staff and member names, registration/tax numbers and any figure from the live account. Where a screen shows data, only its **structure** (columns, fields, switches) is recorded. Counts are kept where they describe the setup (e.g. "409 products", "37 groups").

Legend: **[P]** = locked behind Feedme's Premium plan on this account. `/path` = the portal route.

---

## 0. Shell

- **Top bar:** module switcher (grid icon, top-left, shows the current module's name) · Feedme logo · language/region · outlet switcher · user avatar.
- **Outlet scope:** most list pages carry a `storefront` outlet picker ("3 selected" / one outlet). Settings that are per outlet (order settings, payment types, discount-rule sync, e-invoice) pick one outlet at a time.
- **Every URL carries** `country`, `businessId`, `restaurantId` query parameters.
- **Left nav** belongs to the current module; some entries are collapsible groups.
- **Footer of the left nav:** "Timezone: Kuala Lumpur (UTC+08)"; Report also has "Switch to report v3".
- **Module switcher (9 entries):**

| Module | Tagline | Landing route |
|---|---|---|
| Report | Make informed decisions with detailed insights | `/report/overview` |
| Connect | Drive sales through targeted campaigns | `/connect/analytic` |
| Inventory | Optimize stock levels and track inventory in real-time | `/inventory/stock` |
| HRM | Manage employee records | `/hrm/employee` |
| Restaurant Operation | Manage your restaurant operations | `/restaurant-operation/transaction` |
| Menu | Manage menu | `/menu/product` |
| Payment | Streamline transactions and track settlements effortlessly | `/payment/payout-account` |
| Mini Program | Elevate your brand with custom landing pages | `/brand` |
| Settings | — | `/settings/business` |

---

## 1. Menu (`/menu/*`)

Left nav: Products · Category · Subcategory · Group · Takeaway · Scheduler · Variant · Order pacing · Cooking guide · Print route · Serving sequence · Publish · Menu setting · Catalog.

### 1.1 Products (`/menu/product`) — 409 products
- Toolbar: **Menu management** · **Export** · **Import** · **Add product**; filters **Category: All** and **Scheduler: Summary**; search "Search products".
- Columns: Code · Product name · Price (RM) · SST · Categories · Subcategory path · Order from (sortable) · actions (overview, delete). An `edit` column header toggles inline edit.
- Example rows (structure): `Pasta Combo · 19.90 · 6.00% · Best Value Combo ⭐️ · -- · All`; `Keychain · 9.90 · 0.00% · Birthday Wishes, Seasonal · POS`.

### 1.2 Product form ("Update product") — full page
Right rail **Product summary**: Product code · Product name · Category · Order from · Selling price · Tax · Inventory · Takeaway.

Sections, top to bottom:
1. **Update product from** — *Catalog* (e.g. Main) and *Scheduler* (e.g. All time): the price/availability being edited belongs to that catalog × scheduler.
2. **Product detail** — Product code · Product name * (with translate) · Internal name · Description (optional, translate + AI) · Product image (drag & drop, crop, cover, AI enhance).
3. **Categories** — *Sell as product with add on* ("appears à-la-carte") with category multi-select; or *Sell as add-on only*.
4. **Subcategory – menu path** (e.g. Coffee/Latte).
5. **Shelf life (mins)**.
6. **Item Quantity** — min/max order quantity **per bill** and **per ordering session** ("one diner's order on a single device; several sessions can be combined into one bill").
7. **Order from** — Available for all / POS / … (channel availability).
8. **Price** — Selling price (RM) · SST rate (e.g. SST 6.00%; "applicable if restaurant profile SST is set") · **Member Selling Price** (per member tier) · **Price group** table (Group title · Default selling price · Member selling price; linked to catalogs).
9. **Price setting** — Open price · Allow adjust price without permission · Sell by unit (weight/length) · Track costing · Has a minimum price after discount.
10. **Printing** — *Group with parent* (print with its parent when served as an add-on) · **KDS configuration**: *All at once* or *Sequential dispatch* · **Linked routes** (multi: Bakery, Bar, Basement, Front House, Kitchen) + Add route.
11. **Variants** — add options like size/type.
12. **Groups** — "Add group to your product to sell them as a combo set": list of linked modifier groups (e.g. Choose your base / Choose your protein / Choose your drinks / Spicy Level) with edit/delete.
13. **Inventory** — ingredient + recipe per product/variant; **Product threshold for online orders** (stock ≤ N → prompt to remove from online ordering).
14. **Takeaway** — takeaway charge per product (e.g. Packaging Fees) · switch *App: enable takeaway option for App ordering*.
15. **Order Pacing** — *Serve later*: delay sending this item to the kitchen relative to other dishes.

### 1.3 Category (`/menu/category`) — 50 categories
Drag-to-order list; columns Category title · Apply products ("7 products linked"); Add category.

### 1.4 Subcategory (`/menu/subcategory`) — 12
Drag-to-order list (e.g. Premium Ochazuke, Standard Ochazuke, Tea); Add subcategory.

### 1.5 Group (`/menu/group`) — 37 modifier groups
- List: Group name · Products (option names) · Applied products ("49 items linked"); filter Scheduler: Summary; drag to order.
- **Update group** drawer: Group name (translate) · **Min. select** · **Max. select** · Configuration: **Stackable** ("customer can choose same option more than once") · **Product** table: Default · Code · Title · Price (RM) · Order from · per-row actions · **Link products** ("unlinked variant's orderFrom will be set to None").
- Options are themselves products (e.g. "Smoked Duck", "Add Espresso", "Serve NOW / AFTER Meal" used as a serving-instruction group).

### 1.6 Takeaway (`/menu/takeaway`) — 3
Takeaway name · Price (RM) · Apply products (e.g. Packaging Fee 1.06 → 45 items; Packaging Fees 1.00 → 6 items).

### 1.7 Scheduler (`/menu/scheduler`) — 1
Scheduler name · Repeat · Period · Apply product (e.g. "Grab Combo Set · Daily · 10:00 am – 11:59 pm · 10 items").

### 1.8 Variant (`/menu/variant`) — 18 reusable variant sets
Variant name · Option values · Applied products (e.g. "Buckets Beer · 5 bottle in 1").

### 1.9 Order pacing (`/menu/order-pacing`)
Timing presets: Timing label · Delay (mins) · Applied products (e.g. "Delay 10 · 1 item").

### 1.10 Cooking guide (`/menu/cooking-guide`) — empty; "Add guide".

### 1.11 Print route (`/menu/print-route`) — 5 routes
Print route name · Product linked: Bakery 81 · Bar 168 · Basement 76 · Front House · Kitchen. (Route → printer mapping lives on the POS device, not here.)

### 1.12 Serving sequence (`/menu/serving-sequence`) — none set; "Add sequence".

### 1.13 Publish (`/menu/publish`)
Menu changes reach outlets only when published. Toolbar: Refresh · Publish progress · Publish all · Filter · per-row Publish / undo. Columns: Restaurant · Default · POS takeaway · Pick up · Version · Status.

### 1.14 Menu setting (`/menu/setting`) — tabs
- **Menu configuration:** Tax setting → Tax calculation *Automatic* ("all prices default to exclusive; through a delivery company they automatically become tax inclusive") or *Manual* (per catalog) · *SST inclusive* switch · Product threshold for online orders.
- **Price group:** named price groups linkable to catalogs.
- **Member pricing:** member tiers that then appear on each product's price section (none configured).
- **Link products rule groups:** rule groups that link products by restaurant and item attributes (Name · Description).

### 1.15 Catalog (`/menu/catalog`) — 10
Catalog title · Tax calculation (all Manual) · Auto link item (Activated/Deactivated) · duplicate · delete; "Catalog usage". Catalogs: Craft Cafe · Craftale · Craftale Bar · Delivery express · Dino Meal · Grab Food · Grab Food Puchong · Grab Mart · Grab Mart Puchong · Staff Meal.

---

## 2. Restaurant Operation (`/restaurant-operation/*`)

Left nav: Receipt · Table · Payment · Reason template · **Operation Settings** ▸ (Order Setting · Display System · Discount Rule · Service Charge · Currency Exchange) · **Kitchen** ▸ (Print Templates) · Deposit · Feedback.

### 2.1 Receipt (`/transaction`)
Bill search + Export. Columns: Receipt · Bill ID · Table · Created at · Completed · Status · Total · Payments. Paged (10 per page).

### 2.2 Table (`/table`) — 49 tables
Toolbar: Download QR Code · Add table · list/grid view · **Edit layout**. Layout tabs: All tables · Ground Floor · Beside Floor · Upstairs · Staff · Grab. Columns: Table · Layout · NFC tag (Linked / Not linked). Includes a `#Takeaway` pseudo-table.

### 2.3 Payment — Offline Payment (`/payment`) — 9 types (per outlet)
Columns: Name · Pulse Drawer · Type (Default / Custom) · Reconcile Mode · Reconcile Options. Types on Cheras: CASH · FEEDME · Grab – Craft Cafe · Grab – Dino Meal · GRAB DINE-OUT · Maybank Terminal · ONLINE BANKING · Pine Labs Terminal · TOUCH N GO. "Add Payment Type".

### 2.4 Reason template (`/reason-template`)
Columns: Action · Reasons · Compulsory · Allow Other — preset reasons per action (void, refund, …); none configured.

### 2.5 Order Setting (`/order-settings`) — per outlet, tabs
- **Delivery:** integrated delivery companies and local delivery companies (Company · Catalog · Payment Type · Status), e.g. In House delivery → Delivery express; Food Panda → Main.
- **Dine In:** Anonymous order · Ignore stock · Static QR code · Customer item remark · Customer order remark · Accept queue · Last order before closing · Allow takeaway · **Pax dialog (online ordering)** · Print checklist (online orders only) · **Overwrite bill pax** · **Auto send kitchen** (Follow Auto Accept / …) · **Auto close bill** · Print receipt after auto close · **Allow reject on POS** · Accepted payment (Offline: Payment at Counter, CASHLESS; E-Payment; Credit).
- **Pickup:** Online (activated, adjust from POS) · Ignore stock · Auto send kitchen · Auto close bill · Print receipt after auto close · Allow reject on POS · Order type ASAP / Pre-order · Accepted payment · Multiple pickup points.
- **Drive Thru:** Enable drive thru.
- **Notifications:** SMS credit balance and price per message (RM0.20); events PICKUP-ACCEPT, PICKUP-SERVE, DELIVERY-ACCEPT → channels.
- **General:** Prompt login dialog for anonymous order · Sub-item list view · Hide product code · **Numbering**: auto reset order number; ranges Takeaway #TA001–#TA999, Pickup #P001–#P999, In-house delivery #D001–#D999, FeedMe express FM001–FM999 (each with current number).
- **Queue:** Enable queue order · Auto-called limit · Disable remote queue · Allow override queue code · Notification channels (tried in order: push [native app], SMS) · Print checklist · Show estimated wait · Auto send kitchen (Follow Dine In) · Preset remarks · Queue code settings (Prefix · Current · Start · End · Pax min/max) · Estimated wait time.

### 2.6 Display System (`/display-system`)
ODS templates (POS v7) — "Switch to Display System (POS v8)", Add Configuration (none).

### 2.7 Discount Rule (`/discount-rule`)
"Define how the discount is applied to the bill. Requires POS 7.9.9+." Add discount rule · Save setting. **Restaurants** sync table (Restaurant · Version · Status = Outdated) with Force sync.

### 2.8 Service Charge (`/service-charge`)
- Enable service charge; **Before bill discount / After bill discount**; type **Exclusive / Inclusive**.
- **Custom service charge** rows, each: Rate % · Select item (All / N items) · Select table (All / N tables) · Apply for (Dine In · Takeaway · In-house delivery · Delivery company · Pickup). Craft Cafe has 3 rows (all items/all tables for takeaway·delivery·pickup; 3 tables for dine-in·takeaway; 70 items for dine-in·takeaway).

### 2.9 Currency Exchange (`/currency-exchange`) — Currency · Rate (none).

### 2.10 Print Templates — Receipt Template (`/kitchen/receipt-template`)
Header text · Invoice prefix · Overall font size · Receipt setting: Show contact / Show address / Show email / Hide product code / Hide item with zero price / Hide add-on with zero price · Footer text · Footer QR · Logo image (jpeg/jpg/png, height, width) · Reset to default · Template builder · **Advance builder**.

### 2.11 Deposit (`/deposits`)
Deposit settings. Columns: Deposit ID · Reference No · Created At · Created By · Booking Date · Allowed Outlets · Status · Deposit Amount.

### 2.12 Feedback (`/operation-feedback/feedback`) — rating summary + date filter.

---

## 3. Report (`/report/*`)

Left nav: Overview · Report · Template · Insight (Beta) · Setting · Integration.

### 3.1 Overview
Filters: outlets · date range · comparison period · reporting hour (e.g. 09:00AM–03:00AM). KPI cards with % vs previous period: Sales · Bill Count · Item Count · Discount · Draft Bill Count · Draft Bill Nett. Charts: Top 10 outlet sales · Top products · Hourly sales · Daily sales. Download.

### 3.2 Report list — 39 saved reports (all "POS v8")
- **Sales:** Summary · Overview (×2) · Close up · Daily sales · Hourly sales · User product sales · Receipt · Product by invoice · Discount · Product sales · Product sales by time · Addon sales · Product sales category by tax · Product sales by SST 8% · No Tax/6%/8% · Summary in details.
- **Operations:** Drawer · Counter · Timesheet · Void · Refund · User change payment records · KDS performance.
- **Inventory:** Inventory adjustment · Inventory balance · Product unit.
- **Marketing:** Voucher (V1, V2) · Member store purchase · User credit transaction (V1, V2) · Credit transaction (V1, V2) · Member / Campaign voucher / Tier and experience / Point and store / Credit dashboards.
- Each report: Duplicate · Send Email · Download; same filter bar as Overview.

**Close up (the day-end / Z report)** — KPI cards: Bill count · Total sales · Total pax · Total discount · Total void · Total refund · Void bill count · Average sales · Average pax · Average sales/pax. Tables: Payment summary · Charge summary · Delivery summary · Pickup summary · Type summary · Source summary · Member store · **Sales summary**: Gross → Discount → Delivery fee → Other charge → Gross before charges → SST → Service charge → Rounding → **Nett**.

### 3.3 Template — 13 report templates
Wastage report (Inventory) · KDS performance · Product sales & profit (uses inventory default unit cost) · Daypart sales · Table turnover rate (dine-in) · Member store purchase with payment · Track voucher usage · Receipt – slot sales ("Nett = Sales − Refund") · Purchase order · Table turnover · Payment reconciliation · POS availability changelog · Inventory movement.

### 3.4 Setting
**Reporting hours** (named time windows used as filters): Full day 12:00AM–11:59PM · Operation Hour (default) 9:00AM–3:00AM · Midnight Bakery 10:30PM–3:00AM · Morning Shift 9:00AM–6:00PM · Night Shift 6:00PM–3:00AM. Default date range (Today) · Comparison range (Previous period) · Business timezone (Asia/Kuala_Lumpur).

### 3.5 Integration — accounting exports: SQL Accounting · AutoCount (Name · Platform).

---

## 4. Connect — marketing & loyalty (`/connect/*`)

Left nav: Analytic · **Campaign** ▸ (Promotion · Voucher · Broadcast) · **Program** ▸ (Experience · Premium→Point · Credit · Game · Mission) · **Loyalty** ▸ (Member · Segments · Reward Cards) · Referral · Store · Transaction · Marketing Materials · Review · Goals · Setting. Most pages carry a Feedme AI ("Remy") "Try it" banner.

- **Analytic:** member count (~1k), active members, member sales, repeat rate, setup checklist.
- **Promotion:** Promotion title · Status · Type · Summary · Actions (insights, duplicate); Force sync · Queue · Create campaign.
- **Voucher:** Voucher title · Status · Summary · Quota · Claimed · Actions; Create campaign.
- **Broadcast:** SMS/WhatsApp broadcast with credit balance; Purchase credits.
- **Programs:** Experience (tier/XP) · Point · Credit (stored value) · Game · Mission — each "Create … program" (none configured except as noted by Analytic).
- **Member:** Name · Phone · Customer since · Tier · Title · Credit(s) · Experience(s) · Point(s) · Total visit · Last visit; export.
- **Segments:** default segments to get started.
- **Reward Cards:** member cards + card design.
- **Referral:** tiers, rewards, criteria; overview and record.
- **Store:** point/credit store with reward bundles and categories [P for some].
- **Transaction:** Transaction ID · Created at · Amount · Type · Source · User · Phone · Status · References (Collection / Store tabs).
- **Marketing Materials:** AI-generated material.
- **Review:** Google-style review summary, reply, settings.
- **Goals:** "What do you want Connect to help with?" → checklist.
- **Setting:** Basic information (membership title, member app URL, cover image) · **Counter App** (linked device) · Advertisements [P] · SMS (brand name, credits, preview) · email recipients · WhatsApp channel · "Allow member to bind card via member app".

---

## 5. Inventory (`/inventory/*`)

Left nav: **Stock** ▸ (Stock Balance · Wastage template [P] · Unit Cost History [P]) · **Closing** ▸ (Closing history · Closing template · Closing draft) · Ingredient · Recipe · **Order** ▸ (Purchase/Transfer in · Transfer out · Template) · Supplier · Warehouse · Publish · Integration · Settings. Most of the module shows a Premium upsell on this account.

- **Stock Balance:** Code · Product · Balance · Days remaining (Beta); Refresh · Export · Stock adjustment · Refresh balance; unit switcher.
- **Closing history:** Closings / Snapshots tabs; Date · Time · Created from.
- **Ingredient:** Code · Name · Unit · Status; Import · Export · Add ingredient · Filter.
- **Recipe:** Recipe · Ingredients; Export · Add recipe.
- **Purchase/Transfer in:** # · Created at · Transfer from · No. of items · Reference · Status; Create transfer.
- **Transfer out (approval):** # · Created at · Transfer to · No. of items · Reference · Status.
- **Supplier:** Supplier · PIC · Contact · Email; Import · Export.
- **Warehouse:** Warehouse · Contact · Email · Address.
- **Publish:** inventory config pushed to outlets (Type · Location · Version · Status; Publish all).
- **Integration / Settings:** admin-only.

---

## 6. HRM (`/hrm/*`)

Left nav: Employee · Team members · Audit Log · POS Access · **Scheduling** ▸ [P] (Schedule · General Settings · Positions).

- **Employee** (tabs Employee · Role · Timesheet): "Manage employees with access to the POS at your outlets." Columns: Code · Name · Restaurant (multi) · Assigned role (per restaurant) · Join since; filters Restaurant / Role; Export · Create employee.
- **Role:** Name · Operation (N permissions) · Report (N permissions) · Restaurant(s). Roles on this account: admin · Bakery · Full Time · Part Time · Supervisor.
- **Role form ("Update role")** — Name · Restaurants · **Permissions**:
  - *Operation:* Discount (+ **max discount percentage**) · Change price · Void · Waive service charge · Payment · Claim deposit · Resend · Change payment type.
  - *Report (what the POS may show):* Closeup · Counter · Hourly sales · Daily sales · Product sales · Source product sales · User product sales · Category sales · Addon sales · Slot sales · Drawer · Discount · Refund · Void · Timesheet · Counter payment · Inventory balance (POS v8+); several have a ⚙ to choose detail level.
  - *Other (POS settings screens):* Refund · Counter · Mall integration · Drawer · Menu · Inventory · Deposit · Delivery · Counter record · Restaurant setting · Display · Printer · Table · Employee · System · Tax · Payment type · Face ID.
- **Audit Log:** module filter (All · Inventory · Report · HRM · Payment · Menu · CRM · POS), date range, User · Subject · Action type · Status; rows like "Employee Management · List employees page · Success"; Export.

---

## 7. Payment — FeedMe Pay (`/payment/*`)

Left nav: Payout Account · Payment Onboarding · Transactions · Settlements · Financing ▸ (Application).
- **Payout Account:** Type · Name · Status · Active? · Bank details · Person in charge; Apply.
- **Payment Onboarding:** FassPay — "Enable SoftPOS and QR payments for in-store transactions"; Apply.
- **Transactions:** Transaction ID · Pay ID · Gateway ID · Bill seq no · Gateway · Method · Type · Status · Restaurant · Source · Transaction at · Sales amount; Export.
- **Settlements:** Settlement ID · Bank · Account no · Created at · Sales amount · Fee · Settlement amount · Invoice status; FeedMe / Fiuu (RMS) views; Export.
- **Financing — Application:** POS financing prerequisites (check eligibility → apply → processing → disbursed).

---

## 8. Mini Program (`/brand`)

Single page (icon nav):
- **Brandkit:** brand colours (primary, secondary, accent), typography colours, neutral and background colours, brand fonts (stylesheet URLs; brand/heading/body font assignment); Reset to default; Save.
- **Ordering settings:** order-app colour overrides · Category layout (Horizontal / Grid / Single category / Vertical / Multiple categories) · Menu layout · Category display.
- **ODS settings:** Order Display System configurations (none).

---

## 9. Settings (`/settings/*`)

Left nav: My business · **Device Management** ▸ (Device · Kiosk) · Food Courts · License order · E-invoice · Media center.
- **My business:** business header + outlet table: Code · Name · Address · Contact · Email · Tax No; Add restaurant; duplicate.
- **Restaurant form ("Update restaurant"):** *Basic info* — Code (set once) · Restaurant name * · Legal name * · Registration no. * · Tax No · Contact no. · Email · Restaurant image. *Address* — Line 1 · Line 2 · City · Postal code · State · Country · Coordinate (map pin). *Operation hours* — per weekday, several time ranges each, "Copy with" another outlet. *Branding* — Restaurant description · Restaurant URL (feedme.cc/…) · Cover photo · Carousel photos.
- **Device:** Device name · Restaurant · Device type · App version · Binding at; Export · Refresh · Force sync · Add device · Unbind device (5 devices).
- **Kiosk:** device binding and kiosk display settings per outlet.
- **Food Courts:** Name · Owner · Members · Status.
- **License order:** subscription/licence orders.
- **E-invoice (MyInvois):** per outlet and month. Columns: MyInvois Submission ID · Submission date · Type (**Individual Invoice · Consolidated Invoice · Consolidated Refund Note**) · Submit for (month) · Status (Valid); Setting · Export.
- **Media center:** media library, upload, failed tasks.

---

## 10. What this means for Craft OS POS (gap map)

| Feedme capability | Craft OS today (feature/pos-demo) | Where it would land |
|---|---|---|
| Products, categories, variants, modifier groups (min/max) | Imported from Feedme; min/max enforced on the server | Done (Sub-plans 1–2) |
| Stackable modifiers, price groups, member price, open price, sell by unit | Not supported (stackable ignored) | Later; only if needed |
| Catalogs per channel + schedulers | Only "Craft Cafe" catalog availability imported | Later |
| Print routes (product → route) | Done; route → printer per branch on `/pos/settings` | Done |
| KDS sequential dispatch, serving sequence, order pacing | Not supported | Later |
| Menu **Publish** step to outlets | Live immediately (single database) | Not needed |
| Tables with floor layouts, NFC, QR download | Tables + QR cards, no floors | Small add (floor tag) |
| Payment types with drawer pulse and reconcile mode | Not yet | **Sub-plan 3** (checkout) |
| Reason templates (void/refund) | Not yet | **Sub-plan 3** |
| Service charge rules (rate × items × tables × order type; before/after discount; inclusive/exclusive) | Not yet (spec: 10% on subtotal) | **Sub-plan 3** — model as rules, not one rate |
| Discount rules + role max-discount % | Out of demo scope | Sub-plan 3 if the pilot needs it |
| Receipt template (header, prefix, toggles, logo, footer QR) | Not yet | **Sub-plan 3** (receipts) |
| Order numbering ranges per order type | Bill no `YYMMDD-NNN` | Fine for demo |
| Dine-in QR switches (pax dialog, auto send kitchen, auto close bill, allow reject) | QR orders auto-print, pax asked once | Compare in Phase 2 |
| Roles with Operation / Report / Other permissions | Craft OS caps (access_settings) | **Sub-plan 3** supervisor PIN → map to these |
| Close up report (Z report) | Not yet | **Sub-plan 4** — mirror the Sales summary order |
| Reporting hours (shift windows crossing midnight) | Not yet | **Sub-plan 4** |
| E-invoice: individual, consolidated, consolidated refund note | Not yet | **Sub-plan 4** export |
| Loyalty (points, credit, vouchers, tiers, referral, store) | Out of scope | Keep Feedme |
| Inventory (ingredients, recipes, transfers, closings) | Procurement module elsewhere | Separate decision |
| Delivery companies (Grab, Food Panda) | Out of scope | Keep Feedme |
| FeedMe Pay (SoftPOS, settlements, financing) | Out of scope | Keep Feedme / Maybank |
