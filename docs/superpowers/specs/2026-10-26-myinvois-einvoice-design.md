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

Superseded by the build order in "Lowest-admin route" below.

## Lowest-admin route (2026-10-29)

The owner confirmed combined turnover is over RM3M, so e-invoicing is mandatory
(General Guideline v4.8 exemption is below RM3M; third-party summaries, primary PDF
not yet read). Goal: **no recurring work for the owner or counter staff.** Every
ongoing task is automatic; people act only when something fails.

### Who does what

| Who | Task | How often |
|---|---|---|
| Owner | Register ERP in the **preprod** portal, set `MYINVOIS_CLIENT_ID` / `MYINVOIS_CLIENT_SECRET` on craft-os-dev | once (~10 min) |
| Owner | Fill company identity on the E-invoice settings screen | once |
| Owner | Register ERP in the **production** portal, set the same two secrets on Craft-Os-Prod | once, at go-live |
| System | Monthly consolidated e-invoice for every paid bill not individually invoiced | auto, 1st of each month |
| System | Consolidated credit note for the month's refunds of consolidated bills | auto, same run |
| System | Individual e-invoice when a customer requests one from the receipt QR | auto, on request |
| System | Single credit note when an individually invoiced bill is refunded | auto, on refund |
| Owner | Open the E-invoice screen and press Retry | **only** when the system flags a rejection |
| Counter staff | Nothing — no e-invoice button at the counter; customers self-serve | never |

### Decisions that remove work

- **No digital certificate at launch.** The SDK FAQ says taxpayers may keep
  submitting unsigned v1.0 until LHDN issues a retirement notice. Go live on v1.0;
  buy the certificate (about RM1,500 a year, per a forum post) and build v1.1 signing
  only when that notice appears. The same FAQ also says API submission needs an
  organisation certificate, so confirm in the production portal before go-live — if
  production rejects v1.0, signing moves up to step 6.
- **Customers request their own e-invoice.** Every receipt prints a QR to a public
  page. The customer enters name, TIN (or IC), email; the system issues the individual
  e-invoice and shows its validation link. Requests close when that month's
  consolidation runs; after that the page says the sale is already reported.
- **Run consolidation on the 1st**, leaving six of LHDN's seven days to retry
  automatically (3 attempts) before the owner is alerted.
- **Alert only on failure.** A rejected or still-invalid document shows a banner on
  the Craft OS dashboard for `access_settings` users. No monthly report to read.
- **Bills over RM10,000** are rare here (catering) but cannot be consolidated once the
  relaxation period ends. They are kept out of consolidation and raise the same
  failure banner so the owner can collect buyer details. During relaxation (RM3M–5M:
  to 31 Dec 2027) sources disagree on whether this applies — keep the guard anyway.

### Build order

1. Owner screen in Craft OS: settings form (company identity), document list,
   Retry, failure banner. Unblocks the owner's one-time step 2.
2. First sandbox submission once credentials exist; fix the builder against
   LHDN's validator (tax type `02`, classification `022`/`004`, buyer `NA`).
3. Monthly pg_cron job → `consolidate` on the 1st, with automatic retries.
4. Credit notes: consolidated (month's refunds) and single (references the
   original UUID).
5. Receipt QR + public request page; per-bill token printed on the receipt.
6. Production switch for v1.0 (lift the current refusal for unsigned production).
7. Cutover per branch: from the go-live date, that branch's sales exist only in our
   POS, so Feedme and we never report the same bill. Two consolidated e-invoices
   for the same month under one TIN (Feedme's and ours) are fine.
8. Deferred until LHDN's v1.0 retirement notice: v1.1 signing + certificate.

### Open questions

- **Grab orders** reach Feedme automatically today. If a cut-over branch still takes
  Grab on Feedme, Feedme keeps reporting those; if Grab moves to our POS, they join
  our consolidation. Decide per branch at cutover.
- ~~Over or under RM5M?~~ **Settled 2026-10-29: between RM3M and RM5M**, so the
  relaxation period runs to 31 Dec 2027. Step 5 (QR request page) may follow the
  first branch cutover instead of blocking it.
