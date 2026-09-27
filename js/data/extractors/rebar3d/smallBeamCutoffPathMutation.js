/**
 * @fileoverview R12-ZC 小梁カットオフpath planをmember-local RebarPathへ原子的に適用する。
 */
import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';

const SOURCE = 'R12-ZC-small-beam-cutoff-path-mutation';
const TOLERANCE_MM = 1e-6;

function singleLine(path) {
  return path?.primitives?.length === 1 && path.primitives[0]?.type === 'line'
    ? path.primitives[0]
    : null;
}

function close(left, right) {
  return Math.abs(Number(left) - Number(right)) <= TOLERANCE_MM;
}

function fail(reason, extra = {}) {
  return { applied: false, reason, source: SOURCE, ...extra };
}

function relevantMainPaths(paths) {
  return (paths || []).filter(
    (path) =>
      path?.metadata?.coordinateSpace === 'member-local' &&
      (path?.metadata?.role === 'top' || path?.metadata?.role === 'bottom'),
  );
}

function pathMatchesPlannedBaseline(path, entry, memberLengthMm) {
  const line = singleLine(path);
  if (
    !line ||
    path?.metadata?.coordinateSpace !== 'member-local' ||
    path?.metadata?.role !== entry?.role
  ) {
    return false;
  }
  const baselineStartMm = Number(line.start.z) + memberLengthMm / 2;
  const baselineEndMm = Number(line.end.z) + memberLengthMm / 2;
  return (
    close(line.start.x, entry?.pathLocator?.baselineX) &&
    close(line.start.y, entry?.pathLocator?.baselineY) &&
    close(baselineStartMm, entry?.baselineStartMm) &&
    close(baselineEndMm, entry?.baselineEndMm)
  );
}

function findPlannedPath(paths, entry, memberLengthMm) {
  if (entry?.pathMatchKind === 'PATH_INDEX') {
    const pathIndex = Number(entry?.pathIndex);
    if (!Number.isInteger(pathIndex) || pathIndex < 0 || pathIndex >= paths.length) {
      return { path: null, count: 0, reason: 'small-beam-cutoff-mutation-path-index-invalid' };
    }
    const candidate = paths[pathIndex];
    return pathMatchesPlannedBaseline(candidate, entry, memberLengthMm)
      ? { path: candidate, count: 1, reason: null }
      : { path: null, count: 0, reason: 'small-beam-cutoff-mutation-path-index-mismatch' };
  }

  const matches = paths.filter(
    (path) =>
      path?.metadata?.identityKey === entry?.identityKey && path?.metadata?.role === entry?.role,
  );
  return {
    path: matches.length === 1 ? matches[0] : null,
    count: matches.length,
    reason:
      matches.length === 0
        ? 'small-beam-cutoff-mutation-identity-path-missing'
        : matches.length > 1
          ? 'small-beam-cutoff-mutation-identity-path-ambiguous'
          : null,
  };
}

function mutatePath(path, entry, memberLengthMm, memberId) {
  if (!entry?.mutationRequired) return { ok: true, path };
  const line = singleLine(path);
  if (!line || !validateRebarPath(path).ok) {
    return { ok: false, reason: 'small-beam-cutoff-baseline-path-invalid' };
  }
  if (!close(line.start.x, line.end.x) || !close(line.start.y, line.end.y)) {
    return { ok: false, reason: 'small-beam-cutoff-baseline-path-not-axial' };
  }
  const targetStartMm = Number(entry.targetStartMm);
  const targetEndMm = Number(entry.targetEndMm);
  const length = Number(memberLengthMm);
  if (
    ![targetStartMm, targetEndMm, length].every(Number.isFinite) ||
    targetStartMm < -TOLERANCE_MM ||
    targetEndMm > length + TOLERANCE_MM ||
    !(targetEndMm > targetStartMm + TOLERANCE_MM)
  ) {
    return { ok: false, reason: 'small-beam-cutoff-target-station-invalid' };
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
      smallBeamCutoffApplied: true,
      cutoffRuleId: 'R12-ZC',
      cutoffSource: SOURCE,
      cutoffSpanType: entry?.barRequirement?.spanType || null,
      cutoffMode: entry.mode || null,
      cutoffPathMatchKind: entry.pathMatchKind || 'IDENTITY',
      cutoffPathIndex: entry.pathIndex ?? null,
      cutoffSourceFigure: entry?.barRequirement?.sourceFigure || null,
      cutoffExtensionDiaFactor: entry?.barRequirement?.extensionDiaFactor ?? null,
      cutoffExtensionMm: entry.extensionMm ?? entry?.barRequirement?.requiredExtensionMm ?? null,
      cutoffBaselineStartMm: entry.baselineStartMm,
      cutoffBaselineEndMm: entry.baselineEndMm,
      cutoffTargetStartMm: Math.max(0, targetStartMm),
      cutoffTargetEndMm: Math.min(length, targetEndMm),
      cutoffStartReferenceMm: entry.startReferenceMm ?? null,
      cutoffEndReferenceMm: entry.endReferenceMm ?? null,
    },
  );
  const validation = validateRebarPath(next);
  if (!validation.ok) {
    return { ok: false, reason: 'small-beam-cutoff-generated-path-invalid', validation };
  }
  return { ok: true, path: next, validation };
}

/**
 * member planが完全成立した場合だけ全identityをまとめて置換する。
 * 1本でも不一致ならbaseline pathsをそのまま返す。
 */
export function applySmallBeamCutoffMemberPathPlan({
  memberPlan,
  memberPaths,
  memberLengthMm,
  memberId = null,
} = {}) {
  const baseline = Array.isArray(memberPaths) ? memberPaths : [];
  if (!memberPlan?.resolved || memberPlan?.pathPlanReady !== true) {
    return fail(memberPlan?.reason || 'small-beam-cutoff-member-plan-not-ready', {
      paths: baseline,
      mutations: [],
      unresolved: memberPlan?.unresolved || [],
    });
  }
  const length = Number(memberLengthMm);
  if (!(length > 0)) {
    return fail('small-beam-cutoff-member-length-unresolved', {
      paths: baseline,
      mutations: [],
      unresolved: [],
    });
  }

  const mainPaths = relevantMainPaths(baseline);
  if (mainPaths.length !== memberPlan.entries.length) {
    return fail('small-beam-cutoff-plan-path-count-mismatch', {
      paths: baseline,
      mutations: [],
      unresolved: [
        {
          reason: 'small-beam-cutoff-plan-path-count-mismatch',
          planCount: memberPlan.entries.length,
          pathCount: mainPaths.length,
        },
      ],
    });
  }

  const replacements = new Map();
  const mutations = [];
  const unresolved = [];
  for (const entry of memberPlan.entries) {
    const match = findPlannedPath(baseline, entry, length);
    if (!match.path) {
      unresolved.push({
        identityKey: entry.identityKey || null,
        role: entry.role || null,
        pathIndex: entry.pathIndex ?? null,
        reason: match.reason || 'small-beam-cutoff-mutation-path-unresolved',
        candidateCount: match.count,
      });
      continue;
    }
    const mutated = mutatePath(match.path, entry, length, memberId);
    if (!mutated.ok) {
      unresolved.push({
        identityKey: entry.identityKey || null,
        role: entry.role || null,
        reason: mutated.reason,
      });
      continue;
    }
    replacements.set(match.path, mutated.path);
    if (entry.mutationRequired) {
      mutations.push({
        identityKey: entry.identityKey,
        role: entry.role,
        mode: entry.mode,
        pathMatchKind: entry.pathMatchKind || 'IDENTITY',
        pathIndex: entry.pathIndex ?? null,
        baselineStartMm: entry.baselineStartMm,
        baselineEndMm: entry.baselineEndMm,
        targetStartMm: entry.targetStartMm,
        targetEndMm: entry.targetEndMm,
      });
    }
  }

  if (unresolved.length > 0 || replacements.size !== memberPlan.entries.length) {
    return fail(unresolved[0]?.reason || 'small-beam-cutoff-mutation-incomplete', {
      paths: baseline,
      mutations: [],
      unresolved,
    });
  }

  return {
    applied: mutations.length > 0,
    reason: null,
    source: SOURCE,
    memberId: memberId === null || memberId === undefined ? null : String(memberId),
    paths: baseline.map((path) => replacements.get(path) || path),
    mutations,
    unresolved: [],
  };
}
