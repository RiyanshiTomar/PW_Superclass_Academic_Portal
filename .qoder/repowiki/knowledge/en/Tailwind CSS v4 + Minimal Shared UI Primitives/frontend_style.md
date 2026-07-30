The Superclass Academic Portal uses Tailwind CSS v4 (via `@tailwindcss/postcss`) as its sole styling engine, with no separate design system or component library. Visual consistency is achieved through a small set of shared primitives in `components/PortalShell.tsx` and a minimal global theme in `app/globals.css`.

**Styling stack**
- Tailwind CSS v4 loaded via `@import "tailwindcss"` in `globals.css`, processed by `@tailwindcss/postcss` in `postcss.config.mjs`.
- Next.js Google Fonts (`Geist Sans`, `Geist Mono`) injected at the root layout and exposed as CSS custom properties (`--font-geist-sans`, `--font-geist-mono`).
- A tiny `:root` / `@theme inline` block maps semantic tokens (`--background`, `--foreground`, font families) to CSS variables so pages can reference them directly.

**Shared UI primitives** (`components/PortalShell.tsx`)
The app avoids importing third-party UI kits and instead exports a cohesive set of composable components that encapsulate the visual language:
- `PortalShell` — role-aware shell with a fixed left sidebar (desktop) and top bar (mobile), active-link highlighting, and user footer.
- `PageHeader` — consistent page title/description/action slot.
- `Alert` — success/error/info variants built from Tailwind color classes.
- `Card` — white card with border and rounded corners.
- `BtnPrimary` / `BtnSecondary` — two button styles sharing size, radius, and transition conventions.
- `DashboardGrid` — responsive grid for dashboard entry cards with hover effects.

These primitives are consumed uniformly across every portal route (`admin`, `central`, `faculty`, `branch`, `batch-manager`), ensuring a single look-and-feel without a formal token file.

**Design decisions & conventions**
- **Utility-first only**: No SCSS/SASS, CSS-in-JS, or class-name mapping libraries. All styling lives in Tailwind utility strings.
- **Neutral palette**: The entire UI is built on `neutral-*` shades plus semantic accents (`emerald-*` for success, `red-*` for errors). There is no brand color; contrast is driven by `bg-neutral-950` primary buttons and `text-neutral-950` headings.
- **Responsive strategy**: Mobile-first breakpoints (`sm:`, `lg:`) are used consistently; the shell switches between a persistent sidebar and a compact header based on viewport width.
- **Typography**: Only two typefaces (Geist Sans, Geist Mono) are used; headings rely on Tailwind's default weight scale (`font-bold`, `font-semibold`) rather than custom sizes.
- **No external component library**: The team chose lightweight hand-written primitives over shadcn/ui, Radix, or similar, keeping dependencies minimal.

**Rules developers should follow**
1. Reuse `PortalShell`'s exported primitives (`Card`, `PageHeader`, `Alert`, `BtnPrimary`, `BtnSecondary`, `DashboardGrid`) instead of writing ad-hoc styled divs.
2. Stick to the neutral palette (`neutral-*`) and accent colors (`emerald-*`, `red-*`); avoid introducing new brand hues unless explicitly added to `globals.css` tokens.
3. Use Tailwind utilities exclusively — do not add new `.css` files beyond `globals.css`.
4. Keep typography to the two Geist fonts; prefer Tailwind's built-in sizing/weight scales over custom `font-size` values.