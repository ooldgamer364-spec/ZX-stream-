import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export interface ZangetsuSourceInfo {
  id: string;
  name: string;
  version: string;
  type: 'anime' | 'movie';
  lang: string;
  file: string;
  logo: string;
  nsfw: boolean;
}

export interface ZangetsuCatalogItem {
  id: string;
  title: string;
  englishTitle?: string;
  cover: string | null;
  url: string;
  type: 'anime' | 'movie';
  sourceId: string;
  subCount?: number;
  dubCount?: number;
  year?: string | number | null;
}

export interface ZangetsuHomeRow {
  title: string;
  items: ZangetsuCatalogItem[];
}

export interface ZangetsuEpisode {
  id: string;
  number: number;
  title: string;
  url: string;
  thumbnail?: string | null;
  date?: string | null;
}

export interface ZangetsuMediaDetail {
  id: string;
  title: string;
  cover: string | null;
  url: string;
  description: string;
  status: string;
  genres: string[];
  studios: string[];
  type: 'anime' | 'movie';
  sourceId: string;
  episodes: ZangetsuEpisode[];
  year?: string | number | null;
  subCount?: number;
  dubCount?: number;
  tmdbId?: number;
  tmdbIsTv?: boolean;
}

export interface ZangetsuSubtitleTrack {
  url: string;
  lang: string;
  label: string;
  format: 'vtt' | 'srt';
  default?: boolean;
}

export interface ZangetsuVideoSource {
  url: string;
  quality: string;
  container: 'hls' | 'mp4';
  headers?: Record<string, string>;
  kind?: 'sub' | 'dub';
  audioLang?: string;
  subtitles?: ZangetsuSubtitleTrack[];
  label: string;
  // Enhanced metadata parsed by our runtime
  server?: string;
  codec?: string;
  audioFormat?: string;
  size?: string;
  isDirectPlayable?: boolean;
}

export interface RuntimeLogEntry {
  timestamp: string;
  sourceId: string;
  stage: string;
  message: string;
  durationMs?: number;
}

/**
 * Pure helper: Base64 string to byte array (used by Zangetsu extensions for ROT13/base64 redirect chains & AES keys)
 */
export function base64ToBytes(b64: string): number[] {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  return Array.from(Buffer.from(clean, 'base64'));
}

/**
 * Pure helper: HTML to clean plain text with entity decoding
 */
export function htmlText(html: string): string {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&#8211;|&ndash;/gi, '–')
    .replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure helper: Resolve relative URL against a base URL safely
 */
export function absUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return String(href || '');
  }
}

/**
 * Pure helper: Dean Edwards P.A.C.K.E.R unpacker for VidHide / HdStream4u embeds
 */
export function unpackJs(packed: string): string {
  const str = String(packed || '');
  const m = str.match(/}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return str;
  const p = m[1];
  const a = parseInt(m[2], 10);
  let c = parseInt(m[3], 10);
  const k = m[4].split('|');
  const encodeBase = (num: number): string => {
    return (
      (num < a ? '' : encodeBase(Math.floor(num / a))) +
      ((num = num % a) > 35 ? String.fromCharCode(num + 29) : num.toString(36))
    );
  };
  const dict: Record<string, string> = {};
  while (c--) {
    const key = encodeBase(c);
    dict[key] = k[c] || key;
  }
  return p.replace(/\b\w+\b/g, (word) => dict[word] || word);
}

/**
 * Pure helper: Parse structured release metadata from a Zangetsu VideoSource label
 * e.g. "HDHub4u [FSL Server] [WEB-DL H265 DDP5.1 HINDI] [1.76 GB] 1080p"
 */
export function enrichVideoSource(src: ZangetsuVideoSource): ZangetsuVideoSource {
  const label = String(src.label || '');
  const url = String(src.url || '');

  // Extract bracketed segments
  const brackets = [...label.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  const server = brackets[0] || (url.includes('pixeldrain') ? 'Pixeldrain' : url.includes('r2.cloudflarestorage') ? 'FSL Server' : 'Direct');

  let size = '';
  let tags = '';
  for (let i = 1; i < brackets.length; i++) {
    if (/\b(MB|GB|TB)\b/i.test(brackets[i])) {
      size = brackets[i];
    } else {
      tags = brackets[i];
    }
  }

  const codec = /H265|HEVC|X265/i.test(tags || url)
    ? 'HEVC / H.265'
    : /H264|X264|AVC/i.test(tags || url)
      ? 'AVC / H.264'
      : src.container === 'hls'
        ? 'HLS Adaptive'
        : 'H.264';

  const audioFormat = /ATMOS/i.test(tags)
    ? 'Dolby Atmos'
    : /DDP5\.1|DD5\.1/i.test(tags)
      ? 'Dolby Digital+ 5.1'
      : /MULTI|DUAL/i.test(tags || url)
        ? 'Dual / Multi Audio'
        : /HINDI/i.test(tags || url)
          ? 'Hindi Audio'
          : src.audioLang === 'ja'
            ? 'Japanese (Original)'
            : src.kind === 'dub'
              ? 'English / Dubbed'
              : 'Stereo 2.0';

  // Filter out HTML redirect traps and external-only download mirrors so they are never classified as direct playable streams
  const lowerUrl = url.toLowerCase();
  const isExternalOnlyHost =
    lowerUrl.includes('hubcloud.pw/tg/go') ||
    lowerUrl.includes('pixel.hubcloud.pw/?id=') ||
    lowerUrl.includes('gpdl.hubcloud.pw/?id=') ||
    lowerUrl.includes('gdtot') ||
    lowerUrl.includes('gdmirrorbot') ||
    lowerUrl.includes('terabox') ||
    lowerUrl.includes('1024tera') ||
    lowerUrl.includes('mega.nz') ||
    lowerUrl.includes('cuty.io') ||
    lowerUrl.includes('filepress') ||
    lowerUrl.includes('fpgo.');

  const isDirectPlayable =
    src.isDirectPlayable !== false && !isExternalOnlyHost;

  return {
    ...src,
    server,
    codec,
    audioFormat,
    size,
    isDirectPlayable,
  };
}

/**
 * Pure helper: Sort and filter resolved sources so the cleanest, fastest, direct-streamable sources come first
 */
export function prioritizeVideoSources(sources: ZangetsuVideoSource[]): ZangetsuVideoSource[] {
  const enriched = sources.map(enrichVideoSource).filter((s) => s.isDirectPlayable !== false);

  const scoreSource = (s: ZangetsuVideoSource): number => {
    let score = 0;
    const url = s.url.toLowerCase();
    // HLS streams play natively via hls.js with instant adaptive startup
    if (s.container === 'hls' || url.includes('.m3u8')) score += 100;
    // Cloudflare R2 (FSL Server) and Pixeldrain have blazing-fast 206 Range and FFprobe support
    if (url.includes('r2.cloudflarestorage.com')) score += 90;
    if (url.includes('pixeldrain')) score += 85;
    // Prefer H.264 / X264 over HEVC for faster browser decoding
    if (s.codec === 'AVC / H.264') score += 30;
    // Prefer 1080p or 720p over 22GB 4K remuxes for instant browser playback
    if (s.quality === '1080p') score += 25;
    else if (s.quality === '720p') score += 20;
    else if (s.quality === 'auto') score += 25;
    else if (s.quality === '480p') score += 10;
    return score;
  };

  return enriched.sort((a, b) => scoreSource(b) - scoreSource(a));
}

/**
 * Pure helper: Normalize media title for cross-provider matching & search deduplication
 */
export function normalizeMediaTitle(title: string): string {
  return String(title || '')
    .toLowerCase()
    .replace(/\b(season\s*\d+|s0?\d+|part\s*\d+|cour\s*\d+|movie|tv|ova|ona)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure helper: Return ordered list of alternative Zangetsu providers for auto-failover
 */
export function getFailoverProviders(currentSourceId: string, mediaType: 'anime' | 'movie'): string[] {
  const animeChain = ['hianime', 'anikoto', 'animecube', 'kartoons', 'animedubhindi'];
  const movieChain = ['hdhub4u', 'fourkhdhub', 'uhdmovies'];
  const chain = mediaType === 'anime' || animeChain.includes(currentSourceId) ? animeChain : movieChain;
  return chain.filter((id) => id !== currentSourceId);
}

/**
 * Pure helper: Pick best matching catalog item from an alternative provider's search results
 */
export function pickBestCatalogMatch(
  targetTitle: string,
  candidates: ZangetsuCatalogItem[]
): ZangetsuCatalogItem | null {
  if (!candidates || candidates.length === 0) return null;
  const normTarget = normalizeMediaTitle(targetTitle);
  if (!normTarget) return candidates[0];

  let best = candidates[0];
  let bestScore = -1;

  for (const item of candidates) {
    const normItem = normalizeMediaTitle(item.title || item.englishTitle || '');
    let score = 0;
    if (normItem === normTarget) score += 100;
    else if (normItem.includes(normTarget) || normTarget.includes(normItem)) score += 60;
    else {
      const targetWords = normTarget.split(' ').filter(Boolean);
      const itemWords = new Set(normItem.split(' ').filter(Boolean));
      const shared = targetWords.filter((w) => itemWords.has(w)).length;
      score += (shared / Math.max(1, targetWords.length)) * 50;
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best;
}

const MANIFEST_URL = 'https://raw.githubusercontent.com/Spyou/zangetsu-providers/main/index.json';
const RAW_BASE_URL = 'https://raw.githubusercontent.com/Spyou/zangetsu-providers/main/';

const LOCAL_ZANGETSU_SOURCES: ZangetsuSourceInfo[] = [
  {
    id: 'animedubhindi',
    name: 'AnimeDubHindi',
    version: '1.0.0',
    type: 'anime',
    lang: 'hi',
    file: 'providers/animedubhindi.js',
    logo: 'https://www.animedubhindi.link/favicon.ico',
    nsfw: false,
  },
];

class ZangetsuRuntimeEngine {
  private manifestCache: { name: string; description: string; sources: ZangetsuSourceInfo[] } | null = null;
  private contextCache = new Map<string, vm.Context>();
  private scriptCodeCache = new Map<string, string>();
  private homeCache = new Map<string, { timestamp: number; data: ZangetsuHomeRow[] }>();
  private detailCache = new Map<string, { timestamp: number; data: ZangetsuMediaDetail }>();
  private logs: RuntimeLogEntry[] = [];

  private addLog(sourceId: string, stage: string, message: string, durationMs?: number) {
    this.logs.unshift({
      timestamp: new Date().toISOString(),
      sourceId,
      stage,
      message,
      durationMs,
    });
    if (this.logs.length > 60) {
      this.logs.length = 60;
    }
  }

  public getRecentLogs(sourceId?: string): RuntimeLogEntry[] {
    if (!sourceId) return this.logs.slice(0, 25);
    return this.logs.filter((l) => l.sourceId === sourceId).slice(0, 25);
  }

  public async getManifest() {
    if (this.manifestCache) return this.manifestCache;
    const t0 = Date.now();
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`Failed to fetch Zangetsu manifest: ${res.status}`);
    const data = await res.json();
    // Filter out providers that require private API tokens (like TorBox) or are dead
    const activeOrder = ['hdhub4u', 'hianime', 'fourkhdhub', 'anikoto', 'uhdmovies', 'animecube', 'kartoons'];
    const remoteSources = (data.sources || [])
      .filter((s: ZangetsuSourceInfo) => activeOrder.includes(s.id))
      .sort((a: ZangetsuSourceInfo, b: ZangetsuSourceInfo) => activeOrder.indexOf(a.id) - activeOrder.indexOf(b.id))
      .map((s: ZangetsuSourceInfo) => ({
        ...s,
        logo: s.logo.startsWith('http') ? s.logo : `${RAW_BASE_URL}${s.logo}`,
      }));
    const existingIds = new Set(remoteSources.map((s: ZangetsuSourceInfo) => s.id));
    data.sources = [
      ...remoteSources,
      ...LOCAL_ZANGETSU_SOURCES.filter((s) => !existingIds.has(s.id)),
    ];
    this.manifestCache = data;
    this.addLog('system', 'MANIFEST', `Loaded ${data.sources.length} Zangetsu JS extensions (remote + local)`, Date.now() - t0);
    return data;
  }

  public async getExtensionCode(sourceId: string): Promise<string> {
    if (this.scriptCodeCache.has(sourceId)) {
      return this.scriptCodeCache.get(sourceId)!;
    }
    const localMeta = LOCAL_ZANGETSU_SOURCES.find((s) => s.id === sourceId);
    if (localMeta) {
      const t0 = Date.now();
      const localPath = path.resolve(process.cwd(), 'src/runtime/providers', `${sourceId}.js`);
      const code = fs.readFileSync(localPath, 'utf8');
      this.scriptCodeCache.set(sourceId, code);
      this.addLog(sourceId, 'VM_COMPILE', `Loaded & compiled local ${localMeta.file} (${code.length} bytes)`, Date.now() - t0);
      return code;
    }
    const manifest = await this.getManifest();
    const src = manifest.sources.find((s: ZangetsuSourceInfo) => s.id === sourceId);
    const filePath = src ? src.file : `providers/${sourceId}.js`;
    const url = `${RAW_BASE_URL}${filePath}`;
    const t0 = Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load Zangetsu extension ${sourceId} from ${url}`);
    const code = await res.text();
    this.scriptCodeCache.set(sourceId, code);
    this.addLog(sourceId, 'VM_COMPILE', `Fetched & compiled ${filePath} (${code.length} bytes)`, Date.now() - t0);
    return code;
  }

  private async getContext(sourceId: string): Promise<vm.Context> {
    if (this.contextCache.has(sourceId)) {
      return this.contextCache.get(sourceId)!;
    }
    const code = await this.getExtensionCode(sourceId);

    const zFetch = async (url: string, opts: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      followRedirects?: boolean;
      timeoutMs?: number;
    } = {}) => {
      const mergedHeaders: Record<string, string> = { ...(opts.headers || {}) };
      if (!mergedHeaders['User-Agent'] && !mergedHeaders['user-agent']) {
        mergedHeaders['User-Agent'] =
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      }

      const maxAttempts = 2;
      let lastErr: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 18000);
        const t0 = Date.now();
        try {
          const res = await fetch(url, {
            method: opts.method || 'GET',
            headers: mergedHeaders,
            body: opts.body,
            redirect: opts.followRedirects === false ? 'manual' : 'follow',
            signal: controller.signal,
          });
          const body = await res.text();
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
            headers[k.toLowerCase()] = v;
          });
          const host = (() => {
            try { return new URL(url).hostname; } catch { return url.slice(0, 30); }
          })();
          this.addLog(sourceId, 'NET_FETCH', `GET ${host} → HTTP ${res.status} (${body.length}B)`, Date.now() - t0);
          if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
            clearTimeout(timeout);
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }
          return { status: res.status, ok: res.ok, body, headers, url: res.url };
        } catch (err: unknown) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog(sourceId, 'NET_ERR', `Fetch error on ${url.slice(0, 45)}: ${msg}`, Date.now() - t0);
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 350));
            continue;
          }
          throw err;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw lastErr;
    };

    const sandbox: Record<string, unknown> = {
      __SOURCE_ID: sourceId,
      fetch: zFetch,
      base64ToBytes,
      htmlText,
      absUrl,
      unpackJs,
      atob: (s: string) => Buffer.from(String(s || ''), 'base64').toString('binary'),
      btoa: (s: string) => Buffer.from(String(s || ''), 'binary').toString('base64'),
      console,
      setTimeout,
      clearTimeout,
      URL,
    };

    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { filename: `${sourceId}.js`, timeout: 5000 });
    this.contextCache.set(sourceId, ctx);
    return ctx;
  }

  public async getHome(sourceId: string): Promise<ZangetsuHomeRow[]> {
    const cached = this.homeCache.get(sourceId);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.data;
    }
    const ctx = await this.getContext(sourceId);
    const t0 = Date.now();
    this.addLog(sourceId, 'GET_HOME', `Executing ${sourceId}.getHome() in Zangetsu VM...`);
    const rows: ZangetsuHomeRow[] = await ctx.getHome({});
    const validRows = (rows || []).filter((r) => r && Array.isArray(r.items) && r.items.length > 0);
    this.addLog(sourceId, 'HOME_READY', `Resolved ${validRows.length} catalog shelves (${validRows.reduce((a, b) => a + b.items.length, 0)} items)`, Date.now() - t0);
    if (validRows.length > 0) {
      this.homeCache.set(sourceId, { timestamp: Date.now(), data: validRows });
    }
    return validRows;
  }

  public async search(sourceId: string, query: string, page = 1): Promise<ZangetsuCatalogItem[]> {
    const ctx = await this.getContext(sourceId);
    const t0 = Date.now();
    this.addLog(sourceId, 'SEARCH', `Executing ${sourceId}.search("${query}", ${page})...`);
    const items: ZangetsuCatalogItem[] = await ctx.search(query, page, {});
    const tagged = (items || []).map((it) => ({ ...it, sourceId: it.sourceId || sourceId }));
    this.addLog(sourceId, 'SEARCH_DONE', `Found ${tagged.length} matches for "${query}"`, Date.now() - t0);
    return tagged;
  }

  /**
   * Multi-provider search across Movies (HDHub4u, 4KHDHub, UHDMovies) and/or Anime (HiAnime, AniKoto, AnimeCube, Kartoons)
   */
  public async searchMulti(
    query: string,
    scope: 'all' | 'movie' | 'anime' = 'all',
    primarySourceId?: string
  ): Promise<ZangetsuCatalogItem[]> {
    const movieProviders = ['hdhub4u', 'fourkhdhub', 'uhdmovies'];
    const animeProviders = ['hianime', 'anikoto', 'animecube', 'kartoons', 'animedubhindi'];

    let targets: string[] = [];
    if (scope === 'movie') targets = movieProviders;
    else if (scope === 'anime') targets = animeProviders;
    else targets = [...movieProviders, ...animeProviders];

    if (primarySourceId && targets.includes(primarySourceId)) {
      targets = [primarySourceId, ...targets.filter((id) => id !== primarySourceId)];
    }

    const results = await Promise.all(
      targets.map((id) =>
        this.search(id, query, 1).catch(() => [] as ZangetsuCatalogItem[])
      )
    );

    return results.flat();
  }

  /**
   * Auto-failover stream resolver: if current provider fails or its stream breaks,
   * automatically searches alternative Zangetsu providers for the same title & episode number
   */
  public async resolveFailoverProvider(
    currentSourceId: string,
    title: string,
    episodeNumber: number,
    mediaType: 'anime' | 'movie',
    category: 'sub' | 'dub' = 'sub',
    excludeProviders: string[] = []
  ): Promise<{
    providerId: string;
    matchedItem: ZangetsuCatalogItem;
    detail: ZangetsuMediaDetail;
    episode: ZangetsuEpisode;
    sources: ZangetsuVideoSource[];
  } | null> {
    const candidates = getFailoverProviders(currentSourceId, mediaType).filter(
      (id) => !excludeProviders.includes(id)
    );

    const cleanQuery = String(title || '')
      .replace(/\s*\(\d{4}\).*$/, '')
      .replace(/[:-]/g, ' ')
      .trim();

    for (const candidateId of candidates) {
      try {
        this.addLog(
          candidateId,
          'AUTO_FAILOVER',
          `Auto-Failover: Searching ${candidateId} for "${cleanQuery}" (Ep ${episodeNumber})...`
        );
        const searchHits = await this.search(candidateId, cleanQuery, 1);
        const match = pickBestCatalogMatch(title, searchHits);
        if (!match) continue;

        const detail = await this.getDetail(candidateId, match.url);
        const eps = detail?.episodes || [];
        if (eps.length === 0) continue;

        const targetEp =
          eps.find((e) => Number(e.number) === Number(episodeNumber)) || eps[0];

        const sources = await this.getVideoSources(candidateId, targetEp.url, category);
        if (sources && sources.length > 0) {
          this.addLog(
            candidateId,
            'FAILOVER_SUCCESS',
            `Auto-switched to ${candidateId} ("${detail.title}" Ep ${targetEp.number}) with ${sources.length} playable streams`
          );
          return {
            providerId: candidateId,
            matchedItem: match,
            detail,
            episode: targetEp,
            sources,
          };
        }
      } catch {
        // Continue to next failover provider in chain
      }
    }

    return null;
  }

  public async getDetail(sourceId: string, url: string): Promise<ZangetsuMediaDetail> {
    const cacheKey = `${sourceId}:${url}`;
    const cached = this.detailCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
      return cached.data;
    }
    const ctx = await this.getContext(sourceId);
    const t0 = Date.now();
    this.addLog(sourceId, 'GET_DETAIL', `Executing ${sourceId}.getDetail("${url.slice(0, 60)}")...`);
    const detail: ZangetsuMediaDetail = await ctx.getDetail(url, {});
    this.addLog(
      sourceId,
      'DETAIL_READY',
      `Scraped "${detail?.title}" with ${(detail?.episodes || []).length} episode(s)`,
      Date.now() - t0
    );
    if (detail) {
      this.detailCache.set(cacheKey, { timestamp: Date.now(), data: detail });
    }
    return detail;
  }

  public async getVideoSources(
    sourceId: string,
    episodeUrl: string,
    category: 'sub' | 'dub' = 'sub'
  ): Promise<ZangetsuVideoSource[]> {
    const ctx = await this.getContext(sourceId);
    const t0 = Date.now();
    this.addLog(sourceId, 'RESOLVE_STREAM', `Executing ${sourceId}.getVideoSources() [${category.toUpperCase()}]...`);
    const rawSources: ZangetsuVideoSource[] = await ctx.getVideoSources(episodeUrl, { category });
    const prioritized = prioritizeVideoSources(rawSources || []);
    this.addLog(
      sourceId,
      'STREAM_READY',
      `Resolved ${prioritized.length} playable video streams (top: ${prioritized[0]?.label || 'none'})`,
      Date.now() - t0
    );
    return prioritized;
  }
}

export const zangetsuRuntime = new ZangetsuRuntimeEngine();
