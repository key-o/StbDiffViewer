/** @fileoverview built-in DimensionFamily / TerminatorFamily registry。 */
import { normalizeDimensionFamily } from './dimensionFamilyDefinition.js';
import { normalizeTerminatorFamily } from './terminatorFamilyDefinition.js';

function assertUniqueFamilyIds(families, name) {
  const ids = new Set();
  for (const family of families) {
    if (ids.has(family.id)) throw new TypeError(`${name} idが重複しています: ${family.id}`);
    ids.add(family.id);
  }
  return families;
}

const TERMINATOR_INPUTS = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    id: 'builtin:slash-45-v1',
    name: '45度スラッシュ',
    kind: 'slash',
    geometry: Object.freeze({ lengthPaperMm: 2.5, angleDeg: 45 }),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: 'builtin:open-arrow-v1',
    name: '開き矢印',
    kind: 'open-arrow',
    geometry: Object.freeze({ lengthPaperMm: 3.2, widthPaperMm: 3.2 }),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: 'builtin:filled-arrow-v1',
    name: '塗り矢印',
    kind: 'filled-arrow',
    geometry: Object.freeze({ lengthPaperMm: 3.2, widthPaperMm: 3.2 }),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: 'builtin:circle-v1',
    name: '円',
    kind: 'circle',
    geometry: Object.freeze({ diameterPaperMm: 2.5 }),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: 'builtin:dot-v1',
    name: '点',
    kind: 'dot',
    geometry: Object.freeze({ diameterPaperMm: 1.2 }),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: 'builtin:none-v1',
    name: 'なし',
    kind: 'none',
    geometry: Object.freeze({}),
  }),
]);

export const BUILTIN_TERMINATOR_FAMILIES = Object.freeze(
  assertUniqueFamilyIds(
    TERMINATOR_INPUTS.map((family) => normalizeTerminatorFamily(family, { builtIn: true })),
    'TerminatorFamily',
  ),
);

const DIMENSION_INPUTS = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    id: 'builtin:structural-dimension-v1',
    name: '構造図標準寸法',
    line: Object.freeze({ strokeWidthPaperMm: 0.25 }),
    witnessLine: Object.freeze({
      strokeWidthPaperMm: 0.25,
      gapPaperMm: 0.8,
      overshootPaperMm: 1.5,
      fixedLengthPaperMm: null,
    }),
    text: Object.freeze({
      heightPaperMm: 2.5,
      gapPaperMm: 1,
      orientation: 'aligned-with-dimension',
    }),
    terminators: Object.freeze({
      start: 'builtin:slash-45-v1',
      intermediate: 'builtin:slash-45-v1',
      end: 'builtin:slash-45-v1',
    }),
  }),
  Object.freeze({
    schemaVersion: 1,
    id: 'builtin:measurement-dimension-v1',
    name: '測定寸法',
    line: Object.freeze({ strokeWidthPaperMm: 0.8 }),
    witnessLine: Object.freeze({
      strokeWidthPaperMm: 0.5,
      dashPatternPaperMm: Object.freeze([1.6, 1.2]),
      gapPaperMm: 0,
      overshootPaperMm: 0,
      fixedLengthPaperMm: null,
    }),
    text: Object.freeze({
      heightPaperMm: 3.5,
      gapPaperMm: 4,
      orientation: 'horizontal-on-paper',
    }),
    terminators: Object.freeze({
      start: 'builtin:open-arrow-v1',
      intermediate: 'builtin:open-arrow-v1',
      end: 'builtin:open-arrow-v1',
    }),
  }),
]);

export function resolveTerminatorFamily(familyId) {
  if (typeof familyId !== 'string' || !familyId.trim())
    throw new TypeError('TerminatorFamily idが必要です。');
  const family = BUILTIN_TERMINATOR_FAMILIES.find((candidate) => candidate.id === familyId);
  if (!family) throw new TypeError(`TerminatorFamilyがありません: ${familyId}`);
  return family;
}

export function assertDimensionFamilyTerminatorReferences(familyInput, { builtIn = false } = {}) {
  const family = normalizeDimensionFamily(familyInput, { builtIn });
  for (const [position, terminatorId] of Object.entries(family.terminators)) {
    try {
      resolveTerminatorFamily(terminatorId);
    } catch (error) {
      throw new TypeError(
        `DimensionFamily ${family.id} の${position} terminatorを解決できません: ${terminatorId}`,
        { cause: error },
      );
    }
  }
  return family;
}

export const BUILTIN_DIMENSION_FAMILIES = Object.freeze(
  assertUniqueFamilyIds(
    DIMENSION_INPUTS.map((family) =>
      assertDimensionFamilyTerminatorReferences(family, { builtIn: true }),
    ),
    'DimensionFamily',
  ),
);

export function resolveDimensionFamily(familyId) {
  if (typeof familyId !== 'string' || !familyId.trim())
    throw new TypeError('DimensionFamily idが必要です。');
  const family = BUILTIN_DIMENSION_FAMILIES.find((candidate) => candidate.id === familyId);
  if (!family) throw new TypeError(`DimensionFamilyがありません: ${familyId}`);
  return family;
}
