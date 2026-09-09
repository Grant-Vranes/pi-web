/**
 * Maps the language strings produced by the server's file API
 * (`getLanguage` in `app/api/files/[...path]/route.ts`) to CodeMirror 6
 * language extensions so the in-file editor can render syntax highlighting.
 *
 * Languages that have a dedicated `@codemirror/lang-*` package are preferred.
 * The remaining legacy-ish modes (shell, ruby, swift, …) are wrapped from
 * `@codemirror/legacy-modes` with `StreamLanguage`. A `null` return means the
 * editor renders the file as plain text (mirroring the read-only viewer's
 * `react-syntax-highlighter` fallback).
 */

import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { xml } from "@codemirror/lang-xml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
// dockerfile has no @codemirror/lang package; shell highlighting is a close
// visual match and avoids reaching for the fragile legacy docker mode.
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { csharp, kotlin } from "@codemirror/legacy-modes/mode/clike";

function legacy(mode: object): LanguageSupport {
  return new LanguageSupport(
    StreamLanguage.define(mode as Parameters<typeof StreamLanguage.define>[0]),
  );
}

/**
 * Token colors mirror the read-only syntax highlighter's Prism themes
 * (`vscDarkPlus` for dark, `vs` for light, see FileViewer/TextFileViewer) so
 * the in-file editor and the read-only preview look consistent side by side.
 */
const vscDarkPlusTokens = HighlightStyle.define([
  { tag: tags.comment, color: "#6a9955" },
  { tag: tags.lineComment, color: "#6a9955" },
  { tag: tags.blockComment, color: "#6a9955" },
  { tag: tags.keyword, color: "#569cd6" },
  { tag: tags.moduleKeyword, color: "#c586c0" },
  { tag: tags.controlKeyword, color: "#c586c0" },
  { tag: tags.definitionKeyword, color: "#569cd6" },
  { tag: tags.string, color: "#ce9178" },
  { tag: tags.special(tags.string), color: "#ce9178" },
  { tag: tags.number, color: "#b5cea8" },
  { tag: tags.float, color: "#b5cea8" },
  { tag: tags.bool, color: "#569cd6" },
  { tag: tags.null, color: "#569cd6" },
  { tag: tags.operator, color: "#d4d4d4" },
  { tag: tags.punctuation, color: "#d4d4d4" },
  { tag: tags.function(tags.variableName), color: "#dcdcaa" },
  { tag: tags.function(tags.propertyName), color: "#dcdcaa" },
  { tag: tags.definition(tags.function(tags.variableName)), color: "#dcdcaa" },
  { tag: tags.typeName, color: "#4ec9b0" },
  { tag: tags.className, color: "#4ec9b0" },
  { tag: tags.namespace, color: "#4ec9b0" },
  { tag: tags.variableName, color: "#9cdcfe" },
  { tag: tags.propertyName, color: "#9cdcfe" },
  { tag: tags.definition(tags.propertyName), color: "#dcdcaa" },
  { tag: tags.tagName, color: "#569cd6" },
  { tag: tags.attributeName, color: "#9cdcfe" },
  { tag: tags.attributeValue, color: "#ce9178" },
  { tag: tags.regexp, color: "#d16969" },
  { tag: tags.meta, color: "#9cdcfe" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.link, color: "#569cd6", textDecoration: "underline" },
  { tag: tags.heading, color: "#569cd6", fontWeight: "bold" },
]);

const vsTokens = HighlightStyle.define([
  { tag: tags.comment, color: "#008000" },
  { tag: tags.lineComment, color: "#008000" },
  { tag: tags.blockComment, color: "#008000" },
  { tag: tags.keyword, color: "#0000ff" },
  { tag: tags.moduleKeyword, color: "#0000ff" },
  { tag: tags.controlKeyword, color: "#0000ff" },
  { tag: tags.definitionKeyword, color: "#0000ff" },
  { tag: tags.string, color: "#a31515" },
  { tag: tags.special(tags.string), color: "#a31515" },
  { tag: tags.number, color: "#36acaa" },
  { tag: tags.float, color: "#36acaa" },
  { tag: tags.bool, color: "#36acaa" },
  { tag: tags.null, color: "#36acaa" },
  { tag: tags.operator, color: "#393a34" },
  { tag: tags.punctuation, color: "#393a34" },
  { tag: tags.function(tags.variableName), color: "#2b91af" },
  { tag: tags.function(tags.propertyName), color: "#2b91af" },
  { tag: tags.definition(tags.function(tags.variableName)), color: "#2b91af" },
  { tag: tags.typeName, color: "#2b91af" },
  { tag: tags.className, color: "#2b91af" },
  { tag: tags.namespace, color: "#2b91af" },
  { tag: tags.variableName, color: "#393a34" },
  { tag: tags.propertyName, color: "#ff0000" },
  { tag: tags.definition(tags.propertyName), color: "#ff0000" },
  { tag: tags.tagName, color: "#800000" },
  { tag: tags.attributeName, color: "#ff0000" },
  { tag: tags.attributeValue, color: "#0000ff" },
  { tag: tags.regexp, color: "#ff0000" },
  { tag: tags.meta, color: "#393a34" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.link, color: "#0000ff", textDecoration: "underline" },
  { tag: tags.heading, color: "#2b91af", fontWeight: "bold" },
]);

/**
 * Returns a syntax-highlighting extension whose token colors match the
 * read-only preview for the active theme (`vscDarkPlus` dark / `vs` light).
 */
export function getEditorHighlightStyle(isDark: boolean): import("@codemirror/state").Extension {
  return syntaxHighlighting(isDark ? vscDarkPlusTokens : vsTokens, { fallback: true });
}

/**
 * Returns the CodeMirror language extension for a server language string, or
 * `null` when the file should render as unhighlighted plain text.
 */
export function getEditorLanguage(language: string): LanguageSupport | null {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true });
    case "javascript":
      return javascript();
    case "python":
      return python();
    case "go":
      return go();
    case "rust":
      return rust();
    case "java":
      return java();
    case "c":
    case "cpp":
      return cpp();
    case "csharp":
      return legacy(csharp);
    case "kotlin":
      return legacy(kotlin);
    case "html":
      return html();
    case "css":
      return css();
    case "json":
      return json();
    case "yaml":
      return yaml();
    case "toml":
      return legacy(toml);
    case "xml":
      return xml();
    case "markdown":
      return markdown();
    case "bash":
      return legacy(shell);
    case "sql":
      return sql();
    case "dockerfile":
      return legacy(shell);
    case "ruby":
      return legacy(ruby);
    case "swift":
      return legacy(swift);
    // graphql / hcl have no supported CodeMirror mode yet.
    case "text":
    case "graphql":
    case "hcl":
    default:
      return null;
  }
}