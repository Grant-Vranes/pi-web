/**
 * Pure in-file search helpers shared by the file viewer's search bar.
 * Case-insensitive matching folds ASCII letters only: it is length-preserving
 * (offsets always index the original string) and predictable for code.
 */

export interface SearchMatch {
  /** 1-based source line of the match. */
  line: number;
  /** Inclusive UTF-16 start offset into the original content. */
  start: number;
  /** Exclusive UTF-16 end offset into the original content. */
  end: number;
}

const ASCII_UPPER_A = 65;
const ASCII_UPPER_Z = 90;
const ASCII_CASE_DELTA = 32;

function foldCharCode(code: number): number {
  return code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z ? code + ASCII_CASE_DELTA : code;
}

function countNewlinesBetween(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = from; index < to; index++) {
    if (text.charCodeAt(index) === 10) count++;
  }
  return count;
}

function foldMatchesAt(text: string, offset: number, query: string): boolean {
  for (let index = 0; index < query.length; index++) {
    const a = text.charCodeAt(offset + index);
    const b = query.charCodeAt(index);
    if (a !== b && foldCharCode(a) !== foldCharCode(b)) return false;
  }
  return true;
}

export function findMatches(content: string, query: string, caseSensitive: boolean): SearchMatch[] {
  if (query.length === 0 || query.length > content.length) return [];

  const matches: SearchMatch[] = [];
  const lastStart = content.length - query.length;
  let line = 1;
  let cursor = 0;

  scan: while (cursor <= lastStart) {
    if (caseSensitive) {
      const index = content.indexOf(query, cursor);
      if (index !== -1) {
        line += countNewlinesBetween(content, cursor, index);
        matches.push({ line, start: index, end: index + query.length });
        cursor = index + query.length;
        continue;
      }
      let fallbackIndex = -1;
      for (let index = cursor; index <= lastStart; index++) {
        if (foldMatchesAt(content, index, query)) {
          fallbackIndex = index;
        }
      }
      if (fallbackIndex === -1) return matches;
      line += countNewlinesBetween(content, cursor, fallbackIndex);
      matches.push({ line, start: fallbackIndex, end: fallbackIndex + query.length });
      cursor = fallbackIndex + query.length;
      continue;
    }
    for (let index = cursor; index <= lastStart; index++) {
      if (foldMatchesAt(content, index, query)) {
        line += countNewlinesBetween(content, cursor, index);
        matches.push({ line, start: index, end: index + query.length });
        cursor = index + query.length;
        continue scan;
      }
    }
    return matches;
  }
  return matches;
}

export function replaceOne(content: string, match: SearchMatch, replacement: string): string {
  return content.slice(0, match.start) + replacement + content.slice(match.end);
}

export function replaceAll(
  content: string,
  matches: SearchMatch[],
  replacement: string,
): { content: string; count: number } {
  if (matches.length === 0) return { content, count: 0 };
  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(content.slice(cursor, match.start), replacement);
    cursor = match.end;
  }
  parts.push(content.slice(cursor));
  return { content: parts.join(""), count: matches.length };
}
