// Types mirroring the Python dataclasses from OTDR Analyzer v8.3

export interface Thresholds {
  connector_loss_db: number | null;
  splice_loss_db: number | null;
  reflectance_db: number | null;
  orl_db: number | null;
  link_loss_max_db: number | null;
}

export interface OTDRResult {
  wavelength_nm: number;
  link_loss_db: number;
  link_orl_db: number;
  fiber_end_ft: number;
  direction: string;
  events: number;
  passed: boolean;
  highest_reflectance_db: number | null;
}

export interface OTDRReport {
  filename: string;
  format_type: string;
  cable_id: string;
  fiber_id: string;
  location_a: string;
  location_b: string;
  job_id: string;
  technician_id: string;
  test_date: string;
  customer: string;
  company: string;
  model_1: string;
  serial_1: string;
  model_2: string;
  serial_2: string;
  calibration_date: string;
  calibration_due: string;
  results_1310: OTDRResult | null;
  results_1550: OTDRResult | null;
  highest_fiber_end_ft: number;
  link_length_ft: number;
  thresholds: Thresholds;
  overall_result: string;
  peak_reflectance_db: number | null;
  peak_orl_db: number | null;
}

export type FormatType = 'auto' | 'VIAVI' | 'VIAVI_SINGLE' | 'EXFO' | 'EXFO_FTBX' | 'EXFO_IOLM' | 'ANRITSU' | 'ANRITSU_MT9085';
export type ExportFormat = 'xlsx' | 'csv' | 'json';

export function createDefaultThresholds(): Thresholds {
  return {
    connector_loss_db: null,
    splice_loss_db: null,
    reflectance_db: null,
    orl_db: null,
    link_loss_max_db: null,
  };
}

export function createDefaultReport(filename: string, format_type: string): OTDRReport {
  return {
    filename,
    format_type,
    cable_id: '',
    fiber_id: '',
    location_a: '',
    location_b: '',
    job_id: '',
    technician_id: '',
    test_date: '',
    customer: '',
    company: '',
    model_1: '',
    serial_1: '',
    model_2: '',
    serial_2: '',
    calibration_date: '',
    calibration_due: '',
    results_1310: null,
    results_1550: null,
    highest_fiber_end_ft: 0,
    link_length_ft: 0,
    thresholds: createDefaultThresholds(),
    overall_result: '',
    peak_reflectance_db: null,
    peak_orl_db: null,
  };
}

export function createOTDRResult(wavelength_nm: number, link_loss_db: number, link_orl_db: number): OTDRResult {
  return {
    wavelength_nm,
    link_loss_db,
    link_orl_db,
    fiber_end_ft: 0,
    direction: '',
    events: 0,
    passed: true,
    highest_reflectance_db: null,
  };
}
