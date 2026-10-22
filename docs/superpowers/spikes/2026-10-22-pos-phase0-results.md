# POS Phase 0 — spike results

Spec: docs/superpowers/specs/2026-10-22-pos-demo-design.md
Plan: docs/superpowers/plans/2026-10-22-pos-phase0-spikes.md

## Setup

| Item | Value |
|---|---|
| Date / shop | 2026-10-22 · Craft Cafe (shop LAN 192.168.0.0/24) |
| Wi-Fi network | |
| Mac running Vite + agent (IP) | 192.168.0.32 (MacBook, macOS — Node needs Local Network permission) |
| iPad model / iPadOS version | |
| Phone(s) used for QR | |
| Bar printer — brand / model / IP / route kind | ZyWell ZY301 (generic ESC/POS, USB+RS232+LAN) / 192.168.0.8 / agent (TCP 9100) |
| Kitchen printer — brand / model / IP / route kind | not identified yet — Kitchen route temporarily points at the bar printer 192.168.0.8 |
| Supabase project region | ap-southeast-1 (Singapore) — project craft-os-dev, ref egznnbjmicebbhwasloy |
| Dev Supabase verify script (spike-2026-10-22-pos-phase0-verify.sql) returned VERIFY OK | Yes — 2026-10-22, all 14 checks |
| Dry run done off site (fake printer + dev DB) | |

## Before going on site

1. Run the verify script (`spike-2026-10-22-pos-phase0-verify.sql`) in the dev Supabase SQL editor and confirm `VERIFY OK`.
2. Run Task 10's fake-printer check against the dev DB: `nc -l 9100` in one terminal, the agent in another, then press **Test print** on the POS page.
3. Open `spike/pos.html` and `spike/qr.html` once on the Mac and confirm both load.
4. Bring the Epson ePOS-Print and Star WebPRNT official sample pages (vendor SDK downloads), so a 1a FAIL can be told apart as a code problem or a printer problem.

## Spike 1 — printing

| Check | How | Result | Evidence |
|---|---|---|---|
| 1a Browser → printer over HTTPS | iPad: open `https://<printer-ip>` once and accept its certificate, then POS page → Test print (browser route). If the printer offers no HTTPS, record 1a FAIL — the production POS is HTTPS. | FAIL (hardware) | ZY301 answers on 9100 only; ports 80 and 443 do not respond (curl 000) — no web service, so a browser cannot print to it |
| 1b Certificate acceptance survives closing and reopening Safari | Close Safari fully, reopen POS page, Test print again | N/A | Follows from 1a — the printer has no HTTPS at all |
| 1c Agent → printer on TCP 9100 | Mac: run agent, POS page → Test print (agent route) | | |
| 1c-2 Agent: unplug the printer's network cable, then Test print again | Agent log should say the job failed, not printed; the job shows as failed in `select id, status, last_error from spike_print_jobs order by created_at desc limit 5;` (no page lists agent jobs) | | |
| 1d Chinese characters | Look at the "Chinese check" line on each ticket | Prints as "?" | Test ticket 18:19: "Chinese check: ??? ??". Text ESC/POS with no code page; Feedme prints this printer "Image-based" (rasterised), which is how it shows Chinese |
| 1e Ticket width | Does a 42-column rule fit on one line? If not, what does? | 48 columns fit | A 48-digit row printed on one line; agent TICKET_COLS set to 48 |
| 1f-browser Failure shows and reprints (browser route) | Open the printer cover, Test print: the job shows as failed. Close the cover, press Reprint: it prints once | | |
| 1f-agent Failure and requeue (agent route) | Open the cover or unplug the cable on an agent route, Test print, then run `select id, status, last_error from spike_print_jobs order by created_at desc limit 5;`. If failed, requeue with `select spike_requeue_print_job('<id>');` and confirm it prints once | | |

**Spike 1 verdict:** PASS if (1a + 1b + 1f-browser) OR (1c + 1c-2 + 1f-agent).

## Spike 2 — QR order → POS ≤ 2 s, tickets printed

Procedure: iPad shows the POS page. On a phone on the shop Wi-Fi open the QR links. The server rejects a 6th QR order from one table within a minute, so rotate the 10 orders across tables B5, A1, A2 (in that order, repeating), about 10 s apart. Each order has one Bar and one Kitchen item. The phone shows "sent in N ms" after each order — record it as the customer send time.

| # | Table | Latency on POS (ms) | Customer send time (ms) | Bar ticket printed | Kitchen ticket printed |
|---|---|---|---|---|---|
| 1 | B5 | | | | |
| 2 | A1 | | | | |
| 3 | A2 | | | | |
| 4 | B5 | | | | |
| 5 | A1 | | | | |
| 6 | A2 | | | | |
| 7 | B5 | | | | |
| 8 | A1 | | | | |
| 9 | A2 | | | | |
| 10 | B5 | | | | |

Order-to-print time from the database (paste the output):

    select round(extract(epoch from (j.printed_at - o.placed_at)) * 1000) as ms_to_print, j.route
      from spike_print_jobs j join spike_orders o on o.id = j.order_id
     where o.source = 'qr' order by o.placed_at desc limit 20;

**Spike 2 verdict:** PASS if for all 10 orders (latency + customer send time / 2) ≤ 2000 ms and all 20 tickets printed exactly once.

## Spike 3 — counter orders survive an outage

Note the time (UTC) here: ____ (before 3a; the 3d queries use it as `<noted time>`, e.g. `2026-10-22 03:48:00+00`).

| Check | How | Result | Evidence |
|---|---|---|---|
| 3a Queue while internet is down | Unplug the router's internet (WAN) cable — Wi-Fi stays up. Submit 3 counter orders. "queued" shows 3 | | |
| 3b Survives closing the tab | Close the POS tab, reopen it (still no internet). "queued" still 3 | | |
| 3c Sends on reconnect | After reopening the tab in 3b the counter restarts at 0. Plug the WAN back in and wait until a web page loads on the iPad; within 30 s of that, "queued" is 0 and "sent this session" shows 3. | | |
| 3d No duplicates, nothing lost | Count: `select count(*) from spike_orders o where o.source = 'counter' and o.placed_at >= '<noted time>' and not exists (select 1 from spike_order_items i where i.order_id = o.id and i.note = 'duplicate test');` — expect exactly 3. Contents: `select o.id, string_agg(format('%s x %s', i.qty, i.name_snapshot), ', ' order by i.name_snapshot) from spike_orders o join spike_order_items i on i.order_id = o.id where o.source = 'counter' and o.placed_at >= '<noted time>' group by o.id;` — match against what was rung up | | |
| 3e Duplicate test button | Press Duplicate test | | |

**Spike 3 verdict:** PASS if 3a–3e all pass.

## Known limitations going in

- **Raw TCP 9100 cannot confirm a print.** The agent waits up to 1 s after sending; a printer that keeps the connection open and drops it later than that is reported as printed. Epson ePOS / Star WebPRNT return an explicit success, so they do not have this gap.
- **Stuck "printing" jobs are not recovered automatically.** If the iPad or agent dies after claiming a job, it stays "printing". Note any you see (`select id, route, created_at from spike_print_jobs where status = 'printing';`).
- **Chinese text on tickets** is sent as "?" over raw TCP (ESC/POS without a code page); Epson ePOS sends it as text with lang="zh-cn". Spike 1d records what each printer actually shows.
- **The Supabase SQL editor may ask to confirm a "destructive operation"** when running the verify script — it is safe to confirm: the whole script is rolled back.

## Outcome

| Spike | Verdict |
|---|---|
| 1 Printing | |
| 2 Realtime | |
| 3 Offline | |

**Decision:**
- All three PASS → start Phase 1 on the spec as written; the print path is whichever of 1a/1c passed.
- Only the agent path (1c + 1c-2 + 1f-agent) passed for printing → amend the spec: Phase 1 needs an always-on print agent device in each shop.
- Spike 1 fails entirely → stop and decide on printer hardware before Phase 1.
- Spike 2 fails → investigate Realtime region/latency before Phase 1.
- Spike 3 fails → fix the queue before Phase 1; do not pilot without it.
