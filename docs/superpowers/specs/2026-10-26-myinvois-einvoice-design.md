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

## W5 — catch-up and automation (2026-11-23)

Readiness W5. The owner picked W5 next on 2026-11-23; the lowest-admin route above (approved 2026-10-29)
is the design. This section fixes what changed since the skeleton and settles the small decisions (the
owner asked Claude to make those). Branch `feature/pos-demo` (feature/einvoice merged in 979c4e2).

### W5.1 What the skeleton misses

- **Discounts (W2).** `billLines` builds item lines at gross price and throws when an SST group's base is
  smaller than its items (any discounted bill). **Takeaway lines in a dine-in bill (W7)** and the
  per-line takeaway fee are not modelled. Consolidation sums whole-bill totals only.
- **No outlet start date.** Consolidation would report every paid bill of a branch, including bills
  Feedme already reports. That breaks "no double reporting" at cut-over.
- **No RM10,000 guard**, no scheduled run, no credit notes.

### W5.2 Lines come from the sales ledger

- A document's lines are built from the same per-line figures as Reports → Ledger export
  (`pos_report_lines`: gross, catalog / item / bill-share discount, net, SST base = net + takeaway fee
  on a takeaway line; SST per line = the bill's rate group split by largest remainder, ordered as the
  ledger orders it). One shared SQL function returns these lines for a set of bills, and both the ledger
  and the e-invoice read it, so an e-invoice and the ledger agree to the sen.
- **Single invoice:** one line per item line: unit price, quantity, the discount as a line allowance,
  the takeaway fee as a taxed line charge, tax at the line's rate. Service charge and rounding stay
  whole-document amounts, as before.
- **Consolidated invoice:** one line per **business day** (06:00–05:59 MYT, as Reports) and SST rate,
  "Receipts 261025-001 – 261025-212 (212)", plus that day's untaxed amounts and service charge. The month
  is the business-day month, so a consolidated invoice equals Reports → Overview for the same month and
  outlet.
- Every document is checked before submission: its payable amount must equal the bills' `total_sen` sum
  (a mismatch refuses, as now).

### W5.3 Outlet start date (no double reporting)

- New `branches.einvoice_from date`, set per outlet on the E-invoice screen ("Report e-invoices from").
  Empty = this outlet is not reported by us (Feedme still reports it). Only bills whose business day is on
  or after it are invoiced, consolidated or credited.
- It may be set or moved later freely; moving it earlier, or clearing it, is refused once a live
  document exists for that outlet.

### W5.4 The daily job

- `pg_cron` runs every day at 07:00 MYT (after the 1st's business day of the old month has closed) and
  calls the Edge Function's `run` action through `pg_net`, with a job secret (Supabase Vault on the
  database side, function secret `EINVOICE_JOB_SECRET` on the function side; generated, never shown).
- Each run, in order:
  1. Refresh every submitted document still waiting for LHDN.
  2. Every day: consolidate each closed business month of an outlet with a start date that still has
     unreported bills (`einvoice_unreported_months`), oldest first — last month's goes out on the 1st, and a
     missed or killed run, or a start date set into a month already past, is caught up. At most 6
     outlet-months per run (the rest are reported as "later"); at most 3 attempts per outlet and month, then
     stop and raise the banner. *(Final review, 2026-11-23: was "days 1–7, previous month only", which let a
     closed month go silently unreported.)*
  3. Credit notes (W5.5).
  4. One `einvoice_job_runs` row: written `running` when the run starts and completed at the end (when, what
     was done per outlet, and errors), so a run killed half-way still shows on the screen.
- Not set up (no LHDN credentials or company details missing): the run records "not set up" and calls
  nothing. In sandbox that raises no banner; in production it does.

### W5.5 Credit notes for refunds

- **Refund of an individually invoiced bill** → a single credit note (`CN-…`) referencing that invoice's
  LHDN UUID, issued by the next daily run.
- **Refunds of bills already in a consolidated invoice** → one consolidated credit note per outlet and
  month for that month's refunds (by the refund's business day), issued with the next month's
  consolidation and referencing the consolidated invoice(s) of the original bills.
- A refund of a bill not yet reported waits until its bill is reported, then follows the rules above.
  A refund of a bill before the outlet's start date is never reported by us.
- Refunds store an amount only, so a credit note splits the refund over the bill's own mix (each SST rate
  group, the untaxed part and the service charge) by largest remainder; its tax never exceeds the bill's.
- **As built (W5.5 note, 2026-11-23):** a consolidated credit note is issued by the first daily run after its
  refunds' business month has ended *and* the original consolidated invoice is valid — not only together with
  the next month's consolidation. A single credit note LHDN finds invalid counts against its refund
  (`CN|<refund>`) and stops after 3, like a month.

### W5.6 Bills over RM10,000

- A bill whose total is over RM10,000 is left out of consolidation and raises the banner ("needs the
  buyer's details for an individual e-invoice"); the owner issues it from the E-invoice screen with the
  buyer's details. Kept during the relaxation period too (see above).

### W5.7 Screen and banner

- E-invoice screen gains: per-outlet "Report e-invoices from" dates, the last job runs (date, outcome),
  and the bills over RM10,000 waiting for a buyer. The banner (access_settings users) shows when a
  document is rejected or invalid, a consolidation failed 3 times, a bill over RM10,000 waits, or (in
  production only) e-invoicing is not set up.
- Added in the final review (2026-11-23): Needs attention lists every closed outlet-month not reported yet
  ("Kepong · October 2026 · 212 bills · RM x.xx", Retry = consolidate), and the banner says "Some months'
  sales have not been reported to LHDN yet." (once the daily run has had its chance at the month) and "The
  daily e-invoice run has not run for 2 days." (an outlet has a start date and no run started in 48 h). A
  submitted document whose LHDN status is unknown keeps its bills and is flagged for a check in the portal.

### Before the production switch (final review, 2026-11-23)

- Links and the start-date guard ignore the environment today: a bill linked to a **sandbox** document counts
  as reported, `branches_einvoice_from_guard` and the screen's `hasLiveDocument` count sandbox documents as
  "already sent", and `einvoice_unlinked_paid_bills` / `einvoice_unreported_months` skip bills linked in
  sandbox. Before switching `einvoice_settings.environment` to production, either scope the links, the guard
  and `hasLiveDocument` to the current environment, or archive (delete) the sandbox links at the switch so
  every bill is reported again in production.
- `pg_net` keeps each request in its queue table (`net.http_request_queue`, readable by the `postgres` role
  only) until it is sent, so the job secret header is briefly stored there; it is never in any client-readable
  table or log.

### W5.8 Out of W5

First real sandbox submission and fixing the builder against LHDN's validator (needs the owner's sandbox
credentials), the receipt QR request page, the production switch and v1.1 signing (build order steps 2,
5, 6, 8). Field choices stay unverified until the first sandbox submission.

### W5.9 Testing

- Unit tests: the builders (discounts, takeaway lines, service charge, rounding, multi-rate, credit-note
  split), the job's decisions (which month, attempts, start dates).
- A reconciliation run over every paid dev bill: each single-bill document adds up to its `total_sen`,
  and a consolidated document per outlet and month equals the bills' sum and Reports → Overview.
- SQL verify (rolled back, dev): start-date rules, the shared ledger lines, job bookkeeping, links, the
  RM10,000 exclusion, credit-note selection.
- Dev: the `run` action called with the job secret and no LHDN credentials records "not set up"; the
  cron job exists and is scheduled.
