/**
 * @fileoverview QuantityFact[] の UI 非依存 group-by 集計。
 */

import { QUANTITY_MEASURES, QUANTITY_UNCLASSIFIED } from './QuantityAnalyticsTypes.js';

function factValue(fact, key) {
  if (Object.prototype.hasOwnProperty.call(fact || {}, key)) return fact[key];
  if (Object.prototype.hasOwnProperty.call(fact?.quantity || {}, key)) return fact.quantity[key];
  return undefined;
}

function matchesFilter(fact, key, accepted) {
  if (accepted === undefined || accepted === null) return true;
  const candidates = Array.isArray(accepted) ? accepted : [accepted];
  if (candidates.length === 0) return false;
  const value = factValue(fact, key);
  return candidates.some((candidate) => candidate === value);
}

function matchesFilters(fact, filters = {}) {
  return Object.entries(filters).every(([key, accepted]) => matchesFilter(fact, key, accepted));
}

function normalizedDimensionValue(value) {
  if (value === null || value === undefined || value === '') return QUANTITY_UNCLASSIFIED;
  return value;
}

function createAccumulator(dimensions, fact) {
  const group = {};
  for (const dimension of dimensions) {
    group[dimension] = normalizedDimensionValue(factValue(fact, dimension));
  }
  return {
    group,
    count: 0,
    statusCounts: {},
    measures: {},
    measureCounts: {},
    measuresByStatus: {},
    measureCountsByStatus: {},
    facts: [],
  };
}

function addMeasure(target, counts, key, value) {
  if (key === 'count') {
    target[key] = (target[key] || 0) + 1;
    counts[key] = (counts[key] || 0) + 1;
    return;
  }
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
  target[key] = (target[key] || 0) + Number(value);
  counts[key] = (counts[key] || 0) + 1;
}

function finalizeMeasureMap(target, counts, measures) {
  const result = {};
  for (const measure of measures) {
    result[measure] = (counts[measure] || 0) > 0 ? target[measure] : null;
  }
  return result;
}

/**
 * @param {Array<Object>} facts
 * @param {{dimensions?: string[], measures?: string[], filters?: Object, includeFacts?: boolean}} options
 * @returns {Array<Object>}
 */
export function aggregateQuantityFacts(
  facts,
  { dimensions = [], measures = QUANTITY_MEASURES, filters = {}, includeFacts = false } = {},
) {
  if (!Array.isArray(facts)) throw new TypeError('facts must be an array');
  if (!Array.isArray(dimensions)) throw new TypeError('dimensions must be an array');
  if (!Array.isArray(measures)) throw new TypeError('measures must be an array');

  const groups = new Map();

  for (const fact of facts) {
    if (!matchesFilters(fact, filters)) continue;

    const dimensionValues = dimensions.map((dimension) =>
      normalizedDimensionValue(factValue(fact, dimension)),
    );
    const key = JSON.stringify(dimensionValues);
    if (!groups.has(key)) groups.set(key, createAccumulator(dimensions, fact));
    const acc = groups.get(key);

    acc.count++;
    const status = fact?.status || QUANTITY_UNCLASSIFIED;
    acc.statusCounts[status] = (acc.statusCounts[status] || 0) + 1;

    if (!acc.measuresByStatus[status]) {
      acc.measuresByStatus[status] = {};
      acc.measureCountsByStatus[status] = {};
    }

    for (const measure of measures) {
      const value = factValue(fact, measure);
      addMeasure(acc.measures, acc.measureCounts, measure, value);
      addMeasure(acc.measuresByStatus[status], acc.measureCountsByStatus[status], measure, value);
    }

    if (includeFacts) acc.facts.push(fact);
  }

  return [...groups.values()].map((acc) => {
    const measuresByStatus = {};
    for (const [status, values] of Object.entries(acc.measuresByStatus)) {
      measuresByStatus[status] = finalizeMeasureMap(
        values,
        acc.measureCountsByStatus[status],
        measures,
      );
    }

    return {
      ...acc.group,
      count: acc.count,
      statusCounts: { ...acc.statusCounts },
      // measures は現在の filter を通過した fact 全体の合計。
      // 確定値として表示する場合は confirmedMeasures を使用し、
      // PARTIAL を無条件に確定合計へ混ぜない。
      measures: finalizeMeasureMap(acc.measures, acc.measureCounts, measures),
      measureCounts: { ...acc.measureCounts },
      measuresByStatus,
      confirmedMeasures: measuresByStatus.CALCULATED
        ? { ...measuresByStatus.CALCULATED }
        : Object.fromEntries(measures.map((measure) => [measure, null])),
      partialMeasures: measuresByStatus.PARTIAL
        ? { ...measuresByStatus.PARTIAL }
        : Object.fromEntries(measures.map((measure) => [measure, null])),
      ...(includeFacts ? { facts: acc.facts } : {}),
    };
  });
}

export default aggregateQuantityFacts;
