# POS Sub-plan 4a — Shifts, Pay in / Pay out and the Z report

Date: 2026-10-24 · Branch: `feature/pos-demo` · Builds on Sub-plans 1–3 and menu catalogs M1–M3.

## Scope

**In:** one shift per branch per day (open with a float, blind cash count at close), Pay in / Pay out, a
frozen Z report per shift (printed at close, reprintable), a list of past shifts.

**Out (Sub-plan 4b or later):** monthly e-Invoice export (waits for the MyInvois batch-upload template
from the owner or the accountant), X report (mid-shift figures), denomination counting, cash drawer kick,
several drawers per branch, reporting hours.

## Owner decisions (2026-10-24)

1. **One shift a day** (A): open in the morning with a float, count cash at closing. Several iPads of a
   branch share one cash drawer and one shift.
2. **No money without an open shift** (A): checkout, refund, Pay in and Pay out are refused with
   "Open the shift first". Ordering (counter and QR) and kitchen tickets keep working. Every money row
   belongs to exactly one shift, so the Z report is "everything between open and close" and bills after
   midnight need no business-day cutoff.
3. **Blind count** (A): the cashier enters the counted cash before seeing the expected amount. A variance
   above the branch's **Cash variance limit** (default RM 5.00) needs a supervisor PIN and a reason.
4. **Pay in / Pay out are recorded** (A) and enter the expected cash.
5. **Approach 1:** the server stamps `shift_id` on each money row when it is written; nothing is
   attributed by time, except the void list (no money moves on a void).
6. Open choices not asked were settled the Feedme way (Close up report layout, refunds of an old bill go
   to the shift open at the time of the refund).

## Data model

```
pos_shifts
  id uuid pk, branch_id → branches
  opened_by → staff, opened_at, opening_float_sen ≥ 0
  status 'open' | 'closed'
  first_count_sen      -- the first blind count submitted (kept even if the count is re-entered)
  counted_cash_sen, expected_cash_sen, variance_sen      -- set at close
  variance_reason, variance_approved_by → staff          -- only when |variance| > limit
  closed_by → staff, closed_at
  report jsonb                                           -- the frozen Z report, written once at close
  unique index: one row per branch where status = 'open'

pos_cash_moves
  id uuid pk (client-generated: a resend is safe), shift_id → pos_shifts, branch_id
  kind 'pay_in' | 'pay_out', amount_sen > 0, reason text not null
  created_by → staff, approved_by → staff (pay_out only), created_at

payments.shift_id → pos_shifts      (set by checkout_bill)
refunds.shift_id  → pos_shifts      (set by refund_bill)
refunds.kind      text              (snapshot of the method's kind; cash refunds leave the drawer)
branch_pos_settings.cash_variance_limit_sen integer not null default 500
```

Old dev rows keep `shift_id` null and appear in no report.

## Flows

**Open shift.** With no open shift the POS top bar shows **Open shift**. The sheet asks for the
**Opening float** (prefilled with the last shift's float). Any live POS staff of the branch may open.
`open_shift(p_float_sen)` refuses a second open shift ("A shift is already open — opened by <name> at
HH:MM").

**During the shift.** The top bar shows "Shift open · since 09:02". A shift open for more than 20 hours
shows an amber "This shift was opened yesterday — close it" note. `checkout_bill` and `refund_bill` take the
open shift with `for share` (a close waits for a checkout in flight and then counts it); with none they
raise "Open the shift first".

**Pay in / Pay out.** One sheet: kind, amount, reason (required). Pay out needs an approver PIN
(`pos_supervise`, the existing approval dialog); Pay in does not. `record_cash_move(id, kind, amount,
reason, approver, pin)` is idempotent on `id`.

**Close shift.**
1. **Close shift** warns when bills are still open ("3 bills are still open — they stay open for the next
   shift") and lets the cashier continue.
2. **Counted cash** (one total, blind). Submitting calls `close_shift(shift_id, counted, reason, approver,
   pin)`; the first call stores `first_count_sen`.
3. The server computes **expected cash = opening float + cash payments − cash refunds + pay in − pay
   out** (cash payments are `amount_sen`, change already taken off).
4. Within the limit → closed. Above it without an approver → `{ok:false, needsApproval:true,
   expectedSen, varianceSen}`; the sheet then shows expected and variance and asks for a reason and a
   supervisor PIN. Re-entering a different count is allowed; the Z report shows the first count beside
   the final one.
5. On close the server builds the Z report once (`pos_shift_report`), stores it in `report`, and queues
   it on the branch's receipt route (none → "Not printed — no receipt printer set").
6. A closed shift never changes. A refund of its bills later belongs to the shift open at that time.

**Past shifts.** A **Shifts** drawer (pos_supervise) lists the last 30 closed shifts (date, opened/closed
by, nett sales, variance) and opens each Z report with **Reprint**.

## Z report (Feedme "Close up", without discount, delivery and member sections)

- **Header:** branch, opened (time, by), closed (time, by).
- **Summary:** bill count, total pax, nett sales, average per bill, average per pax, void bill count,
  total void, total refund.
- **Sales summary:** Gross (subtotal) → Takeaway fee → Service charge → SST → Rounding → **Nett**.
- **Payments:** per method: count, amount; refunds per method; net per method.
- **Order type:** dine-in / takeaway — bills, nett.
- **Source:** counter / QR — orders, item value.
- **Cash drawer:** opening float, cash sales, cash refunds, each pay in / pay out (amount, reason, by),
  expected, first count, counted, variance (reason, approved by).
- **Voids:** voided items and bills whose void time falls between open and close (name, qty, value,
  reason, by, approver).
- **Refunds:** bill no, amount, method, reason, approver.
- **Product sales:** per product name, quantity and value, most sold first.

A bill belongs to the shift of its payments (one checkout per bill, so all its payments share a shift).
All money in integer sen; the printed layout reuses `renderJobLines` with a new payload kind `zreport`
(print_jobs.kind stays `receipt`, as the refund slip does).

## Permissions

Open shift, close shift (within the limit), Pay in: live POS staff of the branch (`pos_my_branch`).
Pay out and a variance above the limit: approver with `pos_supervise` and PIN. Shifts drawer and reprint:
`pos_supervise`. Cash variance limit: the POS settings page, as the other branch settings.

## SQL rules (as Sub-plans 1–3 and M1–M3)

`security definer` + `set search_path = public, pg_temp`; revoke from `public, anon`; every DELETE /
UPDATE has a WHERE (pg-safeupdate — the Vitest scan covers the new files); idempotent migration ending
with `notify pgrst, 'reload schema'`; STOP guards when the checkout fixes are missing; the re-created
`checkout_bill` and `refund_bill` become canonical, and the older checkout files gain a STOP / re-run note.
Dev first; prod later by the owner, before any deploy carrying the client.

## Testing

- **SQL verify script (dev, rolled back):** open twice refused; checkout and refund refused with no shift;
  stamps on payments and refunds; pay out without PIN refused; expected cash with float, cash and card
  payments, change, a cash refund, pay in and pay out; within-limit close; above-limit needs approval;
  first count kept; closed shift immutable; a checkout racing a close lands in the closed shift's report;
  a refund of a closed shift's bill lands in the new shift; report totals equal the bills' totals.
- **Vitest:** the Z report layout (`renderJobLines` for `zreport`), form parsing of amounts, the shift
  status banner rules.
- **Browser on dev:** open → orders → cash and card checkout → pay out → refund → close with a short
  variance → Z report printed via the print host; reprint from Shifts.
