/**
 * @fileoverview Issue #287 Phase 4: QuantityFact / 数量集計結果の CSV serializer。
 *
 * UI / Three.js / DOM に依存せず、UTF-8 BOM + CRLF の Excel 互換 CSV を生成する。
 */

import { mm2ToM2, mm3ToM3 } from '../core/QuantityUnits.js';

export const QUANTITY_CSV_STATUS_ORDER = Object.freeze([
  'CALCULATED',
  'PARTIAL',
  'INSUFFICIENT_DATA',
  'UNSUPPORTED',
  'NOT_APPLICABLE',
  'INVALID_GEOMETRY',
]);

const MEASURE_OUTPUT = Object.freeze({
  count: Object.freeze({ key: 'count', convert: (value) => Number(value) }),
  lengthMm: Object.freeze({ key: 'length_m', convert: (value) => Number(value) / 1_000 }),
  surfaceAreaMm2: Object.freeze({ key: 'surface_area_m2', convert: (value) => mm2ToM2(value) }),
  grossVolumeMm3: Object.freeze({ key: 'gross_volume_m3', convert: (value) => mm3ToM3(value) }),
  netVolumeMm3: Object.freeze({ key: 'net_volume_m3', convert: (value) => mm3ToM3(value) }),
  concreteVolumeMm3: Object.freeze({
    key: 'concrete_volume_m3',
    convert: (value) => mm3ToM3(value),
  }),
  structuralSteelVolumeMm3: Object.freeze({
    key: 'structural_steel_volume_m3',
    convert: (value) => mm3ToM3(value),
  }),
});

const DIMENSION_OUTPUT = Object.freeze({
  storyName: 'story_name',
  memberCategory: 'member_category',
  kindStructure: 'kind_structure',
  sectionName: 'section_name',
});

const FACT_COLUMNS = Object.freeze([
  'model_side',
  'element_type',
  'element_id',
  'guid',
  'story_id',
  'story_name',
  'story_height_m',
  'story_height_match_key',
  'story_resolution',
  'member_category',
  'kind_structure',
  'section_id',
  'section_name',
  'section_id_fd',
  'section_name_fd',
  'section_id_wr',
  'section_name_wr',
  'status',
  'count',
  'length_m',
  'surface_area_m2',
  'gross_volume_m3',
  'net_volume_m3',
  'concrete_volume_m3',
  'structural_steel_volume_m3',
  'warning_count',
  'warnings',
]);

function normalizeCsvValue(value) {
  return value === null || value === undefined || Number.isNaN(value) ? '' : value;
}

function escapeCsvCell(value) {
  const normalized = normalizeCsvValue(value);
  const text = String(normalized);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function serializeRows(columns, rows) {
  const lines = [columns.map(escapeCsvCell).join(',')];
  for (const row of rows || []) {
    lines.push(columns.map((column) => escapeCsvCell(row?.[column])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function normalizeDecimalDigits(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const digits = Number(value);
  return Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : fallback;
}

function roundToDecimalDigits(value, decimalDigits) {
  const digits = normalizeDecimalDigits(decimalDigits);
  if (digits === null) return value;
  const factor = 10 ** digits;
  return Math.round((value + Math.sign(value) * Number.EPSILON) * factor) / factor;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function convertQuantityMeasureForCsv(measure, value, decimalDigits = null) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const definition = MEASURE_OUTPUT[measure];
  if (!definition) return number;
  const converted = definition.convert(number);
  return Number.isFinite(converted) ? roundToDecimalDigits(converted, decimalDigits) : null;
}

export function getQuantityMeasureCsvKey(measure) {
  return MEASURE_OUTPUT[measure]?.key || String(measure || 'measure');
}

function summaryDimensions(state = {}) {
  const dimensions = [];
  if (state.dimension1) dimensions.push(state.dimension1);
  if (state.dimension2 && state.dimension2 !== 'none' && state.dimension2 !== state.dimension1) {
    dimensions.push(state.dimension2);
  }
  return dimensions;
}

function appendStatusColumns(columns, prefix = '') {
  for (const status of QUANTITY_CSV_STATUS_ORDER) {
    columns.push(`${prefix}status_${status.toLowerCase()}_count`);
  }
}

function assignStatusCounts(target, statusCounts, prefix = '') {
  for (const status of QUANTITY_CSV_STATUS_ORDER) {
    target[`${prefix}status_${status.toLowerCase()}_count`] = Number(statusCounts?.[status] || 0);
  }
}

function assignSummaryDimensions(target, row, dimensions) {
  for (const dimension of dimensions) {
    target[DIMENSION_OUTPUT[dimension] || dimension] = row?.[dimension] ?? '未分類';
  }
}

function summaryDimensionColumns(dimensions) {
  return dimensions.map((dimension) => DIMENSION_OUTPUT[dimension] || dimension);
}

/**
 * 現在の集計 state に対応する集計結果 CSV を生成する。
 * rows は UI で sort 済みの全 row を渡すことを想定し、ページングは適用しない。
 */
export function serializeQuantitySummaryCsv(rows, state = {}) {
  const dimensions = summaryDimensions(state);
  const columns = summaryDimensionColumns(dimensions);
  const measure = state.measure || 'count';
  const measureKey = getQuantityMeasureCsvKey(measure);
  const decimalDigits = normalizeDecimalDigits(state.decimalDigits, 3);
  const isComparison = state.modelSide === 'AB';
  const isGeometryStoryMatch =
    isComparison && state.storyMatchCriterion === 'geometry' && dimensions.includes('storyName');

  if (isGeometryStoryMatch) {
    columns.push('story_name_a', 'story_name_b', 'story_height_m');
  }

  if (isComparison) {
    columns.push('a_count', 'b_count');
    if (measure === 'count') {
      columns.push('delta_count');
    } else {
      columns.push(
        `a_${measureKey}`,
        `a_partial_${measureKey}`,
        `b_${measureKey}`,
        `b_partial_${measureKey}`,
        `delta_${measureKey}`,
        `partial_delta_${measureKey}`,
      );
    }
    appendStatusColumns(columns, 'a_');
    appendStatusColumns(columns, 'b_');
  } else {
    columns.push('count');
    if (measure !== 'count') {
      columns.push(`confirmed_${measureKey}`, `partial_${measureKey}`);
    }
    appendStatusColumns(columns);
  }

  const csvRows = (rows || []).map((row) => {
    const output = {};
    assignSummaryDimensions(output, row, dimensions);

    if (isGeometryStoryMatch) {
      output.story_name_a = row?.storyNameA ?? '';
      output.story_name_b = row?.storyNameB ?? '';
      const height = toFiniteNumber(row?.storyHeightMm);
      output.story_height_m = height === null ? '' : height / 1_000;
    }

    if (isComparison) {
      output.a_count = Number(row?.countA || 0);
      output.b_count = Number(row?.countB || 0);
      if (measure === 'count') {
        output.delta_count = output.b_count - output.a_count;
      } else {
        output[`a_${measureKey}`] = convertQuantityMeasureForCsv(
          measure,
          row?.measureA,
          decimalDigits,
        );
        output[`a_partial_${measureKey}`] = convertQuantityMeasureForCsv(
          measure,
          row?.partialMeasureA,
          decimalDigits,
        );
        output[`b_${measureKey}`] = convertQuantityMeasureForCsv(
          measure,
          row?.measureB,
          decimalDigits,
        );
        output[`b_partial_${measureKey}`] = convertQuantityMeasureForCsv(
          measure,
          row?.partialMeasureB,
          decimalDigits,
        );
        output[`delta_${measureKey}`] = convertQuantityMeasureForCsv(
          measure,
          row?.delta,
          decimalDigits,
        );
        output[`partial_delta_${measureKey}`] = convertQuantityMeasureForCsv(
          measure,
          row?.partialDelta,
          decimalDigits,
        );
      }
      assignStatusCounts(output, row?.statusCountsA, 'a_');
      assignStatusCounts(output, row?.statusCountsB, 'b_');
      return output;
    }

    output.count = Number(row?.count || 0);
    if (measure !== 'count') {
      output[`confirmed_${measureKey}`] = convertQuantityMeasureForCsv(
        measure,
        row?.confirmedMeasures?.[measure],
        decimalDigits,
      );
      output[`partial_${measureKey}`] = convertQuantityMeasureForCsv(
        measure,
        row?.partialMeasures?.[measure],
        decimalDigits,
      );
    }
    assignStatusCounts(output, row?.statusCounts);
    return output;
  });

  return serializeRows(columns, csvRows);
}

function factRow(fact, decimalDigits = null) {
  const quantity = fact?.quantity || {};
  const storyHeight = toFiniteNumber(fact?.storyHeightMm);
  return {
    model_side: fact?.modelSide ?? '',
    element_type: fact?.elementType ?? '',
    element_id: fact?.elementId ?? '',
    guid: fact?.guid ?? '',
    story_id: fact?.storyId ?? '',
    story_name: fact?.storyName ?? '',
    story_height_m: storyHeight === null ? '' : storyHeight / 1_000,
    story_height_match_key: fact?.storyHeightMatchKey ?? '',
    story_resolution: fact?.storyResolution ?? '',
    member_category: fact?.memberCategory ?? '',
    kind_structure: fact?.kindStructure ?? '',
    section_id: fact?.sectionId ?? '',
    section_name: fact?.sectionName ?? '',
    section_id_fd: fact?.sectionIdFD ?? '',
    section_name_fd: fact?.sectionNameFD ?? '',
    section_id_wr: fact?.sectionIdWR ?? '',
    section_name_wr: fact?.sectionNameWR ?? '',
    status: fact?.status ?? '',
    count: convertQuantityMeasureForCsv('count', quantity.count ?? 1, decimalDigits),
    length_m: convertQuantityMeasureForCsv('lengthMm', quantity.lengthMm, decimalDigits),
    surface_area_m2: convertQuantityMeasureForCsv(
      'surfaceAreaMm2',
      quantity.surfaceAreaMm2,
      decimalDigits,
    ),
    gross_volume_m3: convertQuantityMeasureForCsv(
      'grossVolumeMm3',
      quantity.grossVolumeMm3,
      decimalDigits,
    ),
    net_volume_m3: convertQuantityMeasureForCsv(
      'netVolumeMm3',
      quantity.netVolumeMm3,
      decimalDigits,
    ),
    concrete_volume_m3: convertQuantityMeasureForCsv(
      'concreteVolumeMm3',
      quantity.concreteVolumeMm3,
      decimalDigits,
    ),
    structural_steel_volume_m3: convertQuantityMeasureForCsv(
      'structuralSteelVolumeMm3',
      quantity.structuralSteelVolumeMm3,
      decimalDigits,
    ),
    warning_count: Array.isArray(fact?.warnings) ? fact.warnings.length : 0,
    warnings: Array.isArray(fact?.warnings) ? fact.warnings.join(' | ') : '',
  };
}

/**
 * QuantityFact を 1 行 1 部材で出力する。
 * null は空欄、数値 0 は 0 のまま保持する。
 */
export function serializeQuantityFactsCsv(facts, options = {}) {
  const decimalDigits = normalizeDecimalDigits(options?.decimalDigits);
  return serializeRows(
    FACT_COLUMNS,
    (Array.isArray(facts) ? facts : []).map((fact) => factRow(fact, decimalDigits)),
  );
}

export function buildQuantityCsvFilename(kind, modelSide, now = new Date()) {
  const safeKind = kind === 'facts' ? 'facts' : 'summary';
  const side = modelSide === 'B' ? 'B' : modelSide === 'AB' ? 'AB' : 'A';
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `quantity-${safeKind}-${side}-${stamp}.csv`;
}

export default {
  serializeQuantitySummaryCsv,
  serializeQuantityFactsCsv,
  convertQuantityMeasureForCsv,
  getQuantityMeasureCsvKey,
  buildQuantityCsvFilename,
};
