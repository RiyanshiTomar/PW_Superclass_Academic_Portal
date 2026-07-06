# Superclass Portal — by PhysicsWallah

Academic operations portal: Central Team creates reusable **lecture planners** (CSV upload, per-lecture faculty), assigns them to batches, and faculty see only their own schedule with hours, a calendar, and reschedule/cancel requests. Overlap validation prevents a faculty being double-booked.

Built with **Next.js 16**, **React 19**, **Tailwind CSS 4**, and **Supabase** (auth + Postgres).

## Roles / portals
- **Admin** (`/admin`) — manage centres, programs, faculty, central team, branch heads, batch managers.
- **Central Team** (`/central`) — Batch Scheduler (batches + weekly timetable) and Batch Planner (Create / Assign / Edit) + Reschedule Requests.
- **Faculty** (`/faculty`) — My Batches (hours), My Planners (confirm), Calendar (reschedule/cancel).
- **Branch Head** (`/branch`), **Batch Manager** (`/batch-manager`).

Login is passwordless (Supabase magic link) restricted to `@pw.live` emails.

## Local setup
```bash
npm install
cp .env.example .env      # fill in your Supabase values
npm run dev               # http://localhost:3000
```

### Database
Run these in the Supabase SQL Editor (once, in order):
1. `scripts/schema.sql` — full schema for a **fresh** project (drops & recreates everything).
2. `scripts/migration-planners.sql` — planner tables (only if you already ran an older schema; idempotent & additive).

Then seed reference data locally:
```bash
npm run import-data       # needs SUPABASE_SERVICE_ROLE_KEY in .env + the CSVs in repo root
```

## Environment variables
| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | app + build | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | app + build | public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | local scripts only | secret; not needed on Vercel |

## Deploy to Vercel
1. Push this repo to GitHub.
2. In Vercel: **New Project → Import** the repo (framework auto-detected as Next.js).
3. Add env vars `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Production + Preview).
4. Deploy. After it's live, in **Supabase → Authentication → URL Configuration** add your Vercel URL to **Site URL** and **Redirect URLs** (e.g. `https://your-app.vercel.app/**`).

After the first deploy, **every `git push` to the production branch auto-deploys**; pull requests get preview deployments.

## Planner CSV format
Header row required; columns matched by name (any order, extra columns ignored):

`Subject, Chapter, Topic, Faculty Email, Date, Start Time, End Time, Duration`

- **Required:** Chapter, Topic, Faculty Email (registered active faculty), Date (`YYYY-MM-DD`).
- **Optional:** Subject, Start/End Time (`HH:MM`), Duration (minutes). Give Start + End and the length is auto-calculated; else Duration (default 60).

See `scripts/planner-template.csv`.

## Security note
RLS is currently **disabled**; access is enforced at the route level via `proxy.ts`. Before a real production launch, enable RLS with per-role policies.
