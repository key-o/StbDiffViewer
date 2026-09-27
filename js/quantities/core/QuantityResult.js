/**
 * @fileoverview STB要素に紐づく派生数量結果の共通 contract。
 */

import { isQuantityStatus, QuantityStatus } from './QuantityStatus.js';

function requireNonEmptyString(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new TypeError(`${label} is required`);
  }
  return String(value);
}

/**
 * 要素種別 + ID を複合 identity として構築する。
 * ST-Bridge の id は異種要素間で重複し得るため、elementId 単独では扱わない。
 *
 * @param {Object} params
 * @param {string} params.elementType
 * @param {string|number} params.elementId
 * @param {string|null} [params.guid]
 * @returns {{elementType: string, elementId: string, guid: string|null}}
 */
export function createQuantityIdentity({ elementType, elementId, guid = null }) {
  return {
    elementType: requireNonEmptyString(elementType, 'elementType'),
    elementId: requireNonEmptyString(elementId, 'elementId'),
    guid: guid === null || guid === undefined || String(guid).trim() === '' ? null : String(guid),
  };
}

/**
 * 派生数量結果を構築する。
 *
 * @param {Object} params
 * @param {{elementType: string, elementId: string|number, guid?: string|null}} params.identity
 * @param {string} [params.status]
 * @param {Object} [params.values]
 * @param {Object} [params.basis]
 * @param {string[]} [params.dependencies]
 * @param {string[]} [params.warnings]
 * @param {number|null} [params.revision]
 * @returns {Object}
 */
export function createQuantityResult({
  identity,
  status = QuantityStatus.CALCULATED,
  values = {},
  basis = {},
  dependencies = [],
  warnings = [],
  revision = null,
}) {
  if (!identity) {
    throw new TypeError('identity is required');
  }
  if (!isQuantityStatus(status)) {
    throw new TypeError(`Unknown quantity status: ${status}`);
  }
  if (!Array.isArray(dependencies)) {
    throw new TypeError('dependencies must be an array');
  }
  if (!Array.isArray(warnings)) {
    throw new TypeError('warnings must be an array');
  }
  if (revision !== null && (!Number.isInteger(revision) || revision < 0)) {
    throw new TypeError('revision must be a non-negative integer or null');
  }

  return {
    identity: createQuantityIdentity(identity),
    status,
    values: { ...values },
    basis: { ...basis },
    dependencies: [...new Set(dependencies.map((key) => String(key)))],
    warnings: warnings.map((warning) => String(warning)),
    revision,
  };
}

/**
 * 数量計算が値を確定できなかった結果を構築する。
 * 失敗時に 0 を返さないための明示 helper。
 *
 * @param {Object} params
 * @returns {Object}
 */
export function createUnavailableQuantityResult({
  identity,
  status = QuantityStatus.INSUFFICIENT_DATA,
  values = {},
  basis = {},
  dependencies = [],
  warnings = [],
  revision = null,
}) {
  if (status === QuantityStatus.CALCULATED) {
    throw new TypeError('Unavailable quantity result cannot use CALCULATED status');
  }
  return createQuantityResult({
    identity,
    status,
    values,
    basis,
    dependencies,
    warnings,
    revision,
  });
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isQuantityResult(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    value.identity &&
    value.identity.elementType &&
    value.identity.elementId &&
    isQuantityStatus(value.status) &&
    value.values &&
    typeof value.values === 'object' &&
    Array.isArray(value.dependencies) &&
    Array.isArray(value.warnings),
  );
}
