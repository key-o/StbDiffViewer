/**
 * @fileoverview Issue #292: Appendix A2 actual-geometry feasibilityを
 * RebarPlacementRuleSetのHard Constraint入力へ変換するpure adapter。
 *
 * geometry check自体は#273のrebarAppendixA2JointFeasibilityを正本とし、
 * ここではcandidateが必要な調整を明示的に満たすかだけを判定する。
 * 推定移動・暗黙の2段化・別納まり選択は行わない。
 */

export const RebarPlacementCandidateEffect = Object.freeze({
  SIDE_OUTER_BAR_INSET: 'SIDE_OUTER_BAR_INSET',
  LAYER_ESCALATION: 'LAYER_ESCALATION',
  ALTERNATIVE_DETAIL: 'ALTERNATIVE_DETAIL',
});

const VALID_EFFECTS = new Set(Object.values(RebarPlacementCandidateEffect));
const EPS = 1e-6;

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim().toUpperCase();
}

function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEffect(effect) {
  if (typeof effect === 'string') {
    const type = text(effect);
    return VALID_EFFECTS.has(type) ? Object.freeze({ type }) : null;
  }
  const type = text(effect?.type);
  if (!VALID_EFFECTS.has(type)) return null;
  const distanceMm = finiteOrNull(effect?.distanceMm);
  return Object.freeze({
    type,
    ...(effect?.side ? { side: text(effect.side) } : {}),
    ...(effect?.role ? { role: text(effect.role) } : {}),
    ...(distanceMm !== null ? { distanceMm } : {}),
  });
}

function normalizeEffects(candidateEffects) {
  return Object.freeze(
    (Array.isArray(candidateEffects) ? candidateEffects : []).map(normalizeEffect).filter(Boolean),
  );
}

function freezeDetails(details = {}) {
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (Array.isArray(value)) result[key] = Object.freeze(value.slice());
    else if (value && typeof value === 'object') result[key] = Object.freeze({ ...value });
    else result[key] = value;
  }
  return Object.freeze(result);
}

function requirement({
  type,
  code,
  sourceRuleIds,
  side = null,
  role = null,
  minimumDistanceMm = null,
  details = {},
}) {
  return Object.freeze({
    type,
    code,
    sourceRuleIds: Object.freeze(sourceRuleIds.filter(Boolean).map(String)),
    ...(side ? { side: text(side) } : {}),
    ...(role ? { role: text(role) } : {}),
    ...(minimumDistanceMm !== null ? { minimumDistanceMm } : {}),
    details: freezeDetails(details),
  });
}

function effectSatisfiesRequirement(effect, required) {
  if (effect.type !== required.type) return false;
  if (required.side && effect.side !== required.side) return false;
  if (required.role && effect.role !== required.role) return false;
  if (required.minimumDistanceMm !== undefined) {
    return (
      Number.isFinite(effect.distanceMm) && effect.distanceMm + EPS >= required.minimumDistanceMm
    );
  }
  return true;
}

function violationForRequirement(required) {
  return Object.freeze({
    code: required.code,
    requirementType: required.type,
    sourceRuleIds: required.sourceRuleIds,
    ...(required.side ? { side: required.side } : {}),
    ...(required.role ? { role: required.role } : {}),
    ...(required.minimumDistanceMm !== undefined
      ? { minimumDistanceMm: required.minimumDistanceMm }
      : {}),
    details: required.details,
  });
}

function geometryUnresolvedViolation(jointCheck, reason) {
  return Object.freeze({
    code: 'appendix-a2-geometry-unresolved',
    requirementType: 'GEOMETRY_RESOLUTION',
    sourceRuleIds: Object.freeze(
      (jointCheck?.candidateRules || [])
        .map((rule) => rule?.ruleId)
        .filter(Boolean)
        .map(String),
    ),
    details: Object.freeze({
      nodeId: jointCheck?.nodeId ?? null,
      reason: reason || jointCheck?.reason || 'appendix-a2-geometry-unresolved',
    }),
  });
}

function collectRequirements(feasibility) {
  const requirements = [];

  for (const check of feasibility?.sideChecks || []) {
    if (check?.status === 'ADJUSTMENT_REQUIRED') {
      const minimumDistanceMm = finiteOrNull(check.requiredInsetMm);
      requirements.push(
        requirement({
          type: RebarPlacementCandidateEffect.SIDE_OUTER_BAR_INSET,
          code: 'appendix-a2-side-outer-bar-inset-required',
          sourceRuleIds: ['APPENDIX-A2-SIDE-JOINT-OUTER-BAR-INSET'],
          side: check.side,
          role: check.role,
          minimumDistanceMm,
          details: {
            currentClearMm: finiteOrNull(check.currentClearMm),
            postShiftClearToNextMm: finiteOrNull(check.postShiftClearToNextMm),
            minimumMainBarClearMm: finiteOrNull(check.minimumMainBarClearMm),
          },
        }),
      );
    } else if (check?.status === 'LAYER_ESCALATION_REQUIRED') {
      requirements.push(
        requirement({
          type: RebarPlacementCandidateEffect.LAYER_ESCALATION,
          code: 'appendix-a2-side-one-layer-congestion',
          sourceRuleIds: ['APPENDIX-A2-SIDE-JOINT-OUTER-BAR-INSET'],
          side: check.side,
          role: check.role,
          details: {
            requiredInsetMm: finiteOrNull(check.requiredInsetMm),
            postShiftClearToNextMm: finiteOrNull(check.postShiftClearToNextMm),
            minimumMainBarClearMm: finiteOrNull(check.minimumMainBarClearMm),
          },
        }),
      );
    } else if (check?.status === 'UNRESOLVED') {
      requirements.push(
        requirement({
          type: 'GEOMETRY_RESOLUTION',
          code: 'appendix-a2-side-geometry-unresolved',
          sourceRuleIds: ['APPENDIX-A2-SIDE-JOINT-OUTER-BAR-INSET'],
          side: check.side,
          role: check.role,
          details: { reason: check.reason || null },
        }),
      );
    }
  }

  const corner = feasibility?.cornerHookInsertion;
  for (const check of corner?.checks || []) {
    if (check?.status === 'TWO_LAYER_CANDIDATE') {
      requirements.push(
        requirement({
          type: RebarPlacementCandidateEffect.LAYER_ESCALATION,
          code: 'appendix-a2-corner-two-layer-required',
          sourceRuleIds: [
            'APPENDIX-A2-CORNER-HOOK-INSIDE-DIA-4D',
            'APPENDIX-A2-CORNER-LAYER-ESCALATION',
          ],
          role: check.role,
          details: {
            requiredClearMm: finiteOrNull(check.requiredClearMm),
            currentMaxClearMm: finiteOrNull(check.currentMaxClearMm),
            candidate: check.twoLayerEscalationCandidate || null,
          },
        }),
      );
    } else if (check?.status === 'ALTERNATIVE_DETAIL_REQUIRED') {
      requirements.push(
        requirement({
          type: RebarPlacementCandidateEffect.ALTERNATIVE_DETAIL,
          code: 'appendix-a2-corner-alternative-detail-required',
          sourceRuleIds: [
            'APPENDIX-A2-CORNER-HOOK-INSIDE-DIA-4D',
            'APPENDIX-A2-CORNER-LAYER-ESCALATION',
          ],
          role: check.role,
          details: {
            requiredClearMm: finiteOrNull(check.requiredClearMm),
            currentMaxClearMm: finiteOrNull(check.currentMaxClearMm),
          },
        }),
      );
    }
  }

  return Object.freeze(requirements);
}

/**
 * @param {object} jointCheck collectRebarAppendixA2JointAssemblyChecks()の1行
 * @param {{candidateEffects?: Array<object|string>}} options
 * @returns {{hardConstraintViolations: readonly object[], geometryRequirements: readonly object[], candidateEffects: readonly object[]}}
 */
export function buildAppendixA2PlacementGeometryContext(jointCheck, options = {}) {
  const candidateEffects = normalizeEffects(options.candidateEffects);
  const topology = text(jointCheck?.jointTopology?.kind);
  if (!['SIDE', 'CORNER'].includes(topology)) {
    return Object.freeze({
      source: 'APPENDIX_A2_GEOMETRY_FEASIBILITY',
      hardConstraintViolations: Object.freeze([]),
      geometryRequirements: Object.freeze([]),
      candidateEffects,
    });
  }

  const feasibility = jointCheck?.geometryFeasibility || null;
  if (
    !feasibility ||
    jointCheck?.geometryApplication !== 'CHECK_CONNECTED' ||
    feasibility.status === 'UNRESOLVED'
  ) {
    return Object.freeze({
      source: 'APPENDIX_A2_GEOMETRY_FEASIBILITY',
      hardConstraintViolations: Object.freeze([
        geometryUnresolvedViolation(jointCheck, feasibility?.reason),
      ]),
      geometryRequirements: Object.freeze([]),
      candidateEffects,
    });
  }

  const geometryRequirements = collectRequirements(feasibility);
  const hardConstraintViolations = [];
  for (const required of geometryRequirements) {
    if (required.type === 'GEOMETRY_RESOLUTION') {
      hardConstraintViolations.push(violationForRequirement(required));
      continue;
    }
    if (!candidateEffects.some((effect) => effectSatisfiesRequirement(effect, required))) {
      hardConstraintViolations.push(violationForRequirement(required));
    }
  }

  return Object.freeze({
    source: 'APPENDIX_A2_GEOMETRY_FEASIBILITY',
    hardConstraintViolations: Object.freeze(hardConstraintViolations),
    geometryRequirements,
    candidateEffects,
  });
}

export function withAppendixA2PlacementGeometryContext(context = {}, jointCheck, options = {}) {
  const geometryContext = buildAppendixA2PlacementGeometryContext(jointCheck, options);
  const existing = Array.isArray(context?.hardConstraintViolations)
    ? context.hardConstraintViolations.filter(Boolean)
    : [];
  return Object.freeze({
    ...context,
    hardConstraintViolations: Object.freeze([
      ...existing,
      ...geometryContext.hardConstraintViolations,
    ]),
    geometryRequirements: geometryContext.geometryRequirements,
    candidateEffects: geometryContext.candidateEffects,
    geometryContextSource: geometryContext.source,
  });
}
