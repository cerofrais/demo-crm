# 23 — Design system

Short reference for the visual conventions already in use across the app.
Nothing here is new — it's a write-up of patterns that exist today in
`src/components/ui`, `tailwind.config.ts`, and `globals.css`, so they stop
drifting as more pages get built. When in doubt, match what's here; if a
component needs something this doc doesn't cover, extend `components/ui`
rather than styling it one-off at the call site.

---

## Color

Colors are semantic Tailwind tokens (`bg-primary`, `text-muted-foreground`,
`border-border`, …), defined as HSL CSS variables in `globals.css` and mapped
in `tailwind.config.ts`. Never hardcode a hex color or an arbitrary Tailwind
shade (`text-gray-500`, `bg-[#246a80]`) in a component — use the token, so
the light/dark themes and any future rebrand only need to change one place.

| Token | Use |
| --- | --- |
| `background` / `foreground` | Page background / default text |
| `card` / `card-foreground` | `Card` surfaces |
| `primary` / `primary-foreground` | Primary buttons, brand accents (`--primary` = site teal `#246a80`) |
| `secondary` / `secondary-foreground` | Secondary buttons, filter chips, subdued surfaces |
| `muted` / `muted-foreground` | Deemphasized text, empty-state icons, helper copy |
| `accent` / `accent-foreground` | Sea-green tint accents |
| `destructive` / `destructive-foreground` | Delete/danger actions and their confirmation states |
| `border` / `input` | Borders, dividers, form-control outlines |
| `ring` | Focus rings (`focus-visible:ring-2 focus-visible:ring-ring`) |
| `sidebar` / `sidebar-foreground` / `sidebar-accent` | App nav rail only |

Two static (non-theme) scales exist for one-off brand accents that don't
need to flip in dark mode:

- **`brand-{50…900}`** — the teal family (`brand-500` = `#246a80`, matching
  trewellness.in). Used for things like `Avatar` initials
  (`bg-brand-100 text-brand-700`), hover states (`hover:bg-brand-600`), and
  category badges.
- **`earth-{50…500,cream,sage}`** — warm neutrals lifted from the marketing
  site, for surfaces/accents that want warmth rather than the cooler
  semantic greys.

Status/semantic colors that aren't part of the brand scale use plain
Tailwind palettes directly, by convention rather than a token — this is
deliberate, not a gap to fix: `emerald` (success/active/approved),
`amber`/`rose` (warning/destructive-adjacent, e.g. `ScoreBadge`'s
40–69/<40 bands), `sky`/`purple`/`indigo`/`violet` (category-distinguishing
badges, e.g. tag categories in `lead-tags.ts`'s `CATEGORY_CLASS`, role
badges in Users).

**Dark mode**: every semantic token has a `.dark` override in `globals.css`.
`brand`/`earth` do not — they're used sparingly enough (accents, not surfaces)
that this hasn't been a problem, but a component leaning on them for a large
surface area should double-check dark-mode contrast.

## Radius

Three tokens, all derived from `--radius` (`0.625rem` = 10px):

| Token | Value | Use |
| --- | --- | --- |
| `rounded-sm` | `radius - 4px` (6px) | Small controls |
| `rounded-md` | `radius - 2px` (8px) | Default — buttons, inputs, selects, textareas |
| `rounded-lg` | `radius` (10px) | `Card` surfaces, dialogs |
| `rounded-full` | — | `Badge`, avatars, pill filters, circular icon buttons |

`components/ui` primitives already default to the right one — don't override
`rounded-*` at the call site unless the shape is genuinely different (e.g. a
pill-shaped filter chip that isn't a `Badge`).

## Spacing & layout

- **Page padding**: `p-4 md:p-6` for page content, `px-4 py-3 md:px-6` for
  toolbars/headers — 16px on phone, 24px from `md:` up. This is the
  convention in every page shell and in `PageHeader`; match it rather than
  picking a new number.
- **Card padding**: `p-4` for a standard card, `p-3` for compact/mobile list
  rows.
- **Gaps**: `gap-2` (8px) for tightly related inline controls (icon +
  label), `gap-3` (12px) for toolbar items, `gap-1.5` for icon-button
  clusters.
- **Touch targets**: interactive controls are `h-11` (44px) by default —
  meets the iOS/Android minimum tap-target size — and shrink to a compact
  `lg:h-9` (36px) from the `lg:` breakpoint up, once a mouse/trackpad is the
  likely input. This split is already built into `Input`, `Select`, and the
  `icon` button size — don't hardcode a fixed height on a new touch control,
  reuse the primitive.

## Typography

No custom type scale beyond Tailwind's defaults plus one font variable
(`--font-sans`, wired through `next/font`). In practice:

- `text-lg font-semibold` — page titles (`PageHeader`)
- `text-sm font-semibold` / `font-medium` — section headers, card titles
- `text-sm` — default body/UI copy
- `text-xs` — secondary/meta text, table cells, helper copy
- `text-[10px]`–`text-[11px]` — the smallest labels (uppercase eyebrow
  labels, tiny hints) — used sparingly, prefer `text-xs` unless space is
  genuinely tight
- `uppercase tracking-wide text-muted-foreground` — the recurring pattern
  for small field/section eyebrow labels (see `Field` in the Users/lead
  drawer forms)

## Components

`src/components/ui/index.tsx` is the shared primitive set — treat it the
same way the `packages/ui`-style projects treat theirs: **extend it, don't
route around it.** If a page needs a new visual variant of `Button`, `Card`,
`Badge`, etc., add the variant there so every consumer gets it, instead of
overriding classes at the call site with `className`.

Current primitives: `Button` (variants: `primary`/`secondary`/`ghost`/
`outline`/`destructive`; sizes: `sm`/`md`/`lg`/`icon`), `Card`, `Badge`,
`ScoreBadge` (the AI-score ring — consolidated from four previously
inconsistent ad hoc renderers, see the git history if tempted to add a
fifth), `Input`, `Select`, `Textarea`, `Avatar` (initials), plus `Sheet`/
`Dialog` (portal + focus trap + Esc + scroll lock + mobile bottom-sheet
treatment — always use these instead of a hand-rolled modal),
`ScrollableTabs`, `HorizontalScrollbar`, `RichTextEditor`.

**Buttons**: default to `variant="primary"` for the one primary action in a
view, `outline` for secondary actions, `ghost` for icon-only or low-emphasis
actions, `destructive` only for irreversible/dangerous actions (delete,
hard-delete) — never for a merely "negative" action like Cancel, which is
`outline`.

**Forms**: label with `<label className="text-xs font-medium text-foreground">`
above the control (see `Field` helper components in Users/lead drawer) —
not placeholder-as-label. Validation errors render as
`text-xs text-destructive` directly under the field.

**Empty/loading states**: a centered muted icon (`h-10 w-10 opacity-20`)
plus `text-muted-foreground` copy is the standard empty-state shape (see
Users, Referrals, Guests). Loading uses either a centered `Loader2
className="animate-spin"` or an inline spinner beside the triggering
control — match whichever the surrounding view already uses.

## Responsive pattern

Mobile-first, with `md:`/`lg:` overrides — not separate mobile/desktop
components except where the interaction genuinely differs (e.g. Kanban has
`kanban-board.tsx` for drag-and-drop on desktop and `kanban-mobile.tsx` for
a tap-driven flow on phone, because drag gestures don't translate). Tables
that don't need a different interaction model instead render as a `divide-y`
stacked list below `md:` and a `<table>` above it (see Users) — same data,
same component, two Tailwind-conditional render branches.

## What NOT to do

- Don't hardcode hex colors or arbitrary Tailwind color shades — use a
  semantic token, or `brand`/`earth` for one-off brand accents.
- Don't hand-roll a modal — use `Dialog`/`Sheet`.
- Don't add a new `rounded-*` value — the three radius tokens cover every
  existing surface.
- Don't override `components/ui` primitives with one-off `className` hacks
  for a look that isn't actually one-off — add a variant instead.
- Don't invent a new touch-target height — reuse `h-11 lg:h-9` (already
  built into the form primitives) for anything genuinely new.
