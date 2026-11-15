import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fastFetchBinaryStream,
  parseTotalBytesFromContentRange,
  planRangeChunks,
} from './fastDownloader';

test('planRangeChunks and parseTotalBytesFromContentRange compute exact byte ranges', () => {
  assert.deepEqual(planRangeChunks(10, 4), [
    { index: 0, start: 0, end: 3 },
    { index: 1, start: 4, end: 7 },
    { index: 2, start: 8, end: 9 },
  ]);
  assert.equal(parseTotalBytesFromContentRange('bytes 0-3/10'), 10);
  assert.equal(parseTotalBytesFromContentRange(null), 0);
});

test('fastFetchBinaryStream reassembles parallel 206 chunks accurately even after transient 502 retry', async () => {
  const payload = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  let failedOnce = false;

  const mockFetch: typeof fetch = async (_input, init) => {
    const hdrs = (init?.headers || {}) as Record<string, string>;
    const range = hdrs.Range || '';
    const match = range.match(/bytes=(\d+)-(\d+)/);
    if (!match) {
      return new Response(payload, { status: 200 });
    }
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    if (start === 4 && !failedOnce) {
      failedOnce = true;
      return new Response(JSON.stringify({ error: 'Transient 502' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }
    const slice = payload.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        'content-range': `bytes ${start}-${end}/${payload.byteLength}`,
        'content-length': String(slice.byteLength),
      },
    });
  };

  let lastBytes = 0;
  const result = await fastFetchBinaryStream({
    url: '/api/proxy?url=https%3A%2F%2Fcdn.example.com%2Fvideo.mkv',
    chunkSizeBytes: 4,
    concurrency: 3,
    fetchImpl: mockFetch,
    onProgress: (p) => {
      lastBytes = p.receivedBytes;
    },
  });

  assert.equal(result.totalBytes, 10);
  assert.equal(lastBytes, 10);
  const assembled = new Uint8Array(await result.blob.arrayBuffer());
  assert.deepEqual(Array.from(assembled), Array.from(payload));
});

test('fastFetchBinaryStream propagates clear error message on upstream 403/502', async () => {
  const failingFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'Upstream returned HTTP 403' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    () =>
      fastFetchBinaryStream({
        url: '/api/stream/remux?url=https%3A%2F%2Fcdn.example.com%2Fmaster.m3u8',
        fetchImpl: failingFetch,
      }),
    /Upstream returned HTTP 403/
  );
});
