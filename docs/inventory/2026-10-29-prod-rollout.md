# Inventory v2 (PR #9) — production rollout plan

Prepared 2026-10-29 from read-only checks of production (`yfsoesxzurzjdwstszru`).
Claude runs every step through the Supabase Management API; the owner approves
the start and the test-data delete.

## What production looks like today

- Only the July Phase 1 procurement schema. None of files 1–13 has run.
- Procurement data is **test only**: supplier `[TEST] Bean Supply Co`, item
  `[TEST] Coffee Beans`, PO-20260730-001/002/003, 2 receivings, 2 stock rows,
  2 price-history rows, 2 photos. No real supplier, item or order.
- Branches Cheras (HQ), Kepong, Puchong exist. No existing row breaks a new check.
- No staff lose procurement access under the new capability rule.
- Daily automatic backup at about 01:47 MYT; no point-in-time restore.

## Before the night

1. **Owner:** set WONG LI YONG's branch in Staff Management (the only supervisor
   has none, so cannot order or receive).
2. **Claude:** re-run the read-only checks the same evening; stop if anything
   changed (real procurement data, a new supervisor without a branch, staff whose
   rank is above their system role).

## The night (after closing, one sitting, about 30 minutes)

3. **Snapshot.** Save, read-only, to a local file: every procurement table's rows
   and the current definition of every function the files replace
   (`submit_receiving`, `has_procurement_cap`, `can_access_branch`, …). The daily
   backup is the last resort; the snapshot is enough to undo by hand because the
   changes are additive and the data is test-only.
4. **Run files 1–13 in order**, once each, checking the result after each and
   stopping at the first error (each file is one transaction, so a failed file
   leaves nothing half-done):

   | # | File |
   |---|------|
   | 1 | `migration-2026-10-26-items-department.sql` |
   | 2 | `migration-2026-10-27-po-multi-receiving.sql` |
   | 3 | `migration-2026-10-27-cost-fix.sql` |
   | 4 | `migration-2026-10-27-overdelivery-close-short.sql` |
   | 5 | `migration-2026-10-27-security-hardening.sql` |
   | 6 | `migration-2026-10-27-wastage.sql` |
   | 7 | `migration-2026-10-27-internal-transfers.sql` |
   | 8 | `migration-2026-10-27-procurement-function-grants.sql` |
   | 9 | `migration-2026-10-27-prep-recipes.sql` |
   | 10 | `migration-2026-10-27-private-receiving-photos.sql` |
   | 11 | `migration-2026-10-28-inventory-review-fixes.sql` |
   | 12 | `migration-2026-10-29-item-departments.sql` |
   | 13 | `migration-2026-10-29-owner-decisions.sql` |

   Files 10 and 11 close a photo hole together; never stop between them.
5. **Post-checks (read-only):** every marker present (HQ supplier row, `po_shipments`,
   `wastage_logs`, `recipes`, `items.departments`, guards, six wastage reasons),
   photo bucket private, `anon` cannot run any procurement function, older files
   STOP when re-run (checked by running their guard only).
6. **Delete the test data** listed above (the owner has seen the list), in one
   transaction: receiving lines, receivings, stock rows, price history, PO lines,
   POs, the item, the supplier, then the 2 photo files. Then confirm every
   procurement table is empty except the HQ supplier row.
7. **Merge PR #9** into `main`. Vercel deploys the app (about 2 minutes). The DB
   goes first because the new screens call the new functions; the old app keeps
   working against the new DB in the meantime (its only casualty is photo
   links, and the only photos are the test ones deleted in step 6, so no CDN
   purge is needed).
8. **Smoke test** on production with a real supervisor and manager (the owner or
   a manager does this; Claude does not sign in as real staff):
   manager adds one real supplier and item → supervisor raises a PO for their
   department → receives it with a photo → logs one wastage → Stock on Hand shows
   the stock and the week's wastage.

## If something goes wrong

- A file fails: stop. Nothing from that file applied. Fix on dev, re-run from
  that file.
- The app misbehaves after the merge: revert the merge on GitHub (Vercel
  redeploys the old app). The new DB objects are additive; the old app works
  with them, apart from photo links.
- Worst case: restore the daily backup (loses the day's other changes, so only
  if the snapshot cannot undo it).

## After go-live (follow-ups already in PR #9)

- Tighten `anon` grants on the non-procurement functions listed in section 5.
- Drop `items.name_zh`; later, the single `items.department` once no old app
  version remains.
- Storage locations for the stocktake; recipes for the top 20 sellers.
