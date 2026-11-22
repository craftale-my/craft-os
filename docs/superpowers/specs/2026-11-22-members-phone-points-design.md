# Members: phone sign-in and points — design

Date: 2026-11-22 · Status: approved by the owner in conversation, awaiting review of this text
Builds on: QR shared table cart (guests, `qr_cart_send`), POS checkout (`pos_pay_and_close`, refunds).

## 1. Goal

A guest signs in on the QR page with their phone number, confirmed once by an SMS code, and from then
on collects points for what their table pays. Staff can also put a member on a bill at the counter.
The guest sees their points on the QR page.

**This version:** join / sign in, earn, see the balance, staff attach at the counter, a member list for
the owner. **Not in this version** (each its own later spec): redeeming points, tiers, vouchers, birthday
rewards, importing Feedme's members, marketing messages, a member page outside the QR page.

## 2. Owner decisions (2026-11-22)

- Sign-in is by phone number **with an SMS code**.
- Earn only in this version; redeeming comes later (it has to work with the discount rules).
- Earn rate: **1 point per RM 1 paid** (my proposal, accepted with the design).

## 3. What people see

### Guest (QR page)

- In the top strip, beside the guest chip: `Join & earn points` (not signed in) or `★ 120 pts` (signed in).
- Tap → a sheet:
  1. `Collect points with your phone number` — a field with `+60` fixed in front, numeric keypad;
     button `Send code`. Under it: `We text you a 6-digit code. We only use your number for your points.`
  2. `Enter the code we sent to +60 12-345 6789` — six boxes (`autocomplete="one-time-code"`), `Confirm`;
     `Send again` becomes available after 60 s; `Change number`.
  3. Signed in: `You're in! Points from this table's bill go to +60 ••• ••6789.` and the balance.
- Signed in, the sheet shows: the masked number, `120 points`, the last five entries
  (`22 Nov · Craft Cafe Cheras · +42`), `How points work: 1 point for every RM 1 you pay.` and `Sign out`.
- The phone stays signed in on this device for 180 days (a token in `localStorage`, usable at any table
  of ours).
- **Which bill earns:** when a signed-in guest's phone sends the table's order, or opens the page at a
  table that already has an open bill, the bill is linked to that member if it has none yet. One member per
  bill — the first to be linked. A later guest who signs in at a table whose bill already has a member
  sees `This table's points are going to +60 ••• ••1234.` The counter can change it.
- Points arrive when the bill is paid at the counter; the page then shows the new balance on its next read.

### Staff (POS)

- Bill actions: `Member` → enter a phone number → `Attach`. No code — staff are trusted, and the action
  is logged with the staff id. A number not yet a member is created on the spot (`New member`).
  `Remove member` takes it off an open bill.
- The bill column shows `Member ••6789` under the bill number; the receipt prints
  `Member ••6789   Points earned 42`.
- Splitting: each part bill carries the member of its parent; points follow what each part pays.

### Owner (back office)

- `Members` page: search by number; list with joined date, balance, last visit; a member's ledger;
  `Adjust points` (± with a required reason) for the owner role only.
- Settings: earn rate (points per RM 1, default 1), on/off switch `Members on QR page`.

## 4. Rules

- **Earning:** `floor(net paid in RM × rate)`, where net paid = the bill's total actually paid (after
  discounts, including service charge and tax, after rounding), computed when the bill closes as paid.
  Voided bills earn nothing. A refund writes a negative entry for `floor(refunded RM × rate)`, never
  taking that bill's earned points below zero.
- **Ledger, not a counter:** `member_points` rows (`earn`, `refund`, `adjust`), each with the bill or the
  reason; the balance is their sum (kept in `members.points` by the same transaction for fast reads).
  One `earn` row per bill (unique), so a retried close cannot pay twice.
- **Phone numbers:** stored in E.164 (`+60123456789`). Malaysian mobile numbers only in this version
  (`+60 1x`, 9–10 digits after `+60`); the leading `0` a guest types is dropped. Shown masked
  (`+60 ••• ••6789`) everywhere on the guest side and on receipts; staff and owner see it in full.
- **Staff Meal:** a bill with any live item ordered from a discounted catalog (`menu_catalogs.discount_bp > 0`,
  i.e. Staff Meal) earns nothing.

## 5. Sign-in and security

Members are **not** Supabase Auth users: every existing policy treats `authenticated` as staff, and a
guest must never hold such a session. Members get their own small token scheme, all behind
`security definer` functions callable by `anon`.

- **Request a code** — Edge Function `member-auth` (`POST /request`): validates the number, rate-limits,
  creates a 6-digit code (stored hashed, expires in 5 minutes, 5 attempts), asks the SMS provider to send
  `Craft Cafe: your code is 123456. It expires in 5 minutes.`
- **Confirm** — `POST /verify`: checks the code; creates the member if new; returns a member token
  (32 random bytes; only its SHA-256 is stored, with device label and expiry 180 days).
- **Using it** — the QR page passes the token to `member_me(p_token)` (balance and last entries) and to
  `member_link_table` so the server can link the bill. `member_sign_out(p_token)`.
- **Limits:** per number 3 codes per 15 minutes and 10 per day; per IP 10 requests per hour; a global
  daily cap on SMS sent (default 300, a setting) that turns sign-in off with
  `Sign-in is busy right now. Please ask our staff to add your number.` — protects the SMS bill.
- **No enumeration:** `/request` answers the same for a member and a non-member.
- **SMS provider:** behind one small interface (`sendSms(to, text)`) in the function, chosen by the
  secret `SMS_PROVIDER`. Adapters in this version: `log` (dev: no SMS; the code is written to the
  `member_otps.dev_code` column, readable only by SQL — used for testing on dev) and one real provider.
  **The owner chooses and signs up for the provider**; until its secrets are set on a project the
  function runs in `log` mode on dev and answers `Sign-in is not available yet.` on prod.
- **Privacy (PDPA):** the join sheet links a short notice (what we store: number, points, visits; why;
  how to ask for deletion). `member_delete` (owner) removes the number and keeps anonymous ledger rows.

## 6. Server

`supabase/migration-2026-11-23-members.sql` (+ `-verify.sql`), dev first (built 2026-11-23; the function
signatures and return shapes are listed in `.superpowers/sdd/task-15-report.md`):

- Tables: `members` (id, phone unique among non-deleted, points ≥ 0, joined_at, last_visit_at, deleted_at),
  `member_points` (member_id, kind, points, bill_id, refund_id, rate, reason, staff_id, created_at; unique
  earn per bill, unique row per refund; an earn row keeps the rate it used and a refund of that bill reuses it),
  `member_otps` (phone, code_hash, expires_at, attempts, ip, created_at, used_at, dev_code),
  `member_tokens` (member_id, token_hash, device, expires_at, last_used_at),
  `member_settings` (single row: rate, qr_enabled, sms_daily_cap),
  `member_bill_events` (who attached / removed / linked a member on a bill: staff and device ids).
  RLS on all; no policy for `anon` or `authenticated`; all access through functions.
- `bills.member_id uuid references members`.
- Functions: `member_public_settings`, `member_me`, `member_sign_out`, `member_link_table` (anon);
  `pos_bill_set_member(p_bill_id, p_phone)` / `pos_bill_clear_member` (a till's staff session, own outlet,
  open bill); `member_search`, `member_ledger`, `member_settings_get` (back office: `access_settings`);
  `member_adjust`, `member_delete`, `member_settings_set` (owner); `member_otp_request`, `member_otp_verify`
  (service role, for the Edge Function).
- Staff Meal is read from each item's own record of its catalog's discount (`order_items.catalog_discount_bp`,
  written when the item is ordered), not from the catalog as it is now.
- A refund never takes the bill's net points nor the member's balance below zero.
- **Points are written by triggers, not by editing the checkout functions** (they are large, and other
  work re-creates them): `after update of status on bills` — a bill that becomes `paid` with a member gets
  its one `earn` row; `after insert on refunds` — the negative row; a bill that becomes `merged` hands its
  member to the bill it merged into when that one has none. A split-off part bill is created with its
  parent's member by a `before insert on bills` trigger when the insert names a parent (follow how the
  split migration links a part to its parent).
- **Linking from the QR page is its own call**, `member_link_table(p_table_token, p_member_token)` (anon):
  links the table's open bill to the member when the bill has none and returns the masked number the
  bill's points go to. The page calls it after a successful send and when a signed-in guest opens a table
  that has an open bill. `qr_cart_send` and `qr_table_state` are not changed.
- Edge Function `member-auth` (service role inside; never returns the code).
- Verify script: award once per bill, refund floors at zero, staff-meal bill earns nothing, token of a
  deleted member refused, anon cannot read any member table; `rollback; select 'VERIFY OK'`.

## 7. Client

- QR: `src/qr/member/` — `memberApi.ts`, `useMember.ts` (token in `localStorage`, balance),
  `MemberSheet.tsx` (the three steps + signed-in view), `phone.ts` (pure: normalise, validate, mask; tests);
  the top-strip button; `QrApp` calls `member_link_table` after a send and on entry.
- POS: `Member` bill action + small dialog; bill column line; receipt lines in `ticket.ts`.
- Back office: `Members` page and the two settings.

## 8. Failure cases

| Case | What happens |
|---|---|
| SMS does not arrive | `Send again` after 60 s; after the per-number limit: `Too many tries. Please ask our staff to add your number.` |
| Wrong code 5 times | The code is dead; `Send again`. |
| Token expired / member deleted | The page quietly returns to `Join & earn points`. |
| Bill paid while the guest was not linked | No points; staff can attach the member before paying. After payment: owner `Adjust points`. |
| Two members at one table | First linked wins; the second sees whose number the points go to. |
| Bill moved or merged | The surviving bill keeps its own member; if it has none it takes the moved bill's. |
| Front end before SQL | The member button is hidden when `member_me`/settings are missing or `qr_enabled` is off. |

## 9. Testing

Unit: `phone.ts`; sheet steps; POS dialog. SQL verify as §6. Edge function: limits and no-enumeration,
in `log` mode. Dev browser walk: join with a dev code, order, staff pays, balance rises; refund lowers
it; staff attach at the counter; second guest sees the notice.

## 10. Rollout and what waits for the owner

SQL → Edge Function (+ secrets) → back office → POS → QR. Dev can run end to end in `log` mode now.
**Prod needs the owner's SMS provider account** (sender name registration in Malaysia can take days).

## 11. Build order

1. SQL: tables, ledger, triggers, RPCs, verify. 2. Edge Function with the `log` adapter. 3. QR sheet, token,
link. 4. POS attach, bill column, receipt. 5. Back office page + settings. 6. Real SMS adapter once the
provider is chosen. Plan: `docs/superpowers/plans/2026-11-23-members-phone-points.md`.
