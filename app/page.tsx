'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { OTDRReport, FormatType, ExportFormat } from '@/lib/types';
import { parseOtdrReports, mergeWavelengthReports } from '@/lib/otdr-parser';
import { exportToExcel, exportToCsv, exportToJson } from '@/lib/export';
import { extractPagesFromPdf } from '@/lib/pdf-extract';

// ─── Icons (inline SVG to avoid dependency issues) ───

function IconUpload() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function IconSun() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function IconMoon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

// ─── Main App ───

type TabType = 'results' | 'thresholds' | 'equipment';

export default function OTDRAnalyzerPage() {
  const [files, setFiles] = useState<File[]>([]);
  const [reports, setReports] = useState<OTDRReport[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('xlsx');
  const [activeTab, setActiveTab] = useState<TabType>('results');
  const [isDragOver, setIsDragOver] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [debugText, setDebugText] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize theme from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('otdr-theme');
      if (saved === 'light' || saved === 'dark') setTheme(saved);
    } catch {}
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.className = `theme-${next}`;
    try { localStorage.setItem('otdr-theme', next); } catch {}
  };

  // Convenience: is it light mode?
  const L = theme === 'light';

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
  }, []);
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (droppedFiles.length > 0) {
      setFiles(prev => [...prev, ...droppedFiles]);
      setReports([]);
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (selected.length > 0) {
      setFiles(prev => [...prev, ...selected]);
      setReports([]);
    }
    e.target.value = '';
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
    setReports([]);
  };

  const clearAll = () => {
    setFiles([]); setReports([]); setErrors([]); setProgress(0); setStatusMsg('');
  };

  // Analysis
  const analyze = async () => {
    if (files.length === 0) return;
    setIsAnalyzing(true); setErrors([]); setProgress(0);
    const allReports: OTDRReport[] = [];
    const errs: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setProgress(((i) / files.length) * 100);
      setStatusMsg(`Analyzing: ${file.name} (${i + 1}/${files.length})`);
      try {
        const parsed = await parseOtdrReports(file, 'auto', (msg) => setStatusMsg(`${file.name}: ${msg}`));
        allReports.push(...parsed);
      } catch (e: any) {
        errs.push(`${file.name}: ${e.message || 'Unknown error'}`);
      }
    }

    setStatusMsg('Merging wavelength reports...');
    const merged = mergeWavelengthReports(allReports);
    setReports(merged);
    setErrors(errs);
    setProgress(100);
    setStatusMsg(`Analyzed ${merged.length} test record${merged.length !== 1 ? 's' : ''}`);
    setIsAnalyzing(false);
  };

  // Export
  const handleExport = () => {
    if (reports.length === 0) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = `otdr_results_${ts}`;
    switch (exportFormat) {
      case 'xlsx': exportToExcel(reports, `${base}.xlsx`); break;
      case 'csv': exportToCsv(reports, `${base}.csv`); break;
      case 'json': exportToJson(reports, `${base}.json`); break;
    }
  };

  // Filtered reports for search
  const filteredReports = searchTerm
    ? reports.filter(r =>
        r.filename.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.cable_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.fiber_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.location_a.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : reports;

  return (
    <div className="noise-bg min-h-screen flex flex-col">
      {/* Header */}
      <header className={`relative z-10 border-b backdrop-blur-sm ${L ? 'bg-[var(--bg-header)] border-black/5 shadow-sm' : 'bg-[var(--bg-header)] border-white/5'}`}>
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/otdr-icon.png" alt="OTDR" className="w-9 h-9 rounded-lg" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--text-heading)' }}>OTDR Analyzer</h1>
              <p className="text-[10px] font-mono tracking-widest uppercase" style={{ color: 'var(--accent-muted)' }}>v1.01 Web Edition</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded font-mono ${L ? 'bg-cyan-600/10 text-cyan-700' : 'bg-cyan-400/10 text-cyan-400'}`}>VIAVI</span>
              <span className={`px-2 py-0.5 rounded font-mono ${L ? 'bg-green-600/10 text-green-700' : 'bg-green-400/10 text-green-400'}`}>EXFO</span>
              <span className={`px-2 py-0.5 rounded font-mono ${L ? 'bg-orange-600/10 text-orange-700' : 'bg-orange-400/10 text-orange-400'}`}>Anritsu</span>
            </div>
            <button
              onClick={toggleTheme}
              className={`relative flex items-center w-[52px] h-[26px] rounded-full transition-all duration-300 ${
                L ? 'bg-gray-200' : 'bg-gray-700'
              }`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {/* Sun icon (left side, visible in light mode) */}
              <span className={`absolute left-[7px] top-1/2 -translate-y-1/2 transition-opacity duration-300 ${L ? 'opacity-50' : 'opacity-0'}`}>
                <IconSun />
              </span>
              {/* Moon icon (right side, visible in dark mode) */}
              <span className={`absolute right-[7px] top-1/2 -translate-y-1/2 transition-opacity duration-300 ${L ? 'opacity-0' : 'opacity-50'}`}>
                <IconMoon />
              </span>
              {/* Sliding dot */}
              <span className={`absolute top-[3px] w-[20px] h-[20px] rounded-full shadow-md transition-all duration-300 ${
                L ? 'left-[29px] bg-gray-700' : 'left-[3px] bg-gray-100'
              }`} />
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1 max-w-[1600px] mx-auto w-full px-6 py-6 flex flex-col gap-5">
        {/* Upload & Controls Row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Drop Zone */}
          <div
            className={`lg:col-span-2 border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200 ${
              isDragOver ? 'drop-zone-active' : ''
            }`}
            style={{
              borderColor: isDragOver ? 'var(--accent)' : 'var(--border-drop)',
              background: 'var(--bg-card)',
            }}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input ref={fileInputRef} type="file" accept=".pdf" multiple className="hidden" onChange={handleFileSelect} />
            <div className="flex flex-col items-center gap-3">
              <div style={{ color: 'var(--accent-muted)' }}><IconUpload /></div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Drop OTDR PDF reports here or <span style={{ color: 'var(--text-link)' }} className="underline underline-offset-2">browse files</span></p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-dim)' }}>Supports multi-page compiled reports — each test is auto-extracted</p>
              </div>
            </div>
          </div>

          {/* Controls Panel */}
          <div className="rounded-xl p-5 flex flex-col gap-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)', flexShrink: 0 }}>
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                Report format is auto-detected — supports VIAVI, EXFO, and Anritsu OTDR files
              </span>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider font-semibold block mb-2" style={{ color: 'var(--text-dim)' }}>Export Format</label>
              <div className="flex gap-2">
                {(['xlsx', 'csv', 'json'] as ExportFormat[]).map(fmt => (
                  <button
                    key={fmt}
                    onClick={() => setExportFormat(fmt)}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-mono uppercase transition-all ${
                      exportFormat === fmt
                        ? (L ? 'bg-cyan-100 text-cyan-700 border border-cyan-300' : 'bg-cyan-400/15 text-cyan-400 border border-cyan-400/30')
                        : ''
                    }`}
                    style={exportFormat !== fmt ? { background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' } : undefined}
                  >
                    .{fmt}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 mt-auto">
              <button
                onClick={analyze}
                disabled={files.length === 0 || isAnalyzing}
                className="flex-1 px-4 py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:from-cyan-400 hover:to-blue-500 shadow-lg shadow-cyan-500/20"
              >
                {isAnalyzing ? 'Analyzing...' : 'Analyze'}
              </button>
              <button
                onClick={handleExport}
                disabled={reports.length === 0}
                className="px-4 py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-2"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-input)', color: 'var(--text-secondary)' }}
              >
                <IconDownload /> Export
              </button>
            </div>
          </div>
        </div>

        {/* File List */}
        {files.length > 0 && (
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{files.length} PDF{files.length !== 1 ? 's' : ''} loaded</span>
              <button onClick={clearAll} className={`text-xs transition-colors ${L ? 'text-red-500/70 hover:text-red-600' : 'text-red-400/70 hover:text-red-400'}`}>Clear all</button>
            </div>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs group" style={{ background: 'var(--bg-input)', color: 'var(--text-secondary)' }}>
                  <IconFile />
                  <span className="max-w-[200px] truncate">{f.name}</span>
                  <button onClick={() => removeFile(i)} className={`opacity-0 group-hover:opacity-100 transition-all ml-1 ${L ? 'text-gray-400 hover:text-red-500' : 'text-gray-500 hover:text-red-400'}`}>
                    <IconX />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Progress Bar */}
        {isAnalyzing && (
          <div className="space-y-2">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-input)' }}>
              <div className="h-full fiber-progress-bar rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{statusMsg}</p>
          </div>
        )}

        {/* Status Messages */}
        {!isAnalyzing && statusMsg && (
          <p className="text-xs font-mono" style={{ color: 'var(--accent)' }}>{statusMsg}</p>
        )}
        {errors.length > 0 && (
          <div className={`rounded-lg p-3 ${L ? 'bg-red-50 border border-red-200' : 'bg-red-500/10 border border-red-500/20'}`}>
            <p className={`text-xs font-semibold mb-1 ${L ? 'text-red-700' : 'text-red-400'}`}>{errors.length} error{errors.length !== 1 ? 's' : ''}:</p>
            {errors.slice(0, 5).map((e, i) => (
              <p key={i} className={`text-xs font-mono ${L ? 'text-red-600' : 'text-red-300/80'}`}>{e}</p>
            ))}
          </div>
        )}

        {/* Results Table */}
        {reports.length > 0 && (
          <div className="flex-1 flex flex-col rounded-xl overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            {/* Tabs & Search */}
            <div className="flex items-center justify-between px-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="flex">
                {([
                  ['results', 'Results'],
                  ['thresholds', 'Thresholds'],
                  ['equipment', 'Equipment'],
                ] as [TabType, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key)}
                    className={`px-4 py-3 text-xs font-semibold uppercase tracking-wider transition-colors ${
                      activeTab === key ? 'tab-active' : ''
                    }`}
                    style={{ color: activeTab === key ? 'var(--accent)' : 'var(--text-dim)' }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 rounded-lg px-3 py-1.5" style={{ background: 'var(--bg-input)' }}>
                <span style={{ color: 'var(--text-dim)' }}><IconSearch /></span>
                <input
                  type="text"
                  placeholder="Filter results..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="bg-transparent text-xs focus:outline-none w-36"
                  style={{ color: 'var(--text-secondary)' }}
                />
              </div>
            </div>

            {/* Table */}
            <div className="flex-1 overflow-auto">
              {activeTab === 'results' && <ResultsTable reports={filteredReports} />}
              {activeTab === 'thresholds' && <ThresholdsTable reports={filteredReports} />}
              {activeTab === 'equipment' && <EquipmentTable reports={filteredReports} />}
            </div>

            <div className="px-4 py-2 text-xs font-mono" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-dim)' }}>
              {filteredReports.length} record{filteredReports.length !== 1 ? 's' : ''}
              {searchTerm && ` (filtered from ${reports.length})`}
            </div>
          </div>
        )}

        {/* Debug toggle */}
        {files.length > 0 && (
          <div className="group flex justify-end opacity-30 hover:opacity-100 transition-opacity duration-300">
            <button
              onClick={async () => {
                if (!showDebug && files.length > 0) {
                  const pages = await extractPagesFromPdf(files[0]);
                  setDebugText(pages.map((p, i) => `=== PAGE ${i + 1} ===\n${p.text}`).join('\n\n'));
                }
                setShowDebug(!showDebug);
              }}
              className="text-[9px] font-mono transition-colors px-2 py-0.5"
              style={{ color: 'var(--text-dim)' }}
              title="Show raw PDF text extraction (for troubleshooting)"
            >
              {showDebug ? '▼ hide debug' : '⚙ debug'}
            </button>
          </div>
        )}
        {showDebug && debugText && (
          <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <pre className="text-[11px] font-mono rounded-lg p-4 max-h-96 overflow-auto whitespace-pre-wrap break-all" style={{ background: 'var(--bg-debug)', color: 'var(--text-muted)' }}>
              {debugText}
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Results Table ───

function ResultsTable({ reports }: { reports: OTDRReport[] }) {
  return (
    <table className="otdr-table w-full">
      <thead>
        <tr>
          <th className="th-default text-left">Filename</th>
          <th className="th-default">Format</th>
          <th className="th-default">Fiber ID</th>
          <th className="th-1310">1310 Loss</th>
          <th className="th-1310">1310 ORL</th>
          <th className="th-1310">1310 Ev</th>
          <th className="th-1310">1310 Refl</th>
          <th className="th-1550">1550 Loss</th>
          <th className="th-1550">1550 ORL</th>
          <th className="th-1550">1550 Ev</th>
          <th className="th-1550">1550 Refl</th>
          <th className="th-peak">Length (ft)</th>
          <th className="th-peak">Peak Refl</th>
          <th className="th-peak">Peak ORL</th>
          <th className="th-default">Result</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((r, i) => (
          <tr key={i}>
            <td className="col-default text-left max-w-[220px] truncate" title={r.filename}>{r.filename}</td>
            <td className="col-default text-center">{r.format_type}</td>
            <td className="col-default text-center">{r.fiber_id || '—'}</td>
            <td className="col-1310 text-center">{r.results_1310 ? r.results_1310.link_loss_db.toFixed(3) : '—'}</td>
            <td className="col-1310 text-center">{r.results_1310 ? r.results_1310.link_orl_db.toFixed(2) : '—'}</td>
            <td className="col-1310 text-center">{r.results_1310?.events ?? '—'}</td>
            <td className="col-1310 text-center">{r.results_1310?.highest_reflectance_db?.toFixed(2) ?? '—'}</td>
            <td className="col-1550 text-center">{r.results_1550 ? r.results_1550.link_loss_db.toFixed(3) : '—'}</td>
            <td className="col-1550 text-center">{r.results_1550 ? r.results_1550.link_orl_db.toFixed(2) : '—'}</td>
            <td className="col-1550 text-center">{r.results_1550?.events ?? '—'}</td>
            <td className="col-1550 text-center">{r.results_1550?.highest_reflectance_db?.toFixed(2) ?? '—'}</td>
            <td className="col-peak text-center">{(r.link_length_ft || r.highest_fiber_end_ft).toFixed(2)}</td>
            <td className="col-peak text-center">{r.peak_reflectance_db?.toFixed(2) ?? '—'}</td>
            <td className="col-peak text-center">{r.peak_orl_db?.toFixed(2) ?? '—'}</td>
            <td className="text-center">
              {r.overall_result ? (
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                  r.overall_result === 'PASS' ? 'badge-pass' : 'badge-fail'
                }`}>
                  {r.overall_result}
                </span>
              ) : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Thresholds Table ───

function ThresholdsTable({ reports }: { reports: OTDRReport[] }) {
  return (
    <table className="otdr-table w-full">
      <thead>
        <tr>
          <th className="th-default text-left">Filename</th>
          <th className="th-default">Format</th>
          <th className="th-thresh">Connector (dB)</th>
          <th className="th-thresh">Splice (dB)</th>
          <th className="th-thresh">Reflectance (dB)</th>
          <th className="th-thresh">ORL (dB)</th>
          <th className="th-thresh">Link Loss Max (dB)</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((r, i) => (
          <tr key={i}>
            <td className="col-default text-left max-w-[280px] truncate" title={r.filename}>{r.filename}</td>
            <td className="col-default text-center">{r.format_type}</td>
            <td className="col-thresh text-center">{r.thresholds.connector_loss_db !== null ? `>${r.thresholds.connector_loss_db}` : '—'}</td>
            <td className="col-thresh text-center">{r.thresholds.splice_loss_db !== null ? `>${r.thresholds.splice_loss_db}` : '—'}</td>
            <td className="col-thresh text-center">{r.thresholds.reflectance_db !== null ? `>${r.thresholds.reflectance_db}` : '—'}</td>
            <td className="col-thresh text-center">{r.thresholds.orl_db !== null ? `<${r.thresholds.orl_db}` : '—'}</td>
            <td className="col-thresh text-center">{r.thresholds.link_loss_max_db !== null ? `>${r.thresholds.link_loss_max_db}` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Equipment Table ───

function EquipmentTable({ reports }: { reports: OTDRReport[] }) {
  return (
    <table className="otdr-table w-full">
      <thead>
        <tr>
          <th className="th-default text-left">Filename</th>
          <th className="th-default">Format</th>
          <th className="th-equip">Model 1</th>
          <th className="th-equip">Serial 1</th>
          <th className="th-equip">Model 2</th>
          <th className="th-equip">Serial 2</th>
          <th className="th-equip">Cal Date</th>
          <th className="th-equip">Cal Due</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((r, i) => (
          <tr key={i}>
            <td className="col-default text-left max-w-[280px] truncate" title={r.filename}>{r.filename}</td>
            <td className="col-default text-center">{r.format_type}</td>
            <td className="col-equip text-center">{r.model_1 || '—'}</td>
            <td className="col-equip text-center">{r.serial_1 || '—'}</td>
            <td className="col-equip text-center">{r.model_2 || '—'}</td>
            <td className="col-equip text-center">{r.serial_2 || '—'}</td>
            <td className="col-equip text-center">{r.calibration_date || '—'}</td>
            <td className="col-equip text-center">{r.calibration_due || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
