/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  Play,
  Search,
  Film,
  Loader2,
  Code2,
  AlertCircle,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Star,
  Bookmark,
  Check,
  Tv,
  Share2,
  Flag,
  Download,
  FolderDown,
  Send,
  LayoutGrid,
  Clapperboard,
  Settings,
  X,
  Trash2,
} from 'lucide-react';
import {
  type ZangetsuSourceInfo,
  type ZangetsuCatalogItem,
  type ZangetsuHomeRow,
  type ZangetsuMediaDetail,
  type ZangetsuEpisode,
  type ZangetsuVideoSource,
  type OfflineVaultRecord,
  type ContinueWatchingEntry,
  type ProbedMediaMetadata,
  getOfflineRecords,
  saveOfflineRecord,
  deleteOfflineRecord,
} from './types';
import { VideoPlayer } from './components/VideoPlayer';
import { OfflineDownloadsView } from './components/OfflineDownloadsView';
import { ExtensionInspectorModal } from './components/ExtensionInspectorModal';
import {
  extractEpisodeSeasonNumber,
  formatCleanEpisodeTitle,
  groupEpisodesBySeason,
} from './utils/seasons';
import {
  inferDownloadExtension,
  parseHumanSizeToBytes,
  selectMinimalDownloadEndpoint,
  type SupportedDownloadQuality,
} from './utils/downloads';
import { fastFetchBinaryStream } from './utils/fastDownloader';

type ActiveNav = 'movies' | 'anime' | 'downloads' | 'settings';
type SearchScope = 'movie' | 'anime' | 'all' | 'active';

export default function App() {
  // Zangetsu Providers & Active Extension
  const [providers, setProviders] = useState<ZangetsuSourceInfo[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string>('hdhub4u');
  const [activeNav, setActiveNav] = useState<ActiveNav>('movies');

  // Search Overlay & Hero Carousel State
  const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false);
  const [heroSlideIdx, setHeroSlideIdx] = useState<number>(0);

  // Catalog & Search State
  const [homeRows, setHomeRows] = useState<ZangetsuHomeRow[]>([]);
  const [isLoadingHome, setIsLoadingHome] = useState<boolean>(true);
  const [homeError, setHomeError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchScope, setSearchScope] = useState<SearchScope>('movie');
  const [searchResults, setSearchResults] = useState<ZangetsuCatalogItem[] | null>(null);
  const [searchProviderFilter, setSearchProviderFilter] = useState<string>('all');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // Watch / Media Detail State
  const [selectedItem, setSelectedItem] = useState<ZangetsuCatalogItem | null>(null);
  const [mediaDetail, setMediaDetail] = useState<ZangetsuMediaDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [activeEpisode, setActiveEpisode] = useState<ZangetsuEpisode | null>(null);
  const [selectedSeasonNumber, setSelectedSeasonNumber] = useState<number>(1);
  const [episodeSearch, setEpisodeSearch] = useState<string>('');
  const [audioCategory, setAudioCategory] = useState<'sub' | 'dub'>('sub');

  const [videoSources, setVideoSources] = useState<ZangetsuVideoSource[]>([]);
  const [activeSourceIndex, setActiveSourceIndex] = useState<number>(0);
  const [isResolvingSources, setIsResolvingSources] = useState<boolean>(false);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  // Auto Source Changer / Provider Failover State
  const [autoSwitchEnabled, setAutoSwitchEnabled] = useState<boolean>(true);
  const [isFailoverLoading, setIsFailoverLoading] = useState<boolean>(false);
  const [failoverNotice, setFailoverNotice] = useState<string | null>(null);
  const [triedFailoverProviders, setTriedFailoverProviders] = useState<string[]>([]);

  // Offline Vault State
  const [offlineRecords, setOfflineRecords] = useState<OfflineVaultRecord[]>([]);
  const [offlineBlobUrl, setOfflineBlobUrl] = useState<string | null>(null);

  // JS Runtime Inspector Modal
  const [isInspectorOpen, setIsInspectorOpen] = useState<boolean>(false);

  // Watch Detail & Homepage Interactive State (Watchlist, Continue Watching, Comments, Action Feedback)
  const [watchlistIds, setWatchlistIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('zx_watchlist_ids');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [watchlistItems, setWatchlistItems] = useState<ZangetsuCatalogItem[]>(() => {
    try {
      const raw = localStorage.getItem('zx_watchlist_items');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [continueWatching, setContinueWatching] = useState<ContinueWatchingEntry[]>(() => {
    try {
      const raw = localStorage.getItem('zx_continue_watching');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [commentsByMedia, setCommentsByMedia] = useState<
    Record<string, { id: string; author: string; time: string; text: string }[]>
  >(() => {
    try {
      const raw = localStorage.getItem('zx_media_comments');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });
  const [commentDraft, setCommentDraft] = useState<string>('');
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [showTvModal, setShowTvModal] = useState<boolean>(false);
  const [showReportModal, setShowReportModal] = useState<boolean>(false);
  const [openDownloadSignal, setOpenDownloadSignal] = useState<number>(0);

  // Concurrency & Cancellation Refs
  const homeAbortRef = useRef<AbortController | null>(null);
  const openSeqRef = useRef<number>(0);
  const isFailoverInFlightRef = useRef<boolean>(false);
  const heroTouchStartXRef = useRef<number | null>(null);
  const downloadControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Load Offline Vault Records on mount
  useEffect(() => {
    getOfflineRecords().then(setOfflineRecords).catch(() => {});
  }, []);

  // Load Zangetsu Manifest on mount
  useEffect(() => {
    fetch('/api/zangetsu/manifest')
      .then((r) => r.json())
      .then((data) => {
        if (data.sources && Array.isArray(data.sources)) {
          setProviders(data.sources);
        }
      })
      .catch(() => {});
  }, []);

  // Load Home Catalog whenever activeSourceId changes
  const loadHomeCatalog = useCallback((sourceId: string) => {
    if (homeAbortRef.current) {
      homeAbortRef.current.abort();
    }
    const controller = new AbortController();
    homeAbortRef.current = controller;

    setIsLoadingHome(true);
    setHomeError(null);
    setSearchResults(null);
    fetch(`/api/zangetsu/home/${sourceId}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Provider ${sourceId} failed to load`);
        return r.json();
      })
      .then((data) => {
        if (homeAbortRef.current !== controller) return;
        setHomeRows(data.rows || []);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (homeAbortRef.current !== controller) return;
        setHomeError(err instanceof Error ? err.message : 'Failed to load Zangetsu catalog');
      })
      .finally(() => {
        if (homeAbortRef.current === controller) {
          setIsLoadingHome(false);
        }
      });
  }, []);

  useEffect(() => {
    setHeroSlideIdx(0);
    loadHomeCatalog(activeSourceId);
    return () => {
      homeAbortRef.current?.abort();
    };
  }, [activeSourceId, loadHomeCatalog]);

  const recordContinueWatching = useCallback(
    (item: ZangetsuCatalogItem, episodeNumber = 1, seasonNumber = 1, progressPct = 10) => {
      setContinueWatching((prev) => {
        const entry: ContinueWatchingEntry = {
          item,
          episodeNumber,
          seasonNumber,
          progressPct,
          updatedAt: Date.now(),
        };
        const next = [entry, ...prev.filter((e) => e.item.id !== item.id)].slice(0, 18);
        try {
          localStorage.setItem('zx_continue_watching', JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    []
  );

  // Automatic or Manual Provider Failover (switches to alternate anime/movie Zangetsu provider)
  const handleProviderFailover = useCallback(
    async (
      overrideSourceId?: string,
      overrideTitle?: string,
      overrideEpNum?: number,
      overrideType?: 'anime' | 'movie' | 'tv',
      explicitExclude?: string[],
      expectedOpenSeq?: number
    ) => {
      if (isFailoverInFlightRef.current) return;

      const currentSrc = overrideSourceId || selectedItem?.sourceId || activeSourceId;
      const targetTitle = overrideTitle || mediaDetail?.title || selectedItem?.title || '';
      const targetEpNum = overrideEpNum || activeEpisode?.number || 1;
      const targetType = overrideType || selectedItem?.type || 'anime';

      if (!targetTitle) return;

      const reqSeq = expectedOpenSeq ?? openSeqRef.current;
      isFailoverInFlightRef.current = true;
      setIsFailoverLoading(true);
      setSourcesError(null);
      setFailoverNotice(
        `Searching alternative Zangetsu providers for "${targetTitle}" (Ep ${targetEpNum})...`
      );

      try {
        const excludeList = Array.from(
          new Set([...triedFailoverProviders, currentSrc, ...(explicitExclude || [])])
        );
        const excludeParam = excludeList.join(',');
        const res = await fetch(
          `/api/zangetsu/failover?sourceId=${encodeURIComponent(currentSrc)}&title=${encodeURIComponent(
            targetTitle
          )}&episodeNumber=${targetEpNum}&type=${targetType}&category=${audioCategory}&exclude=${encodeURIComponent(
            excludeParam
          )}`
        );
        const data = await res.json();
        if (openSeqRef.current !== reqSeq) return;

        if (res.ok && data.resolved && data.sources && data.sources.length > 0) {
          const newProvider: string = data.providerId;
          setTriedFailoverProviders((prev) => Array.from(new Set([...prev, currentSrc, newProvider])));
          setSelectedItem((prev) =>
            prev
              ? {
                  ...prev,
                  sourceId: newProvider,
                  url: data.matchedItem?.url || prev.url,
                }
              : prev
          );
          if (data.detail) {
            setMediaDetail(data.detail);
          }
          if (data.episode) {
            setActiveEpisode(data.episode);
            setSelectedSeasonNumber(
              extractEpisodeSeasonNumber(
                data.episode,
                extractEpisodeSeasonNumber({ title: data.detail?.title || targetTitle }, 1)
              )
            );
          }
          setVideoSources(data.sources);
          setActiveSourceIndex(0);
          setFailoverNotice(
            `Auto Source Changer switched provider from ${currentSrc.toUpperCase()} to ${newProvider.toUpperCase()} (${data.sources.length} working servers)`
          );
        } else {
          const msg =
            data?.error ||
            `No alternate provider had working streams for "${targetTitle}". Try switching servers manually.`;
          setFailoverNotice(msg);
          setSourcesError((prevErr) => prevErr || msg);
        }
      } catch {
        if (openSeqRef.current !== reqSeq) return;
        const msg = 'Provider failover check failed. Please retry or select another server.';
        setFailoverNotice(msg);
        setSourcesError((prevErr) => prevErr || msg);
      } finally {
        isFailoverInFlightRef.current = false;
        if (openSeqRef.current === reqSeq) {
          setIsFailoverLoading(false);
        }
      }
    },
    [
      selectedItem,
      activeSourceId,
      mediaDetail,
      activeEpisode,
      audioCategory,
      triedFailoverProviders,
    ]
  );

  const handleRequestProviderFailover = useCallback(() => {
    void handleProviderFailover();
  }, [handleProviderFailover]);

  // Resolve Video Sources when activeEpisode or audioCategory changes
  const resolveEpisodeSources = useCallback(
    (
      sourceId: string,
      ep: ZangetsuEpisode,
      category: 'sub' | 'dub',
      itemTitle?: string,
      itemType?: 'anime' | 'movie' | 'tv',
      expectedOpenSeq?: number
    ) => {
      const reqSeq = expectedOpenSeq ?? openSeqRef.current;
      setIsResolvingSources(true);
      setSourcesError(null);
      setVideoSources([]);
      setActiveSourceIndex(0);
      setOfflineBlobUrl(null);

      fetch(
        `/api/zangetsu/sources/${sourceId}?episodeUrl=${encodeURIComponent(ep.url)}&category=${category}`
      )
        .then((r) => {
          if (!r.ok) throw new Error('Failed to resolve playable video sources');
          return r.json();
        })
        .then((data) => {
          if (openSeqRef.current !== reqSeq) return;
          const list: ZangetsuVideoSource[] = data.sources || [];
          if (list.length === 0) {
            if (autoSwitchEnabled && itemTitle) {
              void handleProviderFailover(
                sourceId,
                itemTitle,
                ep.number,
                itemType,
                [sourceId],
                reqSeq
              );
            } else {
              setSourcesError('No playable stream links resolved for this episode.');
            }
          } else {
            setVideoSources(list);
            setActiveSourceIndex(0);
          }
        })
        .catch((err) => {
          if (openSeqRef.current !== reqSeq) return;
          if (autoSwitchEnabled && itemTitle) {
            void handleProviderFailover(
              sourceId,
              itemTitle,
              ep.number,
              itemType,
              [sourceId],
              reqSeq
            );
          } else {
            setSourcesError(err instanceof Error ? err.message : 'Stream resolution failed');
          }
        })
        .finally(() => {
          if (openSeqRef.current === reqSeq) {
            setIsResolvingSources(false);
          }
        });
    },
    [autoSwitchEnabled, handleProviderFailover]
  );

  // Open a catalog item into the Theater Watch Room & resolve its first episode
  const handleOpenMedia = useCallback(
    (item: ZangetsuCatalogItem) => {
      openSeqRef.current += 1;
      const reqSeq = openSeqRef.current;
      const srcId = item.sourceId || activeSourceId;
      setSelectedItem(item);
      setMediaDetail(null);
      setActiveEpisode(null);
      setSelectedSeasonNumber(1);
      setEpisodeSearch('');
      setVideoSources([]);
      setSourcesError(null);
      setOfflineBlobUrl(null);
      setFailoverNotice(null);
      setTriedFailoverProviders([srcId]);
      setIsLoadingDetail(true);
      setDetailError(null);
      setIsSearchOpen(false);
      recordContinueWatching(item, 1, 1, 8);
      window.scrollTo({ top: 0, behavior: 'smooth' });

      fetch(`/api/zangetsu/detail/${srcId}?url=${encodeURIComponent(item.url)}`)
        .then((r) => {
          if (!r.ok) throw new Error('Failed to fetch media details');
          return r.json();
        })
        .then((data) => {
          if (openSeqRef.current !== reqSeq) return;
          const detail: ZangetsuMediaDetail = data.detail;
          setMediaDetail(detail);
          const eps = detail?.episodes || [];
          if (eps.length > 0) {
            const firstSeasonGroups = groupEpisodesBySeason(eps, detail.title || item.title);
            const initialSeason = firstSeasonGroups[0]?.seasonNumber || 1;
            const firstEp = firstSeasonGroups[0]?.episodes[0] || eps[0];
            setSelectedSeasonNumber(initialSeason);
            setActiveEpisode(firstEp);
            recordContinueWatching(
              { ...item, cover: detail.cover || item.cover, title: detail.title || item.title },
              firstEp.number,
              initialSeason,
              12
            );
            resolveEpisodeSources(
              srcId,
              firstEp,
              audioCategory,
              detail.title || item.title,
              detail.type || item.type,
              reqSeq
            );
          } else if (autoSwitchEnabled) {
            void handleProviderFailover(srcId, item.title, 1, item.type, [srcId], reqSeq);
          } else {
            setSourcesError('No episodes or movie links found on page.');
          }
        })
        .catch((err) => {
          if (openSeqRef.current !== reqSeq) return;
          if (autoSwitchEnabled) {
            void handleProviderFailover(srcId, item.title, 1, item.type, [srcId], reqSeq);
          } else {
            setDetailError(err instanceof Error ? err.message : 'Detail scrape failed');
          }
        })
        .finally(() => {
          if (openSeqRef.current === reqSeq) {
            setIsLoadingDetail(false);
          }
        });
    },
    [
      activeSourceId,
      audioCategory,
      resolveEpisodeSources,
      autoSwitchEnabled,
      handleProviderFailover,
      recordContinueWatching,
    ]
  );

  // Execute Movie / Anime Search (Supports Multi-Provider Movie Search & Anime Search)
  const executeSearch = useCallback(
    (queryText: string, scopeOverride?: SearchScope) => {
      const q = queryText.trim();
      if (!q) {
        setSearchResults(null);
        return;
      }
      const effectiveScope = scopeOverride || searchScope;
      setIsSearching(true);
      setSelectedItem(null);
      setSearchProviderFilter('all');
      setIsSearchOpen(false);
      if (activeNav === 'downloads' || activeNav === 'settings') {
        setActiveNav(effectiveScope === 'anime' ? 'anime' : 'movies');
      }

      const searchEndpoint =
        effectiveScope === 'active'
          ? `/api/zangetsu/search/${activeSourceId}?q=${encodeURIComponent(q)}`
          : `/api/zangetsu/search/${activeSourceId}?q=${encodeURIComponent(q)}&scope=${effectiveScope}`;

      fetch(searchEndpoint)
        .then((r) => r.json())
        .then((data) => {
          setSearchResults(data.items || []);
        })
        .catch(() => {
          setSearchResults([]);
        })
        .finally(() => {
          setIsSearching(false);
        });
    },
    [activeSourceId, searchScope, activeNav]
  );

  // Handle Search Submission
  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeSearch(searchQuery);
  };

  const isAnimeSourceId = useCallback(
    (sourceId?: string | null) => {
      if (!sourceId) return false;
      const match = providers.find((p) => p.id === sourceId);
      if (match) return match.type === 'anime';
      return ['hianime', 'anikoto', 'animecube', 'kartoons', 'animedubhindi'].includes(sourceId);
    },
    [providers]
  );

  // Handle Bottom Navigation Category Switching
  const handleNavClick = (nav: ActiveNav) => {
    setActiveNav(nav);
    setSelectedItem(null);
    setSearchResults(null);
    setIsSearchOpen(false);

    if (nav === 'anime') {
      setSearchScope('anime');
      if (!isAnimeSourceId(activeSourceId)) {
        setActiveSourceId('hianime');
      }
    } else if (nav === 'movies') {
      setSearchScope('movie');
      if (isAnimeSourceId(activeSourceId)) {
        setActiveSourceId('hdhub4u');
      }
    }
  };

  const executeTrackedTransfer = async (
    initialRec: OfflineVaultRecord,
    fetchUrl: string,
    fileExtension: string
  ) => {
    const recId = initialRec.id;
    const existingController = downloadControllersRef.current.get(recId);
    if (existingController) {
      existingController.abort();
      downloadControllersRef.current.delete(recId);
    }

    const controller = new AbortController();
    downloadControllersRef.current.set(recId, controller);

    try {
      const mimeType = fileExtension === 'mkv' ? 'video/x-matroska' : 'video/mp4';
      const { blob, totalBytes } = await fastFetchBinaryStream({
        url: fetchUrl,
        signal: controller.signal,
        estimatedTotalBytes: initialRec.totalBytes || 0,
        chunkSizeBytes: 3 * 1024 * 1024,
        concurrency: 6,
        mimeType,
        onProgress: ({ receivedBytes, totalBytes: resolvedTotalBytes, speedBytesPerSec }) => {
          const pct =
            resolvedTotalBytes > 0
              ? Math.min(99, Math.round((receivedBytes / resolvedTotalBytes) * 100))
              : Math.min(95, Math.max(5, Math.round(receivedBytes / (2 * 1024 * 1024))));
          setOfflineRecords((prev) =>
            prev.map((r) =>
              r.id === recId
                ? {
                    ...r,
                    progress: pct,
                    sizeBytes: receivedBytes,
                    totalBytes: resolvedTotalBytes > 0 ? resolvedTotalBytes : r.totalBytes,
                    speedBytesPerSec,
                  }
                : r
            )
          );
        },
      });

      downloadControllersRef.current.delete(recId);
      const finalSize = blob.size || totalBytes;
      const completedRec: OfflineVaultRecord = {
        ...initialRec,
        blob,
        fileExtension,
        downloadEndpoint: fetchUrl,
        sizeBytes: finalSize,
        totalBytes: finalSize,
        speedBytesPerSec: 0,
        status: 'completed',
        progress: 100,
        downloadError: undefined,
      };
      setOfflineRecords((prev) => prev.map((r) => (r.id === recId ? completedRec : r)));
      try {
        await saveOfflineRecord(completedRec);
      } catch {
        // If IndexedDB hits storage quota on very large movies (>1 GB), keep metadata persisted and full Blob ready in session
        await saveOfflineRecord({ ...completedRec, blob: undefined }).catch(() => {});
      }
    } catch (err) {
      downloadControllersRef.current.delete(recId);
      if (err instanceof Error && err.name === 'AbortError') {
        setOfflineRecords((prev) => prev.filter((r) => r.id !== recId));
        return;
      }
      const errorRec: OfflineVaultRecord = {
        ...initialRec,
        fileExtension,
        downloadEndpoint: fetchUrl,
        status: 'error',
        progress: 0,
        speedBytesPerSec: 0,
        downloadError: err instanceof Error ? err.message : 'Download interrupted',
      };
      setOfflineRecords((prev) => prev.map((r) => (r.id === recId ? errorRec : r)));
      await saveOfflineRecord({ ...errorRec, blob: undefined }).catch(() => {});
    }
  };

  // Trigger Real Tracked Download (Parallel Range Chunks + Zero HTTP 500 + Live Speed & Progress)
  const handleTriggerOfflineSave = async (
    source: ZangetsuVideoSource,
    audioIndex: number,
    audioLabel: string,
    qualityOption?: SupportedDownloadQuality,
    probedMeta?: ProbedMediaMetadata | null
  ) => {
    const title = mediaDetail?.title || selectedItem?.title || 'Zangetsu Media';
    const epNum = activeEpisode?.number || 1;
    const epTitle = activeEpisode?.title || 'Full Movie';
    const epSeason = activeEpisode
      ? extractEpisodeSeasonNumber(
          activeEpisode,
          extractEpisodeSeasonNumber({ title }, 1)
        )
      : 1;
    const qualityLabel =
      qualityOption?.label ||
      (source.quality && source.quality !== 'auto' ? source.quality : 'HD');

    const recId = `${activeSourceId}-${title}-S${epSeason}E${epNum}-${qualityLabel}-${audioLabel}`.replace(
      /[^a-zA-Z0-9_-]/g,
      '_'
    );

    const estimatedTotalBytes =
      (qualityOption?.estimatedBytes && qualityOption.estimatedBytes > 0
        ? qualityOption.estimatedBytes
        : 0) ||
      (probedMeta?.sizeBytes && probedMeta.sizeBytes > 0 ? probedMeta.sizeBytes : 0) ||
      parseHumanSizeToBytes(source.size);

    const baseName = `${title.replace(/[^a-zA-Z0-9]+/g, '_')}_${
      epTitle !== 'Full Movie' ? `S${epSeason}E${epNum}_` : ''
    }${qualityLabel.replace(/[^a-zA-Z0-9]+/g, '')}_${audioLabel.replace(/[^a-zA-Z0-9]+/g, '')}`;

    const effectiveQuality: SupportedDownloadQuality = qualityOption || {
      id: 'default',
      label: qualityLabel,
      containerLabel: 'MP4',
      sizeLabel: source.size || '',
      estimatedBytes: estimatedTotalBytes,
      hlsLevelIndex: -1,
    };

    const previewEndpoint = selectMinimalDownloadEndpoint({
      source,
      quality: effectiveQuality,
      audioIndex,
      probedMeta: probedMeta || null,
      filename: `${baseName}.mp4`,
    });
    const fileExtension = inferDownloadExtension(previewEndpoint, qualityOption?.variantUrl || source.url);
    const safeFilename = `${baseName}.${fileExtension}`;
    const fetchUrl =
      fileExtension === 'mp4'
        ? previewEndpoint
        : selectMinimalDownloadEndpoint({
            source,
            quality: effectiveQuality,
            audioIndex,
            probedMeta: probedMeta || null,
            filename: safeFilename,
          });

    const initialRec: OfflineVaultRecord = {
      id: recId,
      title,
      episodeTitle: epTitle,
      episodeNumber: epNum,
      seasonNumber: epSeason,
      isSeries: (mediaDetail?.episodes?.length || 0) > 1 || selectedItem?.type !== 'movie',
      sourceId: selectedItem?.sourceId || activeSourceId,
      cover: mediaDetail?.cover || selectedItem?.cover || null,
      quality: qualityLabel,
      audioFormat: audioLabel,
      sizeBytes: 0,
      totalBytes: estimatedTotalBytes,
      speedBytesPerSec: 0,
      savedAt: new Date().toISOString(),
      status: 'downloading',
      progress: 0,
      directUrl: qualityOption?.variantUrl || source.url,
      headers: source.headers,
      fileExtension,
      downloadEndpoint: fetchUrl,
    };

    setOfflineRecords((prev) => [initialRec, ...prev.filter((r) => r.id !== recId)]);
    await executeTrackedTransfer(initialRec, fetchUrl, fileExtension);
  };

  const handleRetryOfflineDownload = async (rec: OfflineVaultRecord) => {
    const ext = rec.fileExtension || inferDownloadExtension(rec.downloadEndpoint || '', rec.directUrl);
    const safeName = `${rec.title.replace(/[^a-zA-Z0-9]+/g, '_')}_E${rec.episodeNumber}_${rec.quality.replace(/[^a-zA-Z0-9]+/g, '')}.${ext}`;
    const hdr = rec.headers ? encodeURIComponent(JSON.stringify(rec.headers)) : '';
    const fetchUrl =
      rec.downloadEndpoint ||
      (rec.directUrl.includes('.m3u8')
        ? `/api/stream/remux?url=${encodeURIComponent(rec.directUrl)}&headers=${hdr}&download=1&filename=${encodeURIComponent(safeName)}`
        : `/api/proxy?url=${encodeURIComponent(rec.directUrl)}&headers=${hdr}&download=1&filename=${encodeURIComponent(safeName)}`);

    const restartedRec: OfflineVaultRecord = {
      ...rec,
      status: 'downloading',
      progress: 0,
      sizeBytes: 0,
      speedBytesPerSec: 0,
      downloadError: undefined,
      fileExtension: ext,
      downloadEndpoint: fetchUrl,
    };
    setOfflineRecords((prev) => prev.map((r) => (r.id === rec.id ? restartedRec : r)));
    await executeTrackedTransfer(restartedRec, fetchUrl, ext);
  };

  const handleCancelOfflineDownload = async (id: string) => {
    const controller = downloadControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      downloadControllersRef.current.delete(id);
    }
    setOfflineRecords((prev) => prev.filter((r) => r.id !== id));
    await deleteOfflineRecord(id).catch(() => {});
  };

  const handlePlayOfflineRecord = (rec: OfflineVaultRecord) => {
    setActiveNav(isAnimeSourceId(rec.sourceId) ? 'anime' : 'movies');
    setSelectedItem({
      id: rec.id,
      title: rec.title,
      cover: rec.cover,
      url: rec.directUrl,
      type: 'movie',
      sourceId: rec.sourceId,
    });
    setMediaDetail({
      id: rec.id,
      title: rec.title,
      cover: rec.cover,
      url: rec.directUrl,
      description: `Playing from Zangetsu Offline Vault (${rec.quality} · ${rec.audioFormat})`,
      status: 'Offline Ready',
      genres: [],
      studios: [],
      type: 'movie',
      sourceId: rec.sourceId,
      episodes: [
        {
          id: 'offline-ep',
          number: rec.episodeNumber,
          title: rec.episodeTitle,
          url: rec.directUrl,
        },
      ],
    });
    setActiveEpisode({
      id: 'offline-ep',
      number: rec.episodeNumber,
      title: rec.episodeTitle,
      url: rec.directUrl,
    });
    if (rec.blob) {
      const bUrl = URL.createObjectURL(rec.blob);
      setOfflineBlobUrl(bUrl);
    } else {
      setOfflineBlobUrl(null);
      setVideoSources([
        {
          url: rec.directUrl,
          quality: rec.quality,
          container: rec.directUrl.includes('.m3u8') ? 'hls' : 'mp4',
          headers: rec.headers,
          label: `${rec.sourceId.toUpperCase()} [${rec.quality}]`,
          server: 'Offline Direct',
          audioFormat: rec.audioFormat,
        },
      ]);
    }
  };

  const handleDeleteOfflineRecord = async (id: string) => {
    await deleteOfflineRecord(id);
    setOfflineRecords((prev) => prev.filter((r) => r.id !== id));
  };

  // Active home rows
  const displayedRows = homeRows;

  // Dynamic Hero Carousel Slides built directly from live Zangetsu home catalog (up to 19 slides)
  const heroSlides = useMemo(() => {
    const seen = new Set<string>();
    const list: ZangetsuCatalogItem[] = [];
    for (const row of displayedRows) {
      for (const item of row.items || []) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        list.push(item);
        if (list.length >= 19) return list;
      }
    }
    return list;
  }, [displayedRows]);

  const safeHeroIdx = heroSlides.length > 0 ? heroSlideIdx % heroSlides.length : 0;
  const activeHeroItem = heroSlides[safeHeroIdx] || null;

  // Auto-advance hero banner subtly when on home view (respects reduced motion)
  useEffect(() => {
    if (selectedItem || searchResults !== null || activeNav === 'downloads' || activeNav === 'settings' || heroSlides.length <= 1) {
      return;
    }
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    const id = window.setInterval(() => {
      setHeroSlideIdx((prev) => (prev + 1) % heroSlides.length);
    }, 7000);
    return () => window.clearInterval(id);
  }, [selectedItem, searchResults, activeNav, heroSlides.length]);

  const episodesList = mediaDetail?.episodes || [];
  const seasonGroups = useMemo(
    () => groupEpisodesBySeason(episodesList, mediaDetail?.title || selectedItem?.title),
    [episodesList, mediaDetail?.title, selectedItem?.title]
  );

  const activeSeasonGroup = useMemo(
    () =>
      seasonGroups.find((g) => g.seasonNumber === selectedSeasonNumber) ||
      seasonGroups[0] ||
      null,
    [seasonGroups, selectedSeasonNumber]
  );

  const activeSeasonEpisodes = activeSeasonGroup ? activeSeasonGroup.episodes : episodesList;

  const filteredEpisodes = episodeSearch.trim()
    ? activeSeasonEpisodes.filter(
        (e) =>
          String(e.number).includes(episodeSearch.trim()) ||
          e.title.toLowerCase().includes(episodeSearch.trim().toLowerCase())
      )
    : activeSeasonEpisodes;

  const activeEpisodeSeason = useMemo(() => {
    if (!activeEpisode) return selectedSeasonNumber || 1;
    return extractEpisodeSeasonNumber(
      activeEpisode,
      extractEpisodeSeasonNumber({ title: mediaDetail?.title || selectedItem?.title }, 1)
    );
  }, [activeEpisode, selectedSeasonNumber, mediaDetail?.title, selectedItem?.title]);

  const currentEpIdx = activeEpisode
    ? episodesList.findIndex((e) => e.id === activeEpisode.id)
    : -1;
  const hasNextEp = currentEpIdx >= 0 && currentEpIdx + 1 < episodesList.length;

  // Filtered search results by provider tab
  const filteredSearchResults = React.useMemo(() => {
    if (!searchResults) return [];
    if (searchProviderFilter === 'all') return searchResults;
    return searchResults.filter((item) => item.sourceId === searchProviderFilter);
  }, [searchResults, searchProviderFilter]);

  const searchResultProviders = React.useMemo(() => {
    if (!searchResults) return [];
    return Array.from(new Set(searchResults.map((i) => i.sourceId)));
  }, [searchResults]);

  const isWatchView = Boolean(selectedItem) && activeNav !== 'downloads' && activeNav !== 'settings';
  const activeMediaKey = selectedItem ? `${selectedItem.sourceId || activeSourceId}:${selectedItem.id}` : '';
  const isInWatchlist = activeMediaKey ? watchlistIds.includes(activeMediaKey) : false;
  const activeComments = activeMediaKey ? commentsByMedia[activeMediaKey] || [] : [];

  const showTimedNotice = useCallback((msg: string) => {
    setActionNotice(msg);
    window.setTimeout(() => {
      setActionNotice((cur) => (cur === msg ? null : cur));
    }, 3200);
  }, []);

  const toggleItemWatchlist = useCallback(
    (item: ZangetsuCatalogItem) => {
      const key = `${item.sourceId || activeSourceId}:${item.id}`;
      const exists = watchlistIds.includes(key);
      setWatchlistIds((prev) => {
        const next = exists ? prev.filter((id) => id !== key) : [key, ...prev];
        try {
          localStorage.setItem('zx_watchlist_ids', JSON.stringify(next));
        } catch {}
        return next;
      });
      setWatchlistItems((prev) => {
        const next = exists ? prev.filter((x) => `${x.sourceId || activeSourceId}:${x.id}` !== key) : [item, ...prev.filter((x) => `${x.sourceId || activeSourceId}:${x.id}` !== key)].slice(0, 40);
        try {
          localStorage.setItem('zx_watchlist_items', JSON.stringify(next));
        } catch {}
        return next;
      });
      showTimedNotice(exists ? 'Removed from My List' : 'Added to My List');
    },
    [activeSourceId, watchlistIds, showTimedNotice]
  );

  const handleToggleWatchlist = () => {
    if (!selectedItem) return;
    toggleItemWatchlist({
      ...selectedItem,
      title: mediaDetail?.title || selectedItem.title,
      cover: mediaDetail?.cover || selectedItem.cover,
    });
  };

  const handlePlaybackProgress = useCallback(
    (currentTime: number, duration: number) => {
      if (!selectedItem || duration <= 0) return;
      const pct = Math.max(4, Math.min(98, Math.round((currentTime / duration) * 100)));
      recordContinueWatching(
        {
          ...selectedItem,
          title: mediaDetail?.title || selectedItem.title,
          cover: mediaDetail?.cover || selectedItem.cover,
        },
        activeEpisode?.number || 1,
        activeEpisodeSeason,
        pct
      );
    },
    [selectedItem, mediaDetail?.title, mediaDetail?.cover, activeEpisode?.number, activeEpisodeSeason, recordContinueWatching]
  );

  const handleShareMedia = async () => {
    const shareTitle = mediaDetail?.title || selectedItem?.title || 'Zangetsu Stream Hub';
    const shareUrl = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, url: shareUrl });
        return;
      } catch {
        // fallback to clipboard copy
      }
    }
    try {
      await navigator.clipboard.writeText(`${shareTitle} — ${shareUrl}`);
      showTimedNotice('Share link copied to clipboard');
    } catch {
      showTimedNotice(`Ready to share: ${shareTitle}`);
    }
  };

  const handlePlayOnTv = async () => {
    const videoEl = document.querySelector('video') as (HTMLVideoElement & {
      remote?: { prompt: () => Promise<void> };
    }) | null;
    if (videoEl?.remote && typeof videoEl.remote.prompt === 'function') {
      try {
        await videoEl.remote.prompt();
        return;
      } catch {
        // fallback to TV cast URL modal
      }
    }
    setShowTvModal(true);
  };

  const handlePostComment = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = commentDraft.trim();
    if (!trimmed || !activeMediaKey) return;
    const entry = {
      id: `${Date.now()}`,
      author: 'Viewer',
      time: 'Just now',
      text: trimmed,
    };
    setCommentsByMedia((prev) => {
      const next = {
        ...prev,
        [activeMediaKey]: [entry, ...(prev[activeMediaKey] || [])],
      };
      try {
        localStorage.setItem('zx_media_comments', JSON.stringify(next));
      } catch {}
      return next;
    });
    setCommentDraft('');
  };

  const recommendedItems = React.useMemo(() => {
    if (!selectedItem) return [];
    const pool = homeRows.flatMap((r) => r.items);
    const seen = new Set<string>();
    const unique: ZangetsuCatalogItem[] = [];
    for (const item of pool) {
      if (item.id !== selectedItem.id && !seen.has(item.id)) {
        seen.add(item.id);
        unique.push(item);
      }
      if (unique.length >= 12) break;
    }
    return unique;
  }, [homeRows, selectedItem]);

  const isHomeShowcase =
    !isWatchView &&
    activeNav !== 'downloads' &&
    activeNav !== 'settings' &&
    searchResults === null;

  return (
    <div className="min-h-screen bg-black text-slate-100 flex flex-col">
      {/* Minimal OTT Top Bar (Overlay on Hero in Browse View, Hidden in Watch View & Downloads View) */}
      {!isWatchView && activeNav !== 'downloads' && (
        <>
          <header
            className={`${
              isHomeShowcase
                ? 'fixed top-0 inset-x-0 bg-gradient-to-b from-black/85 via-black/45 to-transparent'
                : 'sticky top-0 bg-black/95 backdrop-blur-md border-b border-white/10'
            } z-40 px-4 sm:px-8 h-14 flex items-center justify-between transition-colors`}
          >
            {/* Brand Logo Mark (Sleek White Geometric Monogram matching reference) */}
            <button
              type="button"
              data-testid="brand-logo-btn"
              aria-label="Zangetsu Home"
              onClick={() => {
                setSelectedItem(null);
                setSearchResults(null);
                setIsSearchOpen(false);
                if (activeNav === 'settings') {
                  setActiveNav('movies');
                }
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="min-w-[44px] min-h-[44px] flex items-center justify-start focus:outline-none"
            >
              <svg
                width="30"
                height="24"
                viewBox="0 0 36 28"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
                className="text-white"
              >
                <path
                  d="M3 24L12.5 4H16.5L11 16H17.5L15.5 20.5H9L7.2 24H3Z"
                  fill="currentColor"
                />
                <path
                  d="M17.5 4H22L25.5 16.5L30.5 4H34.5L26.8 24H23L17.5 4Z"
                  fill="currentColor"
                />
              </svg>
            </button>

            {/* Right Action: Clean Search Icon */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="open-search-btn"
                aria-label="Search Movies and Anime"
                onClick={() => setIsSearchOpen((v) => !v)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-end text-white hover:text-slate-300 transition-colors"
              >
                {isSearchOpen ? <X className="w-6 h-6" /> : <Search className="w-6 h-6 stroke-[2]" />}
              </button>
            </div>
          </header>

          {/* Expandable Top Search Bar Overlay */}
          {isSearchOpen && (
            <div
              data-testid="search-overlay"
              className="fixed top-14 inset-x-0 z-40 bg-black/95 backdrop-blur-lg border-b border-white/10 px-4 sm:px-8 py-4 shadow-2xl"
            >
              <form
                onSubmit={handleSearchSubmit}
                data-testid="movie-search-form"
                className="max-w-4xl mx-auto flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
              >
                <select
                  aria-label="Search Scope"
                  data-testid="search-scope-select"
                  value={searchScope}
                  onChange={(e) => setSearchScope(e.target.value as SearchScope)}
                  className="px-3 py-2.5 bg-[#161618] border border-white/15 rounded-xl text-xs text-white font-semibold focus:outline-none focus:border-white/40 shrink-0"
                >
                  <option value="movie">All Movies & Series (HDHub4u + 4K + UHD)</option>
                  <option value="anime">All Anime (HiAnime + AniKoto)</option>
                  <option value="all">All Movies & Anime</option>
                  <option value="active">Active ({activeSourceId.toUpperCase()})</option>
                </select>

                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    autoFocus
                    data-testid="movie-search-input"
                    aria-label="Search movies, series, or anime via Zangetsu"
                    placeholder="Search any movie, web series, or anime..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-3 py-2.5 bg-[#161618] border border-white/15 rounded-xl text-sm text-white placeholder-slate-400 focus:outline-none focus:border-white/40"
                  />
                </div>
                <button
                  type="submit"
                  data-testid="movie-search-submit"
                  className="px-5 py-2.5 bg-white hover:bg-slate-200 text-black text-xs sm:text-sm font-bold rounded-xl transition-colors whitespace-nowrap shrink-0"
                >
                  Search
                </button>
              </form>
            </div>
          )}
        </>
      )}

      {/* Main Content Area */}
      <main className="flex-1">
        {activeNav === 'downloads' ? (
          <OfflineDownloadsView
            records={offlineRecords}
            onPlayOffline={handlePlayOfflineRecord}
            onDeleteOffline={handleDeleteOfflineRecord}
            onCancelOffline={handleCancelOfflineDownload}
            onRetryOffline={handleRetryOfflineDownload}
            onBrowseCatalog={() => setActiveNav('movies')}
          />
        ) : activeNav === 'settings' ? (
          <div data-testid="settings-view" className="max-w-4xl mx-auto px-4 sm:px-8 py-6 pb-28 flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-bold text-white font-display">Settings & Sources</h1>
              <p className="text-xs sm:text-sm text-slate-400">
                Choose active live Zangetsu extension, playback failover behavior, and manage My List.
              </p>
            </div>

            {/* Active Extension Provider Picker */}
            <section className="bg-[#141416] border border-white/10 rounded-2xl p-4 sm:p-5 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm sm:text-base font-bold text-white">Active Live Provider</h2>
                <button
                  type="button"
                  onClick={() => setIsInspectorOpen(true)}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-semibold text-white flex items-center gap-1.5"
                >
                  <Code2 className="w-3.5 h-3.5" />
                  <span>Zangetsu JS Runtime</span>
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {providers.map((prov) => {
                  const isActive = activeSourceId === prov.id;
                  return (
                    <button
                      key={prov.id}
                      type="button"
                      onClick={() => {
                        setActiveSourceId(prov.id);
                        setSelectedItem(null);
                        setSearchScope(prov.type === 'anime' ? 'anime' : 'movie');
                        setActiveNav(prov.type === 'anime' ? 'anime' : 'movies');
                      }}
                      className={`p-3 rounded-xl text-left border transition-colors flex items-center justify-between ${
                        isActive
                          ? 'bg-white text-black border-white font-semibold'
                          : 'bg-black/50 text-slate-200 border-white/10 hover:border-white/30'
                      }`}
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-bold">{prov.name}</span>
                        <span className={`text-[11px] ${isActive ? 'text-slate-700' : 'text-slate-400'}`}>
                          {prov.type === 'anime' ? 'Anime Extension' : 'Movies & Web Series'} · v{prov.version}
                        </span>
                      </div>
                      {isActive && <Check className="w-4 h-4 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Playback & Storage Preferences */}
            <section className="bg-[#141416] border border-white/10 rounded-2xl p-4 sm:p-5 flex flex-col gap-4">
              <h2 className="text-sm sm:text-base font-bold text-white">Playback & History</h2>
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-white">Auto Source Changer</span>
                  <span className="text-xs text-slate-400">
                    Automatically fail over to backup Zangetsu extensions when a server errors out.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoSwitchEnabled((v) => !v)}
                  className={`px-4 py-2 rounded-lg text-xs font-bold shrink-0 transition-colors ${
                    autoSwitchEnabled ? 'bg-white text-black' : 'bg-[#222226] text-slate-300'
                  }`}
                >
                  {autoSwitchEnabled ? 'ON' : 'OFF'}
                </button>
              </div>

              {continueWatching.length > 0 && (
                <div className="flex items-center justify-between gap-4 pt-3 border-t border-white/10">
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-white">Continue Watching History</span>
                    <span className="text-xs text-slate-400">
                      {continueWatching.length} saved title{continueWatching.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setContinueWatching([]);
                      try {
                        localStorage.removeItem('zx_continue_watching');
                      } catch {}
                    }}
                    className="px-3.5 py-2 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-xs font-semibold flex items-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear</span>
                  </button>
                </div>
              )}
            </section>

            {/* Saved My List */}
            {watchlistItems.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="text-base sm:text-lg font-bold text-white">My List ({watchlistItems.length})</h2>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                  {watchlistItems.map((item) => (
                    <PosterCard key={`${item.sourceId}:${item.id}`} item={item} onSelect={handleOpenMedia} />
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : selectedItem ? (
          /* WATCH DETAIL VIEW (Matches Reference Screenshot: Player at Top -> Title -> Rating/Year -> Action Pills -> Servers -> Comments -> Episodes -> You May Also Like) */
          <div data-testid="watch-detail-view" className="bg-black min-h-screen w-full pb-14">
            {/* Top Full-Bleed / Theater 16:9 Player Viewport */}
            <div className="w-full max-w-5xl mx-auto sm:pt-3 sm:px-4">
              {(isResolvingSources || isFailoverLoading) && videoSources.length === 0 && !offlineBlobUrl ? (
                <div className="relative w-full aspect-video bg-black sm:rounded-xl overflow-hidden flex flex-col items-center justify-center p-6 text-center gap-3">
                  <div className="absolute top-0 inset-x-0 px-4 pt-4 flex items-center gap-3">
                    <button
                      type="button"
                      aria-label="Back to Catalog"
                      onClick={() => {
                        openSeqRef.current += 1;
                        setSelectedItem(null);
                        setOfflineBlobUrl(null);
                      }}
                      className="p-1.5 -ml-1 text-white hover:text-slate-200 transition-colors"
                    >
                      <ChevronLeft className="w-6 h-6 stroke-[2.2]" />
                    </button>
                    <h2 className="text-base sm:text-lg font-bold text-white truncate">
                      {mediaDetail?.title || selectedItem.title}
                    </h2>
                  </div>
                  <Loader2 className="w-10 h-10 text-white animate-spin" />
                  <div className="flex flex-col gap-1">
                    <h3 className="text-sm font-semibold text-white">
                      {isFailoverLoading
                        ? 'Auto-Switching to Backup Zangetsu Provider...'
                        : `Resolving live stream from ${(selectedItem.sourceId || activeSourceId).toUpperCase()}...`}
                    </h3>
                    <p className="text-xs text-slate-400 max-w-md">
                      Decrypting playback servers and probing audio & subtitle tracks in real time.
                    </p>
                  </div>
                </div>
              ) : sourcesError && videoSources.length === 0 && !offlineBlobUrl ? (
                <div className="relative w-full aspect-video bg-black sm:rounded-xl overflow-hidden flex flex-col items-center justify-center p-6 text-center gap-3">
                  <div className="absolute top-0 inset-x-0 px-4 pt-4 flex items-center gap-3">
                    <button
                      type="button"
                      aria-label="Back to Catalog"
                      onClick={() => {
                        openSeqRef.current += 1;
                        setSelectedItem(null);
                        setOfflineBlobUrl(null);
                      }}
                      className="p-1.5 -ml-1 text-white hover:text-slate-200 transition-colors"
                    >
                      <ChevronLeft className="w-6 h-6 stroke-[2.2]" />
                    </button>
                    <h2 className="text-base sm:text-lg font-bold text-white truncate">
                      {mediaDetail?.title || selectedItem.title}
                    </h2>
                  </div>
                  <AlertCircle className="w-10 h-10 text-rose-500" />
                  <p className="text-sm text-slate-200 max-w-md">{sourcesError}</p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {activeEpisode && (
                      <button
                        type="button"
                        onClick={() =>
                          resolveEpisodeSources(
                            selectedItem.sourceId || activeSourceId,
                            activeEpisode,
                            audioCategory,
                            mediaDetail?.title || selectedItem.title,
                            mediaDetail?.type || selectedItem.type
                          )
                        }
                        className="px-4 py-2 bg-white text-black font-semibold text-xs rounded-full hover:bg-slate-200 transition-colors flex items-center gap-1.5"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Retry Stream</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleProviderFailover()}
                      disabled={isFailoverLoading}
                      className="px-4 py-2 bg-[#1E1E20] text-white border border-white/15 font-semibold text-xs rounded-full hover:bg-[#2A2A2D] transition-colors flex items-center gap-1.5"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isFailoverLoading ? 'animate-spin' : ''}`} />
                      <span>Switch Backup Provider</span>
                    </button>
                  </div>
                </div>
              ) : (
                <VideoPlayer
                  title={mediaDetail?.title || selectedItem.title}
                  episode={activeEpisode}
                  poster={mediaDetail?.cover || selectedItem.cover}
                  sources={videoSources}
                  activeSourceIndex={activeSourceIndex}
                  onSelectSource={setActiveSourceIndex}
                  audioCategory={audioCategory}
                  onChangeAudioCategory={(cat) => {
                    setAudioCategory(cat);
                    if (activeEpisode) {
                      resolveEpisodeSources(
                        selectedItem.sourceId || activeSourceId,
                        activeEpisode,
                        cat,
                        mediaDetail?.title || selectedItem.title,
                        mediaDetail?.type || selectedItem.type
                      );
                    }
                  }}
                  hasSubDubToggle={
                    selectedItem.type === 'anime' ||
                    ['hianime', 'anikoto', 'animecube'].includes(
                      selectedItem.sourceId || activeSourceId
                    )
                  }
                  onTriggerOfflineSave={handleTriggerOfflineSave}
                  onViewDownloads={() => {
                    openSeqRef.current += 1;
                    setSelectedItem(null);
                    setOfflineBlobUrl(null);
                    setActiveNav('downloads');
                  }}
                  onBack={() => {
                    openSeqRef.current += 1;
                    setSelectedItem(null);
                    setOfflineBlobUrl(null);
                  }}
                  hasPreviousEpisode={currentEpIdx > 0}
                  onPreviousEpisode={() => {
                    if (currentEpIdx > 0) {
                      const prevEp = episodesList[currentEpIdx - 1];
                      setActiveEpisode(prevEp);
                      setSelectedSeasonNumber(
                        extractEpisodeSeasonNumber(
                          prevEp,
                          extractEpisodeSeasonNumber({ title: mediaDetail?.title || selectedItem.title }, 1)
                        )
                      );
                      resolveEpisodeSources(
                        selectedItem.sourceId || activeSourceId,
                        prevEp,
                        audioCategory,
                        mediaDetail?.title || selectedItem.title,
                        mediaDetail?.type || selectedItem.type
                      );
                    }
                  }}
                  hasNextEpisode={hasNextEp}
                  onNextEpisode={() => {
                    if (hasNextEp) {
                      const nextEp = episodesList[currentEpIdx + 1];
                      setActiveEpisode(nextEp);
                      setSelectedSeasonNumber(
                        extractEpisodeSeasonNumber(
                          nextEp,
                          extractEpisodeSeasonNumber({ title: mediaDetail?.title || selectedItem.title }, 1)
                        )
                      );
                      resolveEpisodeSources(
                        selectedItem.sourceId || activeSourceId,
                        nextEp,
                        audioCategory,
                        mediaDetail?.title || selectedItem.title,
                        mediaDetail?.type || selectedItem.type
                      );
                    }
                  }}
                  recommendations={recommendedItems}
                  onSelectRecommendation={handleOpenMedia}
                  offlineBlobUrl={offlineBlobUrl}
                  autoSwitchEnabled={autoSwitchEnabled}
                  onToggleAutoSwitch={() => setAutoSwitchEnabled((v) => !v)}
                  onRequestProviderFailover={handleRequestProviderFailover}
                  isFailoverLoading={isFailoverLoading}
                  failoverNotice={failoverNotice}
                  currentProviderId={selectedItem.sourceId || activeSourceId}
                  hideServerBar
                  openDownloadSignal={openDownloadSignal}
                  isSeries={episodesList.length > 1 || selectedItem.type !== 'movie'}
                  seasonNumber={activeEpisodeSeason}
                  onPlaybackProgress={handlePlaybackProgress}
                />
              )}
            </div>

            {/* Detail Information & Interactive Sections Directly Below Player */}
            <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-4 flex flex-col gap-5">
              {/* 1. Title & Rating / Year / Episode Metadata */}
              <div className="flex flex-col gap-2">
                <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight leading-snug">
                  {mediaDetail?.title || selectedItem.title}
                </h1>
                <div className="flex flex-wrap items-center gap-3 text-sm text-slate-300 font-medium">
                  {(mediaDetail?.rating ?? selectedItem.rating) && (
                    <span className="inline-flex items-center gap-1.5 text-white font-semibold">
                      <Star className="w-4 h-4 text-amber-400 fill-amber-400" />
                      <span>{mediaDetail?.rating ?? selectedItem.rating}</span>
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1.5 text-amber-400 font-semibold uppercase text-xs">
                    <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                    <span>{selectedItem.sourceId || activeSourceId}</span>
                  </span>
                  {(mediaDetail?.year || selectedItem.year) && (
                    <span className="font-mono tabular-nums text-slate-300">
                      {mediaDetail?.year || selectedItem.year}
                    </span>
                  )}
                  {activeEpisode && (episodesList.length > 1 || selectedItem.type !== 'movie') && (
                    <span className="font-mono tabular-nums text-slate-300">
                      S{activeEpisodeSeason} E{activeEpisode.number}
                    </span>
                  )}
                  {mediaDetail?.genres && mediaDetail.genres.length > 0 && (
                    <span className="text-xs text-slate-400">
                      {mediaDetail.genres.slice(0, 3).join(' · ')}
                    </span>
                  )}
                </div>
              </div>

              {/* 2. Action Pill Row: Add to List | Play on TV | Share | Report | Download | View Downloads */}
              <div className="flex items-center gap-2.5 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={handleToggleWatchlist}
                  className={`px-4 py-2 rounded-full text-xs sm:text-sm font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors ${
                    isInWatchlist
                      ? 'bg-white text-black font-semibold'
                      : 'bg-[#1E1E20] hover:bg-[#2A2A2D] text-white'
                  }`}
                >
                  {isInWatchlist ? <Check className="w-4 h-4" /> : <Bookmark className="w-4 h-4" />}
                  <span>{isInWatchlist ? 'In My List' : 'Add to List'}</span>
                </button>

                <button
                  type="button"
                  onClick={handlePlayOnTv}
                  className="px-4 py-2 rounded-full bg-[#1E1E20] hover:bg-[#2A2A2D] text-white text-xs sm:text-sm font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                >
                  <Tv className="w-4 h-4" />
                  <span>Play on TV</span>
                </button>

                <button
                  type="button"
                  onClick={handleShareMedia}
                  className="px-4 py-2 rounded-full bg-[#1E1E20] hover:bg-[#2A2A2D] text-white text-xs sm:text-sm font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                >
                  <Share2 className="w-4 h-4" />
                  <span>Share</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowReportModal(true)}
                  className="px-4 py-2 rounded-full bg-[#1E1E20] hover:bg-[#2A2A2D] text-white text-xs sm:text-sm font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                >
                  <Flag className="w-4 h-4" />
                  <span>Report</span>
                </button>

                {videoSources.length > 0 && (
                  <button
                    type="button"
                    data-testid="detail-download-btn"
                    onClick={() => setOpenDownloadSignal((n) => n + 1)}
                    className="px-4 py-2 rounded-full bg-[#1E1E20] hover:bg-[#2A2A2D] text-white text-xs sm:text-sm font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                  >
                    <Download className="w-4 h-4" />
                    <span>Download</span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setActiveNav('downloads')}
                  className="px-4 py-2 rounded-full bg-[#1E1E20] hover:bg-[#2A2A2D] text-white text-xs sm:text-sm font-medium flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
                >
                  <FolderDown className="w-4 h-4" />
                  <span>View Downloads</span>
                </button>
              </div>

              {actionNotice && (
                <div className="px-4 py-2 rounded-xl bg-[#1C1C1E] border border-white/10 text-xs text-amber-300 flex items-center justify-between">
                  <span>{actionNotice}</span>
                  <button
                    type="button"
                    onClick={() => setActionNotice(null)}
                    className="text-slate-400 hover:text-white ml-4"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* 3. Alternative Server Selection & Auto-Switch Controls */}
              <div className="flex flex-col gap-3 pt-1">
                <p className="text-sm italic text-slate-300">
                  If current server is not working, try a different one:
                </p>

                {videoSources.length > 0 && (
                  <div className="flex items-center gap-2.5 overflow-x-auto pb-1">
                    <span className="text-sm font-bold text-white shrink-0">Servers :</span>
                    {videoSources.map((src, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setActiveSourceIndex(idx)}
                        className={`px-5 py-2 rounded-full text-sm font-semibold transition-all shrink-0 ${
                          idx === activeSourceIndex
                            ? 'bg-white text-black shadow-sm'
                            : 'bg-[#1C1C1E] hover:bg-[#2A2A2D] text-slate-200'
                        }`}
                      >
                        {src.server || `Server ${idx + 1}`}
                        {src.quality && src.quality !== 'auto' ? ` (${src.quality})` : ''}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="auto-source-changer-toggle"
                    onClick={() => setAutoSwitchEnabled((v) => !v)}
                    className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                      autoSwitchEnabled
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-[#161618] border-white/10 text-slate-400'
                    }`}
                  >
                    Auto-Switch: {autoSwitchEnabled ? 'ON' : 'OFF'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleProviderFailover()}
                    disabled={isFailoverLoading}
                    className="px-3 py-1 rounded-full text-xs font-medium bg-[#161618] hover:bg-[#232326] border border-white/15 text-amber-300 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${isFailoverLoading ? 'animate-spin' : ''}`} />
                    <span>Switch Provider ({(selectedItem.sourceId || activeSourceId).toUpperCase()})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsInspectorOpen(true)}
                    className="px-3 py-1 rounded-full text-xs font-medium bg-[#161618] hover:bg-[#232326] border border-white/10 text-slate-300 flex items-center gap-1.5"
                  >
                    <Code2 className="w-3 h-3 text-amber-400" />
                    <span>Resolver Trace</span>
                  </button>
                </div>
              </div>

              {/* 4. Comments Card (Matching Reference Screenshot) */}
              <section
                aria-label="Comments"
                className="bg-[#161618] border border-white/5 rounded-2xl p-4 sm:p-5 flex flex-col gap-3.5"
              >
                <div className="flex items-center gap-2">
                  <h2 className="text-base sm:text-lg font-bold text-white">Comments</h2>
                  <span className="text-base sm:text-lg font-semibold text-slate-400 font-mono tabular-nums">
                    {activeComments.length}
                  </span>
                </div>

                {activeComments.length === 0 ? (
                  <p className="text-xs sm:text-sm text-slate-400">
                    No comments yet. Be the first to share your thoughts!
                  </p>
                ) : (
                  <div className="flex flex-col gap-3 max-h-56 overflow-y-auto pr-1">
                    {activeComments.map((c) => (
                      <div key={c.id} className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 font-bold text-xs flex items-center justify-center shrink-0">
                          {c.author.slice(0, 2).toUpperCase()}
                        </div>
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <div className="flex items-center gap-2 text-xs">
                            <span className="font-semibold text-white">{c.author}</span>
                            <span className="text-slate-400">{c.time}</span>
                          </div>
                          <p className="text-sm text-slate-200 break-words">{c.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <form onSubmit={handlePostComment} className="flex items-center gap-2 pt-1">
                  <input
                    type="text"
                    aria-label="Write a comment"
                    placeholder="Add a comment..."
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    className="flex-1 px-3.5 py-2 rounded-xl bg-black/60 border border-white/10 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-white/30"
                  />
                  <button
                    type="submit"
                    aria-label="Post Comment"
                    disabled={!commentDraft.trim()}
                    className="px-3.5 py-2 rounded-xl bg-white text-black font-semibold text-xs sm:text-sm hover:bg-slate-200 disabled:opacity-40 transition-colors flex items-center gap-1.5 shrink-0"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Post</span>
                  </button>
                </form>
              </section>

              {/* 5. Multi-Season Selector & Episodes Grid (Extracts ALL seasons from Zangetsu source) */}
              {(episodesList.length > 1 || selectedItem.type !== 'movie' || isLoadingDetail) && (
                <section aria-label="Episodes" className="flex flex-col gap-4 pt-1">
                  <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar pb-1">
                    {seasonGroups.length > 0 ? (
                      seasonGroups.map((group) => {
                        const isSelected = (activeSeasonGroup?.seasonNumber ?? 1) === group.seasonNumber;
                        return (
                          <button
                            key={group.seasonNumber}
                            type="button"
                            data-testid={`season-tab-${group.seasonNumber}`}
                            onClick={() => {
                              setSelectedSeasonNumber(group.seasonNumber);
                              setEpisodeSearch('');
                            }}
                            className={`px-4 py-1.5 rounded-full text-xs sm:text-sm font-bold whitespace-nowrap shrink-0 transition-colors ${
                              isSelected
                                ? 'bg-white text-black'
                                : 'bg-[#1C1C1E] hover:bg-[#2A2A2D] text-slate-200'
                            }`}
                          >
                            {group.label}
                          </button>
                        );
                      })
                    ) : (
                      <span className="px-4 py-1.5 rounded-full bg-white text-black text-xs sm:text-sm font-bold whitespace-nowrap shrink-0">
                        Season 1
                      </span>
                    )}
                    {isLoadingDetail && <Loader2 className="w-4 h-4 text-white animate-spin shrink-0" />}
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-lg font-bold text-white">Episodes</h2>
                    <div className="flex items-center gap-2">
                      {activeSeasonEpisodes.length > 6 && (
                        <input
                          type="search"
                          aria-label="Filter episodes"
                          placeholder="Episode #"
                          value={episodeSearch}
                          onChange={(e) => setEpisodeSearch(e.target.value)}
                          className="w-28 sm:w-44 px-3 py-1.5 bg-[#161618] border border-white/10 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-white/30"
                        />
                      )}
                      <span className="p-2 rounded-lg bg-[#161618] text-slate-300">
                        <LayoutGrid className="w-4 h-4" />
                      </span>
                    </div>
                  </div>

                  {detailError ? (
                    <div className="p-4 text-xs text-rose-400 bg-[#161618] rounded-xl">
                      {detailError}
                    </div>
                  ) : filteredEpisodes.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                      {filteredEpisodes.map((ep) => {
                        const isCurrent = activeEpisode?.id === ep.id;
                        const epThumb = ep.thumbnail || mediaDetail?.cover || selectedItem.cover;
                        const cleanTitle = formatCleanEpisodeTitle(ep);
                        return (
                          <button
                            key={ep.id}
                            type="button"
                            data-testid={`episode-card-${ep.id}`}
                            onClick={() => {
                              const epSeason = extractEpisodeSeasonNumber(
                                ep,
                                activeSeasonGroup?.seasonNumber || 1
                              );
                              setActiveEpisode(ep);
                              setSelectedSeasonNumber(epSeason);
                              recordContinueWatching(
                                {
                                  ...selectedItem,
                                  title: mediaDetail?.title || selectedItem.title,
                                  cover: mediaDetail?.cover || selectedItem.cover,
                                },
                                ep.number,
                                epSeason,
                                10
                              );
                              resolveEpisodeSources(
                                selectedItem.sourceId || activeSourceId,
                                ep,
                                audioCategory,
                                mediaDetail?.title || selectedItem.title,
                                mediaDetail?.type || selectedItem.type
                              );
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            className={`group relative aspect-video rounded-xl overflow-hidden text-left border transition-all ${
                              isCurrent
                                ? 'border-white ring-1 ring-white'
                                : 'border-white/10 hover:border-white/40'
                            } bg-[#161618]`}
                          >
                            {epThumb && (
                              <img
                                src={epThumb}
                                alt={cleanTitle}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover opacity-55 group-hover:scale-105 transition-transform"
                              />
                            )}
                            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent p-3 flex flex-col justify-end">
                              <span className="text-xs sm:text-sm font-bold text-white">
                                Episode : {ep.number}
                              </span>
                              <span className="text-[11px] text-slate-300 line-clamp-1">
                                {cleanTitle}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              )}

              {/* 6. You May Also Like Recommendations Grid (Matching Reference Screenshot) */}
              {recommendedItems.length > 0 && (
                <section aria-label="You May Also Like" className="flex flex-col gap-3.5 pt-2">
                  <h2 className="text-lg sm:text-xl font-bold text-white">You May Also Like</h2>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 sm:gap-4">
                    {recommendedItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleOpenMedia(item)}
                        className="group text-left flex flex-col gap-1.5 focus:outline-none"
                      >
                        <div className="relative w-full aspect-[2/3] rounded-xl overflow-hidden bg-[#161618] border border-white/10 group-hover:border-white/50 transition-colors">
                          {item.cover ? (
                            <img
                              src={item.cover}
                              alt={item.title}
                              referrerPolicy="no-referrer"
                              loading="lazy"
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-500">
                              <Film className="w-6 h-6" />
                            </div>
                          )}
                          {item.type !== 'anime' && (
                            <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-white text-black text-[10px] font-bold uppercase tracking-wide">
                              MULTI
                            </span>
                          )}
                        </div>
                        <span className="text-xs sm:text-sm font-medium text-slate-200 group-hover:text-white line-clamp-1">
                          {item.title}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>

            {/* Play on TV Inline Cast Modal */}
            {showTvModal && (
              <div
                onClick={() => setShowTvModal(false)}
                className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="w-full max-w-md bg-[#161618] border border-white/15 rounded-2xl p-5 flex flex-col gap-3 text-white"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-bold">Play on TV / External Player</h3>
                    <button
                      type="button"
                      onClick={() => setShowTvModal(false)}
                      className="text-xs text-slate-400 hover:text-white"
                    >
                      Close
                    </button>
                  </div>
                  <p className="text-xs text-slate-300">
                    Copy the direct stream link below to cast to Smart TV / VLC / Web Video Caster:
                  </p>
                  <div className="p-2.5 rounded-lg bg-black/70 border border-white/10 text-[11px] font-mono text-amber-300 break-all max-h-24 overflow-y-auto">
                    {videoSources[activeSourceIndex]?.url || 'No active stream URL resolved yet.'}
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      const url = videoSources[activeSourceIndex]?.url;
                      if (url) {
                        try {
                          await navigator.clipboard.writeText(url);
                          showTimedNotice('Direct stream URL copied for TV player');
                        } catch {}
                      }
                      setShowTvModal(false);
                    }}
                    className="w-full py-2.5 rounded-xl bg-white text-black font-semibold text-xs hover:bg-slate-200 transition-colors"
                  >
                    Copy Stream URL
                  </button>
                </div>
              </div>
            )}

            {/* Report Stream Modal */}
            {showReportModal && (
              <div
                onClick={() => setShowReportModal(false)}
                className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="w-full max-w-md bg-[#161618] border border-white/15 rounded-2xl p-5 flex flex-col gap-3 text-white"
                >
                  <h3 className="text-base font-bold">Report Playback Issue</h3>
                  <p className="text-xs text-slate-300">
                    If this server is broken, buffered, or missing audio, you can submit a report and immediately switch to another backup provider.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-end pt-1">
                    <button
                      type="button"
                      onClick={() => setShowReportModal(false)}
                      className="px-4 py-2 rounded-xl bg-[#242428] text-xs font-medium text-slate-200"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowReportModal(false);
                        showTimedNotice('Issue logged — searching backup Zangetsu provider...');
                        void handleProviderFailover();
                      }}
                      className="px-4 py-2 rounded-xl bg-white text-black text-xs font-semibold"
                    >
                      Report & Switch Provider
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : searchResults !== null ? (
          /* SEARCH RESULTS VIEW (Multi-Provider Movie & Anime Search) */
          <div data-testid="search-results-view" className="max-w-7xl mx-auto px-6 py-8 flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between border-b border-slate-800 pb-4 gap-4">
              <div>
                <h1 className="text-xl font-bold text-white">
                  Search Results for "{searchQuery}"
                </h1>
                <p className="text-xs text-slate-400 mt-0.5">
                  Found {filteredSearchResults.length} real-time matches across Zangetsu providers
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {searchResultProviders.length > 1 && (
                  <div className="flex items-center gap-1.5 mr-2">
                    <button
                      type="button"
                      onClick={() => setSearchProviderFilter('all')}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                        searchProviderFilter === 'all'
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'bg-[#141926] text-slate-300 hover:text-white border border-slate-800'
                      }`}
                    >
                      All ({searchResults.length})
                    </button>
                    {searchResultProviders.map((provId) => (
                      <button
                        key={provId}
                        type="button"
                        onClick={() => setSearchProviderFilter(provId)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium uppercase transition-colors ${
                          searchProviderFilter === provId
                            ? 'bg-amber-500 text-slate-950 font-semibold'
                            : 'bg-[#141926] text-slate-300 hover:text-white border border-slate-800'
                        }`}
                      >
                        {provId} ({searchResults.filter((i) => i.sourceId === provId).length})
                      </button>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setSearchResults(null);
                    setSearchQuery('');
                  }}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-xs font-medium rounded-lg text-slate-200"
                >
                  Clear Search
                </button>
              </div>
            </div>

            {isSearching ? (
              <div className="py-20 flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-8 h-8 text-amber-500 animate-spin" />
                <span className="text-xs text-slate-400">
                  Querying Zangetsu providers for "{searchQuery}"...
                </span>
              </div>
            ) : filteredSearchResults.length === 0 ? (
              <div className="bg-[#11151F] border border-slate-800 rounded-xl p-12 text-center flex flex-col items-center gap-3">
                <p className="text-sm text-slate-300">
                  No titles found matching "{searchQuery}". Try searching across all movies & anime below:
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchScope('all');
                    executeSearch(searchQuery, 'all');
                  }}
                  className="px-4 py-2 bg-amber-500 text-slate-950 font-semibold text-xs rounded-lg hover:bg-amber-400"
                >
                  Search Across All Movie & Anime Providers
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-5">
                {filteredSearchResults.map((item) => (
                  <PosterCard key={item.id} item={item} onSelect={handleOpenMedia} />
                ))}
              </div>
            )}
          </div>
        ) : (
          /* OTT HOMEPAGE: Full-Bleed Live Zangetsu Hero Carousel -> Continue Watching -> Horizontal Poster Rails */
          <div className="flex flex-col gap-6 pb-24 bg-black">
            {/* Hero Banner Carousel (Live Title & Poster from Zangetsu Source) */}
            {isLoadingHome && heroSlides.length === 0 ? (
              <div className="relative w-full h-[62vh] min-h-[450px] max-h-[600px] lg:h-[70vh] lg:max-h-[680px] bg-[#0B0B0D] flex flex-col items-center justify-center gap-3 px-6">
                <Loader2 className="w-9 h-9 text-white animate-spin" />
                <p className="text-xs font-medium text-slate-300">
                  Loading live titles from {activeSourceId.toUpperCase()}...
                </p>
              </div>
            ) : homeError && heroSlides.length === 0 ? (
              <div className="pt-20 px-4 sm:px-8 max-w-2xl mx-auto w-full">
                <div className="bg-[#141416] border border-white/10 rounded-2xl p-8 flex flex-col items-center text-center gap-3">
                  <AlertCircle className="w-8 h-8 text-rose-500" />
                  <p className="text-sm text-slate-200">{homeError}</p>
                  <button
                    type="button"
                    onClick={() => loadHomeCatalog(activeSourceId)}
                    className="px-5 py-2 bg-white text-black font-bold text-xs rounded-lg"
                  >
                    Retry {activeSourceId.toUpperCase()}
                  </button>
                </div>
              </div>
            ) : (
              activeHeroItem && (
                <section
                  aria-label="Featured Spotlight"
                  data-testid="hero-carousel"
                  onTouchStart={(e) => {
                    heroTouchStartXRef.current = e.touches[0]?.clientX ?? null;
                  }}
                  onTouchEnd={(e) => {
                    const startX = heroTouchStartXRef.current;
                    heroTouchStartXRef.current = null;
                    if (startX === null || heroSlides.length <= 1) return;
                    const endX = e.changedTouches[0]?.clientX ?? startX;
                    const dx = endX - startX;
                    if (dx < -40) {
                      setHeroSlideIdx((prev) => (prev + 1) % heroSlides.length);
                    } else if (dx > 40) {
                      setHeroSlideIdx((prev) => (prev - 1 + heroSlides.length) % heroSlides.length);
                    }
                  }}
                  className="relative w-full h-[62vh] min-h-[460px] max-h-[600px] lg:h-[70vh] lg:max-h-[680px] overflow-hidden bg-black"
                >
                  {/* Background Artwork Layer */}
                  {activeHeroItem.cover ? (
                    <>
                      <img
                        src={activeHeroItem.cover}
                        alt=""
                        aria-hidden="true"
                        referrerPolicy="no-referrer"
                        className="hidden lg:block absolute inset-0 w-full h-full object-cover blur-2xl opacity-45 scale-110"
                      />
                      <img
                        src={activeHeroItem.cover}
                        alt={activeHeroItem.title}
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 w-full h-full object-cover object-top lg:object-contain lg:object-right lg:pr-20 transition-opacity duration-300"
                      />
                    </>
                  ) : (
                    <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-black to-black" />
                  )}

                  {/* Measured Contrast Scrims matching Screenshot */}
                  <div className="absolute inset-0 bg-gradient-to-t from-black via-black/45 to-black/25" />
                  <div className="hidden lg:block absolute inset-0 bg-gradient-to-r from-black via-black/75 to-transparent" />

                  {/* Hero Content Overlay */}
                  <div className="relative z-10 h-full max-w-7xl mx-auto px-4 sm:px-8 pb-6 flex flex-col justify-end gap-2.5">
                    {/* Type + Multi + Source Line */}
                    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wider text-slate-200 uppercase">
                      <span>{activeHeroItem.type === 'anime' ? 'ANIME' : 'MOVIE / TV'}</span>
                      {(activeHeroItem.type === 'movie' ||
                        (Boolean(activeHeroItem.subCount) && Boolean(activeHeroItem.dubCount))) && (
                        <span className="px-2 py-0.5 rounded-full bg-white text-black text-[10px] font-extrabold tracking-wide">
                          MULTI
                        </span>
                      )}
                      <span aria-hidden="true" className="text-slate-400">
                        ·
                      </span>
                      <span className="text-slate-200">
                        {activeHeroItem.subCount
                          ? `EP ${activeHeroItem.subCount}${activeHeroItem.dubCount ? ` · DUB ${activeHeroItem.dubCount}` : ''}`
                          : activeHeroItem.sourceId.toUpperCase()}
                      </span>
                    </div>

                    {/* Hero Title (From Live Source) */}
                    <h1
                      className="text-3xl sm:text-5xl font-extrabold text-white tracking-tight font-display leading-[1.1] max-w-xl line-clamp-2"
                      style={{ textWrap: 'balance' }}
                    >
                      {activeHeroItem.title}
                    </h1>

                    {/* Year / Rating (Only Real Metadata) */}
                    <div className="flex items-center gap-2 text-sm text-slate-200 font-medium">
                      {activeHeroItem.year && (
                        <span className="font-mono tabular-nums">{activeHeroItem.year}</span>
                      )}
                      {activeHeroItem.year && activeHeroItem.rating && (
                        <span aria-hidden="true" className="text-slate-400">
                          ·
                        </span>
                      )}
                      {activeHeroItem.rating && (
                        <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                          <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                          <span>{activeHeroItem.rating}</span>
                        </span>
                      )}
                    </div>

                    {/* Bottom Action Row + Slide Counter (01 ─── 19) */}
                    <div className="flex items-end justify-between gap-4 pt-1.5">
                      <div className="flex items-center gap-5">
                        <button
                          type="button"
                          data-testid="hero-play-btn"
                          onClick={() => handleOpenMedia(activeHeroItem)}
                          className="px-7 py-3 rounded-lg bg-white hover:bg-slate-200 text-black font-bold text-sm sm:text-base flex items-center gap-2.5 transition-colors shadow-lg whitespace-nowrap shrink-0"
                        >
                          <Play className="w-4 h-4 fill-current" />
                          <span>Play</span>
                        </button>

                        {(() => {
                          const heroKey = `${activeHeroItem.sourceId || activeSourceId}:${activeHeroItem.id}`;
                          const isSaved = watchlistIds.includes(heroKey);
                          return (
                            <button
                              type="button"
                              data-testid="hero-mylist-btn"
                              onClick={() => toggleItemWatchlist(activeHeroItem)}
                              className="flex flex-col items-center justify-center gap-1 text-white hover:text-slate-200 transition-colors min-w-[48px] min-h-[44px]"
                            >
                              {isSaved ? (
                                <Check className="w-5 h-5" />
                              ) : (
                                <Bookmark className="w-5 h-5" />
                              )}
                              <span className="text-[11px] font-medium whitespace-nowrap">
                                {isSaved ? 'In List' : 'My List'}
                              </span>
                            </button>
                          );
                        })()}
                      </div>

                      {/* Slide Progress Counter matching 01 ─── 19 */}
                      {heroSlides.length > 1 && (
                        <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-slate-200 shrink-0 pb-1">
                          <button
                            type="button"
                            aria-label="Previous featured title"
                            onClick={() =>
                              setHeroSlideIdx((prev) => (prev - 1 + heroSlides.length) % heroSlides.length)
                            }
                            className="p-1 text-slate-300 hover:text-white transition-colors"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <span className="text-white font-semibold">
                            {String(safeHeroIdx + 1).padStart(2, '0')}
                          </span>
                          <div className="w-10 sm:w-16 h-[2px] bg-white/25 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-white transition-all duration-300"
                              style={{ width: `${((safeHeroIdx + 1) / heroSlides.length) * 100}%` }}
                            />
                          </div>
                          <span className="text-slate-400">
                            {String(heroSlides.length).padStart(2, '0')}
                          </span>
                          <button
                            type="button"
                            aria-label="Next featured title"
                            onClick={() => setHeroSlideIdx((prev) => (prev + 1) % heroSlides.length)}
                            className="p-1 text-slate-300 hover:text-white transition-colors"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )
            )}

            {/* Continue Watching Horizontal Rail (Persisted Watch History) */}
            {continueWatching.length > 0 && (
              <section
                aria-label="Continue Watching"
                data-testid="continue-watching-rail"
                className="flex flex-col gap-3"
              >
                <div className="max-w-7xl mx-auto w-full px-4 sm:px-8 flex items-center justify-between">
                  <h2 className="text-lg sm:text-xl font-bold text-white font-display tracking-tight">
                    Continue Watching
                  </h2>
                </div>
                <div className="max-w-7xl mx-auto w-full overflow-x-auto no-scrollbar px-4 sm:px-8 flex gap-3 sm:gap-4">
                  {continueWatching.map((entry) => (
                    <button
                      key={`cw-${entry.item.sourceId}:${entry.item.id}`}
                      type="button"
                      onClick={() => handleOpenMedia(entry.item)}
                      className="group relative w-[30.5vw] min-w-[106px] max-w-[162px] sm:w-[160px] md:w-[176px] aspect-[2/3] rounded-xl overflow-hidden bg-[#141416] shrink-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      {entry.item.cover ? (
                        <img
                          src={entry.item.cover}
                          alt={entry.item.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full p-3 flex flex-col items-center justify-center text-center bg-gradient-to-br from-slate-900 to-black gap-2">
                          <Film className="w-6 h-6 text-slate-400" />
                          <span className="text-xs font-semibold text-slate-200 line-clamp-2">
                            {entry.item.title}
                          </span>
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25">
                        <div
                          className="h-full bg-white"
                          style={{ width: `${Math.max(8, entry.progressPct)}%` }}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Live Zangetsu Horizontal Catalog Shelves */}
            <div className="flex flex-col gap-7">
              {displayedRows.map((row, rIdx) => (
                <section key={`${row.title}-${rIdx}`} className="flex flex-col gap-3">
                  <div className="max-w-7xl mx-auto w-full px-4 sm:px-8 flex items-center justify-between">
                    <h2 className="text-lg sm:text-xl font-bold text-white font-display tracking-tight">
                      {row.title}
                    </h2>
                  </div>

                  <div className="max-w-7xl mx-auto w-full overflow-x-auto no-scrollbar px-4 sm:px-8 flex gap-3 sm:gap-4">
                    {row.items.map((item) => (
                      <div
                        key={item.id}
                        className="w-[30.5vw] min-w-[106px] max-w-[162px] sm:w-[160px] md:w-[176px] shrink-0"
                      >
                        <PosterCard item={item} onSelect={handleOpenMedia} compact />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Fixed Bottom Tab Navigation Bar (Matching Reference Screenshot, hidden inside Watch View) */}
      {!isWatchView && (
        <nav
          aria-label="Primary Bottom Navigation"
          data-testid="bottom-nav"
          className="fixed bottom-0 inset-x-0 z-40 h-16 bg-black/95 backdrop-blur-md border-t border-white/10"
        >
          <div className="grid grid-cols-4 h-full max-w-2xl mx-auto">
            <button
              type="button"
              data-testid="nav-movies-btn"
              onClick={() => handleNavClick('movies')}
              className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                activeNav === 'movies' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <Clapperboard className="w-5 h-5" />
              <span className="text-[10px] font-medium tracking-tight">Movie/Tv</span>
            </button>

            <button
              type="button"
              data-testid="nav-anime-btn"
              onClick={() => handleNavClick('anime')}
              className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                activeNav === 'anime' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <Tv className="w-5 h-5" />
              <span className="text-[10px] font-medium tracking-tight">Anime</span>
            </button>

            <button
              type="button"
              data-testid="nav-downloads-btn"
              onClick={() => handleNavClick('downloads')}
              className={`relative flex flex-col items-center justify-center gap-1 transition-colors ${
                activeNav === 'downloads' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <div className="relative">
                <Download className="w-5 h-5" />
                {offlineRecords.some((r) => r.status === 'downloading') && (
                  <span className="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-white animate-pulse" />
                )}
              </div>
              <span className="text-[10px] font-medium tracking-tight">Downloads</span>
            </button>

            <button
              type="button"
              data-testid="nav-settings-btn"
              onClick={() => handleNavClick('settings')}
              className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                activeNav === 'settings' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              <Settings className="w-5 h-5" />
              <span className="text-[10px] font-medium tracking-tight">Settings</span>
            </button>
          </div>
        </nav>
      )}

      {/* Zangetsu JS Extension Inspector Modal */}
      <ExtensionInspectorModal
        isOpen={isInspectorOpen}
        onClose={() => setIsInspectorOpen(false)}
        providers={providers}
        activeSourceId={activeSourceId}
        onSelectProvider={(id) => {
          setActiveSourceId(id);
          setSelectedItem(null);
          setActiveNav(isAnimeSourceId(id) ? 'anime' : 'movies');
        }}
      />
    </div>
  );
}

interface PosterCardProps {
  item: ZangetsuCatalogItem;
  onSelect: (item: ZangetsuCatalogItem) => void;
  compact?: boolean;
}

const PosterCard: React.FC<PosterCardProps> = ({ item, onSelect, compact = false }) => {
  const [imgErr, setImgErr] = useState(false);

  return (
    <button
      type="button"
      data-testid="catalog-card"
      onClick={() => onSelect(item)}
      className="group w-full text-left flex flex-col gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-white rounded-xl"
    >
      <div className="relative w-full aspect-[2/3] rounded-xl overflow-hidden bg-[#141416] border border-white/10 group-hover:border-white/40 transition-colors">
        {item.cover && !imgErr ? (
          <img
            src={item.cover}
            alt={item.title}
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => setImgErr(true)}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full p-4 flex flex-col items-center justify-center text-center bg-gradient-to-br from-slate-900 to-black gap-2">
            <Film className="w-7 h-7 text-slate-400" />
            <span className="text-xs font-semibold text-slate-300 line-clamp-3">{item.title}</span>
          </div>
        )}

        {/* Hover Play Overlay */}
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center">
          <div className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center shadow-lg">
            <Play className="w-4 h-4 fill-current ml-0.5" />
          </div>
        </div>
      </div>

      {/* Unboxed Metadata & Title */}
      <div className="flex flex-col gap-0.5 px-0.5">
        {!compact && (
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <span className="uppercase text-slate-300 font-medium">{item.sourceId}</span>
            {item.subCount ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">SUB {item.subCount}</span>
              </>
            ) : null}
            {item.dubCount ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">DUB {item.dubCount}</span>
              </>
            ) : null}
          </div>
        )}
        <h3 className="text-xs sm:text-sm font-medium text-slate-200 group-hover:text-white transition-colors line-clamp-1 leading-snug">
          {item.title}
        </h3>
      </div>
    </button>
  );
};
