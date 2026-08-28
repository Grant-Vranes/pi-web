export interface DroppedUploadEntry {
  file: File;
  relativePath: string;
}

export interface CollectedDrop {
  entries: DroppedUploadEntry[];
  unsupported: boolean;
}

interface FileEntryLike {
  name: string;
  isFile: true;
  isDirectory: false;
  file(success: (f: File) => void, error?: (e: Error) => void): void;
}

interface DirectoryEntryLike {
  name: string;
  isFile: false;
  isDirectory: true;
  createReader(): { readEntries(success: (entries: unknown[]) => void, error?: (e: Error) => void): void };
}

type AnyEntry = FileEntryLike | DirectoryEntryLike;

function isFileEntry(entry: AnyEntry | null | undefined): entry is FileEntryLike {
  return !!entry && entry.isFile === true && entry.isDirectory === false;
}

function isDirEntry(entry: AnyEntry | null | undefined): entry is DirectoryEntryLike {
  return !!entry && entry.isFile === false && entry.isDirectory === true;
}

function readAllEntries(reader: { readEntries(success: (entries: unknown[]) => void, error?: (e: Error) => void): void }): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const acc: unknown[] = [];
    const step = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(acc);
        } else {
          acc.push(...batch);
          step();
        }
      }, reject);
    };
    step();
  });
}

async function collectEntry(entry: AnyEntry, prefix: string, out: DroppedUploadEntry[]): Promise<void> {
  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(resolve, reject);
    });
    out.push({ file, relativePath });
    return;
  }
  if (isDirEntry(entry)) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) {
      await collectEntry(child as AnyEntry, relativePath, out);
    }
  }
}

export async function collectDroppedUploadEntries(dataTransfer: DataTransfer): Promise<CollectedDrop> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: AnyEntry[] = [];
  let unsupported = true;

  for (const item of items) {
    const getter = (item as { webkitGetAsEntry?: () => AnyEntry | null }).webkitGetAsEntry;
    if (typeof getter !== "function") continue;
    unsupported = false;
    try {
      const entry = getter.call(item as object);
      if (entry) entries.push(entry);
    } catch {
      // ignore items that fail to resolve
    }
  }

  const out: DroppedUploadEntry[] = [];
  if (unsupported) {
    // Fallback: flat files, no structure.
    const files = Array.from(dataTransfer.files ?? []);
    for (const file of files) {
      out.push({ file, relativePath: file.name });
    }
    return { entries: out, unsupported: true };
  }

  for (const entry of entries) {
    await collectEntry(entry, "", out);
  }
  return { entries: out, unsupported: false };
}
