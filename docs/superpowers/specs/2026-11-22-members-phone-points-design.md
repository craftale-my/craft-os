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

- In the top strip, beside the guest chip: `Join & earn points` (not signed in) or `★ 120 pts` (signed in;
  `★ …` while a stored sign-in waits for its balance on a weak connection).
- Tap → a sheet (a modal dialog: labelled by its title, `✕` and Escape close it, focus moves in and goes
  back to the strip button):
  1. `Collect points with your phone number` — a field with `+60` fixed in front, numeric keypad;
     button `Send code`. Under it: `We text you a 6-digit code. We only use your number for your points.`
  2. `Enter the code we sent to +60 12-345 6789` — six boxes (`autocomplete="one-time-code"`), `Confirm`;
     `Send again` becomes available after 60 s; `Change number`. A pasted `123 456` or a whole SMS works: the
     first six digits are the code. After a refused code the input has focus again.
  3. `You're in!`, the balance (`0 points`), and `Order from this table and your points are added when the
     bill is paid.`
- The number field takes what people paste from contacts: full-width digits, Unicode spaces and dashes.
- Signed in, the sheet shows (`Loading your points…` until the balance is back): the masked number, `120 points`, the last five entries
  (`22 Nov · Craft Cafe Cheras · +42`), `How points work: 1 point for every RM 1 you pay.` and `Sign out`.
- The phone stays signed in on this device for 180 days (a token in `localStorage`, usable at any table
  of ours). A balance read with no reply is tried again after 1 s, 3 s and 8 s; only the server saying
  the token is unknown signs the phone out. A sign-in or sign-out in another tab is picked up.
- **Which bill earns:** when a signed-in guest's phone sends the table's order, or opens the page at a
  table whose open bill already has an order from that guest, the bill is linked to that member if it has
  none yet. One member per
  bill — the first to be linked. A later guest who signs in at a table whose bill already has a member
  sees `This table's points are going to +60 ••• ••1234.` The counter can change it.
- Points arrive when the bill is paid at the counter; the page then shows the new balance on its next read.

### Staff (POS)

- Bill actions: `Member` (on any open bill, right after `Clear QR cart`) → enter a phone number → `Attach`.
  No code — staff are trusted, and the action is logged with the staff id. A number not yet a member is
  created on the spot (`New member`). A bill that has a member opens on it (`Member +60 12-345 6789 · 120
  points`) with `Change` and `Remove member`; `Remove member` takes it off an open bill. Off while offline.
  Until the bill's member is read the dialog says `Loading…`, or `Couldn't read the member.` with `Retry`;
  the attach form is never shown over an unknown state. The member is kept per bill: a bill switch never
  shows the previous bill's member.
- Payment screen: a `Member` row above the payment methods while the bill is open — `Member` + `Add` (the
  same dialog) or `Member ••6789` + `Change` — so a takeaway (or any `Send & pay`) gets its member before
  Pay. Off while offline, as the action is. A part payment (split by item) shows the member read only.
- The bill column shows `Member ••6789` under the bill number (only once that bill's read is done); the
  receipt of a paid bill that still holds at least 1 point prints `Member` and `Points earned 42` after the
  totals (the printer is ASCII-only, so the number prints as `**6789`). The number is the bill's net points
  (earn plus its refunds): a reprint after a partial refund shows the lower number, after a full refund
  no member lines. Part receipts and receipts printed before payment have none.
- Splitting: each part bill carries the member of its parent; points follow what each part pays.

### Owner (back office)

- `Members` page (POS → Members, `/pos/members`, `access_settings`): search by number (digits, debounced);
  list with the full number, joined date, balance, last visit, 50 a page; a row opens a side panel with the
  member's ledger (date, outlet, kind, points, bill no. / reason, staff). For the owner role only:
  `Adjust points` (± with a required reason, confirmed), `Delete member` (`Delete this member? Their number
  is removed; past bills keep their totals.`), an `Earn problems` list at the bottom when there are any
  (`Use Adjust points to credit these by hand.`; each row has `Mark done`, confirmed with `Mark this as
  handled?`, after which it leaves the list), and the settings. Search drops a leading `60` / `0` only from
  a full number (at least 9 digits, then `1`); a fragment such as `6078` is searched as typed. A page that
  comes back empty steps back one page; the reason of an adjust is at most 200 characters.
- Settings (owner): `Points per RM 1` (0–100, default 1), switch `Members on QR page`, `SMS codes per day`
  (the daily SMS cap, default 300).

## 4. Rules

- **Earning:** `floor(net paid in RM × rate)`, where net paid = the bill's total actually paid (after
  discounts, including service charge and tax, after rounding), computed when the bill closes as paid.
  Voided bills earn nothing. A refund writes a negative entry that brings the bill down to
  `floor((total − all refunds so far) in RM × rate)` (running total, see §6), never taking that bill's
  earned points or the member's balance below zero.
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

- **Every call to `member-auth`** must come from an allowed QR origin (secret `MEMBER_AUTH_ORIGINS`,
  comma-separated; else 403; CORS answers echo that origin, never `*`), be a POST with
  `Content-Type: application/json` (else 415; a cross-site form cannot send it without a preflight) and a
  body of at most 2 KB (else 413).
- **Request a code** — Edge Function `member-auth` (`POST {action: 'request', phone, table}`, `table` = the
  QR table token): validates the number, checks the table (it must exist, be active and not QR-paused, else
  `Sign-in is not available yet.`), rate-limits, creates a 6-digit code (stored hashed with its table,
  expires in 5 minutes, 5 tries per IP), asks the SMS provider to send
  `Craft Cafe: your code is 123456. It expires in 5 minutes.`
- **Confirm** — `POST {action: 'verify', phone, code}`: checks the code; creates the member if new; returns a member token
  (32 random bytes; only its SHA-256 is stored, with device label and expiry 180 days). More than 20
  wrong codes from one IP in an hour answer `locked` without touching any guest's code, and the 5 tries
  of a code are counted per IP, so wrong tries from elsewhere cannot lock a guest out.
- **Using it** — the QR page passes the token to `member_me(p_token)` (balance and last entries) and to
  `member_link_table` so the server can link the bill. `member_sign_out(p_token)`.
- **Limits:** per number 3 codes per 15 minutes and 10 per day; per IP 30 codes per hour and 100 per
  24 hours (a whole café shares one Wi-Fi address); per table 20 codes per 24 hours (`Sign-in is busy
  right now. Please ask our staff to add your number.`); a global daily cap on SMS sent (default 300, a
  setting) that turns sign-in off with the same `busy` copy — protects the SMS bill.
  The IP is `cf-connecting-ip` only (set by the platform, refused from a client), an IPv6 address cut to
  its /64; never `X-Forwarded-For` or `sb-forwarded-for`. Without it the function answers
  `Sign-in is not available yet.`; `member_otp_request` and `member_otp_verify` refuse a call without an IP.
- **Only the newest code counts:** asking for a new code makes an older one fail even inside its 5 minutes.
- **No enumeration:** `request` answers the same for a member and a non-member (byte for byte).
- **SMS provider:** behind one small interface (`sendSms(to, text)`) in the function, chosen by the
  secret `SMS_PROVIDER`. Adapters in this version: `log` (dev: no SMS; the code is written to the
  `member_otps.dev_code` column, readable only by SQL — used for testing on dev) and one real provider.
  **The owner chooses and signs up for the provider**; until its secrets are set on a project the
  function runs in `log` mode on dev and answers `Sign-in is not available yet.` on prod.
  Plain dev codes are stored only where `member_settings.dev_codes_allowed` is on (default off; set by
  hand on dev, never in a migration, never on prod); with it off `member_otp_request` refuses any dev code.
  A successful sign-in clears every dev code of that number.
- **Privacy (PDPA):** the join sheet links a short notice: `We keep your phone number, your points and the
  visits they came from, the type of device you sign in on, and — for two days — the network address used
  to ask for a code. We use them only to run your points.` / `To delete your details, ask our staff.` (Codes
  and wrong-code records, with their IPs, are deleted after two days.) `member_delete` (owner) removes the number and keeps anonymous ledger rows.

## 6. Server

`supabase/migration-2026-11-23-members.sql` (+ `-verify.sql`), dev first (built 2026-11-23; the function
signatures and return shapes are listed in `.superpowers/sdd/task-15-report.md`):

- Tables: `members` (id, phone unique among non-deleted, points ≥ 0, joined_at, last_visit_at, deleted_at),
  `member_points` (member_id, kind, points, bill_id, refund_id, rate, reason, staff_id, created_at; unique
  earn per bill, unique row per refund; an earn row keeps the rate it used and a refund of that bill reuses it),
  `member_otps` (phone, code_hash, expires_at, attempts, ip, table_id, created_at, used_at, dev_code),
  `member_verify_fails` (ip, otp_id, at: one row per wrong code, for the per-IP limits; two days),
  `member_tokens` (member_id, token_hash, device, expires_at, last_used_at),
  `member_settings` (single row: rate, qr_enabled, sms_daily_cap, dev_codes_allowed),
  `member_bill_events` (who attached / removed / linked a member on a bill: staff and device ids),
  `member_earn_failures` (bill_id, error, at: an earn the trigger could not write; resolved_at, resolved_by
  once the owner marks it done).
  RLS on all; no policy for `anon` or `authenticated`; all access through functions.
- `bills.member_id uuid references members` (the key added `not valid`, then validated); index
  `member_points(bill_id)`.
- Phone numbers: separators dropped, then a leading `+60` / `60` / `0060`, then one leading `0`; the rest
  must be `1` + `1` + 8 digits (011) or `1` + `[02-9]` + 7 digits. `+60 012-345 6789` and `0060123456789`
  are accepted, `01234567890` is refused. The TypeScript rule (`src/shared/lib/memberPhone.ts` and the
  Edge Function's copy, both tested against `memberPhoneCases.ts`) also applies NFKC and drops Unicode
  spaces, dashes and invisible marks first; it sends SQL only the E.164 result.
- Functions (every one `security definer` with its own `search_path`): `member_public_settings`,
  `member_me`, `member_sign_out`, `member_link_table` (anon);
  `pos_bill_set_member(p_bill_id, p_phone)` / `pos_bill_clear_member` (a till's staff session, own outlet,
  open bill); `member_search`, `member_ledger`, `member_settings_get` (back office: `access_settings`);
  `member_adjust`, `member_delete`, `member_settings_set`, `member_earn_failures_list` (open rows only),
  `member_earn_failure_resolve(p_id)` (an owner who is
  also active: `is_active` and `status = 'active'`); `member_otp_request(phone, ip, code_hash, dev_code,
  table_token)` → `ok | disabled | rate_number | rate_ip | rate_table | cap`,
  `member_otp_verify(phone, code_hash, token_hash, device, ip)` → `ok | wrong | expired | locked`,
  `member_otp_void` (the SMS never left: the code is made unusable) (service role, for the Edge Function).
- Staff Meal is read from each item's own record of its catalog's discount (`order_items.catalog_discount_bp`,
  written when the item is ordered), not from the catalog as it is now.
- **Refunds by running total:** the bill should still hold `floor((total − all its refunds so far) in RM ×
  the earn's rate)`, at least 0; a refund takes what the bill holds above that, capped by the member's
  balance. Ten RM 0.99 refunds and one of RM 0.60 on a RM 10.50 bill end at 0.
- **Points are written by triggers, not by editing the checkout functions** (they are large, and other
  work re-creates them): `after update of status on bills` — a bill that **becomes** `paid` with a member
  gets its one `earn` row (only on the transition, or when the total was still null: a split part is
  inserted paid without a total and closed afterwards); `after insert on refunds` — the negative row; a
  bill that becomes `merged` hands its member to the bill it merged into when that one has none. A
  split-off part bill is created with its parent's member by a `before insert on bills` trigger.
- **The earn never fails a payment:** an error in the earn trigger's writes is rolled back to its own
  block, written to `member_earn_failures`, raised as a WARNING, and the bill closes without its points
  (the owner adjusts by hand). The refund trigger stays strict.
- `member_delete` locks the member's open bills first (by id), then the member — the order checkout uses.
- **Linking from the QR page is its own call**, `member_link_table(p_table_token, p_guest_id,
  p_member_token)` (anon): links the table's open bill to the member when the bill has none, **only for a
  guest who has ordered on that bill** (an `order_items` row of the bill carries the guest id; a cart line
  is not enough). A QR-paused table is refused as `qr_cart_table` refuses it. Another member's masked
  number is shown only to a guest who passes the same check. The page calls it after a successful send
  and when a signed-in guest opens a table where they have ordered. `qr_cart_send` and `qr_table_state`
  are not changed.
- Edge Function `member-auth` (service role inside; never returns the code). The handler is
  `handler.ts` (`handle(req, deps)`, tested with a fake rpc); `index.ts` wires the real client.
- Counter (`migration-2026-11-23-members-pos.sql`, built 2026-11-23): `pos_bill_member(p_bill_id)` →
  `{memberId, phone, phoneMasked, points, earned} | null` (a till's staff session, the bill at its outlet, any
  status) for the bill column and the dialog; and a `before insert` trigger on `print_jobs` that adds
  `member: {last4, pointsEarned}` to a paid bill's customer receipt (reprints too; the member is the earn
  row's, `pointsEarned` the bill's net points, nothing when ≤ 0), so `pos_receipt_payload` is not re-created. The trigger never stops a print job (an error leaves the payload as it was).
- Verify script: award once per bill and only on the transition, voided bill earns nothing, refunds by
  running total, a failed earn still closes the bill, staff-meal bill earns nothing, token of a deleted
  member refused, every member function security definer with a search_path, the guest RPCs run as the
  real `anon` role and staff RPCs as `authenticated`, neither can touch a member table or call the
  service-only and helper functions; a final block raises unless every section ran, then
  `rollback; select 'VERIFY OK'`.

## 7. Client

- QR: `src/qr/member/` — `memberApi.ts`, `useMember.ts` (token in `localStorage`, balance),
  `MemberSheet.tsx` (the three steps + signed-in view);
  the top-strip button; `QrApp` calls `member_link_table` after a send and on entry.
- POS: `Member` bill action + small dialog (`MemberDialog.tsx`, `billMember.ts`, per-bill state in
  `useBillMember.ts`); the Payment screen's `Member` row (`PaymentScreen.tsx`); bill column line; receipt
  lines in `receipt.ts` (`memberLines`). The phone rule lives in `src/shared/lib/memberPhone.ts` for the QR
  page, the till and the back office.
- Back office: `Members` page and the two settings.

## 8. Failure cases

| Case | What happens |
|---|---|
| SMS does not arrive | `Send again` after 60 s; after the per-number limit: `Too many tries. Please ask our staff to add your number.` |
| Wrong code 5 times | The code is dead for that IP; `Send again`. |
| More than 20 wrong codes from one IP in an hour | `Too many wrong tries. Send a new code.` for that IP; no guest's code is touched. |
| Too many codes from one table in a day (20) | `Sign-in is busy right now. Please ask our staff to add your number.` |
| A request from another site (no or a foreign `Origin`), not JSON, or over 2 KB | Refused (403 / 415 / 413) before any database call. |
| Weak connection after sign-in | `★ …` and `Loading your points…`; the read is tried again after 1 s, 3 s and 8 s. |
| Token expired / member deleted | The page quietly returns to `Join & earn points`. |
| Bill paid while the guest was not linked | No points; staff can attach the member before paying. After payment: owner `Adjust points`. |
| Two members at one table | First linked wins; the second sees whose number the points go to (once they have ordered on the bill). |
| Guest signed in but has not ordered on the bill | Nothing is linked and no number is shown; the link happens after their first send. |
| Table paused for QR ordering | Nothing is linked (`{linked: false}`). |
| Earn could not be written when the bill closed | The payment still closes; the failure is listed for the owner (`member_earn_failures_list`), who adjusts by hand, then marks it done. |
| Many small refunds | Counted by running total: they take what one refund of the same sum would. |
| Equal / by-amount part payments | Accepted for this version: the bill's one member earns on the whole total, whoever paid each part. |
| No platform client IP on a code request or a verify | `Sign-in is not available yet.` (the SQL refuses a call without an IP). |
| Bill moved or merged | The surviving bill keeps its own member; if it has none it takes the moved bill's. |
| Front end before SQL | The member button is hidden when `member_me`/settings are missing or `qr_enabled` is off. |

## 9. Testing

Unit: the shared phone cases (`memberPhoneCases.ts`, run by both copies of the rule); sheet steps and
dialog semantics; POS dialog; the function's handler with a fake rpc. SQL verify as §6. Edge function: limits and no-enumeration,
in `log` mode. Dev browser walk: join with a dev code, order, staff pays, balance rises; refund lowers
it; staff attach at the counter; second guest sees the notice.

## 10. Rollout and what waits for the owner

SQL → Edge Function (+ secrets) → back office → POS → QR. Dev can run end to end in `log` mode now.
**Prod needs the owner's SMS provider account** (sender name registration in Malaysia can take days).

## 11. Build order

1. SQL: tables, ledger, triggers, RPCs, verify. 2. Edge Function with the `log` adapter. 3. QR sheet, token,
link. 4. POS attach, bill column, receipt. 5. Back office page + settings. 6. Real SMS adapter once the
provider is chosen. Plan: `docs/superpowers/plans/2026-11-23-members-phone-points.md`.
