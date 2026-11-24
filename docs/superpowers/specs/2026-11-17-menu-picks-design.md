# Menu picks (QR ordering and counter) — design

Date: 2026-11-17 · Branch: `feature/pos-demo` · Status: owner asked for it on 2026-11-17 ("AI
recommendations on QR ordering: what sells best, what usually goes together, what most guests choose");
the details below were decided without the owner (asleep, "small decisions: don't ask") and are marked
where they are a choice.

Research behind it: `docs/pos/2026-11-17-modern-pos-ai-research.md` (iCHEF's QR recommendations are
computed from the shop's own sales, not an LLM; Toast's in-order upsell is still beta).

## 1. Goal

Three hints, on the customer's QR menu first and on the counter's order screen second:

1. **Popular here** — what sells best at this outlet.
2. **Goes well with** — after a guest adds an item, what is usually ordered with it (latte → cake).
3. **Most picked** — inside an item's options, the choice most guests make (e.g. Oat milk).

## 2. Decisions

- **Statistics, not an LLM** (assumed). The three hints are counts over our own POS orders. No API key,
  no cost per scan, the same answer every time, and explainable ("ordered together 41 times"). An LLM
  adds nothing to "count what sells" and would need a key the owner has not given yet.
- **Cold start:** the POS has almost no sales yet (dev: 15 paid bills), and Feedme's history is not in
  our database. So a manager can tick **Recommend on QR menu** on a product; ticked products fill
  Popular here and Goes well with until sales are enough, and stay first afterwards.
- **Grain** (assumed): Popular counts units on paid bills of the branch, last 30 days. Goes well with
  counts products in the same **order** (one guest's basket, closer than a whole table's bill), last 60
  days. Most picked counts modifier choices, last 60 days.
- **Thresholds** (assumed, constants in one place):
  - Popular from sales only when the branch has ≥ 30 paid bills in the window; top 6 by units, a product
    needs ≥ 3 units.
  - A pair Y for X needs Y in another category, ≥ 3 shared orders, and shared/orders(X) ≥ 10%; top 3 by
    shared orders.
  - Most picked needs ≥ 10 units of the product with that group answered, and the top option ≥ 40% and
    strictly ahead of the next.
- **Cache:** computed per branch at most every 30 minutes (assumed) into `menu_picks_cache`; the read
  recomputes when the cache is older. No cron job.
- Add-on products, voided items and items not on paid bills are never counted. Picks are filtered on the
  client to products the current menu actually offers (catalog, time slot, sold out).

## 3. Server

Migration `supabase/migration-2026-11-17-menu-picks.sql` + `-verify.sql`.

```sql
alter table menu_products add column if not exists is_recommended boolean not null default false;
create table if not exists menu_picks_cache (
  branch_id    uuid primary key references branches(id),
  computed_at  timestamptz not null,
  payload      jsonb not null
);
-- RLS on, no policies: read only through the functions below
```

- **`pos_compute_picks(p_branch uuid) returns jsonb`** (internal, stable): the payload
  ```json
  { "popular": ["<productId>", …],                       // recommended first, then by units, max 8
    "pairs":   { "<productId>": ["<productId>", …] },    // max 3 each
    "mostPicked": { "<productId>": { "<groupId>": "<optionId>" } },
    "fromSales": true }                                    // false = only recommended products so far
  ```
  Pairs fallback for a product with no qualifying pair: the popular list minus products of its own
  category, max 3.
- **`pos_menu_picks_for(p_branch uuid) returns jsonb`** (internal, volatile): returns the cached payload
  when `computed_at > now() − 30 min`, else computes, upserts and returns it.
- **`qr_picks(p_token text) returns jsonb`** (security definer, `anon, authenticated`): the table's
  branch (active table, not paused) → `pos_menu_picks_for`; an unknown token returns null.
- **`pos_menu_picks() returns jsonb`** (security definer, `authenticated`): the caller's branch
  (`pos_my_branch()`).
- **`set_product_recommended(p_product_id uuid, p_on boolean) returns void`**: needs
  `has_menu_cap('manage_menu')` (the menu editor's capability); clears every branch's cache row so the next
  read recomputes.
- `menu_product` reads in the menu editor include `isRecommended`.

## 4. QR page (`src/qr/QrApp.tsx`)

- Loads `qr_picks` after `qr_menu` (a failure just hides the hints; never blocks ordering), and again
  with the minute menu refresh at most every 10 minutes.
- **Popular here:** a horizontal row of cards above the category chips (photo, name, price); tapping
  opens the item sheet. Hidden when no popular product is on the menu now. Products in it also carry a
  small **Popular** pill in the category lists.
- **Goes well with:** right after a guest adds a new line (not when editing one), a panel above the cart
  shows "Goes well with your Coffee Latte" and up to 3 cards (on the menu now, not sold out, not
  already in the cart); tapping one opens its sheet; ✕ or adding anything closes it. Shown at most once
  per product per visit.
- **Most picked:** in the item sheet (`LineSheet`), the option gets a **Most picked** pill. Nothing is
  pre-selected because of it (assumed: guests must not pay for an option they did not choose).

## 5. Counter (`OrderScreen`, after the QR work)

- `pos_menu_picks` loaded with the menu; **Popular** pill on product tiles.
- After a product is added to the draft, a one-line chip row under the bill's drafts: "Goes well with:
  Butter Croissant · Basque Cheesecake"; a tap adds the product as from its tile (sheet if it has
  required options); the row clears on the next add or Send.
- `ModifierSheet` shows the **Most picked** pill like the QR sheet.

## 6. Menu editor

Product editor: a switch **Recommend on QR menu** with the hint "Shown under Popular here, and suggested
with other items, until sales are enough to choose by themselves." It saves on its own call
(`set_product_recommended`), not through the product save.

## 7. Client files

| File | Change |
|---|---|
| `src/features/pos/order/picks.ts` (new) | Pure: payload type, `visiblePopular(menu, picks)`, `pairsFor(menu, picks, productId, cart)`, `mostPickedOption(picks, productId, groupId)` |
| `src/qr/QrApp.tsx` | Load picks, Popular row + pills, Goes well with panel |
| `src/features/pos/order/LineSheet.tsx`, `ModifierSheet.tsx` | Optional `mostPicked` prop → pill |
| `src/features/pos/order/OrderScreen.tsx`, `ProductTiles.tsx` | Counter pills and chip row |
| `src/features/pos/menu/ProductEditorPage.tsx` | Recommend switch |

UI copy: "Popular here", "Popular", "Goes well with your <product>", "Most picked",
"Recommend on QR menu", the hint above.

## 8. Testing

- SQL verify on seeded orders (rolled back): popular order and the 30-bill threshold, recommended first,
  pairs across categories only with the 3-order / 10% rules, fallback pairs, most picked threshold and
  tie, voided and add-on items ignored, cache reused inside 30 min and recomputed after
  `set_product_recommended`, `qr_picks` null for a bad token, anon cannot call `pos_compute_picks`.
- Client unit tests for `picks.ts` (filters to the live menu, excludes cart items and sold-out, max 3).
- Browser check on dev: QR page shows Popular here and Goes well with from recommended products; counter
  pill and chip row.

## 9. Not in scope

- An LLM or chat assistant; personal recommendations per member (no member login on QR yet); time-of-day
  picks; measuring uptake (needs a field on the order — a follow-up); importing Feedme history.

## 10. Rollout

Dev first. On prod after the POS chain; the client hides the hints when the functions are missing.
