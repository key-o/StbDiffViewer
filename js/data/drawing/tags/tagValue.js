/** @fileoverview 型・状態・出典付きタグ値。XML/DOM/scene非依存。 */
import { normalizeSectionFigure } from './tagSectionFigure.js';

const STATUSES = ['known', 'missing', 'invalid', 'not-applicable'];
const PROVENANCE_KINDS = ['drawing', 'stb', 'derived'];
const VALUE_TYPES = ['text', 'figure'];
const TEXT_SHAPES = ['scalar', 'list'];

function normalizeProvenance(provenance) {
  if (
    !PROVENANCE_KINDS.includes(provenance?.kind) ||
    typeof provenance?.path !== 'string' ||
    !provenance.path.trim()
  )
    throw new TypeError('TagValueの出典が必要です。');
  const result = { kind: provenance.kind, path: provenance.path };
  for (const key of ['version', 'rule']) {
    if (provenance[key] === undefined || provenance[key] === null) continue;
    if (typeof provenance[key] !== 'string' || !provenance[key].trim())
      throw new TypeError(`TagValueの出典${key}が不正です。`);
    result[key] = provenance[key];
  }
  return Object.freeze(result);
}

function normalizeKnownValue(valueType, shape, value) {
  if (valueType === 'figure') return normalizeSectionFigure(value);
  if (shape === 'scalar') {
    if (typeof value !== 'string') throw new TypeError('既知の文字TagValueには文字列が必要です。');
    return value;
  }
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    ![...value].every((item) => typeof item === 'string')
  )
    throw new TypeError('listには2つ以上の文字列が必要です。');
  return Object.freeze([...value]);
}

/**
 * @param {object} input
 * @returns {Readonly<object>} JSON化可能な独立snapshot。
 * textはSTB属性値の原文字列を保持し、listはXPathの文書順を保持する。
 * figureは断面図(モデルmm)を保持する。
 */
export function normalizeTagValue(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('TagValueが必要です。');
  const {
    valueType,
    shape = 'scalar',
    status = 'known',
    value = null,
    reason = null,
    provenance,
  } = input;
  if (!STATUSES.includes(status) || !VALUE_TYPES.includes(valueType))
    throw new TypeError('TagValueの型または状態が不正です。');
  if (valueType === 'text' ? !TEXT_SHAPES.includes(shape) : shape !== 'scalar')
    throw new TypeError('未対応のTagValue形状です。');
  const unit = valueType === 'figure' ? 'mm' : null;
  if ((input.unit ?? unit) !== unit) throw new TypeError('TagValueの単位が不正です。');
  const normalizedProvenance = normalizeProvenance(provenance);
  if (reason !== null && (typeof reason !== 'string' || !reason.trim()))
    throw new TypeError('TagValueの理由が不正です。');

  let normalizedValue = null;
  if (status === 'known') normalizedValue = normalizeKnownValue(valueType, shape, value);
  else if (value !== null || !reason)
    throw new TypeError('未取得/不正/該当なしの値はnullと理由で表してください。');

  return Object.freeze({
    valueType,
    shape,
    unit,
    status,
    value: normalizedValue,
    reason,
    provenance: normalizedProvenance,
  });
}
