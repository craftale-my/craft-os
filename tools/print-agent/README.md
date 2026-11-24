# Craft POS print agent

Prints the kitchen tickets, receipts and Z reports of **one outlet** on LAN printers
(raw ESC/POS on TCP 9100). It replaces the iPad's print host when an outlet has an
always-on computer next to its printers.

The agent is a **device**, like a POS tablet: it pairs once, HQ approves it in Craft OS
for one outlet, and from then on it prints that outlet's jobs on that outlet's routes of
kind `agent`. It needs no staff login.

## Setup

1. Copy `.env.example` to `.env` (git-ignored) and fill in `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`. `TICKET_COLS` and `MAX_AGE_MIN` are optional.
   **Production:** the agent refuses the production database unless the `.env` also has
   `PRINT_AGENT_ALLOW_PROD=1`. Set that line only on an outlet's printing computer — never on a
   developer's machine, which would print (or take) a real outlet's tickets. The pair command and
   the agent both print a `*** PRODUCTION database ***` line when it is on.
2. Pair, from the repo root (the name is optional; the default is this computer's name):

   ```bash
   node --env-file=tools/print-agent/.env tools/print-agent/pair.ts "Cheras bar computer"
   ```

   It prints `Pairing code: ABC-123 — approve it in Craft OS → Devices (kind: Print agent).`
   HQ opens Craft OS → POS → Devices → Pending requests, checks the code, picks the outlet,
   keeps the kind **Print agent** and approves. The command then writes
   `tools/print-agent/.device.json` (git-ignored, readable only by you) and says
   `Paired. Start the agent with: …`. A rejected or expired request says so; run the command
   again for a new code.

   An agent started with a staff email login stops printing once the switch-over SQL runs — pair it before that.
3. Run:

   ```bash
   node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
   ```

To pair again (another outlet, a new computer): unpair the old agent in Devices, delete
`tools/print-agent/.device.json`, run the pair command. When HQ unpairs the agent it stops
with `This print agent was unpaired — run the pair command again.` (within a minute).
Never copy `.device.json` to another computer or into chat: it is the agent's password.

Routes are read at start: restart the agent after changing a route in POS settings.

The agent prints with this repo's print code (`src/features/pos/print/`): after a POS update that changes
receipts, tickets or the drawer, pull the branch and restart the agent — and run that update's SQL first
(since W4 the agent reads `print_jobs.seq`, so a drawer kick goes out before its receipt). A drawer kick
older than 2 minutes is not sent: the server marks it failed ("Too late to open the drawer.") so the drawer
never opens with nobody at the till. Keep the agent computer's clock synced.
Tickets older than `MAX_AGE_MIN` minutes are left pending (the iPad shows them as
waiting) instead of printed on start. `TICKET_COLS` is the paper width in characters
(48 on the ZyWell ZY301).
