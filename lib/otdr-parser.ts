/**
 * OTDR Report Parser v8.4 - Web Edition
 * Complete port of Python OTDR Analyzer v8.0 parsing engine.
 * Supports: VIAVI (dual, single, compiled), EXFO (legacy, FTBx, iOLM),
 *           Anritsu MT9083, Anritsu MT9085 (dual + compiled single-wavelength)
 *
 * v8.4 Changes:
 * - Fixed VIAVI SmartOTDR vertical fallback: accept negative fiber_end values
 *   (short fiber runs with negative distance offsets)
 * - Fixed VIAVI event table wavelength detection for pdf.js vertical layout
 *   where "EXPERT" and "1310nm" appear on separate lines
 * - Added fiber_end_ft from Fiber End markers (e.g., "385.91 ft") as fallback
 *   when summary fiber_end is negative
 * - Improved event data parsing for pdf.js vertical layout with tilde prefixes
 *
 * v8.3 Changes (synced from Python v8.0):
 * - Added mid-line wavelength patterns for VIAVI (filename text before wavelength)
 * - ORL ">" prefix stripping in VIAVI summary lines
 * - VIAVI event table: SMART format wavelength detection
 * - Direction lookahead from next line for VIAVI patternNoDir
 * - EXFO iOLM: improved Identifiers table parsing with 3-tier fallback
 * - EXFO iOLM: added Filename, JobID, Company, Operator, pass/fail extraction
 * - EXFO iOLM: added Pass/Fail Thresholds ORL + link loss max
 * - Anritsu MT9085 compiled: OCR wavelength fallback (bare "1310 nm")
 * - Anritsu MT9085 compiled: OCR positive-value reflectance fix (missing minus)
 * - Anritsu MT9085 compiled: OCR artifacts cleanup (~, —, GM, ENA)
 * - Anritsu MT9085 compiled: Instrument/calibration OCR fallbacks
 * - Anritsu MT9085 compiled: Customer OCR fallback (> instead of :)
 * - Anritsu MT9085 compiled: thresholds now check event+trace+combined pages
 * - Wavelength merger: mid-filename and _1310nm stripping patterns
 * - Tesseract.js OCR fallback for fully image-based PDFs
 */

import {
  OTDRReport, OTDRResult, Thresholds, FormatType,
  createDefaultReport, createDefaultThresholds, createOTDRResult
} from './types';
import { extractTextFromPdf, extractPagesFromPdf, PageText } from './pdf-extract';

// ─── Helper Functions ───

function normalizeTestName(name: string): string {
  name = name.trim();
  name = name.replace(/\b([A-Z]{2})\s+(\d+)$/g, '$1$2');
  name = name.replace(/\b([A-Z]{2})\s+(\d+)\s/g, '$1$2 ');
  return name;
}

function filterReflectancePairs(pairs: [number, number][]): number | null {
  if (pairs.length === 0) return null;
  const total = pairs.length;
  let filtered: number[];
  if (total >= 4) {
    const firstEv = Math.min(...pairs.map(([ev]) => ev));
    const lastEv = Math.max(...pairs.map(([ev]) => ev));
    filtered = pairs.filter(([ev]) => ev !== firstEv && ev !== lastEv).map(([, r]) => r);
    if (filtered.length === 0) filtered = pairs.map(([, r]) => r);
  } else {
    filtered = pairs.map(([, r]) => r);
  }
  return Math.max(...filtered); // closest to 0 = worst
}

function calcPeaks(report: OTDRReport): void {
  const reflValues: number[] = [];
  if (report.results_1310?.highest_reflectance_db != null) reflValues.push(report.results_1310.highest_reflectance_db);
  if (report.results_1550?.highest_reflectance_db != null) reflValues.push(report.results_1550.highest_reflectance_db);
  if (reflValues.length > 0) report.peak_reflectance_db = Math.max(...reflValues);

  const orlValues: number[] = [];
  if (report.results_1310) orlValues.push(report.results_1310.link_orl_db);
  if (report.results_1550) orlValues.push(report.results_1550.link_orl_db);
  if (orlValues.length > 0) report.peak_orl_db = Math.max(...orlValues);
}

function calcLinkLength(report: OTDRReport): void {
  const ends = [report.results_1310, report.results_1550]
    .filter((r): r is OTDRResult => r !== null)
    .map(r => r.fiber_end_ft);
  if (ends.length > 0) {
    report.highest_fiber_end_ft = Math.max(...ends);
    report.link_length_ft = report.highest_fiber_end_ft;
  }
}

function matchGroup(text: string, pattern: RegExp, group: number = 1): string | null {
  const m = text.match(pattern);
  return m ? m[group]?.trim() || null : null;
}

function matchFloat(text: string, pattern: RegExp, group: number = 1): number | null {
  const s = matchGroup(text, pattern, group);
  return s !== null ? parseFloat(s) : null;
}

function matchInt(text: string, pattern: RegExp, group: number = 1): number | null {
  const s = matchGroup(text, pattern, group);
  return s !== null ? parseInt(s, 10) : null;
}

// ─── Format Detection ───

export function detectFormat(text: string): FormatType {
  const tl = text.toLowerCase();

  if (tl.includes('mt9085') || (tl.includes('trace summary report') && tl.includes('test result summary'))) {
    return 'ANRITSU_MT9085';
  }
  if (tl.includes('mt9083') || (tl.includes('test result summary') && tl.includes('pass/fail thresholds') && tl.includes('test information'))) {
    return 'ANRITSU';
  }
  if (tl.includes('iolm report')) return 'EXFO_IOLM';
  if (/otdr\s*report\s*\(\d{4}\s*nm/.test(tl) && tl.includes('spanlength') && tl.includes('spanloss')) {
    return 'EXFO_FTBX';
  }
  if (tl.includes('ftbx-') || tl.includes('ftb-')) return 'EXFO_FTBX';
  if (tl.includes('exfo') || tl.includes('max-7')) return 'EXFO';
  if (tl.includes('print date') && tl.includes('jdsu')) return 'VIAVI_SINGLE';
  if ((tl.includes('t-berd') || tl.includes('jdsu')) && tl.includes('laser') && tl.includes('link loss')) {
    if (/filename\s+laser\s+link\s*loss/.test(tl)) return 'VIAVI_SINGLE';
  }
  if (tl.includes('viavi') || tl.includes('t-berd') || tl.includes('otdr expert')) return 'VIAVI';
  // SmartOTDR / FTTA / E100AS are VIAVI devices not detected by the above
  if (tl.includes('smartotdr') || tl.includes('e100as') || (tl.includes('ftta') && tl.includes('laser'))) return 'VIAVI';
  if (tl.includes('wavelength (nm)') && tl.includes('link length:')) return 'EXFO';
  if (tl.includes('laser nm') && tl.includes('fiber end ft')) return 'VIAVI';
  // pdf.js may split "Laser nm" and "Fiber End ft" across lines
  if (tl.includes('laser') && tl.includes('link loss') && tl.includes('fiber')) return 'VIAVI';
  // EXFO FTBx pdf.js: headers split across lines
  if (/otdr\s*report\s*\(\d{4}\s*nm/.test(tl) && tl.includes('span') && tl.includes('loss')) return 'EXFO_FTBX';

  return 'VIAVI'; // fallback
}

// ─── VIAVI Standard Parser ───

function parseViaviReport(text: string, filename: string, pages: PageText[]): OTDRReport {
  const report = createDefaultReport(filename, 'VIAVI');

  // Header info
  let m: string | null;
  m = matchGroup(text, /Cable\s*Id\s*:?\s*([^\n]+?)(?:\s+Fiber|$)/i);
  if (m) report.cable_id = m;

  m = matchGroup(text, /Fiber\s*Id(?:\/Number)?\s*:?\s*([^\n]+)/i);
  if (m) {
    let fid = m.replace(/\s+Location\s*$/i, '').trim();
    if (fid) report.fiber_id = fid;
  }

  m = matchGroup(text, /Location\s*A\s*:\s*([^\n]+?)(?:\s+Location\s*B|$)/i);
  if (m) report.location_a = m;
  else {
    m = matchGroup(text, /([A-Z][A-Z\s]+?)\n\s*Location\s*A\s*:/i);
    if (m) report.location_a = m;
  }

  m = matchGroup(text, /Location\s*B\s*:\s*([^\n]+?)(?:\s+Job|$)/i);
  if (m) report.location_b = m;
  else {
    m = matchGroup(text, /Location\s*B\s*:\s*\n([^\n]+)/i);
    if (m) report.location_b = m;
  }

  m = matchGroup(text, /Job\s*Id\s*:?\s*(\w+)/i); if (m) report.job_id = m;
  m = matchGroup(text, /Technician\s*Id\s*:?\s*(\w+)/i); if (m) report.technician_id = m;
  m = matchGroup(text, /Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4}(?:\s*\d{1,2}:\d{2})?)/i); if (m) report.test_date = m;

  // Equipment - match T-BERD, SmartOTDR, ONA-800, etc.
  const equipMatch = text.match(/(T-BERD\s*\d+|SmartOTDR|ONA-\d+)\s*\(S\/N\s*(\d+)\)/i);
  if (equipMatch) { report.model_1 = equipMatch[1].trim(); report.serial_1 = equipMatch[2].trim(); }
  const moduleMatch = text.match(/([A-Z]\d+[A-Z0-9]*)\s*\(S\/N\s*(\d+)\)/);
  if (moduleMatch && moduleMatch[1] !== report.serial_1) { report.model_2 = moduleMatch[1].trim(); report.serial_2 = moduleMatch[2].trim(); }

  // Calibration - accept MM/DD/YYYY, YYYY/M/D, and YYYY-Mon-DD formats
  m = matchGroup(text, /[Cc]alibration\s*[Dd]ate\s*:?\s*(\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4})/); if (m) report.calibration_date = m;
  m = matchGroup(text, /[Cc]alibration\s*[Dd]ue\s*:?\s*(\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4})/); if (m) report.calibration_due = m;

  // Thresholds
  let v: number | null;
  v = matchFloat(text, /Connector\s*Loss\s*\(dB\)\s*>?\s*([\d.]+)/i); if (v !== null) report.thresholds.connector_loss_db = v;
  v = matchFloat(text, /Splice\s*Loss\s*\(dB\)\s*>?\s*([\d.]+)/i); if (v !== null) report.thresholds.splice_loss_db = v;
  v = matchFloat(text, /Reflectance\s*\(dB\)\s*>?\s*(-?[\d.]+)/i); if (v !== null) report.thresholds.reflectance_db = v;
  v = matchFloat(text, /ORL\s*\(dB\)\s*<?\s*([\d.]+)/i); if (v !== null) report.thresholds.orl_db = v;
  v = matchFloat(text, /Link\s*Loss\s*Max\.?\s*\(dB\)\s*>?\s*([\d.]+)/i); if (v !== null) report.thresholds.link_loss_max_db = v;

  // Wavelength results
  // Pre-process: strip ">" from ORL values (e.g., "> 29.38" -> "29.38")
  const lines = text.split('\n').map(l => l.replace(/>\s*([\d.]+)/g, '$1'));
  const patternWithDir = /^(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.\-]+)\s+(.+?(?:->|<-).+?)\s+([\d.\-]+)\s+(\d+)\s*$/;
  const patternDirNoAvg = /^(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.\-]+)\s+(.+?(?:->|<-).+?)\s+(\d+)\s*$/;
  const patternNoDir = /^(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+(\d+)\s*$/;
  // Mid-line patterns: wavelength appears after filename text (not at start of line)
  // e.g., "BAND_ALPHA_OPT1_BBU to RRU 1310 1.562 37.64 3764.97 RRH <- BBU 1.361 6"
  const patternMidlineAvg = /\b(1[35][15]0)\s+([\d.\-]+)\s+([\d.]+)\s+([\d.\-]+)\s+(.+?(?:->|<-).+?)\s+([\d.\-]+)\s+(\d+)\s*$/;
  const patternMidlineNoAvg = /\b(1[35][15]0)\s+([\d.\-]+)\s+([\d.]+)\s+([\d.\-]+)\s+(.+?(?:->|<-).+?)\s+(\d+)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    let match: RegExpMatchArray | null;

    match = line.match(patternWithDir);
    if (match) {
      const [, wlS, loss, orl, end, direction, , events] = match;
      const wl = parseInt(wlS);
      if (wl === 1310 || wl === 1550) {
        const result: OTDRResult = {
          wavelength_nm: wl, link_loss_db: parseFloat(loss), link_orl_db: parseFloat(orl),
          fiber_end_ft: parseFloat(end), direction: direction.trim(), events: parseInt(events),
          passed: true, highest_reflectance_db: null
        };
        if (wl === 1310 && !report.results_1310) report.results_1310 = result;
        else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
      }
      continue;
    }

    match = line.match(patternDirNoAvg);
    if (match) {
      const [, wlS, loss, orl, end, direction, events] = match;
      const wl = parseInt(wlS);
      if (wl === 1310 || wl === 1550) {
        const result: OTDRResult = {
          wavelength_nm: wl, link_loss_db: parseFloat(loss), link_orl_db: parseFloat(orl),
          fiber_end_ft: parseFloat(end), direction: direction.trim(), events: parseInt(events),
          passed: true, highest_reflectance_db: null
        };
        if (wl === 1310 && !report.results_1310) report.results_1310 = result;
        else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
      }
      continue;
    }

    match = line.match(patternNoDir);
    if (match) {
      const [, wlS, loss, orl, end, , events] = match;
      const wl = parseInt(wlS);
      if (wl === 1310 || wl === 1550) {
        let direction = '';
        if (i > 0) {
          const prevLine = lines[i - 1].trim();
          if (prevLine.includes('->') || prevLine.includes('<-')) direction = prevLine;
        }
        if (i < lines.length - 1) {
          const nextLine = lines[i + 1].trim();
          if (nextLine && !/^\d{4}\s+/.test(nextLine) && !/^Alarm/i.test(nextLine)) {
            if (direction) direction = `${direction} ${nextLine}`;
            else if (nextLine.includes('->') || nextLine.includes('<-')) direction = nextLine;
          }
        }
        const result: OTDRResult = {
          wavelength_nm: wl, link_loss_db: parseFloat(loss), link_orl_db: parseFloat(orl),
          fiber_end_ft: parseFloat(end), direction, events: parseInt(events),
          passed: true, highest_reflectance_db: null
        };
        if (wl === 1310 && !report.results_1310) report.results_1310 = result;
        else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
      }
      continue;
    }

    // Try mid-line patterns (wavelength after filename text)
    // e.g., "BAND_ALPHA_OPT1_BBU to RRU 1310 1.562 37.64 3764.97 RRH <- BBU 1.361 6"
    match = line.match(patternMidlineAvg);
    if (match) {
      const [, wlS, loss, orl, end, direction, , events] = match;
      const wl = parseInt(wlS);
      if (wl === 1310 || wl === 1550) {
        const result: OTDRResult = {
          wavelength_nm: wl, link_loss_db: parseFloat(loss), link_orl_db: parseFloat(orl),
          fiber_end_ft: parseFloat(end), direction: direction.trim(), events: parseInt(events),
          passed: true, highest_reflectance_db: null
        };
        if (wl === 1310 && !report.results_1310) report.results_1310 = result;
        else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
      }
      continue;
    }

    match = line.match(patternMidlineNoAvg);
    if (match) {
      const [, wlS, loss, orl, end, direction, events] = match;
      const wl = parseInt(wlS);
      if (wl === 1310 || wl === 1550) {
        const result: OTDRResult = {
          wavelength_nm: wl, link_loss_db: parseFloat(loss), link_orl_db: parseFloat(orl),
          fiber_end_ft: parseFloat(end), direction: direction.trim(), events: parseInt(events),
          passed: true, highest_reflectance_db: null
        };
        if (wl === 1310 && !report.results_1310) report.results_1310 = result;
        else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
      }
      continue;
    }

    // Pattern: "1310  0.207  43.47  200.55" — only wl + loss + orl + fiberEnd on the line
    // Direction, avg_loss, events are on following lines
    const patternPartial = /^(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s*$/;
    match = line.match(patternPartial);
    if (match) {
      const wl = parseInt(match[1]);
      if (wl === 1310 || wl === 1550) {
        const loss = parseFloat(match[2]);
        const orl = parseFloat(match[3]);
        const fiberEnd = parseFloat(match[4]);
        // Validate: ORL should be > 10 (not a random 4-number line)
        if (orl > 10) {
          // Scan following lines for event count
          let events = 0;
          let foundDir = false;
          for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            const val = lines[j].trim();
            if (/^(Alarms|Thresholds|Page|1\/5)/i.test(val)) break;
            if (val.includes('->') || val.includes('<-')) { foundDir = true; continue; }
            if (/^\d{1,2}$/.test(val)) {
              const n = parseInt(val);
              if (foundDir || n >= 2) events = n;
            }
          }
          const result: OTDRResult = {
            wavelength_nm: wl, link_loss_db: loss, link_orl_db: orl,
            fiber_end_ft: fiberEnd, direction: '', events,
            passed: true, highest_reflectance_db: null
          };
          if (wl === 1310 && !report.results_1310) report.results_1310 = result;
          else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
        }
      }
    }
  }

  // Legacy fallback (horizontal) — run if either wavelength is still missing
  if (!report.results_1310 || !report.results_1550) {
    // Pattern: ".msor 1310 0.207 43.47 200.55 ... 5" or standalone "1310 0.207 43.47 200.55 ... 5"
    const patternData = /(?:[\w\s\-\.]+\.msor\s+)?(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)/;
    // Also match .msor with data + direction + avg_loss + events on same line
    const patternMsorFull = /\.(?:msor|sor)\s+(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+.+?\s+([\d.\-]+)\s+(\d+)\s*$/;
    // Pattern: ".msor  1310  0.504  39.53  263.38" — 3 data values, no events (events on following lines)
    const patternMsorPartial = /\.(?:msor|sor)\s+(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s*$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match = line.match(patternData);
      if (!match) {
        const mfMatch = line.match(patternMsorFull);
        if (mfMatch) match = mfMatch;
      }
      if (match) {
        const wl = parseInt(match[1]);
        if (wl === 1310 || wl === 1550) {
          let direction = '';
          if (i > 0) {
            const prevLine = lines[i - 1].trim();
            if (prevLine.includes('->') || prevLine.includes('<-')) direction = prevLine;
          }
          const result: OTDRResult = {
            wavelength_nm: wl, link_loss_db: parseFloat(match[2]), link_orl_db: parseFloat(match[3]),
            fiber_end_ft: parseFloat(match[4]), direction, events: parseInt(match[match.length - 1]),
            passed: true, highest_reflectance_db: null
          };
          if (wl === 1310 && !report.results_1310) report.results_1310 = result;
          else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
        }
        continue;
      }
      // Try partial .msor pattern (no events on line)
      const mpMatch = line.match(patternMsorPartial);
      if (mpMatch) {
        const wl = parseInt(mpMatch[1]);
        const orl = parseFloat(mpMatch[3]);
        if ((wl === 1310 || wl === 1550) && orl > 10) {
          // Scan forward for events
          let events = 0;
          let foundDir = false;
          for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            const val = lines[j].trim();
            if (/^(Alarms|Thresholds|Page|1\/5|0\.00)/i.test(val)) break;
            if (val.includes('->') || val.includes('<-')) { foundDir = true; continue; }
            if (/^\d{1,2}$/.test(val)) {
              const n = parseInt(val);
              if (foundDir || n >= 2) events = n;
            }
          }
          const result: OTDRResult = {
            wavelength_nm: wl, link_loss_db: parseFloat(mpMatch[2]), link_orl_db: orl,
            fiber_end_ft: parseFloat(mpMatch[4]), direction: '', events,
            passed: true, highest_reflectance_db: null
          };
          if (wl === 1310 && !report.results_1310) report.results_1310 = result;
          else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
        }
      }
    }
  }

  // pdf.js vertical fallback: wavelength data on separate lines
  // Pattern A: "1310\n0.345\n43.62\n261.29\n...direction...\n6"
  // Pattern B: "filename.msor 1310\n0.207\n43.47\n200.55\n...direction...\n5"
  if (!report.results_1310 || !report.results_1550) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      let wl: number | null = null;
      let dataStartIdx = i + 1;

      // Pattern A: standalone wavelength line
      if (/^(1310|1550)$/.test(line)) {
        wl = parseInt(line);
      }
      // Pattern B: wavelength at end of .msor/.sor line
      const msorMatch = line.match(/\.(?:msor|sor)\s+(1310|1550)\s*$/);
      if (msorMatch) {
        wl = parseInt(msorMatch[1]);
      }

      if (wl && (wl === 1310 || wl === 1550)) {
        // Next 3 lines should be loss, orl, fiber_end (all numeric, loss can be negative)
        const lossStr = lines[dataStartIdx]?.trim() || '';
        const orlStr = lines[dataStartIdx + 1]?.trim() || '';
        const fiberEndStr = lines[dataStartIdx + 2]?.trim() || '';
        const loss = parseFloat(lossStr);
        const orl = parseFloat(orlStr);
        const fiberEnd = parseFloat(fiberEndStr);
        if (isNaN(loss) || isNaN(orl) || isNaN(fiberEnd)) continue;
        // Validate: ORL should be > 10 (sanity check to avoid false matches)
        // fiberEnd can be negative for SmartOTDR short runs with negative distance offsets
        if (orl < 10) continue;
        // Find event count: scan forward for standalone small number
        // The pattern after fiber_end is: direction lines (may wrap), avg_loss, event_count
        // We want the LAST standalone 1-2 digit number before Alarms/section marker
        let events = 0;
        let foundDirection = false;
        for (let j = dataStartIdx + 3; j < Math.min(dataStartIdx + 15, lines.length); j++) {
          const val = lines[j].trim();
          if (/^(Alarms|Thresholds|Page|1\/5)/i.test(val)) break;
          if (val.includes('->') || val.includes('<-')) { foundDirection = true; continue; }
          // After direction, may have continuation text, then avg_loss, then event count
          if (/^\d{1,2}$/.test(val)) {
            const n = parseInt(val);
            // Only accept as event count if we've passed the direction section
            // or if n >= 2 (a "1" right after direction is likely a name fragment)
            if (foundDirection || n >= 2) events = n;
          }
        }
        const result: OTDRResult = {
          wavelength_nm: wl, link_loss_db: loss, link_orl_db: orl,
          fiber_end_ft: fiberEnd, direction: '', events,
          passed: true, highest_reflectance_db: null
        };
        if (wl === 1310 && !report.results_1310) report.results_1310 = result;
        else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
      }
    }
  }

  calcLinkLength(report);

  // Parse Event Tables for reflectance from individual pages
  for (const page of pages) {
    const pageText = page.text;
    const wlMatch = pageText.match(/(?:OTDR|EXPERT|FTTA|SMART)\s+(?:EXPERT\s+|FTTA\s+|SMART\s+)?(\d{4})nm/);
    // Also try the Test Setup line format: "EXPERT 1310nm 5ns 5km" or "SMART 1310nm 10ns"
    let wavelength = wlMatch ? parseInt(wlMatch[1]) : null;
    if (!wavelength) {
      const wlMatch1b = pageText.match(/(?:EXPERT|OTDR|SMART)\s+(\d{4})nm\s+\d+ns/);
      if (wlMatch1b) wavelength = parseInt(wlMatch1b[1]);
    }
    // Also try pdf.js vertical: "OTDR\n1310nm" or "OTDR\n1550nm"
    if (!wavelength) {
      const wlMatch2 = pageText.match(/OTDR\n(\d{4})nm/);
      if (wlMatch2) wavelength = parseInt(wlMatch2[1]);
    }
    // pdf.js vertical with split: "EXPERT\n1310nm\n5ns" or just standalone "1310nm" or "1550nm"
    if (!wavelength) {
      const wlMatch3 = pageText.match(/(?:EXPERT|SMART|FTTA|OTDR)\n(\d{4})nm/);
      if (wlMatch3) wavelength = parseInt(wlMatch3[1]);
    }
    // Last resort: find standalone "1310nm" or "1550nm" on its own line within Test Setup section
    if (!wavelength) {
      const testSetupIdx = pageText.indexOf('Test Setup');
      const summaryIdx = pageText.indexOf('Summary');
      if (testSetupIdx >= 0 && summaryIdx > testSetupIdx) {
        const setupBlock = pageText.substring(testSetupIdx, summaryIdx);
        const wlMatch4 = setupBlock.match(/^(\d{4})nm$/m);
        if (wlMatch4) wavelength = parseInt(wlMatch4[1]);
      }
    }
    if (!wavelength) continue;

    const eventReflPairs: [number, number][] = [];
    let totalEvents = 0;
    const pLines = pageText.split('\n');
    let inEventTable = false;

    // Try horizontal event table first (pdfplumber)
    for (const pLine of pLines) {
      if (pLine.includes('Event') && pLine.includes('Distance') && pLine.includes('Reflect')) {
        inEventTable = true; continue;
      }
      if (inEventTable) {
        if (pLine.trim().startsWith('ft') || pLine.trim().startsWith('dB')) continue;
        if (pLine.trim().startsWith('Page') || !pLine.trim()) break;
        const evMatch = pLine.match(/^\s*(\d{1,2})\s+/);
        if (!evMatch) continue;
        const eventNum = parseInt(evMatch[1]);
        totalEvents = Math.max(totalEvents, eventNum);
        const parts = pLine.split(/\s+/);
        let reflVal: number | null = null;
        for (const p of parts.slice(2)) {
          const cleaned = p.replace(/^>/, '');
          if (cleaned.startsWith('-') && cleaned.includes('.')) {
            const val = parseFloat(cleaned);
            if (!isNaN(val) && val < -14.0) {
              if (reflVal === null || val > reflVal) reflVal = val;
            }
          }
        }
        if (reflVal !== null) eventReflPairs.push([eventNum, reflVal]);
      }
    }

    // pdf.js vertical event table fallback
    // Pattern: "Event\nDistance\nLoss\nReflect.\n...\n1\n-3279.90\n~ 0.323\n~\n0.00\n2\n..."
    if (eventReflPairs.length === 0) {
      let inEvt = false;
      let evtDataValues: string[] = [];
      for (const pLine of pLines) {
        const l = pLine.trim();
        if (l === 'Event' || (l.includes('Event') && l.includes('Distance'))) { inEvt = true; continue; }
        if (inEvt) {
          if (l.startsWith('Page') || l === '') break;
          // Skip header labels and units
          if (/^(Distance|Loss|Reflect\.|Slope|Section|T\. Loss|ft|dB|dB\/km)$/.test(l)) continue;
          // Collect data values: numbers, negative numbers, tilde-prefixed, "End"
          // Clean tilde prefix: "~ 0.323" -> "0.323", standalone "~" -> skip
          if (l === '~') continue;
          const cleaned = l.replace(/^~\s*/, '').replace(/^>\s*/, '');
          if (/^-?[\d.]+$/.test(cleaned) || l === 'End') {
            evtDataValues.push(cleaned);
          }
        }
      }
      // Parse event data: each event has ~4-6 values
      // Look for event numbers (standalone small integers) followed by data
      let currentEvNum = 0;
      for (const val of evtDataValues) {
        // Event number: standalone small int that resets the sequence
        if (/^\d{1,2}$/.test(val) && parseInt(val) > currentEvNum) {
          currentEvNum = parseInt(val);
          totalEvents = Math.max(totalEvents, currentEvNum);
          continue;
        }
        // Reflectance: negative value < -14
        const cleaned = val.replace(/^>/, '');
        if (cleaned.startsWith('-') && cleaned.includes('.')) {
          const num = parseFloat(cleaned);
          if (!isNaN(num) && num < -14.0 && currentEvNum > 0) {
            eventReflPairs.push([currentEvNum, num]);
          }
        }
      }
    }

    const highestRefl = filterReflectancePairs(eventReflPairs);
    if (wavelength === 1310 && report.results_1310) {
      report.results_1310.highest_reflectance_db = highestRefl;
      // If fiber_end is negative, use the "NNN.NN ft" marker from the page as actual fiber length
      if (report.results_1310.fiber_end_ft < 0) {
        const ftMatch = pageText.match(/([\d.]+)\s*ft\s*$/m);
        if (ftMatch) {
          const ftVal = parseFloat(ftMatch[1]);
          if (!isNaN(ftVal) && ftVal > 0) report.results_1310.fiber_end_ft = ftVal;
        }
      }
    }
    else if (wavelength === 1550 && report.results_1550) {
      report.results_1550.highest_reflectance_db = highestRefl;
      if (report.results_1550.fiber_end_ft < 0) {
        const ftMatch = pageText.match(/([\d.]+)\s*ft\s*$/m);
        if (ftMatch) {
          const ftVal = parseFloat(ftMatch[1]);
          if (!isNaN(ftVal) && ftVal > 0) report.results_1550.fiber_end_ft = ftVal;
        }
      }
    }
  }

  // Also parse thresholds from vertical pdf.js layout
  // "Connector Loss (dB)\n>0.50\nSplice Loss (dB)\n>0.20\n..."
  if (!report.thresholds.connector_loss_db) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/^Connector\s*Loss\s*\(dB\)$/i.test(l) && i + 1 < lines.length) {
        const v = parseFloat(lines[i + 1].replace(/^>/, '').trim());
        if (!isNaN(v)) report.thresholds.connector_loss_db = v;
      }
      if (/^Splice\s*Loss\s*\(dB\)$/i.test(l) && i + 1 < lines.length) {
        const v = parseFloat(lines[i + 1].replace(/^>/, '').trim());
        if (!isNaN(v)) report.thresholds.splice_loss_db = v;
      }
      if (/^Reflectance\s*\(dB\)$/i.test(l) && i + 1 < lines.length) {
        const v = parseFloat(lines[i + 1].replace(/^>/, '').trim());
        if (!isNaN(v)) report.thresholds.reflectance_db = v;
      }
      if (/^ORL\s*\(dB\)$/i.test(l) && i + 1 < lines.length) {
        const v = parseFloat(lines[i + 1].replace(/^</, '').trim());
        if (!isNaN(v)) report.thresholds.orl_db = v;
      }
    }
  }

  // Recalculate link length in case fiber_end was corrected from negative to positive
  calcLinkLength(report);
  calcPeaks(report);
  return report;
}

// ─── VIAVI Single-Wavelength Parser ───

function parseViaviSingleReport(pages: PageText[], filename: string): OTDRReport[] {
  const reportsDict: Map<string, OTDRReport> = new Map();

  for (const page of pages) {
    const text = page.text;
    let baseName = '';
    let displayName = '';
    const fileMatch = text.match(/File\s*:\s*([^\n]+?)\.sor/);
    if (fileMatch) {
      const fullName = fileMatch[1].trim();
      displayName = fullName.replace(/\s*1[35][15]0$/, '').trim();
      baseName = normalizeTestName(displayName);
    }
    if (!baseName) continue;

    let wavelength: number | null = null;
    let linkLoss: number | null = null;
    let linkOrl: number | null = null;
    let fiberEnd: number | null = null;
    let events = 1;

    const wlMatch = text.match(/OTDR\s+(\d{4})nm/);
    if (wlMatch) wavelength = parseInt(wlMatch[1]);

    const summaryMatch = text.match(/\.sor\s+(\d{4})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([A-Z\s\->]+)\s+(\d+)/);
    if (summaryMatch) {
      wavelength = parseInt(summaryMatch[1]);
      linkLoss = parseFloat(summaryMatch[2]);
      linkOrl = parseFloat(summaryMatch[3]);
      fiberEnd = parseFloat(summaryMatch[4]);
      events = parseInt(summaryMatch[6]);
    } else {
      const multiMatch = text.match(/\n(\d{4})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([A-Z\s\->]+)\s+(\d+)\s*\n.*?\.sor/);
      if (multiMatch) {
        wavelength = parseInt(multiMatch[1]);
        linkLoss = parseFloat(multiMatch[2]);
        linkOrl = parseFloat(multiMatch[3]);
        fiberEnd = parseFloat(multiMatch[4]);
        events = parseInt(multiMatch[6]);
      }
    }

    if (!wavelength || (wavelength !== 1310 && wavelength !== 1550)) continue;

    if (!reportsDict.has(baseName)) {
      const report = createDefaultReport(displayName, 'VIAVI');
      let mg: string | null;
      mg = matchGroup(text, /Fiber\s*Id\s*:?\s*([^\n]+?)(?:\s+Location|$)/i); if (mg) report.fiber_id = mg;
      mg = matchGroup(text, /Job\s*Id\s*:?\s*(\w+)/i); if (mg) report.job_id = mg;
      mg = matchGroup(text, /Cable\s*Id\s*:?\s*([^\n]*?)(?:\s+Fiber|$)/i); if (mg) report.cable_id = mg;
      mg = matchGroup(text, /Location\s*A\s*:?\s*([^\n]*?)(?:\s+Location|$)/i); if (mg) report.location_a = mg;
      mg = matchGroup(text, /Location\s*B\s*:?\s*([^\n]*?)(?:\s+Job|$)/i); if (mg) report.location_b = mg;
      mg = matchGroup(text, /Operator\s*:?\s*([^\n]+?)(?:\s+Date|$)/i); if (mg) report.technician_id = mg;
      mg = matchGroup(text, /Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4}\s*\d{1,2}:\d{2}\s*[ap]m)/i); if (mg) report.test_date = mg;

      const eq = text.match(/(T-BERD\s*\d+)\s*\(S\/N\s*(\d+)\)/i);
      if (eq) { report.model_1 = eq[1].trim(); report.serial_1 = eq[2].trim(); }
      const mod = text.match(/(\d{4}\s+[A-Z0-9]+)\s*\(S\/N\s*(\d+)\)/);
      if (mod) { report.model_2 = mod[1].trim(); report.serial_2 = mod[2].trim(); }

      const llm = matchFloat(text, /Link\s*Loss\s*Max\.?\s*\(dB\)\s*>?\s*([\d.]+)/i);
      if (llm !== null) report.thresholds.link_loss_max_db = llm;

      reportsDict.set(baseName, report);
    }

    const report = reportsDict.get(baseName)!;
    if (linkLoss !== null) {
      const result: OTDRResult = {
        wavelength_nm: wavelength, link_loss_db: linkLoss, link_orl_db: linkOrl || 0,
        fiber_end_ft: fiberEnd || 0, direction: '', events, passed: true, highest_reflectance_db: null
      };

      // Parse Event Table for reflectance on this page
      // Format: "Event Distance Loss Reflect. Section Att. Section T. Loss"
      //         "1 146.05 -37.11 0.473 146.05 0.473"
      //         "1 118.92 0.024 118.92 0.024"  (no reflectance)
      //         "2 146.57 -39.53 0.641 27.64 0.664"
      const eventReflPairs: [number, number][] = [];
      const pageLines = text.split('\n');
      let inEventTable = false;
      let totalEventsInTable = 0;

      for (const eline of pageLines) {
        if (/Event\s+Distance\s+Loss\s+Reflect/.test(eline)) { inEventTable = true; continue; }
        if (inEventTable) {
          if (eline.trim().startsWith('ft') || eline.trim().startsWith('dB')) continue;
          if (!eline.trim() || /^Page\s/i.test(eline.trim())) break;
          const evMatch = eline.match(/^\s*(\d{1,2})\s+/);
          if (!evMatch) continue;
          const eventNum = parseInt(evMatch[1]);
          totalEventsInTable = Math.max(totalEventsInTable, eventNum);
          const parts = eline.split(/\s+/);
          for (const p of parts.slice(2)) {
            const cleaned = p.replace(/^>/, '');
            if (cleaned.startsWith('-') && cleaned.includes('.')) {
              const val = parseFloat(cleaned);
              if (!isNaN(val) && val < -14.0) {
                eventReflPairs.push([eventNum, val]);
                break; // one reflectance per event
              }
            }
          }
        }
      }

      result.highest_reflectance_db = filterReflectancePairs(eventReflPairs);

      if (wavelength === 1310) report.results_1310 = result;
      else if (wavelength === 1550) report.results_1550 = result;
    }
  }

  const results = Array.from(reportsDict.values());
  results.forEach(r => {
    calcLinkLength(r);
    calcPeaks(r);
  });
  return results;
}

// ─── VIAVI Compiled Multi-Test Parser ───

function parseViaviCompiledMultitest(pages: PageText[], filename: string): OTDRReport[] {
  const reportsDict: Map<string, OTDRReport> = new Map();
  let i = 0;

  while (i < pages.length) {
    const summaryText = pages[i].text;
    if (!summaryText.includes('Summary') || !(summaryText.includes('Laser nm') || (summaryText.includes('Laser') && summaryText.includes('nm')))) { i++; continue; }
    if (summaryText.includes('Test Setup') || summaryText.includes('SMART')) { i++; continue; }

    const page1310Text = i + 1 < pages.length ? pages[i + 1].text : '';
    const page1550Text = i + 2 < pages.length ? pages[i + 2].text : '';

    let fileMatch = summaryText.match(/File\s*:\s*(\S[^\n]+)/);
    // pdf.js vertical: "File :\n SAL_TROLLEY_SQUARE...msor.pdf"
    if (!fileMatch || !fileMatch[1].trim()) {
      fileMatch = summaryText.match(/File\s*:\s*\n\s*(\S[^\n]+)/);
    }
    if (!fileMatch) { i += 3; continue; }

    let fileName = fileMatch[1].trim();
    // Handle line-wrapped filenames: "PLEASANT GREEN_700-" + next line "850_ALPHA_..."
    if (fileName.endsWith('-')) {
      const afterFile = summaryText.slice(summaryText.indexOf(fileName) + fileName.length);
      const nextLineMatch = afterFile.match(/^\s*\n\s*(\S[^\n]+)/);
      if (nextLineMatch) {
        fileName = fileName + nextLineMatch[1].trim();
      }
    }
    fileName = fileName.replace(/\.msor\.pdf$|\.msor$|\.pdf$/i, '').trim().replace(/-$/, '').trim();
    const baseKey = fileName.toLowerCase();

    const report = createDefaultReport(fileName, 'VIAVI');

    // Metadata
    let mg: string | null;
    mg = matchGroup(summaryText, /Cable\s*Id\s*:\s*([^\n]+?)(?:\s+Fiber|$)/i); if (mg) report.cable_id = mg;
    mg = matchGroup(summaryText, /Fiber\s*Id(?:\/Number)?\s*:\s*([^\n]+)/i);
    if (mg) { const fid = mg.replace(/\s+Location\s*$/i, '').trim(); if (fid) report.fiber_id = fid; }
    mg = matchGroup(summaryText, /Location\s*A\s*:\s*([^\n]+?)(?:\s+Location\s*B|$)/i); if (mg) report.location_a = mg;
    mg = matchGroup(summaryText, /Location\s*B\s*:\s*([^\n]+?)(?:\s+Job|$)/i); if (mg) report.location_b = mg;
    mg = matchGroup(summaryText, /Job\s*(?:ID|Id)\s*:\s*([^\n]+?)(?:\s+Technician|$)/i); if (mg) report.job_id = mg;
    mg = matchGroup(summaryText, /Technician\s*(?:ID|Id)\s*:\s*([^\n]*)/i); if (mg) report.technician_id = mg;

    // Equipment from detail pages
    for (const detailText of [page1310Text, page1550Text]) {
      if (!report.model_1) {
        const eq = detailText.match(/(ONA-\d+|T-BERD\s*\d+[A-Z0-9\s]*?|SmartOTDR)\s*\(S\/N\s*(\w+)\)/);
        if (eq) { report.model_1 = eq[1].trim(); report.serial_1 = eq[2].trim(); }
      }
      if (!report.model_2) {
        const mod = detailText.match(/(E100AS|\d{4}\s+[A-Z0-9]+)\s*\(S\/N\s*(\w+)\)/);
        if (mod) { report.model_2 = mod[1].trim(); report.serial_2 = mod[2].trim(); }
      }
      if (!report.calibration_date) {
        mg = matchGroup(detailText, /Calibration\s*[Dd]ate\s*:\s*(\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4})/);
        if (mg) report.calibration_date = mg;
      }
      if (!report.test_date) {
        mg = matchGroup(detailText, /Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4}\s*\d{1,2}:\d{2}\s*[ap]m)/i);
        if (mg) report.test_date = mg;
      }
    }

    // Thresholds
    for (const src of [summaryText, page1310Text]) {
      let tv: number | null;
      tv = matchFloat(src, /Connector\s*Loss\s*\(dB\)\s*>?\s*([\d.]+)/i); if (tv !== null && !report.thresholds.connector_loss_db) report.thresholds.connector_loss_db = tv;
      tv = matchFloat(src, /Splice\s*Loss\s*\(dB\)\s*>?\s*([\d.]+)/i); if (tv !== null && !report.thresholds.splice_loss_db) report.thresholds.splice_loss_db = tv;
      tv = matchFloat(src, /Reflectance\s*\(dB\)\s*>?\s*(-?[\d.]+)/i); if (tv !== null && !report.thresholds.reflectance_db) report.thresholds.reflectance_db = tv;
      tv = matchFloat(src, /ORL\s*\(dB\)\s*<?\s*([\d.]+)/i); if (tv !== null && !report.thresholds.orl_db) report.thresholds.orl_db = tv;
      tv = matchFloat(src, /Link\s*Loss\s*Max\.?\s*\(dB\)\s*>?\s*([\d.]+)/i); if (tv !== null && !report.thresholds.link_loss_max_db) report.thresholds.link_loss_max_db = tv;
    }

    // Parse wavelength results from summary
    const processedLines = summaryText.split('\n').map(l => l.replace(/>\s*([\d.]+)/g, '$1'));
    const pWithAvg = /^(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+(.+?(?:->|<-).+?)\s+([\d.\-]+)\s+(\d+)\s*$/;
    const pDirNoAvg = /^(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+(.+?(?:->|<-).+?)\s+(\d+)\s*$/;
    const pNoDir = /^(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.\-]+)\s+(\d+)\s*$/;
    const pMsor = /\.msor\s+(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+(.+?(?:->|<-).+?)\s+([\d.\-]+)\s+(\d+)\s*$/;
    const pMsorNoAvg = /\.msor\s+(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+(.+?(?:->|<-).+?)\s+(\d+)\s*$/;
    // Mid-line patterns: wavelength appears after filename text
    const pMidlineAvg = /\b(1[35][15]0)\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+(.+?(?:->|<-).+?)\s+([\d.\-]+)\s+(\d+)\s*$/;
    const pMidlineNoAvg = /\b(1[35][15]0)\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s+(.+?(?:->|<-).+?)\s+(\d+)\s*$/;

    for (let li = 0; li < processedLines.length; li++) {
      const trimmed = processedLines[li].trim();
      let matched = false;
      for (const pattern of [pWithAvg, pMsor, pDirNoAvg, pMsorNoAvg, pNoDir, pMidlineAvg, pMidlineNoAvg]) {
        const match = trimmed.match(pattern);
        if (match) {
          const wl = parseInt(match[1]);
          if (wl === 1310 || wl === 1550) {
            const result: OTDRResult = {
              wavelength_nm: wl, link_loss_db: parseFloat(match[2]), link_orl_db: parseFloat(match[3]),
              fiber_end_ft: parseFloat(match[4]), direction: '', events: parseInt(match[match.length - 1]),
              passed: true, highest_reflectance_db: null
            };
            if (wl === 1310 && !report.results_1310) report.results_1310 = result;
            else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
          }
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // pdf.js vertical: ".msor1310 0.029 46.22 211.02" (no space between .msor and wavelength)
      // or ".msor 1310 0.029 46.22 211.02" with just 4 values (direction + events on following lines)
      const pMsorPartial = trimmed.match(/\.msor\s*(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s*$/);
      if (pMsorPartial) {
        const wl = parseInt(pMsorPartial[1]);
        const orl = parseFloat(pMsorPartial[3]);
        if ((wl === 1310 || wl === 1550) && orl > 10) {
          let events = 0;
          for (let j = li + 1; j < Math.min(li + 10, processedLines.length); j++) {
            const v = processedLines[j].trim();
            if (/^(Alarms|Thresholds|Page|1\/)/i.test(v)) break;
            if (/^\d{1,2}$/.test(v)) { events = parseInt(v); }
          }
          const result: OTDRResult = {
            wavelength_nm: wl, link_loss_db: parseFloat(pMsorPartial[2]), link_orl_db: orl,
            fiber_end_ft: parseFloat(pMsorPartial[4]), direction: '', events,
            passed: true, highest_reflectance_db: null
          };
          if (wl === 1310 && !report.results_1310) report.results_1310 = result;
          else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
        }
        continue;
      }

      // pdf.js vertical: standalone "1550 0.000 56.49 12.56" (wavelength at start, no direction)
      const pPartial = trimmed.match(/^(\d{4})\s+([\d.\-]+)\s+([\d.]+)\s+([\d.]+)\s*$/);
      if (pPartial) {
        const wl = parseInt(pPartial[1]);
        const orl = parseFloat(pPartial[3]);
        if ((wl === 1310 || wl === 1550) && orl > 10) {
          let events = 0;
          for (let j = li + 1; j < Math.min(li + 10, processedLines.length); j++) {
            const v = processedLines[j].trim();
            if (/^(Alarms|Thresholds|Page|1\/)/i.test(v)) break;
            if (/^\d{1,2}$/.test(v)) { events = parseInt(v); }
          }
          const result: OTDRResult = {
            wavelength_nm: wl, link_loss_db: parseFloat(pPartial[2]), link_orl_db: orl,
            fiber_end_ft: parseFloat(pPartial[4]), direction: '', events,
            passed: true, highest_reflectance_db: null
          };
          if (wl === 1310 && !report.results_1310) report.results_1310 = result;
          else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
        }
      }

      // pdf.js fully-vertical: wavelength alone on a line, then each value on its own line:
      //   1310
      //   -9.933
      //   42.44
      //   -106.61
      //   RRH <- BBU
      //   ---
      //   3
      if (/^(1310|1550)$/.test(trimmed)) {
        const wl = parseInt(trimmed);
        // Collect next numeric-like lines
        const vals: string[] = [];
        let dir = '';
        let events = 0;
        for (let j = li + 1; j < Math.min(li + 12, processedLines.length); j++) {
          const v = processedLines[j].trim();
          if (/^(Alarms|Thresholds|Page\s*Number|1\/|Summary)/i.test(v)) break;
          if (v.match(/^-?[\d.]+$/)) {
            vals.push(v);
          } else if (v.includes('->') || v.includes('<-')) {
            dir = v;
          } else if (v === '---' || v === '--') {
            // avg loss placeholder, skip
          } else if (/^\d{1,2}$/.test(v)) {
            events = parseInt(v);
            break; // events is typically last in the sequence
          }
        }
        // Need at least link_loss, orl, fiber_end (3 values)
        if (vals.length >= 3) {
          const linkLoss = parseFloat(vals[0]);
          const orl = parseFloat(vals[1]);
          const fiberEnd = parseFloat(vals[2]);
          if (!isNaN(linkLoss) && !isNaN(orl) && orl > 10) {
            const result: OTDRResult = {
              wavelength_nm: wl,
              link_loss_db: linkLoss,
              link_orl_db: orl,
              fiber_end_ft: Math.abs(fiberEnd),
              direction: dir,
              events,
              passed: true,
              highest_reflectance_db: null
            };
            if (wl === 1310 && !report.results_1310) report.results_1310 = result;
            else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
          }
        }
      }
    }

    // Parse event tables from detail pages for reflectance
    for (const [detailText, wlDefault] of [[page1310Text, 1310], [page1550Text, 1550]] as [string, number][]) {
      const wlCheck = detailText.match(/(?:SMART|EXPERT|OTDR)\s+(\d{4})nm/);
      const wavelength = wlCheck ? parseInt(wlCheck[1]) : wlDefault;
      const eventReflPairs: [number, number][] = [];
      let totalEventsInTable = 0;
      const dLines = detailText.split('\n');
      let inEventTable = false;

      for (const dl of dLines) {
        if (dl.includes('Event') && dl.includes('Distance') && dl.includes('Reflect')) { inEventTable = true; continue; }
        if (inEventTable) {
          if (dl.trim().startsWith('ft') || dl.trim().startsWith('dB')) continue;
          if (dl.trim().startsWith('Page') || !dl.trim()) break;
          const evMatch = dl.match(/^\s*(\d{1,2})\s+/);
          if (!evMatch) continue;
          const eventNum = parseInt(evMatch[1]);
          totalEventsInTable = Math.max(totalEventsInTable, eventNum);
          const parts = dl.split(/\s+/);
          let reflVal: number | null = null;
          for (const p of parts.slice(2)) {
            const cleaned = p.replace(/^>/, '');
            if (cleaned.startsWith('-') && cleaned.includes('.')) {
              const val = parseFloat(cleaned);
              if (!isNaN(val) && val < -14.0) { if (reflVal === null || val > reflVal) reflVal = val; }
            }
          }
          if (reflVal !== null) eventReflPairs.push([eventNum, reflVal]);
        }
      }

      const highestRefl = filterReflectancePairs(eventReflPairs);
      if (wavelength === 1310 && report.results_1310) report.results_1310.highest_reflectance_db = highestRefl;
      else if (wavelength === 1550 && report.results_1550) report.results_1550.highest_reflectance_db = highestRefl;
    }

    calcLinkLength(report);
    calcPeaks(report);
    reportsDict.set(baseKey, report);
    i += 3;
  }

  return Array.from(reportsDict.values());
}

// ─── EXFO Legacy Parser ───

function parseExfoReport(text: string, filename: string): OTDRReport {
  const report = createDefaultReport(filename, 'EXFO');
  let mg: string | null;
  mg = matchGroup(text, /Job\s*ID:\s*(\w+)/i); if (mg) report.job_id = mg;
  mg = matchGroup(text, /Customer:\s*(\w+)/i); if (mg) report.customer = mg;
  mg = matchGroup(text, /Cable\s*Id:\s*([^\n]+)/i); if (mg) report.cable_id = mg;
  mg = matchGroup(text, /Fiber\s*Id:\s*([^\n]+?)(?:\s+Direction|$)/i); if (mg) report.fiber_id = mg;
  mg = matchGroup(text, /Tested\s*from:\s*([^\n]+?)(?:\s+to\s+|$)/i); if (mg) report.location_a = mg;
  mg = matchGroup(text, /to\s+([^\n]+?)(?:\s+Cable|$)/i); if (mg) report.location_b = mg;
  mg = matchGroup(text, /Date\/Time:\s*([^\n]+)/i); if (mg) report.test_date = mg;
  mg = matchGroup(text, /Technician:\s*(\w+)/i); if (mg) report.technician_id = mg;

  const eqMatch = text.match(/(MAX-\d+[A-Z0-9\-]*)\s+S\/N:?\s*(\w+)/i);
  if (eqMatch) { report.model_1 = eqMatch[1].trim(); report.serial_1 = eqMatch[2].trim(); }

  let v: number | null;
  v = matchFloat(text, /Link\s*Length:\s*([\d.]+)\s*ft/i); if (v !== null) report.link_length_ft = v;
  v = matchFloat(text, /Connector\s*Loss.*?:\s*<?\s*([\d.]+)\s*dB/i); if (v !== null) report.thresholds.connector_loss_db = v;
  v = matchFloat(text, /Splice\s*Loss.*?:\s*<?\s*([\d.]+)\s*dB/i); if (v !== null) report.thresholds.splice_loss_db = v;
  v = matchFloat(text, /Reflectance.*?:\s*>?\s*(-?[\d.]+)\s*dB/i); if (v !== null) report.thresholds.reflectance_db = v;
  v = matchFloat(text, /ORL.*?:\s*>?\s*([\d.]+)\s*dB/i); if (v !== null) report.thresholds.orl_db = v;

  // Wavelength results
  const section = text.match(/iOLM\s*Results[\s\S]*?(?=Link\s*View|Element|$)/i);
  if (section) {
    const wlMatches = [...section[0].matchAll(/(\d{4})\s+([\d.]+)\s+([\d.]+)/g)];
    for (const wm of wlMatches) {
      const wl = parseInt(wm[1]);
      if (wl === 1310 || wl === 1550) {
        const result: OTDRResult = {
          wavelength_nm: wl, link_loss_db: parseFloat(wm[2]), link_orl_db: parseFloat(wm[3]),
          fiber_end_ft: report.link_length_ft, direction: '', events: 0, passed: true, highest_reflectance_db: null
        };
        if (wl === 1310) report.results_1310 = result;
        else if (wl === 1550) report.results_1550 = result;
      }
    }
  }
  return report;
}

// ─── EXFO iOLM Element Table Parser ───

function parseExfoIolmElementTable(text: string): [number | null, number | null] {
  const eventRefl1310: [number, number][] = [];
  const eventRefl1550: [number, number][] = [];
  const lines = text.split('\n');
  let inElementTable = false;

  for (const line of lines) {
    if (line.includes('Element Table')) { inElementTable = true; continue; }
    if (inElementTable) {
      if (line.includes('Pass/Fail') || line.includes('Parameters')) break;
      if (line.includes('Connector')) {
        const connMatch = line.match(/Connector\s+(\d+)/);
        const connNum = connMatch ? parseInt(connMatch[1]) : 0;
        const reflMatches = line.match(/-?\d+\.?\d*|>-\d+\.?\d*/g) || [];
        if (reflMatches.length >= 6) {
          try {
            let r1310 = reflMatches[4].replace(/^>/, '');
            let r1550 = reflMatches[5].replace(/^>/, '');
            const v1310 = parseFloat(r1310);
            const v1550 = parseFloat(r1550);
            if (v1310 < 0) eventRefl1310.push([connNum, v1310]);
            if (v1550 < 0) eventRefl1550.push([connNum, v1550]);
          } catch { /* skip */ }
        }
      }
    }
  }

  return [filterReflectancePairs(eventRefl1310), filterReflectancePairs(eventRefl1550)];
}

// ─── EXFO iOLM Multi-Page Parser ───

function parseExfoIolmMultipage(pages: PageText[], filename: string): OTDRReport[] {
  const reports: OTDRReport[] = [];

  for (let pi = 0; pi < pages.length - 1; pi += 2) {
    const page1Text = pages[pi].text;
    const page2Text = pages[pi + 1]?.text || '';
    if (!page1Text.includes('iOLM Report') && !page1Text.includes('iOLM Results')) continue;

    const report = createDefaultReport(filename, 'EXFO_IOLM');
    let mg: string | null;

    // Extract internal filename from report
    mg = matchGroup(page1Text, /Filename:\s*([^\n]+)/);
    if (!mg) mg = matchGroup(page1Text, /File\s*name:\s*([^\n]+)/);
    if (mg) report.filename = mg;

    // Pass/Fail
    if (page1Text.includes('iOLM Report Pass')) report.overall_result = 'PASS';
    else if (page1Text.includes('iOLM Report Fail')) report.overall_result = 'FAIL';

    // General Information
    mg = matchGroup(page1Text, /JobID:\s*([^\n]+)/); if (mg) report.job_id = mg;
    mg = matchGroup(page1Text, /Customer:\s*(\S+)/); if (mg) report.customer = mg;
    mg = matchGroup(page1Text, /Company:\s*([^\n]+)/); if (mg) report.company = mg;
    mg = matchGroup(page1Text, /Testdate:\s*([^\s]+)/); if (mg) report.test_date = mg;

    // Operator - may be on line after "Operator" header
    const opMatch = page1Text.match(/Operator\s*\n([^\n]+)/);
    if (opMatch && opMatch[1].trim() && !opMatch[1].trim().startsWith('Model')) {
      report.technician_id = opMatch[1].trim();
    }

    // Equipment info - handle both pdfplumber ("Serialnumber") and pdf.js ("Serial number") formats
    mg = matchGroup(page1Text, /Model\s+([A-Za-z0-9\-]+)/); if (mg) report.model_1 = mg;
    mg = matchGroup(page1Text, /Serial\s*number\s+(\d+)/); if (mg) report.serial_1 = mg;
    mg = matchGroup(page1Text, /Calibration\s*date\s+([^\n]+)/); if (mg) report.calibration_date = mg;
    mg = matchGroup(page1Text, /Calibration\s*due\s+([^\n]+)/i); if (mg) report.calibration_due = mg;

    // Identifiers table - multiple format variants
    // Format 1: CableID Technology FiberID Frequency Location
    const identMatch = page1Text.match(
      /Identifiers\s*\nCableID\s+(?:Technology\s+)?FiberID\s+(?:Frequency\s+)?Location\s*\n(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/
    );
    if (identMatch) {
      report.cable_id = identMatch[1]; report.fiber_id = identMatch[3]; report.location_a = identMatch[5];
    } else {
      // Format 2: simple "CableID FiberID" with just values below
      const identSimple = page1Text.match(
        /Identifiers\s*\nCable\s*ID\s+Fiber\s*ID\s*\n(\S.*)/
      );
      if (identSimple) {
        const vals = identSimple[1].trim().split(/\s+/);
        if (vals.length >= 2) { report.cable_id = vals[0]; report.fiber_id = vals[1]; }
        else if (vals.length === 1) report.fiber_id = vals[0];
      } else {
        // Fallback: parse section between Identifiers and iOLM Results
        const identSection = page1Text.match(/Identifiers[\s\S]*?iOLM Results/);
        if (identSection) {
          const dataMatch = identSection[0].match(/\n(\S+)\s+\S+\s+(\S+)\s+[\d\-]+\s+(\S+)/);
          if (dataMatch) {
            report.cable_id = dataMatch[1]; report.fiber_id = dataMatch[2]; report.location_a = dataMatch[3];
          }
        }
      }
    }

    let v: number | null;
    v = matchFloat(page1Text, /Linklength:\s*([\d.]+)\s*ft/); if (v !== null) report.link_length_ft = v;

    // iOLM Results
    const resultsSection = page1Text.match(/iOLM Results[\s\S]*?(?=Link View|Element|$)/i);
    if (resultsSection) {
      for (const wm of [...resultsSection[0].matchAll(/(\d{4})\s+([\d.\-]+)\s+([\d.]+)/g)]) {
        const wl = parseInt(wm[1]);
        if (wl === 1310 || wl === 1550) {
          const result: OTDRResult = {
            wavelength_nm: wl, link_loss_db: parseFloat(wm[2]), link_orl_db: parseFloat(wm[3]),
            fiber_end_ft: report.link_length_ft, direction: '', events: 0, passed: true, highest_reflectance_db: null
          };
          if (wl === 1310) report.results_1310 = result;
          else report.results_1550 = result;
        }
      }
    }

    // Element Table for reflectance
    const [hiRefl1310, hiRefl1550] = parseExfoIolmElementTable(page2Text);
    if (report.results_1310 && hiRefl1310 !== null) report.results_1310.highest_reflectance_db = hiRefl1310;
    if (report.results_1550 && hiRefl1550 !== null) report.results_1550.highest_reflectance_db = hiRefl1550;

    // Count events
    const connMatches = page2Text.match(/Connector\s+\d+\s+[\d.]+/g) || [];
    const events = connMatches.length;
    if (report.results_1310) report.results_1310.events = events;
    if (report.results_1550) report.results_1550.events = events;

    // Thresholds from Custom Pass/Fail section
    const threshSection = page2Text.match(/Custom Pass\/Fail Thresholds on Elements[\s\S]*?iOLM Parameters/);
    if (threshSection) {
      const tm = threshSection[0].match(/Connector\s+([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
      if (tm) {
        report.thresholds.connector_loss_db = parseFloat(tm[1]);
        report.thresholds.reflectance_db = parseFloat(tm[3]);
      }
    }

    // Link Loss Max / ORL thresholds from Pass/Fail Thresholds section
    const passfailSection = page2Text.match(/iOLM Pass\/Fail Thresholds[\s\S]*?iOLM Advanced/);
    if (passfailSection) {
      const pfm = passfailSection[0].match(/CustomPass\/FailThresholds\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d,.]+)/);
      if (pfm) {
        report.thresholds.orl_db = parseFloat(pfm[2]);
        const llm = parseFloat(pfm[1]);
        if (llm > 0) report.thresholds.link_loss_max_db = llm;
      }
    }

    calcPeaks(report);
    reports.push(report);
  }
  return reports;
}

// ─── EXFO FTBx Event Table Parser ───

function parseExfoEventTable(text: string): [number, number | null] {
  const events: number[] = [];
  const eventReflPairs: [number, number][] = [];
  const lines = text.split('\n');
  let inTable = false;

  for (const line of lines) {
    if (line.includes('Event Table')) { inTable = true; continue; }
    if (inTable) {
      if (line.includes('Macrobend') || line.includes('Pass/Fail')) break;
      // pdfplumber horizontal: "FirstConnector 1 0.0 --- -54.8 0.000"
      const match = line.match(/(First\s*Connector|Reflective)\s+(\d+)\s+([\d.,]+)\s+([\d.\-]+|---)\s+(-?[\d.]+)/);
      if (match) {
        const eventNo = parseInt(match[2]);
        const reflectance = parseFloat(match[5]);
        events.push(eventNo);
        eventReflPairs.push([eventNo, reflectance]);
      }
    }
  }

  // pdf.js vertical layout: "First Connector\n1\n0.0\n---\n-54.8\n0.000\nSection\n..."
  // Parse by collecting event types and their following data
  if (events.length === 0) {
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].includes('Event Table')) { i++; continue; }
      i++; // skip "Event Table" line
      // Skip header lines until we hit event data
      while (i < lines.length && !/(First\s*Connector|Reflective|Section)/.test(lines[i])) {
        if (lines[i].includes('Macrobend') || lines[i].includes('Pass/Fail')) break;
        i++;
      }
      // Now parse events
      while (i < lines.length) {
        const l = lines[i].trim();
        if (l.includes('Macrobend') || l.includes('Pass/Fail')) break;
        if (/^First\s*Connector$/i.test(l) || /^Reflective$/i.test(l)) {
          // Next values: No, Pos, Loss, Reflectance, Attenuation, Cumulative
          // But some are on the next lines
          const eventNo = parseInt(lines[i + 1]?.trim() || '0');
          if (eventNo > 0) {
            events.push(eventNo);
            // Scan next few lines for reflectance (negative value)
            for (let j = i + 2; j < Math.min(i + 8, lines.length); j++) {
              const val = lines[j].trim();
              if (/^(Section|Reflective|First|Macrobend|Pass)/.test(val)) break;
              const num = parseFloat(val);
              if (!isNaN(num) && num < -14.0) {
                eventReflPairs.push([eventNo, num]);
                break;
              }
            }
          }
          i++;
        } else if (/^Section$/.test(l)) {
          // Skip section data (6 values)
          i++;
          while (i < lines.length && !/^(First\s*Connector|Reflective|Section|Macrobend|Pass)/.test(lines[i].trim())) i++;
        } else {
          i++;
        }
      }
      break;
    }
  }

  const eventsCount = events.length > 0 ? Math.max(...events) : 0;
  const highestRefl = filterReflectancePairs(eventReflPairs);
  return [eventsCount, highestRefl];
}

// ─── EXFO FTBx Parser ───

/** Helper: extract value for a label that may be on same line or next line */
function exfoField(lines: string[], pattern: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(pattern);
    if (m) {
      // Value on same line
      if (m[1]?.trim()) return m[1].trim();
      // Value on next line (pdf.js vertical)
      if (i + 1 < lines.length && lines[i + 1].trim()) return lines[i + 1].trim();
    }
  }
  return null;
}

function parseExfoFtbxReport(pages: PageText[], filename: string): OTDRReport {
  const report = createDefaultReport(filename, 'EXFO');
  const eventData: Record<number, { events: number; reflectance: number | null }> = {
    1310: { events: 0, reflectance: null },
    1550: { events: 0, reflectance: null },
  };

  for (const page of pages) {
    const text = page.text;
    const lines = text.split('\n').map(l => l.trim());
    const wlMatch = text.match(/OTDR\s*Report\s*\((\d{4})\s*nm/);
    const wavelength = wlMatch ? parseInt(wlMatch[1]) : null;

    if (/OTDR\s*Report.*?Pass/i.test(text)) { if (!report.overall_result) report.overall_result = 'PASS'; }
    else if (/OTDR\s*Report.*?Fail/i.test(text)) report.overall_result = 'FAIL';

    // Metadata — handle both "CableID: val" (pdfplumber) and "Cable ID:\nval" (pdf.js)
    if (!report.cable_id) {
      let v = matchGroup(text, /CableID:\s*([^\n]+)/);
      if (!v) v = exfoField(lines, /^Cable\s*ID:?\s*(.*)/i);
      if (v) report.cable_id = v;
    }
    if (!report.fiber_id) {
      let v = matchGroup(text, /FiberID:\s*([^\n]+)/);
      if (!v) v = exfoField(lines, /^Fiber\s*ID:?\s*(.*)/i);
      if (v) report.fiber_id = v;
    }
    if (!report.job_id) {
      let v = matchGroup(text, /JobID:\s*([^\n]+)/);
      if (!v) v = exfoField(lines, /^Job\s*ID:?\s*(.*)/i);
      if (v) report.job_id = v;
    }
    if (!report.company) {
      let v = matchGroup(text, /Company:\s*([^\n]+)/);
      if (!v) v = exfoField(lines, /^Company:?\s*(.*)/i);
      if (v) report.company = v;
    }
    if (!report.test_date) {
      let v = matchGroup(text, /Testdate:\s*([^\n]+)/);
      if (!v) v = exfoField(lines, /^Test\s*date:?\s*(.*)/i);
      if (v) report.test_date = v;
    }
    if (!report.model_1) {
      let v = matchGroup(text, /Model\s+([A-Za-z0-9][\w\-]+)/);
      if (!v) v = exfoField(lines, /^Model\s*(.*)/);
      if (v) report.model_1 = v;
    }
    if (!report.serial_1) {
      let v = matchGroup(text, /Serialnumber\s+(\d+)/);
      if (!v) v = exfoField(lines, /^Serial\s*number\s*(.*)/i);
      if (v) report.serial_1 = v;
    }
    if (!report.calibration_date) {
      let v = matchGroup(text, /Calibrationdate\s+([^\n]+)/);
      if (!v) v = exfoField(lines, /^Calibration\s*date\s*(.*)/i);
      if (v) report.calibration_date = v;
    }

    // Event table
    if (wavelength && (wavelength === 1310 || wavelength === 1550) && text.includes('Event Table')) {
      const [ec, hr] = parseExfoEventTable(text);
      eventData[wavelength].events = ec;
      eventData[wavelength].reflectance = hr;
    }

    // Results — handle "Spanlength: 464.1ft" (pdfplumber) and "Span length:\n464.1 ft" (pdf.js)
    if (wavelength && (wavelength === 1310 || wavelength === 1550)) {
      let spanLength = matchFloat(text, /Span\s*length:\s*([\d.]+)\s*ft/);
      if (spanLength === null) {
        const v = exfoField(lines, /^Span\s*length:?\s*(.*)/i);
        if (v) { const m = v.match(/([\d.]+)\s*ft/); if (m) spanLength = parseFloat(m[1]); }
      }
      let spanLoss = matchFloat(text, /Span\s*loss:\s*([\d.]+)\s*dB/);
      if (spanLoss === null) {
        const v = exfoField(lines, /^Span\s*loss:?\s*(.*)/i);
        if (v) { const m = v.match(/([\d.]+)\s*dB/); if (m) spanLoss = parseFloat(m[1]); }
      }
      let spanOrl = matchFloat(text, /Span\s*ORL:\s*([\d.]+)\s*dB/);
      if (spanOrl === null) {
        const v = exfoField(lines, /^Span\s*ORL:?\s*(.*)/i);
        if (v) { const m = v.match(/([\d.]+)\s*dB/); if (m) spanOrl = parseFloat(m[1]); }
      }
      if (spanLoss !== null) {
        const result: OTDRResult = {
          wavelength_nm: wavelength, link_loss_db: spanLoss, link_orl_db: spanOrl || 0,
          fiber_end_ft: spanLength || 0, direction: '', events: eventData[wavelength].events,
          passed: true, highest_reflectance_db: eventData[wavelength].reflectance
        };
        if (wavelength === 1310) report.results_1310 = result;
        else report.results_1550 = result;
      }
    }

    // Thresholds — handle both formats
    let tv: number | null;
    // pdfplumber: "Spliceloss(dB) 0.250"
    tv = matchFloat(text, /Splice\s*loss\s*\(dB\)\s*([\d.]+)/); if (tv !== null && !report.thresholds.splice_loss_db) report.thresholds.splice_loss_db = tv;
    tv = matchFloat(text, /Connector\s*loss\s*\(dB\)\s*([\d.]+)/); if (tv !== null && !report.thresholds.connector_loss_db) report.thresholds.connector_loss_db = tv;
    tv = matchFloat(text, /Reflectance\s*\(dB\)\s*(-?[\d.]+)/); if (tv !== null && !report.thresholds.reflectance_db) report.thresholds.reflectance_db = tv;
    tv = matchFloat(text, /Span\s*ORL\s*\(dB\)\s*([\d.]+)/); if (tv !== null && !report.thresholds.orl_db) report.thresholds.orl_db = tv;
    // pdf.js vertical: "Splice loss (dB)\n0.250"
    if (!report.thresholds.splice_loss_db) {
      const v = exfoField(lines, /^Splice\s*loss\s*\(dB\)\s*(.*)/i);
      if (v) { const n = parseFloat(v); if (!isNaN(n)) report.thresholds.splice_loss_db = n; }
    }
    if (!report.thresholds.connector_loss_db) {
      const v = exfoField(lines, /^Connector\s*loss\s*\(dB\)\s*(.*)/i);
      if (v) { const n = parseFloat(v); if (!isNaN(n)) report.thresholds.connector_loss_db = n; }
    }
    if (!report.thresholds.reflectance_db) {
      const v = exfoField(lines, /^Reflectance\s*\(dB\)\s*(.*)/i);
      if (v) { const n = parseFloat(v); if (!isNaN(n)) report.thresholds.reflectance_db = n; }
    }
    if (!report.thresholds.orl_db) {
      const v = exfoField(lines, /^Span\s*ORL\s*\(dB\)\s*(.*)/i);
      if (v) { const n = parseFloat(v); if (!isNaN(n)) report.thresholds.orl_db = n; }
    }
  }

  // Update results with event data
  if (report.results_1310 && eventData[1310].events > 0) {
    report.results_1310.events = eventData[1310].events;
    report.results_1310.highest_reflectance_db = eventData[1310].reflectance;
  }
  if (report.results_1550 && eventData[1550].events > 0) {
    report.results_1550.events = eventData[1550].events;
    report.results_1550.highest_reflectance_db = eventData[1550].reflectance;
  }

  calcLinkLength(report);
  calcPeaks(report);
  return report;
}

// ─── Anritsu MT9083 Page Parser ───

function parseAnritsuPage(text: string, filename: string): OTDRReport | null {
  if (!text.includes('Test Result Summary')) return null;
  const report = createDefaultReport(filename, 'ANRITSU');
  const lines = text.split('\n').map(l => l.trim());

  // Helper: pdf.js sometimes inserts spaces into numbers/dates
  // e.g. "202 6 - Mar - 1 1  1 1 : 42" -> "2026-Mar-11 11:42"
  // e.g. "1 280" -> "1280"
  const deSpace = (s: string): string => s.replace(/(\d)\s+(\d)/g, '$1$2').replace(/(\d)\s*-\s*/g, '$1-').replace(/-\s*(\w)/g, '-$1').trim();

  // ── Test Information ──
  let mg: string | null;
  mg = matchGroup(text, /File\s*Name\s+(.+)/); if (mg) report.filename = mg.trim();

  // Fiber ID — may have spaces: "Fiber ID  1 280"
  mg = matchGroup(text, /Fiber\s*ID\s+([\d\s]+)/);
  if (mg) report.fiber_id = mg.replace(/\s+/g, '').trim();

  mg = matchGroup(text, /Cable\s*ID\s+([^\n]*?)(?:\s+Fiber|$)/m); if (mg) report.cable_id = mg.trim();
  mg = matchGroup(text, /Start\s*Location\s+([^\n]+)/); if (mg) report.location_a = mg.trim();
  mg = matchGroup(text, /Terminal\s*Location\s*([^\n]*)/); if (mg) report.location_b = mg.trim();

  // Date/Time — pdf.js may space-split: "202 6 - Mar - 1 1  1 1 : 42"
  mg = matchGroup(text, /Date\/Time\s+([\d\s\-:A-Za-z]+?)(?:\n|Cable|$)/);
  if (mg) report.test_date = deSpace(mg);

  mg = matchGroup(text, /Operator\s+([^\n]*?)(?:\s{2,}Date|$)/); if (mg && mg.trim()) report.technician_id = mg.trim();

  // Equipment: "MT9083A2 (6201333267)"
  const eqMatch = text.match(/(MT\d+[A-Z0-9]*)\s*\((\d[\d\s]*)\)/);
  if (eqMatch) {
    report.model_1 = eqMatch[1].trim();
    report.serial_1 = eqMatch[2].replace(/\s+/g, '').trim();
  }

  // Calibration — may have spaces in date, stop at end of line
  mg = matchGroup(text, /Calibration\s+([\d\s\-A-Za-z]+?)(?:\n|$)/);
  if (mg) report.calibration_date = deSpace(mg);

  // ── Overall result ──
  if (/\bPASS\b/.test(text)) report.overall_result = 'PASS';
  if (/\bFAIL\b/.test(text)) report.overall_result = 'FAIL';

  // ── Test Result Summary ──
  // Browser pdf.js format (horizontal, one wavelength per row):
  //   "1310 nm  214 ft  0.448  2  32.019 dB"
  //   "1550 nm  214 ft  0.283  2  33.773 dB"
  // Also handle pdfplumber dual-column: "Fiber Length 214 ft 214 ft"
  
  // Try row-per-wavelength pattern first (browser pdf.js)
  const wlRowPattern = /(\d{4})\s*nm\s+([\d.]+)\s*ft\s+([\d.\-]+)\s+(\d+)\s+([\d.]+)\s*dB/g;
  let wlMatch;
  while ((wlMatch = wlRowPattern.exec(text)) !== null) {
    const wl = parseInt(wlMatch[1]);
    const fiberLen = parseFloat(wlMatch[2]);
    const loss = parseFloat(wlMatch[3]);
    const events = parseInt(wlMatch[4]);
    const orl = parseFloat(wlMatch[5]);
    if (wl === 1310 || wl === 1550) {
      const result: OTDRResult = {
        wavelength_nm: wl, link_loss_db: loss, link_orl_db: orl,
        fiber_end_ft: fiberLen, direction: '', events,
        passed: report.overall_result !== 'FAIL', highest_reflectance_db: null
      };
      if (wl === 1310 && !report.results_1310) report.results_1310 = result;
      else if (wl === 1550 && !report.results_1550) report.results_1550 = result;
    }
  }

  // Fallback: pdfplumber dual-column layout
  if (!report.results_1310 && !report.results_1550) {
    const fl1310 = matchFloat(text, /Fiber\s+Length\s+([\d.]+)\s*ft\s+([\d.]+)\s*ft/, 1);
    const fl1550 = matchFloat(text, /Fiber\s+Length\s+([\d.]+)\s*ft\s+([\d.]+)\s*ft/, 2);
    const loss1310 = matchFloat(text, /Total\s+Loss\s+([\d.\-]+)\s*dB\s+([\d.\-]+)\s*dB/, 1);
    const loss1550 = matchFloat(text, /Total\s+Loss\s+([\d.\-]+)\s*dB\s+([\d.\-]+)\s*dB/, 2);
    const ev1310 = matchInt(text, /Total\s+Events\s+(\d+)\s+(\d+)/, 1) || 0;
    const ev1550 = matchInt(text, /Total\s+Events\s+(\d+)\s+(\d+)/, 2) || 0;
    const orl1310 = matchFloat(text, /ORL\s+([\d.]+)\s*dB\s+([\d.]+)\s*dB/, 1) || 0;
    const orl1550 = matchFloat(text, /ORL\s+([\d.]+)\s*dB\s+([\d.]+)\s*dB/, 2) || 0;
    if (loss1310 !== null) {
      report.results_1310 = {
        wavelength_nm: 1310, link_loss_db: loss1310, link_orl_db: orl1310,
        fiber_end_ft: fl1310 || 0, direction: '', events: ev1310,
        passed: report.overall_result !== 'FAIL', highest_reflectance_db: null
      };
    }
    if (loss1550 !== null) {
      report.results_1550 = {
        wavelength_nm: 1550, link_loss_db: loss1550, link_orl_db: orl1550,
        fiber_end_ft: fl1550 || 0, direction: '', events: ev1550,
        passed: report.overall_result !== 'FAIL', highest_reflectance_db: null
      };
    }
  }

  calcLinkLength(report);

  // ── Thresholds ──
  // Browser pdf.js horizontal: "0.20 dB  0.50 dB  -35.0 dB  1.00 dB/km  3.0 dB  3.0 dB  27.0 dB"
  const threshLine = lines.find(l => /^[\d.\-]+\s*dB\s+[\d.\-]+\s*dB/.test(l) && l.includes('dB/km'));
  if (threshLine) {
    const vals = [...threshLine.matchAll(/([\d.\-]+)\s*dB(?:\/km)?/g)].map(m => parseFloat(m[1]));
    // Order: Non-Refl, Refl, Reflectance, Fiber Loss, Total Loss, Splitter Loss, ORL
    if (vals.length >= 7) {
      report.thresholds.splice_loss_db = vals[0];      // Non Reflective Loss
      report.thresholds.connector_loss_db = vals[1];    // Reflective Loss
      report.thresholds.reflectance_db = vals[2];       // Reflectance
      report.thresholds.link_loss_max_db = vals[4];     // Total Loss
      report.thresholds.orl_db = vals[6];               // ORL
    }
  }
  // Fallback: labeled patterns (pdfplumber)
  if (!report.thresholds.connector_loss_db) {
    let tv: number | null;
    tv = matchFloat(text, /Reflective\s+(?:Event\s+)?Loss.*?:\s*([\d.]+)\s*dB/); if (tv !== null) report.thresholds.connector_loss_db = tv;
    tv = matchFloat(text, /Non[\s-]?Reflective\s+(?:Event\s+)?Loss.*?:\s*([\d.]+)\s*dB/); if (tv !== null) report.thresholds.splice_loss_db = tv;
    tv = matchFloat(text, /Reflectance\s*:?\s*(-?[\d.]+)\s*dB/); if (tv !== null) report.thresholds.reflectance_db = tv;
    tv = matchFloat(text, /ORL\s*:\s*([\d.]+)\s*dB/); if (tv !== null) report.thresholds.orl_db = tv;
    tv = matchFloat(text, /Total\s+Loss\s*:\s*([\d.]+)\s*dB/); if (tv !== null) report.thresholds.link_loss_max_db = tv;
  }

  // ── Event table for reflectance ──
  // Browser pdf.js: full row on one line, both wavelengths:
  //   "1  179  0.305  -38.126  179  0.229  1  179  0.140  -39.920  179  0.069"
  //   "2  214  End  -16.823S  35  0.448  2  214  End  -17.933S  35  0.283"
  const eventRefl1310: [number, number][] = [];
  const eventRefl1550: [number, number][] = [];

  for (const line of lines) {
    // Match event rows: start with event number, contain reflectance values (negative with optional S)
    // Full row has 12+ fields: ev1 dist1 loss1 refl1 span1 cum1 ev2 dist2 loss2 refl2 span2 cum2
    const parts = line.split(/\s+/);
    if (parts.length < 10) continue;
    
    // Check if first part is an event number (1-99)
    const evNum = parseInt(parts[0]);
    if (isNaN(evNum) || evNum < 1 || evNum > 99) continue;
    
    // Look for reflectance values (negative numbers, optionally ending in S)
    // In a 12-field row: refl_1310 is at index 3, refl_1550 is at index 9
    // In rows with "End" instead of loss: refl_1310 is at index 3, refl_1550 is at index 9
    const reflValues: { pos: number; val: number; evNum: number }[] = [];
    for (let pi = 2; pi < parts.length; pi++) {
      const cleaned = parts[pi].replace(/S$/, '');
      if (cleaned.startsWith('-') && cleaned.includes('.')) {
        const val = parseFloat(cleaned);
        if (!isNaN(val) && val < -14.0) {
          reflValues.push({ pos: pi, val, evNum });
        }
      }
    }

    // First reflectance found = 1310, second = 1550 (in a dual-wavelength row)
    if (reflValues.length >= 1) eventRefl1310.push([evNum, reflValues[0].val]);
    if (reflValues.length >= 2) eventRefl1550.push([evNum, reflValues[1].val]);
  }

  const hi1310 = filterReflectancePairs(eventRefl1310);
  const hi1550 = filterReflectancePairs(eventRefl1550);
  if (hi1310 !== null && report.results_1310) report.results_1310.highest_reflectance_db = hi1310;
  if (hi1550 !== null && report.results_1550) report.results_1550.highest_reflectance_db = hi1550;

  calcPeaks(report);
  return report;
}

// ─── Anritsu Multipage Parser ───

function parseAnritsuMultipage(pages: PageText[], filename: string): OTDRReport[] {
  const reports: OTDRReport[] = [];
  for (const page of pages) {
    const report = parseAnritsuPage(page.text, filename);
    if (report) reports.push(report);
  }
  return reports;
}

// ─── Anritsu MT9085 Dual Parser ───

function parseAnritsuMt9085Dual(pages: PageText[], filename: string): OTDRReport[] {
  const report = createDefaultReport(filename, 'ANRITSU');
  const page1Text = pages[0]?.text || '';

  let mg: string | null;
  mg = matchGroup(page1Text, /Location\s*:\s*([^\n]+)/); if (mg) report.location_a = mg;
  mg = matchGroup(page1Text, /Date\/Time\s*:\s*([^\n]+)/); if (mg) report.test_date = mg;
  mg = matchGroup(page1Text, /Cable\s*ID\s*:\s*([^\n]+)/); if (mg) report.cable_id = mg;
  mg = matchGroup(page1Text, /Fiber\s*ID\s*:\s*([^\n]+)/); if (mg) report.fiber_id = mg;
  mg = matchGroup(page1Text, /Customer\s*:\s*([^\n]+)/); if (mg) report.customer = mg;
  mg = matchGroup(page1Text, /Operator\s*:\s*([^\n]+)/); if (mg) report.technician_id = mg;

  const instMatch = page1Text.match(/Instrument\s*:\s*(MT\d+[A-Z0-9\-]*)\s*\((\d+)\)/);
  if (instMatch) { report.model_1 = instMatch[1].trim(); report.serial_1 = instMatch[2].trim(); }
  mg = matchGroup(page1Text, /Calibration\s*:\s*([^\n]+)/); if (mg) report.calibration_date = mg;

  // Results
  const fiberLen1310 = matchFloat(page1Text, /Fiber\s+Length\s+([\d.]+)\s*ft\s+([\d.]+)\s*ft/, 1);
  const fiberLen1550 = matchFloat(page1Text, /Fiber\s+Length\s+([\d.]+)\s*ft\s+([\d.]+)\s*ft/, 2);
  if (fiberLen1310 !== null && fiberLen1550 !== null) {
    report.link_length_ft = Math.max(fiberLen1310, fiberLen1550);
    report.highest_fiber_end_ft = report.link_length_ft;
  }

  const loss1310 = matchFloat(page1Text, /Total\s+Loss\s+([\d.\-]+)\s*dB\s+([\d.\-]+)\s*dB/, 1);
  const loss1550 = matchFloat(page1Text, /Total\s+Loss\s+([\d.\-]+)\s*dB\s+([\d.\-]+)\s*dB/, 2);
  const ev1310 = matchInt(page1Text, /Total\s+Events\s+(\d+)\s+(\d+)/, 1) || 0;
  const ev1550 = matchInt(page1Text, /Total\s+Events\s+(\d+)\s+(\d+)/, 2) || 0;
  const orl1310 = matchFloat(page1Text, /ORL\s+([\d.]+)\s*dB\s+([\d.]+)\s*dB/, 1) || 0;
  const orl1550 = matchFloat(page1Text, /ORL\s+([\d.]+)\s*dB\s+([\d.]+)\s*dB/, 2) || 0;

  if (page1Text.includes('PASS')) report.overall_result = 'PASS';
  else if (page1Text.includes('FAIL')) report.overall_result = 'FAIL';

  if (loss1310 !== null) {
    report.results_1310 = {
      wavelength_nm: 1310, link_loss_db: loss1310, link_orl_db: orl1310,
      fiber_end_ft: fiberLen1310 || report.link_length_ft, direction: '', events: ev1310,
      passed: report.overall_result !== 'FAIL', highest_reflectance_db: null
    };
  }
  if (loss1550 !== null) {
    report.results_1550 = {
      wavelength_nm: 1550, link_loss_db: loss1550, link_orl_db: orl1550,
      fiber_end_ft: fiberLen1550 || report.link_length_ft, direction: '', events: ev1550,
      passed: report.overall_result !== 'FAIL', highest_reflectance_db: null
    };
  }

  // Event tables for reflectance
  const eventRefl1310: [number, number][] = [];
  const eventRefl1550: [number, number][] = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const pageText = pages[pi].text;
    if (!pageText.includes('Event Table')) continue;
    const is1310 = pageText.includes('1310 nm') || pi === 1;
    const is1550 = pageText.includes('OTDR Trace') || pi === 2;
    const pLines = pageText.split('\n');
    let inEt = false;

    for (const line of pLines) {
      if (line.includes('Event Table')) { inEt = true; continue; }
      if (inEt) {
        if (line.includes('Pass/Fail') || line.includes('Thresholds')) break;
        const evMatch = line.match(/^\s*(\d+)\s+([\d.]+)\s+.*?(-?[\d.]+)\s+(-[\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (evMatch) {
          const eventNum = parseInt(evMatch[1]);
          const refl = parseFloat(evMatch[4]);
          if (is1310 && !is1550) eventRefl1310.push([eventNum, refl]);
          else if (is1550) eventRefl1550.push([eventNum, refl]);
        } else {
          const feMatch = line.match(/Fiber\s+End\s+(-[\d.]+)/);
          if (feMatch) {
            const refl = parseFloat(feMatch[1]);
            if (is1310 && !is1550) eventRefl1310.push([eventRefl1310.length + 1, refl]);
            else if (is1550) eventRefl1550.push([eventRefl1550.length + 1, refl]);
          }
        }
      }
    }
  }

  const hi1310 = filterReflectancePairs(eventRefl1310);
  const hi1550 = filterReflectancePairs(eventRefl1550);
  if (hi1310 !== null && report.results_1310) report.results_1310.highest_reflectance_db = hi1310;
  if (hi1550 !== null && report.results_1550) report.results_1550.highest_reflectance_db = hi1550;

  // Thresholds
  for (const page of pages) {
    if (page.text.includes('Pass/Fail Thresholds')) {
      let tv: number | null;
      tv = matchFloat(page.text, /Reflective\s+Event\s+Loss.*?:\s*([\d.]+)\s*dB/); if (tv !== null) report.thresholds.connector_loss_db = tv;
      tv = matchFloat(page.text, /Non-Reflective\s+Event\s+Loss.*?:\s*([\d.]+)\s*dB/); if (tv !== null) report.thresholds.splice_loss_db = tv;
      tv = matchFloat(page.text, /Reflectance\s*:\s*(-?[\d.]+)\s*dB/); if (tv !== null) report.thresholds.reflectance_db = tv;
      tv = matchFloat(page.text, /ORL\s*:\s*([\d.]+)\s*dB/); if (tv !== null) report.thresholds.orl_db = tv;
      tv = matchFloat(page.text, /Total\s+Loss\s*:\s*([\d.]+)\s*dB/); if (tv !== null) report.thresholds.link_loss_max_db = tv;
      break;
    }
  }

  calcPeaks(report);
  return [report];
}

// ─── Anritsu MT9085 Compiled Single-Wavelength Parser ───

function parseAnritsuMt9085Compiled(pages: PageText[], filename: string): OTDRReport[] {
  const reportsDict: Map<string, OTDRReport> = new Map();
  let i = 0;

  // Helper: fix space-fragmented numbers from pdf.js ("0.7 28" -> "0.728")
  const fixNum = (s: string): string => {
    let prev = '';
    while (prev !== s) { prev = s; s = s.replace(/(\d)\s+(\d)/g, '$1$2').replace(/(\d)\s*\.\s*(\d)/g, '$1.$2').replace(/\.\s+(\d)/g, '.$1'); }
    return s;
  };

  while (i < pages.length) {
    const summaryText = pages[i].text;
    if (!summaryText.includes('Trace summary report')) { i++; continue; }
    const eventText = i + 1 < pages.length ? pages[i + 1].text : '';
    const lines = summaryText.split('\n').map(l => l.trim());

    // Extract File Name — may be blank
    const fileMatch = summaryText.match(/File Name\s*:?\s*([^\n]*)/);
    let fileName = fileMatch ? fileMatch[1].trim() : '';
    
    // If blank, try Notes on same line
    if (!fileName) {
      const notesMatch = summaryText.match(/Notes\s*:?\s*([^\n]+)/);
      if (notesMatch && notesMatch[1].trim() && notesMatch[1].trim() !== ':') {
        fileName = notesMatch[1].replace(/^:\s*/, '').trim();
      }
    }
    // Check orphaned ": value" lines at page bottom
    if (!fileName) {
      const orphanedValues: string[] = [];
      for (let li = lines.length - 1; li >= 0; li--) {
        const l = lines[li];
        if (l.startsWith(': ') && l.length > 2) {
          orphanedValues.unshift(l.slice(2).trim());
        } else if (l === '' || /^\d+$/.test(l) || /^\d+\s*ft$/.test(l)) {
          continue;
        } else {
          break;
        }
      }
      for (const v of orphanedValues) {
        if (/opt|air|fiber|line|port|band/i.test(v)) { fileName = v; break; }
      }
      if (!fileName && orphanedValues.length > 0) fileName = orphanedValues[0];
    }
    if (!fileName) fileName = `${filename}_test_${Math.floor(i / 3) + 1}`;

    // Wavelength detection
    let wavelength: number | null = null;
    const wlMatch = fileName.match(/(\d{4})(?:nm)?\.SOR/i);
    if (wlMatch) wavelength = parseInt(wlMatch[1]);
    if (!wavelength) {
      const wlMatch2 = summaryText.match(/Wavelength\s*:?\s*(\d{4})\s*nm/);
      if (wlMatch2) wavelength = parseInt(wlMatch2[1]);
    }
    if (!wavelength) {
      const wlMatch3 = summaryText.match(/(\d{4})\s*nm\s+Pass/);
      if (wlMatch3) wavelength = parseInt(wlMatch3[1]);
    }
    // OCR fallback: bare "1310 nm" or "1550 nm" in Test Result Summary
    if (!wavelength) {
      const wlMatch4 = summaryText.match(/(?:^|\s)(1310|1550)\s*nm/m);
      if (wlMatch4) wavelength = parseInt(wlMatch4[1]);
    }
    if (!wavelength || (wavelength !== 1310 && wavelength !== 1550)) { i += 3; continue; }

    const baseName = fileName.replace(/_1[35][15]0(?:nm)?\.SOR$/i, '');
    const baseKey = baseName.toLowerCase();

    if (!reportsDict.has(baseKey)) {
      const report = createDefaultReport(baseName, 'ANRITSU');
      let mg: string | null;
      // Customer - handle OCR ">" instead of ":"
      mg = matchGroup(summaryText, /Customer\s*[>:\s]+([A-Z0-9][^\n]*)/); if (mg) report.customer = mg;
      // Location - match "Location : VALUE" but NOT "Terminal Location" or "Start Location"
      const locMatch = summaryText.match(/^Location\s*:\s*(\S[^\n]*)/m);
      if (locMatch && locMatch[1].trim()) report.location_a = locMatch[1].trim();
      mg = matchGroup(summaryText, /Date\/Time\s*:\s*([^\n]+)/); if (mg) report.test_date = mg;
      mg = matchGroup(summaryText, /Cable\s*ID\s*:\s*([^\n]+)/); if (mg) report.cable_id = mg;
      mg = matchGroup(summaryText, /Fiber\s*ID\s*:\s*([^\n]+)/); if (mg) report.fiber_id = mg;
      mg = matchGroup(summaryText, /Start\s*Location\s*:\s*([^\n]+)/); if (mg) report.location_a = mg;
      mg = matchGroup(summaryText, /Terminal\s*Location\s*:\s*([^\n]+)/); if (mg) report.location_b = mg;

      // Extract orphaned bottom values for Location and Date
      const orphanedValues: string[] = [];
      for (let li = lines.length - 1; li >= 0; li--) {
        const l = lines[li];
        if (l.startsWith(': ') && l.length > 2) {
          orphanedValues.unshift(l.slice(2).trim());
        } else if (l === '' || /^\d+$/.test(l) || /^\d+\s*ft$/.test(l)) {
          continue;
        } else {
          break;
        }
      }
      for (const v of orphanedValues) {
        if (/^\d{4}-\w+-\d+/.test(v) && !report.test_date) report.test_date = v;
        else if (!report.location_a && !/opt|air|fiber/i.test(v) && !/^\d{4}/.test(v)) report.location_a = v;
      }

      const opMatches = summaryText.match(/Operator\s*:\s*(\S[^\n]*)/g);
      if (opMatches) {
        for (const op of opMatches) {
          const val = op.replace(/Operator\s*:\s*/, '').trim();
          if (val) { report.technician_id = val; break; }
        }
      }

      const instMatch = summaryText.match(/(MT\d+[A-Z0-9\-]*)\s*\((\d+)\)/);
      if (instMatch) { report.model_1 = instMatch[1].trim(); report.serial_1 = instMatch[2].trim(); }
      else {
        // OCR fallback: value on separate line ": MT9083A2-063 (6261755857)"
        const instMatch2 = summaryText.match(/:\s*(MT\d+[A-Z0-9\-]*)\s*\((\d+)\)/);
        if (instMatch2) { report.model_1 = instMatch2[1].trim(); report.serial_1 = instMatch2[2].trim(); }
      }
      mg = matchGroup(summaryText, /Calibration\s*:\s*([^\n]+)/); if (mg) report.calibration_date = mg;
      // OCR calibration fallback: standalone date line after instrument
      if (!report.calibration_date) {
        mg = matchGroup(summaryText, /:\s*(\d{4}\s+(?:March|January|February|April|May|June|July|August|September|October|November|December)\s+\d+)/);
        if (mg) report.calibration_date = mg;
      }

      // Thresholds - try multiple sources (event page, trace page, summary)
      const traceText = i + 2 < pages.length ? pages[i + 2].text : '';
      const combinedDetail = eventText + '\n' + traceText;
      let tv: number | null;
      for (const tText of [eventText, traceText, combinedDetail]) {
        if (tText.includes('Pass/Fail') || tText.includes('Thresholds')) {
          tv = matchFloat(tText, /Non-Reflective\s+Event\s+Loss.*?:\s*([\d.]+)\s*dB/); if (tv !== null && !report.thresholds.splice_loss_db) report.thresholds.splice_loss_db = tv;
          tv = matchFloat(tText, /(?<!Non-)Reflective\s+Event\s+Loss.*?:\s*([\d.]+)\s*dB/); if (tv !== null && !report.thresholds.connector_loss_db) report.thresholds.connector_loss_db = tv;
          tv = matchFloat(tText, /Reflectance\s*[:\s]+(-?[\d.]+)\s*dB/); if (tv !== null && !report.thresholds.reflectance_db) report.thresholds.reflectance_db = tv;
          tv = matchFloat(tText, /Total\s+Loss\s*[:\s]+([\d.]+)\s*dB/); if (tv !== null && !report.thresholds.link_loss_max_db) report.thresholds.link_loss_max_db = tv;
          tv = matchFloat(tText, /ORL\s*[:\s]+([\d.]+)\s*dB/); if (tv !== null && !report.thresholds.orl_db) report.thresholds.orl_db = tv;
          break;
        }
      }
      // Also check page 3 for vertical ": value" threshold format
      const threshPage = traceText;
      if (!report.thresholds.splice_loss_db) {
        const threshVals: number[] = [];
        for (const tm of Array.from((threshPage || combinedDetail).matchAll(/:\s*([\d.\-]+)\s*dB(?:\/km)?/g))) {
          threshVals.push(parseFloat(tm[1]));
        }
        if (threshVals.length >= 6) {
          report.thresholds.splice_loss_db = threshVals[0];
          report.thresholds.connector_loss_db = threshVals[1];
          report.thresholds.reflectance_db = threshVals[2];
          report.thresholds.link_loss_max_db = threshVals[4];
          report.thresholds.orl_db = threshVals[5];
        }
      }

      reportsDict.set(baseKey, report);
    }

    const report = reportsDict.get(baseKey)!;

    // Parse Test Result Summary with space-fragmented number support
    let fiberLength = 0.0;
    let totalLoss: number | null = null;
    let totalEvents = 0;
    let orl = 0.0;
    let passed = true;

    // Fiber Length: find "NNN ft" line near summary
    const flIdx = lines.findIndex(l => l.includes('Fiber Length'));
    if (flIdx >= 0) {
      for (let fi = flIdx; fi < Math.min(flIdx + 10, lines.length); fi++) {
        const ftm = lines[fi].match(/^(\d+)\s*ft$/);
        if (ftm) { fiberLength = parseFloat(ftm[1]); break; }
      }
    }
    if (!fiberLength) {
      const flm = summaryText.match(/Fiber\s+Length\s+([\d.]+)\s*ft/);
      if (flm) fiberLength = parseFloat(flm[1]);
    }

    // Total Loss — handle both normal "Total Loss  -0.400 dB" and OCR space-fragmented formats
    let tlMatch = summaryText.match(/Total\s+Loss\s+([\d.\-]+)/);
    if (tlMatch) {
      totalLoss = parseFloat(fixNum(tlMatch[1].trim()));
    } else {
      // Fallback for space-fragmented OCR: "Total Loss  -0. 400"
      const tlMatch2 = summaryText.match(/Total\s+Loss\s+([\d.\s\-]+?)(?:\n|Total|$)/);
      if (tlMatch2) totalLoss = parseFloat(fixNum(tlMatch2[1].trim()));
    }

    const teMatch = summaryText.match(/Total\s+Events\s+(\d+)/);
    if (teMatch) totalEvents = parseInt(teMatch[1]);

    const orlMatch = summaryText.match(/ORL\s+([\d.]+)\s*dB/);
    if (orlMatch) orl = parseFloat(orlMatch[1]);

    if (summaryText.includes('FAIL')) { passed = false; report.overall_result = 'FAIL'; }
    else if (summaryText.includes('PASS') && !report.overall_result) report.overall_result = 'PASS';

    // Event table reflectance
    const eventReflPairs: [number, number][] = [];
    const evSource = eventText || summaryText;
    if (evSource.includes('Event Table')) {
      const eLines = evSource.split('\n');
      let inEt = false;
      for (const line of eLines) {
        if (line.includes('Event Table')) { inEt = true; continue; }
        if (inEt) {
          if (line.includes('Pass/Fail') || line.includes('Thresholds')) break;
          const evMatch = line.match(/^\s*(\d+)\s+/);
          if (!evMatch) continue;
          const eventNum = parseInt(evMatch[1]);
          // Clean OCR artifacts: ~ instead of -, em-dash instead of -
          const fixedLine = fixNum(line.replace(/~/g, '-').replace(/—/g, '-'));
          const parts = fixedLine.split(/\s+/);
          for (const p of parts.slice(1)) {
            if (p.startsWith('**') || /^(M|Fiber|End|GM|ENA)$/i.test(p)) continue;
            const val = parseFloat(p);
            if (!isNaN(val) && val < -14.0) { eventReflPairs.push([eventNum, val]); break; }
            // OCR may drop the minus sign on reflectance values
            // If we see a large positive value (>14), it's likely a missing minus
            if (!isNaN(val) && val > 14.0 && val < 70.0) { eventReflPairs.push([eventNum, -val]); break; }
          }
        }
      }
    }

    const highestRefl = filterReflectancePairs(eventReflPairs);

    if (totalLoss !== null && !isNaN(totalLoss)) {
      const result: OTDRResult = {
        wavelength_nm: wavelength, link_loss_db: totalLoss, link_orl_db: orl,
        fiber_end_ft: fiberLength, direction: '', events: totalEvents,
        passed, highest_reflectance_db: highestRefl
      };
      if (wavelength === 1310) report.results_1310 = result;
      else report.results_1550 = result;
    }

    i += 3;
  }

  const results = Array.from(reportsDict.values());
  for (const report of results) {
    calcLinkLength(report);
    calcPeaks(report);
  }
  return results;
}

// ─── Anritsu MT9085 Dispatcher ───

function parseAnritsuMt9085Report(pages: PageText[], filename: string): OTDRReport[] {
  if (pages.length === 0) return [];
  const firstSummary = pages[0].text;
  const hasDual = /1310\s*nm\s+1550\s*nm/.test(firstSummary);
  if (hasDual) return parseAnritsuMt9085Dual(pages, filename);
  return parseAnritsuMt9085Compiled(pages, filename);
}

// ─── Wavelength Report Merger ───

export function mergeWavelengthReports(reports: OTDRReport[]): OTDRReport[] {
  const groups: Map<string, [string, OTDRReport][]> = new Map();

  for (const report of reports) {
    let baseName = report.filename;
    baseName = baseName.replace(/[\s_]*(1310|1550)[\s_]*\.pdf$/i, '.pdf');
    baseName = baseName.replace(/[\s_]*(1310|1550)[\s_]*\.sor\.pdf$/i, '.sor.pdf');
    baseName = baseName.replace(/[\s_]*(1310|1550)[\s_]*\.msor\.pdf$/i, '.msor.pdf');
    baseName = baseName.replace(/\.pdf$/i, '').replace(/[\s_]*(1310|1550)$/i, '').trim();
    // Strip wavelength from mid-filename: "name-1310-timestamp" -> "name--timestamp"
    baseName = baseName.replace(/-(?:1310|1550)-/g, '--');
    // Also handle _1310nm or _1550nm patterns
    baseName = baseName.replace(/[_-](?:1310|1550)(?:nm)?(?=[_.\-])/gi, '');
    baseName = baseName.trim();
    const key = normalizeTestName(baseName).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push([baseName, report]);
  }

  const merged: OTDRReport[] = [];
  for (const [, groupItems] of groups) {
    if (groupItems.length === 1) { merged.push(groupItems[0][1]); continue; }

    let report1310: OTDRReport | null = null;
    let report1550: OTDRReport | null = null;
    const baseName = groupItems[0][0];

    for (const [, report] of groupItems) {
      if (report.results_1310 && !report1310) report1310 = report;
      if (report.results_1550 && !report1550) report1550 = report;
    }

    const baseReport = report1310 || report1550 || groupItems[0][1];
    const mergedReport: OTDRReport = {
      ...createDefaultReport(baseName, baseReport.format_type),
      cable_id: baseReport.cable_id, fiber_id: baseReport.fiber_id,
      location_a: baseReport.location_a, location_b: baseReport.location_b,
      job_id: baseReport.job_id, technician_id: baseReport.technician_id,
      test_date: baseReport.test_date, customer: baseReport.customer,
      company: baseReport.company, model_1: baseReport.model_1,
      serial_1: baseReport.serial_1, model_2: baseReport.model_2,
      serial_2: baseReport.serial_2, calibration_date: baseReport.calibration_date,
      calibration_due: baseReport.calibration_due,
      thresholds: { ...baseReport.thresholds },
      overall_result: baseReport.overall_result,
    };

    for (const [, report] of groupItems) {
      if (report.results_1310 && !mergedReport.results_1310) mergedReport.results_1310 = report.results_1310;
      if (report.results_1550 && !mergedReport.results_1550) mergedReport.results_1550 = report.results_1550;
      if (!mergedReport.test_date && report.test_date) mergedReport.test_date = report.test_date;
      if (!mergedReport.technician_id && report.technician_id) mergedReport.technician_id = report.technician_id;
      if (!mergedReport.model_1 && report.model_1) { mergedReport.model_1 = report.model_1; mergedReport.serial_1 = report.serial_1; }
      if (!mergedReport.model_2 && report.model_2) { mergedReport.model_2 = report.model_2; mergedReport.serial_2 = report.serial_2; }
    }

    calcLinkLength(mergedReport);
    calcPeaks(mergedReport);
    if (mergedReport.results_1310 && mergedReport.results_1550) {
      mergedReport.filename = `${baseName} (1310+1550)`;
    }
    merged.push(mergedReport);
  }

  return merged;
}

// ─── Main Entry Point ───

export async function parseOtdrReports(
  file: File,
  forceFormat: FormatType = 'auto',
  onProgress?: (msg: string) => void
): Promise<OTDRReport[]> {
  onProgress?.(`Reading: ${file.name}`);
  const pages = await extractPagesFromPdf(file, onProgress);
  const fullText = pages.map(p => p.text).join('\n');
  const fmt = forceFormat === 'auto' ? detectFormat(fullText) : forceFormat;
  const filename = file.name;

  onProgress?.(`Detected format: ${fmt} — Parsing...`);

  switch (fmt) {
    case 'ANRITSU':
      return parseAnritsuMultipage(pages, filename);
    case 'ANRITSU_MT9085':
      return parseAnritsuMt9085Report(pages, filename);
    case 'VIAVI_SINGLE':
      return parseViaviSingleReport(pages, filename);
    case 'EXFO_FTBX':
      return [parseExfoFtbxReport(pages, filename)];
    case 'EXFO_IOLM':
      return parseExfoIolmMultipage(pages, filename);
    case 'EXFO':
      return [parseExfoReport(fullText, filename)];
    default: {
      // VIAVI - check if compiled multi-test
      if (pages.length >= 6) {
        const fileNames = new Set<string>();
        for (const page of pages.slice(0, 12)) {
          const m = page.text.match(/File\s*:\s*([^\n]+)/);
          if (m) fileNames.add(m[1].trim().replace(/\.$/, ''));
        }
        if (fileNames.size > 1) return parseViaviCompiledMultitest(pages, filename);
      }
      return [parseViaviReport(fullText, filename, pages)];
    }
  }
}
