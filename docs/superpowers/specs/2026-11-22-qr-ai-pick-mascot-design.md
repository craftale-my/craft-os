# QR page: AI Pick card and the mascot — design

Date: 2026-11-22 · Status: approved by the owner in conversation, awaiting review of this text
Builds on: `2026-11-17` menu picks (Popular / Goes well with / Most picked, from our own sales),
`2026-11-22` QR shared table cart (the five views).

## 1. Goal

Make the QR page friendlier: a small original mascot appears at a few moments, and the cart shows one
`AI Pick` — a single suggestion with a cheerful line — chosen from what the table has in its cart.

The suggestion is computed from our own sales data and simple rules; the line is one of a set of
pre-written sentences (owner's choice 2026-11-22: no language model — free, instant, never says anything
odd). The structure leaves one seam where a model-written line could replace the picked sentence later.

Out of scope: a model-written line, chat, dietary/allergen advice, mascot animation beyond a small CSS
bounce, a name contest for the mascot.

## 2. What the guest sees

**The mascot** — an original character drawn for Craft Cafe: a round coffee cup with a face, in the brand
brown and cream, as inline SVG (no image file, no third-party art). Four poses: `hello` (waving),
`pick` (holding a sparkle), `sleepy` (empty cart), `cheer` (order sent).

| Where | Pose | With it |
|---|---|---|
| Entry card `Who's ordering?` | `hello` | above the title |
| Cart, AI Pick card | `pick` | see below |
| Empty cart | `sleepy` | above `Your cart is empty.` |
| Order details (after sending) | `cheer` | beside the check mark line `Order sent` |

**AI Pick card** — on the cart page, between the cart lines and `Goes well with your order`:

- left: the mascot (`pick`); a small pill `AI Pick` with a sparkle icon;
- one line of text (the sentence);
- the suggested product: photo, name, price, and a button `Add` (a product that needs a choice opens its
  item page instead, as a pairing card does);
- a small `✕` (`aria-label="Hide AI Pick"`) hides the card for this visit to the table.
- After `Add`, the card shows the next suggestion if there is one, otherwise it goes away.
- Not shown: when there is no suggestion, when the cart is empty, past last order (W7 rule), offline.

The suggested product is never one already in the table's cart, never sold out, never outside its time
slot, and is dropped from `Goes well with your order` while the card shows it (no duplicate on one screen).

## 3. How the pick is chosen

Pure function `aiPick(menu, picks, mine, all, kinds, seed)` in `src/qr/aiPick.ts`:

1. Work out the **situation** from MY lines (available ones):
   - `drinks_only` — every line is a drink;
   - `food_only` — every line is food;
   - `solo_small` — exactly one unit in the whole table cart;
   - `mixed` — otherwise.
2. Candidates, in order, first non-empty wins:
   - `drinks_only` → pairings of my lines that are food; then popular food.
   - `food_only` → pairings that are drinks; then popular drinks.
   - `solo_small`, `mixed` → pairings of my lines (`cartPairs`); then popular.
   Each candidate must pass `validateLine(p, defaultLine(p)) === null` or be openable (it has choices) and
   not be in the table's cart.
3. Take the first candidate; the sentence comes from the list for that situation, chosen by `seed`
   (a number fixed per visit, so the sentence does not change on every refresh).

**Drink or food** — a new field on the category: `menu_categories.kind` — `'drink' | 'food' | null`
(null = neither; such products only take part in `mixed`). Set in the back office category editor
(`Type: Drink / Food / Other`). The QR menu RPC returns it per category.

**Sentences** (`src/qr/aiPickCopy.ts`, English, `{name}` = product name) — at least five per situation, e.g.:

- `drinks_only`: `A drink on its own? {name} would keep it company.` · `Something to nibble with that? Try {name}.`
- `food_only`: `That needs a drink. {name} goes down well with it.` · `Thirsty work, eating. {name}?`
- `solo_small`: `Treat yourself — {name} is a favourite here.` · `Room for one more? {name}.`
- `mixed`: `Tables like yours often add {name}.` · `One for the table: {name}.`

Rules for the copy: no health or allergy claims, no "best", no price talk, at most 60 characters before
the name is filled in.

**Seam for later** — the card takes `{ product, sentence }`; a future source may replace `sentence`
(falling back to the picked one when it fails or is slow). Nothing else is built for it now.

## 4. Server (one small migration, dev first)

`supabase/migration-2026-11-22-menu-category-kind.sql` (+ verify):

- `alter table menu_categories add column if not exists kind text check (kind in ('drink','food'))`.
- The QR menu function and the POS menu read return `kind` with each category (re-create from current
  text; additive field — an older client ignores it).
- The category save RPC accepts `kind`.

## 5. Client

- `src/qr/Mascot.tsx` — `<Mascot pose size />`, inline SVG, `aria-hidden`; a CSS bounce on mount, off under
  `prefers-reduced-motion`.
- `src/qr/aiPick.ts` (+ test), `src/qr/aiPickCopy.ts` (+ a test that every sentence obeys the copy rules).
- `src/qr/AiPickCard.tsx` (+ test) — the card; `CartPage` places it and removes its product from the
  pairing strip; `QrApp` holds `aiHidden` and the seed.
- `GuestCard`, `CartPage` (empty state), `SentPage` — place the mascot.
- Back office category editor — the `Type` choice.
- `PosCategory` gains `kind?: 'drink' | 'food' | null`.

## 6. Failure and edge cases

| Case | What happens |
|---|---|
| No category has a kind yet | Situation is always `mixed`/`solo_small`; the card still works from pairings and popular. |
| No picks at all (new outlet) | No card. |
| Add fails | The card stays, with the cart's error line (`Not added — …`). |
| The picked product leaves the menu at the minute refresh | The next candidate, or no card. |

## 7. Testing

Unit: situations, candidate order, exclusion of cart items / sold out / other slot, stable sentence per
seed, copy rules. Component: card content, Add, Add on a product with choices opens the item page, hide,
not shown past last order. Dev browser check at phone size: all four mascot places; set Demo categories'
kinds; drinks-only cart suggests food.

## 8. Rollout

SQL → back office (so kinds can be set) → QR build. Without kinds the card still works.
