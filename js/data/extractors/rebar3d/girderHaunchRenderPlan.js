/**
 * @fileoverview R8-D: STB明示ハンチのコーナー主筋をproduction pathへ渡す計画。
 *
 * girderHaunchDetailing の要求factsと production gateを合成し、
 * STANDARD_WITH_STBでREADYとなったmember-local corner transitionだけを部材別に集約する。
 * EXPLICIT geometryはproject schemaが未確定のため、このadapterでは消費しない。
 */

import { buildGirderHaunchDetailingChecks } from './girderHaunchDetailing.js';
import {
  SPECIAL_DETAILING_GATE_STATUS,
  SPECIAL_DETAILING_PRODUCTION_MODE,
  attachSpecialDetailingProductionGate,
} from './specialDetailingProductionGate.js';

const POSITION_TOLERANCE_MM = 1e-6;

function transitionKey(spec) {
  return [
    spec.side,
    spec.role,
    spec.layer ?? '',
    spec.diaMm,
    String(spec.grade || '').toUpperCase(),
    spec.from.u,
    spec.from.v,
    spec.to.u,
    spec.to.v,
  ].join('|');
}

function addTransition(map, memberId, spec) {
  if (!memberId) return;
  const key = String(memberId);
  const list = map.get(key) || [];
  const identity = transitionKey(spec);
  if (!list.some((item) => item.__identity === identity)) {
    Object.defineProperty(spec, '__identity', { value: identity, enumerable: false });
    list.push(spec);
    map.set(key, list);
  }
}

function transitionSpecs(check) {
  const geometry = check?.haunchProductionGeometry;
  if (!geometry || !Array.isArray(geometry.cornerTransitions)) return [];
  return geometry.cornerTransitions.map((transition) => ({
    side: geometry.side,
    lengthMm: Number(geometry.lengthMm),
    endpointZone: geometry.endpointZone || null,
    targetZone: geometry.targetZone || 'CENTER',
    role: transition.role,
    layer: transition.layer ?? 1,
    diaMm: Number(transition.diaMm),
    grade: transition.grade || null,
    from: { u: Number(transition.from?.u), v: Number(transition.from?.v) },
    to: { u: Number(transition.to?.u), v: Number(transition.to?.v) },
    sourceCheck: check,
  }));
}

function normalizedGrade(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function localPosition(bar) {
  return bar?.localPosition || bar || {};
}

function trimMatchesTransition(trim, transition, side) {
  if (trim?.endpoint !== side) return false;
  const bar = trim?.bar;
  const position = localPosition(bar);
  const barLayer = bar?.layer;
  return (
    bar?.role === transition?.role &&
    (barLayer === null || barLayer === undefined || barLayer === '' || Number(barLayer) === 1) &&
    Number(bar?.dia) === Number(transition?.diaMm) &&
    normalizedGrade(bar?.grade) === normalizedGrade(transition?.grade) &&
    Number.isFinite(Number(position?.u)) &&
    Number.isFinite(Number(position?.v)) &&
    Math.abs(Number(position.u) - Number(transition?.from?.u)) <= POSITION_TOLERANCE_MM &&
    Math.abs(Number(position.v) - Number(transition?.from?.v)) <= POSITION_TOLERANCE_MM
  );
}

function endpointKey(check) {
  return `${String(check?.elementId || '')}|${String(check?.side || '')}`;
}

function hasR7TrimConflict(check, jointTransitionPlan) {
  const trims = jointTransitionPlan?.memberEndTrims?.get(String(check?.elementId || '')) || [];
  if (!trims.length) return false;
  const transitions = check?.haunchProductionGeometry?.cornerTransitions || [];
  return transitions.some((transition) =>
    trims.some((trim) => trimMatchesTransition(trim, transition, check.side)),
  );
}

function unresolvedCheck(check, blocker) {
  return {
    ...check,
    generationStatus: 'UNRESOLVED',
    productionGateStatus: SPECIAL_DETAILING_GATE_STATUS.UNRESOLVED,
    productionGateReady: false,
    productionGateBlockers: [...new Set([...(check.productionGateBlockers || []), blocker])],
    productionPathCandidate: false,
  };
}

/**
 * RC大梁ハンチのproduction計画を作る。
 * R7の仕口trimと同じ端部コーナー筋が競合する場合は、beam path builderへ渡す前に
 * 端部単位でUNRESOLVEDへ落とす。これにより判定UIも実描画と同じfail-closed状態を示す。
 * @returns {{checks:Array<Object>, memberTransitions:Map<string,Array<Object>>}}
 */
export function buildGirderHaunchRenderPlan(xmlDoc, girderLayouts, options = {}) {
  const rawChecks = buildGirderHaunchDetailingChecks(
    xmlDoc,
    girderLayouts,
    options.scanTag || null,
  );
  const gatedChecks = rawChecks.map((raw) =>
    attachSpecialDetailingProductionGate(raw, {
      commonConfig: options.commonConfig,
      projectDetailing: options.projectDetailing,
    }),
  );
  const memberTransitions = new Map();

  // R8の端部置換は原子的なので、同一端部のどれか1本がR7 trimと競合すれば
  // 同一端部の全checkをproduction候補から外す。
  const conflictedEndpoints = new Set();
  for (const check of gatedChecks) {
    if (
      check.productionGateStatus === SPECIAL_DETAILING_GATE_STATUS.READY &&
      check.productionGateMode === SPECIAL_DETAILING_PRODUCTION_MODE.STANDARD_WITH_STB &&
      hasR7TrimConflict(check, options.jointTransitionPlan)
    ) {
      conflictedEndpoints.add(endpointKey(check));
    }
  }

  const checks = gatedChecks.map((check) => {
    if (conflictedEndpoints.has(endpointKey(check))) {
      return unresolvedCheck(check, 'haunch-conflicts-with-r7-joint-trim');
    }

    if (
      check.productionGateStatus !== SPECIAL_DETAILING_GATE_STATUS.READY ||
      check.productionGateMode !== SPECIAL_DETAILING_PRODUCTION_MODE.STANDARD_WITH_STB
    ) {
      return check;
    }

    const specs = transitionSpecs(check);
    if (!specs.length) return unresolvedCheck(check, 'haunch-transition-specs-unresolved');

    for (const spec of specs) addTransition(memberTransitions, check.elementId, spec);
    return {
      ...check,
      productionPathCandidate: true,
    };
  });

  return { checks, memberTransitions };
}
