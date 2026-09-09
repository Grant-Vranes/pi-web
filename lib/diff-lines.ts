/**
 * Line-level diff helpers used to mark which lines the user has changed while
 * editing a file in the CodeMirror editor (the "change markers" on the left
 * gutter). This is intentionally independent of the git-based unified-patch
 * diff (`diffLines` in `components/FileViewer.tsx`): that one compares disk
 * against the git repository, whereas here we compare the *editing baseline*
 * (the on-disk content captured when edit mode is entered) against the
 * current, unsaved draft.
 *
 * We only need to know, for each line that currently exists in the editor,
 * whether it is unchanged, newly added, or modified from the baseline. Removed
 * lines no longer exist in the document and therefore cannot carry a gutter
 * marker.
 *
 * Algorithm: a bounded LCS finds the lines that are identical in both texts
 * (the "anchors"). Between two anchors there is a gap holding some removed
 * baseline lines and some added current lines; each added line is paired, in
 * order, with the most textually similar unused removed line. If they are
 * close enough (a bounded Levenshtein similarity above a threshold) the line
 * is classified *modified* (a replaced line), otherwise *added* (a brand-new
 * line). This mirrors how VS Code distinguishes insert from replace.
 */

/** 0-based line index in the *current* (edited) text → change kind. */
export type ChangeKind = "added" | "modified";

export type DiffLinesBetweenResult = {
  /** Map from 0-based current-line index to its change kind. */
  changed: Map<number, ChangeKind>;
  added: number;
  modified: number;
};

const LCS_LIMIT = 8_000_000; // ≈2800×2800 lines; larger files use the position fallback
const SIMILARITY_THRESHOLD = 0.35; // ≥ this shared fraction ⇒ "modified" instead of "added"

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Fraction of shared characters inferred from a bounded edit distance. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const maxOps = Math.max(3, Math.floor((1 - SIMILARITY_THRESHOLD) * maxLen));
  const d = boundedEditDistance(a, b, maxOps);
  return d > maxOps ? 0 : 1 - d / maxLen;
}

/**
 * Levenshtein distance between two single lines, but stops early and returns
 * `maxOps + 1` as soon as the distance is provably above `maxOps`.
 */
function boundedEditDistance(a: string, b: string, maxOps: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > maxOps) return maxOps + 1;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= m; j++) {
      const v = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      const clamped = v > maxOps ? maxOps + 1 : v;
      curr[j] = clamped;
      if (clamped < rowMin) rowMin = clamped;
    }
    if (rowMin > maxOps) return maxOps + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
}

function pairwiseSame(a: string, b: string, maxLenGap: number): boolean {
  return Math.abs(a.length - b.length) <= maxLenGap;
}

/**
 * Deterministic line diff between `original` (the editing baseline) and
 * `current` (the draft). Returns a map from 0-based line index in `current`
 * to `"added"` or `"modified"`.
 *
 * For very large files the LCS table is skipped in favour of a position-based
 * comparison that still flags changed lines, just without chasing moves.
 */
export function diffLinesBetween(original: string, current: string): DiffLinesBetweenResult {
  const a = splitLines(original);
  const b = splitLines(current);
  const n = a.length;
  const m = b.length;

  const changed = new Map<number, ChangeKind>();
  let added = 0;
  let modified = 0;
  const markModified = (idx: number) => {
    if (changed.has(idx)) return;
    changed.set(idx, "modified");
    modified++;
  };
  const markAdded = (idx: number) => {
    if (changed.has(idx)) return;
    changed.set(idx, "added");
    added++;
  };

  if (n === 0 || m === 0) {
    for (let j = 0; j < m; j++) markAdded(j);
    return { changed, added, modified };
  }

  if (n * m > LCS_LIMIT) {
    // Position-based fallback for very large files.
    const minLen = Math.min(n, m);
    for (let k = 0; k < minLen; k++) {
      if (a[k] !== b[k]) markModified(k);
    }
    for (let j = minLen; j < m; j++) markAdded(j);
    return { changed, added, modified };
  }

  // LCS lengths from (i,j) to the bottom-right.
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i];
    const nextRow = table[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? nextRow[j + 1] + 1 : Math.max(nextRow[j], row[j + 1]);
    }
  }

  // Anchors: identical lines in LCS order.
  const anchors: Array<[number, number]> = [];
  {
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        anchors.push([i, j]);
        i++;
        j++;
      } else if (table[i][j + 1] > table[i + 1][j]) {
        j++;
      } else {
        i++;
      }
    }
  }

  // Within each gap between anchors, pair added lines with the most similar
  // unused removed lines; matched ⇒ modified, unmatched ⇒ added.
  let gapStartOld = 0;
  let gapStartNew = 0;
  for (const [oldIdx, newIdx] of [...anchors, [n, m] as [number, number]]) {
    const removedA = a.slice(gapStartOld, oldIdx);
    const addedB = b.slice(gapStartNew, newIdx);
    const used = new Array<boolean>(removedA.length).fill(false);
    if (addedB.length > 0 && removedA.length <= addedB.length * 2) {
      for (let bi = 0; bi < addedB.length; bi++) {
        const line = addedB[bi];
        let bestIdx = -1;
        let bestScore = SIMILARITY_THRESHOLD; // must beat this to become "modified"
        for (let ri = 0; ri < removedA.length; ri++) {
          if (used[ri]) continue;
          if (!pairwiseSame(removedA[ri], line, Math.max(4, 0.6 * Math.max(removedA[ri].length, line.length)))) {
            continue;
          }
          const sim = similarity(removedA[ri], line);
          if (sim > bestScore) {
            bestScore = sim;
            bestIdx = ri;
          }
        }
        if (bestIdx >= 0) {
          used[bestIdx] = true;
          markModified(gapStartNew + bi);
        } else {
          markAdded(gapStartNew + bi);
        }
      }
    } else {
      for (let j = 0; j < addedB.length; j++) markAdded(gapStartNew + j);
    }
    gapStartOld = oldIdx + 1;
    gapStartNew = newIdx + 1;
  }

  return { changed, added, modified };
}