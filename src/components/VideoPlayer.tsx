import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import Hls from 'hls.js';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Settings,
  Lock,
  Unlock,
  Music,
  Plus,
  Minus,
  Check,
  Loader2,
  AlertCircle,
  RefreshCw,
  Download,
  Upload,
  FastForward,
  Rewind,
  Sun,
  Volume2,
  VolumeX,
  Film,
  Server,
  Languages,
  X,
  FolderDown,
} from 'lucide-react';
import type {
  ZangetsuVideoSource,
  ProbedMediaMetadata,
  ZangetsuEpisode,
  ZangetsuCatalogItem,
} from '../types';
import {
  buildSupportedDownloadLanguages,
  buildSupportedDownloadQualitiesForServer,
  groupDownloadServers,
  type HlsLevelInfo,
  type HlsAudioTrackInfo,
  type SupportedDownloadQuality,
} from '../utils/downloads';

export interface VideoPlayerProps {
  title: string;
  episode: ZangetsuEpisode | null;
  poster?: string | null;
  sources: ZangetsuVideoSource[];
  activeSourceIndex: number;
  onSelectSource: (index: number) => void;
  audioCategory: 'sub' | 'dub';
  onChangeAudioCategory: (cat: 'sub' | 'dub') => void;
  hasSubDubToggle: boolean;
  onTriggerOfflineSave: (
    source: ZangetsuVideoSource,
    audioIndex: number,
    audioLabel: string,
    quality?: SupportedDownloadQuality,
    probedMeta?: ProbedMediaMetadata | null
  ) => void;
  onViewDownloads?: () => void;
  onNextEpisode?: () => void;
  hasNextEpisode?: boolean;
  onPreviousEpisode?: () => void;
  hasPreviousEpisode?: boolean;
  onBack?: () => void;
  recommendations?: ZangetsuCatalogItem[];
  onSelectRecommendation?: (item: ZangetsuCatalogItem) => void;
  offlineBlobUrl?: string | null;
  autoSwitchEnabled?: boolean;
  onToggleAutoSwitch?: () => void;
  onRequestProviderFailover?: () => void;
  isFailoverLoading?: boolean;
  failoverNotice?: string | null;
  currentProviderId?: string;
  hideServerBar?: boolean;
  openDownloadSignal?: number;
  isSeries?: boolean;
  seasonNumber?: number;
  onPlaybackProgress?: (currentTime: number, duration: number) => void;
}

interface ParsedCue {
  start: number;
  end: number;
  text: string;
}

interface CustomExternalSubtitle {
  label: string;
  lang: string;
  vttText: string;
}

type ActivePanel = 'none' | 'settings' | 'subtitles' | 'recommendations' | 'download';
type SettingsSubMenu = 'main' | 'speed' | 'quality' | 'audio';
type VideoFitMode = 'contain' | 'cover' | 'zoom' | 'stretch';

const SUPPORTED_SPEEDS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function parseTimestampToSeconds(ts: string): number {
  const clean = ts.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(clean) || 0;
}

function parseSubtitleTextToCues(rawText: string): ParsedCue[] {
  const normalized = rawText.replace(/\r\n/g, '\n');
  const cues: ParsedCue[] = [];

  if (/\[Events\]/i.test(normalized)) {
    const lines = normalized.split('\n');
    for (const line of lines) {
      if (line.startsWith('Dialogue:')) {
        const parts = line.slice(9).split(',');
        if (parts.length >= 10) {
          const start = parseTimestampToSeconds(parts[1]);
          const end = parseTimestampToSeconds(parts[2]);
          const text = parts
            .slice(9)
            .join(',')
            .replace(/\{[^}]*\}/g, '')
            .replace(/\\N/gi, '\n')
            .trim();
          if (text && end > start) {
            cues.push({ start, end, text });
          }
        }
      }
    }
    return cues;
  }

  const blocks = normalized.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx !== -1) {
      const timeLine = lines[timeLineIdx];
      const [startStr, endPart] = timeLine.split('-->');
      const endStr = (endPart || '').trim().split(/\s+/)[0];
      const start = parseTimestampToSeconds(startStr);
      const end = parseTimestampToSeconds(endStr);
      const text = lines
        .slice(timeLineIdx + 1)
        .join('\n')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (text && end >= start) {
        cues.push({ start, end, text });
      }
    }
  }
  return cues;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  title,
  episode,
  poster = null,
  sources,
  activeSourceIndex,
  onSelectSource,
  audioCategory,
  onChangeAudioCategory,
  hasSubDubToggle,
  onTriggerOfflineSave,
  onViewDownloads,
  onNextEpisode,
  hasNextEpisode,
  onPreviousEpisode,
  hasPreviousEpisode,
  onBack,
  recommendations = [],
  onSelectRecommendation,
  offlineBlobUrl,
  autoSwitchEnabled = true,
  onToggleAutoSwitch,
  onRequestProviderFailover,
  isFailoverLoading = false,
  failoverNotice = null,
  currentProviderId,
  hideServerBar = false,
  openDownloadSignal = 0,
  isSeries = false,
  seasonNumber = 1,
  onPlaybackProgress,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'right' | 'center' }>({
    time: 0,
    side: 'center',
  });
  const pendingResumeTimeRef = useRef<number | null>(null);
  const hoverRevealedAtRef = useRef<number>(0);

  const activeSource = sources[activeSourceIndex] || null;
  const storageKey = useMemo(
    () => `zx_stream_pos_${title}_${episode?.id || episode?.number || 'movie'}`,
    [title, episode]
  );

  // Playback Core State
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [autoSwitchStatus, setAutoSwitchStatus] = useState<string | null>(null);

  // Timeline & Remux Seek Offset
  const [seekOffset, setSeekOffset] = useState(0);
  const [rawCurrentTime, setRawCurrentTime] = useState(0);
  const [rawDuration, setRawDuration] = useState(0);

  // Probed MKV / Direct Container Metadata
  const [probedState, setProbedState] = useState<{ url: string; meta: ProbedMediaMetadata | null } | null>(
    null
  );
  const [isProbing, setIsProbing] = useState(false);
  const [selectedAudioTrackIndex, setSelectedAudioTrackIndex] = useState(0);
  const [forceTranscode, setForceTranscode] = useState(false);

  // HLS Adaptive Variants & Audio/Subtitle Tracks
  const [hlsLevels, setHlsLevels] = useState<HlsLevelInfo[]>([]);
  const [selectedHlsLevel, setSelectedHlsLevel] = useState<number>(-1);
  const [hlsAudioTracks, setHlsAudioTracks] = useState<HlsAudioTrackInfo[]>([]);
  const [selectedHlsAudioTrack, setSelectedHlsAudioTrack] = useState<number>(0);

  // UI & Overlay Panels State
  const [showControls, setShowControls] = useState(true);
  const [isScreenLocked, setIsScreenLocked] = useState(false);
  const [showLockHint, setShowLockHint] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isHorizontalFullscreen, setIsHorizontalFullscreen] = useState(false);
  const [viewportSize, setViewportSize] = useState<{ w: number; h: number }>(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 720,
  }));
  const [isPipActive, setIsPipActive] = useState(false);
  const [pipNotice, setPipNotice] = useState<string | null>(null);

  const [activePanel, setActivePanel] = useState<ActivePanel>('none');
  const [settingsSubMenu, setSettingsSubMenu] = useState<SettingsSubMenu>('main');

  // Speed, Volume, Brightness, Fit/Zoom
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isLongPressSpeed, setIsLongPressSpeed] = useState<boolean>(false);
  const [preBoostSpeed, setPreBoostSpeed] = useState<number>(1.0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [brightness, setBrightness] = useState<number>(100);
  const [fitMode, setFitMode] = useState<VideoFitMode>('contain');
  const [pinchScale, setPinchScale] = useState<number>(1);
  const [fitModeBadge, setFitModeBadge] = useState<string | null>(null);

  // Subtitles & Appearance State
  const [selectedSubTrack, setSelectedSubTrack] = useState<number>(-1);
  const [subtitleDelay, setSubtitleDelay] = useState<number>(0.0);
  const [showSubAppearance, setShowSubAppearance] = useState<boolean>(false);
  const [subFontSize, setSubFontSize] = useState<'sm' | 'md' | 'lg' | 'xl'>('md');
  const [subFontColor, setSubFontColor] = useState<string>('#FFFFFF');
  const [subBgOpacity, setSubBgOpacity] = useState<number>(0.65);
  const [subPosition, setSubPosition] = useState<'bottom' | 'middle' | 'top'>('bottom');
  const [subTextStyle, setSubTextStyle] = useState<'shadow' | 'outline' | 'bold'>('shadow');
  const [customSubtitles, setCustomSubtitles] = useState<CustomExternalSubtitle[]>([]);
  const [parsedCues, setParsedCues] = useState<ParsedCue[]>([]);

  // Touch & Gesture Feedback Overlays
  const [seekFeedback, setSeekFeedback] = useState<{ side: 'left' | 'right'; seconds: number } | null>(null);
  const [gestureHud, setGestureHud] = useState<{ type: 'brightness' | 'volume' | 'seek'; text: string } | null>(
    null
  );
  const touchStateRef = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    mode: 'none' | 'seek' | 'brightness' | 'volume' | 'pinch';
    initialTime: number;
    initialVolume: number;
    initialBrightness: number;
    initialPinchDist: number;
    initialPinchScale: number;
    targetTime: number;
    moved: boolean;
  }>({
    startX: 0,
    startY: 0,
    startTime: 0,
    mode: 'none',
    initialTime: 0,
    initialVolume: 1,
    initialBrightness: 100,
    initialPinchDist: 0,
    initialPinchScale: 1,
    targetTime: 0,
    moved: false,
  });

  // Real-Time Download Customizer State + Per-Server Inspection Cache
  const [downloadSourceIndex, setDownloadSourceIndex] = useState<number>(0);
  const [downloadAudioIndex, setDownloadAudioIndex] = useState<number>(0);
  const [downloadStartedNotice, setDownloadStartedNotice] = useState<string | null>(null);
  const [isInspectingDownloadServer, setIsInspectingDownloadServer] = useState<boolean>(false);
  const [downloadServerMetaMap, setDownloadServerMetaMap] = useState<
    Record<
      string,
      {
        probedMeta: ProbedMediaMetadata | null;
        hlsLevels: HlsLevelInfo[];
        hlsAudioTracks: HlsAudioTrackInfo[];
      }
    >
  >({});

  useEffect(() => {
    setDownloadSourceIndex(activeSourceIndex);
  }, [activeSourceIndex]);

  useEffect(() => {
    setDownloadAudioIndex(selectedAudioTrackIndex);
  }, [selectedAudioTrackIndex]);

  const activeSourceUrl = activeSource?.url || '';
  const activeSourceContainer = activeSource?.container || '';
  const activeSourceHeadersKey = useMemo(
    () => (activeSource?.headers ? JSON.stringify(activeSource.headers) : ''),
    [activeSource?.headers]
  );
  const probedMeta = probedState?.url === activeSourceUrl ? probedState.meta : null;

  const effectiveCurrentTime = seekOffset + rawCurrentTime;
  const effectiveDuration =
    probedMeta && probedMeta.duration > 0
      ? probedMeta.duration
      : rawDuration > 0 && isFinite(rawDuration)
        ? seekOffset + rawDuration
        : 0;

  // Save & Restore Playback Position
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseFloat(saved);
        if (isFinite(parsed) && parsed > 5) {
          pendingResumeTimeRef.current = parsed;
        }
      }
    } catch {
      // ignore storage errors
    }
  }, [storageKey]);

  useEffect(() => {
    if (effectiveCurrentTime > 5 && effectiveDuration > 0 && effectiveCurrentTime < effectiveDuration - 10) {
      try {
        localStorage.setItem(storageKey, String(Math.floor(effectiveCurrentTime)));
      } catch {
        // ignore
      }
      if (onPlaybackProgress) {
        onPlaybackProgress(effectiveCurrentTime, effectiveDuration);
      }
    }
  }, [Math.floor(effectiveCurrentTime / 5), effectiveDuration, storageKey, onPlaybackProgress]);

  // Auto-hide Controls after Inactivity (Only hide while actively playing and not buffering)
  const resetControlsTimer = useCallback(() => {
    setShowControls((prev) => {
      if (!prev) hoverRevealedAtRef.current = Date.now();
      return true;
    });
    if (hideControlsTimerRef.current) {
      window.clearTimeout(hideControlsTimerRef.current);
    }
    if (isPlaying && !isBuffering && activePanel === 'none' && !isScreenLocked) {
      hideControlsTimerRef.current = window.setTimeout(() => {
        setShowControls(false);
      }, 3800);
    }
  }, [isPlaying, isBuffering, activePanel, isScreenLocked]);

  useEffect(() => {
    resetControlsTimer();
    return () => {
      if (hideControlsTimerRef.current) {
        window.clearTimeout(hideControlsTimerRef.current);
      }
    };
  }, [isPlaying, isBuffering, activePanel, isScreenLocked, resetControlsTimer]);

  const isUnloadingRef = useRef<boolean>(false);
  const effectiveCurrentTimeRef = useRef<number>(effectiveCurrentTime);
  effectiveCurrentTimeRef.current = effectiveCurrentTime;
  const playbackSpeedRef = useRef<number>(playbackSpeed);
  playbackSpeedRef.current = playbackSpeed;

  // Automatic Playback Failover (stable callback via ref so stream useEffect never re-runs on timeupdate)
  const triggerPlaybackFailover = useCallback(
    (reason: string) => {
      if (!autoSwitchEnabled) {
        setErrorMsg(reason);
        setIsBuffering(false);
        return;
      }

      if (activeSourceIndex + 1 < sources.length) {
        const nextIdx = activeSourceIndex + 1;
        const nextServerName = sources[nextIdx]?.server || `Server #${nextIdx + 1}`;
        setAutoSwitchStatus(`Playback issue detected — Auto-switching to ${nextServerName}...`);
        setErrorMsg(null);
        pendingResumeTimeRef.current =
          effectiveCurrentTimeRef.current > 2 ? effectiveCurrentTimeRef.current : null;
        window.setTimeout(() => {
          onSelectSource(nextIdx);
          setAutoSwitchStatus(null);
        }, 450);
      } else if (onRequestProviderFailover && !isFailoverLoading) {
        setAutoSwitchStatus('All servers on current provider failed — Auto-switching Zangetsu provider...');
        setErrorMsg(null);
        onRequestProviderFailover();
      } else {
        setErrorMsg(reason);
        setIsBuffering(false);
      }
    },
    [
      autoSwitchEnabled,
      activeSourceIndex,
      sources,
      onSelectSource,
      onRequestProviderFailover,
      isFailoverLoading,
    ]
  );

  const triggerFailoverRef = useRef(triggerPlaybackFailover);
  triggerFailoverRef.current = triggerPlaybackFailover;

  // Probe stream when active source is non-HLS (e.g., MKV, MP4, AVI, TS, WebM, MOV)
  useEffect(() => {
    setSeekOffset(0);
    setRawCurrentTime(0);
    setRawDuration(0);

    if (!activeSourceUrl || offlineBlobUrl) {
      setProbedState(null);
      setIsProbing(false);
      return;
    }
    const isHls = activeSourceContainer === 'hls' || activeSourceUrl.includes('.m3u8');
    if (isHls) {
      setProbedState(null);
      setIsProbing(false);
      return;
    }

    let cancelled = false;
    setIsProbing(true);
    setSelectedAudioTrackIndex(0);
    setForceTranscode(false);

    const headersParam = activeSourceHeadersKey ? encodeURIComponent(activeSourceHeadersKey) : '';
    fetch(`/api/stream/probe?url=${encodeURIComponent(activeSourceUrl)}&headers=${headersParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((meta: ProbedMediaMetadata | null) => {
        if (cancelled) return;
        setProbedState({ url: activeSourceUrl, meta });
        if (
          meta &&
          ['hevc', 'h265', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'wmv3', 'flv1', 'xvid', 'divx'].includes(
            meta.videoCodec
          )
        ) {
          setForceTranscode(true);
        }
        setIsProbing(false);
      })
      .catch(() => {
        if (cancelled) return;
        setProbedState({ url: activeSourceUrl, meta: null });
        setIsProbing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSourceUrl, activeSourceContainer, activeSourceHeadersKey, offlineBlobUrl]);

  // Attach Stream to Video Element (Universal Engine: HLS.js + FFmpeg Remux + Native Direct)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    isUnloadingRef.current = false;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    setErrorMsg(null);
    setIsBuffering(true);
    setHlsLevels([]);
    setSelectedHlsLevel(-1);
    setHlsAudioTracks([]);
    setSelectedHlsAudioTrack(0);

    if (offlineBlobUrl) {
      video.src = offlineBlobUrl;
      video.load();
      video.play().catch(() => {});
      return () => {
        cancelled = true;
        isUnloadingRef.current = true;
      };
    }

    if (!activeSourceUrl) {
      setIsBuffering(false);
      return () => {
        cancelled = true;
      };
    }

    const isHls = activeSourceContainer === 'hls' || activeSourceUrl.includes('.m3u8');
    const headersParam = activeSourceHeadersKey ? encodeURIComponent(activeSourceHeadersKey) : '';

    if (isHls) {
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(activeSourceUrl)}&headers=${headersParam}`;
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
        });
        hlsRef.current = hls;
        let networkRetryCount = 0;
        hls.loadSource(proxyUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          if (cancelled) return;
          const levels: HlsLevelInfo[] = data.levels
            .map((lvl, idx) => ({
              index: idx,
              height: lvl.height || 0,
              bitrate: lvl.bitrate || 0,
              variantUrl: Array.isArray(lvl.url) ? lvl.url[0] : typeof lvl.url === 'string' ? lvl.url : undefined,
            }))
            .filter((lvl) => lvl.height > 0);
          setHlsLevels(levels);

          if (hls.audioTracks && hls.audioTracks.length > 0) {
            setHlsAudioTracks(
              hls.audioTracks.map((t, idx) => ({
                index: idx,
                name: t.name || t.lang || `Track ${idx + 1}`,
                lang: t.lang || '',
              }))
            );
            setSelectedHlsAudioTrack(hls.audioTrack >= 0 ? hls.audioTrack : 0);
          }

          setIsBuffering(false);
          setAutoSwitchStatus(null);
          if (pendingResumeTimeRef.current && pendingResumeTimeRef.current > 2) {
            video.currentTime = pendingResumeTimeRef.current;
            pendingResumeTimeRef.current = null;
          }
          video.playbackRate = playbackSpeedRef.current;
          video.play().catch(() => {});
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
          if (cancelled) return;
          if (data.audioTracks && data.audioTracks.length > 0) {
            setHlsAudioTracks(
              data.audioTracks.map((t, idx) => ({
                index: idx,
                name: t.name || t.lang || `Track ${idx + 1}`,
                lang: t.lang || '',
              }))
            );
          }
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled) return;
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetryCount < 1) {
              networkRetryCount += 1;
              hls.startLoad();
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && networkRetryCount < 1) {
              networkRetryCount += 1;
              hls.recoverMediaError();
            } else {
              hls.destroy();
              triggerFailoverRef.current('Stream playback interrupted on current server.');
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = proxyUrl;
        video.addEventListener('loadedmetadata', () => {
          if (cancelled) return;
          setIsBuffering(false);
          video.play().catch(() => {});
        });
      }
      return () => {
        cancelled = true;
        isUnloadingRef.current = true;
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
      };
    }

    // Wait for FFprobe on direct containers (MKV, MP4, AVI, MOV, FLV, WMV, TS, WebM)
    if (isProbing || probedState?.url !== activeSourceUrl) return;

    const useRemux =
      probedMeta?.needsRemux ||
      selectedAudioTrackIndex > 0 ||
      seekOffset > 0 ||
      forceTranscode ||
      /\.(mkv|avi|flv|wmv|ts|m2ts|mov|mpd)(\?|$)/i.test(activeSourceUrl);

    if (pendingResumeTimeRef.current && pendingResumeTimeRef.current > 2 && useRemux && seekOffset === 0) {
      const targetResume = pendingResumeTimeRef.current;
      pendingResumeTimeRef.current = null;
      setSeekOffset(targetResume);
      return;
    }

    const streamUrl = useRemux
      ? `/api/stream/remux?url=${encodeURIComponent(activeSourceUrl)}&headers=${headersParam}&audioIndex=${selectedAudioTrackIndex}&start=${Math.floor(seekOffset)}&transcodeVideo=${forceTranscode ? '1' : '0'}`
      : `/api/proxy?url=${encodeURIComponent(activeSourceUrl)}&headers=${headersParam}`;

    video.src = streamUrl;
    video.load();
    video.playbackRate = playbackSpeedRef.current;
    video.play().catch(() => {});

    return () => {
      cancelled = true;
      isUnloadingRef.current = true;
    };
  }, [
    activeSourceUrl,
    activeSourceContainer,
    activeSourceHeadersKey,
    offlineBlobUrl,
    isProbing,
    probedState,
    probedMeta,
    selectedAudioTrackIndex,
    seekOffset,
    forceTranscode,
  ]);

  // Build Unified Actual Subtitle Track List (Never fake tracks)
  const availableSubtitleTracks = useMemo(() => {
    const list: {
      id: string;
      index: number;
      label: string;
      lang: string;
      kind: 'external' | 'embedded' | 'custom';
      url?: string;
      embIndex?: number;
      vttText?: string;
    }[] = [];

    const extSubs = activeSource?.subtitles || [];
    extSubs.forEach((s, idx) => {
      list.push({
        id: `ext-${idx}`,
        index: list.length,
        label: s.label || s.lang || `Subtitle ${idx + 1}`,
        lang: s.lang || 'en',
        kind: 'external',
        url: s.url,
      });
    });

    const embSubs = probedMeta?.subtitleTracks || [];
    embSubs.forEach((s) => {
      list.push({
        id: `emb-${s.index}`,
        index: list.length,
        label: s.title || s.language || `Embedded Track ${s.index + 1}`,
        lang: s.language || 'en',
        kind: 'embedded',
        embIndex: s.index,
      });
    });

    customSubtitles.forEach((c, idx) => {
      list.push({
        id: `cust-${idx}`,
        index: list.length,
        label: `${c.label} (Local)`,
        lang: c.lang,
        kind: 'custom',
        vttText: c.vttText,
      });
    });

    return list;
  }, [activeSource, probedMeta, customSubtitles]);

  // Load and Parse Active Subtitle Track Cues for Accurate Delay & Styling
  useEffect(() => {
    if (selectedSubTrack < 0 || selectedSubTrack >= availableSubtitleTracks.length) {
      setParsedCues([]);
      return;
    }

    const track = availableSubtitleTracks[selectedSubTrack];
    if (!track) {
      setParsedCues([]);
      return;
    }

    if (track.kind === 'custom' && track.vttText) {
      setParsedCues(parseSubtitleTextToCues(track.vttText));
      return;
    }

    let cancelled = false;
    const headersParam = activeSource?.headers ? encodeURIComponent(JSON.stringify(activeSource.headers)) : '';
    const subFetchUrl =
      track.kind === 'external' && track.url
        ? `/api/stream/subtitle.vtt?url=${encodeURIComponent(track.url)}&headers=${headersParam}`
        : track.kind === 'embedded' && activeSource
          ? `/api/stream/EmbeddedSub.vtt?url=${encodeURIComponent(activeSource.url)}&headers=${headersParam}&subIndex=${track.embIndex || 0}&start=0`
          : null;

    if (!subFetchUrl) {
      setParsedCues([]);
      return;
    }

    fetch(subFetchUrl)
      .then((r) => (r.ok ? r.text() : ''))
      .then((txt) => {
        if (!cancelled && txt) {
          setParsedCues(parseSubtitleTextToCues(txt));
        }
      })
      .catch(() => {
        if (!cancelled) setParsedCues([]);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSubTrack, availableSubtitleTracks, activeSource]);

  // Active Subtitle Cues at Current Timestamp (with Subtitle Synchronization Delay applied)
  const activeCueText = useMemo(() => {
    if (selectedSubTrack < 0 || parsedCues.length === 0) return null;
    const adjustedTime = effectiveCurrentTime - subtitleDelay;
    const matching = parsedCues.filter((c) => adjustedTime >= c.start && adjustedTime <= c.end);
    if (matching.length === 0) return null;
    return matching.map((m) => m.text).join('\n');
  }, [selectedSubTrack, parsedCues, effectiveCurrentTime, subtitleDelay]);

  // Build Actual Available Qualities (Never invent fake resolutions)
  const actualQualityOptions = useMemo(() => {
    if (hlsLevels.length > 0) {
      const uniqueHeights = new Map<number, { index: number; height: number; bitrate: number }>();
      hlsLevels.forEach((lvl) => {
        if (lvl.height > 0 && !uniqueHeights.has(lvl.height)) {
          uniqueHeights.set(lvl.height, lvl);
        }
      });
      return Array.from(uniqueHeights.values())
        .sort((a, b) => b.height - a.height)
        .map((lvl) => ({
          id: `hls-${lvl.index}`,
          label: `${lvl.height}p`,
          subLabel: lvl.bitrate ? `${Math.round(lvl.bitrate / 1000)} kbps` : 'Adaptive HLS',
          type: 'hls' as const,
          hlsIndex: lvl.index,
          sourceIndex: activeSourceIndex,
        }));
    }

    // Check distinct real resolutions across resolved Zangetsu sources
    const resolutionSources: {
      id: string;
      label: string;
      subLabel: string;
      type: 'source';
      hlsIndex: number;
      sourceIndex: number;
    }[] = [];
    const seenRes = new Set<string>();

    sources.forEach((src, idx) => {
      const match = (src.quality || src.label || '').match(/\b(360p|480p|720p|1080p|1440p|2160p|4k)\b/i);
      if (match) {
        const norm = match[1].toLowerCase() === '4k' ? '2160p' : match[1].toLowerCase();
        const key = `${norm}-${src.server || idx}`;
        if (!seenRes.has(key)) {
          seenRes.add(key);
          resolutionSources.push({
            id: `src-${idx}`,
            label: norm,
            subLabel: `${src.server || 'Direct'}${src.size ? ` · ${src.size}` : ''}`,
            type: 'source',
            hlsIndex: -1,
            sourceIndex: idx,
          });
        }
      }
    });

    if (resolutionSources.length === 0 && probedMeta?.height) {
      return [
        {
          id: `probed-${activeSourceIndex}`,
          label: `${probedMeta.height}p`,
          subLabel: 'Direct Stream Resolution',
          type: 'source' as const,
          hlsIndex: -1,
          sourceIndex: activeSourceIndex,
        },
      ];
    }

    return resolutionSources;
  }, [hlsLevels, sources, activeSourceIndex, probedMeta]);

  // Build Actual Detected Audio Tracks (Never hardcode fake languages)
  const actualAudioTracks = useMemo(() => {
    if (probedMeta && probedMeta.audioTracks.length > 0) {
      return probedMeta.audioTracks.map((t) => ({
        index: t.index,
        label: t.language,
        detail: `${t.codec} · ${t.channelLayout.toUpperCase()} (${t.bitrate})`,
        kind: 'probed' as const,
      }));
    }

    if (hlsAudioTracks.length > 0) {
      return hlsAudioTracks.map((t) => ({
        index: t.index,
        label: t.name,
        detail: t.lang ? t.lang.toUpperCase() : 'HLS Audio Stream',
        kind: 'hls' as const,
      }));
    }

    if (hasSubDubToggle) {
      return [
        {
          index: 0,
          label: audioCategory === 'dub' ? 'Dubbed Audio (DUB)' : 'Original Japanese (SUB)',
          detail: activeSource?.audioFormat || 'AAC Stereo',
          kind: 'single' as const,
        },
      ];
    }

    const detectedName =
      activeSource?.audioLang ||
      activeSource?.audioFormat ||
      'Default Audio Track';

    return [
      {
        index: 0,
        label: detectedName,
        detail: activeSource?.codec ? `${activeSource.codec} Stream` : 'Primary Audio Stream',
        kind: 'single' as const,
      },
    ];
  }, [probedMeta, hlsAudioTracks, hasSubDubToggle, audioCategory, activeSource]);

  const currentQualitySummary = useMemo(() => {
    if (hlsLevels.length > 0) {
      if (selectedHlsLevel === -1) return 'Auto';
      const found = hlsLevels.find((l) => l.index === selectedHlsLevel);
      return found ? `${found.height}p` : 'Auto';
    }
    if (activeSource?.quality && activeSource.quality !== 'auto') {
      return activeSource.quality;
    }
    if (probedMeta?.height) {
      return `${probedMeta.height}p`;
    }
    return 'Auto';
  }, [hlsLevels, selectedHlsLevel, activeSource, probedMeta]);

  const currentAudioSummary = useMemo(() => {
    if (probedMeta && probedMeta.audioTracks[selectedAudioTrackIndex]) {
      return probedMeta.audioTracks[selectedAudioTrackIndex].language;
    }
    if (hlsAudioTracks.length > 0 && hlsAudioTracks[selectedHlsAudioTrack]) {
      return hlsAudioTracks[selectedHlsAudioTrack].name;
    }
    if (hasSubDubToggle) {
      return audioCategory === 'dub' ? 'Dubbed' : 'Original';
    }
    if (activeSource?.audioFormat) {
      return activeSource.audioFormat.replace(/\s+Audio$/i, '');
    }
    return 'Default';
  }, [probedMeta, selectedAudioTrackIndex, hlsAudioTracks, selectedHlsAudioTrack, hasSubDubToggle, audioCategory, activeSource]);

  // Seek helper preserving remux offset or native currentTime
  const seekToSeconds = useCallback(
    (targetSec: number) => {
      const v = videoRef.current;
      if (!v || !activeSource) return;
      const clamped =
        effectiveDuration > 0
          ? Math.max(0, Math.min(effectiveDuration - 0.5, targetSec))
          : Math.max(0, targetSec);

      const isHls = activeSource.container === 'hls' || activeSource.url.includes('.m3u8');
      const useRemux =
        !isHls &&
        !offlineBlobUrl &&
        (probedMeta?.needsRemux ||
          selectedAudioTrackIndex > 0 ||
          seekOffset > 0 ||
          forceTranscode ||
          /\.(mkv|avi|flv|wmv|ts|m2ts|mov|mpd)(\?|$)/i.test(activeSource.url));

      if (useRemux) {
        setSeekOffset(clamped);
        setRawCurrentTime(0);
      } else {
        v.currentTime = clamped;
        setRawCurrentTime(clamped);
      }
    },
    [activeSource, effectiveDuration, offlineBlobUrl, probedMeta, selectedAudioTrackIndex, seekOffset, forceTranscode]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, []);

  const handleSkipBy = useCallback(
    (deltaSec: number) => {
      seekToSeconds(effectiveCurrentTime + deltaSec);
      const side = deltaSec < 0 ? 'left' : 'right';
      setSeekFeedback((prev) => ({
        side,
        seconds: prev && prev.side === side ? prev.seconds + Math.abs(deltaSec) : Math.abs(deltaSec),
      }));
      window.setTimeout(() => {
        setSeekFeedback(null);
      }, 750);
    },
    [effectiveCurrentTime, seekToSeconds]
  );

  // Speed Change
  const handleSelectSpeed = (spd: number) => {
    setPlaybackSpeed(spd);
    if (videoRef.current) {
      videoRef.current.playbackRate = spd;
    }
    setSettingsSubMenu('main');
  };

  // Quality Change (Preserves Playback Position)
  const handleSelectQualityOption = (opt: {
    type: 'auto' | 'hls' | 'source';
    hlsIndex: number;
    sourceIndex: number;
  }) => {
    const savedPos = effectiveCurrentTime;
    if (opt.type === 'auto') {
      setSelectedHlsLevel(-1);
      if (hlsRef.current) {
        hlsRef.current.currentLevel = -1;
      }
    } else if (opt.type === 'hls') {
      setSelectedHlsLevel(opt.hlsIndex);
      if (hlsRef.current) {
        hlsRef.current.currentLevel = opt.hlsIndex;
      }
    } else if (opt.type === 'source' && opt.sourceIndex !== activeSourceIndex) {
      pendingResumeTimeRef.current = savedPos > 2 ? savedPos : null;
      onSelectSource(opt.sourceIndex);
    }
    setSettingsSubMenu('main');
  };

  // Audio Track Change (Actually Switches Stream & Preserves Position)
  const handleSelectAudioTrack = (track: { index: number; kind: 'probed' | 'hls' | 'single' }) => {
    const currentPos = effectiveCurrentTime;
    if (track.kind === 'probed') {
      setSelectedAudioTrackIndex(track.index);
      if (currentPos > 2) {
        setSeekOffset(currentPos);
        setRawCurrentTime(0);
      }
    } else if (track.kind === 'hls' && hlsRef.current) {
      setSelectedHlsAudioTrack(track.index);
      hlsRef.current.audioTrack = track.index;
    }
    setSettingsSubMenu('main');
  };

  // Strict Landscape Fullscreen Toggle
  const enterLandscapeFullscreen = useCallback(() => {
    const el = containerRef.current;
    setIsHorizontalFullscreen(true);
    if (el && !document.fullscreenElement) {
      el.requestFullscreen()
        .then(() => {
          const orientation = (
            window.screen as unknown as { orientation?: { lock?: (mode: string) => Promise<void> } }
          )?.orientation;
          if (orientation && typeof orientation.lock === 'function') {
            orientation.lock('landscape').catch(() => {});
          }
        })
        .catch(() => {
          // Fallback to fixed full-viewport landscape mode when iframe blocks native fullscreen
        });
    } else {
      const orientation = (
        window.screen as unknown as { orientation?: { lock?: (mode: string) => Promise<void> } }
      )?.orientation;
      if (orientation && typeof orientation.lock === 'function') {
        orientation.lock('landscape').catch(() => {});
      }
    }
  }, []);

  const exitLandscapeFullscreen = useCallback(() => {
    setIsHorizontalFullscreen(false);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    const orientation = (window.screen as unknown as { orientation?: { unlock?: () => void } })?.orientation;
    if (orientation && typeof orientation.unlock === 'function') {
      try {
        orientation.unlock();
      } catch {
        // ignore
      }
    }
  }, []);

  const toggleLandscapeFullscreen = useCallback(() => {
    if (isHorizontalFullscreen || isFullscreen) {
      exitLandscapeFullscreen();
    } else {
      enterLandscapeFullscreen();
    }
  }, [isHorizontalFullscreen, isFullscreen, enterLandscapeFullscreen, exitLandscapeFullscreen]);

  useEffect(() => {
    const onFsChange = () => {
      const hasFs = Boolean(document.fullscreenElement);
      setIsFullscreen(hasFs);
      if (!hasFs && isFullscreen) {
        setIsHorizontalFullscreen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isHorizontalFullscreen) {
        setIsHorizontalFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isFullscreen, isHorizontalFullscreen]);

  // Track viewport size & lock body scroll for true horizontal fullscreen on any device
  useEffect(() => {
    const updateViewport = () => {
      setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    };
    updateViewport();
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
    };
  }, []);

  useEffect(() => {
    if (isHorizontalFullscreen || isFullscreen) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [isHorizontalFullscreen, isFullscreen]);

  // Open Real-Time Download sheet when triggered from parent Watch Detail action row
  useEffect(() => {
    if (openDownloadSignal > 0 && activeSource) {
      setShowControls(true);
      setActivePanel('download');
    }
  }, [openDownloadSignal, activeSource]);

  // Genuine Picture-in-Picture API
  const handleTogglePiP = async () => {
    const v = videoRef.current;
    if (!v) return;

    if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
      setPipNotice('Picture-in-Picture is not supported by this browser/device.');
      window.setTimeout(() => setPipNotice(null), 3500);
      return;
    }

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPipActive(false);
      } else {
        await v.requestPictureInPicture();
        setIsPipActive(true);
      }
    } catch {
      setPipNotice('Picture-in-Picture requires active video metadata or is restricted by browser policy.');
      window.setTimeout(() => setPipNotice(null), 3500);
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnterPip = () => setIsPipActive(true);
    const onLeavePip = () => setIsPipActive(false);
    v.addEventListener('enterpictureinpicture', onEnterPip);
    v.addEventListener('leavepictureinpicture', onLeavePip);
    return () => {
      v.removeEventListener('enterpictureinpicture', onEnterPip);
      v.removeEventListener('leavepictureinpicture', onLeavePip);
    };
  }, []);

  // Cycle Display Aspect / Fit Mode
  const handleCycleFitMode = () => {
    const order: VideoFitMode[] = ['contain', 'cover', 'zoom', 'stretch'];
    const labels: Record<VideoFitMode, string> = {
      contain: 'Fit to Screen',
      cover: 'Crop / Fill',
      zoom: 'Zoom 115%',
      stretch: 'Stretch 16:9',
    };
    const next = order[(order.indexOf(fitMode) + 1) % order.length];
    setFitMode(next);
    setPinchScale(1);
    setFitModeBadge(labels[next]);
    window.setTimeout(() => setFitModeBadge(null), 1500);
  };

  // External Local Subtitle File Loader (.srt / .vtt / .ass)
  const handleExternalSubtitleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      if (content) {
        const newSub: CustomExternalSubtitle = {
          label: file.name.replace(/\.(srt|vtt|ass|ssa)$/i, ''),
          lang: 'custom',
          vttText: content,
        };
        setCustomSubtitles((prev) => {
          const next = [...prev, newSub];
          const newIndex =
            (activeSource?.subtitles?.length || 0) +
            (probedMeta?.subtitleTracks?.length || 0) +
            next.length -
            1;
          setSelectedSubTrack(newIndex);
          return next;
        });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Advanced Touch & Pointer Gestures on Video Surface
  const handleVideoSurfaceClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isScreenLocked) {
      setShowLockHint(true);
      window.setTimeout(() => setShowLockHint(false), 2000);
      return;
    }
    if (activePanel !== 'none') {
      setActivePanel('none');
      setSettingsSubMenu('main');
      return;
    }
    if (touchStateRef.current.moved) {
      touchStateRef.current.moved = false;
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const side: 'left' | 'right' | 'center' = relX < 0.35 ? 'left' : relX > 0.65 ? 'right' : 'center';
    const now = Date.now();

    if (now - lastTapRef.current.time < 300 && lastTapRef.current.side === side && side !== 'center') {
      // Double-tap left (-10s) or right (+10s)
      handleSkipBy(side === 'left' ? -10 : 10);
      lastTapRef.current = { time: 0, side: 'center' };
      return;
    }

    lastTapRef.current = { time: now, side };
    if (now - hoverRevealedAtRef.current < 350) {
      setShowControls(true);
    } else {
      setShowControls((prev) => !prev);
    }
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isScreenLocked || activePanel !== 'none') return;

    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchStateRef.current.mode = 'pinch';
      touchStateRef.current.initialPinchDist = Math.hypot(dx, dy);
      touchStateRef.current.initialPinchScale = pinchScale;
      return;
    }

    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchStateRef.current = {
        startX: t.clientX,
        startY: t.clientY,
        startTime: Date.now(),
        mode: 'none',
        initialTime: effectiveCurrentTime,
        initialVolume: isMuted ? 0 : volume,
        initialBrightness: brightness,
        initialPinchDist: 0,
        initialPinchScale: pinchScale,
        targetTime: effectiveCurrentTime,
        moved: false,
      };

      if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = window.setTimeout(() => {
        if (!touchStateRef.current.moved && videoRef.current && !videoRef.current.paused) {
          setPreBoostSpeed(playbackSpeed);
          setIsLongPressSpeed(true);
          videoRef.current.playbackRate = 2.0;
        }
      }, 480);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isScreenLocked || activePanel !== 'none') return;

    if (e.touches.length === 2 && touchStateRef.current.mode === 'pinch') {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (touchStateRef.current.initialPinchDist > 0) {
        const nextScale = Math.max(
          1,
          Math.min(2.2, touchStateRef.current.initialPinchScale * (dist / touchStateRef.current.initialPinchDist))
        );
        setPinchScale(nextScale);
        touchStateRef.current.moved = true;
      }
      return;
    }

    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStateRef.current.startX;
    const dy = t.clientY - touchStateRef.current.startY;

    if (Math.abs(dx) > 14 || Math.abs(dy) > 14) {
      touchStateRef.current.moved = true;
      if (longPressTimerRef.current) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    }

    const rect = e.currentTarget.getBoundingClientRect();
    if (touchStateRef.current.mode === 'none') {
      if (Math.abs(dx) > 22 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        touchStateRef.current.mode = 'seek';
      } else if (Math.abs(dy) > 22 && Math.abs(dy) > Math.abs(dx) * 1.3) {
        const isLeftHalf = touchStateRef.current.startX - rect.left < rect.width / 2;
        touchStateRef.current.mode = isLeftHalf ? 'brightness' : 'volume';
      }
    }

    if (touchStateRef.current.mode === 'seek') {
      const deltaSec = Math.round((dx / Math.max(1, rect.width)) * 120);
      const nextTime = Math.max(
        0,
        effectiveDuration > 0
          ? Math.min(effectiveDuration, touchStateRef.current.initialTime + deltaSec)
          : touchStateRef.current.initialTime + deltaSec
      );
      touchStateRef.current.targetTime = nextTime;
      const sign = deltaSec >= 0 ? '+' : '';
      setGestureHud({
        type: 'seek',
        text: `${formatTime(nextTime)} (${sign}${deltaSec}s)`,
      });
    } else if (touchStateRef.current.mode === 'brightness') {
      const deltaPct = Math.round((-dy / Math.max(1, rect.height)) * 100);
      const nextBright = Math.max(25, Math.min(150, touchStateRef.current.initialBrightness + deltaPct));
      setBrightness(nextBright);
      setGestureHud({
        type: 'brightness',
        text: `Brightness ${nextBright}%`,
      });
    } else if (touchStateRef.current.mode === 'volume') {
      const deltaVol = (-dy / Math.max(1, rect.height)) * 1.2;
      const nextVol = Math.max(0, Math.min(1, touchStateRef.current.initialVolume + deltaVol));
      setVolume(nextVol);
      setIsMuted(nextVol === 0);
      if (videoRef.current) {
        videoRef.current.volume = nextVol;
        videoRef.current.muted = nextVol === 0;
      }
      setGestureHud({
        type: 'volume',
        text: `Volume ${Math.round(nextVol * 100)}%`,
      });
    }
  };

  const handleTouchEnd = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (isLongPressSpeed) {
      setIsLongPressSpeed(false);
      if (videoRef.current) {
        videoRef.current.playbackRate = preBoostSpeed;
      }
    }
    if (touchStateRef.current.mode === 'seek' && touchStateRef.current.moved) {
      seekToSeconds(touchStateRef.current.targetTime);
    }
    touchStateRef.current.mode = 'none';
    window.setTimeout(() => setGestureHud(null), 500);
  };

  // Selected Server & Real Supported Download Options (Zero Fake Data)
  const selectedDownloadSource = sources[downloadSourceIndex] || activeSource;
  const isDownloadSourceActive = downloadSourceIndex === activeSourceIndex;

  useEffect(() => {
    if (activePanel !== 'download' || !selectedDownloadSource || isDownloadSourceActive) {
      setIsInspectingDownloadServer(false);
      return;
    }
    const targetUrl = selectedDownloadSource.url;
    if (!targetUrl || downloadServerMetaMap[targetUrl]) {
      setIsInspectingDownloadServer(false);
      return;
    }

    let cancelled = false;
    setIsInspectingDownloadServer(true);
    const hdr = selectedDownloadSource.headers
      ? encodeURIComponent(JSON.stringify(selectedDownloadSource.headers))
      : '';
    const isHls = selectedDownloadSource.container === 'hls' || targetUrl.includes('.m3u8');

    const inspectPromise = isHls
      ? fetch(`/api/stream/hls-info?url=${encodeURIComponent(targetUrl)}&headers=${hdr}`)
          .then((r) => (r.ok ? r.json() : { levels: [], audioTracks: [] }))
          .then((info) => ({
            probedMeta: null,
            hlsLevels: Array.isArray(info.levels) ? info.levels : [],
            hlsAudioTracks: Array.isArray(info.audioTracks) ? info.audioTracks : [],
          }))
      : fetch(`/api/stream/probe?url=${encodeURIComponent(targetUrl)}&headers=${hdr}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((meta: ProbedMediaMetadata | null) => ({
            probedMeta: meta,
            hlsLevels: [],
            hlsAudioTracks: [],
          }));

    inspectPromise
      .then((result) => {
        if (cancelled) return;
        setDownloadServerMetaMap((prev) => ({ ...prev, [targetUrl]: result }));
      })
      .catch(() => {
        if (cancelled) return;
        setDownloadServerMetaMap((prev) => ({
          ...prev,
          [targetUrl]: { probedMeta: null, hlsLevels: [], hlsAudioTracks: [] },
        }));
      })
      .finally(() => {
        if (!cancelled) setIsInspectingDownloadServer(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activePanel, selectedDownloadSource, isDownloadSourceActive, downloadServerMetaMap]);

  const downloadServerProbe = selectedDownloadSource
    ? isDownloadSourceActive
      ? { probedMeta, hlsLevels, hlsAudioTracks }
      : downloadServerMetaMap[selectedDownloadSource.url] || {
          probedMeta: null,
          hlsLevels: [],
          hlsAudioTracks: [],
        }
    : { probedMeta: null, hlsLevels: [], hlsAudioTracks: [] };

  const supportedDownloadLanguages = useMemo(
    () =>
      buildSupportedDownloadLanguages({
        source: selectedDownloadSource,
        probedMeta: downloadServerProbe.probedMeta,
        hlsAudioTracks: downloadServerProbe.hlsAudioTracks,
        hasSubDubToggle,
        audioCategory,
      }),
    [selectedDownloadSource, downloadServerProbe, hasSubDubToggle, audioCategory]
  );

  const groupedDownloadServers = useMemo(() => groupDownloadServers(sources), [sources]);

  const selectedServerGroup = useMemo(() => {
    return (
      groupedDownloadServers.find((g) =>
        g.items.some((item) => item.originalIndex === downloadSourceIndex)
      ) ||
      groupedDownloadServers[0] ||
      null
    );
  }, [groupedDownloadServers, downloadSourceIndex]);

  const supportedDownloadQualities = useMemo(
    () =>
      buildSupportedDownloadQualitiesForServer({
        serverGroup: selectedServerGroup,
        primarySource: selectedDownloadSource,
        probedMeta: downloadServerProbe.probedMeta,
        hlsLevels: downloadServerProbe.hlsLevels,
        hlsAudioTracksCount: downloadServerProbe.hlsAudioTracks.length,
      }),
    [selectedServerGroup, selectedDownloadSource, downloadServerProbe]
  );

  const selectedDownloadAudioObj =
    supportedDownloadLanguages.find((a) => a.index === downloadAudioIndex) ||
    supportedDownloadLanguages[0] || { index: 0, label: 'Default Audio', detail: '', kind: 'single' as const };

  const handleStartTrackedDownload = (qualityOption: SupportedDownloadQuality) => {
    const src = qualityOption.targetSource || selectedDownloadSource;
    if (!src) return;
    onTriggerOfflineSave(
      src,
      selectedDownloadAudioObj.index,
      selectedDownloadAudioObj.label,
      qualityOption,
      src.url === selectedDownloadSource?.url ? downloadServerProbe.probedMeta : null
    );
    setDownloadStartedNotice(
      `Downloading ${qualityOption.label} · ${selectedDownloadAudioObj.label} — tracking MB & speed in Downloads`
    );
    window.setTimeout(() => setDownloadStartedNotice(null), 6500);
    setActivePanel('none');
  };

  const isLandscapeMode = isHorizontalFullscreen || isFullscreen;
  const progressPercent =
    effectiveDuration > 0 ? Math.min(100, Math.max(0, (effectiveCurrentTime / effectiveDuration) * 100)) : 0;

  const videoFitClass =
    fitMode === 'cover'
      ? 'object-cover'
      : fitMode === 'stretch'
        ? 'object-fill'
        : 'object-contain';

  const effectiveZoomScale = fitMode === 'zoom' ? 1.15 * pinchScale : pinchScale;

  const subFontSizeClass =
    subFontSize === 'sm'
      ? 'text-xs sm:text-sm'
      : subFontSize === 'lg'
        ? 'text-base sm:text-xl'
        : subFontSize === 'xl'
          ? 'text-lg sm:text-2xl'
          : 'text-sm sm:text-base';

  const subPositionClass =
    subPosition === 'top'
      ? 'top-16'
      : subPosition === 'middle'
        ? 'bottom-28'
        : 'bottom-16';

  const controlsVisible = showControls || !isPlaying || isBuffering;

  return (
    <div className="flex flex-col gap-3">
      {/* Status Banner for Failover / PiP / Download */}
      {(autoSwitchStatus || failoverNotice || downloadStartedNotice || pipNotice) && (
        <div
          data-testid="player-status-banner"
          className="bg-amber-500/15 border border-amber-500/40 text-amber-300 px-3.5 py-2 rounded-xl text-xs font-medium flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2 min-w-0">
            {(isFailoverLoading || autoSwitchStatus) && (
              <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
            )}
            <span className="truncate">{pipNotice || downloadStartedNotice || autoSwitchStatus || failoverNotice}</span>
          </div>
          {downloadStartedNotice && onViewDownloads && (
            <button
              type="button"
              data-testid="banner-view-downloads-btn"
              onClick={onViewDownloads}
              className="px-2.5 py-1 bg-white text-black font-bold rounded-md hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1"
            >
              <FolderDown className="w-3 h-3" />
              <span>View Downloads</span>
            </button>
          )}
          {onRequestProviderFailover && !downloadStartedNotice && !pipNotice && (
            <button
              type="button"
              onClick={onRequestProviderFailover}
              className="px-2.5 py-1 bg-amber-500 text-slate-950 font-semibold rounded-md hover:bg-amber-400 transition-colors whitespace-nowrap shrink-0"
            >
              Switch Provider Now
            </button>
          )}
        </div>
      )}

      {/* Hidden File Input for External Subtitles (.srt, .vtt, .ass) */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.vtt,.ass,.ssa"
        onChange={handleExternalSubtitleUpload}
        className="hidden"
      />

      {/* Main Universal Video Player Container */}
      <div
        ref={containerRef}
        data-testid="zangetsu-video-player"
        data-horizontal-fullscreen={isLandscapeMode ? 'true' : 'false'}
        data-screen-locked={isScreenLocked ? 'true' : 'false'}
        className={
          isLandscapeMode
            ? 'fixed inset-0 z-50 w-screen h-screen bg-black overflow-hidden select-none'
            : 'relative w-full aspect-video bg-black sm:rounded-xl overflow-hidden group select-none'
        }
      >
        <div
          data-testid="video-landscape-stage"
          onMouseMove={resetControlsTimer}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={
            isLandscapeMode && viewportSize.h > viewportSize.w
              ? {
                  position: 'fixed',
                  top: '50%',
                  left: '50%',
                  width: `${viewportSize.h}px`,
                  height: `${viewportSize.w}px`,
                  transform: 'translate(-50%, -50%) rotate(90deg)',
                  transformOrigin: 'center center',
                }
              : undefined
          }
          className="relative w-full h-full bg-black overflow-hidden flex items-center justify-center"
        >
        {/* HTML5 Video Element */}
        <video
          ref={videoRef}
          style={{
            filter: `brightness(${brightness}%)`,
            transform: effectiveZoomScale !== 1 ? `scale(${effectiveZoomScale})` : undefined,
          }}
          className={`w-full h-full ${videoFitClass} bg-black transition-transform duration-150`}
          playsInline
          crossOrigin="anonymous"
          onPlay={() => setIsPlaying(true)}
          onPlaying={() => {
            setIsPlaying(true);
            setIsBuffering(false);
            setAutoSwitchStatus(null);
          }}
          onLoadedData={() => setIsBuffering(false)}
          onCanPlay={() => setIsBuffering(false)}
          onPause={() => setIsPlaying(false)}
          onWaiting={() => setIsBuffering(true)}
          onEnded={() => {
            if (hasNextEpisode && onNextEpisode) {
              onNextEpisode();
            }
          }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setRawDuration(v.duration || 0);
            setIsBuffering(false);
            if (
              pendingResumeTimeRef.current &&
              pendingResumeTimeRef.current > 2 &&
              seekOffset === 0 &&
              v.seekable.length > 0 &&
              v.seekable.end(0) >= pendingResumeTimeRef.current
            ) {
              const target = pendingResumeTimeRef.current;
              pendingResumeTimeRef.current = null;
              v.currentTime = target;
            }
          }}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime || 0;
            setRawCurrentTime(t);
            if (t > 0) setIsBuffering(false);
          }}
          onError={(e) => {
            const v = e.currentTarget;
            if (isUnloadingRef.current || !v.src || v.error?.code === 1) {
              return;
            }
            if (!forceTranscode && probedMeta && !activeSource?.url.includes('.m3u8')) {
              setForceTranscode(true);
              return;
            }
            triggerFailoverRef.current(
              'Stream playback error on current server. Select an alternative server or switch provider.'
            );
          }}
        />

        {/* Interactive Tap & Double-Tap Surface */}
        <div
          data-testid="video-gesture-surface"
          onClick={handleVideoSurfaceClick}
          className="absolute inset-0 z-10 cursor-pointer"
        />

        {/* Custom Synchronized & Styled Subtitle Overlay */}
        {activeCueText && (
          <div
            data-testid="active-subtitle-overlay"
            className={`absolute inset-x-6 ${subPositionClass} z-15 flex justify-center pointer-events-none text-center`}
          >
            <span
              style={{
                color: subFontColor,
                backgroundColor: `rgba(0, 0, 0, ${subBgOpacity})`,
                textShadow:
                  subTextStyle === 'outline'
                    ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
                    : '0 2px 6px rgba(0,0,0,0.95)',
                fontWeight: subTextStyle === 'bold' ? 700 : 500,
              }}
              className={`px-3.5 py-1.5 rounded-lg whitespace-pre-line leading-snug ${subFontSizeClass}`}
            >
              {activeCueText}
            </span>
          </div>
        )}

        {/* Double-Tap Rewind / Forward Visual Feedback */}
        {seekFeedback && (
          <div
            data-testid="double-tap-feedback"
            className={`absolute inset-y-0 ${
              seekFeedback.side === 'left' ? 'left-0 rounded-r-full' : 'right-0 rounded-l-full'
            } w-1/3 bg-white/15 backdrop-blur-sm z-20 flex flex-col items-center justify-center pointer-events-none animate-pulse`}
          >
            {seekFeedback.side === 'left' ? (
              <Rewind className="w-9 h-9 text-white mb-1" />
            ) : (
              <FastForward className="w-9 h-9 text-white mb-1" />
            )}
            <span className="text-sm font-bold text-white font-mono">
              {seekFeedback.side === 'left' ? `-${seekFeedback.seconds}s` : `+${seekFeedback.seconds}s`}
            </span>
          </div>
        )}

        {/* Long-Press 2x Speed Pill Indicator */}
        {isLongPressSpeed && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 z-25 bg-black/75 backdrop-blur-md px-4 py-1.5 rounded-full border border-white/15 flex items-center gap-1.5 text-xs font-bold text-white pointer-events-none">
            <FastForward className="w-3.5 h-3.5 text-amber-400" />
            <span>2.0x Speed Boost</span>
          </div>
        )}

        {/* Swipe Brightness / Volume / Seek / Fit Mode HUD */}
        {(gestureHud || fitModeBadge) && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-25 bg-black/80 backdrop-blur-md px-4 py-2 rounded-xl border border-white/15 flex items-center gap-2 text-xs font-semibold text-white pointer-events-none">
            {gestureHud?.type === 'brightness' && <Sun className="w-4 h-4 text-amber-400" />}
            {gestureHud?.type === 'volume' &&
              (isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-rose-400" />
              ) : (
                <Volume2 className="w-4 h-4 text-amber-400" />
              ))}
            <span>{fitModeBadge || gestureHud?.text}</span>
          </div>
        )}

        {/* Buffering / Probing / Failover Indicator (Non-blocking so center controls remain visible) */}
        {(isBuffering || isProbing || isFailoverLoading) && !errorMsg && (
          <div className="absolute top-11 sm:top-14 left-1/2 -translate-x-1/2 z-15 flex items-center gap-2 px-3 py-1 rounded-full bg-black/75 backdrop-blur-md border border-white/10 pointer-events-none max-w-[72%] whitespace-nowrap">
            <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
            <span className="text-[11px] sm:text-xs font-medium text-slate-200 truncate">
              {isFailoverLoading
                ? 'Auto-switching provider...'
                : isProbing
                  ? 'Inspecting audio tracks...'
                  : 'Buffering stream...'}
            </span>
          </div>
        )}

        {/* Screen Lock Floating Circular Button (Left Side — Shown in Landscape Fullscreen or when Locked) */}
        {(isLandscapeMode || isScreenLocked) && (
          <div
            className={`absolute left-4 sm:left-6 top-1/2 -translate-y-1/2 z-30 flex items-center gap-2 transition-opacity duration-200 ${
              showControls || !isPlaying || isBuffering || isScreenLocked
                ? 'opacity-100'
                : 'opacity-0 pointer-events-none'
            }`}
          >
          <button
            type="button"
            data-testid="screen-lock-btn"
            aria-label={isScreenLocked ? 'Unlock Screen Controls' : 'Lock Screen Controls'}
            onClick={(e) => {
              e.stopPropagation();
              const nextLocked = !isScreenLocked;
              setIsScreenLocked(nextLocked);
              setShowLockHint(false);
              if (!nextLocked) {
                setShowControls(true);
              }
            }}
            className="w-11 h-11 rounded-full bg-black/65 hover:bg-black/85 backdrop-blur-md border border-white/15 flex items-center justify-center text-white transition-all shadow-lg"
          >
            {isScreenLocked ? <Lock className="w-5 h-5 text-amber-400" /> : <Unlock className="w-5 h-5 text-white" />}
          </button>
          {isScreenLocked && showLockHint && (
            <span className="px-3 py-1 rounded-full bg-black/80 text-xs font-medium text-white border border-white/15">
              Screen Locked · Tap padlock to unlock
            </span>
          )}
          </div>
        )}

        {/* Unlocked OTT Controls Overlay (Matches Reference Screenshots 1 & 2) */}
        {!isScreenLocked && (
          <div
            data-testid="player-controls-overlay"
            aria-hidden={!controlsVisible}
            className={`absolute inset-0 z-20 flex flex-col justify-between bg-gradient-to-b from-black/80 via-black/20 to-black/85 transition-opacity duration-250 pointer-events-none ${
              controlsVisible ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {/* TOP BAR: Back + Title on Left | Recommendations + CC + Settings on Right */}
            <div className={`px-4 sm:px-6 pt-4 pb-2 flex items-start justify-between gap-4 ${controlsVisible ? 'pointer-events-auto' : 'pointer-events-none'}`}>
              <div className="flex items-start gap-3 min-w-0">
                <button
                  type="button"
                  data-testid="player-back-btn"
                  aria-label={isLandscapeMode ? 'Exit Fullscreen' : 'Back'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isLandscapeMode) {
                      exitLandscapeFullscreen();
                    } else if (onBack) {
                      onBack();
                    }
                  }}
                  className="p-1.5 -ml-1 text-white hover:text-slate-200 transition-colors shrink-0"
                >
                  <ChevronLeft className="w-6 h-6 stroke-[2.2]" />
                </button>

                <div className="flex flex-col min-w-0">
                  <h2 className="text-base sm:text-lg font-bold text-white truncate max-w-md sm:max-w-xl leading-snug">
                    {title}
                  </h2>
                  {!isLandscapeMode && episode && (isSeries || hasSubDubToggle) && (
                    <span className="text-xs sm:text-sm text-slate-300 font-medium truncate">
                      Season {seasonNumber || 1} • Episode {episode.number}
                    </span>
                  )}
                </div>
              </div>

              {/* TOP RIGHT ICONS: TV-like Recommendations (Landscape Fullscreen), CC Subtitles, Playback Settings */}
              <div className="flex items-center gap-3 sm:gap-4 shrink-0">
                {/* TV-like Recommendation Icon (Matching Screenshot 1 in Landscape Fullscreen) */}
                {isLandscapeMode && (
                  <button
                    type="button"
                    data-testid="player-recommendations-btn"
                    aria-label="You May Also Like Recommendations"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActivePanel((p) => (p === 'recommendations' ? 'none' : 'recommendations'));
                    }}
                    className={`p-1.5 rounded-lg transition-colors ${
                      activePanel === 'recommendations' ? 'text-amber-400' : 'text-white hover:text-slate-200'
                    }`}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="w-5 h-5"
                    >
                      <path d="M5 4h14" />
                      <rect x="3" y="7" width="18" height="13" rx="2.5" />
                      <polygon points="10 11 15 13.5 10 16 10 11" fill="currentColor" stroke="none" />
                    </svg>
                  </button>
                )}

                {/* CC Subtitles Button (Rounded Rectangle CC Icon Matching Screenshot 1 & 2) */}
                <button
                  type="button"
                  data-testid="player-cc-btn"
                  aria-label="Subtitles (CC)"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowSubAppearance(false);
                    setActivePanel((p) => (p === 'subtitles' ? 'none' : 'subtitles'));
                  }}
                  className={`p-1.5 rounded-lg transition-colors ${
                    activePanel === 'subtitles' || selectedSubTrack >= 0
                      ? 'text-amber-400'
                      : 'text-white hover:text-slate-200'
                  }`}
                >
                  <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6">
                    <rect
                      x="2.5"
                      y="5"
                      width="19"
                      height="14"
                      rx="3"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    <path
                      d="M10.2 10.2C9.8 9.7 9.1 9.5 8.4 9.5C7 9.5 6 10.6 6 12C6 13.4 7 14.5 8.4 14.5C9.1 14.5 9.8 14.3 10.2 13.8M17.2 10.2C16.8 9.7 16.1 9.5 15.4 9.5C14 9.5 13 10.6 13 12C13 13.4 14 14.5 15.4 14.5C16.1 14.5 16.8 14.3 17.2 13.8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>

                {/* Playback Settings Icon (Sliders Matching Screenshot 1 & 2) */}
                <button
                  type="button"
                  data-testid="player-settings-btn"
                  aria-label="Playback Settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSettingsSubMenu('main');
                    setActivePanel((p) => (p === 'settings' ? 'none' : 'settings'));
                  }}
                  className={`p-1.5 rounded-lg transition-colors ${
                    activePanel === 'settings' ? 'text-amber-400' : 'text-white hover:text-slate-200'
                  }`}
                >
                  <SlidersHorizontal className="w-5 h-5" />
                </button>

                {/* Real-Time Quality + Language Download Button (Available in Landscape Fullscreen; Normal mode uses Download pill below player) */}
                {isLandscapeMode && activeSource && (
                  <button
                    type="button"
                    data-testid="player-download-btn"
                    aria-label="Download Stream with Quality and Language Selection"
                    onClick={(e) => {
                      e.stopPropagation();
                      setActivePanel((p) => (p === 'download' ? 'none' : 'download'));
                    }}
                    className={`p-1.5 rounded-lg transition-colors ${
                      activePanel === 'download' ? 'text-amber-400' : 'text-white/90 hover:text-white'
                    }`}
                  >
                    <Download className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>

            {/* CENTRE CONTROLS: Previous | Play/Pause | Next (Matching Screenshot 1 & 2) */}
            <div className={`flex items-center justify-center gap-12 sm:gap-16 ${controlsVisible ? 'pointer-events-auto' : 'pointer-events-none'}`}>
              <button
                type="button"
                data-testid="player-prev-btn"
                aria-label="Previous"
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasPreviousEpisode && onPreviousEpisode && effectiveCurrentTime < 15) {
                    onPreviousEpisode();
                  } else {
                    handleSkipBy(-10);
                  }
                }}
                className="p-2 text-white/85 hover:text-white transition-transform active:scale-95"
              >
                <SkipBack className="w-8 h-8 fill-current" />
              </button>

              <button
                type="button"
                data-testid="player-play-pause-btn"
                aria-label={isPlaying ? 'Pause' : 'Play'}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlay();
                }}
                className="p-3 text-white hover:scale-105 transition-transform active:scale-95"
              >
                {isPlaying ? (
                  <Pause className="w-11 h-11 fill-current" />
                ) : (
                  <Play className="w-11 h-11 fill-current ml-0.5" />
                )}
              </button>

              <button
                type="button"
                data-testid="player-next-btn"
                aria-label="Next"
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasNextEpisode && onNextEpisode) {
                    onNextEpisode();
                  } else {
                    handleSkipBy(10);
                  }
                }}
                className="p-2 text-white/85 hover:text-white transition-transform active:scale-95"
              >
                <SkipForward className="w-8 h-8 fill-current" />
              </button>
            </div>

            {/* BOTTOM SECTION: Skip 90s Floating Pill + Timeline + Display/PiP/Fullscreen Controls */}
            <div className={`px-4 sm:px-6 pb-4 pt-2 flex flex-col gap-2.5 ${controlsVisible ? 'pointer-events-auto' : 'pointer-events-none'}`}>
              {/* Floating `>> Skip 90s` Pill on Right (Matching Screenshot 2) */}
              <div className="flex items-center justify-between">
                {hasSubDubToggle ? (
                  <div className="flex items-center gap-1 bg-black/65 backdrop-blur-md border border-white/15 p-0.5 rounded-full">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onChangeAudioCategory('sub');
                      }}
                      className={`px-2.5 py-0.5 text-[11px] font-semibold rounded-full transition-colors ${
                        audioCategory === 'sub' ? 'bg-white text-black' : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      SUB
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onChangeAudioCategory('dub');
                      }}
                      className={`px-2.5 py-0.5 text-[11px] font-semibold rounded-full transition-colors ${
                        audioCategory === 'dub' ? 'bg-white text-black' : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      DUB
                    </button>
                  </div>
                ) : (
                  <div />
                )}

                {(isSeries || hasSubDubToggle) && (
                  <button
                    type="button"
                    data-testid="skip-90s-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSkipBy(90);
                    }}
                    className="px-4 py-1.5 rounded-full bg-black/70 hover:bg-black/85 backdrop-blur-md border border-white/10 text-xs sm:text-sm font-semibold text-white flex items-center gap-1.5 shadow-lg transition-colors"
                  >
                    <FastForward className="w-4 h-4 fill-current" />
                    <span>Skip 90s</span>
                  </button>
                )}
              </div>

              {/* Timeline Row: Current Time | Custom Vertical-Pill Scrubber | Total Duration | Aspect | PiP | Square | Fullscreen */}
              <div className="flex items-center gap-3 sm:gap-4">
                <span
                  data-testid="player-current-time"
                  className="text-xs sm:text-sm font-semibold font-mono tabular-nums text-white shrink-0"
                >
                  {formatTime(effectiveCurrentTime)}
                </span>

                {/* Sleek Progress Bar with Vertical Pill Thumb Matching Screenshots 1 & 2 */}
                <div className="relative flex-1 h-6 flex items-center">
                  <div className="w-full h-1 bg-white/30 rounded-full overflow-hidden">
                    <div
                      style={{ width: `${progressPercent}%` }}
                      className="h-full bg-white rounded-full"
                    />
                  </div>
                  <div
                    style={{ left: `calc(${progressPercent}% - 4px)` }}
                    className="absolute w-2 h-5 bg-white rounded-full shadow-md pointer-events-none"
                  />
                  <input
                    type="range"
                    aria-label="Seek timeline"
                    min={0}
                    max={effectiveDuration > 0 ? effectiveDuration : 100}
                    step={0.5}
                    value={effectiveCurrentTime}
                    onChange={(e) => {
                      e.stopPropagation();
                      seekToSeconds(parseFloat(e.target.value));
                    }}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                </div>

                <span
                  data-testid="player-total-duration"
                  className="text-xs sm:text-sm font-semibold font-mono tabular-nums text-white shrink-0"
                >
                  {formatTime(effectiveDuration)}
                </span>

                {/* Right Display Controls */}
                <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
                  {/* Display Fit / Aspect Ratio Icon (Shown in Landscape Fullscreen matching Screenshot 1) */}
                  {isLandscapeMode && (
                    <button
                      type="button"
                      data-testid="display-fit-btn"
                      aria-label="Change Video Aspect Fit"
                      title="Change Aspect Fit (Contain / Fill / Zoom / Stretch)"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCycleFitMode();
                      }}
                      className="p-1 text-white hover:text-slate-200 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
                        <rect x="2.5" y="4.5" width="19" height="15" rx="3" stroke="currentColor" strokeWidth="2" />
                        <path d="M6.5 10V8H9M17.5 14V16H15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}

                  {/* Picture-in-Picture (PiP) Button (Matching Screenshot 1 & 2) */}
                  <button
                    type="button"
                    data-testid="pip-btn"
                    aria-label="Picture in Picture"
                    title="Picture-in-Picture"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTogglePiP();
                    }}
                    className={`p-1 transition-colors ${
                      isPipActive ? 'text-amber-400' : 'text-white hover:text-slate-200'
                    }`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
                      <rect
                        x="2.5"
                        y="4.5"
                        width="19"
                        height="15"
                        rx="2.5"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="currentColor" />
                    </svg>
                  </button>

                  {/* Dedicated Square Fullscreen / Exit Fullscreen Icon (Exact Match to Screenshot 1, 2 & Watch View) */}
                  <button
                    type="button"
                    data-testid="horizontal-fullscreen-btn"
                    aria-label={isLandscapeMode ? 'Exit Fullscreen' : 'Horizontal Fullscreen'}
                    title={isLandscapeMode ? 'Exit Fullscreen' : 'Horizontal Fullscreen'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLandscapeFullscreen();
                    }}
                    className={`p-1 transition-colors ${
                      isLandscapeMode ? 'text-amber-400' : 'text-white hover:text-slate-200'
                    }`}
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
                      <path
                        d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PLAYBACK SETTINGS BOTTOM-SHEET PANEL (Exact Match to Screenshot 4) */}
        {activePanel === 'settings' && (
          <div
            data-testid="playback-settings-sheet"
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-4 sm:inset-x-auto sm:w-[540px] sm:left-1/2 sm:-translate-x-1/2 bottom-3 z-40 bg-[#101823]/95 backdrop-blur-2xl border border-white/10 rounded-[28px] p-5 sm:p-6 shadow-2xl text-white"
          >
            {/* Top Drag Handle */}
            <div
              onClick={() => {
                setActivePanel('none');
                setSettingsSubMenu('main');
              }}
              className="w-12 h-1.5 rounded-full bg-white/30 mx-auto mb-4 cursor-pointer"
            />

            {settingsSubMenu === 'main' && (
              <div className="flex flex-col gap-1">
                <h3 className="text-lg sm:text-xl font-bold text-white mb-2">Playback Settings</h3>

                {/* Row 1: Speed */}
                <button
                  type="button"
                  data-testid="settings-row-speed"
                  onClick={() => setSettingsSubMenu('speed')}
                  className="w-full py-3.5 px-2 rounded-xl hover:bg-white/5 flex items-center justify-between transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6 text-white">
                      <circle
                        cx="12"
                        cy="12"
                        r="9"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeDasharray="4 2"
                      />
                      <polygon points="10 8.5 16 12 10 15.5 10 8.5" fill="currentColor" />
                    </svg>
                    <span className="text-base font-medium text-white">Speed</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-300">
                    <span data-testid="settings-speed-value" className="text-sm sm:text-base">
                      {Number.isInteger(playbackSpeed) ? `${playbackSpeed.toFixed(1)}x` : `${playbackSpeed}x`}
                    </span>
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </button>

                {/* Row 2: Quality */}
                <button
                  type="button"
                  data-testid="settings-row-quality"
                  onClick={() => setSettingsSubMenu('quality')}
                  className="w-full py-3.5 px-2 rounded-xl hover:bg-white/5 flex items-center justify-between transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <SlidersHorizontal className="w-6 h-6 text-white" />
                    <span className="text-base font-medium text-white">Quality</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-300">
                    <span data-testid="settings-quality-value" className="text-sm sm:text-base">
                      {currentQualitySummary}
                    </span>
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </button>

                {/* Row 3: Audio */}
                <button
                  type="button"
                  data-testid="settings-row-audio"
                  onClick={() => setSettingsSubMenu('audio')}
                  className="w-full py-3.5 px-2 rounded-xl hover:bg-white/5 flex items-center justify-between transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <Music className="w-6 h-6 text-white" />
                    <span className="text-base font-medium text-white">Audio</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-slate-300">
                    <span data-testid="settings-audio-value" className="text-sm sm:text-base">
                      {currentAudioSummary}
                    </span>
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </button>
              </div>
            )}

            {settingsSubMenu === 'speed' && (
              <div data-testid="settings-speed-panel" className="flex flex-col gap-2">
                <div className="flex items-center gap-2 mb-1">
                  <button
                    type="button"
                    onClick={() => setSettingsSubMenu('main')}
                    className="p-1 text-slate-300 hover:text-white"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <h3 className="text-lg font-bold text-white">Playback Speed</h3>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-48 overflow-y-auto pt-1">
                  {SUPPORTED_SPEEDS.map((spd) => {
                    const isSel = Math.abs(playbackSpeed - spd) < 0.01;
                    const label = Number.isInteger(spd) ? `${spd.toFixed(1)}x` : `${spd}x`;
                    return (
                      <button
                        key={spd}
                        type="button"
                        onClick={() => handleSelectSpeed(spd)}
                        className={`px-3 py-2.5 rounded-xl text-sm font-semibold flex items-center justify-between border transition-colors ${
                          isSel
                            ? 'bg-white text-slate-950 border-white'
                            : 'bg-white/5 text-slate-200 border-white/10 hover:bg-white/10'
                        }`}
                      >
                        <span>{label}</span>
                        {isSel && <Check className="w-4 h-4 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {settingsSubMenu === 'quality' && (
              <div data-testid="settings-quality-panel" className="flex flex-col gap-2">
                <div className="flex items-center gap-2 mb-1">
                  <button
                    type="button"
                    onClick={() => setSettingsSubMenu('main')}
                    className="p-1 text-slate-300 hover:text-white"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <h3 className="text-lg font-bold text-white">Video Quality</h3>
                </div>
                <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
                  <button
                    type="button"
                    onClick={() =>
                      handleSelectQualityOption({
                        type: 'auto',
                        hlsIndex: -1,
                        sourceIndex: activeSourceIndex,
                      })
                    }
                    className={`w-full px-3.5 py-2.5 rounded-xl text-left text-sm flex items-center justify-between transition-colors ${
                      selectedHlsLevel === -1 && hlsLevels.length > 0
                        ? 'bg-white/15 text-white font-bold'
                        : 'hover:bg-white/5 text-slate-200'
                    }`}
                  >
                    <span>Auto (Recommended)</span>
                    {selectedHlsLevel === -1 && hlsLevels.length > 0 && <Check className="w-4 h-4 text-white" />}
                  </button>

                  {actualQualityOptions.map((opt) => {
                    const isSel =
                      opt.type === 'hls'
                        ? selectedHlsLevel === opt.hlsIndex
                        : opt.sourceIndex === activeSourceIndex && selectedHlsLevel === -1 && hlsLevels.length === 0;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          handleSelectQualityOption({
                            type: opt.type,
                            hlsIndex: opt.hlsIndex,
                            sourceIndex: opt.sourceIndex,
                          })
                        }
                        className={`w-full px-3.5 py-2.5 rounded-xl text-left text-sm flex items-center justify-between transition-colors ${
                          isSel ? 'bg-white/15 text-white font-bold' : 'hover:bg-white/5 text-slate-200'
                        }`}
                      >
                        <div className="flex flex-col">
                          <span>{opt.label}</span>
                          <span className="text-xs text-slate-400">{opt.subLabel}</span>
                        </div>
                        {isSel && <Check className="w-4 h-4 text-white shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {settingsSubMenu === 'audio' && (
              <div data-testid="settings-audio-panel" className="flex flex-col gap-2">
                <div className="flex items-center gap-2 mb-1">
                  <button
                    type="button"
                    onClick={() => setSettingsSubMenu('main')}
                    className="p-1 text-slate-300 hover:text-white"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <h3 className="text-lg font-bold text-white">Audio Track</h3>
                </div>
                <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
                  {actualAudioTracks.map((track) => {
                    const isSel =
                      track.kind === 'probed'
                        ? selectedAudioTrackIndex === track.index
                        : track.kind === 'hls'
                          ? selectedHlsAudioTrack === track.index
                          : true;
                    return (
                      <button
                        key={`${track.kind}-${track.index}`}
                        type="button"
                        onClick={() => handleSelectAudioTrack(track)}
                        className={`w-full px-3.5 py-2.5 rounded-xl text-left text-sm flex items-center justify-between transition-colors ${
                          isSel ? 'bg-white/15 text-white font-bold' : 'hover:bg-white/5 text-slate-200'
                        }`}
                      >
                        <div className="flex flex-col">
                          <span>{track.label}</span>
                          <span className="text-xs text-slate-400">{track.detail}</span>
                        </div>
                        {isSel && <Check className="w-4 h-4 text-white shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* SUBTITLES BOTTOM-SHEET PANEL (Exact Match to Screenshot 3) */}
        {activePanel === 'subtitles' && (
          <div
            data-testid="subtitles-sheet"
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-4 sm:inset-x-auto sm:w-[540px] sm:left-1/2 sm:-translate-x-1/2 bottom-3 z-40 bg-[#101823]/95 backdrop-blur-2xl border border-white/10 rounded-[28px] p-5 sm:p-6 shadow-2xl text-white"
          >
            {/* Top Drag Handle */}
            <div
              onClick={() => setActivePanel('none')}
              className="w-12 h-1.5 rounded-full bg-white/30 mx-auto mb-4 cursor-pointer"
            />

            {/* Header Row: "Subtitles" on Left | "-  0.0s  +  Gear" on Right */}
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg sm:text-xl font-bold text-white">Subtitles</h3>

              <div className="flex items-center gap-4">
                <button
                  type="button"
                  data-testid="sub-delay-minus"
                  aria-label="Decrease Subtitle Delay"
                  onClick={() => setSubtitleDelay((d) => Math.round((d - 0.5) * 10) / 10)}
                  className="p-1 text-white hover:text-amber-400 transition-colors"
                >
                  <Minus className="w-5 h-5" />
                </button>

                <span
                  data-testid="sub-delay-value"
                  className="text-xs sm:text-sm font-mono tabular-nums text-slate-300 min-w-[38px] text-center"
                >
                  {subtitleDelay > 0 ? `+${subtitleDelay.toFixed(1)}s` : `${subtitleDelay.toFixed(1)}s`}
                </span>

                <button
                  type="button"
                  data-testid="sub-delay-plus"
                  aria-label="Increase Subtitle Delay"
                  onClick={() => setSubtitleDelay((d) => Math.round((d + 0.5) * 10) / 10)}
                  className="p-1 text-white hover:text-amber-400 transition-colors"
                >
                  <Plus className="w-5 h-5" />
                </button>

                <button
                  type="button"
                  data-testid="sub-appearance-btn"
                  aria-label="Subtitle Appearance Settings"
                  onClick={() => setShowSubAppearance((v) => !v)}
                  className={`p-1 transition-colors ${
                    showSubAppearance ? 'text-amber-400' : 'text-white hover:text-slate-200'
                  }`}
                >
                  <Settings className="w-5 h-5" />
                </button>
              </div>
            </div>

            {showSubAppearance ? (
              <div data-testid="subtitle-appearance-panel" className="flex flex-col gap-3 pt-1 border-t border-white/10">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">Font Size</span>
                  <div className="flex items-center gap-1.5">
                    {(['sm', 'md', 'lg', 'xl'] as const).map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() => setSubFontSize(sz)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold uppercase ${
                          subFontSize === sz ? 'bg-white text-slate-950' : 'bg-white/10 text-slate-300'
                        }`}
                      >
                        {sz}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">Font Colour</span>
                  <div className="flex items-center gap-2">
                    {[
                      { label: 'White', hex: '#FFFFFF' },
                      { label: 'Yellow', hex: '#FACC15' },
                      { label: 'Cyan', hex: '#38BDF8' },
                      { label: 'Green', hex: '#4ADE80' },
                    ].map((c) => (
                      <button
                        key={c.hex}
                        type="button"
                        onClick={() => setSubFontColor(c.hex)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${
                          subFontColor === c.hex ? 'border-white bg-white/15' : 'border-white/10 bg-white/5'
                        }`}
                        style={{ color: c.hex }}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">Background Opacity</span>
                  <div className="flex items-center gap-1.5">
                    {[0, 0.4, 0.65, 0.9].map((op) => (
                      <button
                        key={op}
                        type="button"
                        onClick={() => setSubBgOpacity(op)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-mono ${
                          Math.abs(subBgOpacity - op) < 0.05 ? 'bg-white text-slate-950 font-bold' : 'bg-white/10 text-slate-300'
                        }`}
                      >
                        {Math.round(op * 100)}%
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">Position & Style</span>
                  <div className="flex items-center gap-1.5">
                    {(['bottom', 'middle', 'top'] as const).map((pos) => (
                      <button
                        key={pos}
                        type="button"
                        onClick={() => setSubPosition(pos)}
                        className={`px-2 py-1 rounded-lg text-xs capitalize ${
                          subPosition === pos ? 'bg-white text-slate-950 font-semibold' : 'bg-white/10 text-slate-300'
                        }`}
                      >
                        {pos}
                      </button>
                    ))}
                    {(['shadow', 'outline', 'bold'] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setSubTextStyle(st)}
                        className={`px-2 py-1 rounded-lg text-xs capitalize ${
                          subTextStyle === st ? 'bg-amber-400 text-slate-950 font-semibold' : 'bg-white/10 text-slate-300'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                {/* Off Radio Item (Exact Match to Screenshot 3) */}
                <button
                  type="button"
                  data-testid="subtitle-option-off"
                  onClick={() => {
                    setSelectedSubTrack(-1);
                    setActivePanel('none');
                  }}
                  className="w-full py-2.5 px-1 rounded-xl hover:bg-white/5 flex items-center gap-3.5 text-left transition-colors"
                >
                  <span className="w-5 h-5 rounded-full border-2 border-white flex items-center justify-center shrink-0">
                    {selectedSubTrack === -1 && <span className="w-2.5 h-2.5 rounded-full bg-white" />}
                  </span>
                  <span className="text-base font-semibold text-white">Off</span>
                </button>

                {/* Actual Available Subtitle Tracks */}
                {availableSubtitleTracks.map((sub, idx) => {
                  const isSel = selectedSubTrack === idx;
                  return (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => {
                        setSelectedSubTrack(idx);
                        setActivePanel('none');
                      }}
                      className="w-full py-2.5 px-1 rounded-xl hover:bg-white/5 flex items-center gap-3.5 text-left transition-colors"
                    >
                      <span className="w-5 h-5 rounded-full border-2 border-white flex items-center justify-center shrink-0">
                        {isSel && <span className="w-2.5 h-2.5 rounded-full bg-white" />}
                      </span>
                      <span className="text-base font-medium text-white truncate">{sub.label}</span>
                    </button>
                  );
                })}

                {availableSubtitleTracks.length === 0 && (
                  <p className="text-xs text-slate-400 pl-8 py-1">
                    No embedded or external subtitle tracks found in this stream.
                  </p>
                )}

                {/* Load External Subtitle File (.SRT / .VTT / .ASS) */}
                <div className="pt-2 mt-1 border-t border-white/10 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs font-semibold text-amber-400 hover:text-amber-300 flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Load External Subtitle (.SRT / .VTT / .ASS)</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TV-LIKE RECOMMENDATION PANEL ("You May Also Like") */}
        {activePanel === 'recommendations' && (
          <div
            data-testid="recommendations-sheet"
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-4 bottom-3 z-40 bg-[#101823]/95 backdrop-blur-2xl border border-white/10 rounded-[28px] p-5 shadow-2xl text-white"
          >
            <div
              onClick={() => setActivePanel('none')}
              className="w-12 h-1.5 rounded-full bg-white/30 mx-auto mb-3 cursor-pointer"
            />
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base sm:text-lg font-bold text-white">You May Also Like</h3>
              <button
                type="button"
                onClick={() => setActivePanel('none')}
                className="text-xs text-slate-400 hover:text-white"
              >
                Close
              </button>
            </div>

            {recommendations.length === 0 ? (
              <p className="text-xs text-slate-400 py-4 text-center">
                No recommendations available for the current catalog.
              </p>
            ) : (
              <div className="flex items-start gap-3.5 overflow-x-auto pb-2">
                {recommendations.slice(0, 12).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActivePanel('none');
                      if (isLandscapeMode) exitLandscapeFullscreen();
                      onSelectRecommendation?.(item);
                    }}
                    className="group w-28 sm:w-32 shrink-0 text-left flex flex-col gap-1.5 focus:outline-none"
                  >
                    <div className="w-full aspect-[2/3] rounded-xl overflow-hidden bg-slate-900 border border-white/10 group-hover:border-amber-400 transition-colors">
                      {item.cover ? (
                        <img
                          src={item.cover}
                          alt={item.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-slate-500">
                          <Film className="w-6 h-6" />
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-amber-400 uppercase font-semibold">
                      <span>{item.type === 'anime' ? 'Anime' : 'Movie'}</span>
                      {item.year && (
                        <>
                          <span>•</span>
                          <span>{item.year}</span>
                        </>
                      )}
                    </div>
                    <span className="text-xs font-semibold text-white line-clamp-1 group-hover:text-amber-400">
                      {item.title}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}



        {/* Error Overlay with One-Click Recovery */}
        {errorMsg && (
          <div className="absolute inset-0 z-35 flex flex-col items-center justify-center bg-black/85 p-6 text-center gap-3">
            <AlertCircle className="w-10 h-10 text-rose-500" />
            <p className="text-sm text-slate-200 max-w-md">{errorMsg}</p>
            <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
              {sources.length > 1 && (
                <button
                  type="button"
                  onClick={() => onSelectSource((activeSourceIndex + 1) % sources.length)}
                  className="px-4 py-2 text-xs font-semibold bg-amber-500 text-slate-950 rounded-lg hover:bg-amber-400 transition-colors"
                >
                  Switch to Next Server
                </button>
              )}
              {onRequestProviderFailover && (
                <button
                  type="button"
                  onClick={() => {
                    setErrorMsg(null);
                    onRequestProviderFailover();
                  }}
                  className="px-4 py-2 text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/50 rounded-lg hover:bg-amber-500/30 transition-colors flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Auto-Switch Provider</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setErrorMsg(null);
                  setForceTranscode(true);
                }}
                className="px-4 py-2 text-xs font-semibold bg-slate-800 text-slate-100 border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors"
              >
                Force Live H.264 Remux
              </button>
            </div>
          </div>
        )}
        </div>
      </div>

      {/* DOWNLOAD OPTIONS BOTTOM SHEET (Only real supported servers, audio tracks & qualities) */}
      {activePanel === 'download' && activeSource && (
        <div
          onClick={() => setActivePanel('none')}
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Download Options"
            data-testid="realtime-download-popover"
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-md max-h-[85vh] overflow-y-auto bg-[#121215] border-t sm:border border-white/10 rounded-t-[28px] sm:rounded-[28px] px-5 pt-3 pb-7 shadow-2xl text-white flex flex-col gap-5"
          >
            {/* Top Drag Handle */}
            <div className="w-10 h-1 rounded-full bg-white/25 mx-auto shrink-0" />

            {/* Sheet Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold tracking-tight text-white">Download Options</h2>
              <button
                type="button"
                aria-label="Close download options"
                onClick={() => setActivePanel('none')}
                className="p-1.5 -mr-1.5 text-slate-300 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Media Preview Card */}
            <div className="bg-[#1A1A1E] border border-white/10 rounded-2xl p-3 flex items-center gap-3.5">
              <div className="w-24 aspect-video rounded-xl overflow-hidden bg-black shrink-0 border border-white/10">
                {episode?.thumbnail || poster ? (
                  <img
                    src={episode?.thumbnail || poster || ''}
                    alt={title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-500">
                    <Film className="w-5 h-5" />
                  </div>
                )}
              </div>
              <div className="flex flex-col min-w-0 gap-0.5">
                <span className="text-sm sm:text-base font-bold text-white line-clamp-1">{title}</span>
                {isSeries && episode && (
                  <span className="text-xs text-slate-400">
                    Season {seasonNumber} · Episode {episode.number}
                  </span>
                )}
              </div>
            </div>

            {/* SERVER SECTION (Deduplicated unique resolved Zangetsu servers) */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                <Server className="w-3.5 h-3.5" />
                <span>Server</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {groupedDownloadServers.map((group, idx) => {
                  const isSel = selectedServerGroup?.serverName === group.serverName;
                  return (
                    <button
                      key={group.serverName}
                      type="button"
                      data-testid={`download-server-pill-${idx}`}
                      onClick={() => {
                        const firstItem = group.items[0];
                        if (firstItem) {
                          setDownloadSourceIndex(firstItem.originalIndex);
                          setDownloadAudioIndex(0);
                        }
                      }}
                      className={`px-5 py-2 rounded-full text-sm transition-colors ${
                        isSel
                          ? 'bg-white text-black font-bold'
                          : 'bg-transparent border border-white/15 text-slate-200 hover:border-white/40 font-medium'
                      }`}
                    >
                      {group.serverName}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* LANGUAGE SECTION (Only genuinely detected/supported audio tracks for this server) */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                <Languages className="w-3.5 h-3.5" />
                <span>Language</span>
                {(isInspectingDownloadServer || (isDownloadSourceActive && isProbing)) && (
                  <Loader2 className="w-3 h-3 animate-spin text-slate-300" />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {supportedDownloadLanguages.map((lang) => {
                  const isSel = selectedDownloadAudioObj.index === lang.index;
                  return (
                    <button
                      key={`${lang.kind}-${lang.index}`}
                      type="button"
                      data-testid={`download-lang-pill-${lang.index}`}
                      onClick={() => setDownloadAudioIndex(lang.index)}
                      className={`px-4 py-2 rounded-full text-sm transition-colors ${
                        isSel
                          ? 'bg-white text-black font-bold'
                          : 'bg-transparent border border-white/15 text-slate-200 hover:border-white/40 font-medium'
                      }`}
                    >
                      {lang.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* AVAILABLE QUALITIES SECTION (Only real supported qualities & real container/size) */}
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                <span className="px-1 py-0.5 rounded border border-slate-500 text-[9px] font-extrabold leading-none">
                  HQ
                </span>
                <span>Available Qualities</span>
              </div>

              <div className="flex flex-col gap-2.5">
                {supportedDownloadQualities.map((q, idx) => (
                  <div
                    key={q.id}
                    data-testid={`download-quality-row-${idx}`}
                    className="bg-[#1A1A1E] border border-white/10 rounded-2xl px-4 py-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="text-base font-bold text-white leading-snug">
                        {q.label}
                      </span>
                      <span className="text-xs text-slate-400 font-mono tabular-nums truncate">
                        {q.containerLabel} · {q.sizeLabel}
                      </span>
                    </div>

                    <button
                      type="button"
                      data-testid={`download-quality-btn-${idx}`}
                      onClick={() => handleStartTrackedDownload(q)}
                      className="px-4 py-2 rounded-full border border-white/35 hover:bg-white hover:text-black text-white text-xs sm:text-sm font-semibold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Existing Alternative Server Selection & Auto Source Changer Bar below Player */}
      {!hideServerBar && sources.length > 0 && !offlineBlobUrl && (
        <div className="bg-[#11151F] border border-slate-800/80 rounded-xl p-3 flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <span className="italic text-slate-400">
                If current server is not working, try a different one:
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {onToggleAutoSwitch && (
                <button
                  type="button"
                  data-testid="auto-source-changer-toggle"
                  onClick={onToggleAutoSwitch}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                    autoSwitchEnabled
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400'
                  }`}
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Auto Source Changer: {autoSwitchEnabled ? 'ON' : 'OFF'}</span>
                </button>
              )}

              {onRequestProviderFailover && (
                <button
                  type="button"
                  data-testid="manual-provider-failover-btn"
                  disabled={isFailoverLoading}
                  onClick={onRequestProviderFailover}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-300 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isFailoverLoading ? 'animate-spin' : ''}`} />
                  <span>Auto-Switch Provider</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <span className="text-xs font-bold text-white shrink-0 mr-1">Servers :</span>
            {sources.map((src, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  pendingResumeTimeRef.current = effectiveCurrentTime > 2 ? effectiveCurrentTime : null;
                  onSelectSource(idx);
                }}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all shrink-0 ${
                  idx === activeSourceIndex
                    ? 'bg-white text-slate-950 shadow-sm'
                    : 'bg-[#090B10] border border-slate-800 text-slate-300 hover:border-slate-600'
                }`}
              >
                {src.server || `Server ${idx + 1}`}{' '}
                {src.quality && src.quality !== 'auto' ? `(${src.quality})` : ''}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
