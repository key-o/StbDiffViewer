/**
 * @fileoverview RC配筋標準のプロジェクト共通設定。
 *
 * 日建連・JSCA 2023 を既定値とし、自治体・発注者・社内標準との差分だけを保持する。
 * null / undefined は「標準既定値を使用」を意味し、0 / false は明示値として保持する。
 */

import { NIKKENREN_2023_REBAR_STANDARD_DEFAULTS } from '../constants/rebarStandardDefaults.js';
import {
  DEFAULT_REBAR_DETAILING_CHOICE,
  normalizeRebarDetailingChoice,
  validateRebarDetailingChoice,
} from './rebarDetailingChoice.js';

export const REBAR_COMMON_CONFIG_STORAGE_KEY = 'stbviewer.rebar.commonConfig';

export const DEFAULT_REBAR_COMMON_CONFIG = Object.freeze({
  standardBase: NIKKENREN_2023_REBAR_STANDARD_DEFAULTS.standardId,
  cover: Object.freeze({
    designCoverMm: null,
    minimumCoverMm: null,
    constructionAllowanceMm: null,
  }),
  spacing: Object.freeze({
    coarseAggregateMaxMm: 25,
    aggregateFactor: null,
    adjacentNominalDiaFactor: null,
    minimumClearSpacingMm: null,
    secondLayerSpacingMm: null,
  }),
  bend: Object.freeze({
    hookTailFactor180: null,
    hookTailFactor135: null,
    hookTailFactor90: null,
    insideDiameterTable: null,
  }),
  splice: Object.freeze({
    lapLengthTable: null,
    adjacentSpliceRule: null,
    allowLapForD35Plus: null,
  }),
  anchorage: Object.freeze({
    developmentLengthTable: null,
    projectionLengthTable: null,
    columnProjectionDepthRatio: null,
    allowNearestTableFallback: false,
  }),
  column: Object.freeze({
    spliceZoneRule: null,
    cutoffRule: null,
    sectionTransitionRule: null,
    hoopPlacementRule: null,
  }),
  girder: Object.freeze({
    spliceZoneRule: null,
    cutoffRule: null,
    firstStirrupFromFaceMm: null,
    stirrupEndZoneRule: null,
    webBarRule: null,
    widthTieRule: null,
  }),
  detailing: Object.freeze({
    choice: DEFAULT_REBAR_DETAILING_CHOICE,
    special: Object.freeze({}),
  }),
});

const REQUIRED_OBJECT_PATHS = [
  'cover',
  'spacing',
  'bend',
  'splice',
  'anchorage',
  'column',
  'girder',
  'detailing',
];
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SPECIAL_DETAILING_TYPES = Object.freeze([
  'GIRDER_HANGER_REBAR',
  'GIRDER_HAUNCH_CORNER_CONTINUITY',
  'TOP_STORY_COLUMN_INTERNAL_RESTRAINT',
]);
const SPECIAL_DETAILING_TYPE_SET = new Set(SPECIAL_DETAILING_TYPES);
const SPECIAL_DETAILING_PRODUCTION_MODES = new Set(['EXPLICIT', 'STANDARD_WITH_STB']);
const SPECIAL_DETAILING_ENTRY_KEYS = new Set(['productionEnabled', 'productionMode', 'geometry']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }
  return value;
}

function mergePatch(base, patch) {
  const result = cloneValue(base);
  if (!isPlainObject(patch)) return result;

  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) continue;
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergePatch(result[key], value);
    } else {
      result[key] = cloneValue(value);
    }
  }
  return result;
}

function readPath(config, path) {
  const segments = path.split('.');
  let value = config;
  for (const segment of segments) value = value?.[segment];
  return value;
}

function validateOptionalNonNegative(config, path, errors) {
  const value = readPath(config, path);
  if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) {
    errors.push(`${path} must be null or a non-negative number`);
  }
}

function validateOptionalBoolean(config, path, errors) {
  const value = readPath(config, path);
  if (value !== null && value !== undefined && typeof value !== 'boolean') {
    errors.push(`${path} must be null or a boolean`);
  }
}

function validateLengthOverrideTable(table, path, keys, errors) {
  if (table === null || table === undefined) return;
  if (!isPlainObject(table)) {
    errors.push(`${path} must be null or an object`);
    return;
  }

  for (const [grade, bands] of Object.entries(table)) {
    if (!isPlainObject(bands)) {
      errors.push(`${path}.${grade} must be an object`);
      continue;
    }
    for (const [band, row] of Object.entries(bands)) {
      const rowPath = `${path}.${grade}.${band}`;
      if (!isPlainObject(row)) {
        errors.push(`${rowPath} must be an object`);
        continue;
      }
      let hasOverride = false;
      for (const key of keys) {
        const value = row[key];
        if (value === null || value === undefined) continue;
        if (!Number.isFinite(value) || value < 0) {
          errors.push(`${rowPath}.${key} must be null or a non-negative number`);
        } else {
          hasOverride = true;
        }
      }
      if (!hasOverride) errors.push(`${rowPath} must define at least one numeric override`);
    }
  }
}

function validateInsideDiameterTable(table, errors) {
  if (table === null || table === undefined) return;
  if (!Array.isArray(table)) {
    errors.push('bend.insideDiameterTable must be null or an array');
    return;
  }

  table.forEach((rule, index) => {
    const path = `bend.insideDiameterTable[${index}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (
      !Array.isArray(rule.grades) ||
      rule.grades.length === 0 ||
      rule.grades.some((grade) => typeof grade !== 'string' || grade.trim() === '')
    ) {
      errors.push(`${path}.grades must be a non-empty string array`);
    }
    if (
      !Array.isArray(rule.bendAngles) ||
      rule.bendAngles.length === 0 ||
      rule.bendAngles.some((angle) => !Number.isFinite(angle) || angle < 0)
    ) {
      errors.push(`${path}.bendAngles must be a non-empty non-negative number array`);
    }
    if (!Number.isFinite(rule.factor) || rule.factor < 0) {
      errors.push(`${path}.factor must be a non-negative number`);
    }
    for (const key of ['minDiaMm', 'maxDiaMm']) {
      const value = rule[key];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        errors.push(`${path}.${key} must be a non-negative number when specified`);
      }
    }
    if (
      Number.isFinite(rule.minDiaMm) &&
      Number.isFinite(rule.maxDiaMm) &&
      rule.minDiaMm > rule.maxDiaMm
    ) {
      errors.push(`${path}.minDiaMm must not exceed maxDiaMm`);
    }
  });
}

function validateColumnHoopPlacementRule(rule, errors) {
  if (rule === null || rule === undefined) return;
  if (!isPlainObject(rule)) {
    errors.push('column.hoopPlacementRule must be null or an object');
    return;
  }

  const fallbackPwRatio = rule.fallbackPwRatio;
  if (
    fallbackPwRatio !== null &&
    fallbackPwRatio !== undefined &&
    ![0.002, 0.003].includes(fallbackPwRatio)
  ) {
    errors.push('column.hoopPlacementRule.fallbackPwRatio must be null, 0.002, or 0.003');
  }
}

function validateSpecialDetailingConfig(config, errors) {
  const special = config?.detailing?.special;
  if (!isPlainObject(special)) {
    errors.push('detailing.special must be an object');
    return;
  }

  for (const key of Object.keys(special)) {
    if (!SPECIAL_DETAILING_TYPE_SET.has(key)) {
      errors.push(`detailing.special.${key} is not a supported special detailing type`);
    }
  }

  for (const type of SPECIAL_DETAILING_TYPES) {
    const entry = special[type];
    if (entry === null || entry === undefined) continue;
    const path = `detailing.special.${type}`;
    if (!isPlainObject(entry)) {
      errors.push(`${path} must be null or an object`);
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (!SPECIAL_DETAILING_ENTRY_KEYS.has(key)) {
        errors.push(`${path}.${key} is not supported`);
      }
    }

    if (typeof entry.productionEnabled !== 'boolean') {
      errors.push(`${path}.productionEnabled must be a boolean`);
    }

    const mode = entry.productionMode;
    if (mode !== null && mode !== undefined && !SPECIAL_DETAILING_PRODUCTION_MODES.has(mode)) {
      errors.push(`${path}.productionMode is unsupported: ${mode}`);
    }

    if (entry.geometry !== null && entry.geometry !== undefined && !isPlainObject(entry.geometry)) {
      errors.push(`${path}.geometry must be null or an object`);
    }

    if (entry.productionEnabled !== true) continue;
    if (!SPECIAL_DETAILING_PRODUCTION_MODES.has(mode)) {
      errors.push(`${path}.productionMode is required when productionEnabled=true`);
      continue;
    }
    if (type === 'GIRDER_HANGER_REBAR' && mode !== 'EXPLICIT') {
      errors.push(`${path}.productionMode must be EXPLICIT`);
    }
    if (mode === 'EXPLICIT' && !isPlainObject(entry.geometry)) {
      errors.push(`${path}.geometry is required for EXPLICIT production`);
    }
  }
}

export function validateRebarCommonConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) {
    return { valid: false, errors: ['config must be an object'] };
  }

  if (
    config.standardBase !== undefined &&
    config.standardBase !== NIKKENREN_2023_REBAR_STANDARD_DEFAULTS.standardId
  ) {
    errors.push(`unsupported standardBase: ${config.standardBase}`);
  }

  for (const path of REQUIRED_OBJECT_PATHS) {
    if (!isPlainObject(config[path])) errors.push(`${path} must be an object`);
  }

  const numericPaths = [
    'cover.designCoverMm',
    'cover.minimumCoverMm',
    'cover.constructionAllowanceMm',
    'spacing.coarseAggregateMaxMm',
    'spacing.aggregateFactor',
    'spacing.adjacentNominalDiaFactor',
    'spacing.minimumClearSpacingMm',
    'spacing.secondLayerSpacingMm',
    'bend.hookTailFactor180',
    'bend.hookTailFactor135',
    'bend.hookTailFactor90',
    'anchorage.columnProjectionDepthRatio',
    'girder.firstStirrupFromFaceMm',
  ];
  for (const path of numericPaths) validateOptionalNonNegative(config, path, errors);

  validateOptionalBoolean(config, 'anchorage.allowNearestTableFallback', errors);
  validateOptionalBoolean(config, 'splice.allowLapForD35Plus', errors);

  validateLengthOverrideTable(
    config.splice?.lapLengthTable,
    'splice.lapLengthTable',
    ['l1', 'l1h'],
    errors,
  );
  validateLengthOverrideTable(
    config.anchorage?.developmentLengthTable,
    'anchorage.developmentLengthTable',
    ['l2', 'l2h'],
    errors,
  );
  validateLengthOverrideTable(
    config.anchorage?.projectionLengthTable,
    'anchorage.projectionLengthTable',
    ['la', 'lb'],
    errors,
  );
  validateInsideDiameterTable(config.bend?.insideDiameterTable, errors);
  validateColumnHoopPlacementRule(config.column?.hoopPlacementRule, errors);
  const choiceValidation = validateRebarDetailingChoice(config.detailing?.choice);
  if (!choiceValidation.valid) errors.push(...choiceValidation.errors);
  validateSpecialDetailingConfig(config, errors);

  return { valid: errors.length === 0, errors };
}

let currentRebarCommonConfig = cloneValue(DEFAULT_REBAR_COMMON_CONFIG);
let rebarCommonConfigRevision = 0;

export function getRebarCommonConfigRevision() {
  return rebarCommonConfigRevision;
}

function bumpRebarCommonConfigRevision() {
  rebarCommonConfigRevision += 1;
  return rebarCommonConfigRevision;
}

export function getRebarCommonConfig() {
  return cloneValue(currentRebarCommonConfig);
}

export function setRebarCommonConfig(patch, { persist = true } = {}) {
  const next = mergePatch(currentRebarCommonConfig, patch);
  if (isPlainObject(next.detailing)) {
    next.detailing.choice = normalizeRebarDetailingChoice(next.detailing.choice);
  }
  const validation = validateRebarCommonConfig(next);
  if (!validation.valid) return { ok: false, errors: validation.errors };

  currentRebarCommonConfig = next;
  bumpRebarCommonConfigRevision();
  if (persist) saveRebarCommonConfig();
  return { ok: true, config: getRebarCommonConfig(), errors: [] };
}

export function resetRebarCommonConfig({ persist = true } = {}) {
  currentRebarCommonConfig = cloneValue(DEFAULT_REBAR_COMMON_CONFIG);
  bumpRebarCommonConfigRevision();
  if (persist) saveRebarCommonConfig();
  return getRebarCommonConfig();
}

export function saveRebarCommonConfig(storage = globalThis.localStorage) {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(REBAR_COMMON_CONFIG_STORAGE_KEY, JSON.stringify(currentRebarCommonConfig));
    return true;
  } catch {
    return false;
  }
}

export function loadRebarCommonConfig(storage = globalThis.localStorage) {
  if (!storage?.getItem) return { ok: false, reason: 'storage-unavailable' };
  try {
    const raw = storage.getItem(REBAR_COMMON_CONFIG_STORAGE_KEY);
    if (!raw) return { ok: false, reason: 'not-found' };
    return importRebarCommonConfigJson(raw, { persist: false });
  } catch {
    return { ok: false, reason: 'invalid-storage-value' };
  }
}

export function exportRebarCommonConfigJson({ pretty = true } = {}) {
  return JSON.stringify(currentRebarCommonConfig, null, pretty ? 2 : 0);
}

export function importRebarCommonConfigJson(json, { persist = true } = {}) {
  try {
    const parsed = JSON.parse(json);
    const merged = mergePatch(DEFAULT_REBAR_COMMON_CONFIG, parsed);
    if (isPlainObject(merged.detailing)) {
      merged.detailing.choice = normalizeRebarDetailingChoice(merged.detailing.choice);
    }
    const validation = validateRebarCommonConfig(merged);
    if (!validation.valid) return { ok: false, errors: validation.errors };

    currentRebarCommonConfig = merged;
    bumpRebarCommonConfigRevision();
    if (persist) saveRebarCommonConfig();
    return { ok: true, config: getRebarCommonConfig(), errors: [] };
  } catch {
    return { ok: false, errors: ['invalid JSON'] };
  }
}
