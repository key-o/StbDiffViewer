/**
 * @fileoverview R12-AC 片持ち小梁上端2段筋cutoff planをmember-local pathへ原子的に適用する。
 */

import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';

const SOURCE = 'R12-AC-small-beam-cantilever-cutoff-path-mutation';
const TOLERANCE_MM = 1e-6;

function fail(reason, extra = {}) {
  return { applied: false, reason, source: SOURCE, ...extra };
}

function singleLine(path) {
  return path?.primitives?.length === 1 && path.primitives[0]?.type === 'line'
    ? path.primitives[0]
    : null;
}

function isTopSecondLayer(path) {
  return (
    path?.metadata?.coordinateSpace === 'member-local' &&
    path?.metadata?.role === 'top' &&
    Number(path?.metadata?.layer) === 2
  );
}

function findUniqueIdentityPath(paths, entry) {
  const matches = paths.filter(
    (path) => isTopSecondLayer(path) && path?.metadata?.identityKey === entry?.identityKey,
  );
  return { path: matches.length === 1 ? matches[0] : null, count: matches.length };
}

function mutatePath(path, entry, memberLengthMm, memberId) {
  if (!entry?.mutationRequired) return { ok: true, path };
  const line = singleLine(path);
  if (!line || !validateRebarPath(path).ok) {
    return { ok: false, reason: 'small-beam-cantilever-baseline-path-invalid' };
  }

  const length = Number(memberLengthMm);
  const targetStartMm = Number(entry.targetStartMm);
  const targetEndMm = Number(entry.targetEndMm);
  if (
    ![length, targetStartMm, targetEndMm].every(Number.isFinite) ||
    targetStartMm < -TOLERANCE_MM ||
    targetEndMm > length + TOLERANCE_MM ||
    !(targetEndMm > targetStartMm + TOLERANCE_MM)
  ) {
    return { ok: false, reason: 'small-beam-cantilever-cutoff-target-invalid' };
  }

  const next = createRebarPath(
    [
      createLine(
        { ...line.start, z: Math.max(0, targetStartMm) - length / 2 },
        { ...line.end, z: Math.min(length, targetEndMm) - length / 2 },
      ),
    ],
    {
      ...path.metadata,
      memberId: memberId || path.metadata?.memberId || null,
      memberTag: 'StbBeam',
      smallBeamCantileverCutoffApplied: true,
      cantileverCutoffRuleId: 'R12-AC',
      cantileverCutoffSource: SOURCE,
      cantileverCutoffSupportSide: entry.supportSide,
      cantileverCutoffReferenceMm: entry.referenceFromSupportMm,
      cantileverCutoffExtensionDiaFactor: entry.extensionDiaFactor,
      cantileverCutoffExtensionMm: entry.extensionMm,
      cantileverCutoffRequiredFromSupportMm: entry.requiredFromSupportMm,
      cantileverCutoffBaselineStartMm: entry.baselineStartMm,
      cantileverCutoffBaselineEndMm: entry.baselineEndMm,
      cantileverCutoffTargetStartMm: Math.max(0, targetStartMm),
      cantileverCutoffTargetEndMm: Math.min(length, targetEndMm),
    },
  );
  const validation = validateRebarPath(next);
  if (!validation.ok) {
    return { ok: false, reason: 'small-beam-cantilever-cutoff-generated-path-invalid', validation };
  }
  return { ok: true, path: next, validation };
}

/** 1本でも不整合ならtop/layer=2を含むmember全体をbaselineへ戻す。 */
export function applySmallBeamCantileverCutoffMemberPathPlan({
  memberPlan,
  memberPaths,
  memberLengthMm,
  memberId = null,
} = {}) {
  const baseline = Array.isArray(memberPaths) ? memberPaths : [];
  if (!memberPlan?.resolved || memberPlan?.pathPlanReady !== true) {
    return fail(memberPlan?.reason || 'small-beam-cantilever-cutoff-plan-not-ready', {
      paths: baseline,
      mutations: [],
      unresolved: memberPlan?.unresolved || [],
    });
  }
  const length = Number(memberLengthMm);
  if (!(length > 0)) {
    return fail('small-beam-cantilever-member-length-unresolved', {
      paths: baseline,
      mutations: [],
      unresolved: [],
    });
  }

  const targetPaths = baseline.filter(isTopSecondLayer);
  if (targetPaths.length !== memberPlan.entries.length) {
    return fail('small-beam-cantilever-cutoff-plan-path-count-mismatch', {
      paths: baseline,
      mutations: [],
      unresolved: [
        {
          reason: 'small-beam-cantilever-cutoff-plan-path-count-mismatch',
          planCount: memberPlan.entries.length,
          pathCount: targetPaths.length,
        },
      ],
    });
  }

  const replacements = new Map();
  const mutations = [];
  const unresolved = [];
  for (const entry of memberPlan.entries) {
    const match = findUniqueIdentityPath(targetPaths, entry);
    if (!match.path) {
      unresolved.push({
        identityKey: entry.identityKey || null,
        reason:
          match.count === 0
            ? 'small-beam-cantilever-cutoff-identity-path-missing'
            : 'small-beam-cantilever-cutoff-identity-path-ambiguous',
        candidateCount: match.count,
      });
      continue;
    }
    const mutated = mutatePath(match.path, entry, length, memberId);
    if (!mutated.ok) {
      unresolved.push({ identityKey: entry.identityKey || null, reason: mutated.reason });
      continue;
    }
    replacements.set(match.path, mutated.path);
    if (entry.mutationRequired) {
      mutations.push({
        identityKey: entry.identityKey,
        supportSide: entry.supportSide,
        baselineStartMm: entry.baselineStartMm,
        baselineEndMm: entry.baselineEndMm,
        targetStartMm: entry.targetStartMm,
        targetEndMm: entry.targetEndMm,
      });
    }
  }

  if (unresolved.length > 0 || replacements.size !== memberPlan.entries.length) {
    return fail(unresolved[0]?.reason || 'small-beam-cantilever-cutoff-mutation-incomplete', {
      paths: baseline,
      mutations: [],
      unresolved,
    });
  }

  return {
    applied: mutations.length > 0,
    reason: null,
    source: SOURCE,
    memberId: memberId == null ? null : String(memberId),
    paths: baseline.map((path) => replacements.get(path) || path),
    mutations,
    unresolved: [],
  };
}
