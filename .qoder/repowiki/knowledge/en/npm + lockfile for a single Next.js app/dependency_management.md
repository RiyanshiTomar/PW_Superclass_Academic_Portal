This repository is a single-package Next.js application and uses the standard npm dependency-management setup.

**System / toolchain**
- Package manager: **npm** (lockfile version 3 via `package-lock.json`).
- No private registry, vendoring, or monorepo workspace configuration is present; all packages are resolved from the public npm registry (`https://registry.npmjs.org/`).
- The README documents dev/build/start scripts under the same names used by npm, yarn, pnpm, and bun, but only `package-lock.json` exists — there is no `.npmrc`, `pnpm-lock.yaml`, `yarn.lock`, or `bun.lock`.

**Key files**
- `package.json` — declares runtime dependencies (`next`, `react`, `react-dom`, `@supabase/supabase-js`, `@supabase/ssr`) and dev dependencies (`typescript`, `eslint`, `tailwindcss`, `@types/*`). Scripts expose `dev`, `build`, `start`, `lint`, and two data-import helpers that run Node scripts under `scripts/`.
- `package-lock.json` — deterministic lockfile pinning every transitive dependency with integrity hashes; this is the source of truth for reproducible installs.
- `node_modules/` — local install tree (gitignored in typical setups).

**Architecture & conventions**
- Single root package; no workspaces or sub-packages.
- Dependencies are pinned to exact versions for core framework/runtime (`next` 16.2.9, `react` 19.2.4, `react-dom` 19.2.4) while dev tooling uses caret ranges (`^5`, `^9`, `^4`, `^20`, `^19`) to allow compatible updates.
- Supabase client packages are the only third-party runtime dependency beyond the Next.js/React stack.
- No custom `.npmrc` overrides, token-based auth, or proxy configuration is visible at the repo level.

**Rules developers should follow**
- Declare new runtime dependencies in `dependencies` and dev-only tooling in `devDependencies` inside `package.json`.
- Commit `package-lock.json` alongside code changes so CI and teammates get identical trees.
- Prefer exact versions for core framework/runtime packages (as already done for `next`, `react`, `react-dom`) to avoid accidental major bumps.
- Keep `node_modules/` out of version control; rely on the lockfile for reproducibility.
- If a private/internal package is needed later, add an `.npmrc` with the appropriate `//registry... :_authToken` and scope mapping before publishing/consuming it.