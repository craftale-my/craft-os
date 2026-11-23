# Org Chart — design

Date: 2026-10-23
Status: approved in conversation, pending implementation plan

## Problem

Supervisors are set one staff member at a time (Directory → profile →
Personal → Edit → Supervisor). Nobody can see at a glance who still has no
supervisor, so late-arrival notifications for those staff fall back to every
branch manager. Staff also have no way to see who they report to beyond the
read-only Supervisor row on their own profile.

## Goals

1. A company org chart, built from `staff.supervisor_id`, that every signed-in
   staff member can open (read-only).
2. Each viewer sees their own reporting line: direct supervisor and every level
   above, up to the owner.
3. Managers see who has no supervisor and assign one from the same page
   without opening each profile.

## Non-goals

- Merging duplicate accounts (two "Hnin Myat Noe Oo"; "Alin" / "Vandulin(alin)").
  The chart will make them visible; merging is separate work.
- Changing an *existing* supervisor from the chart. That stays on the profile
  page's Edit form.
- Drag-and-drop editing.

## Route and navigation

- New route `/org-chart`, wrapped in `ProtectedRoute` with no capability.
- New top-level nav leaf `{ id: 'org-chart', label: 'Org Chart', to: '/org-chart' }`
  placed directly after Profile in `src/shared/lib/nav.ts`. It is not nested
  under Team because the Team group requires `view_team`, which plain staff do
  not have, and the chart must be reachable by everyone.

## Who can assign

The same people who can set Supervisor on the profile page today:
`currentStaff.rank === 'manager'` (see `StaffProfile.tsx` `isManager`). Writes
go through the existing `staff` UPDATE path, so the existing UPDATE RLS keeps
deciding what is allowed.

## Data

### `get_org_chart()` — new SQL function

`security definer`, `stable`, `set search_path = public`, granted `execute` to
`authenticated` only (revoked from `public` and `anon`). Returns one row per
staff member with `status = 'active'`:

| column          | source                                  |
|-----------------|-----------------------------------------|
| `id`            | `staff.id`                              |
| `name`          | `staff.name`                            |
| `nickname`      | `staff.nickname`                        |
| `avatar`        | `staff.avatar`                          |
| `rank`          | `staff.rank`                            |
| `system_role`   | `staff.system_role`                     |
| `job_title`     | `roles.name` via `staff.job_title_id`   |
| `branch`        | `staff.branch`                          |
| `department`    | `staff.department`                      |
| `supervisor_id` | `staff.supervisor_id`                   |

No IC number, phone, address, date of birth or notes. Today `staff_select` is
`to authenticated using (true)` (a parallel change, 2026-10-23, is removing
`anon` access), so the function is not strictly needed for reads right now; it
exists so that a later narrowing of `staff_select` (self / same branch) does
not break the chart, and so the chart never pulls sensitive columns.

### Cycle guard — new trigger on `staff`

`before insert or update of supervisor_id`. Rejects the write when the new
`supervisor_id` equals the row's own `id`, or when walking up from the new
supervisor reaches the row's `id` (a loop). The walk is bounded (e.g. 100
steps) so pre-existing bad data cannot hang it. Error message in English:
`Supervisor would create a reporting loop`.

Both live in one idempotent migration file
`supabase/migration-2026-10-23-org-chart.sql`. `schema.sql` and
`FRESH_BUILD_full.sql` are not touched: neither carries `supervisor_id` today,
and a parallel session is editing `schema.sql`. Run on `craft-os-dev` first,
then prod.

## Tree logic — `src/features/orgchart/orgTree.ts` (pure, unit-tested)

Input: the RPC rows. Output:

- `roots`: staff with `system_role = 'owner'`. Several owners render side by
  side.
- `childrenOf(id)`: direct reports, sorted by rank (manager → supervisor →
  senior → junior → trainee), then name.
- `unassigned`: every non-owner who is not reachable from an owner. This
  covers three cases, each tagged with a reason:
  - `none` — `supervisor_id` is null
  - `inactive` — `supervisor_id` points to someone not in the active list
  - `broken` — has a supervisor, but the chain never reaches an owner (a loop
    in existing data, or a chain ending at an unassigned person). Only the
    *top* of each broken chain is listed; their reports stay under them.
- `chainOf(id)`: the list from that person's direct supervisor up to the root,
  stopping at the first repeat so bad data cannot loop.
- `descendantsOf(id)`: used to exclude someone's own reports from their
  supervisor picker.

If there is no owner at all, the page shows an empty-state message telling
managers to set an owner in Settings, and lists everyone as unassigned.

## UI — `src/features/orgchart/OrgChart.tsx`

Top to bottom:

1. **My reporting line** (everyone): a horizontal strip
   `You → <Direct> (Direct) → … → <Owner>`. When the viewer has no supervisor:
   `You don't have a supervisor yet.` The owner sees `You're at the top.`
2. **Unassigned banner** (managers only, hidden when zero):
   `⚠ N staff have no supervisor` with a toggle that opens the assign list.
   Each row: avatar, name, branch, department, reason tag
   (`No supervisor` / `Supervisor inactive` / `Not connected to owner`), and a
   Supervisor select. Picking a value saves immediately
   (`staff.update({ supervisor_id })`), shows a spinner on that row, then
   refetches the chart. Errors (including the cycle-guard message) show inline
   on the row. Options: all active staff except the person and their
   descendants, sorted by rank then name, labelled `Name · Rank · Branch`.
3. **Search box**: type a name; matching people are listed; choosing one
   expands every ancestor, scrolls the card into view and highlights it for a
   few seconds.
4. **The tree**: top-down cards with connector lines, in a horizontally
   scrollable container. Card shows avatar, name (nickname in brackets if
   set), rank, job title, short branch name. Cards with reports have a
   collapse toggle with the count (`▾ 4` / `▸ 4`). Default expansion: roots
   plus two levels below. The viewer's own card carries a `You` badge, and
   the cards along their reporting line get a subtle accent. Managers clicking
   a card go to `/staff/:id`. For everyone else, cards are not links. The
   viewer's own reporting line is expanded on load, so their card is visible.
5. **Not connected to the owner yet** (everyone): below the main tree, the top
   of each unassigned chain renders as its own small tree (collapsed), so
   nobody disappears from the chart while their chain is broken.

`shortenBranch()` moves out of `Directory.tsx` into
`src/shared/lib/branches.ts` so the chart and the Directory share it.

Styling follows existing pages (brown palette, Archivo / STIX). It must work at
phone width; the tree scrolls sideways and the top sections stack.

## Copy

All UI text in English (see the product-copy rule). Strings are listed in the
UI section above.

## Testing

- `orgTree.test.ts`: roots, sort order, the three unassigned reasons,
  only-top-of-broken-chain, `chainOf` on normal and looping data,
  `descendantsOf`, no-owner case.
- `OrgChart.test.tsx`: banner hidden for non-managers and when zero;
  a picker change calls `staff.update` with the chosen id; picker excludes
  self and descendants; "You" badge and reporting-line strip render.
- `nav` test: `Org Chart` is visible to a role without `view_team`.
- SQL: after the migration on dev, verify the function returns no sensitive
  columns, `anon` cannot execute it, and the trigger rejects a self-reference
  and a two-step loop.
- Manual: preview the page on dev as a manager and as plain staff, desktop and
  phone width.
