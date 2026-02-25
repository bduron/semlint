export interface DiffFilePaths {
  aPath: string;
  bPath: string;
}

export interface DiffChunk {
  file: string;
  chunk: string;
}

function unquoteDiffPath(raw: string): string {
  if (raw.startsWith("\"") && raw.endsWith("\"") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return raw;
}

export function parseDiffGitHeader(line: string): DiffFilePaths | undefined {
  const match = line.match(
    /^diff --git (?:"a\/((?:[^"\\]|\\.)+)"|a\/(\S+)) (?:"b\/((?:[^"\\]|\\.)+)"|b\/(\S+))$/
  );
  if (!match) {
    return undefined;
  }
  const aRaw = match[1] ?? match[2];
  const bRaw = match[3] ?? match[4];
  if (!aRaw || !bRaw) {
    return undefined;
  }
  return {
    aPath: unquoteDiffPath(aRaw),
    bPath: unquoteDiffPath(bRaw)
  };
}

export function splitDiffIntoFileChunks(diff: string): DiffChunk[] {
  const lines = diff.split("\n");
  const chunks: DiffChunk[] = [];

  let currentLines: string[] = [];
  let currentFile = "";

  const flush = (): void => {
    if (currentLines.length === 0) {
      return;
    }
    chunks.push({
      file: currentFile,
      chunk: currentLines.join("\n")
    });
    currentLines = [];
    currentFile = "";
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const parsed = parseDiffGitHeader(line);
      if (parsed) {
        currentFile = parsed.bPath;
      }
    }
    currentLines.push(line);
  }

  flush();
  return chunks;
}
