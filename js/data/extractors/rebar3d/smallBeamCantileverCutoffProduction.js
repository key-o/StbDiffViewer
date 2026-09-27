/**
 * @fileoverview R12-AD 片持ち小梁上端2段筋 cutoff production orchestration。
 *
 * R12-AA facts -> R12-AB identity plan -> R12-AC atomic mutationを1 member単位で接続する。
 */

import { buildSmallBeamCantileverCutoffMemberPathPlan } from './smallBeamCantileverCutoffPathPlan.js';
import { applySmallBeamCantileverCutoffMemberPathPlan } from './smallBeamCantileverCutoffPathMutation.js';

const SOURCE = 'R12-AD-small-beam-cantilever-cutoff-production';

export function buildSmallBeamCantileverCutoffMemberMutation({
  cantileverFact,
  built,
  memberLengthMm,
  memberPlanLengthMm = null,
  memberId = null,
} = {}) {
  const baselineBuilt = built || { paths: [], semanticMainBarCount: 0 };
  const baselinePaths = Array.isArray(baselineBuilt.paths) ? baselineBuilt.paths : [];
  if (!cantileverFact?.resolved || baselinePaths.length === 0) {
    return {
      applied: false,
      reason: cantileverFact?.reason || 'small-beam-cantilever-cutoff-source-unresolved',
      source: SOURCE,
      built: baselineBuilt,
      plan: null,
      mutation: null,
    };
  }

  const plan = buildSmallBeamCantileverCutoffMemberPathPlan({
    cantileverFact,
    memberPaths: baselinePaths,
    memberLengthMm,
    memberPlanLengthMm,
    memberId,
  });
  if (!plan.resolved) {
    return {
      applied: false,
      reason: plan.reason || 'small-beam-cantilever-cutoff-plan-unresolved',
      source: SOURCE,
      built: baselineBuilt,
      plan,
      mutation: null,
    };
  }

  if (plan.noSecondLayer === true) {
    return {
      applied: false,
      reason: null,
      source: SOURCE,
      built: baselineBuilt,
      plan,
      mutation: null,
    };
  }

  const mutation = applySmallBeamCantileverCutoffMemberPathPlan({
    memberPlan: plan,
    memberPaths: baselinePaths,
    memberLengthMm,
    memberId,
  });
  if (mutation.reason) {
    return {
      applied: false,
      reason: mutation.reason,
      source: SOURCE,
      built: baselineBuilt,
      plan,
      mutation,
    };
  }

  return {
    applied: mutation.applied,
    reason: null,
    source: SOURCE,
    built: { ...baselineBuilt, paths: mutation.paths },
    plan,
    mutation,
  };
}
