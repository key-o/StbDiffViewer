/** @fileoverview Automatic height-dimension intents for level elevations. */
import { normalizeDimensionIntent } from '../../data/drawing/dimensions/dimensionIntentDefinition.js';
import { STRUCTURAL_DIMENSION_FAMILY_ID } from './stbPlanAnnotations.js';

const LEVEL_DIMENSION_OFFSET_CHAIN_MM = 3500;
const LEVEL_DIMENSION_OFFSET_OVERALL_MM = 5500;
const LEVEL_DIMENSION_INTENT_PREFIX = 'dim:level:';

function linearChainIntent(id, references, offsetModelMm) {
  return normalizeDimensionIntent({
    schemaVersion: 1,
    id,
    kind: 'linear-chain',
    references,
    placement: { offsetModelMm },
    familyId: STRUCTURAL_DIMENSION_FAMILY_ID,
  });
}

export function buildLevelElevationDimensionIntents({ stories, bounds } = {}) {
  if (!Array.isArray(stories)) throw new TypeError('立面の階情報が必要です。');
  if (stories.length < 2) return Object.freeze([]);
  if (!Number.isFinite(bounds?.minX)) throw new TypeError('立面寸法の水平基準が不正です。');

  const references = [];
  for (const story of stories) {
    const previous = references.at(-1);
    if (previous?.point[1] === story.height) continue;
    references.push({ kind: 'point', point: [bounds.minX, story.height] });
  }
  if (references.length < 2) return Object.freeze([]);
  return Object.freeze([
    linearChainIntent(
      `${LEVEL_DIMENSION_INTENT_PREFIX}chain`,
      references,
      LEVEL_DIMENSION_OFFSET_CHAIN_MM,
    ),
    linearChainIntent(
      `${LEVEL_DIMENSION_INTENT_PREFIX}overall`,
      [references[0], references.at(-1)],
      LEVEL_DIMENSION_OFFSET_OVERALL_MM,
    ),
  ]);
}

export function formatLevelElevationDimensionValue(valueModelMm, { intent } = {}) {
  if (!Number.isFinite(valueModelMm)) throw new TypeError('寸法値には有限の数値が必要です。');
  const value = Math.abs(valueModelMm);
  return String(intent?.id || '').startsWith(LEVEL_DIMENSION_INTENT_PREFIX)
    ? (value / 1000).toFixed(3)
    : String(Math.round(value));
}
