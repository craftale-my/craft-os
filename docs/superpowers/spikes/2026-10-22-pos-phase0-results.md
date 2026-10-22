# POS Phase 0 — spike results

Spec: docs/superpowers/specs/2026-10-22-pos-demo-design.md
Plan: docs/superpowers/plans/2026-10-22-pos-phase0-spikes.md

## Setup

| Item | Value |
|---|---|
| Date / shop | |
| Wi-Fi network | |
| Mac running Vite + agent (IP) | |
| iPad model / iPadOS version | |
| Phone(s) used for QR | |
| Bar printer — brand / model / IP / route kind | |
| Kitchen printer — brand / model / IP / route kind | |
| Dev Supabase verify script (spike-2026-10-22-pos-phase0-verify.sql) returned VERIFY OK | |

## Spike 1 — printing

| Check | How | Result | Evidence |
|---|---|---|---|
| 1a Browser → printer over HTTPS | iPad: open `https://<printer-ip>` once and accept its certificate, then POS page → Test print (browser route) | | |
| 1b Certificate acceptance survives closing and reopening Safari | Close Safari fully, reopen POS page, Test print again | | |
| 1c Agent → printer on TCP 9100 | Mac: run agent, POS page → Test print (agent route) | | |
| 1c-2 Agent: unplug the printer's network cable mid-print, then Test print again | Agent log should say the job failed, not printed; ticket appears in the dashboard as failed | | |
| 1d Chinese characters | Look at the "Chinese check" line on each ticket | | |
| 1e Ticket width | Does a 42-column rule fit on one line? If not, what does? | | |
| 1f Failure shows and reprints | Open the printer cover, Test print, close cover, press Reprint | | |

**Spike 1 verdict:** PASS if 1a+1b pass OR 1c passes, and 1f passes.

## Spike 2 — QR order → POS ≤ 2 s, tickets printed

Procedure: iPad shows the POS page. On a phone on the shop Wi-Fi open the Table B5 QR link. Place 10 orders, each with one Bar and one Kitchen item, about 10 s apart.

| # | Latency on POS (ms) | Bar ticket printed | Kitchen ticket printed |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |

Order-to-print time from the database (paste the output):

    select round(extract(epoch from (j.printed_at - o.placed_at)) * 1000) as ms_to_print, j.route
      from spike_print_jobs j join spike_orders o on o.id = j.order_id
     where o.source = 'qr' order by o.placed_at desc limit 20;

**Spike 2 verdict:** PASS if all 10 latencies ≤ 2000 ms and all 20 tickets printed exactly once.

## Spike 3 — counter orders survive an outage

| Check | How | Result | Evidence |
|---|---|---|---|
| 3a Queue while internet is down | Unplug the router's internet (WAN) cable — Wi-Fi stays up. Submit 3 counter orders. "queued" shows 3 | | |
| 3b Survives closing the tab | Close the POS tab, reopen it (still no internet). "queued" still 3 | | |
| 3c Sends on reconnect | Plug WAN back in. Within 15 s "queued" is 0 and "sent" is 3 | | |
| 3d No duplicates | Paste: `select client_order_id, count(*) from spike_orders where source = 'counter' group by 1 having count(*) > 1;` — expect zero rows | | |
| 3e Duplicate test button | Press Duplicate test | | |

**Spike 3 verdict:** PASS if 3a–3e all pass.

## Known limitations going in

- **Raw TCP 9100 cannot confirm a print.** The agent waits up to 1 s after sending; a printer that keeps the connection open and drops it later than that is reported as printed. Epson ePOS / Star WebPRNT return an explicit success, so they do not have this gap.
- **Stuck "printing" jobs are not recovered automatically.** If the iPad or agent dies after claiming a job, it stays "printing". Note any you see (`select id, route, created_at from spike_print_jobs where status = 'printing';`).
- **Chinese text on tickets** is sent as "?" over raw TCP (ESC/POS without a code page); Epson ePOS sends it as text with lang="zh-hans". Spike 1d records what each printer actually shows.
- **The Supabase SQL editor may ask to confirm a "destructive operation"** when running the verify script — it is safe to confirm: the whole script is rolled back.

## Outcome

| Spike | Verdict |
|---|---|
| 1 Printing | |
| 2 Realtime | |
| 3 Offline | |

**Decision:**
- All three PASS → start Phase 1 on the spec as written; the print path is whichever of 1a/1c passed.
- Only 1c passed for printing → amend the spec: Phase 1 needs an always-on print agent device in each shop.
- Spike 1 fails entirely → stop and decide on printer hardware before Phase 1.
- Spike 2 fails → investigate Realtime region/latency before Phase 1.
- Spike 3 fails → fix the queue before Phase 1; do not pilot without it.
