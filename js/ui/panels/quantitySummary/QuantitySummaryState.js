import {
  DEFAULT_STORY_AXIS_MATCH_CRITERION,
  STORY_AXIS_MATCH_CRITERION,
} from '../../../config/comparisonKeyConfig.js';
import { QuantityStatus } from '../../../quantities/core/QuantityStatus.js';

const QUANTITY_SUMMARY_DIMENSIONS = Object.freeze([
  Object.freeze({ key: 'storyName', label: '階' }),
  Object.freeze({ key: 'memberCategory', label: '部材種別' }),
  Object.freeze({ key: 'kindStructure', label: '構造種別' }),
  Object.freeze({ key: 'sectionName', label: '断面' }),
]);

const QUANTITY_SUMMARY_MEASURES = Object.freeze([
  Object.freeze({ key: 'count', label: '件数', unit: '件' }),
  Object.freeze({ key: 'lengthMm', label: '長さ', unit: 'm' }),
  Object.freeze({ key: 'surfaceAreaMm2', label: '面積', unit: 'm²' }),
  Object.freeze({ key: 'grossVolumeMm3', label: '総体積', unit: 'm³' }),
  Object.freeze({ key: 'netVolumeMm3', label: '正味体積', unit: 'm³' }),
  Object.freeze({ key: 'concreteVolumeMm3', label: 'コンクリート体積', unit: 'm³' }),
  Object.freeze({ key: 'structuralSteelVolumeMm3', label: '鉄骨体積', unit: 'm³' }),
]);

const QUANTITY_SUMMARY_PAGE_SIZE = 200;
const DEFAULT_DECIMAL_DIGITS = 3;
const MIN_DECIMAL_DIGITS = 0;
const MAX_DECIMAL_DIGITS = 6;

const QUANTITY_SUMMARY_STATUSES = Object.freeze([
  QuantityStatus.CALCULATED,
  QuantityStatus.PARTIAL,
  QuantityStatus.INSUFFICIENT_DATA,
  QuantityStatus.UNSUPPORTED,
  QuantityStatus.NOT_APPLICABLE,
  QuantityStatus.INVALID_GEOMETRY,
]);

const DIMENSION_KEYS = new Set(QUANTITY_SUMMARY_DIMENSIONS.map((item) => item.key));
const MEASURE_KEYS = new Set(QUANTITY_SUMMARY_MEASURES.map((item) => item.key));
const STATUS_KEYS = new Set(QUANTITY_SUMMARY_STATUSES);

export function createQuantitySummaryState(overrides = {}) {
  return normalizeQuantitySummaryState({
    modelSide: 'A',
    dimension1: 'storyName',
    dimension2: 'memberCategory',
    measure: 'concreteVolumeMm3',
    decimalDigits: DEFAULT_DECIMAL_DIGITS,
    statuses: [QuantityStatus.CALCULATED, QuantityStatus.PARTIAL],
    storyMatchCriterion: DEFAULT_STORY_AXIS_MATCH_CRITERION,
    sortKey: 'storyName',
    sortDirection: 'asc',
    page: 1,
    ...overrides,
  });
}

export function normalizeQuantitySummaryState(input = {}) {
  const modelSide = input.modelSide === 'B' ? 'B' : input.modelSide === 'AB' ? 'AB' : 'A';
  const dimension1 = DIMENSION_KEYS.has(input.dimension1) ? input.dimension1 : 'storyName';
  let dimension2 =
    input.dimension2 === 'none' || DIMENSION_KEYS.has(input.dimension2)
      ? input.dimension2
      : 'memberCategory';
  if (dimension2 === dimension1) dimension2 = 'none';

  const measure = MEASURE_KEYS.has(input.measure) ? input.measure : 'concreteVolumeMm3';
  const requestedDecimalDigits = Number(input.decimalDigits);
  const decimalDigits =
    Number.isInteger(requestedDecimalDigits) &&
    requestedDecimalDigits >= MIN_DECIMAL_DIGITS &&
    requestedDecimalDigits <= MAX_DECIMAL_DIGITS
      ? requestedDecimalDigits
      : DEFAULT_DECIMAL_DIGITS;
  const storyMatchCriterion = Object.values(STORY_AXIS_MATCH_CRITERION).includes(
    input.storyMatchCriterion,
  )
    ? input.storyMatchCriterion
    : DEFAULT_STORY_AXIS_MATCH_CRITERION;
  const statuses = [
    ...new Set(
      (Array.isArray(input.statuses) ? input.statuses : []).filter((status) =>
        STATUS_KEYS.has(status),
      ),
    ),
  ];

  const measureSortKeys = modelSide === 'AB' ? ['measureA', 'measureB', 'delta'] : ['measure'];
  const allowedSortKeys = new Set([
    dimension1,
    ...(dimension2 === 'none' ? [] : [dimension2]),
    ...measureSortKeys,
  ]);
  const sortKey = allowedSortKeys.has(input.sortKey) ? input.sortKey : dimension1;
  const sortDirection = input.sortDirection === 'desc' ? 'desc' : 'asc';
  const requestedPage = Number(input.page);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  return {
    modelSide,
    dimension1,
    dimension2,
    measure,
    decimalDigits,
    statuses,
    storyMatchCriterion,
    sortKey,
    sortDirection,
    page,
    pageSize: QUANTITY_SUMMARY_PAGE_SIZE,
  };
}

export function getQuantitySummaryDimensions(state) {
  const normalized = normalizeQuantitySummaryState(state);
  return [
    normalized.dimension1,
    ...(normalized.dimension2 === 'none' ? [] : [normalized.dimension2]),
  ];
}

/**
 * A/B比較時の対応キーdimension。
 * 階の共通判定基準が幾何位置の場合だけ storyName を標高キーへ置換する。
 */
export function getQuantityComparisonDimensions(state) {
  const normalized = normalizeQuantitySummaryState(state);
  const dimensions = getQuantitySummaryDimensions(normalized);
  if (
    normalized.modelSide !== 'AB' ||
    normalized.storyMatchCriterion !== STORY_AXIS_MATCH_CRITERION.GEOMETRY
  ) {
    return dimensions;
  }
  return dimensions.map((dimension) =>
    dimension === 'storyName' ? 'storyHeightMatchKey' : dimension,
  );
}

export function buildQuantityAggregationOptions(state, { forComparison = false } = {}) {
  const normalized = normalizeQuantitySummaryState(state);

  return {
    dimensions: forComparison
      ? getQuantityComparisonDimensions(normalized)
      : getQuantitySummaryDimensions(normalized),
    measures: [normalized.measure],
    filters: normalized.statuses.length > 0 ? { status: normalized.statuses } : { status: [] },
  };
}

function comparePresentValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'ja', { numeric: true, sensitivity: 'base' });
}

function getSingleModelSortValue(row, normalized) {
  const measure = normalized.measure;
  if (normalized.sortKey !== 'measure') return row?.[normalized.sortKey];

  if (measure === 'count') {
    return row?.count ?? row?.measures?.count ?? null;
  }
  return row?.confirmedMeasures?.[measure] ?? row?.partialMeasures?.[measure] ?? null;
}

function getComparisonSortValue(row, normalized) {
  if (['measureA', 'measureB', 'delta'].includes(normalized.sortKey)) {
    return row?.[normalized.sortKey] ?? null;
  }
  if (
    normalized.sortKey === 'storyName' &&
    normalized.storyMatchCriterion === STORY_AXIS_MATCH_CRITERION.GEOMETRY
  ) {
    return row?.storyHeightMm ?? null;
  }
  return row?.[normalized.sortKey];
}

export function sortQuantitySummaryRows(rows, state) {
  const normalized = normalizeQuantitySummaryState(state);
  const direction = normalized.sortDirection === 'desc' ? -1 : 1;

  return [...(rows || [])].sort((a, b) => {
    const aValue =
      normalized.modelSide === 'AB'
        ? getComparisonSortValue(a, normalized)
        : getSingleModelSortValue(a, normalized);
    const bValue =
      normalized.modelSide === 'AB'
        ? getComparisonSortValue(b, normalized)
        : getSingleModelSortValue(b, normalized);

    const aMissing = aValue === null || aValue === undefined;
    const bMissing = bValue === null || bValue === undefined;
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    const primary = aMissing ? 0 : comparePresentValues(aValue, bValue);
    if (primary !== 0) return primary * direction;

    const aTie = a?.[normalized.dimension1];
    const bTie = b?.[normalized.dimension1];
    const aTieMissing = aTie === null || aTie === undefined;
    const bTieMissing = bTie === null || bTie === undefined;
    if (aTieMissing !== bTieMissing) return aTieMissing ? 1 : -1;
    return aTieMissing ? 0 : comparePresentValues(aTie, bTie);
  });
}

export function paginateQuantitySummaryRows(rows, state) {
  const normalized = normalizeQuantitySummaryState(state);
  const sourceRows = Array.isArray(rows) ? rows : [];
  const total = sourceRows.length;
  const pageCount = Math.max(1, Math.ceil(total / normalized.pageSize));
  const page = Math.min(normalized.page, pageCount);
  const start = (page - 1) * normalized.pageSize;
  const end = Math.min(start + normalized.pageSize, total);

  return {
    rows: sourceRows.slice(start, end),
    page,
    pageCount,
    pageSize: normalized.pageSize,
    total,
    startIndex: total === 0 ? 0 : start + 1,
    endIndex: end,
  };
}

export function countQuantitySummaryFacts(rows) {
  return (rows || []).reduce((total, row) => {
    const count = Number(row?.count);
    return total + (Number.isFinite(count) && count > 0 ? count : 0);
  }, 0);
}

export function getDimensionLabel(key) {
  return QUANTITY_SUMMARY_DIMENSIONS.find((item) => item.key === key)?.label || key;
}

export function getMeasureDefinition(key) {
  return QUANTITY_SUMMARY_MEASURES.find((item) => item.key === key) || null;
}
