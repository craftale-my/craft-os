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
   - **Everyone (logged in):** `/profile`, `/tasks`, `/hr/*`
   - **Supervisor + Manager:** `/dashboard`, `/staff/:id`, `/probation/:staffId`, `/schedule`
   - **Manager only:** `/missions`, `/settings`
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
- **Task management (Kanban)** (`/tasks`) — Board-style task tracking for the team.
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

**Source of truth: [`supabase/schema.sql`](supabase/schema.sql).** This file defines all
tables, triggers, RLS policies, storage buckets, and seed data. Treat it as canonical.

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

### Row Level Security

**RLS is used throughout.** Policies are defined in `schema.sql` and gate row access by
the requesting user and their rank (e.g. managers see all staff; staff see their own
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
- **Vercel project:** `craft-os` (org `craftale-my`), connected to the GitHub repo.
- **SPA routing:** `vercel.json` rewrites all paths to `/` so client-side routing works.

### How updates flow

```
push to GitHub (main)  →  Vercel auto-builds & deploys
```

Pushing to `main` triggers a production deploy on Vercel automatically. No manual deploy
step is required for application code.

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

- **Always test locally before pushing** — pushing to `main` deploys to production.
- **Database changes:** coordinate with the team before running any migrations. Schema
  changes are manual (run SQL in Supabase) and shared across everyone, so do not run
  migrations unilaterally. Update `supabase/schema.sql` to reflect any change you make.
