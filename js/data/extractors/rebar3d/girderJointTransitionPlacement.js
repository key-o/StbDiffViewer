/**
 * @fileoverview R7: 日建連・JSCA 2023 §8-3 大梁主筋の仕口対応。
 *
 * 同一直線の通し筋を最優先し、残筋はsemantic-firstで対応する。
 * 鉛直ずれは既存productionへ接続し、水平ずれは§8-3-2のe/jt候補を分類する。
 * Phase 5c-Aでは水平candidateをproductionへ接続せず、既存fail-closedを維持する。
 */

import { createTagScanner, extractColumnPlanDimensions } from '../columnSupportUtils.js';
import { rebarSemanticKey } from './rebarIdentityMatcher.js';
import {
  classifyGirderJointBarTopology,
  resolveGirderPriorityResidual,
} from './girderPriorityResolver.js';
import { resolveColumnRebarAvailableProjection } from './columnRebarClearProjection.js';
import {
  applyGirderContinuityOverride,
  resolveGirderContinuityOverrideAssignment,
} from './girderContinuityOverride.js';
import {
  girderEndpointBarFacts,
  projectGirderBarToJointFrame,
  resolveGirderEndpointGeometry,
  resolveOpposedGirderFrame,
} from './girderJointTransitionGeometry.js';

const GIRDER_BENT_MAX_RATIO = 1 / 6;
const EPS = 1e-6;
const OPPOSITE_TOLERANCE = 1e-6;
const STRAIGHT_TOLERANCE_MM = 1e-6;

function append(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function isRc(element) {
  const kind = String(element?.getAttribute?.('kind_structure') || '').toUpperCase();
  return !kind || kind === 'RC';
}

function endpointEntry(scanTag, element, layout, endpoint) {
  const nodeAttr = endpoint === 'start' ? 'id_node_start' : 'id_node_end';
  const nodeId = element.getAttribute(nodeAttr);
  if (!layout) {
    return {
      element,
      layout,
      endpoint,
      nodeId,
      geometry: null,
      bars: [],
      reason: 'girder-layout-unresolved',
    };
  }

  const geometry = resolveGirderEndpointGeometry(scanTag, element, layout, endpoint);
  if (!geometry) {
    return {
      element,
      layout,
      endpoint,
      nodeId,
      geometry: null,
      bars: [],
      reason: 'non-horizontal-girder-axis',
    };
  }

  const bars = girderEndpointBarFacts(element, layout, geometry);
  const hasInvalidPosition = bars.some(
    (bar) => !Object.values(bar.worldPosition || {}).every(Number.isFinite),
  );
  if (!bars.length || hasInvalidPosition) {
    return {
      element,
      layout,
      endpoint,
      nodeId,
      geometry,
      bars: [],
      reason: 'girder-endpoint-bars-unresolved',
    };
  }
  return { element, layout, endpoint, nodeId, geometry, bars, reason: null };
}

function collectGirderEndpoints(scanTag, layouts) {
  const byNode = new Map();
  for (const element of scanTag('StbGirder')) {
    if (!isRc(element)) continue;
    const layout = layouts?.get(String(element.getAttribute('id_section'))) || null;
    append(
      byNode,
      element.getAttribute('id_node_start'),
      endpointEntry(scanTag, element, layout, 'start'),
    );
    append(
      byNode,
      element.getAttribute('id_node_end'),
      endpointEntry(scanTag, element, layout, 'end'),
    );
  }
  return byNode;
}

function directionDot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function isOpposite(first, second) {
  return Boolean(resolveOpposedGirderFrame(first.geometry, second.geometry, OPPOSITE_TOLERANCE));
}

function entryKey(entry) {
  return `${entry.element.getAttribute('id')}:${entry.endpoint}`;
}

function pairEntriesAtNode(entries) {
  const valid = entries.filter((entry) => !entry.reason && entry.geometry);
  const invalid = entries.filter((entry) => entry.reason);
  if (invalid.length && entries.length > 1) {
    return {
      pairs: [],
      unresolvedReason: invalid.map((entry) => `${entryKey(entry)}:${entry.reason}`).join(';'),
    };
  }

  const candidates = new Map();
  for (const entry of valid) {
    candidates.set(
      entry,
      valid.filter((other) => other !== entry && isOpposite(entry, other)),
    );
  }
  if ([...candidates.values()].some((items) => items.length > 1)) {
    return { pairs: [], unresolvedReason: 'girder-opposite-pair-ambiguous' };
  }

  const pairs = [];
  const used = new Set();
  for (const entry of valid) {
    if (used.has(entry)) continue;
    const opposite = candidates.get(entry) || [];
    if (opposite.length !== 1) continue;
    const other = opposite[0];
    const reverse = candidates.get(other) || [];
    if (reverse.length !== 1 || reverse[0] !== entry) continue;

    const frame = resolveOpposedGirderFrame(entry.geometry, other.geometry, OPPOSITE_TOLERANCE);
    if (!frame) continue;
    const firstProjection = directionDot(entry.geometry.outwardPlanDirection, frame.axis);
    const left = firstProjection < 0 ? entry : other;
    const right = left === entry ? other : entry;
    pairs.push({ left, right, frame });
    used.add(entry);
    used.add(other);
  }
  return { pairs, unresolvedReason: null };
}

function sameSemantic(left, right) {
  return rebarSemanticKey(left) === rebarSemanticKey(right);
}

function sameWorldLine(left, right) {
  return (
    sameSemantic(left, right) &&
    Math.abs(left.jointTransverseMm - right.jointTransverseMm) <= STRAIGHT_TOLERANCE_MM &&
    Math.abs(left.jointElevationMm - right.jointElevationMm) <= STRAIGHT_TOLERANCE_MM
  );
}

function matchStraightFirst(leftBars, rightBars) {
  const left = leftBars.slice();
  const right = rightBars.slice();
  const matches = [];

  while (left.length && right.length) {
    const round = [];
    for (const leftBar of left) {
      const matchesRight = right.filter((rightBar) => sameWorldLine(leftBar, rightBar));
      if (matchesRight.length !== 1) continue;
      const rightBar = matchesRight[0];
      const matchesLeft = left.filter((candidate) => sameWorldLine(candidate, rightBar));
      if (matchesLeft.length !== 1 || matchesLeft[0] !== leftBar) continue;
      round.push({ left: leftBar, right: rightBar, matchBasis: 'world-straight-first' });
    }
    if (!round.length) break;
    for (const pair of round) {
      matches.push(pair);
      left.splice(left.indexOf(pair.left), 1);
      right.splice(right.indexOf(pair.right), 1);
    }
  }
  return { matches, left, right };
}

function matchingProjection(bar) {
  return {
    ...bar,
    u: bar.jointTransverseMm,
    v: bar.localPosition?.v,
    __jointBar: bar,
  };
}

/** §7-4と同様に、全体座標のSTRAIGHTを相対slotより先に確保する。 */
function matchGirderJointBars(leftBars, rightBars, options = {}) {
  // topologyはstraight-firstで筋が除去される前の全断面集合から確定する。
  // residualだけで再分類すると、元INTERMEDIATE筋をCORNERへ昇格させるため禁止する。
  const classifiedLeft = options.topologyClassified
    ? leftBars.slice()
    : classifyGirderJointBarTopology(leftBars);
  const classifiedRight = options.topologyClassified
    ? rightBars.slice()
    : classifyGirderJointBarTopology(rightBars);
  const straight = matchStraightFirst(classifiedLeft, classifiedRight);
  const projectedLeft = straight.left.map(matchingProjection);
  const projectedRight = straight.right.map(matchingProjection);
  const maxNormalizedDistance = Number.isFinite(Number(options.maxNormalizedDistance))
    ? Number(options.maxNormalizedDistance)
    : Number.MAX_SAFE_INTEGER;
  const residual = resolveGirderPriorityResidual(projectedLeft, projectedRight, {
    cornerPriority: options.cornerPriority === true,
    topologyFrameCompatible: options.topologyFrameCompatible !== false,
    topologyClassified: true,
    matcherOptions: {
      ...options,
      maxNormalizedDistance,
    },
  });

  const unwrap = (bar) => {
    if (!bar) return bar;
    const { __jointBar } = bar;
    if (!__jointBar) return bar;
    return {
      ...__jointBar,
      topologyRole: bar.topologyRole ?? null,
      topologyPosition: bar.topologyPosition ?? null,
      topologyStatus: bar.topologyStatus ?? null,
      topologyReason: bar.topologyReason ?? null,
    };
  };

  return {
    matches: [
      ...straight.matches,
      ...residual.matches.map((pair) => ({
        left: unwrap(pair.left),
        right: unwrap(pair.right),
        matchBasis: pair.matchBasis || 'relative-slot',
        rejectedAlternatives: pair.rejectedAlternatives || [],
      })),
    ],
    unmatchedLeft: residual.unmatchedLeft.map(unwrap),
    unmatchedRight: residual.unmatchedRight.map(unwrap),
    unresolved: residual.unresolved.map((item) => ({
      ...item,
      leftBars: (item.leftBars || []).map(unwrap),
      rightBars: (item.rightBars || []).map(unwrap),
    })),
    resolver: residual.resolver,
  };
}

function attachedColumns(scanTag, nodeId) {
  return scanTag('StbColumn').filter(
    (element) =>
      isRc(element) &&
      (element.getAttribute('id_node_top') === nodeId ||
        element.getAttribute('id_node_bottom') === nodeId),
  );
}

/** 柱主筋の内側境界から、梁主筋を鉛直に遷移できるjtを解く。 */
function resolveJointBendRun(scanTag, nodeId, pair, columnLayouts) {
  const columns = attachedColumns(scanTag, nodeId);
  if (!columns.length) {
    return { jtMm: null, reason: 'joint-column-unresolved', columns: [] };
  }

  const resolved = [];
  for (const columnEl of columns) {
    const sectionId = String(columnEl.getAttribute('id_section'));
    const columnLayout = columnLayouts?.get(sectionId) || null;
    const dimensions = extractColumnPlanDimensions(scanTag, sectionId);
    if (!columnLayout || !dimensions) {
      return { jtMm: null, reason: 'joint-column-rebar-unresolved', columns: resolved };
    }

    const leftProjection = resolveColumnRebarAvailableProjection({
      columnEl,
      columnLayout,
      columnDimensions: dimensions,
      nodeId,
      beamDirection: pair.left.geometry.planDirection,
      beamSide: pair.left.endpoint,
    });
    const rightProjection = resolveColumnRebarAvailableProjection({
      columnEl,
      columnLayout,
      columnDimensions: dimensions,
      nodeId,
      beamDirection: pair.right.geometry.planDirection,
      beamSide: pair.right.endpoint,
    });
    if (!leftProjection.resolved || !rightProjection.resolved) {
      return { jtMm: null, reason: 'joint-column-rebar-unresolved', columns: resolved };
    }
    if (Math.abs(leftProjection.columnDepthMm - rightProjection.columnDepthMm) > EPS) {
      return { jtMm: null, reason: 'joint-column-depth-inconsistent', columns: resolved };
    }

    const jtMm =
      leftProjection.availableProjectionMm +
      rightProjection.availableProjectionMm -
      leftProjection.columnDepthMm;
    if (!(jtMm > EPS)) {
      return {
        jtMm: null,
        reason: 'joint-column-rebar-window-no-overlap',
        columns: resolved,
      };
    }
    resolved.push({
      columnId: columnEl.getAttribute('id') || null,
      sectionId,
      jtMm,
      leftProjection,
      rightProjection,
    });
  }

  return {
    jtMm: Math.min(...resolved.map((entry) => entry.jtMm)),
    reason: null,
    columns: resolved,
    source: 'actual-column-rebar-overlap',
  };
}

export function classifyGirderJointTransition({
  leftBar,
  rightBar,
  jtMm = null,
  matchBasis = null,
}) {
  const horizontalOffsetMm = Math.abs(leftBar.jointTransverseMm - rightBar.jointTransverseMm);
  const verticalOffsetMm = Math.abs(leftBar.jointElevationMm - rightBar.jointElevationMm);
  const horizontalActive = horizontalOffsetMm > STRAIGHT_TOLERANCE_MM;
  const verticalActive = verticalOffsetMm > STRAIGHT_TOLERANCE_MM;
  const resolvedJtMm = Number.isFinite(jtMm) ? Number(jtMm) : null;
  const horizontalRatio =
    resolvedJtMm !== null && resolvedJtMm > 0 ? horizontalOffsetMm / resolvedJtMm : null;
  const verticalRatio =
    resolvedJtMm !== null && resolvedJtMm > 0 ? verticalOffsetMm / resolvedJtMm : null;
  const eMm =
    horizontalActive && !verticalActive
      ? horizontalOffsetMm
      : !horizontalActive && verticalActive
        ? verticalOffsetMm
        : !horizontalActive && !verticalActive
          ? 0
          : null;
  const ratio =
    horizontalActive && !verticalActive
      ? horizontalRatio
      : !horizontalActive && verticalActive
        ? verticalRatio
        : !horizontalActive && !verticalActive && resolvedJtMm !== null && resolvedJtMm > 0
          ? 0
          : null;
  const base = {
    leftBar,
    rightBar,
    matchBasis,
    horizontalOffsetMm,
    verticalOffsetMm,
    horizontalRatio,
    verticalRatio,
    eMm,
    jtMm: resolvedJtMm,
    ratio,
    standardId: 'NIKKENREN-JSCA-2023',
    ruleId: '8-3',
  };

  if (!horizontalActive && !verticalActive) {
    return { ...base, disposition: 'STRAIGHT_THROUGH', unresolvedReason: null };
  }
  if (horizontalActive && verticalActive) {
    return {
      ...base,
      disposition: 'SPECIAL',
      unresolvedReason: 'combined-horizontal-vertical-offset-not-supported',
      recommendedDisposition: 'ANCHOR_BOTH',
    };
  }
  if (!(resolvedJtMm > 0)) {
    return { ...base, disposition: 'SPECIAL', unresolvedReason: 'joint-bend-run-unresolved' };
  }
  if (horizontalActive) {
    if (horizontalRatio <= GIRDER_BENT_MAX_RATIO + 1e-9) {
      return {
        ...base,
        disposition: 'SPECIAL',
        unresolvedReason: 'horizontal-offset-auto-bend-disabled',
        recommendedDisposition: 'ANCHOR_BOTH',
        candidateDisposition: 'BENT_HORIZONTAL_THROUGH',
        candidateRuleId: 'GIRDER-BENT-HORIZONTAL-ONE-SIXTH-CANDIDATE',
      };
    }
    return {
      ...base,
      disposition: 'SPECIAL',
      unresolvedReason: 'horizontal-bend-slope-exceeds-1-over-6',
      recommendedDisposition: 'ANCHOR_BOTH',
    };
  }
  if (verticalRatio <= GIRDER_BENT_MAX_RATIO + 1e-9) {
    return { ...base, disposition: 'BENT_VERTICAL_THROUGH', unresolvedReason: null };
  }
  return {
    ...base,
    disposition: 'SPECIAL',
    unresolvedReason: 'vertical-bend-slope-exceeds-1-over-6',
    recommendedDisposition: 'ANCHOR_BOTH',
  };
}

function pairFacts(scanTag, nodeId, pair, columnLayouts, options) {
  const result = {
    nodeId,
    modelSource: options?.modelSource || null,
    pairResolved: false,
    unresolvedReason: null,
    leftGirderId: pair.left.element.getAttribute('id') || null,
    rightGirderId: pair.right.element.getAttribute('id') || null,
    leftGirderName: pair.left.element.getAttribute('name') || null,
    rightGirderName: pair.right.element.getAttribute('name') || null,
    leftSectionName: pair.left.layout?.sectionName || null,
    rightSectionName: pair.right.layout?.sectionName || null,
    leftEndpoint: pair.left.endpoint,
    rightEndpoint: pair.right.endpoint,
    bendRun: null,
    transitions: [],
    priorityResolver: null,
    explicitOverride: null,
    unmatchedLeftBars: [],
    unmatchedRightBars: [],
    countChangeAssignments: [],
    unresolvedMatches: [],
  };
  const fail = (reason) => ({ ...result, unresolvedReason: reason });

  const projectedLeftBars = pair.left.bars.map((bar) =>
    projectGirderBarToJointFrame(bar, pair.frame),
  );
  const projectedRightBars = pair.right.bars.map((bar) =>
    projectGirderBarToJointFrame(bar, pair.frame),
  );
  if ([...projectedLeftBars, ...projectedRightBars].some((bar) => !bar)) {
    return fail('girder-bar-world-position-unresolved');
  }

  // topologyはexplicit override / straight-firstの前に全断面集合で一度だけ確定する。
  // L0 pairing後の残筋だけで再分類して、INTERMEDIATEをCORNERへ昇格させない。
  const leftBars = classifyGirderJointBarTopology(projectedLeftBars);
  const rightBars = classifyGirderJointBarTopology(projectedRightBars);

  const angleDelta = Math.atan2(
    Math.sin(pair.right.geometry.rollRad - pair.left.geometry.rollRad),
    Math.cos(pair.right.geometry.rollRad - pair.left.geometry.rollRad),
  );
  const explicitOverride = resolveGirderContinuityOverrideAssignment({
    modelSource: options?.modelSource,
    nodeId,
    leftGirderId: result.leftGirderId,
    rightGirderId: result.rightGirderId,
    projectDetailing: options?.projectDetailing,
  });
  result.explicitOverride = {
    active: explicitOverride.active,
    status: explicitOverride.status,
    reason: explicitOverride.reason,
    source: explicitOverride.source,
    pairCount: explicitOverride.pairs?.length || 0,
  };
  if (explicitOverride.active && !explicitOverride.resolved) {
    return fail(explicitOverride.reason);
  }

  const explicitApplied = applyGirderContinuityOverride(leftBars, rightBars, explicitOverride);
  if (!explicitApplied.resolved) {
    result.explicitOverride = {
      ...result.explicitOverride,
      status: 'UNRESOLVED',
      reason: explicitApplied.reason,
    };
    return fail(explicitApplied.reason);
  }

  const matching = matchGirderJointBars(explicitApplied.left, explicitApplied.right, {
    ...(options?.identityOptions || {}),
    cornerPriority: options?.girderCornerPriority === true,
    topologyFrameCompatible: Math.abs(angleDelta) <= STRAIGHT_TOLERANCE_MM,
    topologyClassified: true,
  });
  matching.matches = [...explicitApplied.matches, ...matching.matches];

  const bendRun = resolveJointBendRun(scanTag, nodeId, pair, columnLayouts);
  const transitions = matching.matches.map((match) => ({
    ...classifyGirderJointTransition({
      leftBar: match.left,
      rightBar: match.right,
      jtMm: bendRun.jtMm,
      matchBasis: match.matchBasis,
    }),
    rejectedAlternatives: match.rejectedAlternatives || [],
  }));

  result.pairResolved = true;
  result.bendRun = bendRun;
  result.transitions = transitions;
  result.priorityResolver = Object.freeze({
    ...matching.resolver,
    explicitOverrideCount: explicitApplied.matches.length,
  });
  result.unmatchedLeftBars = matching.unmatchedLeft;
  result.unmatchedRightBars = matching.unmatchedRight;
  result.countChangeAssignments = [
    ...matching.unmatchedLeft.map((bar) => ({
      disposition: 'TERMINATE',
      side: 'LEFT',
      bar,
      reason: 'count-decrease-after-priority-resolution',
    })),
    ...matching.unmatchedRight.map((bar) => ({
      disposition: 'NEW',
      side: 'RIGHT',
      bar,
      reason: 'count-increase-after-priority-resolution',
    })),
  ];
  result.unresolvedMatches = matching.unresolved;
  return result;
}

/**
 * RC大梁だけを対象に、共有節点の反対向き1:1ペアを§8-3 factsへ変換する。
 * 直交する大梁は別ペアとして扱い、片側しかない端部は既存§8-2定着へ委ねる。
 */
export function buildGirderJointTransitionFacts(
  xmlDoc,
  girderLayouts,
  columnLayouts,
  options = {},
) {
  if (!xmlDoc || !girderLayouts?.size) return { joints: [], unresolvedJoints: [] };
  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  const byNode = collectGirderEndpoints(scanTag, girderLayouts);
  const joints = [];
  const unresolvedJoints = [];

  for (const [nodeId, entries] of byNode) {
    const paired = pairEntriesAtNode(entries);
    if (paired.unresolvedReason) {
      unresolvedJoints.push({
        nodeId,
        modelSource: options.modelSource || null,
        girderIds: entries.map((entry) => entry.element.getAttribute('id')).filter(Boolean),
        reason: paired.unresolvedReason,
      });
      continue;
    }
    for (const pair of paired.pairs) {
      joints.push(
        pairFacts(scanTag, nodeId, pair, columnLayouts, {
          ...options,
          girderCornerPriority:
            options.girderCornerPriority === true ||
            options.detailingChoice?.continuity?.girderCornerPriority === true,
        }),
      );
    }
  }
  return { joints, unresolvedJoints };
}
