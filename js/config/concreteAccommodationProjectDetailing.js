/**
 * @fileoverview 配筋成立性からコンクリート追加候補を生成するproject rule resolver。
 */

import { getRebarProjectDetailing } from './rebarProjectDetailing.js';

export const CONCRETE_ACCOMMODATION_DETAILING_TYPE = 'CONCRETE_ACCOMMODATION';

export const DEFAULT_CONCRETE_ACCOMMODATION_RULE = Object.freeze({
  enabled: false,
  constructionMarginMm: 10,
  roundingMm: 10,
  maxAutomaticFukashiMm: 100,
  allowFaceOffset: true,
  allowLocalPrism: true,
  allowFreeform: false,
  requireApproval: true,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function entryFrom(source) {
  if (!isPlainObject(source)) return undefined;
  if (Object.prototype.hasOwnProperty.call(source, CONCRETE_ACCOMMODATION_DETAILING_TYPE)) {
    return source[CONCRETE_ACCOMMODATION_DETAILING_TYPE];
  }
  if (
    isPlainObject(source.special) &&
    Object.prototype.hasOwnProperty.call(source.special, CONCRETE_ACCOMMODATION_DETAILING_TYPE)
  ) {
    return source.special[CONCRETE_ACCOMMODATION_DETAILING_TYPE];
  }
  return undefined;
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function invalid(reason, source = null) {
  return {
    resolved: false,
    active: false,
    reason,
    source,
    rule: null,
  };
}

export function resolveConcreteAccommodationRule({ projectDetailing } = {}) {
  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const raw = entryFrom(source);
  if (raw === undefined) {
    return {
      resolved: true,
      active: false,
      reason: null,
      source: 'default-disabled',
      rule: { ...DEFAULT_CONCRETE_ACCOMMODATION_RULE },
    };
  }
  if (!isPlainObject(raw)) {
    return invalid('concrete-accommodation-project-rule-invalid', 'project-detailing');
  }

  const constructionMarginMm = nonNegative(
    raw.constructionMarginMm ?? DEFAULT_CONCRETE_ACCOMMODATION_RULE.constructionMarginMm,
  );
  const roundingMm = positive(raw.roundingMm ?? DEFAULT_CONCRETE_ACCOMMODATION_RULE.roundingMm);
  const maxAutomaticFukashiMm = positive(
    raw.maxAutomaticFukashiMm ?? DEFAULT_CONCRETE_ACCOMMODATION_RULE.maxAutomaticFukashiMm,
  );
  if (constructionMarginMm === null) {
    return invalid('concrete-accommodation-construction-margin-invalid', 'project-detailing');
  }
  if (roundingMm === null) {
    return invalid('concrete-accommodation-rounding-invalid', 'project-detailing');
  }
  if (maxAutomaticFukashiMm === null) {
    return invalid('concrete-accommodation-max-automatic-invalid', 'project-detailing');
  }

  const rule = {
    enabled: boolean(raw.enabled, DEFAULT_CONCRETE_ACCOMMODATION_RULE.enabled),
    constructionMarginMm,
    roundingMm,
    maxAutomaticFukashiMm,
    allowFaceOffset: boolean(
      raw.allowFaceOffset,
      DEFAULT_CONCRETE_ACCOMMODATION_RULE.allowFaceOffset,
    ),
    allowLocalPrism: boolean(
      raw.allowLocalPrism,
      DEFAULT_CONCRETE_ACCOMMODATION_RULE.allowLocalPrism,
    ),
    allowFreeform: boolean(raw.allowFreeform, DEFAULT_CONCRETE_ACCOMMODATION_RULE.allowFreeform),
    requireApproval: boolean(
      raw.requireApproval,
      DEFAULT_CONCRETE_ACCOMMODATION_RULE.requireApproval,
    ),
  };
  return {
    resolved: true,
    active: rule.enabled,
    reason: null,
    source: 'project-detailing',
    rule,
  };
}
