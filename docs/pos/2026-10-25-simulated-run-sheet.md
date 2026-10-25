# Simulated business run — POS pre-pilot (Demo branch)

Date: 2026-10-25 · Project: **craft-os-dev** · Branch: Demo (`918afa23-e0d8-41b4-8ca3-19b3447479a6`)

The after-hours script the owner runs on site with two iPads, the ZyWell ZY301 and the print agent,
before the pilot. Every expected figure below was computed by `tools/run-sheet/figures.ts` from the
Demo menu on dev with the POS's own totals rules (`src/features/pos/checkout/bill.ts`). If a price,
a service-charge rule or a payment method changes, run the query at the end again and regenerate this
sheet. Bill numbers are not known in advance: bills are named by their table.

## Before you start

- iPad **A** (counter) and iPad **B** (floor) on `/pos`, signed in as staff of Demo. Someone with
  **Approve POS voids & refunds** and a POS PIN is the approver for every "approver + PIN" below.
- The print agent runs with `BRANCH_ID=918afa23-e0d8-41b4-8ca3-19b3447479a6` and a login of Demo staff; the ZY301 is on
  with paper. Receipts go to Bar.
- Set a print route (Bar or Kitchen) on /menu for P1–P5 (or their categories' products), then regenerate
  this sheet so the ticket lines name the printer. A product without a route prints no ticket.
- Close any open shift of Demo and pay or void every open bill **before** the facts are read (`facts.sql`).
  If you do it afterwards, run `facts.sql` again and regenerate this sheet: the expected Z report counts
  the voids since the last close. When the facts were read: shift open **no**,
  open bills **0**.
- Wrong PINs are counted per **login**: five wrong tries lock that login out of the approver for 10 minutes
  on every iPad signed in with it. Give each cashier their own login on the pilot iPads.
- A phone with a camera for the QR order.
- Cash variance limit RM 5.00; SST registered: yes;
  cash rounding: nearest_5_sen.

| Code | Product (as on the bill) | Dine-in | Takeaway | QR | SST | Packaging fee | Printer | Used for |
|---|---|---|---|---|---|---|---|---|
| P1 | 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's | 42.00 | 42.00 | 42.00 | 6% | 0.00 | - | counter, takeaway and the offline order |
| P2 | Baked Salmon Steak | 43.00 | 43.00 | 43.00 | 6% | 1.00 | - | with a packaging fee |
| P3 | Aglio Olio | 25.00 | 25.00 | 25.00 | 0% | 1.00 | Kitchen | 0% SST — Meat Up \| Choose One: Fried Chicken |
| P4 | 5.5'inch Earl Grey Mango Cake | 85.00 | 85.00 | 85.00 | 6% | 0.00 | - | set meal — Dessert Serve: Serve NOW |
| P5 | Crocheted Rose | 15.00 | 15.00 | 15.00 | 6% | 0.00 | - | the QR order |

Service-charge rules (first match wins): 10% on dine_in.
Payment methods used: Cash (cash), Maybank Terminal (card), DuitNow QR (QR).

## Steps

| Step | Who | Do | Expect |
|---|---|---|---|
| 1 | A | No shift open yet. Table **T9** → 1 × 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's → Send. Tap the item → Void item, reason "Wrong item keyed", approver + PIN. Then **Void bill**, reason "Test bill" (approver + PIN if the dialog asks). | VOID ticket for 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's → no ticket (no printer route). T9 is free again. Both voids appear in this shift's Z report (made since the last close). |
| 2 | A | **Open shift**, opening float **RM 200.00**. | Top bar: "Shift open · since HH:MM". |
| 3 | A + B together | A: **T1**, pax 2 → 2 × 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's + 1 × Baked Salmon Steak → Send. B at the same moment: **T2**, pax 1 → 1 × 5.5'inch Earl Grey Mango Cake (Dessert Serve: Serve NOW) + 1 × Aglio Olio (Meat Up \| Choose One: Fried Chicken) → Send. | Tickets: 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's, Baked Salmon Steak → no ticket (no printer route) / no ticket (no printer route); 5.5'inch Earl Grey Mango Cake, Aglio Olio → no ticket (no printer route) / Kitchen. T1: subtotal RM 127.00 · service charge RM 12.70 · SST RM 7.62 · rounding RM -0.02 · **total RM 147.30**. T2: subtotal RM 110.00 · service charge RM 11.00 · SST RM 5.10 · rounding RM 0.00 · **total RM 126.10**. |
| 4 | Phone | Open **T1**'s QR link → 1 × Crocheted Rose → Place order. | A: T1 marked new; ticket → no ticket (no printer route). T1: subtotal RM 142.00 · service charge RM 14.20 · SST RM 8.52 · rounding RM -0.02 · **total RM 164.70**. |
| 5 | B (A watches T2) | A opens T2's bill panel. B: T2 → tap Aglio Olio → Void item, reason "Wrong item keyed", approver + PIN. | A's T2 panel drops the item within 2 s. VOID ticket → Kitchen. T2: subtotal RM 85.00 · service charge RM 8.50 · SST RM 5.10 · rounding RM 0.00 · **total RM 98.60**. |
| 6 | B | **Move table** T2 → **T5**. | T2 free, T5 occupied. T5: subtotal RM 85.00 · service charge RM 8.50 · SST RM 5.10 · rounding RM 0.00 · **total RM 98.60**. |
| 7 | A | **Takeaway** → 1 × Baked Salmon Steak + 1 × 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's → Send. Note its bill number. | Takeaway prices. Takeaway: subtotal RM 85.00 · SST RM 5.16 · takeaway packaging RM 1.00 · rounding RM -0.01 · **total RM 91.15**. |
| 8 | A | T1 → **Merge** → choose the takeaway bill. | T1 keeps the takeaway's packaging fee: subtotal RM 227.00 · service charge RM 14.20 · SST RM 13.68 · takeaway packaging RM 1.00 · rounding RM 0.02 · **total RM 255.90**. (Before rounding: T1 RM 164.72 + takeaway RM 91.16 = RM 255.88, the merged bill's own RM 255.88.) |
| 9 | A + B | A: T5 → **Checkout** (leave the sheet open). B: T5 → Checkout → Cash → cash received **RM 100.00** → Pay. | B: change **RM 1.40**, receipt prints. A's sheet locks with the red note "This bill was paid on another iPad — do not charge the card terminal." — only **Close** works. A taps Close. |
| 10 | A | T1 → Checkout → Maybank Terminal **RM 127.00** → Add; Cash **RM 128.90**, cash received **RM 130.00** → Add → Pay RM 255.90. | Change **RM 1.10**; the receipt lists both payments and the takeaway packaging. |
| 11 | A | **T3** → 1 × 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's → Send. Then **Void bill**, reason "Customer left", approver + PIN. | VOID ticket → no ticket (no printer route). T3 (RM 48.70) is voided and free again. |
| 12 | B | **Today's bills** → T5's bill → **Refund** RM 5.00 to Cash, reason "Quality complaint", approver + PIN. | Refund slip prints; Today's bills shows the refund on T5's bill. |
| 13 | A | **Pay in** RM 20.00, reason "Float top-up". Then **Pay out** RM 15.00, reason "Ice", approver + PIN. | Each sheet says it was recorded. |
| 14 | A (offline spell) | Turn A's Wi-Fi off. **T6**, pax 1 → 1 × 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's → Send. Wi-Fi on. | While off: "1 order waiting to send". After: it sends by itself, ticket → no ticket (no printer route). T6: subtotal RM 42.00 · service charge RM 4.20 · SST RM 2.52 · rounding RM -0.02 · **total RM 48.70**. |
| 15 | A (unsure reply, on the iPad) | On iPad A (Safari): T6 → Checkout → DuitNow QR RM 48.70 → Add. Wi-Fi off → **Pay**. Wi-Fi on → **Check bill** → **Pay**. | Off: "Not sure the payment went through…", method buttons, amounts and remove locked, only Try again / Check bill / Back. (Safari reports the dropped request as "Load failed": if the sheet shows "TypeError: Load failed" with the lines unlocked instead, the unsure-reply lock fails on the iPad — fail this step.) Check bill: "The bill is still open — the payment was not recorded. Check the lines and press Pay." Pay: paid, receipt prints. |
| 16 | A | **Close shift** → count the drawer: enter **RM 427.50** → Close. | No open bills warned. Closes at once (variance 0.00). The Z report prints on the receipt printer and shows on screen — compare it with the next section. |

## Expected Z report

The printed report has these lines (times and names are left out; a value is flush right on paper).

| Line | Value |
|---|---|
| **SUMMARY** | |
| Bills | 3 |
| Pax | 4 |
| Nett sales | 403.20 |
| Average per bill | 134.40 |
| Average per pax | 100.80 |
| Void bills | 2 |
| Total void | 109.00 |
| Total refund | 5.00 |
| **SALES SUMMARY** | |
| Gross sales | 354.00 |
| Takeaway fee | 1.00 |
| Service charge | 26.90 |
| SST | 21.30 |
| Rounding | 0.00 |
| Nett sales | 403.20 |
| **PAYMENTS** | |
| Cash (2) | 227.50 |
|   Refunds (1) | -5.00 |
|   Net | 222.50 |
| DuitNow QR (1) | 48.70 |
|   Net | 48.70 |
| Maybank Terminal (1) | 127.00 |
|   Net | 127.00 |
| **ORDER TYPE** | |
| Dine-in (3) | 403.20 |
| Takeaway (0) | 0.00 |
| **SOURCE** | |
| Counter (4 orders) | 339.00 |
| QR (1 order) | 15.00 |
| **CASH DRAWER** | |
| Opening float | 200.00 |
| Cash sales | 227.50 |
| Cash refunds | -5.00 |
| Pay in: Float top-up | 20.00 |
| Pay out: Ice | -15.00 |
| Expected cash | 427.50 |
| Counted cash | 427.50 |
| Variance | 0.00 |
| **VOIDS SINCE THE LAST CLOSE** | |
| 1 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's (T9, step 1) | 42.00 |
| Bill (T9) voided, Test bill |  |
| 1 Aglio Olio (T2, step 5) | 25.00 |
| 1 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's (T3, step 11) | 42.00 |
| Bill (T3) voided, Customer left |  |
| **REFUNDS** | |
| (T5's bill) Cash, Quality complaint | 5.00 |
| **PRODUCT SALES** | |
| 4 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's · 168.00 |  |
| 2 Baked Salmon Steak · 86.00 |  |
| 1 5.5'inch Earl Grey Mango Cake · 85.00 |  |
| 1 Crocheted Rose · 15.00 |  |

## Results

| Step | Expected | Seen | Pass / fail |
|---|---|---|---|
| 1 | VOID ticket for 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's → no ticket (no printer route). T9 is free again. Both voids appear in this shift's Z report (made since the last close). | | |
| 2 | Top bar: "Shift open · since HH:MM". | | |
| 3 | Tickets: 1 Set Knitted Flowers ( Rose , Sunflower , Tulip ) 81's, Baked Salmon Steak → no ticket (no printer route) / no ticket (no printer route); 5.5'inch Earl Grey Mango Cake, Aglio Olio → no ticket (no printer route) / Kitchen. T1: subtotal RM 127.00 · service charge RM 12.70 · SST RM 7.62 · rounding RM -0.02 · **total RM 147.30**. T2: subtotal RM 110.00 · service charge RM 11.00 · SST RM 5.10 · rounding RM 0.00 · **total RM 126.10**. | | |
| 4 | A: T1 marked new; ticket → no ticket (no printer route). T1: subtotal RM 142.00 · service charge RM 14.20 · SST RM 8.52 · rounding RM -0.02 · **total RM 164.70**. | | |
| 5 | A's T2 panel drops the item within 2 s. VOID ticket → Kitchen. T2: subtotal RM 85.00 · service charge RM 8.50 · SST RM 5.10 · rounding RM 0.00 · **total RM 98.60**. | | |
| 6 | T2 free, T5 occupied. T5: subtotal RM 85.00 · service charge RM 8.50 · SST RM 5.10 · rounding RM 0.00 · **total RM 98.60**. | | |
| 7 | Takeaway prices. Takeaway: subtotal RM 85.00 · SST RM 5.16 · takeaway packaging RM 1.00 · rounding RM -0.01 · **total RM 91.15**. | | |
| 8 | T1 keeps the takeaway's packaging fee: subtotal RM 227.00 · service charge RM 14.20 · SST RM 13.68 · takeaway packaging RM 1.00 · rounding RM 0.02 · **total RM 255.90**. (Before rounding: T1 RM 164.72 + takeaway RM 91.16 = RM 255.88, the merged bill's own RM 255.88.) | | |
| 9 | B: change **RM 1.40**, receipt prints. A's sheet locks with the red note "This bill was paid on another iPad — do not charge the card terminal." — only **Close** works. A taps Close. | | |
| 10 | Change **RM 1.10**; the receipt lists both payments and the takeaway packaging. | | |
| 11 | VOID ticket → no ticket (no printer route). T3 (RM 48.70) is voided and free again. | | |
| 12 | Refund slip prints; Today's bills shows the refund on T5's bill. | | |
| 13 | Each sheet says it was recorded. | | |
| 14 | While off: "1 order waiting to send". After: it sends by itself, ticket → no ticket (no printer route). T6: subtotal RM 42.00 · service charge RM 4.20 · SST RM 2.52 · rounding RM -0.02 · **total RM 48.70**. | | |
| 15 | Off: "Not sure the payment went through…", method buttons, amounts and remove locked, only Try again / Check bill / Back. (Safari reports the dropped request as "Load failed": if the sheet shows "TypeError: Load failed" with the lines unlocked instead, the unsure-reply lock fails on the iPad — fail this step.) Check bill: "The bill is still open — the payment was not recorded. Check the lines and press Pay." Pay: paid, receipt prints. | | |
| 16 | No open bills warned. Closes at once (variance 0.00). The Z report prints on the receipt printer and shows on screen — compare it with the next section. | | |
| Z report | Every line of the section above | | |

## Regenerating this sheet

1. Close any open shift of Demo and clear its open bills first. Then run `tools/run-sheet/facts.sql` in
   the SQL editor of **craft-os-dev** (read-only) right before the run, and save its one `facts` cell as a
   JSON file. Make no other voids and close no shift on Demo after that — if you do, run it again and
   regenerate.
2. `node --experimental-strip-types --no-warnings tools/run-sheet/figures.ts <facts.json> docs/pos/2026-10-25-simulated-run-sheet.md`
