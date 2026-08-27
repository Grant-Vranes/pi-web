# Project Rail Card Design

## Goal

Wrap every project indicator in the left project rail in a compact card so individual projects are easier to distinguish without changing the rail's behavior or density.

## Scope

- Update the visual presentation of every project rail item in `SessionSidebar`.
- Preserve project selection, tooltips, drag-and-drop ordering, accessible labels, monograms, and activity states.
- Limit implementation changes to project-rail CSS in `app/globals.css` unless a minimal class hook is needed.

## Visual design

Each `.project-rail-item` is a small, rounded card with a subtle tinted background, a thin border, and balanced internal spacing. The existing two-letter monogram stays centered in the card.

The active project receives a stronger accent-tinted surface and border. Inactive cards remain quiet but gain a clearer surface and border on hover. The card dimensions remain compact enough to preserve the rail's existing narrow, vertical rhythm.

Running and unread indicators remain positioned at the lower-right corner of each card. Their colors and semantics are unchanged. Existing drag insertion feedback remains visible and is not covered by the card treatment.

## Behavior and accessibility

No state, event handler, drag-and-drop behavior, title, or `aria-label` changes. Keyboard and pointer activation continue to use the current button implementation.

## Verification

- Run the existing `SessionSidebar` tests.
- Run `node_modules/.bin/tsc --noEmit`.
- Manually inspect inactive, hovered, active, running, unread, and drag-target card states in the sidebar.
