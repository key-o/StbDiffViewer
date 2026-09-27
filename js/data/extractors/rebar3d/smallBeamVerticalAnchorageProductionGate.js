/**
 * @fileoverview R12-V 一般小梁 VERTICAL_90 のproduction gate。
 *
 * requirement/candidate/mode/path plan/actual arc/main-bar continuity/identityがすべて成立した
 * barだけを3D generatorへ渡せる中心線candidateとする。ここではworld変換・mesh生成は行わない。
 */

import { getCenterlineLength, getPathStart, validateRebarPath } from './rebarPath.js';

const TOLERANCE_MM = 1e-6;
const ANGLE_TOLERANCE_RAD = 1e-9;
const SOURCE = 'R12-small-beam-vertical-90-production-gate';
const GROUP_SOURCE = 'R12-small-beam-group-vertical-90-production-gate';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    productionReady: false,
    productionGateReady: false,
    generationStatus: 'UNRESOLVED',
    productionPathCandidate: false,
    productionConsumer: null,
    reason,
    source: SOURCE,
    productionPath: null,
    ...extra,
  };
}

function unresolvedGroup(reason, extra = {}) {
  return {
    resolved: false,
    productionReady: false,
    productionGateReady: false,
    generationStatus: 'UNRESOLVED',
    productionPathCandidate: false,
    productionConsumer: null,
    reason,
    source: GROUP_SOURCE,
    barGates: [],
    ...extra,
  };
}

function closeEnough(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TOLERANCE_MM;
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function validateSourceAlignment({
  pathPlan,
  actualPathFact,
  continuityFact,
  identityFact,
  barIndex,
}) {
  const expectedAnchor = pathPlan?.anchor;
  const sourceAnchors = {
    pathPlanAnchor: expectedAnchor ?? null,
    actualPathAnchor: actualPathFact?.anchor ?? null,
    continuitySide: continuityFact?.side ?? null,
    identitySide: identityFact?.side ?? null,
  };
  if (
    !['start', 'end'].includes(expectedAnchor) ||
    actualPathFact?.anchor !== expectedAnchor ||
    continuityFact?.side !== expectedAnchor ||
    identityFact?.side !== expectedAnchor
  ) {
    return { ok: false, sourceAnchors };
  }

  if (Number.isInteger(barIndex)) {
    const sourceBarIndexes = {
      expectedBarIndex: barIndex,
      pathPlanBarIndex: pathPlan?.barIndex ?? null,
      actualPathBarIndex: actualPathFact?.barIndex ?? null,
      continuityBarIndex: continuityFact?.barIndex ?? null,
      identityBarIndex: identityFact?.barIndex ?? null,
    };
    if (
      pathPlan?.barIndex !== barIndex ||
      actualPathFact?.barIndex !== barIndex ||
      continuityFact?.barIndex !== barIndex ||
      identityFact?.barIndex !== barIndex
    ) {
      return { ok: false, sourceAnchors, sourceBarIndexes };
    }
  }

  return { ok: true, sourceAnchors };
}

/** 1本のidentity-bound actual pathをproduction centerline candidateへ昇格する。 */
export function resolveSmallBeamVertical90BarProductionGate({
  bar,
  pathPlan,
  actualPathFact,
  continuityFact,
  identityFact,
  barIndex = null,
} = {}) {
  if (!pathPlan?.resolved || pathPlan.pathPlanReady !== true) {
    return unresolved(pathPlan?.reason || 'small-beam-vertical-90-path-plan-not-ready');
  }
  if (!actualPathFact?.resolved || actualPathFact.actualPathReady !== true) {
    return unresolved(actualPathFact?.reason || 'small-beam-vertical-90-actual-path-not-ready');
  }
  if (!continuityFact?.resolved || continuityFact.continuityReady !== true) {
    return unresolved(continuityFact?.reason || 'small-beam-vertical-90-continuity-not-ready');
  }
  if (!identityFact?.resolved || identityFact.identityReady !== true || !identityFact.boundPath) {
    return unresolved(identityFact?.reason || 'small-beam-vertical-90-identity-not-ready');
  }

  const alignment = validateSourceAlignment({
    pathPlan,
    actualPathFact,
    continuityFact,
    identityFact,
    barIndex,
  });
  if (!alignment.ok) {
    return unresolved('small-beam-vertical-90-production-source-alignment-mismatch', alignment);
  }

  const identityKey = identityFact.identityKey;
  const barIdentityKey = bar?.identityKey;
  if (
    typeof identityKey !== 'string' ||
    identityKey.trim() === '' ||
    typeof barIdentityKey !== 'string' ||
    barIdentityKey.trim() === '' ||
    bar?.unresolvedMatch === true ||
    bar?.identityStatus === 'unresolved'
  ) {
    return unresolved('small-beam-vertical-90-production-identity-key-unresolved', {
      barIdentityKey:
        typeof barIdentityKey === 'string' && barIdentityKey.trim() !== '' ? barIdentityKey : null,
      identityFactKey:
        typeof identityKey === 'string' && identityKey.trim() !== '' ? identityKey : null,
      barIdentityStatus: bar?.identityStatus || null,
      barUnresolvedMatch: bar?.unresolvedMatch === true,
    });
  }

  const productionPath = identityFact.boundPath;
  const validation = validateRebarPath(productionPath);
  if (!validation.ok) {
    return unresolved('small-beam-vertical-90-production-path-invalid', { validation });
  }
  if (
    productionPath.metadata?.coordinateSpace !== 'anchor-local' ||
    productionPath.metadata?.anchor !== pathPlan.anchor ||
    productionPath.metadata?.bendGeometry !== 'actual-arc' ||
    productionPath.metadata?.anchorageMode !== 'VERTICAL_90'
  ) {
    return unresolved('small-beam-vertical-90-production-path-metadata-mismatch', {
      plannedAnchor: pathPlan.anchor ?? null,
      pathMetadata: productionPath.metadata || null,
    });
  }

  const productionDiaMm = Number(productionPath.metadata?.dia);
  const barDiaMm = Number(bar?.dia);
  const productionGrade = gradeKey(productionPath.metadata?.grade);
  const barGrade = gradeKey(bar?.grade);
  if (
    !closeEnough(productionDiaMm, barDiaMm) ||
    !productionGrade ||
    productionGrade !== barGrade ||
    productionPath.metadata?.role !== 'top'
  ) {
    return unresolved('small-beam-vertical-90-production-bar-metadata-mismatch', {
      productionDiaMm: Number.isFinite(productionDiaMm) ? productionDiaMm : null,
      expectedDiaMm: Number.isFinite(barDiaMm) ? barDiaMm : null,
      productionGrade: productionGrade || null,
      expectedGrade: barGrade || null,
      productionRole: productionPath.metadata?.role || null,
    });
  }

  const arcs = productionPath.primitives.filter((primitive) => primitive?.type === 'arc');
  const sweepAngleRad = Number(arcs[0]?.sweepAngleRad);
  if (
    arcs.length !== 1 ||
    !closeEnough(arcs[0]?.radius, pathPlan.centerlineRadiusMm) ||
    !Number.isFinite(sweepAngleRad) ||
    Math.abs(sweepAngleRad - Math.PI / 2) > ANGLE_TOLERANCE_RAD
  ) {
    return unresolved('small-beam-vertical-90-production-arc-mismatch', {
      arcCount: arcs.length,
      arcRadiusMm: arcs[0]?.radius ?? null,
      plannedRadiusMm: pathPlan.centerlineRadiusMm ?? null,
      sweepAngleRad: Number.isFinite(sweepAngleRad) ? sweepAngleRad : null,
      expectedSweepAngleRad: Math.PI / 2,
    });
  }

  const start = getPathStart(productionPath);
  if (
    !closeEnough(start?.x, bar?.u) ||
    !closeEnough(start?.y, bar?.v) ||
    !closeEnough(start?.z, 0)
  ) {
    return unresolved('small-beam-vertical-90-production-member-end-mismatch', {
      productionPathStart: start,
      expectedU: Number(bar?.u),
      expectedV: Number(bar?.v),
    });
  }

  if (
    barIdentityKey !== identityKey ||
    productionPath.metadata?.identityKey !== identityKey ||
    continuityFact.memberPath?.metadata?.identityKey !== identityKey
  ) {
    return unresolved('small-beam-vertical-90-production-identity-mismatch', {
      barIdentityKey,
      productionIdentityKey: productionPath.metadata?.identityKey || null,
      memberIdentityKey: continuityFact.memberPath?.metadata?.identityKey || null,
      expectedIdentityKey: identityKey,
    });
  }

  const productionCenterlineFromMemberEndMm = getCenterlineLength(productionPath);
  const actualCenterlineFromMemberEndMm = Number(actualPathFact.pathCenterlineFromMemberEndMm);
  const actualTotalFromNearMm = Number(actualPathFact.actualTotalFromNearMm);
  const selectedTotalFromNearMm = Number(pathPlan.selectedTotalFromNearMm);
  if (
    !closeEnough(productionCenterlineFromMemberEndMm, actualCenterlineFromMemberEndMm) ||
    !closeEnough(actualTotalFromNearMm, selectedTotalFromNearMm)
  ) {
    return unresolved('small-beam-vertical-90-production-centerline-length-mismatch', {
      productionCenterlineFromMemberEndMm,
      actualCenterlineFromMemberEndMm: Number.isFinite(actualCenterlineFromMemberEndMm)
        ? actualCenterlineFromMemberEndMm
        : null,
      actualTotalFromNearMm: Number.isFinite(actualTotalFromNearMm) ? actualTotalFromNearMm : null,
      selectedTotalFromNearMm: Number.isFinite(selectedTotalFromNearMm)
        ? selectedTotalFromNearMm
        : null,
    });
  }

  return {
    resolved: true,
    productionReady: true,
    productionGateReady: true,
    generationStatus: 'CENTERLINE_READY',
    productionPathCandidate: true,
    productionConsumer: 'beam-anchor-local-path',
    renderReady: false,
    reason: null,
    source: SOURCE,
    mode: 'VERTICAL_90',
    side: pathPlan.anchor,
    barIndex: Number.isInteger(barIndex) ? barIndex : null,
    identityKey,
    productionPath,
    validation,
    pathCenterlineFromMemberEndMm: productionCenterlineFromMemberEndMm,
    actualTotalFromNearMm,
    selectedTotalFromNearMm,
  };
}

export function resolveSmallBeamGroupVertical90ProductionGate(group) {
  if (group?.role !== 'top') return null;
  const mode = group.anchorageMode;
  if (!mode?.resolved)
    return unresolvedGroup(mode?.reason || 'small-beam-anchorage-mode-unresolved');
  if (mode.mode !== 'VERTICAL_90') {
    return {
      resolved: true,
      productionReady: false,
      productionGateReady: false,
      generationStatus: 'NOT_APPLICABLE',
      productionPathCandidate: false,
      productionConsumer: null,
      renderReady: false,
      applicable: false,
      reason: 'vertical-90-mode-not-selected',
      source: GROUP_SOURCE,
      barGates: [],
    };
  }

  const bars = Array.isArray(group.bars) ? group.bars : [];
  const pathPlans = group.vertical90PathPlan?.barPlans;
  const actualPaths = group.vertical90ActualPath?.barPaths;
  const continuities = group.vertical90Continuity?.barContinuities;
  const identities = group.vertical90Identity?.barIdentities;
  if (
    !Array.isArray(pathPlans) ||
    !Array.isArray(actualPaths) ||
    !Array.isArray(continuities) ||
    !Array.isArray(identities) ||
    bars.length === 0
  ) {
    return unresolvedGroup('small-beam-vertical-90-production-source-facts-missing');
  }
  if (
    pathPlans.length !== bars.length ||
    actualPaths.length !== bars.length ||
    continuities.length !== bars.length ||
    identities.length !== bars.length
  ) {
    return unresolvedGroup('small-beam-vertical-90-production-source-count-mismatch', {
      barCount: bars.length,
      pathPlanCount: pathPlans.length,
      actualPathCount: actualPaths.length,
      continuityCount: continuities.length,
      identityCount: identities.length,
    });
  }

  const barGates = bars.map((bar, index) =>
    resolveSmallBeamVertical90BarProductionGate({
      bar,
      pathPlan: pathPlans[index],
      actualPathFact: actualPaths[index],
      continuityFact: continuities[index],
      identityFact: identities[index],
      barIndex: index,
    }),
  );
  const failed = barGates.filter((fact) => !fact.resolved || fact.productionReady !== true);
  if (failed.length > 0) {
    return unresolvedGroup(
      failed[0].reason || 'small-beam-vertical-90-production-gate-unresolved',
      {
        barGates,
        failedBarGates: failed,
      },
    );
  }

  const identityKeys = barGates.map((fact) => fact.identityKey);
  if (new Set(identityKeys).size !== identityKeys.length) {
    return unresolvedGroup('small-beam-vertical-90-production-identity-not-unique', {
      barGates,
      identityKeys,
    });
  }

  return {
    resolved: true,
    productionReady: true,
    productionGateReady: true,
    generationStatus: 'CENTERLINE_READY',
    productionPathCandidate: true,
    productionConsumer: 'beam-anchor-local-path',
    renderReady: false,
    applicable: true,
    reason: null,
    source: GROUP_SOURCE,
    barGates,
    failedBarGates: [],
    identityKeys,
    productionPaths: barGates.map((fact) => fact.productionPath),
  };
}

export function attachSmallBeamVertical90ProductionGateFacts(requirementFacts) {
  if (!requirementFacts?.beam) {
    return { ...(requirementFacts || {}), vertical90ProductionGateUnresolved: [] };
  }

  const vertical90ProductionGateUnresolved = [];
  for (const [elementId, beamFacts] of requirementFacts.beam) {
    for (const end of beamFacts?.ends || []) {
      if (end.status === 'FREE_END') continue;
      for (const group of end.requirements || []) {
        if (group.role !== 'top') continue;
        group.vertical90ProductionGate = resolveSmallBeamGroupVertical90ProductionGate(group);
        if (
          group.anchorageMode?.mode === 'VERTICAL_90' &&
          group.vertical90ProductionGate?.resolved === false
        ) {
          vertical90ProductionGateUnresolved.push({
            elementId,
            elementName: beamFacts.elementName,
            side: end.side,
            role: group.role,
            diaMm: group.diaMm,
            grade: group.grade,
            reason: group.vertical90ProductionGate.reason,
          });
        }
      }
    }
  }

  return {
    ...requirementFacts,
    vertical90ProductionGateUnresolved,
  };
}
