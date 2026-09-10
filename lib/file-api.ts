import { encodeFilePathForApi } from "./file-paths";

export type FileApiRequestType = "read" | "download" | "meta" | "preview" | "watch" | "write";

export function getFileApiUrl(
  filePath: string,
  type: FileApiRequestType,
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}
