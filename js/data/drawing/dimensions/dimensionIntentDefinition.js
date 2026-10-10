/** @fileoverview 永続/一時寸法の作図意図(DimensionIntent) pure data契約。 */
import { assertPoint } from '../affine2d.js';

export const DIMENSION_INTENT_SCHEMA_VERSION = 1;
export const DIMENSION_INTENT_KINDS = Object.freeze(['linear-chain']);
export const DIMENSION_REFERENCE_KINDS = Object.freeze(['point', 'axis']);

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function assertKnownKeys(input, allowed, name) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`${name}に未対応のfieldがあります: ${key}`);
  }
}

function nonemptyString(value, name, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new TypeError(`${name}が不正です。`);
  return value;
}

function safeId(value, name, max = 160) {
  const id = nonemptyString(value, name, max);
  if (!SAFE_ID_PATTERN.test(id)) throw new TypeError(`${name}は安全な識別子で指定してください。`);
  return id;
}

function normalizeReference(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError(`DimensionReference[${index}]が不正です。`);
  const kind = input.kind;
  if (!DIMENSION_REFERENCE_KINDS.includes(kind))
    throw new TypeError(`未対応のDimensionReference kindです: ${String(kind)}`);

  if (kind === 'point') {
    assertKnownKeys(input, new Set(['kind', 'point']), `DimensionReference[${index}]`);
    return Object.freeze({ kind, point: Object.freeze([...assertPoint(input.point)]) });
  }

  assertKnownKeys(input, new Set(['kind', 'axisId']), `DimensionReference[${index}]`);
  return Object.freeze({ kind, axisId: safeId(input.axisId, `references[${index}].axisId`) });
}

function normalizePlacement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('DimensionIntent placementが必要です。');
  assertKnownKeys(input, new Set(['offsetModelMm']), 'DimensionIntent placement');
  if (!Number.isFinite(input.offsetModelMm))
    throw new TypeError('placement.offsetModelMmが不正です。');
  return Object.freeze({ offsetModelMm: input.offsetModelMm });
}

/** JSON化可能なDimensionIntent v1を検証し、凍結snapshotを返す。 */
export function normalizeDimensionIntent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('DimensionIntentが必要です。');
  assertKnownKeys(
    input,
    new Set(['schemaVersion', 'id', 'kind', 'references', 'placement', 'familyId']),
    'DimensionIntent',
  );
  if (input.schemaVersion !== DIMENSION_INTENT_SCHEMA_VERSION)
    throw new TypeError(`DimensionIntent v${DIMENSION_INTENT_SCHEMA_VERSION}が必要です。`);
  if (!DIMENSION_INTENT_KINDS.includes(input.kind))
    throw new TypeError(`未対応のDimensionIntent kindです: ${String(input.kind)}`);
  if (!Array.isArray(input.references) || input.references.length < 2)
    throw new TypeError('DimensionIntent referencesは2件以上必要です。');

  return Object.freeze({
    schemaVersion: DIMENSION_INTENT_SCHEMA_VERSION,
    id: safeId(input.id, 'DimensionIntent id'),
    kind: input.kind,
    references: Object.freeze(input.references.map(normalizeReference)),
    placement: normalizePlacement(input.placement),
    familyId: safeId(input.familyId, 'DimensionIntent familyId'),
  });
}
