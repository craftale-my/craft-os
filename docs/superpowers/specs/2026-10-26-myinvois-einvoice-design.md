# MyInvois e-Invoice — direct API integration (skeleton)

Date: 2026-10-26 · Branch: `feature/einvoice` (from `feature/pos-demo`) · Dev project: craft-os-dev

## Decision

The owner chose to call LHDN's MyInvois API directly with the company's own ERP
credentials (Client ID + Client Secret registered in the MyInvois Portal), not
through Feedme or a middleware intermediary. Everything that touches LHDN lives in
the shared Supabase backend: the Client Secret and, later, the signing certificate
never reach a POS iPad or the customer page.

This replaces Sub-plan 4b's earlier idea (monthly Excel batch upload).

## Pieces

| Piece | Where | State in this skeleton |
|---|---|---|
| Company identity (TIN, BRN, SST no., MSIC, address) | `einvoice_settings` (one row) | table + RLS; filled by the owner |
| Issued documents and their LHDN status | `einvoice_documents` | table + RLS |
| Which bill / refund a document covers | `einvoice_bill_links`, `einvoice_refund_links` | a bill can sit in **one** live document only (primary key) |
| Atomic create (document + links) | `einvoice_create_document()` | SQL, service role only |
| Month's bills still to consolidate | `einvoice_unlinked_paid_bills()` | SQL, service role only |
| UBL 2.1 JSON builder | `supabase/functions/einvoice/ubl.ts` | pure, unit-tested |
| LHDN HTTP client (token, submit, poll) | `supabase/functions/einvoice/myinvois.ts` | built, untested against LHDN until credentials exist |
| Endpoint | Edge Function `einvoice` | actions `status`, `submit_bill`, `consolidate`, `refresh` |

## Rules the skeleton already enforces

- **Sandbox first.** `einvoice_settings.environment` defaults to `sandbox`. Sandbox takes
  unsigned v1.0 documents; production needs signed v1.1, so the function **refuses
  production** until signing is built.
- **No double reporting.** A bill linked to a live document cannot be linked again. When
  LHDN rejects or invalidates a document, its links are released so the bill can be
  re-issued.
- **Consolidation waits for month end** (Malaysia time) and covers only paid bills of
  that month that have no individual e-invoice.
- **Consolidated lines are per day**, not per bill: "Receipts 261025-001 – 261025-212
  (212)". One line per bill would pass LHDN's 300 KB per-document limit within a month.
- **Tax mapping.** SST charged on F&B is Service Tax → tax type `02` at the bill's rate;
  anything not taxed (0 % items, service charge, an unregistered branch) → `06`.
  Line taxes are split from the bill's own per-rate SST groups (largest remainder), so
  the document's tax always equals what the receipt charged.
- **Buyer.** Missing buyer = General Public (`EI00000000010`).
- **Who can call it.** Every action needs `access_settings` for now. Counter staff issuing
  a single e-invoice for a customer is a later decision (likely `pos_supervise`).

## Credentials (owner, later)

Sandbox: MyInvois Portal `preprod.myinvois.hasil.gov.my` → Register ERP → set on
craft-os-dev (Dashboard → Edge Functions → Secrets):

- `MYINVOIS_CLIENT_ID`
- `MYINVOIS_CLIENT_SECRET`

Never paste the secret into chat. `status` reports whether both exist and whether a
token can be obtained.

## Not built yet (next steps, in order)

1. Run the first sandbox submission once credentials exist; adjust the builder to
   whatever LHDN's validator reports.
2. Credit notes: single (refund of an individually invoiced bill, references the
   original UUID) and consolidated (month's refunds of consolidated bills).
3. Receipt QR → public request page (customer enters TIN/ID, gets their own e-invoice);
   needs a per-bill token on the receipt.
4. Monthly cron (pg_cron → function) for consolidation in the first days of a month.
5. v1.1 signing with a purchased certificate, then production.
6. Owner screen in Craft OS: settings form, document list, Retry.
7. Cutover from Feedme per branch so the same sale is never reported twice.
