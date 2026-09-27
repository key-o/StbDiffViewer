/**
 * @fileoverview Issue #287 Phase 3: Quantity aggregate の A/B 比較と drilldown 用 pure helper。
 */

import { QUANTITY_UNCLASSIFIED } from './QuantityAnalyticsTypes.js';

function factValue(fact, key) {
  if (Object.prototype.hasOwnProperty.call(fact || {}, key)) return fact[key];
  if (Object.prototype.hasOwnProperty.call(fact?.quantity || {}, key)) return fact.quantity[key];
  return undefined;
}

export function normalizeQuantityDimensionValue(value) {
  if (value === null || value === undefined || value === '') return QUANTITY_UNCLASSIFIED;
  return value;
}

export function buildQuantityGroupKey(row, dimensions = []) {
  if (!Array.isArray(dimensions)) throw new TypeError('dimensions must be an array');
  return JSON.stringify(
    dimensions.map((dimension) => normalizeQuantityDimensionValue(row?.[dimension])),
  );
}

function readAggregateMeasure(row, measure, bucket) {
  if (!row) return 0;
  if (measure === 'count') {
    const value = Number(row?.count ?? row?.measures?.count);
    return Number.isFinite(value) ? value : null;
  }
  const value = row?.[bucket]?.[measure];
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function deltaValue(valueA, valueB) {
  if (valueA === null || valueB === null) return null;
  return valueB - valueA;
}

/**
 * A/Bそれぞれで集計済みの row を dimension key で full outer join する。
 * group が片側に存在しない場合、その側の量は 0 とする。
 * group は存在するが measure が null の場合は null を維持し、0 と混同しない。
 */
export function compareQuantityAggregateRows(
  rowsA,
  rowsB,
  { dimensions = [], measure = 'count' } = {},
) {
  if (!Array.isArray(rowsA) || !Array.isArray(rowsB)) {
    throw new TypeError('rowsA and rowsB must be arrays');
  }
  if (!Array.isArray(dimensions)) throw new TypeError('dimensions must be an array');

  const joined = new Map();
  const attach = (rows, side) => {
    for (const row of rows) {
      const groupKey = buildQuantityGroupKey(row, dimensions);
      if (!joined.has(groupKey)) {
        const dimensionsData = {};
        for (const dimension of dimensions) {
          dimensionsData[dimension] = normalizeQuantityDimensionValue(row?.[dimension]);
        }
        joined.set(groupKey, {
          ...dimensionsData,
          groupKey,
          rowA: null,
          rowB: null,
        });
      }
      joined.get(groupKey)[side] = row;
    }
  };

  attach(rowsA, 'rowA');
  attach(rowsB, 'rowB');

  return [...joined.values()].map((row) => {
    const measureA = readAggregateMeasure(row.rowA, measure, 'confirmedMeasures');
    const measureB = readAggregateMeasure(row.rowB, measure, 'confirmedMeasures');
    const partialMeasureA =
      measure === 'count' ? null : readAggregateMeasure(row.rowA, measure, 'partialMeasures');
    const partialMeasureB =
      measure === 'count' ? null : readAggregateMeasure(row.rowB, measure, 'partialMeasures');

    return {
      ...row,
      countA: row.rowA?.count ?? 0,
      countB: row.rowB?.count ?? 0,
      statusCountsA: { ...(row.rowA?.statusCounts || {}) },
      statusCountsB: { ...(row.rowB?.statusCounts || {}) },
      measureA,
      measureB,
      delta: deltaValue(measureA, measureB),
      partialMeasureA,
      partialMeasureB,
      partialDelta: measure === 'count' ? null : deltaValue(partialMeasureA, partialMeasureB),
    };
  });
}

export function filterQuantityFactsForGroup(
  facts,
  group,
  { dimensions = [], statuses = null } = {},
) {
  if (!Array.isArray(facts)) return [];
  if (!Array.isArray(dimensions)) throw new TypeError('dimensions must be an array');
  const acceptedStatuses = Array.isArray(statuses) ? new Set(statuses) : null;

  return facts.filter((fact) => {
    if (acceptedStatuses && !acceptedStatuses.has(fact?.status)) return false;
    return dimensions.every(
      (dimension) =>
        normalizeQuantityDimensionValue(factValue(fact, dimension)) ===
        normalizeQuantityDimensionValue(group?.[dimension]),
    );
  });
}

export default {
  buildQuantityGroupKey,
  compareQuantityAggregateRows,
  filterQuantityFactsForGroup,
  normalizeQuantityDimensionValue,
};
