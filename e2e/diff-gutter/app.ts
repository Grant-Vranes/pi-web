// @ts-nocheck
// Standalone verification of the change-indicator gutter logic used in
// FileViewer's CodeMirror edit mode. Bundled by esbuild and driven by a
// headless Chromium via Playwright below.
import { EditorView, keymap, lineNumbers, gutter, GutterMarker } from "@codemirror/view";
import { EditorState, RangeSet, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { diffLinesBetween } from "../../lib/diff-lines";

class ChangeMark extends GutterMarker {
  constructor(kind) {
    super();
    this.kind = kind;
    this.elementClass = kind === "added" ? "cm-change-add" : "cm-change-mod";
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = this.kind === "added" ? "cm-change-add-bar" : "cm-change-mod-bar";
    return el;
  }
  eq(other) {
    return other instanceof ChangeMark && other.kind === this.kind;
  }
}

class ChangeSpacer extends GutterMarker {
  eq(other) {
    return other instanceof ChangeSpacer;
  }
}

function lineStarts(text) {
  const starts = [0];
  const re = /\r?\n/g;
  let m;
  while ((m = re.exec(text)) !== null) starts.push(m.index + m[0].length);
  return starts;
}

function buildChangeMarkers(changed, text) {
  const starts = lineStarts(text);
  const builder = new RangeSetBuilder();
  const keys = [...changed.keys()].sort((a, b) => a - b);
  for (const line of keys) {
    const pos = starts[line];
    if (pos === undefined) continue;
    builder.add(pos, pos, new ChangeMark(changed.get(line) ?? "modified"));
  }
  return builder.finish();
}

let changeMarkerSet = null;
let baseline = "";

const theme = EditorView.theme({
  ".cm-change-gutter": { width: "6px" },
  ".cm-change-gutter .cm-gutterElement": {
    padding: "0", minWidth: "6px", display: "flex", alignItems: "stretch", justifyContent: "center",
  },
  ".cm-change-add-bar": { width: "3px", alignSelf: "stretch", backgroundColor: "#4ade80", borderRadius: "2px" },
  ".cm-change-mod-bar": { width: "3px", alignSelf: "stretch", backgroundColor: "#f59e0b", borderRadius: "2px" },
});

function extensions() {
  return [
    gutter({
      class: "cm-change-gutter",
      markers: () => changeMarkerSet ?? RangeSet.empty,
      initialSpacer: () => new ChangeSpacer(),
      renderEmptyElements: true,
    }),
    lineNumbers(),
    keymap.of(defaultKeymap),
    EditorState.allowMultipleSelections.of(true),
    theme,
  ];
}

export function init(initial) {
  baseline = initial;
  changeMarkerSet = null;
  window.__view = new EditorView({
    state: EditorState.create({ doc: initial, extensions: extensions() }),
    parent: document.getElementById("app"),
  });
}

// Mimic @uiw/react-codemirror: reactively recompute the diff and reconfigure
// the editor with a fresh extensions array capturing the new marker set.
export function applyText(next) {
  setTimeout(() => {
    const { changed } = diffLinesBetween(baseline, next);
    changeMarkerSet = changed.size === 0 ? null : buildChangeMarkers(changed, next);
    // Replace the doc AND reconfigure with the refreshed markers in one
    // dispatch, mirroring FileViewer where the doc equals the edited text the
    // diff was computed against.
    window.__view.dispatch({
      changes: { from: 0, to: window.__view.state.doc.length, insert: next },
      effects: StateEffect.reconfigure.of(extensions()),
    });
  }, 150);
}