This repository does not implement a logging system. There is no dedicated logger library, no log-level management, no structured log fields, and no centralized logging configuration anywhere in the application code.

Evidence:
- The `lib/` directory (auth.ts, utils.ts, scheduling.ts, validation.ts) contains zero logging calls — no `console.*`, no logger imports, no error-handling wrappers that emit logs.
- All `.ts` and `.tsx` files under `app/`, `components/`, and `lib/` contain no logging statements whatsoever.
- The only logging present is ad-hoc `console.log` / `console.error` / `console.warn` scattered across Node.js seed scripts in `scripts/` (`db-introspect.js`, `import-portal-data.js`) used for CSV import and database introspection. These are one-off CLI utilities, not part of the running Next.js app.
- No logging-related dependencies appear in `package.json`; the `debug` package found in `package-lock.json` is a transitive dependency of tooling, not imported by application code.
- There is no middleware, layout, or global file that configures a logger or intercepts output.

Consequence: Errors and diagnostics in the live Next.js application rely entirely on Next.js's default development console output; there is no production-ready logging strategy, no request correlation IDs, and no way to distinguish log levels.