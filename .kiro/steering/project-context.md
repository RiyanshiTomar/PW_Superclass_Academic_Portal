# Superclass Academic Portal — Project Context

This is a multi-role academic management portal for Superclass (PW — PhysicsWallah). Built with **Next.js 16.2.9** (App Router), **React 19**, **TypeScript 5**, **Supabase** (Postgres + Auth), **Tailwind CSS v4**. Deployed on Vercel. RLS is **disabled** on all tables — all access control is enforced in application code.

---

## Portals & Roles

| Role | Route | What they can do |
|---|---|---|
| `admin` | `/admin` | Manage centres, programs, faculty, users, audit log |
| `central_team` | `/central` | Full access — batch scheduler, planners, tests, audit, marks, results |
| `branch_head` | `/branch` | Own centre's batches, tests (add/edit), marks, attendance, results, batch scheduler (edit schedule only) |
| `batch_manager` | `/batch-manager` | Own assigned batches — batch scheduler (edit schedule only), tests (add/edit, no delete), marks, results, attendance |
| `faculty` | `/faculty` | Own schedule, planners, attendance, tests, results |
| `progress_reviewer` | `/progress-reviewer` | Read-only Batch Progress across ALL centres |
| `syllabus_editor` | `/admin/syllabus` | Only edit Concept Tags (subjects → chapters → topics) |

Multiple roles → `/choose-role` picker on login.

---

## Authentication

1. User logs in at `/login` with email/password
2. Supabase Auth callback at `/auth/callback` calls `link_auth_and_get_role(email, auth_id)` RPC
3. This links `app_users.auth_id` and returns roles + status
4. Redirects to role portal or `/choose-role` if multiple roles
5. `getAppUser()` in `lib/auth.ts` — looks up by `auth_id` first, then email fallback

---

## Core Features

### 1. Batch Scheduler (`components/central/BatchScheduler.tsx`)
- Create/edit batches: name, program, centre, start/end dates, manager, owner
- Weekly schedule: per subject → weekday + time + room + faculty
- **Schedule segments**: `batch_schedules.effective_from/effective_to` — timing can change mid-batch. Calendar ONLY shows slots whose date range is active for the selected date.
- Batch merge support
- Branch head & batch manager: can edit schedules only (no create/delete batch)

### 2. Planner System (`lib/planners.ts`, `components/central/EditPlanner.tsx`, `components/central/CreatePlanner.tsx`)

**CreatePlanner**: Generates one draft lecture row per (subject, class-date) from the batch schedule. Central fills chapter + topic (or uploads CSV/Excel). Empty future rows become buffer slots.

**Materialisation** (`assignPlanner()`): Converts planner template rows to concrete `batch_planners` rows. Each lecture inherits the weekly slot's time/room. Segments are respected. Lectures landing on wrong weekday snap forward to next valid class-date. After materialisation, `resolveTestConflicts()` shifts lectures that landed on existing tests.

**EditPlanner** — Two modes:
- **Template mode**: edits `planner_lectures` blueprint → re-materialises Draft/Rework links
- **Live (batch) mode**: edits `batch_planners` directly by ID. Never deletes unless user explicitly hits `×`. Preserves faculty-approved reschedules.

**Buffer slots**: `is_buffer=true` rows are reserved empty dates. Real lectures land on them when test shifts happen. "+add row" in live mode consumes next buffer. Buffer utilization tracked by `shifted_for_test_id IS NOT NULL`.

**Conducted marking**: DailyLectureAudit sets `status='conducted'` on `batch_planners`. This is the ONLY authoritative way to mark a lecture done — never date-based inference.

**Stage lifecycle**: Draft → Faculty Assigned → Confirmed → Rework. `setLinkStage()` notifies faculty. `sendWeekToFaculty()` releases one week at a time.

**Planner end date rule**: Lectures CANNOT be placed after `batch.end_date`. The shift engine caps classDates at end_date. EditPlanner date inputs have `max={batch.end_date}`.

### 3. Test Scheduler (`components/TestScheduler.tsx`, `lib/tests.ts`)

**Stages**: Draft → Faculty Assigned → Confirmed → Rework → Cancelled

**Validation** (`validateTestSlot()`): Checks faculty + room + batch against weekly schedules, planner lectures, and other tests. Returns exact clash details (test name, time). With `testPriority=true`: only another TEST blocks (clashing lectures get shifted to buffers).

**Test priority shift** (`shiftPlannerForTest()`): When test is created with priority, pushes clashing lectures forward onto next buffer within `batch.end_date`. Stores `shifted_for_test_id` for revert on test delete.

**Syllabus completion** (`getEligibleChapters()`): Per chapter — compares master topics (from `topics` table) vs topics taught in `batch_planners` by test date. Fallback: lecture-count ratio when no topics in master. Threshold: 60%.

**Multi-subject Part tests**: `test_schedules.subject_id = null` when multiple subjects. Chapters stored in `test_chapters` with their own `subject_id` from the `chapters` table. `getTestCompletion()` resolves subjects from chapter IDs.

**Multi-batch tests**: `test_batch_mappings` table. One test can span multiple batches. `batch_id` on `test_schedules` stays as primary batch.

**Cascade shift** (`cascadeShiftTests()`): When a test date needs to move, ALL subsequent tests for that batch shift forward. test[i] → test[i+1]'s old date. Last test → user-provided date. Room auto-assigned from free slots. Preview (dry run) before applying.

**Bulk CSV import**: Supports multi-subject (`Physics;Chemistry` in Subject column, `Chap1;Chap2||ChapA;ChapB` in Chapters column with `||` as subject separator). Room auto-assigned. Errors surface with exact clash details.

**Export CSV**: Export filtered tests for a batch in bulk-import-compatible format.

**test_chapters query limit**: Must use `.limit(5000)` — default PostgREST limit is 1000 and can truncate.

### 4. Calendar (`components/central/CentreTimetable.tsx`)
- Day view per centre — all rooms as columns
- Shows classes (`batch_schedules`), planner lectures (`batch_planners`), tests (`test_schedules`)
- **Date-range filter**: `batch_schedules` filtered by `effective_from <= date` AND (`effective_to IS NULL OR effective_to >= date`)
- Planner dedup: a planner lecture is dropped if its batch+subject+time matches a class block (same batch, same subject, overlapping time)
- Stale ghost entries: planner rows whose time no longer overlaps the current schedule slot (e.g. class moved from 7:30 to 8:00 — old 7:30 planner row is dropped)

### 5. Pacing & Progress

**`computeBatchPacing()`** (`lib/pacing.ts`):
- Fetches `batch_planners` where `is_buffer=false` AND `planned_date <= batch.end_date`
- "Done" = `status === 'conducted'` (NEVER date-based)
- `finishDate` = last planned lecture date (within end_date)
- `marginDays` = `end_date − finishDate`
- Status colors: 🔴 `behind` (marginDays < 0), 🟢 `ahead` (marginDays ≥ 14), 🔵 `on-track`, ⚫ `done`

**`getBatchProgress()`** (`lib/tests.ts`):
- Time-based expected count vs `status='conducted'` actual count
- Buffer utilization tracking
- Returns `lecturesCompleted` (conducted only), `lecturesExpected`, `bufferSlotsRemaining`

**Batch Progress page**: Both central team and `progress_reviewer` can see it. Progress reviewers see ALL centres.

### 6. Daily Lecture Audit (`components/central/DailyLectureAudit.tsx`)
- Central team marks lectures as conducted here
- Fields: lecture link URL, topic ✓, duration ✓, PPT ✓, remarks
- Saving with `topic_check=true` → sets `batch_planners.status='conducted'`
- This is the authoritative conducted path

### 7. Results (`components/ResultsSummary.tsx`)
- Batch-wise test results — avg score %, pass %
- Top performers
- Centre filter (central team only)

---

## Database — Key Tables

| Table | Purpose |
|---|---|
| `app_users` | All users. `role` (primary), `roles TEXT[]` (all). `auth_id` → Supabase Auth |
| `centres` | Teaching centres with `branch_head_id` |
| `user_centres` | Junction user ↔ centre (multi-centre support) |
| `programs` | Academic programs |
| `subjects` | Subjects within a program |
| `chapters` | Concept Tags chapters (`subject_id`, `sequence_no`) |
| `topics` | Concept Tags topics (`chapter_id`) |
| `batches` | `program_id`, `centre_id`, `start_date`, `end_date`, `batch_manager_id`, `batch_owner_id`, `buffer_days` |
| `batch_schedules` | Weekly slots: `batch_id`, `day_of_week`, `start_time`, `end_time`, `faculty_id`, `subject_id`, `classroom_id`, `effective_from`, `effective_to` |
| `planners` | Planner template (shared across batches) |
| `planner_lectures` | Template lecture rows |
| `batch_planner_links` | Junction planner ↔ batch with stage |
| `batch_planners` | Materialised lectures per batch. `status` (planned/confirmed/conducted), `is_buffer`, `shifted_for_test_id`, `shifted_from_date` |
| `classrooms` | Rooms at a centre |
| `test_schedules` | Tests: `batch_id`, `subject_id` (null=multi-subject), `part_type` (Full/Part), `stage` |
| `test_chapters` | `test_id` + `chapter_id` (chapters join has `name, subject_id`) |
| `test_batch_mappings` | Multi-batch test support |
| `lecture_audits` | Audit records per `batch_planner_id`: topic/duration/ppt checks, remarks |
| `reschedule_requests` | Faculty/manager reschedule requests |
| `students` | Student records per batch |
| `user_credentials` | Stores plaintext password mirror for admin visibility |

---

## Key Business Rules (NEVER violate these)

1. **No room/faculty overlap** — enforced in `validateTestSlot()` and `lib/scheduling.ts`
2. **No lecture after batch.end_date** — planner shift caps at end_date; EditPlanner date input has `max={end_date}`; `getTestCompletion` filters `planned_date <= endDate`
3. **Conducted = audit-marked only** — `status === 'conducted'` set by DailyLectureAudit, never inferred from date
4. **Test priority over lectures** — tests created with `testPriority` shift clashing lectures to buffers
5. **Buffers absorb shifts** — real lectures shift onto buffer slots within end_date; if no buffers left → warning shown
6. **Calendar shows only active segments** — `batch_schedules` filtered by `effective_from/to` for the viewed date
7. **test_chapters limit** — always use `.limit(5000)` when querying test_chapters, default 1000 truncates
8. **Syllabus % for Part tests** — computed from `getEligibleChapters()` using topic taught ratio vs test date; multi-subject resolved from chapter's own `subject_id`

---

## Project Structure

```
app/
  admin/          — Admin portal pages
  batch-manager/  — Batch manager portal (scheduler, tests, marks, results, attendance)
  branch/         — Branch head portal
  central/        — Central team portal (hub, tests, audit, marks, results, etc.)
  faculty/        — Faculty portal
  faculty-schedule/ — Shared faculty schedule view
  progress-reviewer/ — Progress reviewer portal (single page: BatchProgress)
  auth/callback/  — Supabase auth callback
  login/          — Login page
  choose-role/    — Role picker for multi-role users
  page.tsx        — Root router (redirects by role)

components/
  central/        — BatchScheduler, EditPlanner, CreatePlanner, DailyLectureAudit, CentreTimetable
  TestScheduler.tsx
  BatchProgress.tsx
  ResultsSummary.tsx, MarksEntry.tsx, AttendancePanel.tsx, StudentsPanel.tsx
  FacultyScheduleView.tsx, PortalShell.tsx

lib/
  tests.ts        — Test engine: eligible chapters, slot validation, cascade shift, getBatchProgress
  planners.ts     — Planner engine: materialise, assignPlanner, cascadeReschedule, buffer
  pacing.ts       — computeBatchPacing (subject-level pacing with marginDays/status)
  auth.ts         — getAppUser, getUserCentreIds, hasRole
  utils.ts        — toMinutes, formatTime, daysBetween, stageBadgeClass
  scheduling.ts   — checkWeeklyScheduleOverlap, checkClassroomScheduleOverlap
  results.ts      — summarize (marks summary)
  notifications.ts — notify, notifyUsers
  validation.ts   — validateBatchDates, validateTimeRange, isDateInRange

scripts/
  schema.sql                   — Full DB schema
  migration-*.sql              — Individual migrations
  migrations/                  — Additional migrations
  set-password.js              — Set password for a user (requires app_users row first)
  add-progress-reviewers.sql   — SQL to add progress_reviewer users
```

---

## Adding New Users

1. Run SQL in Supabase SQL Editor to insert into `app_users` with correct role
2. Run `node scripts/set-password.js email@pw.live "Password@123"` to set auth credentials
3. OR use Admin portal → Add Credentials (requires admin role)

---

## Recent Work Done (current session)

- Multi-subject bulk test scheduling (CSV with `||` separator)
- Batch manager portal: Batch Scheduler + Tests access
- Progress reviewer role + `/progress-reviewer` portal
- Cascade shift tests feature (Shift Forward button)
- Export tests CSV from filtered view
- Calendar fix: effective_from/to date range filtering + ghost entry dedup
- Pacing fix: `doneLectures` uses `conducted` status, not date
- Planner end date enforcement in EditPlanner
- Results page: centre filter for central team
- test_chapters query limit increased to 5000
- Syllabus % fix for multi-subject tests
