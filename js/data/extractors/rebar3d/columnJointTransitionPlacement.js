/**
 * @fileoverview R6: 梁仕口を挟む下階柱TOPと上階柱BOTTOMの主筋対応。
 * 単一柱のTOP/BOTTOM断面差とは区別する。semantic一致を前提に、全体座標で
 * 同一直線となる主筋をSTRAIGHTとして先取りし、残った筋だけR5の相対位置matcherへ渡す。
 */
import { createTagScanner } from '../columnSupportUtils.js';
import {
  applyColumnContinuityOverride,
  resolveColumnContinuityOverrideAssignment,
} from './columnContinuityOverride.js';
import { resolveColumnPriorityResidual } from './columnPriorityResolver.js';
import { classifyColumnBarTransition, columnBarSemanticKey } from './columnRebarTransition.js';
import {
  columnTransitionGeometry,
  columnEndpointBarFacts,
  collectTransitionBeamWindows,
  resolveTransitionBeamWindow,
} from './columnJointTransitionGeometry.js';

const STRAIGHT_MATCH_TOLERANCE_MM = 1e-6;

function append(map, key, item) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(item);
}

function collectColumns(scanTag, layouts) {
  const lower = new Map();
  const upper = new Map();
  // 既存rendererはIDのみをキーにする。StbPostとのID衝突を避け、R6はStbColumnを対象とする。
  for (const element of scanTag('StbColumn')) {
    const kind = String(element.getAttribute('kind_structure') || '').toUpperCase();
    if (kind && kind !== 'RC') continue;
    const layout = layouts.get(String(element.getAttribute('id_section')));
    const item = { element, layout };
    // 配筋欠損柱も接続数へ含め、分岐や欠損を1:1の正常接続へ縮約しない。
    append(lower, element.getAttribute('id_node_top'), item);
    append(upper, element.getAttribute('id_node_bottom'), item);
  }
  return { lower, upper };
}

function planDistance(left, right) {
  return Math.hypot(right.u - left.u, right.v - left.v);
}

function sameColumnSemantic(left, right) {
  return columnBarSemanticKey(left) === columnBarSemanticKey(right);
}

/**
 * 日建連§7-4のe=0を最優先する。
 * 同一semanticかつ全体座標で同一直線の候補が相互に一意な場合だけ先取りする。
 * 重複位置などで一意でない候補はここで推定せず、後段matcherのunresolved判定へ残す。
 */
function matchStraightBarsFirst(lowerBars, upperBars) {
  const lower = lowerBars.slice();
  const upper = upperBars.slice();
  const matches = [];

  while (lower.length && upper.length) {
    const round = [];
    for (const left of lower) {
      const candidates = upper.filter(
        (right) =>
          sameColumnSemantic(left, right) &&
          planDistance(left, right) <= STRAIGHT_MATCH_TOLERANCE_MM,
      );
      if (candidates.length !== 1) continue;
      const right = candidates[0];
      const reverse = lower.filter(
        (candidate) =>
          sameColumnSemantic(candidate, right) &&
          planDistance(candidate, right) <= STRAIGHT_MATCH_TOLERANCE_MM,
      );
      if (reverse.length !== 1 || reverse[0] !== left) continue;
      round.push({
        left,
        right,
        distance: 0,
        semanticKey: columnBarSemanticKey(left),
        matchBasis: 'world-straight-first',
      });
    }
    if (!round.length) break;
    for (const pair of round) {
      matches.push(pair);
      lower.splice(lower.indexOf(pair.left), 1);
      upper.splice(upper.indexOf(pair.right), 1);
    }
  }

  return { matches, lower, upper };
}

function matchColumnJointBars(lowerBars, upperBars, options = {}) {
  const straight = matchStraightBarsFirst(lowerBars, upperBars);
  const residual = resolveColumnPriorityResidual(straight.lower, straight.upper, options);
  return {
    matches: [...straight.matches, ...residual.matches],
    unmatchedLeft: residual.unmatchedLeft,
    unmatchedRight: residual.unmatchedRight,
    unresolved: residual.unresolved,
    resolver: residual.resolver,
  };
}

function jointForPair(scanTag, nodeId, lower, upper, beamLayouts, index = null, options = {}) {
  const result = {
    nodeId,
    modelSource: options.modelSource || null,
    transitions: [],
    unmatchedLowerBars: [],
    unmatchedUpperBars: [],
    unresolvedMatches: [],
    pairResolved: false,
    unresolvedReason: null,
    attachedBeamWindowCount: 0,
    priorityResolver: null,
    explicitOverride: null,
    countChangeAssignments: [],
  };
  for (const [side, item] of [
    ['lower', lower],
    ['upper', upper],
  ]) {
    result[`${side}ColumnId`] = item.element.getAttribute('id');
    result[`${side}ColumnName`] = item.element.getAttribute('name');
    result[`${side}SectionId`] = item.element.getAttribute('id_section');
    result[`${side}SectionName`] = item.layout?.sectionName || null;
    result[`${side}Geometry`] = columnTransitionGeometry(scanTag, item.element, index);
  }
  const fail = (reason) => ({ ...result, unresolvedReason: reason });
  if (!lower.layout || !upper.layout) return fail('column-layout-unresolved');
  if (!result.lowerGeometry || !result.upperGeometry) return fail('non-vertical-column-axis');
  const lowerBars = columnEndpointBarFacts(
    lower.element,
    lower.layout,
    result.lowerGeometry,
    'top',
  );
  const upperBars = columnEndpointBarFacts(
    upper.element,
    upper.layout,
    result.upperGeometry,
    'bottom',
  );
  if (!lowerBars.length || !upperBars.length) return fail('column-endpoint-bars-unresolved');
  if ([...lowerBars, ...upperBars].some((bar) => ![bar.u, bar.v].every(Number.isFinite))) {
    return fail('invalid-bar-position');
  }
  const angleDelta = Math.atan2(
    Math.sin(result.upperGeometry.angle - result.lowerGeometry.angle),
    Math.cos(result.upperGeometry.angle - result.lowerGeometry.angle),
  );
  const explicitOverride = resolveColumnContinuityOverrideAssignment({
    modelSource: options.modelSource,
    nodeId,
    lowerColumnId: result.lowerColumnId,
    upperColumnId: result.upperColumnId,
    projectDetailing: options.projectDetailing,
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
  const explicitApplied = applyColumnContinuityOverride(lowerBars, upperBars, explicitOverride);
  if (!explicitApplied.resolved) {
    result.explicitOverride = {
      ...result.explicitOverride,
      status: 'UNRESOLVED',
      reason: explicitApplied.reason,
    };
    return fail(explicitApplied.reason);
  }

  const matched = matchColumnJointBars(explicitApplied.lower, explicitApplied.upper, {
    cornerPriority: options.columnCornerPriority === true,
    topologyFrameCompatible: Math.abs(angleDelta) <= STRAIGHT_MATCH_TOLERANCE_MM,
  });
  matched.matches = [...explicitApplied.matches, ...matched.matches];
  result.priorityResolver = Object.freeze({
    ...matched.resolver,
    explicitOverrideCount: explicitApplied.matches.length,
  });
  const windows = collectTransitionBeamWindows(scanTag, nodeId, beamLayouts, index);
  result.attachedBeamWindowCount = windows.filter((entry) => entry.window).length;
  result.transitions = matched.matches.map((match) => {
    const pair = { bottomBar: match.left, topBar: match.right, jtMm: null };
    const preliminary = classifyColumnBarTransition(pair);
    const resolved =
      preliminary.unresolvedReason === 'jt-unresolved'
        ? resolveTransitionBeamWindow(windows, pair.bottomBar, pair.topBar)
        : { window: null, reason: null };
    const classified = resolved.window
      ? classifyColumnBarTransition({ ...pair, jtMm: resolved.window.jtMm })
      : preliminary;
    return {
      ...classified,
      unresolvedReason: resolved.reason || classified.unresolvedReason,
      nodeId,
      identityKey: `R6:${nodeId}:${result.lowerColumnId}:${match.left.barIndex}:${result.upperColumnId}:${match.right.barIndex}`,
      bendWindow: resolved.window,
      matchBasis: match.matchBasis || null,
      rejectedAlternatives: match.rejectedAlternatives || [],
    };
  });
  result.unmatchedLowerBars = matched.unmatchedLeft;
  result.unmatchedUpperBars = matched.unmatchedRight;
  result.countChangeAssignments = [
    ...matched.unmatchedLeft.map((bar) => ({
      disposition: 'TERMINATE',
      side: 'LOWER',
      bar,
      reason: 'count-decrease-after-priority-resolution',
    })),
    ...matched.unmatchedRight.map((bar) => ({
      disposition: 'NEW',
      side: 'UPPER',
      bar,
      reason: 'count-increase-after-priority-resolution',
    })),
  ];
  result.unresolvedMatches = matched.unresolved;
  result.pairResolved = true;
  return result;
}

/** 上下階柱が各1本の共有節点だけを扱う。分岐・欠損・同距離tieは推定しない。 */
export function buildColumnJointTransitionFacts(xmlDoc, columnLayouts, beamLayouts, options = {}) {
  if (!xmlDoc || !columnLayouts?.size) return { joints: [], unresolvedJoints: [] };
  const scanTag = options.scanTag || createTagScanner(xmlDoc);
  const index = options.index || null;
  const { lower, upper } = collectColumns(scanTag, columnLayouts);
  const joints = [];
  const unresolvedJoints = [];
  for (const nodeId of new Set([...lower.keys(), ...upper.keys()])) {
    const lowers = lower.get(nodeId) || [];
    const uppers = upper.get(nodeId) || [];
    if (!lowers.length || !uppers.length) continue;
    if (lowers.length !== 1 || uppers.length !== 1) {
      unresolvedJoints.push({
        nodeId,
        modelSource: options.modelSource || null,
        lowerColumnIds: lowers.map((item) => item.element.getAttribute('id')),
        upperColumnIds: uppers.map((item) => item.element.getAttribute('id')),
        reason: 'column-joint-not-one-to-one',
      });
      continue;
    }
    joints.push(
      jointForPair(scanTag, nodeId, lowers[0], uppers[0], beamLayouts, index, {
        columnCornerPriority:
          options.columnCornerPriority === true ||
          options.detailingChoice?.continuity?.columnCornerPriority === true,
        projectDetailing: options.projectDetailing,
        modelSource: options.modelSource,
      }),
    );
  }
  return { joints, unresolvedJoints };
}
