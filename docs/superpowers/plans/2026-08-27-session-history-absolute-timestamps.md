# Session History Absolute Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep today’s session-history timestamps relative while rendering every older session timestamp as a localized date and time through seconds.

**Architecture:** `lib/i18n/format.ts` owns the local-calendar-day decision and timestamp formatting. `components/SessionSidebar.tsx` remains a consumer of the formatter only, so its grouping, ordering, and row layout are unchanged. Tests exercise the formatter through its public API with a fixed local `now`.

**Tech Stack:** TypeScript, Node.js built-in test runner, `Intl.DateTimeFormat`, React 19, Next.js 16.

## Global Constraints

- Today is determined by the browser’s local calendar day, not a rolling 24-hour interval.
- Today keeps the existing `Intl.RelativeTimeFormat` output.
- Yesterday and all earlier dates must show numeric year, month, day, hour, minute, and second in the active UI locale.
- Do not change session sorting, date group labels, group-collapse persistence, row tooltip behavior, or message timestamps.
- Do not overwrite unrelated uncommitted changes in the current worktree.

---

### Task 1: Specify and implement non-today session timestamp formatting

**Files:**
- Modify: `lib/i18n/format.test.mjs`
- Modify: `lib/i18n/format.ts`

**Interfaces:**
- Consumes: existing `formatRelativeTime(date, locale, now)` exported by `lib/i18n/format.ts`.
- Produces: `formatSessionTimestamp(date: Date | string, locale: Locale, now?: Date): string`, returning relative text only when `date` is on `now`’s local calendar day.

- [ ] **Step 1: Write failing formatter tests**

Add this test to `lib/i18n/format.test.mjs`. It deliberately asserts behavior that the current three-day relative-time implementation does not satisfy.

```js
test("formats only today relatively and uses date plus seconds for older sessions", () => {
  const now = new Date(2026, 0, 3, 12, 0, 0);

  assert.equal(
    formatSessionTimestamp(new Date(2026, 0, 3, 8, 0, 0), "en", now),
    "4 hours ago",
  );

  const yesterday = formatSessionTimestamp(new Date(2026, 0, 2, 8, 9, 7), "en", now);
  assert.match(yesterday, /2026/);
  assert.match(yesterday, /08/);
  assert.match(yesterday, /09/);
  assert.match(yesterday, /07/);
  assert.doesNotMatch(yesterday, /day ago/);

  const chinese = formatSessionTimestamp(new Date(2025, 11, 30, 5, 4, 3), "zh-CN", now);
  assert.match(chinese, /2025/);
  assert.match(chinese, /05/);
  assert.match(chinese, /04/);
  assert.match(chinese, /03/);
  assert.doesNotMatch(chinese, /天前/);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --experimental-strip-types --test lib/i18n/format.test.mjs
```

Expected: the new test fails because yesterday currently returns a relative string such as `1 day ago` instead of a date with seconds.

- [ ] **Step 3: Implement the minimal formatter change**

In `lib/i18n/format.ts`, replace the relative-day threshold in `formatSessionTimestamp` with an exact today check and specify all date and time fields for the non-today branch:

```ts
export function formatSessionTimestamp(date: Date | string, locale: Locale, now = new Date()): string {
  if (calendarDaysAgo(date, now) === 0) {
    return formatRelativeTime(date, locale, now);
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date instanceof Date ? date : new Date(date));
}
```

Keep `RELATIVE_DAY_LIMIT` where it is still used by `formatDayLabel`; update the `formatSessionTimestamp` doc comment to state that only today is relative and all other local calendar days include seconds.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
node --experimental-strip-types --test lib/i18n/format.test.mjs
```

Expected: all tests in `lib/i18n/format.test.mjs` pass, including the new non-today assertion.

- [ ] **Step 5: Run the type checker**

Run:

```bash
node_modules/.bin/tsc --noEmit
```

Expected: exits with status 0 and reports no TypeScript errors.

- [ ] **Step 6: Commit only the formatter change**

```bash
git add lib/i18n/format.ts lib/i18n/format.test.mjs
git commit -m "fix: show absolute timestamps for older sessions"
```

Expected: a commit containing only the intended formatter implementation and its tests. Do not stage pre-existing unrelated changes.
