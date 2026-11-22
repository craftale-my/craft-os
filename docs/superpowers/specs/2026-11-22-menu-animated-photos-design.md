# Animated product photos (GIF) — design

Date: 2026-11-22 · Status: approved by the owner in conversation, awaiting review of this text
Builds on: `2026-10-24` slots and photos (product photo upload, bucket `menu-images`).

## 1. Goal

A product photo may be an animation. The back office accepts a GIF or an animated WebP, stores it as it
is, and every place that shows the product's photo plays it.

Out of scope: video files (MP4), converting GIF to a smaller format on the server, per-outlet photos.

## 2. What changes for people

**Back office — product editor, Photo section, and the import's Photos step**

- The picker already accepts any image (`image/*`, and the import's zip takes `.gif` names), so GIF and WebP
  need no change there; the hint text names them.
- A still picture goes through today's path unchanged: resized to at most 800 × 1600, re-encoded as WebP
  (JPEG on old Safari), about 100–200 KB.
- An **animated** file (a GIF with more than one frame, or an animated WebP) is uploaded as it is — the
  resize step draws one frame on a canvas and would freeze it.
  - Limit: **4 MB**. Larger: `The animation is too large (at most 4 MB). Trim it or lower its size and try again.`
  - Limit on its pixel size: at most 1200 px on the longer side. Larger:
    `The animation is too wide or tall (at most 1200 px). Export it smaller and try again.`
  - Under the preview the editor says `Animated · 2.3 MB` (`Animated · 340 KB` under 1 MB; the size is the
    stored file's Content-Length, just `Animated` when it cannot be read).
- A GIF with a single frame is a still picture and takes the still path.

**Guests (QR page) and the counter**

- The photo plays wherever it is shown: menu grid tile, list row, item page, pairing cards, and the
  counter's product tiles. It loops, silently, as GIFs do.
- A guest whose phone asks for reduced motion (`prefers-reduced-motion: reduce`) sees animations only on the
  item page; lists show nothing moving. (Decision: a first frame cannot be shown without a second file, so in
  lists such a guest sees the quiet placeholder the grid already uses for products without a photo.)

## 3. Decisions

- **Stored as uploaded, not transcoded.** Transcoding to animated WebP/MP4 needs a server-side encoder we
  do not have; 4 MB and lazy loading keep the page usable. To revisit if owners upload many.
- **4 MB / 1200 px.** A 3-second 600 px GIF is about 1–3 MB. The menu already loads photos lazily
  (`loading="lazy"`), so only animations near the screen are fetched.
- **How "animated" is decided:** in the browser, from the file's bytes — GIF: more than one image
  descriptor block; WebP: the `ANIM` chunk flag in the `VP8X` header. Pure functions with tests; no library.
- **The server keeps one rule for paths.** `menu_set_product_image` accepts
  `products/<product id>/<name>` ending in `.webp`, `.jpg`, `.gif` or `.anim.webp` (animated WebP — §5).

## 4. Server (one migration, dev first)

`supabase/migration-2026-11-23-menu-animated-photos.sql` (+ `-verify.sql`):

- Bucket `menu-images`: `file_size_limit` 2 MB → 4 MB; `allowed_mime_types` gains `image/gif`.
- `menu_set_product_image`: the path pattern also allows `.gif` and `.anim.webp`. Nothing else in it changes — re-create it
  from its current text.
- The table check `menu_products_image_path_check` pins the same suffixes; it is widened in step (drop + add).
- Verify script: bucket limit and types; the function accepts a `.gif` path and still refuses a path of
  another product or another extension; ends with `rollback; select 'VERIFY OK'`.

No new column: the product keeps one `image_path` (only its check constraint widens).

## 5. Client

- `src/features/pos/menu/photo.ts` — `PhotoMime` gains `'image/gif'`; `photoPath` maps it to `.gif`;
  new pure `isAnimatedGif(bytes)`, `isAnimatedWebp(bytes)`, `gifSize(bytes)` / `webpSize(bytes)` (pixel
  size from the header), `animationProblem({ bytes, width, height })` with the two messages above.
- `src/features/pos/menu/photoUpload.ts` — `uploadProductPhoto` reads the first bytes; an animated file
  skips `resizePhoto` and is uploaded with its own content type; everything after the upload (point the
  product at it, delete the old file, the lost-answer recovery) is the same code.
- Photo section + import Photos step — the hint texts, the `Animated · n MB` line (Photo section), the messages
  (both show `uploadProductPhoto`'s errors as they are).
- QR lists (`MenuGrid`, `MenuList`, `PickCard`, item page pairings) — a small `ProductPhoto` component in
  `qrParts.tsx` replaces the repeated `<img>` (the item page hero keeps its own `<img>` and always plays; the
  counter's `ProductTiles` already shows `imageUrl` in an `<img>`, which plays a GIF with no change): it knows a path ending in `.gif` (or a product flagged
  animated — see below) and applies the reduced-motion rule.
- An animated WebP cannot be told from a still one by its path.
  **Decision — animated WebP is saved with the suffix `.anim.webp`**; `photoPath` and the server pattern
  accept it, and `ProductPhoto` treats `.gif` and `.anim.webp` as animated.

## 6. Failure cases

| Case | What happens |
|---|---|
| Animated file over 4 MB or 1200 px | Refused before upload with the message; the product keeps its photo. |
| A file named `.gif` that is not a GIF | Falls to the still path; the canvas refuses it with today's `could not be read` message. |
| Old client (before this build) opens a product with a `.gif` photo | It shows it — an `<img>` plays a GIF without new code. |
| Front end deployed before the SQL | Upload fails at `menu_set_product_image` (path refused); the uploaded file is removed by the existing recovery. Rollout: SQL first. |

## 7. Testing

- Unit: the byte sniffers with small fixtures (1-frame GIF, 2-frame GIF, still WebP, animated WebP),
  sizes, `animationProblem`, `photoPath` for both new suffixes.
- `uploadProductPhoto`: animated skips resize and keeps content type; still path untouched.
- `ProductPhoto`: reduced motion hides list animations, item page still shows.
- Dev check in a browser: upload a GIF to a Demo product, see it play on the QR grid, list, item page and
  the counter tile; then remove it.

## 8. Rollout

SQL (dev, later prod) → back-office build → QR and POS builds. No data migration.
