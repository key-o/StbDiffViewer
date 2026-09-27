/**
 * @fileoverview 日建連・JSCA 2023標準図 §6-1 の基礎大梁端部について、
 * 選択済みtypeとbar layerから availability 比較に使う必要投影長を解決する。
 *
 * 図6-1-1〜図6-1-3からbar layerとの対応を一意に読める範囲をproductionへ接続する。
 * - A1 / B2 / C2 1段筋: 「1段筋は直線定着 L2」→ required projection = L2
 * - B1 / C1 1段筋: 折曲げ定着 → required projection = Laかつ3D/4、全長L2、余長8d
 * - 全type 2段筋: 図示される折曲げ定着 → required projection = Laかつ3D/4、全長L2、余長8d
 *
 * 3段筋以降は標準図§6-1でbar-level対応を一意化できないため fail-closed とする。
 */

import { validateFoundationBeamAnchorageType2023 } from './foundationBeamAnchorageTypeConstraint2023.js';

const STRAIGHT_FIRST_LAYER_TYPES = new Set(['A1', 'B2', 'C2']);
const BENT_FIRST_LAYER_TYPES = new Set(['B1', 'C1']);
const GIRDER_TYPES_WITH_SECOND_LAYER_BENT = new Set(['A1', 'B1', 'B2', 'C1', 'C2']);

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    blockers: [reason],
    requiredAnchorageMm: null,
    ...extra,
  };
}

function invalid(reason, extra = {}) {
  return {
    status: 'INVALID',
    resolved: false,
    blockers: [reason],
    requiredAnchorageMm: null,
    ...extra,
  };
}

function ready(requiredAnchorageMm, extra = {}) {
  return {
    status: 'READY',
    resolved: true,
    blockers: [],
    requiredAnchorageMm,
    ...extra,
  };
}

function normalizeType(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function normalizeLayer(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function candidateRequired(candidates, key) {
  const candidate = candidates?.[key];
  return candidate?.resolved === true &&
    Number.isFinite(candidate.requiredMm) &&
    candidate.requiredMm > 0
    ? candidate.requiredMm
    : null;
}

function resolveStraightL2Requirement({
  normalizedType,
  layer,
  bar,
  standardCandidates,
  constraint,
}) {
  const l2Mm = candidateRequired(standardCandidates.candidates, 'l2');
  if (!l2Mm) {
    return unresolved('foundation-anchorage-l2-unresolved', {
      type: normalizedType,
      layer,
      typeConstraint: constraint,
    });
  }
  return ready(l2Mm, {
    type: normalizedType,
    layer,
    role: bar?.role || null,
    mode: 'STRAIGHT_L2',
    projectionKind: 'L2',
    totalLengthRequirementMm: l2Mm,
    tailRequirementMm: 0,
    typeConstraint: constraint,
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-FIG-6-1-1-6-1-2b-6-1-3b',
  });
}

function resolveBentL2LaRequirement({
  normalizedType,
  layer,
  bar,
  standardCandidates,
  constraint,
}) {
  const laMm = candidateRequired(standardCandidates.candidates, 'la');
  const l2Mm = candidateRequired(standardCandidates.candidates, 'l2');
  const tailMm = candidateRequired(standardCandidates.candidates, 'hookTail90');
  if (!laMm || !l2Mm || !tailMm) {
    return unresolved('foundation-anchorage-bent-candidate-unresolved', {
      type: normalizedType,
      layer,
      typeConstraint: constraint,
    });
  }
  return ready(laMm, {
    type: normalizedType,
    layer,
    role: bar?.role || null,
    mode: 'BENT_L2_LA_TAIL8D',
    projectionKind: 'LA_AND_3D_OVER_4',
    totalLengthRequirementMm: l2Mm,
    tailRequirementMm: tailMm,
    typeConstraint: constraint,
    source: 'NIKKENREN-JSCA-RC-REBAR-STANDARD-2023-FIG-6-1-1-6-1-2-6-1-3',
  });
}

/**
 * @param {Object} params
 * @param {'StbGirder'|'GIRDER'|'StbBeam'|'BEAM'} params.memberTag
 * @param {string} params.type A1/B1/B2/C1/C2 等
 * @param {Object} params.bar bar fact (layer/role)
 * @param {Object} params.standardCandidates foundationBeamAnchorageStandardCandidates の candidates
 * @param {boolean|null} [params.uplift]
 * @param {string|null} [params.foundationSystem]
 * @param {boolean|null} [params.continuous]
 */
export function resolveFoundationBeamAnchorageRequirement2023({
  memberTag,
  type,
  bar,
  standardCandidates,
  uplift = null,
  foundationSystem = null,
  continuous = null,
} = {}) {
  const normalizedType = normalizeType(type);
  const layer = normalizeLayer(bar?.layer);
  if (!normalizedType) return invalid('foundation-anchorage-requirement-type-missing');
  if (!layer)
    return unresolved('foundation-anchorage-requirement-layer-unresolved', {
      type: normalizedType,
    });

  const constraint = validateFoundationBeamAnchorageType2023({
    memberTag,
    type: normalizedType,
    uplift,
    foundationSystem,
    continuous,
  });
  if (!constraint?.resolved) {
    return {
      ...(constraint?.status === 'INVALID'
        ? invalid('foundation-anchorage-requirement-type-constraint-invalid')
        : unresolved('foundation-anchorage-requirement-type-constraint-unresolved')),
      type: normalizedType,
      layer,
      typeConstraint: constraint || null,
      constraintBlockers: [...(constraint?.blockers || [])],
    };
  }

  const memberKind = String(memberTag || '').toUpperCase();
  if (!(memberKind === 'STBGIRDER' || memberKind === 'GIRDER')) {
    return unresolved('foundation-small-beam-anchorage-requirement-not-encoded', {
      type: normalizedType,
      layer,
      typeConstraint: constraint,
    });
  }

  if (!standardCandidates?.resolved || !standardCandidates.candidates) {
    return unresolved('foundation-anchorage-standard-candidates-unresolved', {
      type: normalizedType,
      layer,
      typeConstraint: constraint,
      candidateBlockers: [...(standardCandidates?.blockers || [])],
    });
  }

  if (layer > 2) {
    return unresolved('foundation-anchorage-layer-beyond-standard-detail-unresolved', {
      type: normalizedType,
      layer,
      role: bar?.role || null,
      typeConstraint: constraint,
    });
  }

  if (layer === 1 && STRAIGHT_FIRST_LAYER_TYPES.has(normalizedType)) {
    return resolveStraightL2Requirement({
      normalizedType,
      layer,
      bar,
      standardCandidates,
      constraint,
    });
  }

  if (
    (layer === 1 && BENT_FIRST_LAYER_TYPES.has(normalizedType)) ||
    (layer === 2 && GIRDER_TYPES_WITH_SECOND_LAYER_BENT.has(normalizedType))
  ) {
    return resolveBentL2LaRequirement({
      normalizedType,
      layer,
      bar,
      standardCandidates,
      constraint,
    });
  }

  return invalid('foundation-anchorage-requirement-type-unsupported', {
    type: normalizedType,
    layer,
    typeConstraint: constraint,
  });
}

export const _foundationBeamAnchorageRequirement2023Internals = Object.freeze({
  normalizeType,
  normalizeLayer,
  candidateRequired,
  resolveStraightL2Requirement,
  resolveBentL2LaRequirement,
});
