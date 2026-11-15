import express from 'express';
import { createServer as createViteServer } from 'vite';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import path from 'node:path';
import { zangetsuRuntime } from './src/runtime/zangetsuRuntime.ts';

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface ProbedAudioTrack {
  index: number;
  streamIndex: number;
  codec: string;
  language: string;
  title: string;
  channels: number;
  channelLayout: string;
  bitrate: string;
  isDefault: boolean;
}

export interface ProbedSubtitleTrack {
  index: number;
  streamIndex: number;
  codec: string;
  language: string;
  title: string;
}

export interface ProbedMediaMetadata {
  duration: number;
  sizeBytes: number;
  formatName: string;
  videoCodec: string;
  width: number;
  height: number;
  audioTracks: ProbedAudioTrack[];
  subtitleTracks: ProbedSubtitleTrack[];
  needsRemux: boolean;
}

const probeCache = new Map<string, ProbedMediaMetadata>();

function formatLangName(code: string, title?: string): string {
  const c = String(code || '').toLowerCase();
  const map: Record<string, string> = {
    hin: 'Hindi',
    hi: 'Hindi',
    eng: 'English',
    en: 'English',
    jpn: 'Japanese',
    ja: 'Japanese',
    tam: 'Tamil',
    tel: 'Telugu',
    mal: 'Malayalam',
    kan: 'Kannada',
    kor: 'Korean',
    chi: 'Chinese',
    zho: 'Chinese',
    spa: 'Spanish',
    fre: 'French',
    ger: 'German',
    rus: 'Russian',
    und: 'Original Audio',
  };
  const base = map[c] || (code ? code.toUpperCase() : 'Track');
  if (title && !/hdhub4u|mkvmerge/i.test(title) && title.toLowerCase() !== base.toLowerCase()) {
    return `${base} (${title})`;
  }
  return base;
}

async function probeStreamUrl(url: string, headers?: Record<string, string>): Promise<ProbedMediaMetadata> {
  if (probeCache.has(url)) {
    return probeCache.get(url)!;
  }

  return new Promise((resolve, reject) => {
    const args: string[] = ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format'];
    if (headers && Object.keys(headers).length > 0) {
      const hdrLines = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      args.push('-headers', hdrLines + '\r\n');
    }
    args.push(url);

    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffprobe timed out'));
    }, 12000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout) {
        return reject(new Error(`ffprobe exited with ${code}: ${stderr.slice(0, 200)}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        const streams = parsed.streams || [];
        const format = parsed.format || {};

        const videoStream = streams.find((s: Record<string, unknown>) => s.codec_type === 'video' && s.codec_name !== 'png' && s.codec_name !== 'mjpeg') || {};
        const audioStreams = streams.filter((s: Record<string, unknown>) => s.codec_type === 'audio');
        const subStreams = streams.filter(
          (s: Record<string, unknown>) =>
            s.codec_type === 'subtitle' &&
            ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(String(s.codec_name || ''))
        );

        const audioTracks: ProbedAudioTrack[] = audioStreams.map((s: Record<string, any>, idx: number) => {
          const langCode = s.tags?.language || 'und';
          const rawTitle = s.tags?.title || '';
          const channels = Number(s.channels || 2);
          const layout = s.channel_layout || (channels === 6 ? '5.1' : 'stereo');
          const codec = String(s.codec_name || 'aac').toUpperCase();
          const br = s.bit_rate || s.tags?.BPS;
          const bitrate = br ? `${Math.round(Number(br) / 1000)} kbps` : `${channels}ch`;

          return {
            index: idx,
            streamIndex: Number(s.index),
            codec,
            language: formatLangName(langCode, rawTitle),
            title: `${formatLangName(langCode, rawTitle)} · ${codec} ${layout.toUpperCase()} (${bitrate})`,
            channels,
            channelLayout: layout,
            bitrate,
            isDefault: Boolean(s.disposition?.default),
          };
        });

        const subtitleTracks: ProbedSubtitleTrack[] = subStreams.map((s: Record<string, any>, idx: number) => {
          const langCode = s.tags?.language || 'eng';
          const rawTitle = s.tags?.title || '';
          return {
            index: idx,
            streamIndex: Number(s.index),
            codec: String(s.codec_name || 'subrip'),
            language: langCode,
            title: formatLangName(langCode, rawTitle),
          };
        });

        const videoCodec = String(videoStream.codec_name || 'h264').toLowerCase();
        const formatName = String(format.format_name || '').toLowerCase();
        const hasNonBrowserAudio = audioStreams.some((s: Record<string, any>) =>
          ['eac3', 'ac3', 'dts', 'dca', 'truehd', 'flac', 'alac', 'wmav2', 'pcm_s16le', 'pcm_s24le'].includes(
            String(s.codec_name || '').toLowerCase()
          )
        );
        const nonNativeVideoCodec = [
          'hevc',
          'h265',
          'mpeg2video',
          'mpeg4',
          'msmpeg4v3',
          'wmv3',
          'flv1',
          'xvid',
          'divx',
        ].includes(videoCodec);
        const nonNativeContainer = [
          'matroska',
          'avi',
          'flv',
          'asf',
          'mpegts',
          'mpeg',
          'mov',
        ].some((fmt) => formatName.includes(fmt));

        const needsRemux =
          nonNativeContainer ||
          nonNativeVideoCodec ||
          hasNonBrowserAudio ||
          audioTracks.length > 1;

        const result: ProbedMediaMetadata = {
          duration: parseFloat(format.duration || videoStream.duration || '0') || 0,
          sizeBytes: parseInt(format.size || '0', 10) || 0,
          formatName,
          videoCodec,
          width: Number(videoStream.width || 0),
          height: Number(videoStream.height || 0),
          audioTracks,
          subtitleTracks,
          needsRemux,
        };

        probeCache.set(url, result);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // 1. Zangetsu Manifest & Providers list
  app.get('/api/zangetsu/manifest', async (_req, res) => {
    try {
      const manifest = await zangetsuRuntime.getManifest();
      res.json(manifest);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load manifest' });
    }
  });

  // 2. Zangetsu Provider Source Code Inspection (for live JS Runtime modal)
  app.get('/api/zangetsu/code/:sourceId', async (req, res) => {
    try {
      const code = await zangetsuRuntime.getExtensionCode(req.params.sourceId);
      res.json({ sourceId: req.params.sourceId, code, logs: zangetsuRuntime.getRecentLogs(req.params.sourceId) });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load extension code' });
    }
  });

  // 3. Zangetsu Runtime Logs
  app.get('/api/zangetsu/logs', (req, res) => {
    const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
    res.json({ logs: zangetsuRuntime.getRecentLogs(sourceId) });
  });

  // 4. Zangetsu Home Catalog
  app.get('/api/zangetsu/home/:sourceId', async (req, res) => {
    try {
      const rows = await zangetsuRuntime.getHome(req.params.sourceId);
      res.json({ sourceId: req.params.sourceId, rows, logs: zangetsuRuntime.getRecentLogs(req.params.sourceId) });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load home catalog' });
    }
  });

  // 5. Zangetsu Search (single provider or multi-provider Movie/Anime search)
  app.get('/api/zangetsu/search/:sourceId', async (req, res) => {
    try {
      const q = String(req.query.q || '');
      const page = parseInt(String(req.query.page || '1'), 10) || 1;
      const scope = req.query.scope === 'movie' || req.query.scope === 'anime' || req.query.scope === 'all'
        ? req.query.scope
        : undefined;

      if (scope || req.params.sourceId === 'multi') {
        const items = await zangetsuRuntime.searchMulti(
          q,
          scope || 'all',
          req.params.sourceId !== 'multi' ? req.params.sourceId : undefined
        );
        return res.json({
          sourceId: req.params.sourceId,
          query: q,
          items,
          logs: zangetsuRuntime.getRecentLogs(),
        });
      }

      const items = await zangetsuRuntime.search(req.params.sourceId, q, page);
      res.json({ sourceId: req.params.sourceId, query: q, items, logs: zangetsuRuntime.getRecentLogs(req.params.sourceId) });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  // 5b. Auto-Failover Provider Resolver (when current anime/movie provider playback fails)
  app.get('/api/zangetsu/failover', async (req, res) => {
    try {
      const currentSourceId = String(req.query.sourceId || 'hianime');
      const title = String(req.query.title || '');
      const episodeNumber = parseInt(String(req.query.episodeNumber || '1'), 10) || 1;
      const mediaType = req.query.type === 'movie' ? 'movie' : 'anime';
      const category = req.query.category === 'dub' ? 'dub' : 'sub';
      const exclude = typeof req.query.exclude === 'string' && req.query.exclude
        ? req.query.exclude.split(',').filter(Boolean)
        : [];

      if (!title) return res.status(400).json({ error: 'Missing title for auto-failover' });

      const result = await zangetsuRuntime.resolveFailoverProvider(
        currentSourceId,
        title,
        episodeNumber,
        mediaType,
        category,
        exclude
      );

      if (!result) {
        return res.status(404).json({ error: 'No alternative provider had playable streams for this title' });
      }

      res.json({
        resolved: true,
        ...result,
        logs: zangetsuRuntime.getRecentLogs(),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Auto-failover failed' });
    }
  });

  // 6. Zangetsu Detail & Episodes
  app.get('/api/zangetsu/detail/:sourceId', async (req, res) => {
    try {
      const url = String(req.query.url || '');
      if (!url) return res.status(400).json({ error: 'Missing url parameter' });
      const detail = await zangetsuRuntime.getDetail(req.params.sourceId, url);
      res.json({ detail, logs: zangetsuRuntime.getRecentLogs(req.params.sourceId) });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load media details' });
    }
  });

  // 7. Zangetsu Resolve Video Sources
  app.get('/api/zangetsu/sources/:sourceId', async (req, res) => {
    try {
      const episodeUrl = String(req.query.episodeUrl || '');
      const category = req.query.category === 'dub' ? 'dub' : 'sub';
      if (!episodeUrl) return res.status(400).json({ error: 'Missing episodeUrl parameter' });
      const sources = await zangetsuRuntime.getVideoSources(req.params.sourceId, episodeUrl, category);
      res.json({
        sourceId: req.params.sourceId,
        sources,
        logs: zangetsuRuntime.getRecentLogs(req.params.sourceId),
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'No playable video sources resolved' });
    }
  });

  // 8. FFprobe Media Stream Inspector (Audio Tracks, Codecs, Subtitles, Duration)
  app.get('/api/stream/probe', async (req, res) => {
    try {
      const url = String(req.query.url || '');
      if (!url) return res.status(400).json({ error: 'Missing url' });
      let headers: Record<string, string> = { 'User-Agent': DEFAULT_UA };
      if (typeof req.query.headers === 'string' && req.query.headers) {
        try {
          headers = { ...headers, ...JSON.parse(req.query.headers) };
        } catch {}
      }
      const metadata = await probeStreamUrl(url, headers);
      res.json(metadata);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Probe failed' });
    }
  });

  // 8b. Lightweight HLS Master Playlist Inspector (returns real levels & audio tracks for a selected server)
  app.get('/api/stream/hls-info', async (req, res) => {
    try {
      const targetUrl = String(req.query.url || '');
      if (!targetUrl) return res.status(400).json({ error: 'Missing url' });

      let customHeaders: Record<string, string> = {};
      if (typeof req.query.headers === 'string' && req.query.headers) {
        try {
          customHeaders = JSON.parse(req.query.headers);
        } catch {}
      }

      const fetchHeaders: Record<string, string> = {
        'User-Agent': customHeaders['User-Agent'] || DEFAULT_UA,
      };
      if (customHeaders['Referer'] || customHeaders['referer']) {
        fetchHeaders['Referer'] = customHeaders['Referer'] || customHeaders['referer'];
      }
      if (customHeaders['Origin'] || customHeaders['origin']) {
        fetchHeaders['Origin'] = customHeaders['Origin'] || customHeaders['origin'];
      }
      if (customHeaders['Cookie'] || customHeaders['cookie']) {
        fetchHeaders['Cookie'] = customHeaders['Cookie'] || customHeaders['cookie'];
      }

      const upstream = await fetch(targetUrl, { headers: fetchHeaders, redirect: 'follow' });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ levels: [], audioTracks: [] });
      }
      const text = await upstream.text();
      const baseUrl = upstream.url || targetUrl;
      const lines = text.split('\n').map((l) => l.trim());

      const levels: { index: number; height: number; bitrate: number; variantUrl?: string }[] = [];
      const audioTracks: { index: number; name: string; lang: string }[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/i.test(line)) {
          const nameMatch = line.match(/NAME="([^"]+)"/i);
          const langMatch = line.match(/LANGUAGE="([^"]+)"/i);
          audioTracks.push({
            index: audioTracks.length,
            name: nameMatch?.[1] || langMatch?.[1] || `Track ${audioTracks.length + 1}`,
            lang: langMatch?.[1] || '',
          });
        } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
          const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
          const nextLine = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : '';
          const height = resMatch ? parseInt(resMatch[1], 10) : 0;
          const bitrate = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          if (height > 0 && nextLine) {
            let variantUrl = nextLine;
            try {
              variantUrl = new URL(nextLine, baseUrl).toString();
            } catch {}
            levels.push({
              index: levels.length,
              height,
              bitrate,
              variantUrl,
            });
          }
        }
      }

      res.json({ levels, audioTracks });
    } catch {
      res.json({ levels: [], audioTracks: [] });
    }
  });

  // 9. Live FFmpeg Remux & Minimal-MB Stream Engine (strips extra audio/attachments -> fragmented MP4)
  app.get('/api/stream/remux', async (req, res) => {
    const url = String(req.query.url || '');
    if (!url) return res.status(400).json({ error: 'Missing url' });

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Unsupported stream URL protocol' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid stream URL' });
    }

    const audioIndex = parseInt(String(req.query.audioIndex || '0'), 10) || 0;
    const startSeconds = parseFloat(String(req.query.start || '0')) || 0;
    const forceTranscodeVideo = req.query.transcodeVideo === '1';
    const isCompact = req.query.compact === '1';
    const maxHeight = Math.max(240, Math.min(1080, parseInt(String(req.query.maxHeight || '480'), 10) || 480));

    let headers: Record<string, string> = { 'User-Agent': DEFAULT_UA };
    if (typeof req.query.headers === 'string' && req.query.headers) {
      try {
        headers = { ...headers, ...JSON.parse(req.query.headers) };
      } catch {}
    }

    const isHlsInput = /\.m3u8(\?|$)/i.test(url);
    const args: string[] = ['-v', 'error'];

    let directTsSegments: string[] | null = null;
    if (isHlsInput && startSeconds === 0) {
      try {
        const hdrs: Record<string, string> = { 'User-Agent': headers['User-Agent'] || DEFAULT_UA };
        if (headers['Referer'] || headers['referer']) hdrs['Referer'] = headers['Referer'] || headers['referer'];
        if (headers['Origin'] || headers['origin']) hdrs['Origin'] = headers['Origin'] || headers['origin'];
        if (headers['Cookie'] || headers['cookie']) hdrs['Cookie'] = headers['Cookie'] || headers['cookie'];

        const m3u8Res = await fetch(url, { headers: hdrs, redirect: 'follow' });
        if (m3u8Res.ok) {
          let playlistText = await m3u8Res.text();
          let playlistBase = m3u8Res.url || url;

          // Resolve variant playlist from master if needed
          if (playlistText.includes('#EXT-X-STREAM-INF')) {
            const pLines = playlistText.split('\n').map((l) => l.trim());
            const variants: { bw: number; height: number; vUrl: string }[] = [];
            for (let i = 0; i < pLines.length; i++) {
              if (pLines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bw = parseInt(pLines[i].match(/BANDWIDTH=(\d+)/i)?.[1] || '0', 10);
                const h = parseInt(pLines[i].match(/RESOLUTION=\d+x(\d+)/i)?.[1] || '0', 10);
                const nxt = pLines[i + 1];
                if (nxt && !nxt.startsWith('#')) {
                  variants.push({ bw, height: h, vUrl: new URL(nxt, playlistBase).toString() });
                }
              }
            }
            if (variants.length > 0) {
              variants.sort((a, b) => (isCompact ? a.height - b.height : b.bw - a.bw));
              const chosen = isCompact
                ? variants.find((v) => v.height >= maxHeight) || variants[0]
                : variants[0];
              const vRes = await fetch(chosen.vUrl, { headers: hdrs, redirect: 'follow' });
              if (vRes.ok) {
                playlistText = await vRes.text();
                playlistBase = vRes.url || chosen.vUrl;
              }
            }
          }

          // Use ultra-fast 6-worker parallel prefetcher for unencrypted TS playlists (no EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA audio)
          if (
            playlistText.includes('#EXTINF') &&
            !/#EXT-X-KEY/i.test(playlistText) &&
            !/#EXT-X-MAP/i.test(playlistText) &&
            !/#EXT-X-MEDIA:.*TYPE=AUDIO/i.test(playlistText)
          ) {
            const segUrls = playlistText
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l && !l.startsWith('#'))
              .map((l) => new URL(l, playlistBase).toString());
            if (segUrls.length > 0) {
              directTsSegments = segUrls;
            }
          }
        }
      } catch {
        directTsSegments = null;
      }
    }

    let ffmpegInputUrl = url;
    if (directTsSegments) {
      ffmpegInputUrl = 'pipe:0';
      args.push('-f', 'mpegts');
    } else if (isHlsInput) {
      // Route HLS master/media playlists & segments through local /api/proxy (Node fetch passes CDN checks that ffmpeg HTTP client fails with 403)
      const hdrJson = encodeURIComponent(JSON.stringify(headers));
      ffmpegInputUrl = `http://127.0.0.1:${PORT}/api/proxy?url=${encodeURIComponent(url)}&headers=${hdrJson}&abs=1`;
      args.push(
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-allowed_extensions', 'ALL',
        '-http_persistent', '1'
      );
    } else {
      if (headers['User-Agent']) {
        args.push('-user_agent', headers['User-Agent']);
      }
      const extraHdrEntries = Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'user-agent');
      if (extraHdrEntries.length > 0) {
        const hdrLines = extraHdrEntries.map(([k, v]) => `${k}: ${v}`).join('\r\n');
        args.push('-headers', hdrLines + '\r\n');
      }
      args.push(
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5'
      );
    }

    if (startSeconds > 0 && !directTsSegments) {
      args.push('-ss', String(startSeconds));
    }

    if (!directTsSegments) {
      args.push('-probesize', '1000000', '-analyzeduration', '1000000');
    }

    args.push(
      '-i', ffmpegInputUrl,
      '-map', '0:v:0',
      '-map', `0:a:${audioIndex}?`,
      '-sn',
      '-dn'
    );

    if (isCompact) {
      args.push(
        '-vf', `scale=-2:'min(ih,${maxHeight})'`,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '28',
        '-pix_fmt', 'yuv420p'
      );
    } else if (forceTranscodeVideo) {
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'copy');
    }

    args.push(
      '-c:a', 'aac',
      '-ac', '2',
      '-b:a', isCompact ? '96k' : '128k',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-flush_packets', '1',
      '-f', 'mp4',
      'pipe:1'
    );

    const ff = spawn('ffmpeg', args);
    let startedStreaming = false;
    let finished = false;
    let stderrBuf = '';
    const segAbort = new AbortController();

    if (directTsSegments) {
      const segs = directTsSegments;
      const segHdrs: Record<string, string> = { 'User-Agent': headers['User-Agent'] || DEFAULT_UA };
      if (headers['Referer'] || headers['referer']) segHdrs['Referer'] = headers['Referer'] || headers['referer'];
      if (headers['Origin'] || headers['origin']) segHdrs['Origin'] = headers['Origin'] || headers['origin'];
      if (headers['Cookie'] || headers['cookie']) segHdrs['Cookie'] = headers['Cookie'] || headers['cookie'];

      ff.stdin.on('error', () => {});
      void (async () => {
        const batchSize = 6;
        try {
          for (let i = 0; i < segs.length; i += batchSize) {
            if (finished || segAbort.signal.aborted) break;
            const batch = segs.slice(i, i + batchSize);
            const buffers = await Promise.all(
              batch.map(async (segUrl) => {
                for (let attempt = 0; attempt < 3; attempt++) {
                  if (finished || segAbort.signal.aborted) return Buffer.alloc(0);
                  try {
                    const r = await fetch(segUrl, { headers: segHdrs, signal: segAbort.signal });
                    if (r.ok) {
                      return Buffer.from(await r.arrayBuffer());
                    }
                  } catch {
                    if (segAbort.signal.aborted) return Buffer.alloc(0);
                  }
                }
                return Buffer.alloc(0);
              })
            );
            for (const buf of buffers) {
              if (finished || segAbort.signal.aborted) break;
              if (buf.length > 0 && ff.stdin.writable) {
                const ok = ff.stdin.write(buf);
                if (!ok) {
                  await new Promise<void>((r) => ff.stdin.once('drain', r));
                }
              }
            }
          }
          if (!finished && ff.stdin.writable) ff.stdin.end();
        } catch {
          if (!finished && ff.stdin.writable) ff.stdin.end();
        }
      })();
    }

    const firstByteTimer = setTimeout(() => {
      if (!startedStreaming && !finished) {
        finished = true;
        segAbort.abort();
        try {
          ff.kill('SIGKILL');
        } catch {}
        if (!res.headersSent) {
          res.status(504).json({
            error: stderrBuf.trim() || 'Stream remux timed out waiting for initial media bytes.',
          });
        }
      }
    }, 25000);

    ff.stderr.on('data', (chunk) => {
      if (stderrBuf.length < 2048) {
        stderrBuf += chunk.toString();
      }
    });

    ff.stdout.on('data', (chunk: Buffer) => {
      if (finished) return;
      if (!startedStreaming) {
        startedStreaming = true;
        clearTimeout(firstByteTimer);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.query.download === '1') {
          const filename = String(req.query.filename || 'zangetsu-download.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        }
      }
      if (!res.writableEnded && !res.destroyed) {
        const ok = res.write(chunk);
        if (!ok) {
          ff.stdout.pause();
          res.once('drain', () => {
            if (!finished) ff.stdout.resume();
          });
        }
      }
    });

    ff.stdout.on('end', () => {
      clearTimeout(firstByteTimer);
      if (startedStreaming && !res.writableEnded) {
        res.end();
      }
    });

    ff.stdout.on('error', () => {
      clearTimeout(firstByteTimer);
      segAbort.abort();
      if (!res.headersSent) {
        res.status(502).json({ error: 'Stream read error during remux' });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    ff.on('error', (err) => {
      clearTimeout(firstByteTimer);
      if (finished) return;
      finished = true;
      segAbort.abort();
      if (!res.headersSent) {
        res.status(502).json({ error: err.message || 'FFmpeg spawn failed' });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    ff.on('close', (code) => {
      clearTimeout(firstByteTimer);
      if (finished) return;
      finished = true;
      segAbort.abort();
      if (!startedStreaming) {
        if (!res.headersSent) {
          res.status(502).json({
            error: stderrBuf.trim() || `FFmpeg exited with status ${code ?? 'unknown'} before streaming bytes`,
          });
        }
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    req.on('close', () => {
      clearTimeout(firstByteTimer);
      if (!finished) {
        finished = true;
        segAbort.abort();
        try {
          ff.kill('SIGKILL');
        } catch {}
      }
    });

    res.on('error', () => {
      clearTimeout(firstByteTimer);
      if (!finished) {
        finished = true;
        segAbort.abort();
        try {
          ff.kill('SIGKILL');
        } catch {}
      }
    });
  });

  // 10. Live Embedded & External Subtitle Converter (converts MKV SubRip/ASS/SRT track to WebVTT on the fly)
  app.get('/api/stream/EmbeddedSub.vtt', (req, res) => {
    const url = String(req.query.url || '');
    const subIndex = parseInt(String(req.query.subIndex || '0'), 10) || 0;
    const startSeconds = parseFloat(String(req.query.start || '0')) || 0;
    if (!url) return res.status(400).send('Missing url');

    let headers: Record<string, string> = { 'User-Agent': DEFAULT_UA };
    if (typeof req.query.headers === 'string' && req.query.headers) {
      try {
        headers = { ...headers, ...JSON.parse(req.query.headers) };
      } catch {}
    }

    const args: string[] = ['-v', 'error'];
    if (Object.keys(headers).length > 0) {
      const hdrLines = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      args.push('-headers', hdrLines + '\r\n');
    }
    if (startSeconds > 0) {
      args.push('-ss', String(startSeconds));
    }
    args.push('-i', url, '-map', `0:s:${subIndex}`, '-f', 'webvtt', 'pipe:1');

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const ff = spawn('ffmpeg', args);
    ff.stdout.pipe(res);

    ff.stdout.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    ff.on('error', () => {
      if (!res.headersSent) res.status(502).send('WEBVTT\n\n');
      else if (!res.writableEnded) res.end();
    });
    res.on('error', () => {
      try {
        ff.kill('SIGKILL');
      } catch {}
    });
    req.on('close', () => {
      try {
        ff.kill('SIGKILL');
      } catch {}
    });
  });

  // 10b. External Subtitle Converter (.srt / .ass / .ssa / .vtt -> WebVTT)
  app.get('/api/stream/subtitle.vtt', async (req, res) => {
    try {
      const targetUrl = String(req.query.url || '');
      if (!targetUrl) return res.status(400).send('Missing url');

      let customHeaders: Record<string, string> = {};
      if (typeof req.query.headers === 'string' && req.query.headers) {
        try {
          customHeaders = JSON.parse(req.query.headers);
        } catch {}
      }

      const upstream = await fetch(targetUrl, {
        headers: {
          'User-Agent': customHeaders['User-Agent'] || DEFAULT_UA,
          ...(customHeaders['Referer'] ? { Referer: customHeaders['Referer'] } : {}),
          ...(customHeaders['Cookie'] ? { Cookie: customHeaders['Cookie'] } : {}),
        },
      });

      if (!upstream.ok) {
        return res.status(upstream.status).send('Subtitle fetch failed');
      }

      const rawText = await upstream.text();
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (rawText.trimStart().startsWith('WEBVTT')) {
        return res.send(rawText);
      }

      // Convert SRT or ASS/SSA text to WebVTT
      const normalized = rawText.replace(/\r\n/g, '\n');
      if (/\[Events\]/i.test(normalized)) {
        // Basic ASS/SSA Dialogue -> WebVTT conversion
        const lines = normalized.split('\n');
        const vttCues: string[] = ['WEBVTT', ''];
        for (const line of lines) {
          if (line.startsWith('Dialogue:')) {
            const parts = line.slice(9).split(',');
            if (parts.length >= 10) {
              const start = parts[1].trim().padStart(10, '0');
              const end = parts[2].trim().padStart(10, '0');
              const text = parts
                .slice(9)
                .join(',')
                .replace(/\{[^}]*\}/g, '')
                .replace(/\\N/gi, '\n')
                .trim();
              if (text) {
                vttCues.push(`0${start}0 --> 0${end}0\n${text}\n`);
              }
            }
          }
        }
        return res.send(vttCues.join('\n'));
      }

      // Standard SRT -> WebVTT conversion
      const vttBody =
        'WEBVTT\n\n' +
        normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      return res.send(vttBody);
    } catch {
      res.status(500).send('WEBVTT\n\n');
    }
  });

  // 11. Universal CORS Media & HLS Manifest Proxy + Range/HEAD Support + Crash-Safe Streaming
  app.all('/api/proxy', async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(405).send('Method not allowed');
    }

    const abortCtrl = new AbortController();
    const connectTimer = setTimeout(() => abortCtrl.abort(), 30000);
    let clientClosed = false;

    req.on('close', () => {
      clientClosed = true;
      clearTimeout(connectTimer);
      abortCtrl.abort();
    });

    try {
      const targetUrl = String(req.query.url || '');
      if (!targetUrl) {
        clearTimeout(connectTimer);
        return res.status(400).json({ error: 'Missing url' });
      }

      try {
        const parsed = new URL(targetUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          clearTimeout(connectTimer);
          return res.status(400).json({ error: 'Unsupported proxy URL protocol' });
        }
      } catch {
        clearTimeout(connectTimer);
        return res.status(400).json({ error: 'Invalid proxy URL' });
      }

      let customHeaders: Record<string, string> = {};
      if (typeof req.query.headers === 'string' && req.query.headers) {
        try {
          customHeaders = JSON.parse(req.query.headers);
        } catch {}
      }

      const fetchHeaders: Record<string, string> = {
        'User-Agent': customHeaders['User-Agent'] || DEFAULT_UA,
      };
      if (customHeaders['Referer'] || customHeaders['referer']) {
        fetchHeaders['Referer'] = customHeaders['Referer'] || customHeaders['referer'];
      }
      if (customHeaders['Origin'] || customHeaders['origin']) {
        fetchHeaders['Origin'] = customHeaders['Origin'] || customHeaders['origin'];
      }
      if (customHeaders['Cookie'] || customHeaders['cookie']) {
        fetchHeaders['Cookie'] = customHeaders['Cookie'] || customHeaders['cookie'];
      }
      if (customHeaders['Authorization'] || customHeaders['authorization']) {
        fetchHeaders['Authorization'] = customHeaders['Authorization'] || customHeaders['authorization'];
      }
      if (req.headers.range) {
        fetchHeaders['Range'] = req.headers.range;
      }

      const upstream = await fetch(targetUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: fetchHeaders,
        redirect: 'follow',
        signal: abortCtrl.signal,
      });
      clearTimeout(connectTimer);

      if (clientClosed) return;

      const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
      const isM3u8 =
        targetUrl.includes('.m3u8') ||
        contentType.includes('mpegurl') ||
        contentType.includes('application/x-mpegurl');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

      if (!upstream.ok) {
        const statusCode = upstream.status >= 500 ? 502 : upstream.status;
        return res.status(statusCode).json({
          error: `Upstream returned HTTP ${upstream.status}`,
        });
      }

      // Reject HTML landing pages disguised as media links unless it is an m3u8 manifest
      if (contentType.includes('text/html') && !isM3u8 && req.query.download !== '1') {
        return res.status(422).json({
          error: 'Upstream resolved URL returned an HTML page instead of a playable media stream.',
        });
      }

      if (isM3u8 && req.method !== 'HEAD') {
        const text = await upstream.text();
        if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
          return res.status(422).json({
            error: 'Upstream HLS URL returned HTML instead of a valid #EXTM3U playlist.',
          });
        }
        const baseUrl = upstream.url || targetUrl;
        const headersParam = encodeURIComponent(JSON.stringify(customHeaders));
        const proxyOrigin = req.query.abs === '1' ? `http://127.0.0.1:${PORT}` : '';
        const absParam = req.query.abs === '1' ? '&abs=1' : '';

        const rewritten = text
          .split('\n')
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
              return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
                const abs = new URL(uri, baseUrl).toString();
                return `URI="${proxyOrigin}/api/proxy?url=${encodeURIComponent(abs)}&headers=${headersParam}${absParam}"`;
              });
            }
            const abs = new URL(trimmed, baseUrl).toString();
            return `${proxyOrigin}/api/proxy?url=${encodeURIComponent(abs)}&headers=${headersParam}${absParam}`;
          })
          .join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(rewritten);
      }

      res.status(upstream.status);
      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      forwardHeaders.forEach((h) => {
        const val = upstream.headers.get(h);
        if (val) res.setHeader(h, val);
      });

      if (req.query.download === '1') {
        const filename = String(req.query.filename || 'zangetsu-stream.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      }

      if (req.method === 'HEAD' || !upstream.body) {
        return res.end();
      }

      const nodeStream = Readable.fromWeb(upstream.body as any);
      nodeStream.on('error', () => {
        if (!res.headersSent) {
          res.status(502).end();
        } else {
          res.destroy();
        }
      });
      res.on('error', () => {
        nodeStream.destroy();
      });
      req.on('close', () => {
        nodeStream.destroy();
      });
      nodeStream.pipe(res);
    } catch (err: unknown) {
      clearTimeout(connectTimer);
      if (clientClosed) return;
      if (!res.headersSent) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        res.status(isAbort ? 504 : 502).json({
          error: isAbort ? 'Upstream connection timed out' : err instanceof Error ? err.message : 'Proxy error',
        });
      } else {
        res.destroy();
      }
    }
  });

  // Mount Vite or Static Dist
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Zangetsu Stream Hub server running on http://localhost:${PORT}`);
  });
}

startServer();
