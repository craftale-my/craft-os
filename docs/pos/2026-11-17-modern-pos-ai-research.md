# Modern POS front ends and AI: research for the Craft OS POS

Date: 2026-11-17. Web research only. Method: WebSearch plus WebFetch of vendor help centres and press pages. Confidence tags: [fetched] = page content read directly; [search] = taken from a search-result summary, page not opened (Toast marketing pages returned 403); [vendor claim] = vendor's own figure, unverified.

## 1. Summary

- Split bill: the leaders converge on four tools: split by item (move items onto a new check), split by seat (one tap, shared items auto-divided), split evenly (N ways, whole check or a single item), and split by amount (partial tender on the payment screen). Square and Toast offer all four; Lightspeed, Eats365 and Qashier cover item plus amount/cover splits; no source showed any of them using AI for splitting.
- The picker pattern that recurs is a two-pane screen: original check on one side, numbered split checks on the other, tap an item to move it, per-item overflow menu to share one item across N splits (Eats365, Toast, Square). Seat split is a single button when seats were captured at order time.
- Known traps to design around: shared items create fractional lines; modifiers and item-level discounts must travel with the item; bill-level discounts and service charges stay behind (Square, Toast both document this); you cannot add items after a payment is taken (Eats365).
- AI that is actually shipped is mostly back-office and customer-facing, not counter order entry: Toast IQ conversational assistant (Oct 2025), Square AI assistant and phone voice ordering plus kiosk voice (Oct 2025), Lightspeed AI insights (Jan 2026), iCHEF QR-order recommendations and natural-language menu editing (Oct 2025), QashierGM (Malaysia, availability inconsistent). Server-side upsell prompts (Toast Menu Upsells) are only in waitlist beta.
- I found no shipped product where AI listens to a cashier and fills the POS. Voice ordering is for phone, kiosk and drive-thru. For a café counter, the proven speed gains are non-AI: repeat/favourites from member history, default modifiers, conversational modifier buttons, and shop top-sellers when there is no history.
- Best fit for a small café: a mostly-deterministic upsell/pairing strip driven by the last 45 days of own sales (iCHEF's approach) is cheap and measurable; leave LLM features to manager-side chat over sales data and menu editing, with human approval before any action (Qashier's pattern).

## 2. Split bill patterns in leading POS

| Product | By item | By seat | Evenly | By amount | Notes / source |
|---|---|---|---|---|---|
| Square for Restaurants | Yes: Actions > Split check > Split by item, select items, Create New Check, Save All. Single item can be split into portions (evenly or custom amounts) | Yes, needs seat tracking on; each seat gets a check; multi-seat items divide evenly | Yes: Split evenly, choose N ways | Payments only: divide a total into payments by amount, not by item | Needs Restaurants Plus/Premium. Modifier cost splits with parent item; item discounts and service charges move with the item (by seat); cart-level discounts stay on original. Cannot split sell-by-unit items; voiding one portion recombines the item. [fetched] https://squareup.com/help/us/en/article/8165-split-a-payment-and-check-with-square-for-restaurants |
| Toast | Yes: Split screen, "tap and drop" items to a new check; swipe left to right to view splits | Yes: one tap if seats assigned; "split item between selected seats" (listed for AU/CA/IE/UK) | Yes: on payment screen "Split evenly", enter N; Amount Tendered shows each share. Also per-item even split | Yes: enter partial Amount Tendered, pick tender type, Balance Due remains | Item splits do not carry service charges or item discounts, reapply per check. Over nine ways: use amount method. Requires "Split Checks" permission; table service and quick order only. [fetched] https://intercom.help/toast-central/en/articles/14725434-split-checks-on-the-pos |
| Lightspeed Restaurant (K-Series) | Item shares can be edited between checks | Yes: Split check > Distribute by seat; shared items divided across seats; tap Split next to a shared item to adjust shares | Yes, "by covers": adjust covers with +/- and tap "Split receipt - X parts" | Not described in the article | Must enable "Advanced check splitting" in the device profile. Third-party note that auto-divided shared items can leave fractional lines (secondary source). [fetched] https://k-series-support.lightspeedhq.com/hc/articles/360051089493-Splitting-a-bill ; secondary: https://www.blogicsystems.com/blog/restaurant-pos-systems-handling-split-checks |
| Lightspeed O-Series | Not confirmed | Not confirmed | Yes: Check Out > Split Payment > Split divides evenly each time | Not confirmed | [search] https://o-series-support.lightspeedhq.com/hc/articles/31329418475419 |
| TouchBistro | Via seat/shared items | Yes: splits out all seats, opens the bill of the seat cashing out; shared items prorated | Yes: "Split Evenly By #" | Not confirmed | Splitting one item among seats only after the item is sent to the kitchen. [search] https://cdn.touchbistro.com/help/articles/checkout and https://cdn.touchbistro.com/help/articles/specifying-seats-for-a-shared-item |
| Clover | Yes (per third-party list) | Yes (per third-party list) | Yes (Clover blog) | Custom amount (third-party list) | Clover's own help steps not retrieved; low confidence. [search] https://blog.clover.com/creating-your-own-restaurant-split-check-policy ; https://www.blogicsystems.com/blog/restaurant-pos-systems-handling-split-checks |
| Eats365 (HK/MY) | Yes: Pay > Split Bill icon > Split by item; Add creates splits; tap item on main bill to move into selected split; tap again to return; three-dot menu per item divides its cost among N splits; paid splits show "Paid" | Not found | Yes via Split by amount: slider sets number of payers (max 30), total divided evenly | Yes: tap an amount to override; drop-down merges splits | Layout: main bill list plus splits panel; top-right Discard, Print Split, Print Original. After any split is paid, no more items can be added. [fetched] https://eats365pos.helpjuice.com/handling-payments/perform-a-split-bill-by-item-or-split-bill-by-amount |
| Qashier (MY) | Yes | Not stated | Yes (RM186 split three ways example) | Yes | Pay at table with card, DuitNow QR, Apple/Google Pay, TnG eWallet, GrabPay; dynamic DuitNow QR per bill. [fetched] https://qashier.com/my/restaurant-pos-system/ |
| StoreHub (MY) | Yes | By guest | Yes | Mixed tenders (card, DuitNow QR, cash on one bill) | From a StoreHub blog and a "split open orders" update post, undated. [search] https://www.storehub.com/my/blog/pos-system-for-bar-malaysia ; https://www.storehub.com/blog/storehub-updates-up-your-customer-service-game |
| Feedme (MY) | Yes | Not stated | Yes | By percentage | Marketing-style guide, not official help. [search] https://kcgroup.biz/feedme-pos-system-malaysia/ |
| Loyverse | Yes: three-dot menu on open ticket > Split ticket, tap items, "Move here"; up to 20 tickets | No | No | No | Merge: tick tickets in the Open tickets list, Merge icon. [fetched via search] https://help.loyverse.com/help/how-split-open-ticket-loyverse-pos ; https://help.loyverse.com/help/how-merge-open-tickets-loyverse-pos |

Not covered: SpotOn and Owner.com split-check documentation (not searched in depth); iChef split behaviour (not found).

Design takeaways for the by-item picker:
1. Two panes, original check left, N split checks right; tap to move, tap again to return; undo is just moving back (Toast, Eats365).
2. Per-item overflow action "Share between N" for one bottle or one platter (Square, Toast, Eats365). Square cannot split fractional-quantity items.
3. Seat split should be one button, offered only if seats were recorded at order time (Square, Toast, Lightspeed).
4. Decide up front where discounts and service charge go: item-level follows the item, bill-level stays and is re-applied or prorated (Square, Toast). Craft already has a pro-rata bill-discount design.
5. Lock item adding once any split is paid (Eats365).
6. Evenly and by-amount live on the payment screen as tender behaviour (Toast), while item and seat live on a separate Split screen.

## 3. Ordering speed and clarity patterns

| Pattern | Who | Source |
|---|---|---|
| Repeat/reorder from member history: look up member, open history, tap Reorder, returns to the order screen to confirm | Eats365 (member order history) | [search] https://support.eats365pos.com/use-member-order-history-to-reorder |
| Favourites and recent orders shown at the start of the transaction once a loyalty member is attached; if no history, show the shop's top 10 most-ordered items | Joe Coffee (cafe ordering/loyalty platform) | [search] https://support.joe.coffee/hc/en-us/articles/35445684927892-Customer-Favorites |
| Recent orders on loyalty/profile attach; modifiers pre-filled from the previous order if ordered within the last 30 orders | Otter POS | [search] https://helpdesk.tryotter.com/hc/en-us/articles/36523678200723 |
| Guest profile on the POS: notes, past orders, last order date, count, spend; auto-created from card payments and takeaway/delivery orders; searchable Guest Directory | Toast (Guestbook) | [search] https://support.toasttab.com/en/article/Look-Up-Guest-Profiles-and-Guestbook-Data-on-the-POS |
| Default modifier selection per modifier; modifier set order defined per item; optional "conversational modifiers" buttons (Add / No / Extra); sold-out modifiers pushed to the bottom | Square for Restaurants | [search] https://squareup.com/help/us/en/article/5119-create-and-manage-item-modifiers ; https://squareup.com/help/us/en/article/6426-modifiers-and-categories-with-square-for-restaurants |
| Picture-based category tiles and an always-visible cart; vendor claims up to 30% faster order entry (kiosk) | Square Kiosk | [fetched, vendor claim] https://squareup.com/us/en/press/square-releases-food-beverage |
| Fire by item prep time and course pacing so the kitchen receives items on a schedule; fire time counts from 0:00 when fired; expediter can override | Toast KDS | [search] https://doc.toasttab.com/doc/platformguide/adminFireByPrepTime.html ; https://doc.toasttab.com/doc/platformguide/platformKDSWorkflowUsingCoursePacing.html |
| Pacing dashboard and on-POS alerts for service timing and table pacing (monitoring, not shown to throttle orders) | Lightspeed Tempo | [search] https://www.lightspeedhq.com/pos/restaurant/tempo/ |
| Online-order throttling: cap orders per 15-minute slot | Checkmate, Per Diem, Olo (not POS front ends, but the pattern for QR/Grab load) | [search] https://support.itsacheckmate.com/hc/en-us/articles/19166627767195-Order-Throttling |
| QR table ordering with fewer duplicate steps for servers; Tableside on iPhone with Tap to Pay | Lightspeed (Oct 2025 release) | [search] https://www.lightspeedhq.com/news/lightspeed-commerce-unveils-q3-product-innovations-designed-to-help-merchants-run-smarter-and-serve-better/ (the Oct 2025 detail came via a search summary; confirm in release notes) |
| Multichannel menu management: edit once, sync to online, kiosk, third-party delivery | Square | [fetched] https://squareup.com/us/en/press/square-releases-food-beverage |

Not found: any POS doc for predictive/typeahead product search or specific "order-ahead recall" screens beyond the reorder items above. Do not assume they exist.

## 4. AI features

### Shipped (generally available per sources)

| What | Who | How it works at the counter / for staff | Source |
|---|---|---|---|
| Toast IQ conversational assistant: ask in chat to run tasks (e.g. add a server to a shift), analyse menu and suggest actions from sales data; included with Toast POS at no extra cost per Toast; US iOS, Android, Toast Now and web | Toast, Oct 2025 | Manager-side chat, not order entry. Vendor figures (e.g. a Coca-Cola menu-optimisation lift) are vendor claims | [search] https://pos.toasttab.com/news/toast-expands-toast-iq-smart-ai-assistant ; https://pos.toasttab.com/au/products/toast-iq |
| AI Guest Feedback tools (organise, prioritise, analyse feedback) and AI marketing assistant | Toast, 2025 | Back office | [search] https://pos.toasttab.com/innovation-hub/spring-2025 |
| Square AI assistant: industry/location context (weather, events), auto-updating dashboard widgets, mobile access with voice control, suggested questions | Square, Oct 2025 | Owner/manager Q&A over their own data | [fetched] https://squareup.com/us/en/press/square-releases-food-beverage |
| AI voice ordering by phone: answers calls, takes the order, handles customisations, sends confirmed orders to kitchen/POS; calls logged in Square Messages | Square, announced Oct 8 2025 | Customer talks to AI, not the cashier. Regional availability and pricing not verified | [fetched] https://squareup.com/us/en/press/square-releases-food-beverage ; https://techcrunch.com/2025/10/08/square-launches-ai-voice-ordering-and-an-integrated-bitcoin-solution-for-merchants |
| Square Kiosk with voice ordering and 21.5 inch display | Square | Customer-facing self-order. Date of the second article unclear | [search] https://www.fastcasual.com/news/square-launches-ai-voice-ordering-kiosk-for-restaurants/ |
| Lightspeed AI: conversational access to performance insights inside Lightspeed Restaurant; AI-powered benchmarks and trends in Europe (Jul 2025) | Lightspeed, Jan 2026 | Back office insights. I found no AI order-entry feature | [search] https://www.lightspeedhq.com/news/lightspeed-commerce-launches-lightspeed-ai-a-new-ai-powered-intelligence-layer-for-retail-and-hospitality/ |
| AI recommendation in QR ordering: last 45 days of sales data to pick bestsellers and pairings shown in premium positions on the customer's QR screen; vendor claim up to 25% of customers tap the AI-recommended item and over NT$3,000 per restaurant per month | iCHEF (Taiwan), Oct 2025 | Customer-facing on QR order screen. Vendor claims | [fetched] https://technews.tw/2025/10/21/ichef-creates-an-ai-assistant-for-restaurant-management/ |
| Smart menu assistant: describe a change in plain language to batch-update prices and set-meal options; auto multilingual menu translation; AI help for finding settings; sales diagnostic reports | iCHEF | Back office, no new hardware | [fetched] same iCHEF link |
| Picked for You, AI feature in online ordering | SpotOn, Jul 2025 | Customer-facing online ordering | [search] https://www.spoton.com (SpotOn announcement; exact URL not opened) |
| QashierGM: "AI general manager" answering questions from the group's data (e.g. which outlet turns tables slowest); acts only after approval, within user permissions, big changes wait for a manager | Qashier | Manager-side. Malaysia pages disagree on "coming soon" vs "is here", so verify availability | [fetched] https://qashier.com/my/restaurant-pos-system/ |
| Third-party phone voice AI that writes orders into the POS and KDS (Loman, Maple) for SpotOn, Clover and others | Partners, Jan 2026 and later | Phone only. Vendor claims such as 96% calls resolved are unverified | [search] https://www.businesswire.com/news/home/20260128093558/en ; https://maple.inc/integrations/clover |
| Owner.com AI phone ordering: answers every call, takes the order, sends to kitchen | Owner.com | Phone only. Launch date not pinned down | [search] https://www.owner.com/ai-phone-ordering |
| Drive-thru voice AI feeding items one by one into the order and kitchen screens (Bojangles with Hi Auto, Dec 2025); PAX voice drive-thru (May 2025) | Hi Auto, PAX | Customer at speaker; not a counter cashier tool | [search] https://hi.auto/company/newsroom/the-fast-food-drive-thru-just-got-a-new-operating-system/ ; https://www.pax.us/about/press-room/ai-voice-drive-thru-solution-for-qsrs |
| Feedme AI assistant "Remy", dish descriptions generated from the inventory system on menu upload, AI campaigns for near-expiry ingredients | Feedme (sponsored article) | Back office | [search] https://vulcanpost.com/864658/feedme-pos-fnb-restaurants-malaysia/ |

### Announced, beta, or unconfirmed

| What | Who | Status | Source |
|---|---|---|---|
| Menu Upsells: prompts staff to suggest add-ons (e.g. burger and fries triggers "upgrade to truffle fries") inside order entry on Toast Go handhelds and terminals; recommendations set per item or at start of dining; dashboard shows upsell counts, share of sales, top upsell items, per-employee performance | Toast | Limited/waitlist beta via Toast Test Kitchen; early release | [search] https://pos.toasttab.com/innovation-hub/spring-2025 |
| Toast IQ pairing suggestions that automate upsells in servers' tools | Toast | Described as capability, tied to the beta above | [search] https://pos.toasttab.com/news/toast-launches-toastiq-superpower-future-of-restaurants |
| Chunjiao (春嬌) chain management assistant: forecast footfall, sales and prep volume with hyperlocal weather, on POS, membership and inventory data via MCP | iCHEF with RevtelTech, Google Cloud, Gemini | Slated for launch before Christmas 2025 as paid add-on; launch not confirmed | [fetched] https://technews.tw/2025/10/21/ichef-creates-an-ai-assistant-for-restaurant-management/ |
| Lightspeed Tempo expansion to Kitchen Display connectivity | Lightspeed | Stated roadmap only | [search] https://www.lightspeedhq.com/news/lightspeed-commerce-unveils-tempo-a-revolutionary-new-pacing-intelligence-for-restaurants/ |
| Clover Assistant (analytics via natural language) | Clover | Only a low-quality third-party page found; no Clover primary source. Treat as unconfirmed | [search] https://spice.alibaba.com/spice-basics/clover-assistant |
| Native Clover or TouchBistro AI ordering | Clover, TouchBistro | Nothing found in official sources | n/a |

Gap statement: no source showed an AI that transcribes counter conversation into a cashier's order, and no source showed AI-assisted split billing. Both would be novel for this POS, so treat as experiments, not parity items.

## 5. Recommendations for a small café POS (ranked by impact vs effort)

1. **Split bill by item, two-pane picker** (Quick win to Medium). Original check plus numbered splits, tap to move, tap back to undo, per-item "share between N", Pay per split with a Paid badge, lock add-items after first payment, Print original and per split. Reapply or prorate bill-level discounts and service charge per the pro-rata design; item-level discounts and modifiers travel with the item. Source pattern: Eats365, Toast, Square (section 2).
2. **Even split and amount split on the payment screen** (Quick win). N-ways stepper showing each share, plus editable amount per payer and mixed tender (cash, card, DuitNow QR) with Balance Due. Toast and Eats365 pattern. Covers the most common café case without seats.
3. **Default modifiers and conversational modifier buttons** (Quick win). Per-modifier default selection, per-item modifier order, Add/No/Extra buttons, sold-out modifiers sunk to the bottom. Square pattern.
4. **Repeat last order and favourites by member** (Medium). Attach loyalty member, show Recent plus Favourites first, "Repeat" returns to the order screen to confirm, modifiers pre-filled; when no history show the shop's top 10. Eats365, Joe Coffee, Otter patterns. Feasible since the member base (about 1k) already exists.
5. **Pairing/upsell strip from own sales data, no LLM** (Medium). Rule-based "frequently bought with" computed from the last 45 days (iCHEF approach), shown as one dismissible chip row on the order screen; log accepts per staff to measure. Toast's equivalent is still in beta, so keep it simple and measurable. Vendor uplift numbers are unverified.
6. **Split by seat** (Medium, only if dine-in seat capture is wanted). Needs a seat selector at order time; one button to distribute by seat with shared items shown as editable shares. Skip if cashiers will not enter seats.
7. **Prep-time-aware kitchen firing and slow-order alerts** (Medium). Per-item prep time to stagger firing, ticket age timers, and a simple Grab/QR throttle cap per 15 minutes when the kitchen is overloaded (Toast, Lightspeed Tempo, Checkmate patterns).
8. **Manager chat over sales and menu data with approval gate** (Big). Natural-language questions ("which outlet turns tables slowest") and natural-language bulk price edits, executing only after manager approval within user permissions (QashierGM, iCHEF smart menu pattern). Good fit later once the data is reliable.
9. **AI phone ordering** (Big, buy not build). Vendors integrate into existing POS via order injection (Loman, Maple, Square-native). Only worth it if phone orders are material for the cafés.
10. **Voice order entry at the counter** (Big, experimental). No shipped precedent found; accuracy risk with Manglish and mixed Malay, English and Chinese; keep out of the near-term plan.

## Source reliability notes
- Toast marketing pages (pos.toasttab.com innovation hub, news) returned 403 to the fetcher; Toast facts above marked [search] come from search-engine summaries of those pages plus the fetched Toast help article.
- Vendor uplift figures (Square 30% faster kiosk, iCHEF 25% click-through, Toast Coca-Cola lift) are marketing claims.
- Several results carried future-looking dates (2026); the environment date is 2026-11-17, so these are plausible but not cross-checked.
