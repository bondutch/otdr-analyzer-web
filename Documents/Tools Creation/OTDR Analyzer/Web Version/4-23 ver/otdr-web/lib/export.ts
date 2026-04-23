/**
 * Export module for OTDR Analyzer results
 * Supports CSV, JSON, and Excel (xlsx) with color-coded columns
 * Matches Python openpyxl formatting: colored headers, borders, freeze panes, auto-width
 */

import { OTDRReport } from './types';
import { saveAs } from 'file-saver';
import XLSX from 'xlsx-js-style';

const HEADERS = [
  'Filename', 'Format', 'Cable ID', 'Fiber ID', 'Location A', 'Location B',
  'Job ID', 'Technician', 'Customer', 'Company', 'Test Date', 'Result',
  'Model 1', 'Serial 1', 'Model 2', 'Serial 2', 'Cal Date', 'Cal Due',
  '1310 Loss (dB)', '1310 ORL (dB)', '1310 End (ft)', '1310 Events', '1310 Hi Refl (dB)',
  '1550 Loss (dB)', '1550 ORL (dB)', '1550 End (ft)', '1550 Events', '1550 Hi Refl (dB)',
  'Link Length (ft)', 'Peak Refl (dB)', 'Peak ORL (dB)',
  'Thresh: Conn Loss', 'Thresh: Splice Loss', 'Thresh: Reflectance',
  'Thresh: ORL', 'Thresh: Link Loss Max'
];

// Column ranges (0-indexed) matching Python's 1-indexed ranges
const EQUIP_COLS = [12, 13, 14, 15, 16, 17];
const WL_1310_COLS = [18, 19, 20, 21, 22];
const WL_1550_COLS = [23, 24, 25, 26, 27];
const LINK_COL = 28;
const PEAK_COLS = [29, 30];
const THRESH_COLS = [31, 32, 33, 34, 35];
const RESULT_COL = 11;

// Colors matching Python openpyxl export
const COLORS = {
  headerDefault: '4472C4',
  headerEquip: '70AD47',
  header1310: 'BDD7EE',
  header1550: 'FCE4D6',
  headerPeak: 'E2EFDA',
  headerThresh: 'FFC000',
  pass: 'C6EFCE',
  fail: 'FFC7CE',
};

const thinBorder = {
  top: { style: 'thin' as const, color: { rgb: 'B0B0B0' } },
  bottom: { style: 'thin' as const, color: { rgb: 'B0B0B0' } },
  left: { style: 'thin' as const, color: { rgb: 'B0B0B0' } },
  right: { style: 'thin' as const, color: { rgb: 'B0B0B0' } },
};

function getHeaderStyle(colIdx: number): object {
  let bgColor = COLORS.headerDefault;
  let fontColor = 'FFFFFF';

  if (EQUIP_COLS.includes(colIdx)) {
    bgColor = COLORS.headerEquip;
  } else if (WL_1310_COLS.includes(colIdx)) {
    bgColor = COLORS.header1310; fontColor = '000000';
  } else if (WL_1550_COLS.includes(colIdx)) {
    bgColor = COLORS.header1550; fontColor = '000000';
  } else if (colIdx === LINK_COL || PEAK_COLS.includes(colIdx)) {
    bgColor = COLORS.headerPeak; fontColor = '000000';
  } else if (THRESH_COLS.includes(colIdx)) {
    bgColor = COLORS.headerThresh; fontColor = '000000';
  }

  return {
    font: { bold: true, color: { rgb: fontColor }, sz: 10 },
    fill: { fgColor: { rgb: bgColor } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: thinBorder,
  };
}

function getDataStyle(colIdx: number, value: unknown): object {
  const base: Record<string, unknown> = {
    font: { sz: 10 },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: thinBorder,
  };

  if (colIdx === 0) {
    base.alignment = { horizontal: 'left', vertical: 'center' };
  }

  if (colIdx === RESULT_COL) {
    const v = String(value || '').toUpperCase();
    if (v === 'PASS') {
      base.fill = { fgColor: { rgb: COLORS.pass } };
      base.font = { sz: 10, bold: true, color: { rgb: '006100' } };
    } else if (v === 'FAIL') {
      base.fill = { fgColor: { rgb: COLORS.fail } };
      base.font = { sz: 10, bold: true, color: { rgb: '9C0006' } };
    }
  }

  if (WL_1310_COLS.includes(colIdx) && !base.fill) {
    base.fill = { fgColor: { rgb: 'EDF4FB' } };
  } else if (WL_1550_COLS.includes(colIdx) && !base.fill) {
    base.fill = { fgColor: { rgb: 'FDF2EB' } };
  }

  return base;
}

function reportToRow(r: OTDRReport): (string | number)[] {
  return [
    r.filename, r.format_type, r.cable_id, r.fiber_id, r.location_a, r.location_b,
    r.job_id, r.technician_id, r.customer, r.company, r.test_date, r.overall_result,
    r.model_1, r.serial_1, r.model_2, r.serial_2, r.calibration_date, r.calibration_due,
    r.results_1310?.link_loss_db ?? '', r.results_1310?.link_orl_db ?? '',
    r.results_1310?.fiber_end_ft ?? '', r.results_1310?.events ?? '',
    r.results_1310?.highest_reflectance_db ?? '',
    r.results_1550?.link_loss_db ?? '', r.results_1550?.link_orl_db ?? '',
    r.results_1550?.fiber_end_ft ?? '', r.results_1550?.events ?? '',
    r.results_1550?.highest_reflectance_db ?? '',
    r.link_length_ft || r.highest_fiber_end_ft,
    r.peak_reflectance_db ?? '', r.peak_orl_db ?? '',
    r.thresholds.connector_loss_db ?? '', r.thresholds.splice_loss_db ?? '',
    r.thresholds.reflectance_db ?? '', r.thresholds.orl_db ?? '',
    r.thresholds.link_loss_max_db ?? '',
  ];
}

export function exportToJson(reports: OTDRReport[], filename: string): void {
  const data = reports.map(r => {
    const obj: Record<string, unknown> = {
      filename: r.filename, format_type: r.format_type,
      cable_id: r.cable_id, fiber_id: r.fiber_id,
      location_a: r.location_a, location_b: r.location_b,
      job_id: r.job_id, technician_id: r.technician_id,
      test_date: r.test_date, customer: r.customer, company: r.company,
      model_1: r.model_1, serial_1: r.serial_1, model_2: r.model_2, serial_2: r.serial_2,
      calibration_date: r.calibration_date, calibration_due: r.calibration_due,
      highest_fiber_end_ft: r.highest_fiber_end_ft,
      link_length_ft: r.link_length_ft, overall_result: r.overall_result,
      thresholds: r.thresholds,
    };
    if (r.results_1310) obj['1310nm'] = r.results_1310;
    if (r.results_1550) obj['1550nm'] = r.results_1550;
    return obj;
  });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  saveAs(blob, filename);
}

export function exportToCsv(reports: OTDRReport[], filename: string): void {
  const rows = [HEADERS.join(',')];
  for (const r of reports) {
    const row = reportToRow(r).map(v => {
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    });
    rows.push(row.join(','));
  }
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  saveAs(blob, filename);
}

export function exportToExcel(reports: OTDRReport[], filename: string): void {
  const wb = XLSX.utils.book_new();
  const data = [HEADERS, ...reports.map(reportToRow)];
  const ws = XLSX.utils.aoa_to_sheet(data);

  // Apply header styles
  for (let c = 0; c < HEADERS.length; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[ref]) ws[ref].s = getHeaderStyle(c);
  }

  // Apply data cell styles
  for (let r = 0; r < reports.length; r++) {
    const rowData = reportToRow(reports[r]);
    for (let c = 0; c < HEADERS.length; c++) {
      const ref = XLSX.utils.encode_cell({ r: r + 1, c });
      if (ws[ref]) ws[ref].s = getDataStyle(c, rowData[c]);
    }
  }

  // Auto-width columns
  const colWidths: number[] = HEADERS.map(h => h.length);
  for (const report of reports) {
    const row = reportToRow(report);
    for (let c = 0; c < row.length; c++) {
      const len = String(row[c]).length;
      if (len > colWidths[c]) colWidths[c] = len;
    }
  }
  ws['!cols'] = colWidths.map(w => ({ wch: Math.min(w + 3, 30) }));

  // Freeze top row
  ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', state: 'frozen' };

  // Header row height
  ws['!rows'] = [{ hpt: 30 }];

  XLSX.utils.book_append_sheet(wb, ws, 'OTDR Results');

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, filename);
}
