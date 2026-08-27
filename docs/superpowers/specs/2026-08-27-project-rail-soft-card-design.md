# Project Rail Soft Card Design

## Goal

Refine every project indicator in the left project rail so the small-card treatment feels quieter and the selected project feels more polished.

## Scope

- Replace the visible default project-card border with a soft neutral surface.
- Refine hover and selected-project treatments in project-rail CSS.
- Preserve the existing 36px item size, project monogram, activity badges, drag-and-drop behavior, accessible labels, and keyboard activation.

## Visual design

Every project item remains a rounded compact card, but has no visible outline in its resting state. A subtle neutral background creates separation from the rail without making each indicator look like a bordered button.

Hovering an inactive item lightly raises its background and text contrast, without adding a border. The active project uses a restrained accent-tinted surface, plus a minimal same-hue shadow to imply depth. It must remain clearly selected without an explicit outline or a heavy solid accent fill.

Drag and insertion states retain their existing border and rule treatment because they are temporary spatial feedback, not the resting card presentation. Running and unread badges remain at the lower-right edge of each card with their current colors and semantics.

## Behavior and accessibility

No React markup, state, handlers, tooltip, title, or ARIA changes. The existing focus-visible outline remains available for keyboard users.

## Verification

- Update the project-rail CSS source-contract test for no visible default or hover border and the refined selected surface/shadow.
- Run the focused project-rail and sidebar tests.
- Run `node_modules/.bin/tsc --noEmit`.
- Manually inspect inactive, hover, selected, running, unread, and drag-target states in both light and dark themes.
