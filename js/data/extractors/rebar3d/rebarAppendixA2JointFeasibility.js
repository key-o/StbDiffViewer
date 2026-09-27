/**
 * @fileoverview 配筋指針2010 付録A A2の側柱・隅柱接合部 geometry feasibility。
 *
 * A2 p.276の「柱隅筋と梁コーナー筋が同一かぶり位置で干渉する場合は
 * 外側梁筋を柱筋1本分だけ内側へ納める」と、p.279の「直交筋間を通る
 * フック付定着は内法直径4d以上の挿入空間を確保し、1段で不足する場合は
 * 2段配筋等へ切り替える」を、actual bar factsに対する検査として実装する。
 *
 * このモジュールはgeometryを変更しない。成立可否・必要調整量・2段化候補だけを返す。
 */

import {
  barDiameterMm,
  barOuterDiameterMm,
  minBarClearanceMm,
} from '../../../constants/beamOpeningRules.js';
import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

const EPS = 1e-8;
const DEFAULT_FACE_ALIGNMENT_TOLERANCE_MM = 2;
const DEFAULT_COLLISION_TOLERANCE_MM = 0.5;
const A2_SIDE_INSET_RULE = rebarRuleTraceMetadata('APPENDIX-A2-SIDE-JOINT-OUTER-BAR-INSET');
const A2_CORNER_HOOK_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-HOOK-INSIDE-DIA-4D');
const A2_CORNER_LAYER_RULE = rebarRuleTraceMetadata('APPENDIX-A2-CORNER-LAYER-ESCALATION');

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function nominalDiameter(bar) {
  const explicit = positive(bar?.dia);
  if (explicit !== null) return explicit;
  const resolved = barDiameterMm(bar?.diaName, NaN);
  return positive(resolved);
}

function outerDiameter(bar) {
  const nominal = nominalDiameter(bar);
  const resolved = barOuterDiameterMm(bar?.diaName, nominal ?? NaN);
  return positive(resolved);
}

function normalizeBar(bar) {
  const u = finite(bar?.u);
  const nominalMm = nominalDiameter(bar);
  const outerMm = outerDiameter(bar);
  if (u === null || nominalMm === null || outerMm === null) return null;
  return {
    bar,
    u,
    nominalMm,
    outerMm,
    role: String(bar?.role || '').toLowerCase(),
    layer: Number(bar?.layer) || 1,
  };
}

function firstLayerLine(positionFact, role) {
  const bars = (positionFact?.mainBars || [])
    .map(normalizeBar)
    .filter((item) => item && item.layer === 1 && item.role === String(role || '').toLowerCase())
    .sort((a, b) => a.u - b.u);
  return bars;
}

function selectEndpointPositionFact(layout, endpoint) {
  const facts = layout?.positionFacts || {};
  const preferred =
    endpoint === 'start'
      ? ['LEFT', 'START', 'SAME', 'CENTER', 'RIGHT', 'END']
      : ['RIGHT', 'END', 'SAME', 'CENTER', 'LEFT', 'START'];
  for (const key of preferred) {
    if (facts[key]) return { key, fact: facts[key] };
  }
  const first = Object.entries(facts)[0];
  return first ? { key: first[0], fact: first[1] } : null;
}

function crossUnit(beamFact) {
  const ux = finite(beamFact?.unit?.x);
  const uy = finite(beamFact?.unit?.y);
  if (ux === null || uy === null) return null;
  const length = Math.hypot(ux, uy);
  if (!(length > EPS)) return null;
  return { x: -uy / length, y: ux / length };
}

function projectPoint(point, axis) {
  const x = finite(point?.x) ?? 0;
  const y = finite(point?.y) ?? 0;
  return x * axis.x + y * axis.y;
}

function projectColumnBar(columnGeometry, bar, axis) {
  return (
    projectPoint(columnGeometry.centerOffsetAtNode, axis) +
    Number(bar.u || 0) * axis.x +
    Number(bar.v || 0) * axis.y
  );
}

function columnCrossHalfExtent(columnGeometry, beamAxis) {
  if (beamAxis === 'X') return positive(columnGeometry?.heightMm) / 2;
  if (beamAxis === 'Y') return positive(columnGeometry?.widthMm) / 2;
  return null;
}

function columnCornerBars(columnGeometry) {
  return (columnGeometry?.bars || [])
    .map((bar) => {
      const normalized = normalizeBar(bar);
      if (!normalized) return null;
      return {
        ...normalized,
        corner: bar?.corner === true || String(bar?.topologyRole || '').toUpperCase() === 'CORNER',
        v: finite(bar?.v),
      };
    })
    .filter((item) => item?.corner && item.v !== null);
}

function uniqueCrossBars(line) {
  const result = [];
  for (const item of line || []) {
    const previous = result.at(-1);
    if (
      previous &&
      Math.abs(previous.u - item.u) <= 1e-6 &&
      Math.abs(previous.outerMm - item.outerMm) <= 1e-6
    ) {
      continue;
    }
    result.push(item);
  }
  return result;
}

function inwardNeighbor(line, sideSign) {
  const unique = uniqueCrossBars(line);
  if (unique.length < 2) return { outer: unique[0] || null, next: null };
  if (sideSign > 0) {
    return { outer: unique.at(-1), next: unique.at(-2) };
  }
  return { outer: unique[0], next: unique[1] };
}

function evaluateLineInset({
  line,
  sideSign,
  beamCenterCross,
  columnCornerProjection,
  columnCornerOuterMm,
  collisionToleranceMm,
}) {
  const { outer, next } = inwardNeighbor(line, sideSign);
  if (!outer) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-side-beam-first-layer-bar-missing',
    };
  }

  const beamCenter = beamCenterCross + outer.u;
  const centerDistanceMm = Math.abs(beamCenter - columnCornerProjection);
  const currentClearMm = centerDistanceMm - (outer.outerMm + columnCornerOuterMm) / 2;
  const collision = currentClearMm < collisionToleranceMm;
  const overlapOrToleranceMm = Math.max(0, collisionToleranceMm - currentClearMm);
  const requiredInsetMm = collision ? Math.max(columnCornerOuterMm, overlapOrToleranceMm) : 0;

  let postShiftClearToNextMm = null;
  let minimumMainBarClearMm = null;
  let oneLayerFeasible = true;
  if (collision && next) {
    const shiftedOuterCenter = beamCenter - sideSign * requiredInsetMm;
    const nextCenter = beamCenterCross + next.u;
    postShiftClearToNextMm =
      Math.abs(nextCenter - shiftedOuterCenter) - (outer.outerMm + next.outerMm) / 2;
    minimumMainBarClearMm = minBarClearanceMm(Math.max(outer.nominalMm, next.nominalMm), {
      maxAggregateSizeMm: 25,
    });
    oneLayerFeasible = postShiftClearToNextMm + EPS >= minimumMainBarClearMm;
  }

  return {
    ok: true,
    status: collision
      ? oneLayerFeasible
        ? 'ADJUSTMENT_REQUIRED'
        : 'LAYER_ESCALATION_REQUIRED'
      : 'PASS',
    reason: collision
      ? oneLayerFeasible
        ? 'appendix-a2-side-outer-bar-inset-required'
        : 'appendix-a2-side-outer-bar-inset-congests-one-layer'
      : null,
    currentClearMm,
    requiredInsetMm,
    columnCornerOuterMm,
    beamOuterBarOuterMm: outer.outerMm,
    postShiftClearToNextMm,
    minimumMainBarClearMm,
    oneLayerFeasible,
  };
}

/**
 * 側柱/隅柱で梁外面と柱外面が同一面となる側について、
 * 梁コーナー筋と柱隅筋のplan collisionをactual bar factsから検査する。
 */
export function evaluateAppendixA2SideOuterBarInset({
  beamFact,
  beamLayout,
  columnGeometry,
  faceAlignmentToleranceMm = DEFAULT_FACE_ALIGNMENT_TOLERANCE_MM,
  collisionToleranceMm = DEFAULT_COLLISION_TOLERANCE_MM,
} = {}) {
  if (!beamFact || !beamLayout || !columnGeometry) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-side-geometry-input-missing',
      appliedRules: [A2_SIDE_INSET_RULE],
    };
  }
  if (columnGeometry.shape !== 'RECTANGLE' || columnGeometry.rotationResolved !== true) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-side-column-geometry-axis-unresolved',
      appliedRules: [A2_SIDE_INSET_RULE],
    };
  }

  const selected = selectEndpointPositionFact(beamLayout, beamFact.endpoint);
  const widthMm = positive(selected?.fact?.widthMm);
  const cross = crossUnit(beamFact);
  const columnHalf = columnCrossHalfExtent(columnGeometry, beamFact.axis);
  if (!selected?.fact || widthMm === null || !cross || !(columnHalf > 0)) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-side-section-geometry-unresolved',
      appliedRules: [A2_SIDE_INSET_RULE],
    };
  }
  if ((selected.fact.unresolved || []).length > 0) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-side-beam-layout-unresolved',
      unresolved: selected.fact.unresolved,
      appliedRules: [A2_SIDE_INSET_RULE],
    };
  }

  const beamCenterCross = projectPoint(beamFact.centerOffsetAtNode, cross);
  const columnCenterCross = projectPoint(columnGeometry.centerOffsetAtNode, cross);
  const cornerBars = columnCornerBars(columnGeometry);
  if (cornerBars.length === 0) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-side-column-corner-bars-unresolved',
      appliedRules: [A2_SIDE_INSET_RULE],
    };
  }

  const checks = [];
  for (const sideSign of [-1, 1]) {
    const beamFace = beamCenterCross + (sideSign * widthMm) / 2;
    const columnFace = columnCenterCross + sideSign * columnHalf;
    const faceDifferenceMm = Math.abs(beamFace - columnFace);
    if (faceDifferenceMm > faceAlignmentToleranceMm) continue;

    const projectedCorners = cornerBars.map((bar) => ({
      ...bar,
      projection: projectColumnBar(columnGeometry, bar.bar, cross),
    }));
    const targetCorner = projectedCorners.reduce((best, candidate) => {
      if (!best) return candidate;
      return sideSign > 0
        ? candidate.projection > best.projection
          ? candidate
          : best
        : candidate.projection < best.projection
          ? candidate
          : best;
    }, null);

    for (const role of ['top', 'bottom']) {
      const line = firstLayerLine(selected.fact, role);
      if (line.length === 0) continue;
      checks.push({
        side: sideSign > 0 ? 'POSITIVE' : 'NEGATIVE',
        role: role.toUpperCase(),
        faceDifferenceMm,
        ...evaluateLineInset({
          line,
          sideSign,
          beamCenterCross,
          columnCornerProjection: targetCorner.projection,
          columnCornerOuterMm: targetCorner.outerMm,
          collisionToleranceMm,
        }),
      });
    }
  }

  if (checks.length === 0) {
    return {
      ok: true,
      status: 'NOT_APPLICABLE',
      reason: 'appendix-a2-side-column-beam-outer-face-not-aligned',
      sectionPosition: selected.key,
      checks: [],
      appliedRules: [A2_SIDE_INSET_RULE],
    };
  }

  const statuses = new Set(checks.map((check) => check.status));
  const status = statuses.has('UNRESOLVED')
    ? 'UNRESOLVED'
    : statuses.has('LAYER_ESCALATION_REQUIRED')
      ? 'LAYER_ESCALATION_REQUIRED'
      : statuses.has('ADJUSTMENT_REQUIRED')
        ? 'ADJUSTMENT_REQUIRED'
        : 'PASS';

  return {
    ok: status !== 'UNRESOLVED',
    status,
    reason:
      status === 'PASS'
        ? null
        : status === 'ADJUSTMENT_REQUIRED'
          ? 'appendix-a2-side-outer-bar-inset-required'
          : status === 'LAYER_ESCALATION_REQUIRED'
            ? 'appendix-a2-side-one-layer-congestion'
            : 'appendix-a2-side-geometry-unresolved',
    sectionPosition: selected.key,
    checks,
    geometryEstimated: beamLayout.estimated === true || columnGeometry.estimated === true,
    appliedRules: [A2_SIDE_INSET_RULE],
  };
}

function clearGaps(line) {
  const bars = uniqueCrossBars(line);
  const gaps = [];
  for (let index = 0; index < bars.length - 1; index += 1) {
    const left = bars[index];
    const right = bars[index + 1];
    gaps.push({
      leftIndex: index,
      rightIndex: index + 1,
      clearMm: right.u - left.u - (left.outerMm + right.outerMm) / 2,
    });
  }
  return { bars, gaps };
}

function maxClearGap(line) {
  const built = clearGaps(line);
  const max = built.gaps.reduce(
    (best, gap) => (!best || gap.clearMm > best.clearMm ? gap : best),
    null,
  );
  return { ...built, max };
}

function twoLayerEscalationCandidate(line, requiredClearMm) {
  const bars = uniqueCrossBars(line);
  if (bars.length <= 2) return null;

  let best = null;
  for (let movedIndex = 1; movedIndex < bars.length - 1; movedIndex += 1) {
    const remaining = bars.filter((_, index) => index !== movedIndex);
    const { max } = maxClearGap(remaining);
    if (!max || max.clearMm + EPS < requiredClearMm) continue;
    const candidate = {
      movedIndex,
      movedBarDia: bars[movedIndex].bar?.diaName || null,
      firstLayerCount: remaining.length,
      secondLayerMovedCount: 1,
      availableClearMm: max.clearMm,
      marginMm: max.clearMm - requiredClearMm,
    };
    if (!best || candidate.marginMm > best.marginMm) best = candidate;
  }
  return best;
}

function maximumNominalDiameter(line) {
  return (line || []).reduce((max, bar) => Math.max(max, positive(bar?.nominalMm) || 0), 0);
}

/**
 * 隅柱梁接合部で後組み梁のフック曲げ部が、先組み（受入れ側）梁主筋の
 * 間を通過できるかをactual first-layer bar positionsから検査する。
 */
export function evaluateAppendixA2CornerHookInsertion({
  receivingBeamFact,
  receivingBeamLayout,
  incomingBeamFact,
  incomingBeamLayout,
  hookInsideDiameterFactor = 4,
} = {}) {
  const receiving = selectEndpointPositionFact(receivingBeamLayout, receivingBeamFact?.endpoint);
  const incoming = selectEndpointPositionFact(incomingBeamLayout, incomingBeamFact?.endpoint);
  if (!receiving?.fact || !incoming?.fact) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-corner-beam-layout-missing',
      appliedRules: [A2_CORNER_HOOK_RULE, A2_CORNER_LAYER_RULE],
    };
  }
  if ((receiving.fact.unresolved || []).length > 0 || (incoming.fact.unresolved || []).length > 0) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-corner-beam-layout-unresolved',
      receivingUnresolved: receiving.fact.unresolved || [],
      incomingUnresolved: incoming.fact.unresolved || [],
      appliedRules: [A2_CORNER_HOOK_RULE, A2_CORNER_LAYER_RULE],
    };
  }

  const factor = positive(hookInsideDiameterFactor);
  if (factor === null) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-corner-hook-inside-diameter-factor-unresolved',
      appliedRules: [A2_CORNER_HOOK_RULE, A2_CORNER_LAYER_RULE],
    };
  }

  const checks = [];
  for (const role of ['top', 'bottom']) {
    const receivingLine = firstLayerLine(receiving.fact, role);
    const incomingLine = firstLayerLine(incoming.fact, role);
    if (receivingLine.length < 2 || incomingLine.length === 0) continue;

    const hookDiaMm = maximumNominalDiameter(incomingLine);
    if (!(hookDiaMm > 0)) continue;
    const requiredClearMm = factor * hookDiaMm;
    const current = maxClearGap(receivingLine);
    const currentClearMm = current.max?.clearMm ?? null;
    const oneLayerFeasible = currentClearMm !== null && currentClearMm + EPS >= requiredClearMm;
    const escalation = oneLayerFeasible
      ? null
      : twoLayerEscalationCandidate(receivingLine, requiredClearMm);

    checks.push({
      role: role.toUpperCase(),
      receivingFirstLayerCount: current.bars.length,
      incomingHookBarDiaMm: hookDiaMm,
      requiredClearMm,
      currentMaxClearMm: currentClearMm,
      oneLayerFeasible,
      twoLayerEscalationCandidate: escalation,
      status: oneLayerFeasible
        ? 'PASS'
        : escalation
          ? 'TWO_LAYER_CANDIDATE'
          : 'ALTERNATIVE_DETAIL_REQUIRED',
    });
  }

  if (checks.length === 0) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-corner-first-layer-bars-unresolved',
      appliedRules: [A2_CORNER_HOOK_RULE, A2_CORNER_LAYER_RULE],
    };
  }

  const statuses = new Set(checks.map((check) => check.status));
  const status = statuses.has('ALTERNATIVE_DETAIL_REQUIRED')
    ? 'ALTERNATIVE_DETAIL_REQUIRED'
    : statuses.has('TWO_LAYER_CANDIDATE')
      ? 'TWO_LAYER_CANDIDATE'
      : 'PASS';

  return {
    ok: true,
    status,
    reason:
      status === 'PASS'
        ? null
        : status === 'TWO_LAYER_CANDIDATE'
          ? 'appendix-a2-corner-one-layer-insufficient-two-layer-candidate'
          : 'appendix-a2-corner-hook-insertion-space-insufficient',
    receivingAxis: receivingBeamFact?.axis || null,
    incomingAxis: incomingBeamFact?.axis || null,
    receivingSectionPosition: receiving.key,
    incomingSectionPosition: incoming.key,
    hookInsideDiameterFactor: factor,
    checks,
    geometryEstimated:
      receivingBeamLayout?.estimated === true || incomingBeamLayout?.estimated === true,
    appliedRules: [A2_CORNER_HOOK_RULE, A2_CORNER_LAYER_RULE],
  };
}

/**
 * joint-level geometry checkをまとめる。
 * side/corner ruleの検査のみで、RebarPath自体は変更しない。
 */
export function evaluateAppendixA2JointGeometryFeasibility({
  topology,
  firstAxis,
  secondAxis,
  beamGeometryFacts = [],
  columnGeometry = null,
} = {}) {
  if (!topology?.kind || !['SIDE', 'CORNER'].includes(topology.kind)) {
    return {
      ok: true,
      status: 'NOT_APPLICABLE',
      reason: null,
      sideChecks: [],
      cornerHookInsertion: null,
      geometryApplication: 'CHECK_CONNECTED',
      appliedRules: [],
    };
  }
  if (!columnGeometry) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'appendix-a2-column-geometry-unavailable',
      sideChecks: [],
      cornerHookInsertion: null,
      geometryApplication: 'CHECK_UNRESOLVED',
      appliedRules: [A2_SIDE_INSET_RULE],
    };
  }

  const sideChecks = beamGeometryFacts
    .filter((item) => item?.fact && item?.layout)
    .map((item) =>
      evaluateAppendixA2SideOuterBarInset({
        beamFact: item.fact,
        beamLayout: item.layout,
        columnGeometry,
      }),
    );

  let cornerHookInsertion = null;
  if (topology.kind === 'CORNER') {
    const receiving = beamGeometryFacts.find((item) => item?.fact?.axis === firstAxis);
    const incoming = beamGeometryFacts.find((item) => item?.fact?.axis === secondAxis);
    if (!receiving || !incoming || !firstAxis || !secondAxis) {
      cornerHookInsertion = {
        ok: false,
        status: 'UNRESOLVED',
        reason: 'appendix-a2-corner-assembly-order-or-beam-geometry-unresolved',
        appliedRules: [A2_CORNER_HOOK_RULE, A2_CORNER_LAYER_RULE],
      };
    } else {
      cornerHookInsertion = evaluateAppendixA2CornerHookInsertion({
        receivingBeamFact: receiving.fact,
        receivingBeamLayout: receiving.layout,
        incomingBeamFact: incoming.fact,
        incomingBeamLayout: incoming.layout,
      });
    }
  }

  const statuses = [...sideChecks.map((check) => check.status), cornerHookInsertion?.status].filter(
    Boolean,
  );
  const unresolved = statuses.includes('UNRESOLVED');
  const actionRequired = statuses.some((status) =>
    [
      'ADJUSTMENT_REQUIRED',
      'LAYER_ESCALATION_REQUIRED',
      'TWO_LAYER_CANDIDATE',
      'ALTERNATIVE_DETAIL_REQUIRED',
    ].includes(status),
  );

  return {
    ok: !unresolved,
    status: unresolved ? 'UNRESOLVED' : actionRequired ? 'ACTION_REQUIRED' : 'PASS',
    reason: unresolved
      ? 'appendix-a2-joint-geometry-feasibility-unresolved'
      : actionRequired
        ? 'appendix-a2-joint-geometry-adjustment-required'
        : null,
    sideChecks,
    cornerHookInsertion,
    geometryApplication: unresolved ? 'CHECK_UNRESOLVED' : 'CHECK_CONNECTED',
    appliedRules: [
      A2_SIDE_INSET_RULE,
      ...(topology.kind === 'CORNER' ? [A2_CORNER_HOOK_RULE, A2_CORNER_LAYER_RULE] : []),
    ],
  };
}
