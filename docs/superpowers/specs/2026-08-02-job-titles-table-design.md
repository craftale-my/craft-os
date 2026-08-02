# Job Titles table — ordering, grouping, department hygiene

**Date:** 2026-08-02
**Area:** Settings → Roles & Permissions → Job Titles

## Problem

The Job Titles table reads as disordered. Four distinct causes:

1. **Rows sort by rank alphabetically, not by seniority.** `Settings.tsx` loads roles with
   `.order('rank')`, and `roles.rank` is a `text` column, so Postgres sorts
   `junior → manager → senior → supervisor → trainee`. The rank hierarchy is destroyed.
   There is no secondary sort, so rows within one rank appear in insertion order.
2. **Rank labels are barista-specific.** `RANK_LABELS` maps `junior → "Junior Barista"` and
   `senior → "Senior Barista"`, so *Baker* displays rank "Junior Barista" and *Senior Kitchen*
   displays "Senior Barista". Non-barista departments are mislabelled.
3. **`roles.department` is free text.** The Add/Edit modal uses a plain `<input>`, while the app
   already has a `departments` lookup (slug + display name) and a `deptName()` helper. Live data
   contains `Barista`/`barista`, `Bakery`/`bakery`, and an off-list `Management`.
4. **Name and Rank read as duplicates.** "Junior Barista | Junior Barista",
   "Senior Barista | Senior Barista".

Cause 3 blocks the fix for cause 1: grouping by a free-text department would split one
department into several groups.

## Decisions

| # | Decision |
|---|----------|
| 1 | Make rank labels generic, app-wide (one constant, all consumers inherit). |
| 2 | Group the table by department; order within a group by seniority. |
| 3 | Normalise `roles.department` to canonical slugs **in production**, and make the modal a dropdown so it cannot drift again. |
| 4 | Give `Admin` a real home: add a `Management` department to the lookup, and split it out of the repurposed `other` bucket. |

### Correction found during implementation

The live `departments` table does not match `FALLBACK_DEPARTMENTS` in the code. It holds
`bakery` → "Bakery", `barista` → "Front House", `kitchen` → "Kitchen",
`night bar (basement)` → "Craftale Night Bar", and `other` → **"Management"**.

The catch-all slug had been renamed to "Management" and pressed into service as the real
management department: three staff sit under it (one trainee, two managers). Adding a second
department also displaying "Management" would have put duplicate entries in every department
dropdown in the app. So the migration additionally renames `other` back to "Other" and moves
those three staff onto the new `management` slug.

## Design

### 1. Generic rank labels

`src/shared/types/index.ts` — `RANK_LABELS`:

```
trainee → 'Trainee'      junior → 'Junior'       senior → 'Senior'
supervisor → 'Supervisor'   manager → 'Manager'
```

Rank becomes a cross-department seniority level. Every consumer reads the same constant
(`RankBadge`, `StaffProfile`, `Missions`, `Dashboard`, staff CSV export, Settings dropdowns),
so a single edit propagates. This also resolves problem 4 — "Junior Barista | Junior" no longer
repeats itself.

### 2. Grouped, seniority-ordered table

`JobTitlesTab` groups rows by department slug and renders one section per department:

- Group order follows `activeDepartments` (the lookup is already `.order('name')`).
  Slugs that match no lookup entry sort last, so nothing is ever hidden.
- Within a group: `RANK_ORDER.indexOf(rank)` ascending (Trainee → Manager), then name A–Z.
  The name tiebreak keeps row order stable across reloads.
- The **Department column is removed** and becomes the group heading, rendered via `deptName()`.
  Remaining columns: Name / Rank / Status / Actions — narrower, better on mobile.
- Sorting happens in the component, not the query, so it no longer depends on DB collation.

`Settings.tsx` roles query changes `.order('rank')` → `.order('name')`. **Side effect:** the same
query feeds the Career Paths dropdowns, which change from alphabetical-by-rank to alphabetical-by-name.
This is an improvement and is accepted.

### 3. Department dropdown

`RoleModal`'s Department `<input>` becomes a `<select>` populated from
`useLookups().departmentOptions(form.department)`. It stores the **slug**, never the display name.
`departmentOptions` injects the current value when it is not an active option, so editing a role
on a retired department does not silently reassign it.

### 4. Production data normalisation

`supabase/migration-2026-08-02-department-normalise.sql`:

0. Snapshots `roles`, `departments`, and `staff` into `backup_2026_08_02_*` tables.
1. Inserts a `Management` department (`slug: 'management'`) if absent.
2. Renames `other` back to "Other".
3. Moves staff on `other` to `management`.
4. Lowercases and trims `roles.department`, which lands `Admin` on the new `management` slug.

Ends with verification queries and a commented rollback block.

The project has **no dev Supabase — local development connects to production**. Therefore:
snapshot first, present the SQL for review, and run only on explicit approval.

Note the `roles` table is not readable with the anon key (RLS), so the verification queries must
run in the Supabase SQL editor rather than through the app's client.

## Out of scope

- Whether `Admin` belongs in Job Titles at all (it overlaps with System Roles). Keeping it,
  filed under Management.
- Reordering or renaming the System Roles tab.
- Chan Jie Ling, the one staff row with a null department — mid-onboarding, no branch either.

### Added after the first migration ran

**The `service crew` orphan.** Four trainees carried `department = 'service crew'`, a slug from the
old hardcoded list with no row in the live `departments` table. All four also had
`job_title_id = null` — concrete casualties of the case-sensitive auto-assignment bug described
above. `supabase/migration-2026-08-02-service-crew-backfill.sql` moves them to Front House,
assigns the existing "Service Crew" job title, and runs `initialize_staff_skills` for each, which
is what onboarding would have done.

## Verification

- Table renders three seeded departments plus Management, each ordered Trainee → Manager.
- A role saved through the modal stores a slug, and its row lands in the right group.
- `RankBadge` and the staff CSV export show the generic labels.
- Existing test suite passes.
