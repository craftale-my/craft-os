# GrabFood integration — skeleton design (2026-11-01)

Owner decision 2026-10-29: Grab orders must reach our POS through Grab's API before Feedme is
switched off. This is the skeleton: Grab can authenticate, pull a menu and push orders and
states, and everything is stored and logged. Grab orders do **not** become POS bills yet.

Source for every field name: Grab's own OpenAPI spec, `api/openapi.yaml` in
`github.com/grab/grabfood-api-sdk-java` (GrabFood API 1.1.3). developer.grab.com itself needs a
login, so the webhook URLs, auth and response codes below still need checking there.

## Pieces

| Piece | File |
|---|---|
| Tables + menu query | `supabase/migration-2026-11-01-pos-grab.sql` (+ `-verify.sql`) |
| Edge Function | `supabase/functions/grab/` (`index.ts`, `logic.ts` pure + tests, `grabApi.ts` outbound) |

- `grab_stores`: outlet ↔ Grab merchant ID, which catalog is the Grab menu, auto-accept flag,
  last integration / menu sync status. Our `partnerMerchantID` is `branch_id`.
- `grab_orders`: one row per Grab `orderID` (Grab retries), with the full payload, state,
  item ids that are not on the store's Grab menu, and a `bill_id` for the next step.
- `grab_events`: every call in and out, with body and status. Secrets and tokens are never stored.
- `grab_menu_source(merchant_id)`: service role only. Mirrors `qr_menu`: the catalog's own
  prices, `availability = 'all'` only, add-ons left out, outlet sold-out marks.

## Routes (`https://<ref>.supabase.co/functions/v1/grab/…`)

| Route | Grab spec name | Notes |
|---|---|---|
| `POST /oauth/token` | Get partner access token webhook | client credentials (JSON or form) → 7-day HMAC token, nothing stored |
| `GET /menu?merchantID=` | Get food menu webhook | `GetMenuNewResponse` |
| `POST /orders` | Submit order webhook | stored idempotently → 204 |
| `PUT /order/state` | Push order state webhook | updates `grab_orders.state` → 204 |
| `POST /menu/sync-state` | Menu sync state webhook | `grab_stores.last_menu_*` → 204 |
| `POST /integration-status` | Push integration status webhook | `grab_stores.integration_status` → 204 |
| `POST /admin` | — | staff JWT + `access_settings`: `status`, `preview_menu`, `notify_menu`, `accept_order`, `mark_ready`, `pause_store` |

`status` returns the exact URLs to type into the Grab portal.

## Menu mapping

- Grab has no variants, so **each priced variant is its own Grab item** (`id` = variant id),
  named "Product (Variant)", or just the product name when it has one variant. A Submit order's
  `items[].id` is then the variant id directly.
- Modifier groups/options keep their ids; ranges are clamped to the options offered; sold-out
  add-ons are `UNAVAILABLE`; empty groups are dropped.
- One all-day selling time. Grab limits (100 categories, 300 items per category, 30 groups,
  100 modifiers) produce warnings, never silent cuts.
- Prices go out exactly as the Grab catalog has them (sen = Grab minor units, MYR exponent 2).

## Secrets

| Secret | Who makes it |
|---|---|
| `GRAB_PARTNER_CLIENT_ID`, `GRAB_PARTNER_CLIENT_SECRET` | us; typed into the Grab portal so Grab can call us |
| `GRAB_CLIENT_ID`, `GRAB_CLIENT_SECRET` | Grab, from the portal; for our calls to Grab |
| `GRAB_ENV` | `sandbox` (default) or `production` |

Deploy: `supabase functions deploy grab --project-ref <ref> --use-api --no-verify-jwt`.

## To confirm in the Grab portal (unverified)

1. Whether Grab accepts an in-house POS as a partner at all (fallback: Deliverect-type middleware).
2. The exact webhook URL shape and method Grab uses per webhook (we accept PUT or POST where unsure).
3. Expected success codes (we answer 204 to webhooks).
4. Whether Malaysian menu prices are sent with or without SST, and how SST appears in orders
   (`items[].tax`, `price.tax`).
5. The accept deadline for `MANUAL` orders.

## Next steps

1. Apply the SQL and deploy to craft-os-dev (needs a working Supabase access token), then smoke
   test every route with curl using test credentials.
2. Map stores: one `grab_stores` row per outlet and a Grab catalog (owner's prices).
3. Grab order → POS bill: `orders.source` gains `grab`, channel order numbers (Feedme used
   GF01–GF99), a "Grab" payment method, print routing, and an accept / ready button on the POS
   (replacing auto-accept).
4. Menu photos: `menu-images` is staff-only; Grab needs public image URLs.
5. Time slots → `sellingTimes`; sold-out changes → `notify_menu` (or Update menu record).
6. Reports and e-invoice: Grab sales are paid out by Grab; reconcile with Grab's statements.
