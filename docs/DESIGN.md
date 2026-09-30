# Swarm Cities design

## Overview

Swarm Cities is a dark terminal interface for discovering a plot and managing a soulbound city on Sepolia. The implemented page puts the map and selected city together, then explains the shared economy and exposes market/operator tools. Muted green surfaces, lime selection, restrained borders and monospace data follow the approved visual direction. Large sans-serif editorial headings give the dense controls a clear hierarchy.

Source: `web/src/styles.css`, `web/src/App.tsx`, `web/src/SwapPanel.tsx`. This file is under `docs/` because the assignment's strict path budget excludes repository-root `DESIGN.md`.

## Colors

The canonical color format is hex. Semantic custom properties are defined in `styles.css :root`:

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#0d100e` | Page and input backgrounds |
| `--surface` | `#141915` | Panels and dialog |
| `--surface-raised` | `#1c241d` | Neutral controls and badges |
| `--text` | `#eef0e8` | Primary text |
| `--muted` | `#a1aca1` | Descriptions and metadata |
| `--border` | `#354337` | Structure and control boundaries |
| `--accent` | `#c4f277` | Main action fill, selected plot, small brand mark |
| `--accent-ink` | `#17210c` | Text on accent fill |
| `--owned` | `#24442e` | Owned plot fill |
| `--error` | `#ffb4a9` | Persistent error text |
| `--warning` | `#edcc88` | Wrong-network guidance |
| `--focus` | `#e0edff` | Two-pixel keyboard focus outline |

Map empty cells use `#18221a`, border `#405443`, symbol `#bdcebb`; owned borders use `#618569`. The decorative city drawing uses `#789e66`. The palette is deliberately dark-only; no theme switch is presented. State always has a label, glyph or accessible name in addition to color. Browser-measured opaque text/background pairs and their limits are recorded in `docs/evidence/interaction-results.json` and `docs/validation.md`.

## Typography

`--mono` is `SFMono-Regular, Consolas, Liberation Mono, monospace`; `--sans` is `Arial, Helvetica, sans-serif`. These are platform fonts, with no external font requests or font binaries. The UI uses regular weight, with 700 for brand/primary buttons. Exact font rendering varies by platform.

The base is 14px with line height 1.6. Headings use the sans-serif stack: hero `clamp(44px, 5vw, 72px)`, line height 1.06 and -3px tracking; section headings 22px/1.3, -0.5px tracking; minor headings 17px. The mobile hero becomes 48px with -2.7px tracking. Paragraphs are usually 11–13px, with 1.8 line height where longer; uppercase terminal metadata uses 8–11px with increased tracking. It is secondary to larger section/action labels.

Inputs remain 16px at every width. Plot IDs and coordinate labels are 10px following review. Plot symbols/levels are 12px; amounts use tabular numerals in statistics and plot IDs. Large metrics are 26px at full width and 22–25px at responsive breakpoints. Addresses and consequential descriptions wrap, and the review dialog always shows the full recipient address.

## Layout

`.shell` caps the page at 1440px, centered with 44px inline gutters. Header and footer share this edge. Content spacing is typically 8–12px within controls, 18–24px between panels and 40–66px between major sections. Four statistic cells form one bordered row. `.city-layout` and `.lower-layout` use a flexible left column and a 350px right column with a 22px gap.

The map is inherently two-dimensional. `.plot-grid` has exactly 16 columns, 4px gaps and a 550px minimum width inside `.map-scroll`; small screens scroll the map itself, while the document reflows. A visible scroll hint, keyboard navigation and numeric “Jump to plot” control provide alternatives. Every plot has a full accessible ID, ownership/level and coordinates. One map button at a time participates in the tab order; arrow keys move by one column/row, Home/End to the first/last plot. Plot targets are at least 30px and do not overlap; other controls are generally 42–48px.

Implemented breakpoints:

- 78rem: shell gutters 28px; sidebar 320px; panel gap 18px.
- 68rem: sidebar 300px; header navigation and hero aside collapse; map scroll guidance appears.
- 54rem: main and lower panels stack; statistics become two columns; the city illustration temporarily floats alongside city text.
- 38rem: gutters 18px; header wraps; city illustration returns to normal flow; economy/footer stack; fields and dialog actions stack. No fixed-height text boxes.

Browser validation covers 1440px, 900px, 390px and 320px. The actual live export was additionally inspected at 1440×1100 and 320×850. Only map-internal horizontal scrolling is intentional. Native 200% browser zoom, translated layouts and physical devices remain unverified.

## Elevation & depth

This is a flat interface: borders communicate panel structure, and tonal surfaces separate inputs and controls. There are no decorative shadows. The native modal dialog has an opaque panel surface and `#000b` backdrop; browser modal behavior makes the page beneath inert. Focused controls use z-index 2 locally; the skip link uses z-index 50.

## Shapes

Panels use 5px radii, buttons/fields 4px, map cells 2px, tags 3px and the dialog 8px. One-pixel borders carry grid structure and selection; focus uses a distinct two-pixel perimeter with 4px offset. The small four-square brand mark and line-drawn city are inline vector/CSS assets, with no image dependency.

## Components

- **`AddressLink` in `App.tsx`:** receives address, optional explorer and optional label. Provides checksummed full-address title, external explorer link and copy action. Compact header copy is hidden below 38rem; full contract/owner address controls remain available elsewhere.
- **Buttons:** neutral default, `.primary` filled lime, `.text-button` understated, `.full` full-width city action. Native disabled state locks unavailable prerequisites. Action-specific labels and the persistent status area explain pending work. A synchronous transaction lock prevents duplicate signing through receipt and refetch.
- **Panels:** `.panel`, `.panel-heading`, `.eyebrow`, `.tag`, `.helper` form the shared section vocabulary. The map, city details, heartbeat and swap panels use these patterns.
- **Plot buttons:** `.plot`, `.owned`, `.mine`, `.selected`. Symbol, level, numeric ID, accessible name and `aria-pressed` complement fill/border states. Selection updates the adjacent city panel without a page route.
- **City panel:** unknown, empty, occupied, own-city, maximum-level and unavailable-action states. An empty plot shows fee/base/total; owned plots show resources, weight, claimable rewards and next-level cost. Approval and purchase are sequential.
- **`SwapPanel`:** directional pair, labeled amount/slippage fields, expected/minimum output and exchange rate, expiring quote, then the required approval or swap control. It preserves its quote across ordinary refreshes, but invalidates stale inputs or wallet eligibility.
- **Forms/disclosures:** native labels and `details`/`summary` keep transfer/operator functions in a compact disclosure. Fieldsets disable unauthorized operator forms. Errors remain visible until a new action clears them; polling does not erase wallet rejection messages.
- **Review dialog:** native `<dialog>` for purchases, level ups, transfers and operator actions. Explains the effect, includes cancel and explicit confirmation, supports Escape, traps focus through browser behavior and restores the invoking control's focus.
- **Status:** persistent polite transaction region; alert for action/deployment errors; visible wrong-network control; empty heartbeat state; visible stale/read failure locking. Unloaded values are em dashes, never fabricated zero balances.

Under `prefers-reduced-motion: no-preference`, buttons transition named background/border/scale properties for 120ms with `cubic-bezier(.2,0,0,1)` on scale; active scale is `.96`. There are no entry animations, autoplay or pulsing status indicators. Hover treatment is restricted to hover-capable devices. Forced-colors CSS preserves system borders and selected outlines.

## Do's and don'ts

Start a new section inside `.shell`, reuse `.panel` and existing type/color tokens, and keep the semantic heading order. Describe consequential actions before asking for a signature. Use the runtime manifest and loaded ABIs; do not introduce a second deployment map. Keep full amounts/addresses in transaction reviews, and distinguish unavailable data from zero.

Do not enable controls while chain, ownership, authorization or deployment checks fail. Do not replace the visible role conflict with fabricated “verified” status. Do not add unknown USD values, external fonts, server-dependent routes or fake city occupancy. Preserve the map's scroll alternative when changing cell density. Rebuild the static export, manifest and affected browser evidence after modifying source.
