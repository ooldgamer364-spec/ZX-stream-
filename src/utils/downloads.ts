import type { ProbedMediaMetadata, ZangetsuVideoSource } from '../types';

export interface HlsLevelInfo {
  index: number;
  height: number;
  bitrate: number;
  variantUrl?: string;
}

export interface HlsAudioTrackInfo {
  index: number;
  name: string;
  lang: string;
}

export interface SupportedDownloadLanguage {
  index: number;
  label: string;
  detail: string;
  kind: 'probed' | 'hls' | 'single';
}

export interface SupportedDownloadQuality {
  id: string;
  label: string;
  containerLabel: string;
  sizeLabel: string;
  estimatedBytes: number;
  hlsLevelIndex: number;
  variantUrl?: string;
  compactMaxHeight?: number;
  isDataSaver?: boolean;
  targetSource?: ZangetsuVideoSource;
}

export interface DownloadServerGroup {
  serverName: string;
  items: { source: ZangetsuVideoSource; originalIndex: number }[];
}

function getServerSpeedPriority(serverName: string): number {
  const n = serverName.toLowerCase();
  if (n.includes('pixeldrain')) return 0;
  if (n.includes('gofile')) return 1;
  if (n.includes('direct') || n.includes('r2') || n.includes('turbo')) return 2;
  if (n.includes('fsl')) return 3;
  return 4;
}

/**
 * Groups resolved Zangetsu sources by unique server name so SERVER pills never repeat,
 * placing ultra-fast CDN mirrors (like Pixeldrain) first for instant high-speed downloads.
 */
export function groupDownloadServers(sources: ZangetsuVideoSource[]): DownloadServerGroup[] {
  const map = new Map<string, DownloadServerGroup>();
  sources.forEach((source, originalIndex) => {
    const rawName = (source.server || `Server ${originalIndex + 1}`).trim();
    const key = rawName.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.items.push({ source, originalIndex });
    } else {
      map.set(key, {
        serverName: rawName,
        items: [{ source, originalIndex }],
      });
    }
  });
  return Array.from(map.values()).sort(
    (a, b) => getServerSpeedPriority(a.serverName) - getServerSpeedPriority(b.serverName)
  );
}

/**
 * Unwraps `/api/proxy?url=...` back to the raw upstream media/playlist URL when needed.
 */
export function unwrapProxyUrl(maybeProxyUrl: string): string {
  if (!maybeProxyUrl) return '';
  try {
    if (maybeProxyUrl.startsWith('/api/proxy') || maybeProxyUrl.includes('/api/proxy?')) {
      const parsed = new URL(maybeProxyUrl, 'http://localhost');
      const inner = parsed.searchParams.get('url');
      if (inner) return inner;
    }
  } catch {
    // ignore malformed url
  }
  return maybeProxyUrl;
}

/**
 * Parses human-readable size strings from Zangetsu sources (e.g. "1.11 GB", "559 MB", "820 KB") into bytes.
 */
export function parseHumanSizeToBytes(sizeStr?: string | null): number {
  if (!sizeStr) return 0;
  const match = String(sizeStr)
    .trim()
    .match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)\b/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(num * (multipliers[unit] || 1));
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

export function formatTransferSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s';
  if (bytesPerSec >= 1024 * 1024) {
    return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
  }
  if (bytesPerSec >= 1024) {
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  }
  return `${Math.round(bytesPerSec)} B/s`;
}

function cleanLanguageLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Original Audio';
  // Normalize common tags without inventing languages
  return trimmed.replace(/\s+Audio$/i, '').trim();
}

/**
 * Returns ONLY genuinely detected/supported audio tracks for the selected server.
 * Never fabricates placeholder languages (e.g. Hindi/Tamil/Telugu) when absent.
 */
export function buildSupportedDownloadLanguages(params: {
  source: ZangetsuVideoSource | null;
  probedMeta: ProbedMediaMetadata | null;
  hlsAudioTracks: HlsAudioTrackInfo[];
  hasSubDubToggle: boolean;
  audioCategory: 'sub' | 'dub';
}): SupportedDownloadLanguage[] {
  const { source, probedMeta, hlsAudioTracks, hasSubDubToggle, audioCategory } = params;

  if (probedMeta && probedMeta.audioTracks.length > 0) {
    return probedMeta.audioTracks.map((t) => ({
      index: t.index,
      label: cleanLanguageLabel(t.language || t.title || `Track ${t.index + 1}`),
      detail: `${t.codec} · ${t.channelLayout.toUpperCase()}${t.bitrate ? ` · ${t.bitrate}` : ''}`,
      kind: 'probed',
    }));
  }

  if (hlsAudioTracks.length > 0) {
    return hlsAudioTracks.map((t) => ({
      index: t.index,
      label: cleanLanguageLabel(t.name || t.lang || `Track ${t.index + 1}`),
      detail: t.lang ? t.lang.toUpperCase() : 'HLS Audio',
      kind: 'hls',
    }));
  }

  if (hasSubDubToggle) {
    const label =
      source?.kind === 'dub' || audioCategory === 'dub'
        ? 'Dubbed Audio'
        : 'Original (SUB)';
    return [
      {
        index: 0,
        label,
        detail: source?.audioFormat || 'AAC Stereo',
        kind: 'single',
      },
    ];
  }

  const realLang =
    (source?.audioLang && source.audioLang.trim()) ||
    (source?.audioFormat && !/^aac|mp3|stereo|default$/i.test(source.audioFormat.trim())
      ? source.audioFormat.trim()
      : '');

  return [
    {
      index: 0,
      label: realLang ? cleanLanguageLabel(realLang) : 'Default Audio',
      detail: source?.codec ? `${source.codec} Stream` : 'Primary Track',
      kind: 'single',
    },
  ];
}

function normalizeResolutionLabel(raw?: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/\b(360p|480p|720p|1080p|1440p|2160p|4k)\b/i);
  if (!match) return null;
  return match[1].toLowerCase() === '4k' ? '2160p' : match[1].toLowerCase();
}

function getDirectContainerLabel(url: string, isHls: boolean): string {
  if (isHls) return 'MP4';
  if (/\.mkv(\?|$|%22)/i.test(url)) return 'MKV · Fast';
  if (/\.webm(\?|$|%22)/i.test(url)) return 'WebM · Fast';
  return 'MP4 · Fast';
}

/**
 * Returns ONLY genuinely supported qualities for the selected server.
 * Never invents fake resolutions or fake GB sizes.
 */
export function buildSupportedDownloadQualities(params: {
  source: ZangetsuVideoSource | null;
  probedMeta: ProbedMediaMetadata | null;
  hlsLevels: HlsLevelInfo[];
  hlsAudioTracksCount?: number;
}): SupportedDownloadQuality[] {
  const { source, probedMeta, hlsLevels, hlsAudioTracksCount = 0 } = params;
  if (!source) return [];

  const isHls = source.container === 'hls' || source.url.includes('.m3u8');

  if (isHls && hlsLevels.length > 0) {
    const uniqueByHeight = new Map<number, HlsLevelInfo>();
    for (const lvl of hlsLevels) {
      if (lvl.height > 0 && !uniqueByHeight.has(lvl.height)) {
        uniqueByHeight.set(lvl.height, lvl);
      }
    }

    const sorted = Array.from(uniqueByHeight.values()).sort((a, b) => b.height - a.height);
    const results: SupportedDownloadQuality[] = sorted.map((lvl) => {
      const bitrateLabel = lvl.bitrate > 0 ? `${Math.round(lvl.bitrate / 1000)} kbps` : 'Adaptive';
      const estBytes =
        probedMeta?.duration && probedMeta.duration > 0 && lvl.bitrate > 0
          ? Math.round((probedMeta.duration * lvl.bitrate) / 8)
          : 0;
      const sizeText = estBytes > 0 ? formatBytesCompact(estBytes) : bitrateLabel;

      const variantUrl =
        hlsAudioTracksCount === 0 && lvl.variantUrl ? unwrapProxyUrl(lvl.variantUrl) : undefined;

      return {
        id: `hls-${lvl.height}`,
        label: `${lvl.height}p`,
        containerLabel: 'MP4',
        sizeLabel: sizeText,
        estimatedBytes: estBytes,
        hlsLevelIndex: lvl.index,
        variantUrl,
        compactMaxHeight: hlsAudioTracksCount > 0 && !variantUrl ? lvl.height : undefined,
      };
    });

    const lowestHeight = sorted[sorted.length - 1]?.height ?? 0;
    if (lowestHeight > 480) {
      results.push({
        id: 'hls-compact-480',
        label: '480p (Data Saver)',
        containerLabel: 'Compact MP4',
        sizeLabel: 'Lowest MB usage',
        estimatedBytes: 0,
        hlsLevelIndex: -1,
        compactMaxHeight: 480,
        isDataSaver: true,
      });
    }

    return results;
  }

  const probedHeight = probedMeta?.height && probedMeta.height > 0 ? `${probedMeta.height}p` : null;
  const sourceRes = normalizeResolutionLabel(source.quality) || normalizeResolutionLabel(source.label);
  const resLabel = sourceRes || probedHeight || (source.quality && source.quality !== 'auto' ? source.quality : 'Original');

  const rawBytes =
    (probedMeta?.sizeBytes && probedMeta.sizeBytes > 0 ? probedMeta.sizeBytes : 0) ||
    parseHumanSizeToBytes(source.size);

  const formattedSize = rawBytes > 0 ? formatBytesCompact(rawBytes) : source.size || 'Direct Stream';
  const containerLabel = getDirectContainerLabel(source.url, isHls);

  const qualities: SupportedDownloadQuality[] = [
    {
      id: 'source-original',
      label: resLabel,
      containerLabel,
      sizeLabel: formattedSize,
      estimatedBytes: rawBytes,
      hlsLevelIndex: -1,
      targetSource: source,
    },
  ];

  const numericHeight = parseInt(resLabel, 10) || 0;
  if (numericHeight > 480 || rawBytes > 350 * 1024 * 1024) {
    const roughCompactBytes = rawBytes > 0 ? Math.round(rawBytes * 0.35) : 0;
    qualities.push({
      id: 'source-compact-480',
      label: '480p (Data Saver)',
      containerLabel: 'Compact MP4',
      sizeLabel: roughCompactBytes > 0 ? `~${formatBytesCompact(roughCompactBytes)}` : 'Lowest MB usage',
      estimatedBytes: roughCompactBytes,
      hlsLevelIndex: -1,
      compactMaxHeight: 480,
      isDataSaver: true,
      targetSource: source,
    });
  }

  return qualities;
}

/**
 * Builds deduplicated, real supported qualities across all resolved streams belonging to a grouped SERVER.
 */
export function buildSupportedDownloadQualitiesForServer(params: {
  serverGroup: DownloadServerGroup | null;
  primarySource: ZangetsuVideoSource | null;
  probedMeta: ProbedMediaMetadata | null;
  hlsLevels: HlsLevelInfo[];
  hlsAudioTracksCount?: number;
}): SupportedDownloadQuality[] {
  const { serverGroup, primarySource, probedMeta, hlsLevels, hlsAudioTracksCount = 0 } = params;
  if (!primarySource) return [];

  const isPrimaryHls = primarySource.container === 'hls' || primarySource.url.includes('.m3u8');
  if (isPrimaryHls && hlsLevels.length > 0) {
    return buildSupportedDownloadQualities({
      source: primarySource,
      probedMeta,
      hlsLevels,
      hlsAudioTracksCount,
    });
  }

  const groupItems = serverGroup?.items || [{ source: primarySource, originalIndex: 0 }];
  if (groupItems.length <= 1) {
    return buildSupportedDownloadQualities({
      source: primarySource,
      probedMeta,
      hlsLevels,
      hlsAudioTracksCount,
    });
  }

  const seen = new Set<string>();
  const collected: SupportedDownloadQuality[] = [];

  for (const item of groupItems) {
    const src = item.source;
    const isActiveMatch = src.url === primarySource.url;
    const srcMeta = isActiveMatch ? probedMeta : null;
    const sourceRes = normalizeResolutionLabel(src.quality) || normalizeResolutionLabel(src.label);
    const probedHeight = srcMeta?.height && srcMeta.height > 0 ? `${srcMeta.height}p` : null;
    const resLabel =
      sourceRes || probedHeight || (src.quality && src.quality !== 'auto' ? src.quality : 'Original');

    const rawBytes =
      (srcMeta?.sizeBytes && srcMeta.sizeBytes > 0 ? srcMeta.sizeBytes : 0) ||
      parseHumanSizeToBytes(src.size);
    const formattedSize = rawBytes > 0 ? formatBytesCompact(rawBytes) : src.size || 'Direct Stream';
    const dedupeKey = `${resLabel.toLowerCase()}::${formattedSize.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const isSrcHls = src.container === 'hls' || src.url.includes('.m3u8');
    const containerLabel = getDirectContainerLabel(src.url, isSrcHls);

    collected.push({
      id: `srv-${item.originalIndex}-${resLabel}`,
      label: resLabel,
      containerLabel,
      sizeLabel: formattedSize,
      estimatedBytes: rawBytes,
      hlsLevelIndex: -1,
      targetSource: src,
    });
  }

  collected.sort((a, b) => (parseInt(b.label, 10) || 0) - (parseInt(a.label, 10) || 0));

  const hasLowNative = collected.some((q) => {
    const h = parseInt(q.label, 10) || 0;
    return h > 0 && h <= 480;
  });

  if (!hasLowNative && collected.length > 0) {
    const base = collected[collected.length - 1];
    const roughCompactBytes = base.estimatedBytes > 0 ? Math.round(base.estimatedBytes * 0.35) : 0;
    collected.push({
      id: 'server-compact-480',
      label: '480p (Data Saver)',
      containerLabel: 'Compact MP4',
      sizeLabel:
        roughCompactBytes > 0 ? `~${formatBytesCompact(roughCompactBytes)}` : 'Lowest MB usage',
      estimatedBytes: roughCompactBytes,
      hlsLevelIndex: -1,
      compactMaxHeight: 480,
      isDataSaver: true,
      targetSource: base.targetSource || primarySource,
    });
  }

  return collected;
}

/**
 * Infers output extension matching actual container served (mkv when direct-proxied MKV, otherwise mp4).
 */
export function inferDownloadExtension(endpointUrl: string, sourceUrl: string): string {
  if (endpointUrl.startsWith('/api/proxy') && /\.mkv(\?|$)/i.test(sourceUrl)) {
    return 'mkv';
  }
  return 'mp4';
}

/**
 * Chooses the fastest, crash-free download endpoint:
 * - Direct file streams (MP4/MKV) on default track use parallel Range-capable `/api/proxy` (~10x–100x faster, zero 500 timeout).
 * - HLS playlists (.m3u8), explicit 480p Data Saver, or secondary audio tracks (audioIndex > 0) use `/api/stream/remux`.
 */
export function selectMinimalDownloadEndpoint(params: {
  source: ZangetsuVideoSource;
  quality: SupportedDownloadQuality;
  audioIndex: number;
  probedMeta: ProbedMediaMetadata | null;
  filename: string;
}): string {
  const { source, quality, audioIndex, probedMeta, filename } = params;
  const targetUrl = quality.variantUrl || source.url;
  const isHls = source.container === 'hls' || targetUrl.includes('.m3u8');
  const hdr = source.headers ? encodeURIComponent(JSON.stringify(source.headers)) : '';
  const safeName = encodeURIComponent(filename);

  const isCompact = Boolean(quality.compactMaxHeight);
  const mustRemux = isHls || isCompact || audioIndex > 0;

  if (!mustRemux) {
    return `/api/proxy?url=${encodeURIComponent(targetUrl)}&headers=${hdr}&download=1&filename=${safeName}`;
  }

  const compactParams = isCompact
    ? `&compact=1&maxHeight=${quality.compactMaxHeight || 480}`
    : '';
  const transcodeParam =
    !isCompact &&
    probedMeta &&
    ['hevc', 'h265', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'wmv3', 'flv1', 'xvid', 'divx'].includes(
      probedMeta.videoCodec
    )
      ? '&transcodeVideo=1'
      : '';

  return `/api/stream/remux?url=${encodeURIComponent(targetUrl)}&headers=${hdr}&audioIndex=${audioIndex}${compactParams}${transcodeParam}&download=1&filename=${safeName}`;
}
