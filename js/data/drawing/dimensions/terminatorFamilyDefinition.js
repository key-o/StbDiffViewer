/** @fileoverview 寸法端部記号(TerminatorFamily)のpure data契約。DOM/UI/描画を所有しない。 */

export const TERMINATOR_FAMILY_SCHEMA_VERSION = 1;

export const TERMINATOR_FAMILY_KINDS = Object.freeze([
  'slash',
  'open-arrow',
  'filled-arrow',
  'circle',
  'dot',
  'none',
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

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name}が不正です。`);
  return value;
}

function normalizeFamilyId(value, { builtIn }) {
  const id = nonemptyString(value, 'TerminatorFamily id');
  const expectedPrefix = builtIn ? 'builtin:' : 'user:';
  if (!id.startsWith(expectedPrefix) || !SAFE_ID_PATTERN.test(id)) {
    throw new TypeError(
      builtIn
        ? 'built-in TerminatorFamily idはbuiltin:で開始する安全な識別子にしてください。'
        : 'user TerminatorFamily idはuser:で開始する安全な識別子にしてください。',
    );
  }
  return id;
}

function normalizeGeometry(input, kind) {
  if (input == null) {
    if (kind === 'none') return Object.freeze({});
    throw new TypeError(`TerminatorFamily ${kind} のgeometryが必要です。`);
  }
  if (typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('TerminatorFamily geometryが不正です。');

  if (kind === 'slash') {
    assertKnownKeys(input, new Set(['lengthPaperMm', 'angleDeg']), 'slash geometry');
    return Object.freeze({
      lengthPaperMm: positive(input.lengthPaperMm, 'slash.lengthPaperMm'),
      angleDeg: finite(input.angleDeg, 'slash.angleDeg'),
    });
  }

  if (kind === 'open-arrow' || kind === 'filled-arrow') {
    assertKnownKeys(input, new Set(['lengthPaperMm', 'widthPaperMm']), `${kind} geometry`);
    return Object.freeze({
      lengthPaperMm: positive(input.lengthPaperMm, `${kind}.lengthPaperMm`),
      widthPaperMm: positive(input.widthPaperMm, `${kind}.widthPaperMm`),
    });
  }

  if (kind === 'circle' || kind === 'dot') {
    assertKnownKeys(input, new Set(['diameterPaperMm']), `${kind} geometry`);
    return Object.freeze({
      diameterPaperMm: positive(input.diameterPaperMm, `${kind}.diameterPaperMm`),
    });
  }

  assertKnownKeys(input, new Set(), 'none geometry');
  return Object.freeze({});
}

/** JSON化可能なTerminatorFamily v1を検証し、凍結snapshotを返す。 */
export function normalizeTerminatorFamily(input, { builtIn = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError('TerminatorFamilyが必要です。');
  assertKnownKeys(
    input,
    new Set(['schemaVersion', 'id', 'name', 'kind', 'geometry', 'builtIn']),
    'TerminatorFamily',
  );
  if ('builtIn' in input && input.builtIn !== (builtIn === true))
    throw new TypeError('TerminatorFamily builtIn指定が名前空間と一致しません。');
  if (input.schemaVersion !== TERMINATOR_FAMILY_SCHEMA_VERSION)
    throw new TypeError(`TerminatorFamily v${TERMINATOR_FAMILY_SCHEMA_VERSION}が必要です。`);

  const kind = input.kind;
  if (!TERMINATOR_FAMILY_KINDS.includes(kind))
    throw new TypeError(`未対応のTerminatorFamily kindです: ${String(kind)}`);

  return Object.freeze({
    schemaVersion: TERMINATOR_FAMILY_SCHEMA_VERSION,
    id: normalizeFamilyId(input.id, { builtIn }),
    name: nonemptyString(input.name, 'TerminatorFamily name', 80),
    kind,
    geometry: normalizeGeometry(input.geometry, kind),
    builtIn: builtIn === true,
  });
}
