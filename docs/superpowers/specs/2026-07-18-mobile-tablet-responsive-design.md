# Mobile & Tablet Responsive Design — TRE Wellness CRM

**Date:** 2026-07-18
**Status:** Approved design; ready for implementation planning
**Scope:** Make the full CRM usable and well-designed on phones and tablets, with full role/screen parity.

---

## 1. Goals & non-goals

### Goals
- Every screen and every role works well on phone (≈360–430px), tablet (≈768–1024px), and desktop (≥1024px).
- "Adaptive & tailored": screens use mobile-appropriate patterns (drawer nav, bottom nav, card lists, stacked panels), not just shrunk desktop layouts.
- No regressions to the existing desktop experience.

### Non-goals
- **No PWA / installability / offline.** Responsive web only. No service worker, manifest, or offline caching in this effort.
- **No UI-framework migration.** Keep the hand-rolled primitives in `src/components/ui`; do not adopt Radix/shadcn wholesale.
- **No backend/API changes.** This is a presentation-layer effort. (If a screen needs a new endpoint for a mobile-only need, that is out of scope and gets its own spec.)
- No native apps.

### Success criteria
For each target viewport (see §8): no horizontal scroll on `<body>`, all interactive targets ≥44×44px, primary nav reachable, and every screen's primary task completable by touch.

---

## 2. Decisions locked in brainstorming
- **Audience:** everyone — full parity across all roles and screens.
- **Quality bar:** adaptive & tailored (not reflow-only, not separate mobile apps/routes).
- **Delivery:** responsive web only (no PWA).
- **Tablet posture:** "desktop-lite" — keep boards/tables/multi-panel layouts, just tighter. Phone is where layouts change shape.
- **Mobile Kanban:** stage-tabs + single column with a "Move to stage" picker (no drag on phone).
- **Approach:** Tailwind breakpoints as the primary tool + a thin layer of shared responsive primitives; a `useBreakpoint()` hook only where CSS alone can't decide.

---

## 3. Breakpoint strategy

Use Tailwind's default breakpoints; do not add custom ones.

| Tier | Range | Tailwind prefix | Layout posture |
|------|-------|-----------------|----------------|
| Phone | 0–767px | `base` (unprefixed) | Single column, drawer + bottom nav, card lists, stacked panels |
| Tablet | 768–1023px | `md:` | Desktop-lite: boards/tables kept, sidebar as icon rail, tighter spacing |
| Desktop | ≥1024px | `lg:` | Current experience, unchanged |

**Rule of thumb:** default (unprefixed) classes describe the phone layout; `md:`/`lg:` progressively restore the wider layout. CSS handles layout wherever possible; the `useBreakpoint()` hook is only for cases that must branch in JS (e.g., choosing Kanban board vs. stage-tab component, or table vs. card rendering when the two are structurally different components).

---

## 4. Foundation (Phase 0)

The foundation unblocks every screen and must land first.

### 4.1 Viewport & safe areas
- Add a Next.js `viewport` export in `src/app/layout.tsx`: `width=device-width, initial-scale=1, viewportFit=cover`.
- Add `env(safe-area-inset-*)` padding utilities for the top app bar and bottom nav so content clears notches and home indicators.

### 4.2 `useBreakpoint()` hook
- New `src/hooks/use-breakpoint.ts` wrapping `matchMedia`, SSR-safe (returns a stable default on the server, hydrates on mount to avoid layout flash).
- Exposes `isPhone` / `isTablet` / `isDesktop` (and/or a `breakpoint` string). Used sparingly — CSS is preferred.

### 4.3 App shell (`src/app/(app)/layout.tsx`, `src/components/app/sidebar.tsx`)
- **Desktop (`lg`):** current fixed 240px sidebar — unchanged.
- **Tablet (`md`):** sidebar collapses to an icon rail (icons only, labels on hover/expand).
- **Phone (`base`):**
  - Top app bar with a hamburger button opening a **slide-in drawer** containing the full nav (same items as the sidebar, role-filtered by existing `navFor(roles)`).
  - A **bottom navigation bar** with the top ~4–5 role-relevant destinations; a "More" entry opens the drawer for the rest.
  - Main content is full-width with bottom padding equal to the bottom-nav height + safe-area inset.
- Nav item sets stay driven by the existing `navFor(roles)` in `src/lib/rbac.ts` — no new permission logic. The bottom-nav subset is derived from that list (first N items, "More" for the remainder). Note some roles have few items (DOCTOR ≈ 3), so "More" may be empty — the bottom nav must degrade to just the available items with no "More" entry.

### 4.3a Layout height model (sequencing dependency)
Adding a top bar + bottom nav changes usable height, and the current shell hardcodes full-viewport heights that don't account for it: `layout.tsx` is `h-screen overflow-hidden` with an `h-screen` sidebar, and screens use `h-full` / `h-[60vh]` / `h-[70vh]` / `100vh`-based calcs (`lead-drawer.tsx` conversation panel, `health-workspace.tsx`). Raw `100vh` also has the mobile URL-bar bug.
- **Phase 0 must** convert the app shell to a `100dvh` CSS grid (`topbar / content / bottomnav` rows on phone; `sidebar / content` on desktop) and **audit every `h-screen` / `100vh` / `vh`-based height** so nested scroll regions subtract the bars correctly. This is a prerequisite for the per-screen work — do it before Phase 1.
- **Height-audit result (from Phase-0 review):** the shell is fixed. The remaining `vh` offenders that ignore the new bars are **tracked obligations for their screen's phase** (no desktop regression, and these screens weren't mobile-usable before): `health-workspace.tsx` `h-[calc(100vh-0px)]` and `h-[70vh]` (Phase 2), `lead-drawer.tsx` embedded conversation `h-[60vh]` (Phase 1). Convert these to flex-fill / `100dvh`-aware heights when each screen is adapted.

### 4.4 New shared primitives (`src/components/ui`)
- **`Sheet`** — an overlay that slides from a side (drawer nav) or bottom (bottom-sheet for actions/menus). Handles focus trap, `Esc`, backdrop, scroll lock. Used for the mobile nav drawer, mobile action menus, and phone modals.
- **`Dialog` / `Modal`** — **there is no shared modal primitive today**; every modal is hand-rolled `fixed inset-0` with no focus trap / `Esc` / scroll lock (`new-lead-dialog.tsx`, four in `users/page.tsx`, `BulkEmailDialog` in `guest-search.tsx`, and the `confirm()` in `document-manager.tsx`). Phase 0 must ship a proper `Dialog` (or a centered variant of `Sheet`) **and** migrate these ≥6 sites to it — this migration is real, budgeted work, not incidental. On phone, `Dialog` renders as a bottom/full-screen sheet.
- **`ResponsiveTable` / `DataList`** — accepts a column config `{ key, header, primary?, render }`. Renders a real `<table>` at `md:` and a stacked card list at `base`. Covers the *simple* tables (performance table, plain lists, Users, Documents). **It does NOT cover** the pivot matrix (Reports) or tables with an embedded `<audio>` player and `colSpan` row-expansion (Calls) — those get bespoke card/sticky-column treatment (see §6).
- **`ScrollableTabs`** — a tab bar that scrolls horizontally with fade affordances when tabs overflow (for the lead drawer's 7 tabs and similar).

### 4.5 Touch baseline (applies to `src/components/ui` primitives)
- Minimum interactive target 44×44px; bump icon-only buttons (currently `h-3.5`/`h-4`) on touch.
- Inputs at ≥16px font on phone to prevent iOS auto-zoom.
- Correct input types/attributes: `type="tel"` for phone, `type="email"`, `inputmode`, `autocomplete`.
- Replace native `confirm()` (e.g. `document-manager.tsx`) with the app `Dialog`/`Sheet`.

---

## 5. Reusable patterns (applied across screens)

1. **Wide table → card list on phone.** Each row becomes a card: primary field (name) prominent, key secondary fields as compact label/value pairs, actions behind a kebab → bottom sheet. Table view returns at `md:`.
2. **Two-panel → stacked navigation on phone.** List view first; tapping an item pushes a detail view with a back affordance. Side-by-side returns at `md:`.
3. **Centered modal → full-screen or bottom sheet on phone.** Small `max-w-md` modals become bottom sheets or full-screen sheets on `base`.
4. **Hover/`title`-only affordances → visible or tap-revealed.** Meaningful info hidden in `title=`/`hover:` gets a visible control or moves into the row's kebab/detail. No essential action depends on hover.
5. **Filter/toolbar → "Filters" sheet on phone.** The `flex flex-wrap` toolbars (Leads: search + 3 selects + actions + tag bar; Calls: 2 selects + 2 date inputs; ai-decisions; Users search) collapse into tall walls on phone. On `base`, collapse secondary controls into a "Filters" bottom-sheet / disclosure, leaving only search + primary action inline; full toolbar returns at `md:`.

---

## 6. Screen-by-screen map

| Screen / component | Phone pattern | Tablet (`md`) | Notes |
|---|---|---|---|
| **App shell** (`layout.tsx`, `sidebar.tsx`) | Top bar + drawer + bottom nav | Icon-rail sidebar | Foundation (§4.3) |
| **Leads Kanban** (`kanban-board.tsx`, `leads-workspace.tsx`) | Stage tabs + single column + "Move to stage" picker | Multi-column board (keep drag) | JS branch via `useBreakpoint`; reuse existing stage list |
| **Lead drawer** (`lead-drawer.tsx`) | Full-screen `Sheet`; `ScrollableTabs`; meta `grid-cols-2`→1 | Slide-over as today | 7 tabs. **Embedded panels (ConversationPanel `h-[60vh]`, AssistPanel, CallsPanel, DocumentManager) use fixed heights that double-scroll inside a full-screen Sheet — their height model must switch to flex/`min-h-0` fill, not just wrap the tabs.** |
| **Health workspace** (`health-workspace.tsx`) | List → detail (stacked, back button); Record↔Conversation toggle kept | Two-panel (320px + fluid) | Preserve F29 schema-mismatch banner behavior |
| **Calls** (`calls/page.tsx`) | **Bespoke** card list + expandable detail; stat row `grid-cols-3`→responsive; transcript expansion `grid-cols-2`→stack | Table | 10-col table with embedded `<audio>` + `colSpan` row-expansion — NOT a plain `ResponsiveTable`; needs a custom card. Stats are a fixed grid today (must be made responsive). |
| **Reports** (`reports/page.tsx`) | Summarized card view + sticky-first-column scroll fallback | Matrix table | Read-mostly; pivot has ~9 stage columns |
| **Users** (`users/page.tsx`) | Card list; actions in kebab → sheet; modals → sheet | Table | Tiny action icons today; enlarge |
| **Documents** (`document-manager.tsx`) | List rows; `confirm()`→Dialog; toolbar wraps | Table | Has a `compact` mode already |
| **Conversation** (`conversation-panel.tsx`) | Already fluid; ensure compose row + safe area | As-is | Most mobile-ready screen |
| **Dashboard** (`dashboard/page.tsx`) | Stat grid already `grid-cols-2 lg:grid-cols-5`; charts already fluid | Mostly as-is | Already the most responsive. No chart lib — "charts" are CSS bar `<div>`s. Only nit: funnel's fixed `w-44` label crowds the bar at 360px. |
| **AI-decisions** (`ai-decisions/page.tsx`) | Full-height detail **`Sheet`**; `grid-cols-2`→1; `overflow-x-auto` on the `<pre>` JSON/prompt blocks; filter toolbar→sheet | Slide-over | **NOT trivial** — same drawer class as the lead drawer; belongs in Phase 2. |
| **Guests** (`guest-search.tsx`) | Card list; bulk-select affordance; `BulkEmailDialog`→`Dialog`/sheet | Desktop-lite | **NOT zero-effort** — has multi-select + a hand-rolled bulk-email modal to migrate. |
| **Leads (List view + New-lead form)** | Phone may default to the existing `list` toggle (`LeadsTable`) as an alternative to stage-tabs; `new-lead-dialog.tsx` `grid-cols-2` form→stack | Desktop-lite | `leads-workspace.tsx` already has a pipeline/list toggle — reuse it. |
| **Tasks / Packages / Referrals / Resources / Settings** | Apply table→card / grid-stack / `Dialog` patterns | Desktop-lite | Straightforward reuse of primitives. |

**Out of scope (unauth surface):** `src/app/login/page.tsx` is already responsive (`max-w-md`), and Keycloak's hosted login/password/OTP pages are external and themed separately — both are intentionally excluded from this effort despite the "full parity" goal, which refers to the authenticated `(app)` screens.

---

## 7. Phasing

- **Phase 0 — Foundation.** Viewport/safe-area, `useBreakpoint`, **`100dvh` grid shell + audit of all `h-screen`/`100vh`/`vh` height calcs (§4.3a)**, app shell (drawer + bottom nav + icon rail), primitives `Sheet`/**`Dialog`**/`ResponsiveTable`/`ScrollableTabs`, **migration of the ≥6 hand-rolled modals to `Dialog`**, touch baseline in `ui` primitives, and standing up the **verification harness** (§8). *Ships as: the app is navigable and non-broken on phones; primitives + test harness ready for reuse.* This is the largest phase — budget accordingly.
- **Phase 1 — Core daily flows.** Leads Kanban + lead drawer, Guests, Tasks, Conversation, Calls.
- **Phase 2 — Data-heavy/admin.** Reports, Users, Documents, Health workspace, Packages, Referrals, AI-decisions, Settings, Dashboard polish.
- **Phase 3 — Polish.** Swipe gestures (stage tabs), transitions, empty/loading states, cross-device QA sweep.

Each phase is independently shippable. **Phase 0 becomes the first implementation plan;** subsequent phases get their own plans (this design doc is the shared reference).

**Phase-0 execution decisions (reviewed & approved):**
- **`ResponsiveTable` / `ScrollableTabs` move to Phase 1**, built against their first real consumers (Calls/Users table; lead-drawer tabs) to avoid a speculative/wrong abstraction. Phase 0 still ships `Sheet` + `Dialog`.
- **The 6 hand-rolled modal migrations move into each modal's screen phase** (verify-in-context), not Phase 0. Existing modals keep working unchanged until then; Phase 0 ships the `Dialog` primitive they'll adopt.
- **Verification = manual QA checklist at target viewports + `tsc`/`lint`/`next build`** (all green); Playwright/browser E2E deferred to a later dedicated step.

---

## 8. Verification

**Target viewports:** 360×800 and 390×844 (phones), 768×1024 (iPad portrait), 1024×1366 (iPad landscape), 1440 (desktop regression).

**Per key screen, confirm:**
- No horizontal scroll on `<body>` (wide content scrolls only inside its own container).
- All interactive targets ≥44×44px.
- Mobile nav (drawer + bottom nav) works; active state correct; role filtering intact.
- Table↔card and panel-stacking switch at the right breakpoint with no data loss.
- Existing desktop layout unchanged at ≥1024px.

**Tooling:** the repo currently has **no test harness** (no Playwright/vitest/jest). Phase 0 stands one up. To keep it proportionate:
- **Primary:** add Playwright with a small viewport-screenshot suite over the key screens (asserts: no `<body>` horizontal scroll, bottom-nav/drawer present, table↔card switch) + a keyboard/`Esc`/focus-trap test on `Sheet`/`Dialog`.
- **Fallback (if Playwright setup proves heavy):** a documented **manual QA checklist** run at the target viewports each phase, plus the existing `tsc`/`lint`/`next build` gates. Decide during Phase 0; do not let harness setup block foundation delivery.
- A mobile Lighthouse pass is a nice-to-have, not a gate.

---

## 9. Risks & mitigations
- **Kanban dual-mode drift.** Board and stage-tab views could diverge in behavior. *Mitigation:* both consume the same lead/stage data source and move-action; only presentation differs.
- **`Sheet` accessibility.** Hand-rolled overlays often miss focus trap / scroll lock / `Esc`. *Mitigation:* build these in from the start and cover with the a11y check in §8; if it proves fiddly, pull in one small dependency (e.g. a headless drawer) for this primitive only.
- **SSR hydration flash** from `useBreakpoint`. *Mitigation:* CSS-first; the hook returns a deterministic server default and only components that truly must branch in JS use it.
- **Scope creep into redesign.** *Mitigation:* this is responsive adaptation, not a visual redesign; keep existing styling/tokens.
- **Tablet touch drag-and-drop.** Kanban cards use `touch-none` so dnd-kit's PointerSensor can drag — but that also suppresses native touch-scroll on the card surface, making a dense column hard to scroll on iPad. *Mitigation:* verify on a real iPad; consider a dnd-kit `TouchSensor` with an activation delay/tolerance for the tablet path so a press-and-hold starts a drag while a plain swipe scrolls.
- **Modal-migration regressions.** Moving ≥6 bespoke modals onto one `Dialog` risks behavior changes (submit handlers, close-on-backdrop, nested state). *Mitigation:* migrate one at a time, keep each modal's existing props/callbacks, verify each screen still submits/cancels correctly before moving on.
- **`100dvh` shell refactor touches every screen's height math.** *Mitigation:* land the shell + height audit as an isolated Phase-0 step with its own verification pass before any per-screen work begins.

---

## 10. Open questions (non-blocking)
- Exact bottom-nav destinations per role (derive from `navFor`, then tune with the user after Phase 0).
- Whether Reports' phone view needs the summarized card view in Phase 2 or can ship with sticky-column scroll first and add cards later.
