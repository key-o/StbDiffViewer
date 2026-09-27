/**
 * @fileoverview Issue #273 Phase 5b: RC大梁主筋 continuity の L0 explicit override。
 *
 * 個別編集・承認済みoverrideを project-scoped runtime detailing として保持し、
 * world-straight-first / project corner priority より前に適用する。
 * pairingだけを明示し、e/jt・曲げ半径・定着等のhard constraintは既存R7判定へ委ねる。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { rebarSemanticKey } from './rebarIdentityMatcher.js';

const GIRDER_CONTINUITY_OVERRIDE_DETAILING_TYPE = 'GIRDER_BAR_CONTINUITY_OVERRIDE';
const PROJECT_ENTRY_MISSING = Symbol('project-entry-missing');
const POSITION_TOLERANCE_MM = 1e-6;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizedModelSource(value) {
  const source = String(value ?? '')
    .trim()
    .toUpperCase();
  return source === 'A' || source === 'B' ? source : null;
}

function nonNegativeInteger(value) {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function finiteCoordinate(value) {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function projectEntry(projectDetailing) {
  if (!isPlainObject(projectDetailing)) return PROJECT_ENTRY_MISSING;
  if (
    Object.prototype.hasOwnProperty.call(
      projectDetailing,
      GIRDER_CONTINUITY_OVERRIDE_DETAILING_TYPE,
    )
  ) {
    return projectDetailing[GIRDER_CONTINUITY_OVERRIDE_DETAILING_TYPE];
  }
  if (
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(
      projectDetailing.special,
      GIRDER_CONTINUITY_OVERRIDE_DETAILING_TYPE,
    )
  ) {
    return projectDetailing.special[GIRDER_CONTINUITY_OVERRIDE_DETAILING_TYPE];
  }
  return PROJECT_ENTRY_MISSING;
}

function inactive(status = 'NOT_CONFIGURED') {
  return {
    active: false,
    resolved: true,
    status,
    reason: null,
    source: null,
    assignment: null,
    pairs: [],
  };
}

function unresolved(reason, details = {}) {
  return {
    active: true,
    resolved: false,
    status: 'UNRESOLVED',
    reason,
    source: 'project-detailing',
    assignment: null,
    pairs: [],
    ...details,
  };
}

function localPosition(value) {
  if (!isPlainObject(value)) return null;
  const u = finiteCoordinate(value.u);
  const v = finiteCoordinate(value.v);
  return u === null || v === null ? null : { u, v };
}

function validateAssignmentSelector(rawAssignment, index) {
  if (!isPlainObject(rawAssignment)) {
    return {
      ok: false,
      reason: `girder-explicit-override-assignment-${index}-invalid`,
    };
  }
  const modelSource = normalizedModelSource(rawAssignment.modelSource);
  const nodeId = nonBlank(rawAssignment.nodeId);
  const leftGirderId = nonBlank(rawAssignment.leftGirderId);
  const rightGirderId = nonBlank(rawAssignment.rightGirderId);
  if (!modelSource || !nodeId || !leftGirderId || !rightGirderId) {
    return {
      ok: false,
      reason: `girder-explicit-override-assignment-${index}-joint-key-required`,
    };
  }
  return {
    ok: true,
    selector: { modelSource, nodeId, leftGirderId, rightGirderId },
  };
}

function validatePair(rawPair, index) {
  if (!isPlainObject(rawPair)) {
    return { ok: false, reason: `girder-explicit-override-pair-${index}-invalid` };
  }
  const leftBarIndex = nonNegativeInteger(rawPair.leftBarIndex);
  const rightBarIndex = nonNegativeInteger(rawPair.rightBarIndex);
  const semanticKey = nonBlank(rawPair.semanticKey);
  const leftLocalPosition = localPosition(rawPair.leftLocalPosition);
  const rightLocalPosition = localPosition(rawPair.rightLocalPosition);
  if (leftBarIndex === null || rightBarIndex === null) {
    return { ok: false, reason: `girder-explicit-override-pair-${index}-bar-index-required` };
  }
  if (!semanticKey) {
    return { ok: false, reason: `girder-explicit-override-pair-${index}-semantic-key-required` };
  }
  if (!leftLocalPosition || !rightLocalPosition) {
    return {
      ok: false,
      reason: `girder-explicit-override-pair-${index}-local-position-required`,
    };
  }
  return {
    ok: true,
    pair: {
      leftBarIndex,
      rightBarIndex,
      semanticKey,
      leftLocalPosition,
      rightLocalPosition,
      leftTopologyPosition: nonBlank(rawPair.leftTopologyPosition),
      rightTopologyPosition: nonBlank(rawPair.rightTopologyPosition),
      note: nonBlank(rawPair.note),
    },
  };
}

/**
 * projectDetailingから対象大梁仕口のexplicit pairingを解決する。
 *
 * 形式:
 * {
 *   GIRDER_BAR_CONTINUITY_OVERRIDE: {
 *     productionEnabled: true,
 *     productionMode: 'EXPLICIT',
 *     assignments: [{
 *       modelSource: 'A',
 *       nodeId: '1',
 *       leftGirderId: '20',
 *       rightGirderId: '21',
 *       pairs: [{
 *         leftBarIndex: 0,
 *         rightBarIndex: 1,
 *         semanticKey: 'top|1|top|D25|SD345',
 *         leftLocalPosition: { u: -100, v: 250 },
 *         rightLocalPosition: { u: 100, v: 250 },
 *         leftTopologyPosition: 'TOP:L1:LEFT',
 *         rightTopologyPosition: 'TOP:L1:RIGHT'
 *       }]
 *     }]
 *   }
 * }
 */
export function resolveGirderContinuityOverrideAssignment({
  modelSource,
  nodeId,
  leftGirderId,
  rightGirderId,
  projectDetailing,
} = {}) {
  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const entry = projectEntry(source);
  if (entry === PROJECT_ENTRY_MISSING) return inactive();
  if (!isPlainObject(entry)) {
    return unresolved('girder-explicit-override-project-detailing-entry-invalid');
  }
  if (entry.productionEnabled !== true) return inactive('DISABLED');
  if (entry.productionMode !== 'EXPLICIT') {
    return unresolved('girder-explicit-override-explicit-production-mode-required');
  }
  if (!Array.isArray(entry.assignments)) {
    return unresolved('girder-explicit-override-assignments-required');
  }

  const key = {
    modelSource: normalizedModelSource(modelSource),
    nodeId: nonBlank(nodeId),
    leftGirderId: nonBlank(leftGirderId),
    rightGirderId: nonBlank(rightGirderId),
  };
  if (!key.modelSource) {
    return unresolved('girder-explicit-override-model-source-required');
  }
  if (!key.nodeId || !key.leftGirderId || !key.rightGirderId) {
    return unresolved('girder-explicit-override-joint-key-invalid');
  }

  const validatedAssignments = [];
  for (const [index, assignment] of entry.assignments.entries()) {
    const checked = validateAssignmentSelector(assignment, index);
    if (!checked.ok) {
      if (!isPlainObject(assignment)) return unresolved(checked.reason);
      const scopedFields = [
        [normalizedModelSource(assignment.modelSource), key.modelSource],
        [nonBlank(assignment.nodeId), key.nodeId],
        [nonBlank(assignment.leftGirderId), key.leftGirderId],
        [nonBlank(assignment.rightGirderId), key.rightGirderId],
      ];
      const conflictsCurrentJoint = scopedFields.some(
        ([actual, expected]) => actual !== null && actual !== expected,
      );
      if (!conflictsCurrentJoint) return unresolved(checked.reason);
      continue;
    }
    const { selector } = checked;
    if (
      selector.modelSource === key.modelSource &&
      selector.nodeId === key.nodeId &&
      selector.leftGirderId === key.leftGirderId &&
      selector.rightGirderId === key.rightGirderId
    ) {
      validatedAssignments.push({ assignment, selector });
    }
  }

  const matches = validatedAssignments.map(({ assignment }) => assignment);
  if (matches.length === 0) return inactive('NO_ASSIGNMENT');
  if (matches.length !== 1) {
    return unresolved('girder-explicit-override-assignment-ambiguous', {
      assignmentCount: matches.length,
    });
  }

  const assignment = matches[0];
  if (!Array.isArray(assignment.pairs) || assignment.pairs.length === 0) {
    return unresolved('girder-explicit-override-pairs-required');
  }

  const pairs = [];
  const leftIndexes = new Set();
  const rightIndexes = new Set();
  for (const [index, rawPair] of assignment.pairs.entries()) {
    const checked = validatePair(rawPair, index);
    if (!checked.ok) return unresolved(checked.reason);
    if (leftIndexes.has(checked.pair.leftBarIndex)) {
      return unresolved('girder-explicit-override-left-bar-reused', {
        barIndex: checked.pair.leftBarIndex,
      });
    }
    if (rightIndexes.has(checked.pair.rightBarIndex)) {
      return unresolved('girder-explicit-override-right-bar-reused', {
        barIndex: checked.pair.rightBarIndex,
      });
    }
    leftIndexes.add(checked.pair.leftBarIndex);
    rightIndexes.add(checked.pair.rightBarIndex);
    pairs.push(checked.pair);
  }

  return {
    active: true,
    resolved: true,
    status: 'PAIRING_READY',
    reason: null,
    source: 'project-detailing',
    assignment: {
      modelSource: key.modelSource,
      nodeId: key.nodeId,
      leftGirderId: key.leftGirderId,
      rightGirderId: key.rightGirderId,
      pairs,
    },
    pairs,
  };
}

function uniqueBarByIndex(bars, barIndex) {
  const expected = nonNegativeInteger(barIndex);
  const matches =
    expected === null
      ? []
      : (bars || []).filter((bar) => nonNegativeInteger(bar?.barIndex) === expected);
  if (matches.length === 1) return { ok: true, bar: matches[0] };
  return {
    ok: false,
    reason:
      matches.length === 0
        ? 'girder-explicit-override-bar-index-missing'
        : 'girder-explicit-override-bar-index-ambiguous',
    candidateCount: matches.length,
    barIndex,
  };
}

function topologyMatches(bar, expected) {
  return !expected || String(bar?.topologyPosition || '') === String(expected);
}

function localPositionMatches(bar, expected) {
  const actual = localPosition(bar?.localPosition);
  return (
    actual !== null &&
    expected !== null &&
    Math.hypot(actual.u - expected.u, actual.v - expected.v) <= POSITION_TOLERANCE_MM
  );
}

function fingerprintMatches(bar, pair, side) {
  const semanticMatches = rebarSemanticKey(bar) === pair.semanticKey;
  const position = side === 'left' ? pair.leftLocalPosition : pair.rightLocalPosition;
  const topology = side === 'left' ? pair.leftTopologyPosition : pair.rightTopologyPosition;
  return semanticMatches && localPositionMatches(bar, position) && topologyMatches(bar, topology);
}

function fingerprintIsUnique(bars, pair, side) {
  return (bars || []).filter((bar) => fingerprintMatches(bar, pair, side)).length === 1;
}

function jointDistance(left, right) {
  const lt = finiteCoordinate(left?.jointTransverseMm);
  const le = finiteCoordinate(left?.jointElevationMm);
  const rt = finiteCoordinate(right?.jointTransverseMm);
  const re = finiteCoordinate(right?.jointElevationMm);
  if ([lt, le, rt, re].some((value) => value === null)) return null;
  return Math.hypot(rt - lt, re - le);
}

function alternativeRef(bar) {
  return {
    barIndex: nonNegativeInteger(bar?.barIndex),
    topologyRole: nonBlank(bar?.topologyRole),
    topologyPosition: nonBlank(bar?.topologyPosition),
    jointTransverseMm: finiteCoordinate(bar?.jointTransverseMm),
    jointElevationMm: finiteCoordinate(bar?.jointElevationMm),
    u: finiteCoordinate(bar?.localPosition?.u),
    v: finiteCoordinate(bar?.localPosition?.v),
  };
}

function rejectedAutomaticAlternatives(leftBar, selectedRightBar, rightBars, semanticKey) {
  return (rightBars || [])
    .filter(
      (candidate) => candidate !== selectedRightBar && rebarSemanticKey(candidate) === semanticKey,
    )
    .map((candidate) => {
      const distance = jointDistance(leftBar, candidate);
      return {
        target: alternativeRef(candidate),
        reason:
          distance !== null && distance <= POSITION_TOLERANCE_MM
            ? 'OVERRIDDEN_WORLD_STRAIGHT_CANDIDATE'
            : 'LOWER_PRECEDENCE_AUTOMATIC_CANDIDATE',
      };
    });
}

/**
 * 解決済みassignmentをjoint-frame bar factsへ適用する。
 * semantic/local-position/topology fingerprintがstaleならautomatic matchingへfallbackしない。
 */
export function applyGirderContinuityOverride(leftBars, rightBars, resolvedAssignment) {
  if (!resolvedAssignment?.resolved) {
    return {
      resolved: false,
      reason: resolvedAssignment?.reason || 'girder-explicit-override-unresolved',
      matches: [],
      left: [],
      right: [],
    };
  }
  if (!resolvedAssignment.active) {
    return {
      resolved: true,
      reason: null,
      matches: [],
      left: (leftBars || []).slice(),
      right: (rightBars || []).slice(),
    };
  }

  const left = (leftBars || []).slice();
  const right = (rightBars || []).slice();
  const matches = [];

  for (const pair of resolvedAssignment.pairs || []) {
    const selectedLeft = uniqueBarByIndex(left, pair.leftBarIndex);
    const selectedRight = uniqueBarByIndex(right, pair.rightBarIndex);
    if (!selectedLeft.ok || !selectedRight.ok) {
      return {
        resolved: false,
        reason: selectedLeft.reason || selectedRight.reason,
        matches: [],
        left: [],
        right: [],
      };
    }

    const actualLeftSemantic = rebarSemanticKey(selectedLeft.bar);
    const actualRightSemantic = rebarSemanticKey(selectedRight.bar);
    if (
      actualLeftSemantic !== pair.semanticKey ||
      actualRightSemantic !== pair.semanticKey ||
      actualLeftSemantic !== actualRightSemantic
    ) {
      return {
        resolved: false,
        reason: 'girder-explicit-override-semantic-mismatch',
        matches: [],
        left: [],
        right: [],
      };
    }
    if (
      !localPositionMatches(selectedLeft.bar, pair.leftLocalPosition) ||
      !localPositionMatches(selectedRight.bar, pair.rightLocalPosition)
    ) {
      return {
        resolved: false,
        reason: 'girder-explicit-override-local-position-stale',
        matches: [],
        left: [],
        right: [],
      };
    }
    if (
      !topologyMatches(selectedLeft.bar, pair.leftTopologyPosition) ||
      !topologyMatches(selectedRight.bar, pair.rightTopologyPosition)
    ) {
      return {
        resolved: false,
        reason: 'girder-explicit-override-topology-stale',
        matches: [],
        left: [],
        right: [],
      };
    }
    if (
      !fingerprintIsUnique(leftBars, pair, 'left') ||
      !fingerprintIsUnique(rightBars, pair, 'right')
    ) {
      return {
        resolved: false,
        reason: 'girder-explicit-override-fingerprint-ambiguous',
        matches: [],
        left: [],
        right: [],
      };
    }

    const distance = jointDistance(selectedLeft.bar, selectedRight.bar);
    if (distance === null) {
      return {
        resolved: false,
        reason: 'girder-explicit-override-invalid-bar-position',
        matches: [],
        left: [],
        right: [],
      };
    }

    matches.push({
      left: selectedLeft.bar,
      right: selectedRight.bar,
      distance,
      semanticKey: pair.semanticKey,
      matchBasis: 'girder-explicit-override',
      rejectedAlternatives: rejectedAutomaticAlternatives(
        selectedLeft.bar,
        selectedRight.bar,
        rightBars,
        pair.semanticKey,
      ),
      overrideSource: 'PROJECT_DETAILING:GIRDER_BAR_CONTINUITY_OVERRIDE',
      overrideNote: pair.note,
    });
    left.splice(left.indexOf(selectedLeft.bar), 1);
    right.splice(right.indexOf(selectedRight.bar), 1);
  }

  return {
    resolved: true,
    reason: null,
    matches,
    left,
    right,
  };
}
