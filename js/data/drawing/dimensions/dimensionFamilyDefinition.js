/** @fileoverview 寸法スタイル(DimensionFamily)のpure data契約。DOM/UI/描画を所有しない。 */

export const DIMENSION_FAMILY_SCHEMA_VERSION = 1;
export const DIMENSION_TEXT_ORIENTATIONS = Object.freeze([
  'horizontal-on-paper',
  'aligned-with-dimension',
]);

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function assertKnownKeys(input, allowed, name) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`${name}に未対応のfieldがあります: ${key}`);
  }
}

function nonemptyString(value, name, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new TypeError(`${name}が不正です。`);
  return value;
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name}が不正です。`);
  return value;
}

function nonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name}が不正です。`);
  return value;
}

function normalizeDashPattern(value, name) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${name}が不正です。`);
  const pattern = value.map((item, index) => positive(item, `${name}[${index}]`));
  const canonical = pattern.length % 2 === 0 ? pattern : [...pattern, ...pattern];
  return Object.freeze(canonical);
}

function normalizeFamilyId(value, { builtIn }) {
  const id = nonemptyString(value, 'DimensionFamily id');
  const expectedPrefix = builtIn ? 'builtin:' : 'user:';
  if (!id.startsWith(expectedPrefix) || !SAFE_ID_PATTERN.test(id)) {
    throw new TypeError(
      builtIn
        ? 'built-in DimensionFamily idはbuiltin:で開始する安全な識別子にしてください。'
        : 'user DimensionFamily idはuser:で開始する安全な識別子にしてください。',
    );
  }
  return id;
}

function normalizeLineStyle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('DimensionLineStyleが必要です。');
  assertKnownKeys(
    input,
    new Set(['strokeWidthPaperMm', 'dashPatternPaperMm']),
    'DimensionLineStyle',
  );
  const dashPatternPaperMm = normalizeDashPattern(
    input.dashPatternPaperMm,
    'line.dashPatternPaperMm',
  );
  return Object.freeze({
    strokeWidthPaperMm: positive(input.strokeWidthPaperMm, 'line.strokeWidthPaperMm'),
    ...(dashPatternPaperMm ? { dashPatternPaperMm } : {}),
  });
}

function normalizeWitnessLineStyle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('WitnessLineStyleが必要です。');
  assertKnownKeys(
    input,
    new Set([
      'strokeWidthPaperMm',
      'dashPatternPaperMm',
      'gapPaperMm',
      'overshootPaperMm',
      'fixedLengthPaperMm',
    ]),
    'WitnessLineStyle',
  );
  let fixedLengthPaperMm = null;
  if (input.fixedLengthPaperMm !== undefined && input.fixedLengthPaperMm !== null)
    fixedLengthPaperMm = positive(input.fixedLengthPaperMm, 'witnessLine.fixedLengthPaperMm');
  const dashPatternPaperMm = normalizeDashPattern(
    input.dashPatternPaperMm,
    'witnessLine.dashPatternPaperMm',
  );
  return Object.freeze({
    strokeWidthPaperMm: positive(input.strokeWidthPaperMm, 'witnessLine.strokeWidthPaperMm'),
    ...(dashPatternPaperMm ? { dashPatternPaperMm } : {}),
    gapPaperMm: nonNegative(input.gapPaperMm, 'witnessLine.gapPaperMm'),
    overshootPaperMm: nonNegative(input.overshootPaperMm, 'witnessLine.overshootPaperMm'),
    fixedLengthPaperMm,
  });
}

function normalizeTextStyle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('DimensionTextStyleが必要です。');
  assertKnownKeys(
    input,
    new Set(['heightPaperMm', 'gapPaperMm', 'orientation']),
    'DimensionTextStyle',
  );
  const orientation = input.orientation;
  if (!DIMENSION_TEXT_ORIENTATIONS.includes(orientation))
    throw new TypeError(`未対応のDimensionTextStyle orientationです: ${String(orientation)}`);
  return Object.freeze({
    heightPaperMm: positive(input.heightPaperMm, 'text.heightPaperMm'),
    gapPaperMm: nonNegative(input.gapPaperMm, 'text.gapPaperMm'),
    orientation,
  });
}

function normalizeTerminatorRefs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('DimensionFamily terminatorsが必要です。');
  assertKnownKeys(input, new Set(['start', 'intermediate', 'end']), 'DimensionFamily terminators');
  return Object.freeze({
    start: nonemptyString(input.start, 'terminators.start'),
    intermediate: nonemptyString(input.intermediate, 'terminators.intermediate'),
    end: nonemptyString(input.end, 'terminators.end'),
  });
}

/** JSON化可能なDimensionFamily v1を検証し、凍結snapshotを返す。 */
export function normalizeDimensionFamily(input, { builtIn = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('DimensionFamilyが必要です。');
  assertKnownKeys(
    input,
    new Set([
      'schemaVersion',
      'id',
      'name',
      'line',
      'witnessLine',
      'text',
      'terminators',
      'builtIn',
    ]),
    'DimensionFamily',
  );
  if ('builtIn' in input && input.builtIn !== (builtIn === true))
    throw new TypeError('DimensionFamily builtIn指定が名前空間と一致しません。');
  if (input.schemaVersion !== DIMENSION_FAMILY_SCHEMA_VERSION)
    throw new TypeError(`DimensionFamily v${DIMENSION_FAMILY_SCHEMA_VERSION}が必要です。`);

  return Object.freeze({
    schemaVersion: DIMENSION_FAMILY_SCHEMA_VERSION,
    id: normalizeFamilyId(input.id, { builtIn }),
    name: nonemptyString(input.name, 'DimensionFamily name', 80),
    line: normalizeLineStyle(input.line),
    witnessLine: normalizeWitnessLineStyle(input.witnessLine),
    text: normalizeTextStyle(input.text),
    terminators: normalizeTerminatorRefs(input.terminators),
    builtIn: builtIn === true,
  });
}
