export type ExcalidrawElement = Record<string, unknown>;
export type BinaryFiles = Record<string, Record<string, unknown>>;
export type ExcalidrawAppState = Record<string, unknown>;

export type SceneChunk = {
  content?: string;
  nextOffset?: number;
  truncated?: boolean;
  size?: number;
  mtimeMs?: number;
  error?: string;
};

export type SceneText = {
  text: string;
  size: number;
  mtimeMs: number;
};

type SceneReadResponse = {
  json(): Promise<SceneChunk>;
};

const MAX_SCENE_CHUNKS = 1024;
const MAX_SCENE_RESTARTS = 3;

/** appState fields persisted back into the scene file (no runtime UI state). */
export const SAVED_APP_STATE_KEYS = ["viewBackgroundColor", "gridSize", "gridModeEnabled"] as const;

function readChunkMetadata(chunk: SceneChunk): { size: number; mtimeMs: number } {
  if (typeof chunk.size !== "number" || typeof chunk.mtimeMs !== "number") {
    throw new Error("Missing Excalidraw scene read metadata");
  }
  return { size: chunk.size, mtimeMs: chunk.mtimeMs };
}

export async function fetchSceneText(
  fetchImpl: (url: string) => Promise<SceneReadResponse>,
  urlForOffset: (offset?: number) => string,
): Promise<SceneText> {
  for (let restarts = 0; restarts <= MAX_SCENE_RESTARTS; restarts += 1) {
    let text = "";
    let offset: number | undefined;
    let chunkCount = 0;
    let expectedSize: number | null = null;
    let expectedMtimeMs: number | null = null;
    let restartRequired = false;

    while (true) {
      const chunk = await fetchImpl(urlForOffset(offset)).then((response) => response.json());
      if (chunk.error) throw new Error(chunk.error);
      const { size, mtimeMs } = readChunkMetadata(chunk);

      if (expectedSize === null || expectedMtimeMs === null) {
        expectedSize = size;
        expectedMtimeMs = mtimeMs;
      } else if (size !== expectedSize || mtimeMs !== expectedMtimeMs) {
        restartRequired = true;
        break;
      }

      text += chunk.content ?? "";
      if (!chunk.truncated) return { text, size: expectedSize, mtimeMs: expectedMtimeMs };

      if (typeof chunk.nextOffset !== "number" || chunk.nextOffset <= (offset ?? 0)) {
        throw new Error("Invalid Excalidraw scene chunk offset");
      }
      offset = chunk.nextOffset;

      chunkCount += 1;
      if (chunkCount > MAX_SCENE_CHUNKS) throw new Error("Too many Excalidraw scene chunks");
    }

    if (!restartRequired) break;
  }

  throw new Error("Excalidraw scene changed while reading");
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
