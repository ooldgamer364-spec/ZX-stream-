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
  rating?: string | number | null;
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
  season?: number;
}

export interface ContinueWatchingEntry {
  item: ZangetsuCatalogItem;
  episodeNumber: number;
  seasonNumber: number;
  progressPct: number;
  updatedAt: number;
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
  rating?: string | number | null;
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

export interface OfflineVaultRecord {
  id: string;
  title: string;
  episodeTitle: string;
  episodeNumber: number;
  seasonNumber?: number;
  isSeries?: boolean;
  sourceId: string;
  cover: string | null;
  quality: string;
  audioFormat: string;
  sizeBytes: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  savedAt: string;
  blob?: Blob;
  status: 'downloading' | 'completed' | 'error';
  progress: number;
  directUrl: string;
  headers?: Record<string, string>;
  downloadError?: string;
  fileExtension?: string;
  downloadEndpoint?: string;
}

const DB_NAME = 'zangetsu_offline_vault_v1';
const STORE_NAME = 'downloads';

function openVaultDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveOfflineRecord(record: OfflineVaultRecord): Promise<void> {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getOfflineRecords(): Promise<OfflineVaultRecord[]> {
  try {
    const db = await openVaultDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function deleteOfflineRecord(id: string): Promise<void> {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
