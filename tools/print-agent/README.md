# Craft POS print agent

Prints the kitchen tickets, receipts and Z reports of **one branch** on LAN printers
(raw ESC/POS on TCP 9100). It replaces the iPad's print host when a branch has an
always-on computer next to its printers.

## Setup

1. Copy `.env.example` to `.env` (git-ignored) and fill it in. **Dev project only.**
2. `BRANCH_ID` is the branch this agent prints for (`branches.id`). The agent refuses to
   start without it, and prints only that branch's jobs on that branch's routes of kind
   `agent`.
3. `AGENT_EMAIL` / `AGENT_PASSWORD` must be a login of **staff of that same branch**.
   The print functions (`claim_print_job`, `finish_print_job`, `requeue_print_job`) act
   only on jobs of the caller's own branch, so a login of another branch would skip every
   job — the agent checks this at start and stops with a message.
4. Run from the repo root:

   ```bash
   node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
   ```

Routes are read at start: restart the agent after changing a route in POS settings.

The agent prints with this repo's print code (`src/features/pos/print/`): after a POS update that changes
receipts, tickets or the drawer, pull the branch and restart the agent — and run that update's SQL first
(since W4 the agent reads `print_jobs.seq`, so a drawer kick goes out before its receipt). A drawer kick
older than 2 minutes is not sent: the server marks it failed ("Too late to open the drawer.") so the drawer
never opens with nobody at the till. Keep the agent computer's clock synced.
Tickets older than `MAX_AGE_MIN` minutes are left pending (the iPad shows them as
waiting) instead of printed on start. `TICKET_COLS` is the paper width in characters
(48 on the ZyWell ZY301).
