# QR guest names and shared table cart — design

Date: 2026-11-22 · Branch: `feature/pos-demo` · Status: design approved by the owner on 2026-11-22.

Where it comes from: the owner recorded a session on another restaurant's QR ordering (iCHEF, Taiwan)
and asked what ours can borrow. Guests there pick a nickname and an avatar on entry, everyone at the
table sees one cart fill up live, and the table sends it together. Our page today is anonymous and each
phone keeps its own cart; the others at the table see an item only after it was sent.

Owner's decisions (asked, not assumed):

1. **The table sends together.** One cart per table; anyone may send it, after a confirmation that
   lists the whole table's items.
2. **A guest changes only their own lines.** Other guests' lines are read-only.
3. **The name travels to the kitchen/bar ticket and to the POS bill**, and the POS can pick a guest's
   lines in Split items.

Everything else below is my choice and marked "(assumed)" where it is a real choice.

## 1. Goal

- A guest who scans the table's QR code picks an avatar and may type a name.
- Items a guest adds go into the table's cart on the server. Every phone at the table shows the same
  cart, grouped by guest, within about a second.
- One guest sends the cart for the whole table. Each ticket line and each bill line carries the name of
  the guest who added it.

Out of scope, each its own later piece: order status after sending, a bill page for the guest, the
"stops being served at 13:31" banner, pairings as tick boxes inside the item sheet, member sign-up,
paying at the table, languages.

## 2. What the guest sees

All customer-facing copy is English.

**Entry card** — shown once per table code per phone, before the menu:

- Title `Who's ordering?`
- A row of 8 avatars (emoji, keys `a1`…`a8`; one is preselected at random).
- A text field `Your name (optional)`, at most 20 characters.
- Button `Start ordering`. With the field empty the guest is called `Guest`.
- The name and avatar sit in the page header afterwards; a tap reopens the card to change them. A change
  renames the guest's lines still in the cart, not lines already sent.

**Adding** — the item sheet is unchanged. `Add` writes the line to the table's cart. While the write is
in flight the button shows `Adding…`; on failure the sheet stays open with
`Not added — no connection. Tap Add to try again.` (or the server's reason). Nothing is shown in the
cart that the server does not hold.

**Live changes** — when another guest adds a line, a toast shows for 4 seconds:
`<avatar> Eric added 1 × Latte`. Several additions inside one refresh collapse into
`<avatar> Eric added 3 items`. Removals and edits make no toast. The `Place order` total follows the
table's cart.

**Cart** (the bottom panel) — two groups:

- `Your items` — as today: tap a line to edit it, `✕` to remove it.
- `Others at this table` — one sub-heading per guest (`<avatar> Mei`), lines read-only.
- A line whose product can no longer be ordered (left its time slot, switched off, sold out) is struck
  through with `Not available now` under it and is left out of the total. Its owner can remove it.

**Sending** — `Place order · RM 42.00` opens a sheet:

- Title `Has everyone ordered?`
- The table's lines grouped by guest, with the subtotal. Unavailable lines are not listed.
- The pax question, when the table still needs it (as today).
- Button `Send order for the table`, and `Not yet`.
- If the cart changed between opening the sheet and sending, nothing is sent: the sheet shows
  `The order changed — please check again.` with the fresh lines. What is sent is always what the sender
  saw.

**After sending** — every phone at the table empties its cart and shows the existing
`Order placed — it is on its way. You can add more below.` `Ordered so far` groups its lines by guest.

**A guest with nothing in the cart** may still send the table's cart (assumed: the person holding the
phone is often not the one who ordered).

## 3. Decisions

- **Identity without sign-in.** The phone creates a random `guestId` (uuid) and keeps it with the name
  and avatar in `localStorage` under `qr-guest-<table token>`. "Only your own lines" is judged by that
  id. It is a courtesy boundary between people at one table, not security: anyone holding the table's
  QR code could already place orders for it.
- **Names that collide.** Two guests may both be `Guest`, or both `Mei`. The server gives each guest a
  **label** that is unique on the table: the first keeps the name, the next become `Guest 2`,
  `Guest 3`. A guest's label never changes once one of their lines was sent on the open bill. Labels are
  what the page, the ticket and the POS show.
- **Sync: a ping, then a read.** (assumed, over polling every few seconds and over giving `anon` a
  subscription on a table.) After every successful write the phone sends an empty Realtime **Broadcast**
  message on the table's channel; a phone that receives one reads the cart again through the RPC. Every
  phone also reads every 15 s while in view and when it comes back into view, so a missed ping costs at
  most 15 s. The channel carries no data and no table is exposed to `anon`. This is the POS's own
  pattern (`usePosRealtime`: events plus a 15 s sweep).
  - The channel name is `qr-` + the first 16 hex characters of SHA-256 of the table token, so the token
    never appears as a channel name.
  - **Verified 2026-11-22:** an `anon` client may broadcast on a public channel in the dev project
    (`scripts/qr-broadcast-check.mjs`). The fallback read stays at 15 s.
- **Stale carts.** A line is deleted on the next read when it is older than 2 hours (assumed), or when
  the table has no open bill and the line was created before the table's most recent bill was closed
  (paid or voided).
  The next party never inherits the last party's cart.
- **Limits.** 50 lines per table cart and quantity 1–20 per line (both are `pos_insert_order`'s own
  limits for one order); note 200 characters (as today); name
  20 characters, trimmed, control characters removed; avatar must be one of the 8 keys. The existing
  limit of 5 QR orders per table per minute stays.
- **The old call stays.** `place_table_order` is kept as it is, so a page that was open across the
  deploy can still send its local cart. The new page never calls it.
- **Counter orders** have no guest: their lines carry no label, and nothing changes for them.

## 4. Server

Migration `supabase/migration-2026-11-22-qr-table-cart.sql` + `-verify.sql`. Dev only until the POS
rollout chain reaches prod; add both files to that chain.

```sql
create table if not exists qr_cart_lines (
  id           uuid primary key default gen_random_uuid(),
  table_id     uuid not null references dining_tables(id) on delete cascade,
  guest_id     uuid not null,
  guest_name   text not null,              -- as typed, or 'Guest'
  guest_avatar text not null,              -- 'a1'…'a8'
  product_id   uuid not null,
  variant_id   uuid not null,
  option_ids   uuid[] not null default '{}',
  qty          integer not null check (qty between 1 and 20),
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists qr_cart_lines_table on qr_cart_lines(table_id, created_at);
-- RLS on, no policies: read and written only through the functions below

alter table order_items add column if not exists guest_id    uuid;
alter table order_items add column if not exists guest_label  text;  -- 'Eric', 'Guest 2'; null = counter
alter table order_items add column if not exists guest_avatar text;  -- 'a1'…'a8'; shown on the QR page only
```

All functions are `security definer`, `search_path = public, pg_temp`, granted to `anon` and
`authenticated`, and take the table token first. An unknown, inactive or paused table is refused with
the messages `place_table_order` uses today.

- **`qr_cart_state(p_token text) returns jsonb`** — deletes the table's stale lines (§3), then returns

  ```json
  { "version": "<text>",
    "lines": [ { "id": "…", "guestId": "…", "guestLabel": "Eric", "guestAvatar": "a3",
                 "productId": "…", "variantId": "…", "optionIds": ["…"], "qty": 1, "note": null } ] }
  ```

  ordered by `created_at`. `version` is a hash of the lines' ids and `updated_at`; the client sends it
  back when it sends the cart. **Whether a line is available is judged on the phone** from the menu it
  already holds (`qr_menu`, read again every minute): product on the menu, not sold out, variant and
  options still offered — the test the page applies to its own cart today. Every phone holds the same
  menu, so they agree. The server stays the judge at Send (below).
- **`qr_cart_put(p_token, p_guest jsonb, p_line jsonb, p_line_id uuid) returns uuid`** — `p_guest` is
  `{id, name, avatar}`; `p_line` is today's `OrderLine`. With `p_line_id` null it inserts (refused at
  50 lines: `This table's order is full. Please send it first.`). With `p_line_id` it replaces that
  line, only when the line is on this table and its `guest_id` equals `p_guest.id`; otherwise
  `You can only change your own items.` It checks the line's shape and that the product and variant
  exist; whether it can be ordered is checked by the item sheet before and by `pos_insert_order` at Send.
- **`qr_cart_remove(p_token, p_guest_id uuid, p_line_id uuid) returns void`** — same ownership rule.
  Removing a line that is already gone succeeds.
- **`qr_cart_rename(p_token, p_guest jsonb) returns void`** — sets name and avatar on that guest's
  lines in the cart.
- **`qr_cart_send(p_token, p_pax integer, p_version text, p_skip uuid[], p_client_order_id uuid) returns
  jsonb`** — `p_skip` is the ids of the lines the sender's phone shows as unavailable.
  1. A resend of an order that already went in returns `{ "status": "sent", "orderId": … }` (same
     idempotency as `place_table_order`).
  2. Runs `place_table_order`'s checks: active, not paused, `qr_requires_open_bill`, 5 per minute.
  3. Locks the table's cart lines. If the current version differs from `p_version`, returns
     `{ "status": "changed" }` and sends nothing.
  4. Takes the lines not in `p_skip`; none → `Nothing to send.`
  5. Calls `pos_insert_order` with source `qr` and those lines, each carrying its `guestId`, avatar and
     label (§3, computed against the labels already on the table's open bill).
  6. Deletes **all** the table's cart lines, the skipped ones too, and returns
     `{ "status": "sent", "orderId": … }`.

  If `pos_insert_order` refuses a line after all (it left the menu within the last minute), nothing is
  sent, the error names the item, and the page reads the menu again at once — the line then shows as
  unavailable and the next Send skips it.
- **`pos_insert_order`** — re-created from its live text with two changes, marked `-- G`: a QR item may
  carry `guestId`, `guestLabel` and `guestAvatar`, stored on `order_items`; and each ticket line gains
  `"guest": <label>` when the item has one. Its checks are not touched. Lines from the counter are
  byte-for-byte what they are today.
- **`qr_table_state`** — each item gains `guestLabel` and `guestAvatar` from `order_items` (both null
  for counter items, which the page lists under `Ordered at the counter`).
- **The POS's bill items read** (`BillItemRow`'s query) — gains `guest_id`, `guest_label`.

Label rule, in one SQL function `qr_guest_label(p_bill_id, p_guest_id, p_name, p_taken text[])`:
the label this guest already has on the bill if any; else `p_name` if no other guest on the bill or in
`p_taken` has it; else `p_name || ' ' || n` for the smallest n ≥ 2 that is free. `qr_cart_state` and
`qr_cart_send` both use it, walking guests in order of their first line.

## 5. Client

`src/qr/` only, plus three small POS touches.

- **`qrGuest.ts`** (new, pure + storage): the avatar list, `loadGuest(token)`, `saveGuest(token, g)`,
  `cleanName(text)`. Storage failures (private mode) fall back to a guest kept in memory for the visit.
- **`qrCart.ts`** (new, pure): from a `qr_cart_state` reply and my `guestId` → `{ mine, others }`
  grouped for the panel and for the confirmation sheet; `cartTotalSen(menu, lines)` over available
  lines; `additionsToast(before, after, myGuestId)` → the toast text or null.
- **`useTableCart.ts`** (new hook): holds the reply; `add / replace / remove / rename / send`; subscribes
  to the channel, pings after its own writes, reads on ping, every 15 s in view, on visibility change;
  drops a reply that arrives after a newer one (the page's existing sequence-counter pattern). Exposes
  `status` (`loading | ready | offline`).
- **`GuestCard.tsx`**, **`SendSheet.tsx`** (new components) — §2.
- **`QrApp.tsx`** — `lines` state and `linesRef` go; the cart comes from `useTableCart`. The minute menu
  refresh no longer prunes the cart (the server marks lines unavailable); it still closes an open sheet
  whose product left the menu. `Goes well with` and `Popular here` keep working: "already in the cart"
  now means anywhere in the table's cart. `qrState.ts` loses `addLine / replaceLine / removeLine /
  leftTheMenu / leftTheMenuNotice / pruneAfterRefresh` and their tests once nothing uses them.
- **Ticket** — `TicketLine` gains `guest?: string`; the ticket text prints the line as
  `1 × Latte — Eric` (wrapped by the existing `wrap`). An add-on's own line on another route carries
  the same guest. Void tickets are unchanged (they name the item and the table).
- **POS bill column** — a sent row with a label shows it in small muted type after the name.
- **Split items** (`SplitItemsScreen`) — when the bill's live lines carry at least two different guest
  labels, a row of chips sits above the list, one per label. A tap picks every remaining unit of that
  guest's lines (added to what is already picked); a second tap takes them out. Select all / Clear are
  unchanged.

## 6. Failure cases

| Case | What happens |
|---|---|
| No connection on Add / edit / remove | The sheet or line shows the error; the cart is unchanged. |
| No connection on Send | `Not sent: no connection — tap Send to try again.` The same `client_order_id` is reused, so a retry cannot double-send. |
| Two guests send at once | The first call gets `sent` and empties the cart. The second finds a different version and gets `changed`; its sheet reads the cart again, finds it empty, and closes with the `Order placed` notice. |
| Cart read fails | The last cart stays on screen with `Reconnecting…` over the Place order button, which is disabled until a read succeeds. |
| Broadcast unavailable | Reads every 15 s still run (4 s if the verify step in §3 failed). |
| Staff pause the table mid-order | Writes and Send are refused with the paused message; the page shows it as today on its next menu read. |
| Bill closed while a cart is open | The cart's lines predate the close and are dropped on the next read; the page shows an empty cart. |
| Guest clears browser data | They get a new `guestId`; their old cart lines become "someone else's" and expire or are sent with the table. |

## 7. Testing

- Unit (vitest): `qrGuest` (clean name, storage fallback), `qrCart` (grouping, which lines are unavailable, totals skip them, toast text for one / several / own additions / removals), `useTableCart` with a mocked client
  (stale reply dropped, ping after write, `changed` handling), `GuestCard`, `SendSheet`, ticket text
  with and without a guest, the Split chips.
- SQL verify script on dev: put / replace / remove with the right and the wrong guest; the 50-line cap;
  a skipped line is left out by Send and deleted with the rest; `changed` on a version mismatch; idempotent resend;
  labels (`Guest`, `Guest 2`, a returning guest keeps their label); stale lines after 2 h and after a
  bill close; ticket payload carries `guest`; counter orders unchanged.
- By hand on dev, two phones on one table: names and avatars, live toast, edit own / cannot edit
  other's, send from the phone with an empty cart, printed ticket on the office test printer, the label
  on the POS bill, Split by guest chip.

## 8. Build order

1. Verify anon Broadcast on dev (§3).
2. Migration: table, columns, cart functions, `pos_insert_order`,
   `qr_table_state`; verify script.
3. `qrGuest`, `qrCart`, `useTableCart` with tests.
4. `GuestCard`, `SendSheet`, `QrApp` wiring; remove the dead `qrState` helpers.
5. Ticket text, POS bill label, Split chips.
6. Two-phone check on dev.
