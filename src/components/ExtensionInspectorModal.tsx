import React, { useEffect, useState } from 'react';
import { X, Code2, Terminal, RefreshCw, CheckCircle2 } from 'lucide-react';
import type { ZangetsuSourceInfo, RuntimeLogEntry } from '../types';

interface ExtensionInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  providers: ZangetsuSourceInfo[];
  activeSourceId: string;
  onSelectProvider: (sourceId: string) => void;
}

export const ExtensionInspectorModal: React.FC<ExtensionInspectorModalProps> = ({
  isOpen,
  onClose,
  providers,
  activeSourceId,
  onSelectProvider,
}) => {
  const [selectedTabId, setSelectedTabId] = useState(activeSourceId || 'hdhub4u');
  const [code, setCode] = useState<string>('Loading Zangetsu extension script...');
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setSelectedTabId(activeSourceId || 'hdhub4u');
    }
  }, [isOpen, activeSourceId]);

  const fetchInspectorData = (srcId: string) => {
    setLoading(true);
    fetch(`/api/zangetsu/code/${srcId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.code) setCode(data.code);
        if (data.logs) setLogs(data.logs);
      })
      .catch(() => setCode('// Failed to load provider script'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (isOpen && selectedTabId) {
      fetchInspectorData(selectedTabId);
    }
  }, [isOpen, selectedTabId]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Zangetsu JS Extension Runtime Inspector"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="bg-[#0E121B] border border-slate-800 rounded-2xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Code2 className="w-5 h-5 text-amber-400" />
            <div>
              <h2 className="text-base font-bold text-white">
                Zangetsu JS Extension Runtime Sandbox
              </h2>
              <p className="text-xs text-slate-400">
                Live execution environment running unmodified providers from Spyou/zangetsu-providers
              </p>
            </div>
          </div>

          <button
            type="button"
            aria-label="Close Runtime Inspector"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Provider Selector Bar */}
        <div className="px-6 py-3 bg-[#090B10] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedTabId(p.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-2 whitespace-nowrap shrink-0 ${
                  selectedTabId === p.id
                    ? 'bg-amber-500 text-slate-950 font-semibold'
                    : 'bg-[#131824] text-slate-300 hover:text-white border border-slate-800'
                }`}
              >
                <span>{p.name}</span>
                <span className="text-[10px] opacity-75 font-mono">v{p.version}</span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                onSelectProvider(selectedTabId);
                onClose();
              }}
              className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Use {selectedTabId.toUpperCase()} Catalog</span>
            </button>
            <button
              type="button"
              aria-label="Refresh runtime logs"
              onClick={() => fetchInspectorData(selectedTabId)}
              className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Split Body: Live Execution Trace & Actual Extension JS Source */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          {/* Left: Real-Time Resolver Execution Trace */}
          <div className="lg:col-span-5 border-b lg:border-b-0 lg:border-r border-slate-800 flex flex-col overflow-hidden bg-[#0B0E16]">
            <div className="px-4 py-2.5 border-b border-slate-800/80 flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Terminal className="w-3.5 h-3.5 text-amber-400" />
              <span>Real-Time Resolver Trace ({selectedTabId})</span>
            </div>
            <div className="flex-1 p-4 overflow-y-auto flex flex-col gap-2 font-mono text-xs">
              {logs.length === 0 ? (
                <p className="text-slate-500 text-xs">
                  No requests logged for {selectedTabId} yet. Switch to this provider to execute getHome() in the VM.
                </p>
              ) : (
                logs.map((log, i) => (
                  <div
                    key={i}
                    className="p-2.5 rounded-lg bg-[#121723] border border-slate-800/80 flex flex-col gap-1"
                  >
                    <div className="flex items-center justify-between text-[11px] text-amber-400">
                      <span className="font-semibold">{log.stage}</span>
                      {log.durationMs !== undefined && (
                        <span className="tabular-nums text-slate-400">{log.durationMs}ms</span>
                      )}
                    </div>
                    <p className="text-slate-200 break-all leading-relaxed text-[11px]">
                      {log.message}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right: Live Extension JS Code */}
          <div className="lg:col-span-7 flex flex-col overflow-hidden bg-[#090B10]">
            <div className="px-4 py-2.5 border-b border-slate-800/80 flex items-center justify-between text-xs text-slate-300">
              <span className="font-semibold">
                providers/{selectedTabId}.js (Loaded in Node VM Context)
              </span>
              <span className="font-mono tabular-nums text-slate-400">
                {code.length.toLocaleString()} bytes
              </span>
            </div>
            <pre className="flex-1 p-4 overflow-auto text-[11px] font-mono text-slate-300 leading-relaxed select-all">
              {code}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
