export interface RangeChunkSpec {
  index: number;
  start: number;
  end: number;
}

export interface DownloadProgressInfo {
  receivedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
}

export function planRangeChunks(
  totalBytes: number,
  chunkSizeBytes = 3 * 1024 * 1024
): RangeChunkSpec[] {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || chunkSizeBytes <= 0) {
    return [];
  }
  const chunks: RangeChunkSpec[] = [];
  let start = 0;
  let index = 0;
  while (start < totalBytes) {
    const end = Math.min(totalBytes - 1, start + chunkSizeBytes - 1);
    chunks.push({ index, start, end });
    start = end + 1;
    index += 1;
  }
  return chunks;
}

export function parseTotalBytesFromContentRange(header: string | null): number {
  if (!header) return 0;
  const match = header.match(/bytes\s+\d+-\d+\/(\d+)/i);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      const json = (await res.json()) as { error?: string };
      if (json?.error) return json.error;
    } else {
      const text = await res.text();
      if (text && text.length < 200) return text;
    }
  } catch {
    // ignore body read error
  }
  return `HTTP ${res.status} while downloading stream`;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  maxRetries = 3
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (init.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      const res = await fetchImpl(url, init);
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429 && res.status !== 408) {
        throw new Error(await readErrorMessage(res));
      }
      lastError = new Error(await readErrorMessage(res));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastError = err;
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Download chunk failed');
}

/**
 * High-speed parallel Range downloader + crash-safe streaming fallback.
 * - For /api/proxy endpoints, requests chunk 0 via `Range: bytes=0-<chunkSize-1>`.
 * - If upstream returns 206 Partial Content with known total size, runs 6 concurrent chunk workers
 *   (3 MB per Cloud Run request -> eliminates single-request 500s & multiplies CDN throughput).
 * - If server returns 200 OK or endpoint is /api/stream/remux, streams sequentially cleanly.
 */
export async function fastFetchBinaryStream(params: {
  url: string;
  signal?: AbortSignal;
  estimatedTotalBytes?: number;
  chunkSizeBytes?: number;
  concurrency?: number;
  mimeType?: string;
  onProgress?: (info: DownloadProgressInfo) => void;
  fetchImpl?: typeof fetch;
}): Promise<{ blob: Blob; totalBytes: number }> {
  const {
    url,
    signal,
    estimatedTotalBytes = 0,
    chunkSizeBytes = 3 * 1024 * 1024,
    concurrency = 6,
    mimeType = 'video/mp4',
    onProgress,
    fetchImpl = fetch,
  } = params;

  const isProxyUrl = url.startsWith('/api/proxy');
  const startedAt = Date.now();
  let windowStart = startedAt;
  let windowBytes = 0;
  let lastUiUpdate = 0;
  let receivedBytes = 0;
  let resolvedTotal = estimatedTotalBytes;
  let speedBps = 0;

  const emitProgress = (deltaBytes: number, force = false) => {
    receivedBytes += deltaBytes;
    windowBytes += deltaBytes;
    const now = Date.now();
    const winMs = now - windowStart;
    if (winMs >= 400) {
      speedBps = Math.round((windowBytes * 1000) / winMs);
      windowStart = now;
      windowBytes = 0;
    } else {
      const totalMs = Math.max(150, now - startedAt);
      speedBps = Math.round((receivedBytes * 1000) / totalMs);
    }

    if (force || lastUiUpdate === 0 || now - lastUiUpdate >= 160) {
      lastUiUpdate = now;
      onProgress?.({
        receivedBytes,
        totalBytes: resolvedTotal,
        speedBytesPerSec: speedBps,
      });
    }
  };

  const firstHeaders: Record<string, string> = isProxyUrl
    ? { Range: `bytes=0-${chunkSizeBytes - 1}` }
    : {};

  const firstRes = await fetchWithRetry(url, { signal, headers: firstHeaders }, fetchImpl, 2);

  // Fast Path: 206 Partial Content supported -> parallel multi-worker chunk fetching
  if (firstRes.status === 206 && isProxyUrl) {
    const contentRangeTotal = parseTotalBytesFromContentRange(
      firstRes.headers.get('content-range')
    );
    const firstChunkBuf = new Uint8Array(await firstRes.arrayBuffer());
    emitProgress(firstChunkBuf.byteLength, true);

    if (contentRangeTotal > firstChunkBuf.byteLength) {
      resolvedTotal = contentRangeTotal;
      const allChunks = planRangeChunks(contentRangeTotal, chunkSizeBytes);
      const actualFirstLen = firstChunkBuf.byteLength;
      const pendingSpecs: RangeChunkSpec[] =
        actualFirstLen < chunkSizeBytes
          ? planRangeChunks(contentRangeTotal - actualFirstLen, actualFirstLen).map((c, idx) => ({
              index: idx + 1,
              start: actualFirstLen + c.start,
              end: actualFirstLen + c.end,
            }))
          : allChunks.slice(1);

      const totalParts = pendingSpecs.length + 1;
      const partBuffers: (Uint8Array | null)[] = new Array(totalParts).fill(null);
      partBuffers[0] = firstChunkBuf;

      // For large files (>150 MB), stream completed in-order chunks directly to OPFS disk to prevent mobile RAM OOM
      let opfsFileHandle: FileSystemFileHandle | null = null;
      let opfsWritable: FileSystemWritableFileStream | null = null;
      let opfsDir: FileSystemDirectoryHandle | null = null;
      const opfsTempName = `zx_dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.bin`;
      let nextFlushIdx = 0;

      if (
        contentRangeTotal > 150 * 1024 * 1024 &&
        typeof navigator !== 'undefined' &&
        navigator.storage &&
        typeof navigator.storage.getDirectory === 'function'
      ) {
        try {
          opfsDir = await navigator.storage.getDirectory();
          opfsFileHandle = await opfsDir.getFileHandle(opfsTempName, { create: true });
          opfsWritable = await opfsFileHandle.createWritable();
        } catch {
          opfsFileHandle = null;
          opfsWritable = null;
          opfsDir = null;
        }
      }

      let flushChain = Promise.resolve();
      const scheduleOpfsFlush = () => {
        if (!opfsWritable) return;
        flushChain = flushChain.then(async () => {
          while (opfsWritable && nextFlushIdx < totalParts && partBuffers[nextFlushIdx] !== null) {
            const buf = partBuffers[nextFlushIdx]!;
            await opfsWritable.write(buf as unknown as BufferSource);
            partBuffers[nextFlushIdx] = null; // Release RAM immediately once written to disk
            nextFlushIdx += 1;
          }
        });
      };

      scheduleOpfsFlush();

      let cursor = 0;
      const workerCount = Math.min(concurrency, pendingSpecs.length);

      const worker = async () => {
        while (cursor < pendingSpecs.length) {
          const job = pendingSpecs[cursor++];
          if (!job) break;
          const res = await fetchWithRetry(
            url,
            {
              signal,
              headers: { Range: `bytes=${job.start}-${job.end}` },
            },
            fetchImpl,
            3
          );
          const buf = new Uint8Array(await res.arrayBuffer());
          partBuffers[job.index] = buf;
          scheduleOpfsFlush();
          emitProgress(buf.byteLength);
        }
      };

      try {
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        await flushChain;

        if (opfsWritable && opfsFileHandle) {
          await opfsWritable.close();
          const diskFile = await opfsFileHandle.getFile();
          onProgress?.({
            receivedBytes: contentRangeTotal,
            totalBytes: contentRangeTotal,
            speedBytesPerSec: speedBps,
          });
          return {
            blob: diskFile.slice(0, diskFile.size, mimeType),
            totalBytes: diskFile.size || contentRangeTotal,
          };
        }
      } catch (err) {
        if (opfsWritable) {
          await opfsWritable.abort().catch(() => {});
        }
        if (opfsDir) {
          await opfsDir.removeEntry(opfsTempName).catch(() => {});
        }
        throw err;
      }

      onProgress?.({
        receivedBytes: contentRangeTotal,
        totalBytes: contentRangeTotal,
        speedBytesPerSec: speedBps,
      });
      const blob = new Blob(partBuffers.filter(Boolean) as BlobPart[], { type: mimeType });
      return { blob, totalBytes: blob.size || contentRangeTotal };
    }

    const blob = new Blob([firstChunkBuf] as BlobPart[], { type: mimeType });
    return { blob, totalBytes: blob.size };
  }

  // Fallback Streaming Path: 200 OK (single stream / HLS remux)
  if (!firstRes.body) {
    const arr = new Uint8Array(await firstRes.arrayBuffer());
    emitProgress(arr.byteLength, true);
    const blob = new Blob([arr] as BlobPart[], { type: mimeType });
    return { blob, totalBytes: blob.size };
  }

  const clHeader = firstRes.headers.get('content-length');
  const headerTotal = clHeader ? parseInt(clHeader, 10) : 0;
  if (headerTotal > 0) {
    resolvedTotal = headerTotal;
  }

  const reader = firstRes.body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      emitProgress(value.byteLength);
    }
  }

  const blob = new Blob(chunks as BlobPart[], { type: mimeType });
  onProgress?.({
    receivedBytes: blob.size,
    totalBytes: blob.size,
    speedBytesPerSec: speedBps,
  });
  return { blob, totalBytes: blob.size };
}
