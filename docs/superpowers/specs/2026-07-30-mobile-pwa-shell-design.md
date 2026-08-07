# Mobile PWA Shell — Design

**Date:** 2026-07-30
**Branch:** `feature/po-system`
**Goal:** Craft OS should feel like an installed app on a phone, not a website in a browser tab.

## Problem

Craft OS is a Vite + React SPA. On a phone it reads as a web page: the browser
address bar takes the top of the screen, navigation is a hamburger button
opening a drawer, and there is no way to put it on a home screen. Staff use this
on their phones during shifts, so the browser chrome is pure overhead.

## Scope

In:

- Installable shell — manifest, icon set, `standalone` display, status-bar tint
- Safe-area handling for notches and home indicators
- Mobile bottom tab bar replacing the hamburger top bar
- Install guidance, including the iOS Share ▸ Add to Home Screen recipe
- Native-feel touch details (no tap highlight, no double-tap zoom delay)

Out (deliberately — YAGNI):

- Service worker and offline caching. Every screen reads from Supabase, so
  offline would show empty pages, not useful ones. Without offline the service
  worker earns nothing.
- Push notifications
- Gesture-driven back navigation and page transition animations
- Any change to the desktop layout

## Decisions

### No `vite-plugin-pwa`

That plugin's value is generating a service worker and its precache manifest. We
are not doing offline, so it would pull in Workbox and a registration lifecycle
we don't want, to deliver a `manifest.json` we can write by hand. Hand-rolled:
one manifest file and eight `<meta>` tags.

### Icon is the monkey mark alone, on cream

The full brand logo is the mark plus "CRAFT" plus "CAFE". Rendered at the ~60px
a home-screen icon actually occupies, "CAFE" collapses into a grey smudge and
"CRAFT" is barely legible — and fitting three elements forces the mark itself to
be small. Cropping to the mark lets it fill 80% of the canvas and stay
recognisable at real size.

Icons are committed under `public/icons/` rather than generated at build time;
they are static brand assets, not build output. `scripts/generate-icons.py`
regenerates them from `public/craft-logo.jpg` if the logo changes. It is stdlib
only (macOS `sips` decodes the JPEG; crop/composite/downsample happen in
Python), so it needs no PIL or ImageMagick.

The maskable variant fills only 60% of the canvas. Android launchers crop
maskable icons to a circle or squircle; at 80% the monkey loses its ears.

### No mobile top bar

Every one of the app's 26 pages already renders its own `<h1>`. The brown
`Craft OS` top bar existed only to host the hamburger button, so once navigation
moves to the bottom the bar is 38px of pure cost per screen. Removing it lets
content start directly below the status bar, which is what a native app does.

The safe-area top inset *is* the status bar height, so `padding-top:
env(safe-area-inset-top)` plus each page's existing `py-8` yields the status bar
followed by 32px of breathing room. No page needed changing.

### Tab selection is a rule, not a table

The bar fits five slots and the fifth is always More, leaving four real
destinations. Instead of a hand-maintained tab set per role, `pickTabIds` takes
an ordered candidate list, filters it by capability, and truncates to four:

| Role | Tabs |
| --- | --- |
| Staff (no `view_team`) | Profile · Attendance · Schedule · Missions |
| Manager (`view_team` + `use_procurement`) | Team · Schedule · Tasks · Orders |
| Supervisor (`view_team`, no procurement) | Team · Schedule · Tasks · Attendance |

A role nobody anticipated still lands on a sensible four, and the bar is never
left short. The rule lives in `src/shared/lib/tabs.ts` with no React import so it
can be unit-tested directly; labels, routes and icons live in `BottomTabs`.

### More reuses the existing drawer

More opens `SidebarContent` as a left drawer — the same component, unchanged,
that the hamburger opened. A bottom sheet would be more native, but
`SidebarContent` is laid out for a 240px vertical rail (user card, four capability
-filtered sections, sign out); moving it into a full-width sheet means re-laying
out every item. Reusing it is zero rework and zero regression risk. Noted as the
one place where pragmatism beat maximum native feel.

### iOS status bar must be `default`

`apple-mobile-web-app-status-bar-style` is set to `default`, **not** the commonly
copy-pasted `black-translucent`. `black-translucent` forces white status-bar
text, which is invisible against this app's cream background. With `default` plus
`theme_color: #F5F0E8`, iOS renders dark text on cream. Chrome on Android derives
dark status-bar icons from the same light `theme_color` automatically.

`background_color` is also cream, so the launch screen, the icon and the first
painted screen are the same colour — opening the app has no flash of a different
shade.

### `overscroll-behavior-y: contain`, not `none`

`contain` stops the document chaining its scroll to the viewport (the main
"this is a web page" tell) while leaving Android's pull-to-refresh working.
`none` would also kill the iOS rubber-band, but in standalone mode
pull-to-refresh is the only way to force fresh data, and this app's data goes
stale within a shift. One-word change if that trade-off is ever revisited.

`user-select: none` is applied only to the tab bar and buttons, never globally —
globally it would stop staff copying values out of the payslip table in
`HrSalary`.

## Files

New:

- `public/manifest.webmanifest`
- `public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon-180}.png`
- `scripts/generate-icons.py`
- `src/shared/lib/tabs.ts` + `tabs.test.ts`
- `src/shared/lib/pwa.ts`
- `src/shared/components/BottomTabs.tsx`
- `src/shared/components/InstallPrompt.tsx`

Changed:

- `index.html` — `viewport-fit=cover`, manifest link, theme-color, Apple meta
- `src/index.css` — safe-area custom properties, `--tabbar-h`, touch details,
  and a mobile-only cap on the pages' own `min-h-screen`
- `src/App.tsx` — `AppLayout` reserves tab-bar space, applies insets, mounts
  `BottomTabs` and `InstallPrompt`
- `src/shared/components/Sidebar.tsx` — `SidebarContent` exported; `Sidebar` is
  now desktop-only
- `src/features/staff/StaffProfile.tsx` — back link to the team dashboard

### The `min-h-screen` cap

Pages set `min-h-screen` on their own wrapper, which was correct when the page
owned the whole viewport. Now that `AppLayout` also reserves tab-bar height
below, short pages ended up a screenful *plus* a tab bar tall, leaving dead
scroll. A single rule caps it on phones:

```css
@media (max-width: 639px) { main > .min-h-screen { min-height: 0; } }
```

It sits outside `@layer` deliberately, so it outranks the `min-h-screen`
utility.

## Install guidance

`InstallPrompt` renders inside `AppLayout`, so it appears only after sign-in and
never covers the login form.

- **Android / desktop Chrome** — listens for `beforeinstallprompt`, calls
  `preventDefault()` to suppress Chrome's own mini-infobar, and shows an Install
  button wired to `prompt()`.
- **iOS** — fires no such event and exposes no install API, so it shows the
  two-step Share ▸ Add to Home Screen recipe.

Hidden when `display-mode: standalone` matches, when `navigator.standalone` is
true, or when the user has dismissed it (`localStorage`, key
`craftos.install-prompt.dismissed`). Also hides on `appinstalled`. All
`localStorage` access is wrapped — private mode must not crash the app.

## Desktop safety

Every mobile-only rule is `sm:`-scoped or lives inside a `sm:hidden` component.
The safe-area insets are applied unconditionally because `env(safe-area-inset-*)`
resolves to `0px` in a desktop browser — which also means iPad and landscape
phones get correct insets without extra breakpoints.

## Verification

- `pickTabIds` unit tests cover staff, manager, supervisor, the four-tab cap and
  uniqueness — the only branching logic added.
- `npx tsc -b` clean; full suite 75 tests passing.
- Manifest served as `application/manifest+json`; all four icons 200 `image/png`;
  every `<meta>` value confirmed in the running app; all Tailwind
  arbitrary-value classes confirmed present in the generated stylesheet.
- Visual verification at a 390×844 viewport.
