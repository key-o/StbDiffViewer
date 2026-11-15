/**
 * Auxiliary schedule reinforcement belongs to the user-edited DrawingProject,
 * not to STB source bars. Position names are explicit ST-Bridge layouts.
 * Never infer MAIN/TRANSVERSE from SHORT/LONG or 202 unzoned bars from strips.
 */
import { SLAB_PATTERN_POSITIONS } from './slabSectionFacts.js';

export const AUXILIARY_BAR_LAYOUTS = Object.freeze({
  STANDARD: SLAB_PATTERN_POSITIONS.STANDARD,
  '2WAY_202': SLAB_PATTERN_POSITIONS['2WAY_202'],
  '2WAY_21X': SLAB_PATTERN_POSITIONS['2WAY_21X'],
  '1WAY1': SLAB_PATTERN_POSITIONS['1WAY1'],
  '1WAY2': SLAB_PATTERN_POSITIONS['1WAY2'],
});

export function validateAuxiliaryBars(row) {
  const layout = row.barLayout ?? null;
  const values = row.barValues ?? {};
  if (layout !== null && !Object.hasOwn(AUXILIARY_BAR_LAYOUTS, layout))
    throw new TypeError('Unknown auxiliary bar layout');
  if (
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values) ||
    Object.getOwnPropertySymbols(values).length
  )
    throw new TypeError('Invalid auxiliary bar values');
  const allowed = new Set(layout ? AUXILIARY_BAR_LAYOUTS[layout] : []);
  if (
    Object.keys(values).length > 12 ||
    Object.entries(values).some(
      ([pos, value]) => !allowed.has(pos) || typeof value !== 'string' || value.length > 256,
    )
  )
    throw new TypeError('Invalid auxiliary reinforcement position or text');
}

export function layoutForStbSlab(section) {
  const pattern = section?.barPattern;
  if (pattern === 'STANDARD' || pattern === '1WAY1' || pattern === '1WAY2') return pattern;
  if (pattern !== '2WAY') return null;
  const version = String(section.version || '');
  if (version.startsWith('2.0.2')) return '2WAY_202';
  return /^2\.1\.[01]$/.test(version) ? '2WAY_21X' : null;
}

/** Clone only explicit, unique and valid original STB positions. */
export function cloneStbSlabBars(section) {
  const barLayout = layoutForStbSlab(section);
  if (!barLayout) throw new TypeError('複製できないSTB配筋パターン／バージョンです');
  const legal = new Set(AUXILIARY_BAR_LAYOUTS[barLayout]);
  const barValues = {};
  for (const bar of section.barPositions || []) {
    if (
      !legal.has(bar.pos) ||
      Object.hasOwn(barValues, bar.pos) ||
      !Array.isArray(bar.problems) ||
      bar.problems.length ||
      !bar.rawD ||
      !bar.rawPitch
    )
      throw new TypeError('曖昧または無効なSTB posは補助行に複製できません');
    barValues[bar.pos] = String(bar.rawD) + '@' + String(bar.rawPitch);
  }
  // Missing positions stay missing; never manufacture a reinforcement specification.
  return { barLayout, barValues };
}

export function auxiliaryBarCell(row, direction, face, zone) {
  const layout = row?.auxiliary?.barLayout;
  const values = row?.auxiliary?.barValues ?? {};
  const lookup = (pos) => (Object.hasOwn(values, pos) && values[pos].trim() ? values[pos] : null);
  let positions = [];
  if (layout === 'STANDARD') {
    const prefix = direction + '_' + face;
    positions =
      zone === 'END' ? [prefix + '_COLUMN', prefix + '_MID_END'] : [prefix + '_MID_CENTER'];
  } else if (layout === '2WAY_21X') {
    positions = [direction + '_' + face + '_' + zone];
  } else if (layout === '2WAY_202') {
    positions = [direction + '_' + face];
  }
  if (!positions.length) return { value: '', state: 'NOT_APPLICABLE' };
  const found = positions.map(lookup);
  if (found.some((value) => value === null)) return { value: '', state: 'MISSING' };
  if (new Set(found).size !== 1) return { value: '', state: 'AMBIGUOUS' };
  return { value: found[0], state: 'VALID', source: 'AUXILIARY' };
}
