# POS pre-pilot hardening

Date: 2026-10-25 · Branch: `feature/pos-demo` · Builds on Sub-plans 1–3, menu catalogs M1–M3 and shifts 4a.

## Why

Before the on-site simulated business run and the pilot, close the open findings from the earlier final
reviews that can cost money, lose a report line or print in the wrong shop. Each item below was checked
against the code at head 987a1aa on 2026-10-25.

## Owner decisions (2026-10-25)

1. **Packaging fee follows the item.** Items ordered on a takeaway bill keep their takeaway treatment
   after the bill is merged into a dine-in bill; merging only means paying together.
2. **Voids between shifts go to the next shift.** A Z report lists the voids from the previous shift's
   close to this shift's close.
3. The other choices below were settled the Feedme way and approved with this design.

## 1. Checkout sheet follows its bill

**Now:** the sheet holds a snapshot. If another iPad pays, voids or merges the bill, the cashier only
learns it when **Pay** fails — after the customer's card may already have been charged on the terminal.

**Change:** while the checkout sheet is open, every realtime `bills` event and every 15 s sweep re-reads
that bill.
- Bill no longer `open` (paid, voided or merged) and this sheet has not just paid it: the sheet locks
  (method buttons, lines and **Pay** disabled) and shows a red note
  "This bill was paid on another iPad — do not charge the card terminal." (paid) /
  "This bill was voided on another iPad." (voided) /
  "This bill was merged into <bill no> on another iPad." (merged). The only action is **Close**.
- Bill still open but its total changed (an item voided or an order added on another iPad): the sheet
  reloads its totals and shows "The bill changed on another iPad — check the total." Payment lines already
  entered stay; the existing sum-equals-total check refuses **Pay** until they match.

## 2. Payment locks after an unsure reply

**Now:** after "Not sure the payment went through" the lines stay editable and the retry reuses the same
`checkout_id`; the server replays the first result even when the new lines differ.

**Change (client):** after an unsure reply the method buttons, amounts and remove buttons lock. The sheet
offers **Try again** (same lines, same `checkout_id`) and **Check bill** (re-reads the bill: paid → show the
paid result from the server; open → unlock the lines and mint a new `checkout_id`). **Back** stays.

**Change (server):** `checkout_bill` with a `checkout_id` already recorded compares the stored payments
(method, amount, tendered) with `p_payments`. Equal → replay as today. Different → raise
"This payment was already recorded with other amounts — check Today's bills".

## 3. Item voids reach other iPads at once

**Now:** `void_order_item` changes only `order_items`, so other iPads see it on the 15 s sweep.

**Change:** `void_order_item` touches the bill row (`bills.updated_at = now()`; the column is added if
missing) so the realtime `bills` event fires. No new publication table.

## 4. Packaging fee follows the item

**Now:** `pos_compute_bill` charges the takeaway fee (and its SST base) only when the bill's order type is
takeaway, so merging a takeaway bill into a dine-in bill silently drops the fee.

**Change:** `order_items.order_type` (`'dine_in' | 'takeaway'`), set on insert from the bill by a trigger
(existing rows backfilled from their bill). `merge_bills` leaves it unchanged. `pos_compute_bill` takes a
line's own `orderType` (falling back to the bill's) for the packaging fee, the fee's SST base, and service
charge rule matching. A merged bill therefore totals what the two bills would have totalled apart (before
rounding, which stays whole-bill). The client mirror `bill.ts` and the shared vectors `billVectors.json`
change the same way, with a merge vector.

## 5. Z report keeps voids made between shifts

**Now:** `pos_shift_report` lists voids whose time is between this shift's open and close; a void made
while no shift is open lands in no report. Voids stay allowed without an open shift (ordering works
without one).

**Change:** the void window starts at the close of the branch's previous closed shift (this shift's open
when there is none) and ends at this shift's close. The Z report heading for the section reads
"Voids since the last close".

## 6. A cashier cannot lock an approver out

**Now:** wrong PINs count on the approver's own row; five wrong tries from anyone lock the approver for
10 minutes everywhere.

**Change:** wrong tries count per (approver, caller) in a new `pos_pin_attempts` table. Five wrong tries by
one caller lock that caller out of that approver for 10 minutes ("Too many wrong PINs — try again after
HH:MM"); the approver and every other caller are unaffected. The counter of a pair resets after a
correct PIN or one idle day, as today. `set_my_pos_pin` (caller = approver) uses the same table.
`staff_pos_pins.failed_attempts` and `locked_until` are no longer read or written.

## 7. Printing stays in its own branch

**Now:** the Node print agent (`tools/print-agent/agent.ts`) reads every branch's agent routes into one
map keyed by name and sweeps every branch's jobs; the print-job RPCs accept any job id.

**Change:**
- The agent requires `BRANCH_ID` in `.env` (refuses to start without it) and filters routes, the sweep and
  the realtime subscription by it.
- `claim_print_job`, `finish_print_job` and `requeue_print_job` become `security definer` with
  `search_path = public, pg_temp` and act only on jobs of the caller's branch (`pos_my_branch()`); another
  branch's job id is a no-op (`false` / nothing), as an already-claimed job is today. The agent's login
  must therefore be a staff member of that branch — `.env.example` and the agent README say so.
- The browser print host already filters by branch; it keeps working unchanged.

## 8. Simulated business run sheet

`docs/pos/2026-10-25-simulated-run-sheet.md` (English): the after-hours script the owner runs on site with
two iPads, the ZY301 and the print agent — open shift, several tables ordering at once, QR add-on order,
set meal, item void, bill void, move table, merge (including a takeaway into a table), split tender, cash
with change, refund, pay in / pay out, a short offline spell on the counter, close with a blind count,
Z report. Each step names the products to order (real Demo menu items on dev), the expected bill totals,
and the expected Z report lines, so the run can be checked line by line. A results table at the end
(step, expected, seen, pass/fail).

## SQL rules (as before)

One new migration `supabase/migration-2026-10-25-pos-hardening.sql` (schema + functions, idempotent,
`security definer` + `set search_path = public, pg_temp`, revoke from `public, anon`, every UPDATE / DELETE
has a WHERE, ends with `notify pgrst, 'reload schema'`, STOPs if the shifts functions are missing). Every
function it re-creates becomes canonical; the older files that define them gain a re-run note. Dev first;
prod later by the owner in the rollout order, after the shifts files.

## Testing

- **SQL verify** `supabase/migration-2026-10-25-pos-hardening-verify.sql` (dev, rolled back): replay with
  different payments refused, equal replay returns the first result; item void bumps the bill; merged
  takeaway keeps its fee, SST and service-charge treatment and equals the two bills apart; a void between
  shifts appears in the next shift's report and not twice; five wrong PINs by caller A lock A only, B still
  approves with the right PIN; print RPCs refuse another branch's job; grants.
- **Regression:** shifts, checkout, ordering, menu, catalogs, menu-editor, slots-photos verify scripts.
- **Vitest:** bill vectors (merge case), checkout sheet lock rules (pure function deciding lock / reload
  from the re-read bill), unsure-reply state machine, agent branch filter.
- **Browser on dev (two tabs):** pay a bill in tab B while tab A has its checkout sheet open → A locks with
  the red note; void an item in B → A's bill panel updates within 2 s; merge a takeaway into a table → fee
  kept; unsure reply simulated offline → lines locked, Check bill works.
