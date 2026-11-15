import React, { useEffect, useMemo, useState } from 'react';
import {
  Download,
  Play,
  Trash2,
  ChevronRight,
  ChevronDown,
  X,
  FolderDown,
  AlertCircle,
  Film,
  RefreshCw,
} from 'lucide-react';
import type { OfflineVaultRecord } from '../types';
import { formatBytesCompact, formatTransferSpeed } from '../utils/downloads';

interface OfflineDownloadsViewProps {
  records: OfflineVaultRecord[];
  onPlayOffline: (record: OfflineVaultRecord) => void;
  onDeleteOffline: (id: string) => void;
  onCancelOffline?: (id: string) => void;
  onRetryOffline?: (record: OfflineVaultRecord) => void;
  onBrowseCatalog: () => void;
}

export const OfflineDownloadsView: React.FC<OfflineDownloadsViewProps> = ({
  records,
  onPlayOffline,
  onDeleteOffline,
  onCancelOffline,
  onRetryOffline,
  onBrowseCatalog,
}) => {
  const [availableStorageLabel, setAvailableStorageLabel] = useState<string>('Checking storage...');
  const [manageMode, setManageMode] = useState<boolean>(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;
    const checkStorage = async () => {
      try {
        if (navigator.storage && typeof navigator.storage.estimate === 'function') {
          const est = await navigator.storage.estimate();
          const avail = Math.max(0, (est.quota || 0) - (est.usage || 0));
          if (active && avail > 0) {
            setAvailableStorageLabel(`${formatBytesCompact(avail)} available on this device`);
            return;
          }
        }
      } catch {
        // ignore storage API errors
      }
      if (active) {
        const used = records.reduce((acc, r) => acc + (r.sizeBytes || 0), 0);
        setAvailableStorageLabel(
          used > 0 ? `${formatBytesCompact(used)} stored offline` : 'Device offline vault ready'
        );
      }
    };
    void checkStorage();
    return () => {
      active = false;
    };
  }, [records]);

  const activeDownloads = useMemo(
    () => records.filter((r) => r.status === 'downloading'),
    [records]
  );

  const completedOrFailed = useMemo(
    () => records.filter((r) => r.status !== 'downloading'),
    [records]
  );

  const groupedCompleted = useMemo(() => {
    const groups = new Map<string, OfflineVaultRecord[]>();
    for (const rec of completedOrFailed) {
      const key = `${rec.sourceId}::${rec.title.toLowerCase()}`;
      const list = groups.get(key) || [];
      list.push(rec);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([key, items]) => ({
      key,
      title: items[0].title,
      cover: items.find((i) => i.cover)?.cover || null,
      items: items.sort((a, b) => a.episodeNumber - b.episodeNumber),
      totalBytes: items.reduce((sum, i) => sum + (i.sizeBytes || 0), 0),
    }));
  }, [completedOrFailed]);

  const handleSaveToDisk = (rec: OfflineVaultRecord) => {
    const ext = rec.fileExtension || (/\.mkv(\?|$)/i.test(rec.directUrl) && !rec.directUrl.includes('.m3u8') ? 'mkv' : 'mp4');
    const safeName = `${rec.title.replace(/[^a-zA-Z0-9]+/g, '_')}_E${rec.episodeNumber}_${rec.quality.replace(/[^a-zA-Z0-9]+/g, '')}.${ext}`;
    if (rec.blob) {
      const url = URL.createObjectURL(rec.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return;
    }
    const hdr = rec.headers ? encodeURIComponent(JSON.stringify(rec.headers)) : '';
    const dlUrl =
      rec.downloadEndpoint ||
      (rec.directUrl.includes('.m3u8')
        ? `/api/stream/remux?url=${encodeURIComponent(rec.directUrl)}&headers=${hdr}&download=1&filename=${encodeURIComponent(safeName)}`
        : `/api/proxy?url=${encodeURIComponent(rec.directUrl)}&headers=${hdr}&download=1&filename=${encodeURIComponent(safeName)}`);
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div
      data-testid="downloads-screen"
      className="max-w-4xl mx-auto px-4 sm:px-8 pt-6 pb-28 flex flex-col gap-6 min-h-screen bg-black text-white"
    >
      {/* Header matching OTT Downloads Screenshot */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">Downloads</h1>
          <p
            data-testid="downloads-storage-info"
            className="text-xs sm:text-sm text-slate-400 font-mono tabular-nums"
          >
            {availableStorageLabel}
          </p>
        </div>

        {records.length > 0 && (
          <button
            type="button"
            data-testid="downloads-manage-btn"
            aria-label={manageMode ? 'Done managing downloads' : 'Manage downloads'}
            onClick={() => setManageMode((v) => !v)}
            className={`p-2 rounded-xl transition-colors ${
              manageMode
                ? 'bg-white text-black'
                : 'text-slate-200 hover:text-white hover:bg-white/10'
            }`}
          >
            <Trash2 className="w-5 h-5" />
          </button>
        )}
      </div>

      {records.length === 0 ? (
        <div
          data-testid="downloads-empty-state"
          className="bg-[#141416] border border-white/10 rounded-2xl p-10 flex flex-col items-center justify-center text-center gap-4 mt-4"
        >
          <div className="w-12 h-12 rounded-full bg-white/10 flex items-center justify-center text-white">
            <Download className="w-6 h-6" />
          </div>
          <div className="flex flex-col gap-1 max-w-sm">
            <h2 className="text-base font-bold text-white">No Downloads Yet</h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Open any movie or episode and tap <strong className="text-white">Download</strong> to pick a supported quality and language with minimal MB usage.
            </p>
          </div>
          <button
            type="button"
            onClick={onBrowseCatalog}
            className="mt-1 px-6 py-2.5 bg-white hover:bg-slate-200 text-black font-bold text-xs rounded-full transition-colors whitespace-nowrap shrink-0"
          >
            Browse Titles
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {/* ACTIVE TRANSFERS (Real Progress Bar, Downloaded MB / Total MB, Live MB/s Speed) */}
          {activeDownloads.length > 0 && (
            <section aria-label="Active Downloads" className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base sm:text-lg font-medium text-slate-200">
                  Downloading <span className="font-mono tabular-nums ml-1">{activeDownloads.length}</span>
                </h2>
              </div>

              <div className="flex flex-col gap-3">
                {activeDownloads.map((rec) => {
                  const downloadedText = formatBytesCompact(rec.sizeBytes) || '0.0 MB';
                  const totalText =
                    rec.totalBytes && rec.totalBytes > 0 ? formatBytesCompact(rec.totalBytes) : '';
                  const speedText =
                    rec.sizeBytes === 0 && (rec.speedBytesPerSec || 0) === 0
                      ? 'Connecting...'
                      : formatTransferSpeed(rec.speedBytesPerSec || 0);
                  const pct =
                    rec.totalBytes && rec.totalBytes > 0
                      ? Math.min(100, Math.round((rec.sizeBytes / rec.totalBytes) * 100))
                      : rec.progress;

                  return (
                    <div
                      key={rec.id}
                      data-testid={`active-download-card-${rec.id}`}
                      className="bg-[#141416] border border-white/10 rounded-2xl p-3.5 flex flex-col gap-3"
                    >
                      <div className="flex items-center gap-3.5">
                        <div className="w-24 aspect-video rounded-xl overflow-hidden bg-black shrink-0 border border-white/10">
                          {rec.cover ? (
                            <img
                              src={rec.cover}
                              alt={rec.title}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-500">
                              <Film className="w-5 h-5" />
                            </div>
                          )}
                        </div>

                        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                          <h3 className="text-sm sm:text-base font-bold text-white truncate">
                            {rec.title}
                          </h3>
                          <p className="text-xs text-slate-400 truncate">
                            {(rec.isSeries ?? (rec.episodeNumber > 0 && rec.episodeTitle !== 'Full Movie'))
                              ? `S${rec.seasonNumber || 1} E${rec.episodeNumber} · `
                              : ''}
                            {rec.quality} · {rec.audioFormat}
                          </p>
                        </div>

                        {onCancelOffline && (
                          <button
                            type="button"
                            aria-label={`Cancel download for ${rec.title}`}
                            data-testid={`cancel-download-btn-${rec.id}`}
                            onClick={() => onCancelOffline(rec.id)}
                            className="p-2 rounded-full bg-white/10 hover:bg-rose-500/20 text-slate-200 hover:text-rose-300 transition-colors shrink-0"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>

                      {/* Real Progress Bar */}
                      <div className="flex flex-col gap-1.5">
                        <div className="w-full h-1.5 bg-white/15 rounded-full overflow-hidden">
                          <div
                            data-testid="download-progress-bar-fill"
                            className="h-full bg-white rounded-full transition-all duration-200"
                            style={{ width: `${Math.max(4, pct)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-300">
                          <span>
                            {totalText
                              ? `${downloadedText} / ${totalText} (${pct}%)`
                              : `${downloadedText} downloaded`}
                          </span>
                          <span data-testid="download-speed-label" className="text-white font-semibold">
                            {speedText}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* COMPLETED SECTION (Matching Screenshot: Completed N + Clean Dark Cards) */}
          {groupedCompleted.length > 0 && (
            <section aria-label="Completed Downloads" className="flex flex-col gap-3">
              <h2 className="text-base sm:text-lg font-medium text-slate-200">
                Completed <span className="font-mono tabular-nums ml-1">{groupedCompleted.length}</span>
              </h2>

              <div className="flex flex-col gap-3">
                {groupedCompleted.map((group) => {
                  const isSingle = group.items.length === 1;
                  const first = group.items[0];
                  const isExpanded = Boolean(expandedGroups[group.key]);
                  const totalSizeStr = formatBytesCompact(group.totalBytes);

                  if (isSingle) {
                    const isError = first.status === 'error';
                    return (
                      <div
                        key={group.key}
                        data-testid={`completed-download-card-${first.id}`}
                        className="bg-[#141416] border border-white/10 rounded-2xl p-3 flex flex-col gap-3"
                      >
                        <div className="flex items-center gap-3.5">
                          <button
                            type="button"
                            onClick={() => onPlayOffline(first)}
                            className="w-28 aspect-video rounded-xl overflow-hidden bg-black shrink-0 border border-white/10 relative group"
                          >
                            {group.cover ? (
                              <img
                                src={group.cover}
                                alt={group.title}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-500">
                                <Film className="w-5 h-5" />
                              </div>
                            )}
                            <span className="absolute inset-0 bg-black/35 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                              <Play className="w-6 h-6 text-white fill-white" />
                            </span>
                          </button>

                          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                            <h3 className="text-sm sm:text-base font-bold text-white truncate">
                              {group.title}
                            </h3>
                            <p className="text-xs text-slate-400 truncate font-mono tabular-nums">
                              {(first.isSeries ?? (first.episodeNumber > 0 && first.episodeTitle !== 'Full Movie'))
                                ? `S${first.seasonNumber || 1} E${first.episodeNumber} · `
                                : ''}
                              {first.quality} · {first.audioFormat}
                              {totalSizeStr ? ` · ${totalSizeStr}` : ''}
                            </p>
                            {isError && (
                              <div className="flex flex-wrap items-center gap-2 mt-1">
                                <p className="text-[11px] text-rose-400 flex items-center gap-1 min-w-0">
                                  <AlertCircle className="w-3 h-3 shrink-0" />
                                  <span className="truncate">{first.downloadError || 'Transfer interrupted'}</span>
                                </p>
                                {onRetryOffline && (
                                  <button
                                    type="button"
                                    data-testid={`retry-download-btn-${first.id}`}
                                    onClick={() => onRetryOffline(first)}
                                    className="px-2.5 py-0.5 rounded-full bg-white text-black font-bold text-[11px] inline-flex items-center gap-1 hover:bg-slate-200 transition-colors shrink-0"
                                  >
                                    <RefreshCw className="w-2.5 h-2.5" />
                                    <span>Retry</span>
                                  </button>
                                )}
                              </div>
                            )}
                          </div>

                          {manageMode ? (
                            <button
                              type="button"
                              aria-label={`Delete ${group.title}`}
                              onClick={() => onDeleteOffline(first.id)}
                              className="p-2 rounded-full bg-rose-500/15 text-rose-400 hover:bg-rose-500/25 shrink-0"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Options for ${group.title}`}
                              onClick={() => toggleGroup(group.key)}
                              className="p-1.5 text-slate-400 hover:text-white transition-colors shrink-0"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-5 h-5" />
                              ) : (
                                <ChevronRight className="w-5 h-5" />
                              )}
                            </button>
                          )}
                        </div>

                        {isExpanded && (
                          <div className="flex items-center gap-2 pt-2 border-t border-white/10">
                            {isError && onRetryOffline ? (
                              <button
                                type="button"
                                onClick={() => onRetryOffline(first)}
                                className="flex-1 py-2 rounded-full bg-white text-black font-bold text-xs flex items-center justify-center gap-1.5 hover:bg-slate-200 transition-colors"
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                                <span>Retry Download</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onPlayOffline(first)}
                                className="flex-1 py-2 rounded-full bg-white text-black font-bold text-xs flex items-center justify-center gap-1.5 hover:bg-slate-200 transition-colors"
                              >
                                <Play className="w-3.5 h-3.5 fill-current" />
                                <span>Play Offline</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleSaveToDisk(first)}
                              className="px-4 py-2 rounded-full border border-white/25 text-white font-semibold text-xs flex items-center gap-1.5 hover:bg-white/10 transition-colors"
                            >
                              <FolderDown className="w-3.5 h-3.5" />
                              <span>Save {(first.fileExtension || 'mp4').toUpperCase()}</span>
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete ${first.title}`}
                              onClick={() => onDeleteOffline(first.id)}
                              className="p-2 rounded-full border border-white/15 text-slate-300 hover:text-rose-400 hover:border-rose-400/40 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Multi-episode series card (matches "Stranger Things · N episodes · N downloaded >")
                  const completedCount = group.items.filter((i) => i.status === 'completed').length;
                  return (
                    <div
                      key={group.key}
                      className="bg-[#141416] border border-white/10 rounded-2xl overflow-hidden flex flex-col"
                    >
                      <div className="p-3 flex items-center gap-3.5">
                        <button
                          type="button"
                          onClick={() => toggleGroup(group.key)}
                          className="w-28 aspect-video rounded-xl overflow-hidden bg-black shrink-0 border border-white/10"
                        >
                          {group.cover ? (
                            <img
                              src={group.cover}
                              alt={group.title}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-500">
                              <Film className="w-5 h-5" />
                            </div>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => toggleGroup(group.key)}
                          className="flex-1 min-w-0 text-left flex flex-col gap-0.5"
                        >
                          <h3 className="text-sm sm:text-base font-bold text-white truncate">
                            {group.title}
                          </h3>
                          <p className="text-xs text-slate-400 truncate font-mono tabular-nums">
                            {group.items.length} episodes · {completedCount} downloaded
                            {totalSizeStr ? ` · ${totalSizeStr}` : ''}
                          </p>
                        </button>

                        {manageMode ? (
                          <button
                            type="button"
                            aria-label={`Delete all downloaded episodes for ${group.title}`}
                            onClick={() => group.items.forEach((ep) => onDeleteOffline(ep.id))}
                            className="p-2 rounded-full bg-rose-500/15 text-rose-400 hover:bg-rose-500/25 shrink-0"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            aria-label={`Expand ${group.title}`}
                            onClick={() => toggleGroup(group.key)}
                            className="p-1.5 text-slate-400 hover:text-white transition-colors shrink-0"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-5 h-5" />
                            ) : (
                              <ChevronRight className="w-5 h-5" />
                            )}
                          </button>
                        )}
                      </div>

                      {isExpanded && (
                        <div className="border-t border-white/10 divide-y divide-white/5 bg-black/30">
                          {group.items.map((ep) => {
                            const epSize = formatBytesCompact(ep.sizeBytes);
                            return (
                              <div
                                key={ep.id}
                                className="px-3.5 py-2.5 flex items-center justify-between gap-3"
                              >
                                <div className="flex flex-col min-w-0">
                                  <span className="text-xs sm:text-sm font-semibold text-white truncate">
                                    S{ep.seasonNumber || 1} E{ep.episodeNumber} · {ep.episodeTitle}
                                  </span>
                                  <span className="text-[11px] text-slate-400 font-mono tabular-nums">
                                    {ep.quality} · {ep.audioFormat}
                                    {epSize ? ` · ${epSize}` : ''}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    aria-label={`Play ${group.title} Episode ${ep.episodeNumber}`}
                                    onClick={() => onPlayOffline(ep)}
                                    className="px-3 py-1.5 rounded-full bg-white text-black font-bold text-[11px] flex items-center gap-1"
                                  >
                                    <Play className="w-3 h-3 fill-current" />
                                    <span>Play</span>
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Save MP4 for Episode ${ep.episodeNumber}`}
                                    onClick={() => handleSaveToDisk(ep)}
                                    className="p-1.5 rounded-full border border-white/20 text-slate-200 hover:text-white"
                                  >
                                    <FolderDown className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Delete Episode ${ep.episodeNumber}`}
                                    onClick={() => onDeleteOffline(ep.id)}
                                    className="p-1.5 rounded-full text-slate-400 hover:text-rose-400"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
};
