/**
 * @fileoverview R12-Z / R12-AD production orchestration for one small-beam member.
 *
 * 一般小梁はR12-ZA span facts -> R12-ZB identity plan -> R12-ZC atomic path mutationを、
 * 片持ち小梁はR12-AA facts -> R12-AB identity plan -> R12-AC atomic path mutationを
 * 1 member単位で接続する。plan/mutation不成立時はbuilt.pathsを変更しない。
 */
import { buildSmallBeamCutoffMemberPathPlan } from './smallBeamCutoffPathPlan.js';
import { applySmallBeamCutoffMemberPathPlan } from './smallBeamCutoffPathMutation.js';
import { buildSmallBeamCantileverCutoffMemberMutation } from './smallBeamCantileverCutoffProduction.js';

const SOURCE = 'R12-Z-small-beam-cutoff-production';
const PLANAR_LENGTH_TOLERANCE_MM = 1e-5;

export function buildSmallBeamCutoffMemberMutation({
  spanFact,
  built,
  memberLengthMm,
  memberPlanLengthMm = null,
  memberId = null,
} = {}) {
  if (spanFact?.ruleSection === '9-3(3)') {
    return buildSmallBeamCantileverCutoffMemberMutation({
      cantileverFact: spanFact,
      built,
      memberLengthMm,
      memberPlanLengthMm,
      memberId,
    });
  }

  const baselineBuilt = built || { paths: [], semanticMainBarCount: 0 };
  const baselinePaths = Array.isArray(baselineBuilt.paths) ? baselineBuilt.paths : [];
  if (!spanFact?.resolved || baselinePaths.length === 0) {
    return {
      applied: false,
      reason: spanFact?.reason || 'small-beam-cutoff-production-source-unresolved',
      source: SOURCE,
      built: baselineBuilt,
      plan: null,
      mutation: null,
    };
  }

  const memberLength = Number(memberLengthMm);
  const hasPlanLength = memberPlanLengthMm !== null && memberPlanLengthMm !== undefined;
  const memberPlanLength = Number(memberPlanLengthMm);
  if (!(memberLength > 0)) {
    return {
      applied: false,
      reason: 'small-beam-cutoff-member-length-unresolved',
      source: SOURCE,
      built: baselineBuilt,
      plan: null,
      mutation: null,
    };
  }
  if (hasPlanLength && !(memberPlanLength > 0)) {
    return {
      applied: false,
      reason: 'small-beam-cutoff-member-plan-length-unresolved',
      source: SOURCE,
      built: baselineBuilt,
      plan: null,
      mutation: null,
    };
  }
  if (hasPlanLength && Math.abs(memberLength - memberPlanLength) > PLANAR_LENGTH_TOLERANCE_MM) {
    return {
      applied: false,
      reason: 'small-beam-cutoff-sloped-member-unsupported',
      source: SOURCE,
      built: baselineBuilt,
      plan: null,
      mutation: null,
      memberLengthMm: memberLength,
      memberPlanLengthMm: memberPlanLength,
    };
  }

  const plan = buildSmallBeamCutoffMemberPathPlan({
    spanFact,
    memberPaths: baselinePaths,
    memberLengthMm: memberLength,
    memberId,
  });
  if (!plan.resolved) {
    return {
      applied: false,
      reason: plan.reason || 'small-beam-cutoff-production-plan-unresolved',
      source: SOURCE,
      built: baselineBuilt,
      plan,
      mutation: null,
    };
  }

  const mutation = applySmallBeamCutoffMemberPathPlan({
    memberPlan: plan,
    memberPaths: baselinePaths,
    memberLengthMm: memberLength,
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
