# Craft OS — Project Notes

> Internal handoff documentation. Last updated for the current `main` branch state.

---

## 1. Project Overview

**Craft OS** is the internal staff management system for **Craft Cafe**, operated by
**Craftale Sdn Bhd**. It started as a gamified staff progression tool (skill missions,
XP, level-ups to reduce turnover) and has grown into a broader operations platform
covering HR, scheduling, task management, and reviews.

**Tech stack:**

| Layer        | Technology                          |
| ------------ | ----------------------------------- |
| Frontend     | React 19 + Vite 6 + TypeScript      |
| Styling      | Tailwind CSS 3                       |
| Routing      | React Router 7                      |
| Icons        | lucide-react                         |
| Backend / DB | Supabase (Postgres, Auth, Storage)  |
| Hosting      | Vercel                              |

Build commands (see `package.json`):

- `npm run dev` — local dev server (Vite)
- `npm run build` — type-check (`tsc -b`) then production build
- `npm run preview` — preview the production build locally
- `npm run lint` — ESLint

---

## 2. Architecture

### Folder structure (`src/`)

The app is organized **by feature**, not by file type. Each feature folder owns its
pages and feature-specific components; cross-cutting code lives under `shared/`.

```
src/
├── App.tsx                 # Routes + layout shell (Sidebar + main)
├── features/
│   ├── auth/               # AuthContext, Login, Register, ProtectedRoute
│   ├── onboarding/         # Onboarding flow for new staff
│   ├── staff/              # Dashboard (manager/supervisor), StaffProfile
│   ├── missions/           # Missions CRUD + completion approvals
│   ├── reviews/            # ProbationReview (3-day review)
│   ├── tasks/              # Tasks (Kanban board)
│   ├── schedule/           # Shift scheduling
│   ├── hr/                 # HrAttendance, HrSalary, HrLeave, HrClaims
│   └── settings/           # General Settings (company config)
└── shared/
    ├── components/         # Sidebar, RankBadge, XPBar, SkillDots,
    │                       #   StarRating, ScoreChart, Avatar, ErrorBoundary
    ├── lib/                # supabase.ts, supabase-admin.ts, xp.ts, csv.ts
    └── types/              # index.ts — shared TypeScript types
```

> Note: a recent refactor moved files from the old flat `components/`, `pages/`,
> `contexts/`, and `lib/` folders into the `features/` + `shared/` layout above.
> If you see references to the old paths, they are stale.

### How auth works

Authentication is **Supabase Auth (email/password)** layered over an application-level
`staff` table:

1. `AuthProvider` (`src/features/auth/AuthContext.tsx`) wraps the app and tracks the
   current Supabase `user` plus the matching `staff` row.
2. Every Supabase Auth user maps to one row in the `staff` table (keyed by the auth
   user id). The `staff` row holds the application identity: name, **rank**, level, XP,
   branch, onboarding status, etc.
3. `ProtectedRoute` guards routes. It can require login and optionally a minimum rank
   via `requireRank={['supervisor', 'manager']}`. `OnboardingRoute` handles the
   not-yet-onboarded state.
4. Route access by rank (see `src/App.tsx`):
   - **Everyone (logged in):** `/profile`, `/hr/*`
   - **Supervisor + Manager:** `/dashboard`, `/staff/:id`, `/probation/:staffId`, `/schedule`
   - **Manager only:** `/missions`, `/settings`
   - **Tasks & Projects** (`/team/tasks`, `/team/tasks/archive`, `/team/projects`,
     `/team/projects/:id`) all require the `view_team` capability, which the `staff`
     role does not have — the module is management-only, deliberately. `/tasks` is
     kept only as a redirect to `/team/tasks` (old bookmarks / installed PWAs).
   - After login, managers/supervisors land on `/dashboard`; everyone else on `/profile`.

### How the rank / level / XP system works

- **Rank progression:** `trainee → junior → senior → supervisor → manager`.
- **Levels** accumulate within ranks; **XP** drives leveling (≈500 XP per level).
- XP is awarded when a **mission completion is approved**. This is enforced in the
  database by a trigger (`award_xp_on_approval`) on `mission_completions`, so the level
  math is authoritative server-side rather than computed in the client.
- Rank-specific colors and XP helpers live in `src/shared/types/index.ts` and
  `src/shared/lib/xp.ts`.

---

## 3. Features Implemented

- **Staff leveling & missions** — Staff complete skill missions, submit proof, and earn
  XP on manager approval. Managers create/edit missions (`/missions`); approvals trigger
  XP + level updates.
- **Onboarding flow** (`/onboarding`) — Guided first-run flow for newly approved staff
  before they reach the main app.
- **Monthly performance reviews** — Recurring performance reviews recorded per staff
  member (`monthly_reviews` table) and surfaced on the staff profile.
- **3-day probation reviews** (`/probation/:staffId`) — Early probation check-in for new
  hires (`probation_reviews` table).
- **Tasks & Projects** (`/team/tasks`, `/team/projects`) — Management-only
  (`view_team`) Kanban task board, plus Projects to group related tasks.
  - **Board** — three fixed columns (todo / in progress / done); manual
    drag-to-reorder within a column.
  - **Tags** — free-form, typeahead-assisted, de-duplicated by a normalized `slug`
    (`Urgent` and `urgent` collapse to the same tag).
  - **Checklists** — per-task sub-items; each item can be assigned an owner.
  - **Attachments** — multiple files per task; deleting one also removes the
    stored file.
  - **Projects** (`/team/projects/:id`) — owner, dates, status, and a progress
    bar computed from their tasks.
  - **Archive** (`/team/tasks/archive`) — the board's Done column only shows
    tasks completed in the last 14 days; older completed tasks are searchable
    here.
  - **Live sync** — task changes broadcast over Supabase Realtime so open
    boards stay in sync across sessions.
- **HR module** (`/hr/*`):
  - **Attendance** — Clock in/out with **GPS location + selfie** capture.
  - **Salary records** — Stored payroll records for compliance (see §7).
  - **Leave** — Leave entitlements and leave requests/approvals.
  - **Claims** — Expense claims with receipt uploads.
- **Shift scheduling** (`/schedule`) — Supervisor/manager shift planning.
- **General Settings** (`/settings`, manager only) — Company info, branches, roles,
  XP/system rules, and notification settings.
- **Staff registration requests** — Prospective staff register (`/register`); requests
  land in `registration_requests` for manager approval before a `staff` record is created.

---

## 4. Database

> **`schema.sql` is stale for RLS policies.** Several later migrations `drop policy` and
> recreate policies that still appear in their original form in `schema.sql`, which was never
> updated to match. `attendance_manage`, `attendance_select_own` and others were replaced by
> `migration-2026-07-08-rls-system-role.sql` — the live versions also allow
> `current_system_role() in ('hr','supervisor','manager','admin','owner')`, which the
> `schema.sql` text does not mention. Before relying on any policy, run
> `grep -n "<policy_name>" supabase/schema.sql supabase/migration-*.sql` and take the LAST
> definition, not the one in `schema.sql`. A guard trigger written against the stale text
> silently under-permits exactly the accounts the RBAC migration exists to serve.

**Source of truth: [`supabase/schema.sql`](supabase/schema.sql)** for everything except
the seven Tasks & Projects tables below. Those were added by three dated migration
files under `supabase/` that have been run against production but not folded back into
`schema.sql`:

- `migration-2026-08-14-tasks-projects.sql` — creates all seven tables plus their RLS
  policies, the `project_progress` view, and the `has_task_cap()` permission function.
  `tasks` and `task_comments` had never existed in this Supabase project — they were
  created ad hoc in the old `vvxg` project and never carried over in the 2026-07-05
  migration to the current project. So this is a clean create, not a migration of
  existing data.
- `migration-2026-08-14-checklist-assignee.sql` — adds an `assigned_to` column to
  `task_checklist_items` so an individual checklist item can carry its own owner
  (distinct from the parent task's assignee).
- `migration-2026-08-14-tasks-upsert-fn.sql` — adds an `upsert_tag()` Postgres function
  and switches tag creation to call it. `supabase-js`'s `.upsert()` can't express
  "keep the existing row's values on conflict", so the previous client-side upsert let
  whoever typed a tag second silently overwrite the original tag's display name and
  creator.

Until someone folds these into `schema.sql`, treat the migration files as canonical for
the tables they touch.

Two further dated migrations add the late-reason and notification feature. **They have
not been run yet.**

- `migration-2026-09-02-late-reason-notifications.sql` — adds `staff.supervisor_id`, five
  `late_*` columns on `attendance`, the `notifications` table with its RLS, the
  `excuse_lateness()` function, and guard triggers. Also seeds a `late_reason_written_threshold`
  row in `system_rules` and an `attendance_late` row in `notification_settings`.
- `migration-2026-09-02-notify-late-fn.sql` — adds `notify_late()`, which writes the
  notification rows, and backfills `staff.supervisor_id` from each person's most recent
  monthly-review reviewer, falling back to their branch's person-in-charge.

**Run them in that order, and run them BEFORE the code is pushed.** This is a hard gate,
not a preference: after this feature, every clock-in writes `late_reason_code` and
`late_reason` — punctual ones included — so deploying the code against a database without
those columns stops everyone clocking in, not just people arriving late. Pushing to `main`
deploys automatically, so the push is the point of no return.

One more consequence of running them late rather than early: `countLateDays()` in
`Reviews.tsx` filters on `late_excused`, and a query against a column that does not exist
fails. Until the SQL runs, a monthly review will not be able to show a late count.

A third file, `migration-2026-09-02-rejudge-boundary-late.sql`, is optional and separate. It
re-judges historical attendance rows that the old "any second past the start is late" rule
flagged, and which the whole-minute rule would not. It is written in three steps — dry run,
backup table, then the update — and is meant to be read before it is applied.


### Major tables

| Table                   | Purpose                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `staff`                 | Application identity per auth user: rank, level, XP, branch.   |
| `missions`              | Catalog of skill missions staff can complete.                 |
| `mission_completions`   | Submitted/approved completions; XP trigger fires here.        |
| `skill_ratings`         | Per-skill ratings for staff.                                  |
| `monthly_reviews`       | Monthly performance review records.                           |
| `probation_reviews`     | 3-day probation review records.                               |
| `registration_requests` | Pending sign-up requests awaiting manager approval.           |
| `company_settings`      | Company-level configuration (name, logo, etc.).              |
| `branches`              | Café branch/location records.                                 |
| `roles`                 | Configurable job roles.                                       |
| `system_rules`          | Configurable XP / system rules.                              |
| `notification_settings` | Notification preferences/config.                             |
| `attendance`            | Clock in/out events with GPS + selfie.                       |
| `salary_records`        | Stored salary/payroll records (records only — see §7).        |
| `leave_entitlements`    | Per-staff leave balances.                                     |
| `leave_requests`        | Leave applications and their status.                          |
| `claims`                | Expense claims with receipts.                                 |
| `projects`               | Groups related tasks; owner, dates, status, progress.        |
| `tasks`                  | Task cards: status, priority, project, assignee, `position`. |
| `tags`                   | Free-form task labels, de-duplicated by a normalized `slug`. |
| `task_tags`              | Join table linking `tasks` to `tags`.                        |
| `task_checklist_items`   | Per-task checklist sub-items; each can carry an owner.       |
| `task_attachments`       | Files attached to a task; `storage_path` lets deletion clean up the file too. |
| `task_comments`          | Comments on a task.                                          |

### Row Level Security

**RLS is used throughout.** Policies are defined in `schema.sql` (or, for the Tasks &
Projects tables, their own migration files — see above) and gate row access by the
requesting user and their rank (e.g. managers see all staff; staff see their own
records). When adding tables or columns, add matching RLS policies — a table without
policies will be inaccessible to the anon/auth client.

---

## 5. Environment Setup

### Required `.env.local` variables

```bash
VITE_SUPABASE_URL=          # your Supabase project URL
VITE_SUPABASE_ANON_KEY=     # Supabase anon/public key
```

> A `SUPABASE_SERVICE_ROLE_KEY` may also be used by admin tooling
> (`src/shared/lib/supabase-admin.ts`). **Never** expose the service role key to the
> browser or commit it — see §7.

### Getting Supabase credentials

In the Supabase dashboard → **Project Settings → API**:

- **Project URL** → `VITE_SUPABASE_URL`
- **anon / public** key → `VITE_SUPABASE_ANON_KEY`
- **service_role** key → server/admin use only (keep secret)

### Run locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (default http://localhost:5173).

---

## 6. Deployment

- **GitHub repo:** https://github.com/craftale-my/craft-os
- **Vercel project:** `craft-os` (org `craftale-my`).
- **SPA routing:** `vercel.json` rewrites all paths to `/` so client-side routing works.

### How updates flow

```
push to GitHub (main)  →  Vercel auto-builds & deploys to production
```

`main` is therefore a **live release branch** — anything merged into it ships. Land work
on a feature branch and merge deliberately.

> **History, so nobody re-breaks this.** The project was created from the CLI on
> 2026-06-30 and was never linked to the repo, so for its first month every deploy came
> from `vercel deploy` and pushes did nothing — while these notes claimed otherwise.
> The repository was connected on 2026-08-01. If deploys ever stop following pushes,
> check Project → Settings → Git before assuming anything else.

### Deploying by hand

Still possible, and still the fallback if the Git connection breaks:

```bash
vercel deploy --prod --yes
```

**Run it from a clean checkout of `main`, not from your working tree.** The CLI uploads
whatever is in the current directory, so any half-finished work sitting uncommitted will
ship to production. When the working tree is dirty:

```bash
git worktree add /tmp/deploy-main main
cp -R .vercel /tmp/deploy-main/.vercel     # carries the project link
cd /tmp/deploy-main && vercel deploy --prod --yes
git worktree remove /tmp/deploy-main       # when done
```

### Confirming a deploy actually landed

**Do not compare asset
hashes against a local build** — Vercel builds on a different Node version, so the
hashes differ even when the source is identical (verified 2026-08-01: the same commit
built to 842.63 kB on Vercel and 839.53 kB locally). Grep the live bundle for a string
that only your change introduces:

```bash
BUNDLE=$(curl -s https://craft-os-tale.vercel.app/ | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -s "https://craft-os-tale.vercel.app$BUNDLE" | grep -c "some new UI string"
```

A UI label from the feature works well; it survives minification as a string literal.

If the git integration is ever repaired in the Vercel dashboard, replace this section —
a push would then be enough on its own.

### ⚠️ Database changes are NOT automated

Schema changes are **not** part of the Vercel deploy. To apply DB changes you must
**manually run the SQL in the Supabase dashboard** (SQL editor) against the project.
Keep `supabase/schema.sql` updated to match whatever you run.

---

## 7. Known Considerations

- **Payroll is NOT automated.** `salary_records` stores records only; the app does not
  compute payroll. This is intentional for compliance reasons — calculations are handled
  outside the system.
- **Service role key is sensitive.** Never commit it and never ship it to the client.
  It bypasses RLS. Keep it in server-side/admin environments only.
- **Storage buckets needed:**
  - `mission-proofs`
  - `task-attachments`
  - `attendance-selfies`
  - `claim-receipts`
  - `medical-certificates`
  - `company-assets`

  > ⚠️ Discrepancy to resolve: `supabase/schema.sql` currently seeds only
  > `company-assets`, `claim-receipts`, and `leave-attachments`. The remaining buckets
  > above must be created in Supabase Storage (and given appropriate policies) for all
  > features to work. Verify and reconcile the bucket list against the schema before
  > relying on file uploads.

---

## 8. For New Developers

### Getting access

- Ask a current maintainer to add you as a **collaborator** on the
  [GitHub repo](https://github.com/craftale-my/craft-os) and on the **Vercel** and
  **Supabase** projects (under the `craftale-my` org).

### Recommended workflow

```bash
git clone https://github.com/craftale-my/craft-os.git
cd craft-os
cp .env.example .env.local   # then fill in your Supabase values
npm install
npm run dev
```

- **Always test locally before pushing** — merging to `main` deploys to production. See §6.
- **Database changes:** coordinate with the team before running any migrations. Schema
  changes are manual (run SQL in Supabase) and shared across everyone, so do not run
  migrations unilaterally. Update `supabase/schema.sql` to reflect any change you make.
