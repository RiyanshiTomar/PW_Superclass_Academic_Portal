This project uses the standard Next.js 16 App Router build system with no custom Makefiles, Dockerfiles, or CI pipelines. The entire build and development workflow is driven by npm scripts in `package.json` and TypeScript/ESM configuration files.

**Build toolchain**
- **Framework**: Next.js 16.2.9 (App Router) with React 19.2.4.
- **TypeScript**: v5 with `target: ES2017`, `moduleResolution: bundler`, `isolatedModules`, and a `@/*` path alias mapping to the repo root. `noEmit: true` delegates compilation to Next's internal bundler.
- **Styling**: Tailwind CSS v4 via `@tailwindcss/postcss`; PostCSS config lives at `postcss.config.mjs`.
- **Linting**: ESLint v9 with `eslint-config-next` (v16.2.9), configured via `eslint.config.mjs`.
- **Config files**: Minimal — `next.config.ts` is present but empty; `tsconfig.json` is the only compiler surface.

**NPM scripts**
- `npm run dev` → `next dev` (development server).
- `npm run build` → `next build` (production static/server build).
- `npm run start` → `next start` (serve production output).
- `npm run lint` → `eslint`.
- `npm run import-data` → `node scripts/import-portal-data.js` (seeds Supabase from CSVs).
- `npm run import-faculty` → `node scripts/import-faculty.js <csv>` (ad-hoc faculty import helper).

**Data seeding / migration scripts** (`scripts/`)
- `import-portal-data.js` — Node script that reads `.env`, connects to Supabase via service-role key, parses four CSV files rooted at the repo top-level, and upserts programs/subjects, centres, branch heads, batch managers, central team, and faculty records. It includes its own CSV parser (handles quoted/multi-line fields) and centre-name normalization map.
- `schema.sql` — SQL DDL for the Supabase schema used by the portal.
- `db-introspect.js`, `inspect-centres.js`, `test-parse-csv.js` — ad-hoc inspection/test helpers.
- These scripts are invoked directly via `node` or through the npm scripts above; there is no migration framework (e.g., Prisma, Drizzle) — schema changes are manual SQL edits plus re-running the seed.

**Environment**
- Runtime secrets live in a single `.env` file at the repo root, consumed both by the Next app and the seed scripts (which parse it manually before connecting to Supabase).

**What is NOT present**
- No `Dockerfile`, `docker-compose.yml`, or container orchestration.
- No `Makefile`, shell build/deploy scripts, or cross-compilation targets.
- No CI configuration (`.github/workflows`, Vercel/Nixpacks/etc.) — deployment target is not defined in this repository snapshot.
- No version pinning beyond what `package-lock.json` provides; no monorepo tooling.