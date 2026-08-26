---
name: Graft
description: A governed tool layer for websites that never shipped one.
colors:
  kernel-black: "#080404"
  kernel-surface: "#180D0D"
  warm-white: "#F9F4F3"
  signal-red: "#FF645F"
  signal-coral: "#FFA8A0"
  success-green: "#62CB90"
  review-amber: "#E7B963"
typography:
  sans: "IBM Plex Sans, Arial, sans-serif"
  mono: "IBM Plex Mono, SFMono-Regular, Consolas, monospace"
radius:
  control: "10px"
  panel: "16px"
layout:
  contentWidth: "1240px"
  gutter: "clamp(1rem, 3vw, 2.5rem)"
  spacingBase: "4px"
---

# Design system: Graft

## Creative north star

**The Governed Graft**

Graft should feel like serious infrastructure made unusually easy to inspect. The marketing layer is calm, dark and editorial. The compiler is dense, operational and real. A restrained red signal connects the two surfaces, much like a controlled graft joins an existing page to a new agent interface.

The interface must earn trust through visible evidence. It shows the source boundary, sanitization status, derived contracts, review state, native registration and exact call output. Decorative brand work can frame that proof, but it must never replace it.

## Design thesis

The strongest visual contrast is not light versus dark. It is promise versus proof.

- The landing sections explain the product in short, confident language.
- The working compiler proves the claim without a fake dashboard or pre-rendered screenshot.
- Signal red marks the join: the primary action, active selection, connection state and branded focal edge.
- IBM Plex Sans keeps the narrative clear. IBM Plex Mono makes tools, schemas, counters and calls unmistakably machine-readable.

## Palette: Ruby Kernel

The product uses a near-black base with a warm red undertone, warm white text and one red to coral signal family. Semantic green, amber and destructive red appear only for system state.

### Core tokens

| Role | Token | Value |
|---|---|---|
| Page background | `--background` | `oklch(0.115 0.012 20)` |
| Raised surface | `--card` | `oklch(0.175 0.018 20)` |
| Main text | `--foreground` | `oklch(0.97 0.006 20)` |
| Muted text | `--muted-foreground` | `oklch(0.67 0.002 20)` |
| Signal | `--primary` | `oklch(0.70 0.19 25)` |
| Strong border | `--border-strong` | `oklch(0.35 0.025 20)` |
| Success | `--success` | `oklch(0.72 0.13 155)` |
| Review | `--warning` | `oklch(0.78 0.14 78)` |

All primary foreground and background pairs meet WCAG AA. The full light and dark token maps live in `brand.md` and `src/styles.css`.

### Color rules

**One live signal.** Red identifies the primary action or current selection. Do not use it to make every panel feel branded.

**State is semantic.** Green means connected or successful. Amber means held, pending or uncertain. Destructive red means failure or rejection. State never relies on color alone.

**Warm neutrals only.** New gray surfaces should inherit semantic tokens so the red undertone stays coherent.

## Typography

**Display and body:** IBM Plex Sans  
**Tools and data:** IBM Plex Mono

| Role | Size | Use |
|---|---|---|
| Hero display | `clamp(3rem, 7vw, 6.5rem)` | One landing statement |
| Page title | `clamp(2rem, 4vw, 3.5rem)` | Major product claim |
| Section title | `clamp(1.75rem, 3vw, 2.75rem)` | Method, trust and conversion sections |
| Subsection | `1rem` | Panel and card titles |
| UI body | `0.9375rem` | Default controls and explanations |
| Reading copy | `1rem / 1.65` | Longer narrative copy |
| Caption | `0.75rem` | Metadata and timestamps |
| Mono | `0.75rem` | Tool names, counters, schemas and calls |

Human explanation stays in sentence case. Uppercase mono is reserved for compact state, not every label. Numeric readouts use tabular figures.

## Layout

The landing uses a centered 1240px content frame with fluid gutters. Major sections breathe, while the compiler uses tighter spacing to keep evidence visible.

- Desktop hero: narrative and topology image share a balanced two-column frame.
- Source intake: owned fixtures and the compile action stay visually connected.
- Workbench: lifecycle rail, sanitized preview, candidates, selected contract and timeline remain one continuous proof surface.
- Mobile: content stacks in reading order. Preview and tool panels remain mounted so state is not lost.
- Supported review widths: 360px, 768px, 1024px and 1440px.

No viewport may create page-level horizontal scrolling. Dense JSON and code use local scrolling or deliberate wrapping.

## Shape and depth

Controls use a 10px radius. Major panels and media use up to 16px. Pills are reserved for compact connection or state readouts.

Depth comes from tonal surfaces, borders and one restrained layer of blur in the sticky navigation. Shadows should be soft and rare. The compiler must read as one integrated instrument, not a collection of floating cards.

## Gradients and imagery

Two gradients are available:

- `--gradient-bg` for one large atmospheric region such as the hero
- `--gradient-accent` for a thin focal edge or compact brand treatment

Do not stack both behind copy. Text sits on a solid or effectively solid region.

The original semantic topology image, `public/graft-semantic-topology.png`, is the landing brand moment. It visualizes one owned page passing through a controlled red join into typed tool modules. It contains no UI, logos or claims. It must retain its intrinsic 1448 by 1086 aspect ratio and meaningful alt text.

## Signature components

### Primary action

The main compile or open action uses signal red with kernel-black text. Hover, active, disabled, loading and keyboard focus states must remain distinct.

### Source preset

An owned fixture is a real button with a source name, content type and selection state. Selection uses `aria-pressed`, a border change and a signal treatment.

### Compiler rail

The rail exposes Snapshot, Derive and Register in order. It displays current state and concrete counts. During compilation the underlying bench is inert.

### Tool candidate

Each candidate shows the tool name, review state, origin and confidence evidence. The selected row uses `aria-pressed`. Confidence is never a decorative gauge without supporting evidence.

### Contract inspector

The inspector preserves schema descriptions, required fields, validation feedback, review controls and execution state. Editing uses a native form. Consequential local actions use the confirmation dialog.

### Call timeline

The timeline is latest first and exposes the method, state, duration, arguments and returned payload. Expanded output must stay readable at 360px and 1440px.

## Interaction and motion

- General UI transitions: 100ms to 160ms on the specific changing property
- Compilation: a restrained signal pulse with clear text progress
- Press feedback: subtle scale or tonal change, never layout movement
- Reduced motion: smooth scrolling, pulses and nonessential transitions become instant
- Focus: 3px signal ring with adequate offset
- Touch targets: at least 44 by 44px for primary interaction controls

Never use `transition: all`. Do not autoplay decorative motion.

## Content and voice

Use direct verbs: compile, sanitize, derive, review, register, run and export. Name the boundary and the outcome. Prefer a count or concrete state over an adjective.

Example: `3 tools derived. 2 registered. 1 held for review.`

Avoid claims such as universal, autonomous or arbitrary-site support. Avoid empty hype such as revolutionary, seamless, game-changing and supercharge.

## Non-negotiables

- Keep the real compiler as the product proof.
- Keep permission, sanitization, review and registration boundaries visible.
- Keep all controls semantic, labelled and keyboard reachable.
- Keep native WebMCP state visible in the header and timeline.
- Keep the preview iframe sandboxed.
- Preserve compile, error, held, published, cancelled, empty and disconnected states.
- Respect reduced motion and high-contrast focus.
- Use icons from the established icon library. Do not use Unicode glyphs as interface icons.

## Avoid

- Fake product screenshots or decorative dashboard mockups
- Generic three-card SaaS feature grids
- Giant poster type that obscures the product explanation
- Every-label-is-microcopy styling
- Excessive pills, floating capsules or stacked rounded cards
- Decorative dots, long ruled lists or unexplained gauges
- Multiple accent colors, glass-heavy effects or theme flips between sections
- Changing tool names, action semantics or WebMCP claims for visual polish

## Release review

Before shipping a visual change:

1. Confirm the strongest product claim is visible before the first scroll.
2. Compile every fixture and verify the state sequence.
3. Run a read tool and a confirmed local mutation.
4. Verify held, published, cancelled, error and disconnected states.
5. Inspect at 360px, 768px, 1024px and 1440px.
6. Check focus, touch targets, reduced motion, overflow and image loading.
7. Run tests, typecheck and the production build.

The canonical palette and typography specification is `brand.md`. This document governs how those tokens become product experience.
