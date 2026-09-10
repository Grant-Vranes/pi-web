export type ExcalidrawElement = Record<string, unknown>;
export type BinaryFiles = Record<string, Record<string, unknown>>;
export type ExcalidrawAppState = Record<string, unknown>;

export type SceneChunk = {
  content?: string;
  nextOffset?: number;
  truncated?: boolean;
  error?: string;
};

type SceneReadResponse = {
  json(): Promise<SceneChunk>;
};

/** appState fields persisted back into the scene file (no runtime UI state). */
export const SAVED_APP_STATE_KEYS = ["viewBackgroundColor", "gridSize", "gridModeEnabled"] as const;

export async function fetchSceneText(
  fetchImpl: (url: string) => Promise<SceneReadResponse>,
  urlForOffset: (offset?: number) => string,
): Promise<string> {
  let content = "";
  let offset: number | undefined;
  let chunkCount = 0;

  while (true) {
    const chunk = await fetchImpl(urlForOffset(offset)).then((response) => response.json());
    if (chunk.error) throw new Error(chunk.error);
    content += chunk.content ?? "";

    if (!chunk.truncated) return content;
    if (typeof chunk.nextOffset !== "number" || chunk.nextOffset <= (offset ?? 0)) {
      throw new Error("Invalid Excalidraw scene chunk offset");
    }
    offset = chunk.nextOffset;

    chunkCount += 1;
    if (chunkCount > 1024) throw new Error("Too many Excalidraw scene chunks");
  }
}

export function buildMergedScene(
  original: Record<string, unknown>,
  elements: ExcalidrawElement[],
  savedAppState: ExcalidrawAppState,
  files: BinaryFiles,
): Record<string, unknown> {
  const appState: Record<string, unknown> = {};
  for (const key of SAVED_APP_STATE_KEYS) {
    if (key in savedAppState) appState[key] = savedAppState[key];
  }

  return {
    ...original,
    elements,
    appState,
    files,
  };
}
