# PR #19 (feature/pos-demo → main) — production rollout and rollback runbook

Date: 2026-11-24 · Prepared from the repository at `feature/qr-table-cart` = `abd85fd` (PR #19's head `5c804d4` adds
only the readiness doc's inventory steps, which are read here too) · Dev project `egznnbjmicebbhwasloy` ·
Prod project written as `<PROD_REF>` everywhere.

Claude runs the technical steps with the owner present. The owner approves each stage, clicks every merge and
types every secret. Nothing in this file has been run yet.

## 1. What this is, what it is not, and the gates

- **Is:** the order to put the POS, QR ordering, members, e-invoice, menu costing and sales depletion on prod,
  and how to undo each part.
- **Is not:** a test plan (that is `docs/pos/2026-10-25-simulated-run-sheet.md` and readiness §5), and not the
  Grab integration, which is not in PR #19 (`origin/feature/grab` 4fd1db0 is not an ancestor of this branch).
- **Prod today:** none of the POS schema exists ("Prod has no POS data yet: the POS SQL chain has not run on
  prod", `docs/superpowers/specs/2026-10-29-pos-devices-outlets-design.md` line 26). Stocktake is live there
  (readiness §4 inventory step, PR head).
- **Two stages:** Stage A puts everything on prod unused ("dark"); Stage B cuts Cheras over, Feedme kept.
- **Rule for every step:** database strictly before the front end that needs it (readiness §4: "In every
  environment the SQL runs before the app that needs it is deployed").

### Go / no-go gates

| Gate | Blocks | Source | State on 2026-11-24 |
|---|---|---|---|
| G1 Grab orders arrive through Grab's API | Stage B cut-over | readiness §1 D1, §2 WG ("hard gate for cut-over") | Not met: WG unchecked; Grab code is on `feature/grab`, not in PR #19 |
| G2 On-site test done (full run sheet, two real iPads + phone, failure cases, one parallel day) | Stage B | readiness §5 (all unchecked) | Not met |
| G3 Cheras first, Feedme kept signed in as fallback for a week | Stage B shape | readiness §1 D6, §6 | Decided |
| G4 Real-device checks: iPad/Android add-to-home-screen + offline launch; office agent paired; real receipt + drawer kick on a ZyWell | Stage B | switchover spec §4 "Owner, later"; readiness §2 W4, W6 | Not done |
| G5 Print agent can run against prod | Stage B if any route is kind `agent` | `assertAgentDatabase` (`src/features/pos/guard.ts`): the agent refuses the prod database unless its `.env` has `PRINT_AGENT_ALLOW_PROD=1`; set that line only on the outlet's printing computer | Fixed in code 2026-11-24; not yet run against prod |
| G6 Prod menu import (Feedme export) + photo zip | Stage B | readiness §3 | Owner input |
| G7 Per-outlet setup: tables/areas, payment methods, printers + IPs, tablets, PINs | Stage B | readiness §3 | Owner input |
| G8 Meta WhatsApp setup (verified business, number, template, token) | Members QR sign-in only | `docs/pos/2026-11-23-members-whatsapp-setup.md` | Owner input; not a cut-over gate (D2 = a) |
| G9 LHDN MyInvois credentials + company details; production signing (v1.1) | E-invoice only | einvoice spec lines 30–32, 74–76; readiness §2 W5 "Before the production switch" | Owner input + build work; not a cut-over gate |
| G10 Recipe imports reviewed (open owner items) | Sales depletion being useful | readiness §4 inventory step 2 (PR head) | Owner input |

**Can go live dark (Stage A, no owner input):** all SQL except the e-invoice cron; the three Edge Functions with
no owner secrets; the Craft OS build (incl. the QR page at `/t/…`); a new `craft-pos` Vercel project.
**Needs the owner's inputs:** G6–G10 above, the prod POS app address, the D7 role change, every secret value.

## 2. Recommended shape: two stages

- **Stage A, dark launch:** all migrations, functions and front ends on prod; no outlet uses the POS.
- **Stage B, Cheras cut-over:** data, devices, printing, staff PINs, first service; Feedme is the fallback.

Reasoning:
1. The SQL chain is long (42 files) and mostly additive; doing it on a quiet night with no POS users makes a failed
   file cheap (stop, fix, re-run that file).
2. Readiness §4 step 5 (PR head) already says merge only after all the SQL, because the Menu Costing and usage pages
   need it; Stage A is exactly that.
3. The Craft OS build on this branch has **no staff-login till**: `/pos` is a notice page
   (`src/features/pos/order/PosPage.tsx`, "The POS has moved to its own app."). So the existing staff app needs
   nothing from the till side.
4. **The POS cannot be hidden by capability.** The nav entry `POS → Register` has no `cap`
   (`src/shared/lib/nav.ts`, `{ id: 'pos-register', … to: '/pos' }`), so every staff member sees it and reaches
   the notice + My PIN. Reports, Members, POS Settings, Devices, E-invoice need `access_settings`; Menu needs
   `manage_menu`; Menu Costing needs `manage_procurement`. Dark = present and empty, not invisible. Tell staff.
5. Some Stage A changes are **live for current users** whatever we hide: wastage above on-hand is no longer
   refused (`migration-2026-11-23-wastage-allow-negative.sql`), the stock count result gains "Since last count",
   Settings → System Roles shows three new capabilities. These are wanted (owner decision 2026-11-23) but they
   are not dark.
6. Stage A is safe only if the Stage A smoke tests (§4h) pass before Stage B starts, and only with the e-invoice
   cron left out (otherwise a production-environment "not set up" run would put a red banner on every
   access_settings page — `src/features/pos/einvoice/einvoice.ts` `bannerMessages`, the `not_set_up` +
   `production` line).
7. Running the C3 switch-over SQL inside Stage A is recommended (decision for the owner, §4b note): its ordering
   rule protects a staff-login print agent, and prod has none.

## 3. Before the day

- [ ] **Backup.** Supabase dashboard → Database → Backups: note the time of the last daily backup and whether
      Point-in-Time Recovery is on. As of 2026-10-29 prod had a daily backup at about 01:47 MYT and **no PITR**
      (`docs/inventory/2026-10-29-prod-rollout.md`, "What production looks like today"). Re-check what the plan
      offers today. Not confirmed in the repo: the current plan and PITR state.
- [ ] **Own dump on the night,** run by the owner in their own terminal (the password never goes into chat):
      ```bash
      pg_dump "postgresql://postgres.<PROD_REF>:<DB_PASSWORD>@<POOLER_HOST>:5432/postgres" \
        --format=custom --no-owner --file="craft-os-prod-$(date +%Y%m%d-%H%M).dump"
      ```
      Keep it outside the repository. Check the file size is not zero.
- [ ] **Read-only snapshot** of what the chain changes on existing objects (precedent: inventory rollout step 3):
      `select pg_get_functiondef('public.log_wastage(uuid,uuid,numeric,text,text,text)'::regprocedure);` and
      `select pg_get_constraintdef(oid) from pg_constraint where conname = 'inventory_transactions_transaction_type_check';`
      Save both outputs to a local file.
- [ ] **Vercel:** in the `craft-os` project, Deployments → note the id and URL of the current Production deployment
      (the instant-rollback target).
- [ ] **Freeze:** no other session merges to `main`, deploys `craft-os`, or runs prod SQL from the start of Stage A
      until its smoke test passes. `main` deploys to prod on merge (§4g), and one working tree is shared by several
      sessions.
- [ ] **Window:** after closing, outlets closed, one sitting (precedent: inventory rollout "after closing, one
      sitting"). Avoid :10 past the hour (cron `absent-hourly`, `migration-2026-07-09-auto-absent.sql`) and 04:00 MYT
      (`leave-daily` at 20:00 UTC). The inventory files use `set local lock_timeout = '5s'`: retry in a quiet moment.
- [ ] **Reachable:** the owner (merge, dashboards, secrets, approvals); Claude; for Stage B a Cheras manager with
      `pos_supervise` and a PIN.
- [ ] **Access:** a valid Craftale Supabase access token and Supabase CLI login, and the Craftale Vercel login.
      Prod SQL and `vercel deploy --prod` need the owner's allow rule for Claude, or the owner runs them.
- [ ] **Rehearse** the exact chain once on a scratch database before the night (§7 Q4).

## 4. Stage A — dark launch, step by step

### 4a. Pre-flight (read-only, prod)

- [ ] Extensions and services:
      ```sql
      select extname, extnamespace::regnamespace from pg_extension
       where extname in ('pgcrypto','pg_cron','pg_net','supabase_vault');
      select to_regprocedure('extensions.crypt(text,text)') is not null as crypt_in_extensions;
      ```
      Expect `pgcrypto` in schema `extensions` (STOP guard, `migration-2026-10-24-pos-checkout.sql` line 14) and
      `pg_cron` present (prod already schedules `leave-daily` / `absent-hourly`). `pg_net` is needed only by the
      deferred cron file.
- [ ] Name collisions — every row returned is a STOP until explained:
      ```sql
      select 'table' kind, c.relname name from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','p') and c.relname = any(array[
        'bill_counters','bill_depletions','bill_parts','bills','branch_catalogs','branch_menu_status','branch_pos_settings',
        'catalog_option_prices','catalog_products','catalog_variant_prices','dining_tables','einvoice_bill_links',
        'einvoice_documents','einvoice_job_attempts','einvoice_job_runs','einvoice_refund_links','einvoice_settings',
        'member_bill_events','member_earn_failures','member_otps','member_points','member_settings','member_tokens',
        'member_verify_fails','members','menu_catalogs','menu_categories','menu_category_targets','menu_picks_cache',
        'menu_products','menu_recipe_meta','menu_schedule_windows','menu_schedules','menu_variant_recipe_lines',
        'menu_variants','modifier_groups','modifier_options','modifier_recipe_lines','order_items','orders',
        'payment_methods','payments','pos_call_counters','pos_cash_moves','pos_device_requests','pos_devices',
        'pos_discount_log','pos_drawer_opens','pos_login_attempts','pos_pin_attempts','pos_shifts','pos_staff_sessions',
        'print_jobs','print_routes','product_modifier_groups','product_schedules','qr_cart_lines','reason_templates',
        'refunds','sales_depletion_meta','service_charge_rules','staff_outlets','staff_pos_pins'])
      union all
      select 'function', p.proname from pg_proc p
       where p.pronamespace = 'public'::regnamespace and (p.proname ~ '^(pos|menu|qr|member|einvoice)_' or p.proname = any(array[
        'bills_call_no','bills_deplete_on_paid','bills_member_inherit','bills_member_on_status','branch_pos_settings_part_guard',
        'branches_einvoice_from_guard','branches_outlet_guard','checkout_bill','checkout_items','claim_print_job',
        'clear_bill_discount','clear_item_discount','clear_pos_pin','close_shift','copy_variant_recipe','deplete_bill',
        'dining_tables_guard','finish_print_job','has_menu_cap','insert_test_print','item_standard_cost',
        'item_standard_cost_at','item_standard_costs','merge_bills','move_bill','move_items','my_outlets','open_shift',
        'open_table','order_items_catalog_discount','order_items_order_type','pay_bill_part','place_counter_order',
        'place_table_order','print_jobs_call_no','print_jobs_member_line','record_cash_move','refund_bill',
        'refunds_member_points','reprint_receipt','reprint_zreport','requeue_print_job','save_branch_catalogs',
        'save_lock_settings','save_modifier_recipe','save_outlet','save_receipt_settings','save_shift_settings',
        'save_variant_recipe','service_charge_rules_part_guard','set_bill_discount','set_category_target',
        'set_item_discount','set_items_served','set_my_pos_pin','set_product_recommended','set_staff_outlet',
        'staff_has_cap','staff_outlet_scope','stock_count_unrecipe_sales','stock_count_usage','stock_count_usage_calc',
        'stock_count_usage_guard','stock_count_usage_period','stock_count_usage_summary','void_bill','void_order_item']))
      union all
      select 'bucket', id from storage.buckets where id = 'menu-images'
      union all
      select 'cron', jobname from cron.job where jobname = 'einvoice-daily'
      union all
      select 'branches column', column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'branches' and column_name in
        ('receipt_title','legal_name','registration_no','sst_no','phone','email','kind','opens_on','closes_on','bill_prefix','einvoice_from');
      ```
      The lists are every table and every non-prefixed function the branch's migrations create (only `log_wastage`
      is meant to replace an existing function and is left out). Expect zero rows.
- [ ] Inventory guards the depletion file checks are met (`migration-2026-11-23-sales-depletion.sql` lines 15–25):
      `select to_regclass('public.stock_counts'), to_regprocedure('public.has_procurement_cap(text)'), to_regprocedure('public.inventory_avg_unit_cost(uuid,uuid,timestamp with time zone)'), to_regprocedure('public.stamp_inventory_unit_cost()');` — no nulls.
- [ ] No `'sale'` rows can exist yet: `select count(*) from inventory_transactions where transaction_type not in ('stock_in','adjustment','wastage','transfer_out','transfer_in','production_out','production_in','stocktake');` = 0.
- [ ] Auth: Dashboard → Authentication → Sessions: note `sessions_timebox` and `sessions_inactivity_timeout`
      (must be 0 for tablets; `docs/superpowers/plans/2026-10-30-pos-app.md` lines 110, 2872).

### 4b. Migrations, in order

Run each file once, as one transaction, check its result, stop at the first error. Not confirmed in the repo that
the SQL route is one transaction per file: no file has its own `begin;`; the inventory rollout states "each file is
one transaction" for its route. "Touches live" = changes an object that exists on `main` today.

| # | File | Verify | Touches live objects | Notes |
|---|---|---|---|---|
| 1 | `migration-2026-10-22-pos-menu.sql` | y (pos-menu, after #2) | n (reads `system_role_permissions`) | |
| 2 | `migration-2026-10-22-pos-menu-import-fn.sql` | shares #1 | n | STOP-guarded: never re-run once #9 is in (header "STOP guard (M1)") |
| 3 | `migration-2026-10-23-pos-ordering.sql` | y (after #4; header "AND the seed") | **y**: `create extension if not exists pgcrypto`; adds `orders`, `print_jobs` to publication `supabase_realtime` | |
| 4 | `migration-2026-10-23-pos-ordering-fn.sql` | shares #3 | n | never re-run after #9 |
| 5 | `migration-2026-10-24-pos-checkout.sql` | y (after #6) | **y**: `branches` + `receipt_title, legal_name, registration_no, sst_no, phone, email` (lines 19–24); publication + `bills` | STOP if pgcrypto not in `extensions` |
| 6 | `migration-2026-10-24-pos-checkout-fn.sql` | shares #5 | n | never re-run after #9 |
| 7 | `migration-2026-10-24-pos-bill-actions-fn.sql` | n | n | "Run after … checkout.sql and -fn.sql" |
| 8 | `migration-2026-10-24-pos-checkout-fixes.sql` | n | n | after #5–#7 |
| 9 | `migration-2026-10-24-pos-catalogs.sql` | y (after #10) | n | STOP unless #8 ran (line 18) |
| 10 | `migration-2026-10-24-pos-catalogs-fn.sql` | shares #9 | n | |
| 11 | `migration-2026-10-24-pos-menu-editor-fn.sql` | y | n | |
| 12 | `migration-2026-10-24-pos-slots-photos.sql` | y (after #13) | **y**: bucket `menu-images` + 4 policies on `storage.objects` (lines 95–105) | never re-run after #36 (it resets the bucket to 2 MB, WebP/JPEG — lines 95–99) |
| 13 | `migration-2026-10-24-pos-slots-photos-fn.sql` | shares #12 | n | never re-run after #30 (readiness §4) |
| 14 | `migration-2026-10-24-pos-shifts.sql` | y (after #15) | n | "after every earlier POS migration … M1–M3 included" |
| 15 | `migration-2026-10-24-pos-shifts-fn.sql` | shares #14 | n | |
| 16 | `migration-2026-10-25-menu-list-photo.sql` | n | n | "Prod: run it after the slots-photos and editor-fn files" |
| 17 | `migration-2026-10-25-pos-hardening.sql` | y | n | |
| 18 | `migration-2026-10-26-pos-frontend.sql` | y | n | |
| 19 | `migration-2026-10-26-einvoice.sql` | n | n | missing from readiness §4's list; required by #33's STOP guard |
| 20 | `migration-2026-10-29-pos-outlets.sql` | y | **y**: `branches` + `kind` (default `'branch'`), `opens_on`, `closes_on`, `bill_prefix`, 3 check constraints, unique index `branches_bill_prefix_key`, trigger `branches_outlet_guard` before insert or update (lines 94–124) | new capability `pos_login` |
| 21 | `migration-2026-10-29-pos-devices.sql` | y | n | |
| 22 | `migration-2026-10-29-pos-device-till.sql` | y | n | re-running it later puts the C1 transition back (#42 header) |
| 23 | `migration-2026-10-30-pos-app.sql` | y | n | |
| 24 | `migration-2026-10-30-pos-discounts.sql` | y | n | never re-run after #30 (readiness §4) |
| 25 | `migration-2026-11-16-pos-split-bill.sql` | y | n | **pair with #26**, 11-16 then 11-17; never re-run alone after #26 |
| 26 | `migration-2026-11-17-pos-bill-parts.sql` | y | n | |
| 27 | `migration-2026-11-17-menu-picks.sql` | y | n | re-run drops and re-creates `pos_picks_rules()` |
| 28 | `migration-2026-11-18-pos-reports.sql` | y | n | STOP unless #27 |
| 29 | `migration-2026-11-22-pos-receipt-numbers.sql` | y | n | |
| 30 | `migration-2026-11-22-qr-table-cart.sql` | y | n | re-creates `pos_insert_order`, `qr_table_state` |
| 31 | `migration-2026-11-22-pos-feedme-habits.sql` | y | n | after #29 and #30 (STOP line 35) |
| 32 | `migration-2026-11-22-pos-agent-pairing.sql` | y | n | before #42 |
| 33 | `migration-2026-11-23-einvoice-w5.sql` | y | **y**: `branches.einvoice_from` + trigger `branches_einvoice_from_guard` (lines 153–184) | backfill at line 241 is meant for first apply only (readiness W5) |
| 34 | `migration-2026-11-23-members.sql` | y | n (triggers on new `bills`, `refunds`) | inserts `member_settings` row with `qr_enabled` default **true** (line 145) |
| 35 | `migration-2026-11-23-members-pos.sql` | y | n | |
| 36 | `migration-2026-11-23-menu-animated-photos.sql` | y | **y**: updates bucket `menu-images` (4 MB, GIF) | |
| 37 | `migration-2026-11-23-menu-category-kind.sql` | y | n | after #31 (STOP line 14); re-creates `qr_menu` from #31, so do not re-run #31 after it |
| 38 | `migration-2026-11-22-menu-costing.sql` | dev-only VERIFY | n (FKs to `items`) | readiness says after the menu import; its guard needs only the menu tables (lines 10–16) |
| 39 | `migration-2026-11-23-stock-count-usage.sql` | dev-only VERIFY (sales-depletion) | **y**: index `inventory_transactions_sale_waste_idx`; `drop index if exists inventory_transactions_branch_time_idx` (not on main) | `lock_timeout 5s` |
| 40 | `migration-2026-11-23-sales-depletion.sql` | dev-only VERIFY | **y**: drops and re-adds `inventory_transactions_transaction_type_check` with `'sale'` (NOT VALID, then VALIDATE: scans the table), covering index `inventory_transactions_item_branch_cover_idx` ("blocks ledger writes while it builds") | never re-run an older file that rebuilds that constraint |
| 41 | `migration-2026-11-23-wastage-allow-negative.sql` | n | **y**: re-creates `log_wastage` without the on-hand refusal | never re-run `migration-2026-10-29-owner-decisions.sql` after it |
| 42 | `migration-2026-11-22-pos-switchover.sql` | y | n (re-creates `pos_ctx`, `pos_print_branch`, `pos_session_branch`) | LAST of the POS chain; see the note below |
| — | `migration-2026-11-23-einvoice-w5-cron.sql` | n | **y**: `create extension if not exists pg_net`; cron job `einvoice-daily` | **Deferred** to when LHDN credentials exist (§5) |

Order basis: each header's "Run … after" line and STOP guards. #39 → #40 → #41 is the sales-depletion spec's
"Prod rollout" step 4. #25/#26 pairing: readiness §4. Readiness §4's short form "menu → catalogs → ordering →
checkout" is not the run order: catalogs STOPs unless checkout-fixes ran first (`pos-catalogs.sql` line 18).

**Note on #42 (decision for the owner).** Readiness §4 orders it after pairing every print agent, the Craft OS
build and a coverage query, because "the server cannot tell whether a staff-login print agent still runs
somewhere" (switchover spec §3). Prod has never had a POS, so no such agent exists, and the coverage query in #42's
header returns no rows while `print_routes` is empty. Running #42 in Stage A means staff email logins can never call
front-of-house RPCs on prod. If the owner prefers the readiness order, hold #42 for Stage B step 5.9.

**Verify scripts.** Readiness §4 says run each `-verify.sql`. Most cannot pass on prod as written: they act as the
dev test owner (`v_owner uuid := '76cbcf9f-…' -- dev test login (owner)`, e.g.
`migration-2026-11-18-pos-reports-verify.sql` line 74); `qr-table-cart-verify` "borrows a real dev table"; the
ordering verify needs the dev seed; the inventory VERIFY files say "DEV ONLY". They also write (then roll back)
into `auth.users`, `staff` and `branches` on the live database. Plan:
- [ ] Do not run the `-verify.sql` files on prod. Run them in the rehearsal (§7 Q4) against a copy.
- [ ] On prod, after each file, run a read-only presence check of what its header lists (functions with
      `to_regprocedure`, tables with `to_regclass`).
- [ ] After #42, compare function bodies with dev, where the same chain passed every verify (read-only, both projects):
      `select p.proname, pg_get_function_identity_arguments(p.oid) args, md5(p.prosrc) from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1, 2;`
      Every POS function must match dev; a mismatch means a file ran out of order (the re-run hazards in the
      headers). Dev-only extras (spike, seed) may differ. This catches the regressions the verifies were for.

### 4c. Never run on prod

- [ ] `seed-2026-10-23-pos-demo-branch.sql` ("Dev-only seed … NEVER run this on prod")
- [ ] `seed-2026-10-24-pos-checkout-demo.sql` ("NEVER run this on prod")
- [ ] `spike-2026-10-22-pos-phase0.sql`, `spike-2026-10-22-pos-phase0-verify.sql`, `spike-2026-10-22-pos-phase0-drop.sql` ("DEV SUPABASE ONLY")
- [ ] `VERIFY-2026-11-22-menu-costing.sql`, `VERIFY-2026-11-23-sales-depletion.sql` ("DEV ONLY")
- [ ] By hand: `update member_settings set dev_codes_allowed = true` (members.sql header "DEV ONLY … never on prod")
- [ ] Secret `MEMBER_AUTH_ALLOW_LOG` (member-auth header "never set on prod")
- [ ] `tools/run-sheet/facts.sql` ("craft-os-dev only")

### 4d. Data scripts that must run on prod (all in Stage B)

| When | Script | Source |
|---|---|---|
| After the prod menu import | `supabase/menu-data-2026-10-25-packaging-fee.sql` | header "on prod after the menu import"; STOP "no Craft Cafe catalog" |
| After the menu import, once the owner confirms Bar = drinks, Kitchen = food | `supabase/menu-data-2026-10-25-print-routes.sql` | header "on prod after the menu import, once the owner confirms the same split" |
| After the menu import and #38 | `menu-recipes-import.sql`, `drink-recipes-import.sql`, `dessert-recipes-import.sql` (git-excluded, `inventory-v2` worktree, name-based) | readiness §4 inventory step 2 (PR head) |
| Right before first service | Baseline **full** stock count per outlet | sales-depletion spec "Prod rollout" step 5 |

### 4e. Edge Functions

`supabase/config.toml` does not exist in the repo; `verify_jwt` is set only by the deploy flag. Deploy from the
PR #19 head (`supabase/functions/_shared/secretKey.ts` is bundled into two of them). `provision-staff` is unchanged.

- [ ] `supabase functions deploy pos-device-activation --project-ref <PROD_REF> --no-verify-jwt`
- [ ] `supabase functions deploy member-auth --project-ref <PROD_REF> --no-verify-jwt`
- [ ] `supabase functions deploy einvoice --project-ref <PROD_REF> --no-verify-jwt`

| Function | Secret | Meaning | Who | Stage |
|---|---|---|---|---|
| all three | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEYS` | platform-injected (`_shared/secretKey.ts`) | none | — |
| pos-device-activation | — | none of its own | — | A |
| member-auth | `MEMBER_AUTH_ORIGINS` | QR site origins allowed to call (the prod Craft OS origin that serves `/t/…`) | Claude | A |
| member-auth | `SMS_PROVIDER` | channel; leave **unset** until G8 (unset → `unavailable`, `logic.ts` `selectProvider`), then `whatsapp` | owner | B+ |
| member-auth | `WHATSAPP_TOKEN` | Meta System User token | owner | B+ |
| member-auth | `WHATSAPP_PHONE_NUMBER_ID` | the WhatsApp number's id | owner | B+ |
| member-auth | `WHATSAPP_TEMPLATE` | `craft_signin_code` | owner | B+ |
| member-auth | `WHATSAPP_TEMPLATE_LANG`, `WHATSAPP_GRAPH_VERSION` | optional; default `en_US`, `v27.0` | owner | B+ |
| einvoice | `MYINVOIS_CLIENT_ID`, `MYINVOIS_CLIENT_SECRET` | LHDN ERP credentials | owner | after G9 |
| einvoice | `EINVOICE_JOB_SECRET` | ≥ 32 characters; the cron's header secret | Claude generates, never echoed | with the cron |
| Vault (SQL) | `einvoice_job_secret` (same value), `einvoice_function_url` = `https://<PROD_REF>.supabase.co/functions/v1/einvoice` | read by the cron file | Claude | with the cron |

Secrets are typed in the owner's own terminal: `supabase secrets set --project-ref <PROD_REF> NAME=…`.
Cron: only `einvoice-daily` (`0 23 * * *` = 07:00 MYT), from the deferred cron file.

### 4f. Supabase settings

- [ ] Storage: bucket `menu-images` is created by #12 and widened by #36. Check: public, 4 MB, GIF allowed.
- [ ] Realtime: publication gains `orders`, `print_jobs`, `bills` (#3, #5). Check
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime';`
- [ ] Realtime Broadcast for `anon` on public channels (QR shared cart ping) was verified on dev only
      (qr-table-cart spec §3). Check prod's Realtime settings allow public channels. If not, the page still reads
      every 15 s.
- [ ] Auth: sessions timebox / inactivity 0 (4a). Device accounts are `device-<uuid>@devices.invalid`.
      Not confirmed in the repo: that prod Auth accepts that address (checked on dev only).

### 4g. Front ends

How prod deploys: merging into `main` triggers the `craft-os` Production build (inventory rollout step 7: "Merge
PR #9 into `main`. Vercel deploys the app"). Older plans say "git push does not deploy"
(`docs/superpowers/plans/2026-07-08-leave-accrual-rework.md` line 22); that predates the Git link. Not confirmed in the
repo: that the Git link is still on today. Check Vercel → craft-os → Settings → Git before merging.

- [ ] **Order:** 4b (#1–#42) and 4e done and checked → env vars → merge → deploy checks.
- [ ] `craft-os` (existing, Production; also Preview, which points at prod data): keep `VITE_SUPABASE_URL`,
      `VITE_SUPABASE_ANON_KEY`, `VITE_CRAFT_API_URL`, `VITE_CRAFT_MARKETING_URL`; **add** `VITE_POS_APP_URL` = the
      prod POS app address (`.env.example`; unset → "Ask HQ for the POS app address."). Build-time vars: set before
      the merge build.
- [ ] `craft-pos` (new prod project; needs the owner's OK, it is a new public URL — pos-app plan line 2855): build
      `npm run build:pos`, output `dist-pos`, env `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` = prod. Keep
      `craft-pos-dev` on dev. Not confirmed in the repo: whether the root `vercel.json` suffices for `dist-pos`
      (the plan says "the same `vercel.json`"; the dev trial added its own SPA rewrite and no-cache headers for
      `sw.js` / `version.json`, outside the repo). Check `version.json`, `sw.js`, `manifest.webmanifest` are served
      as files.
- [ ] The QR page needs no project of its own: `vite.config.ts` builds `qr/index.html`; `vercel.json` rewrites
      `/t/(.*)` to it.
- [ ] Owner clicks **Merge** on PR #19 (Claude cannot merge; draft must be marked ready). Then confirm the build
      is Ready and the live bundle contains a string only this branch has (e.g. "The POS has moved to its own app.").
      A failed `tsc -b` leaves the old version live silently.

### 4h. Smoke test (a manager or the owner signs in; Claude does not sign in as real staff)

Existing staff app:
- [ ] Clock-in screen opens and the geofence check runs; one real clock-in from a staff phone the next morning.
- [ ] Schedule (week view), Leave (apply screen), Claims list, Team Attendance.
- [ ] Procurement: PO list, Stock on Hand, an item's detail; log a small wastage above on-hand (now accepted).
- [ ] Stocktake: open a submitted count → "Since last count" section loads without error.
- [ ] Settings → Branches: edit and save one branch's address (fires `branches_outlet_guard`), then put it back.
- [ ] Settings → System Roles: the three new rows (`Approve POS voids & refunds`, `Edit menu`, `Sign in to the POS`).
- [ ] No red e-invoice banner at the top of pages.

New parts, dark:
- [ ] `/pos` shows the notice with the prod POS link and My PIN; `/pos/reports`, `/pos/members`, `/pos/settings`,
      `/pos/devices`, `/pos/einvoice`, `/menu`, `/procurement/menu-costing` open empty without errors.
- [ ] The POS app URL opens "This device isn't activated" (do not request a code yet).
- [ ] `https://<craft-os prod origin>/t/nonexistent` loads the QR page (not the staff app) and shows an error
      instead of a menu, since no table exists yet.
- [ ] Function logs (Dashboard → Edge Functions) show no boot errors.

## 5. Stage B — Cheras cut-over, step by step

Start only when G1, G2, G4, G6, G7 are met, and G5 if any Cheras route uses the agent.

1. [ ] **Roles (D7).** Settings → System Roles: Manager "All Branches" off (readiness §1 D7). This also narrows
       managers in the **existing** staff app wherever `all_branches` scopes data; agree it with the owner first.
2. [ ] **Outlet.** POS Settings → choose Cheras: receipt header (legal name, registration, SST no., phone, email),
       bill prefix (HQ only), service-charge rules, reason templates, cash rounding 5 sen, SST registered
       (readiness §3). Lock minutes (default 10).
3. [ ] **Menu.** Back office → Menu → Import (`/menu/import`, needs `Edit menu`) with the Feedme export; photo zip.
       Then run `menu-data-2026-10-25-packaging-fee.sql`, then `menu-data-2026-10-25-print-routes.sql` (owner confirms
       the split). Staff Meal: confirm normal prices, then Catalogs → Staff Meal → Discount % = 50 with no Staff Meal
       bill open. Category Type (drink / food) for AI Pick.
4. [ ] **Recipes.** The three recipe import SQLs after the open owner items (G10); Menu Costing shows 0 missing costs.
5. [ ] **Tables and QR codes.** Areas (Ground Floor, Beside Floor, Upstairs, Staff, Grab) and tables; print the QR
       cards from POS Settings (links are built from the Craft OS origin).
6. [ ] **Payment methods** to match Feedme; tick "Opens the cash drawer" on cash.
7. [ ] **Printers and routes.** Printer IP per route (Cheras: Bar and Kitchen on one printer). Route kind `agent`
       needs the print agent; otherwise the printing tablet prints.
8. [ ] **Tablets.** On each tablet open the prod POS URL → Add to Home Screen → launch from the icon → code →
       HQ approves in Craft OS → POS → Devices; mark one as the printing tablet.
9. [ ] **Print agent**: on the outlet computer, `tools/print-agent/.env` with the prod URL, the prod anon key
       and the line `PRINT_AGENT_ALLOW_PROD=1` (G5), then `node --env-file=tools/print-agent/.env tools/print-agent/pair.ts "Cheras bar computer"`,
       approve as kind Print agent, then `node --env-file=tools/print-agent/.env tools/print-agent/agent.ts`
       (`tools/print-agent/README.md`). If #42 was held: run the coverage query from #42's header (every row
       `covered = true`), then #42 and the function comparison from §4b, then step 11.
10. [ ] **Staff.** Every cashier and supervisor sets a PIN (Craft OS → POS → My PIN); supervisors hold
        `pos_supervise`; extra outlets on the staff profile if needed.
11. [ ] **Test print** from POS Settings and one ticket per route; one drawer kick.
12. [ ] **Members setting.** Back office → Members → Settings → switch **Members on QR page** off
        (`member_settings.qr_enabled`, default true) until G8; staff can still add a number at the counter.
13. [ ] **E-invoice.** Leave **Report e-invoices from** (`branches.einvoice_from`) empty for every outlet and
        `einvoice_settings.environment` = `sandbox` (default) until G9; do not install the cron file yet.
14. [ ] **Baseline full stock count** at Cheras, submitted (sales-depletion spec step 5).
15. [ ] **Shift.** Open shift with the float on the counter tablet.
16. [ ] **First service checklist:** one QR order from a phone, one counter takeaway (TA001), one dine-in with a
        takeaway line, one split, one void with a supervisor PIN, one refund; tickets and receipt print; Z report at
        close matches cash. Prod smoke bills: void them rather than pay; a paid bill counts in Reports and deducts stock.

**The C3 moment for staff:** nothing changes in Craft OS at cut-over (they have seen the `/pos` notice since
Stage A). What changes is the counter: cashiers stop ringing on Feedme and sign in on the tablet with name + PIN.

**Fall back to Feedme** (readiness D6, §6): Feedme stays signed in at Cheras for the first week. If the POS cannot
take or print orders: the cashier switches to the Feedme device for new orders; open Craft POS bills are paid or
voided by a supervisor before close; the shift is closed with a count; both systems' sales are added by hand for
that day. Grab orders follow G1's arrangement.

## 6. Rollback

### Front end (instant)
- [ ] Vercel → craft-os → Deployments → the deployment noted in §3 → Instant Rollback / Promote. Not confirmed in the
      repo: whether a later merge re-assigns production automatically after a rollback; check in Vercel before the
      next merge.
- [ ] `craft-pos`: remove the domain or delete the project; tablets then cannot load the POS.
- [ ] The old Craft OS build works against the new database: every change to live tables adds columns with
      defaults, and the old app does not call the new functions. Exception: wastage above on-hand stays allowed
      server-side until `log_wastage` is restored (below).

### Edge Functions
- [ ] `supabase functions delete <name> --project-ref <PROD_REF>`, or unset its secrets (member-auth answers
      `unavailable` with `SMS_PROVIDER` unset).

### Database
Additive objects (new tables, new functions, new policies on new tables) can stay; nothing on `main` calls them.
Objects that are **not** additive, with their inverse:

| Change | Inverse |
|---|---|
| `log_wastage` re-created (#41) | Re-create it from the §3 snapshot (same signature). Do not re-run the whole `owner-decisions` file. |
| `inventory_transactions_transaction_type_check` + `'sale'` (#40) | Only while no `'sale'` row exists: drop it and re-add the 8-type check from `migration-2026-11-22-stocktake.sql` lines 17–23. Drop trigger `bills_deplete_on_paid`. Once sales exist: restore from backup only. |
| Indexes on `inventory_transactions` (#39, #40) | `drop index if exists inventory_transactions_sale_waste_idx, inventory_transactions_item_branch_cover_idx;` |
| `branches` columns, checks, `branches_bill_prefix_key` (#5, #20, #33) | Leave in place (old app ignores them). Removing columns: restore from backup only. |
| Triggers `branches_outlet_guard`, `branches_einvoice_from_guard` | `drop trigger … on branches;` if Settings → Branches misbehaves |
| Bucket `menu-images` + 4 `storage.objects` policies (#12, #36) | Drop the `menu_images_*` policies; delete the bucket once empty |
| Publication adds `orders`, `print_jobs`, `bills` | `alter publication supabase_realtime drop table …;` |
| Extensions `pgcrypto`, `pg_net` | Leave; other things may use them |
| Cron `einvoice-daily` | `select cron.unschedule('einvoice-daily');` |
| Re-created functions inside the chain (#22, #25/#26, #30, #31, #37, #42) | Not reversible by re-running older files (each header lists the regressions). Roll forward or restore from backup. |

- **C3 (#42):** the only inverse is re-running `migration-2026-10-29-pos-device-till.sql` (switchover header), which
  also puts back older bodies of functions that #24–#31 re-created. On prod there is nothing to roll back to. Do not.
- **Point of no easy return:** the first real paid bill. From then on bills, payments, member points, stock `sale`
  rows and any e-invoice link exist; a database restore would also erase that day's attendance and other staff app
  data. After that point: roll forward, and use Feedme operationally.

**Decision rule:** if the existing staff app breaks right after the merge and the database checks in 4b passed,
roll back the front end only. If it breaks in a way traced to a database change on a live object, apply that
row's inverse above. Restore the database from backup only if both fail, no real bill exists yet, and the
outlets are closed.

## 7. Unknowns and risks (resolve before the day)

1. Q1 PITR / backup: does the prod plan have PITR today, and when was the last daily backup? (§3)
2. Q2 Vercel wiring: is `craft-os` still Git-linked to `main` and auto-deploying on merge? Does Preview still use
   prod env (then PR #19 previews already write to prod)?
3. Q3 Transactions: does the chosen SQL route (Management API or SQL editor) run a multi-statement file as one
   transaction? The inventory files rely on `set local lock_timeout`, which needs one.
4. Q4 Rehearsal: replay #1–#42 plus the verifies on a fresh copy (scratch Postgres with the prod schema, or a
   Supabase branch) with the dev owner id swapped for a fixture. Not confirmed in the repo which is possible.
5. Q5 Print agent on prod: allowed with `PRINT_AGENT_ALLOW_PROD=1` in the outlet computer's `.env`
   (`tools/print-agent/README.md`), but it has never been run against prod. Is Cheras's printer reachable
   without the agent (the printing tablet) if the agent gives trouble on the day?
6. Q6 Prod Realtime: are public Broadcast channels allowed for `anon`?
7. Q7 Prod Auth: sessions timebox / inactivity 0; device emails `@devices.invalid` accepted.
8. Q8 Extensions: `pgcrypto` in `extensions`, `pg_cron` on, `pg_net` installable, Vault present.
9. Q9 Readiness §4 says "each with its `-verify.sql`" — confirm the owner accepts presence checks instead (§4b).
10. Q10 Prod POS app address: the name of the `craft-pos` project and its URL (needed for `VITE_POS_APP_URL`).
11. Q11 D7 side effects on the existing app: what managers lose when "All Branches" is switched off.
12. Q12 E-invoice before production: environment-scoped links and start-date guard, link-release recovery, the
    `needs_check` backfill guard, a second consolidated invoice (readiness W5) — and v1.1 signing.
13. Q13 Grab: which branch and when; G1 stays the cut-over gate.
14. Q14 Access tokens pasted in chat earlier are still to be revoked (readiness §4 last item).
