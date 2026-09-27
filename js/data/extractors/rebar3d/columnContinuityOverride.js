/**
 * @fileoverview Issue #273 Phase 3b: RC柱主筋 continuity の L0 explicit override。
 *
 * 個別編集・承認済みoverrideを project-scoped runtime detailing として保持し、
 * world-straight-first / project corner priority より前に適用する。
 * pairing自体だけを明示し、e/jt・曲げ半径・定着長などのhard constraintは既存判定へ委ねる。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { columnBarSemanticKey } from './columnRebarTransition.js';

const COLUMN_CONTINUITY_OVERRIDE_DETAILING_TYPE = 'COLUMN_BAR_CONTINUITY_OVERRIDE';
const PROJECT_ENTRY_MISSING = Symbol('project-entry-missing');

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

function finiteDistance(left, right) {
  const leftU = finiteCoordinate(left?.u);
  const leftV = finiteCoordinate(left?.v);
  const rightU = finiteCoordinate(right?.u);
  const rightV = finiteCoordinate(right?.v);
  if ([leftU, leftV, rightU, rightV].some((value) => value === null)) return null;
  return Math.hypot(rightU - leftU, rightV - leftV);
}
function projectEntry(projectDetailing) {
  if (!isPlainObject(projectDetailing)) return PROJECT_ENTRY_MISSING;
  if (
    Object.prototype.hasOwnProperty.call(
      projectDetailing,
      COLUMN_CONTINUITY_OVERRIDE_DETAILING_TYPE,
    )
  ) {
    return projectDetailing[COLUMN_CONTINUITY_OVERRIDE_DETAILING_TYPE];
  }
  if (
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(
      projectDetailing.special,
      COLUMN_CONTINUITY_OVERRIDE_DETAILING_TYPE,
    )
  ) {
    return projectDetailing.special[COLUMN_CONTINUITY_OVERRIDE_DETAILING_TYPE];
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
      reason: `column-explicit-override-assignment-${index}-invalid`,
    };
  }
  const modelSource = normalizedModelSource(rawAssignment.modelSource);
  const nodeId = nonBlank(rawAssignment.nodeId);
  const lowerColumnId = nonBlank(rawAssignment.lowerColumnId);
  const upperColumnId = nonBlank(rawAssignment.upperColumnId);
  if (!modelSource || !nodeId || !lowerColumnId || !upperColumnId) {
    return {
      ok: false,
      reason: `column-explicit-override-assignment-${index}-joint-key-required`,
    };
  }
  return {
    ok: true,
    selector: { modelSource, nodeId, lowerColumnId, upperColumnId },
  };
}

function validatePair(rawPair, index) {
  if (!isPlainObject(rawPair)) {
    return { ok: false, reason: `column-explicit-override-pair-${index}-invalid` };
  }
  const lowerBarIndex = nonNegativeInteger(rawPair.lowerBarIndex);
  const upperBarIndex = nonNegativeInteger(rawPair.upperBarIndex);
  const semanticKey = nonBlank(rawPair.semanticKey);
  const lowerLocalPosition = localPosition(rawPair.lowerLocalPosition);
  const upperLocalPosition = localPosition(rawPair.upperLocalPosition);
  if (lowerBarIndex === null || upperBarIndex === null) {
    return { ok: false, reason: `column-explicit-override-pair-${index}-bar-index-required` };
  }
  if (!semanticKey) {
    return { ok: false, reason: `column-explicit-override-pair-${index}-semantic-key-required` };
  }
  if (!lowerLocalPosition || !upperLocalPosition) {
    return { ok: false, reason: `column-explicit-override-pair-${index}-local-position-required` };
  }
  return {
    ok: true,
    pair: {
      lowerBarIndex,
      upperBarIndex,
      semanticKey: semanticKey.toUpperCase(),
      lowerLocalPosition,
      upperLocalPosition,
      lowerTopologyPosition: nonBlank(rawPair.lowerTopologyPosition),
      upperTopologyPosition: nonBlank(rawPair.upperTopologyPosition),
      note: nonBlank(rawPair.note),
    },
  };
}

/**
 * projectDetailingから対象柱仕口のexplicit pairingを解決する。
 *
 * 形式:
 * {
 *   COLUMN_BAR_CONTINUITY_OVERRIDE: {
 *     productionEnabled: true,
 *     productionMode: 'EXPLICIT',
 *     assignments: [{
 *       modelSource: 'A',
 *       nodeId: '2',
 *       lowerColumnId: '101',
 *       upperColumnId: '102',
 *       pairs: [{
 *         lowerBarIndex: 0,
 *         upperBarIndex: 1,
 *         semanticKey: 'MAIN|1|D25|SD345',
 *         lowerLocalPosition: { u: -250, v: -250 },
 *         upperLocalPosition: { u: -200, v: -200 },
 *         lowerTopologyPosition: 'X_MIN_Y_MIN',
 *         upperTopologyPosition: 'X_MAX_Y_MIN'
 *       }]
 *     }]
 *   }
 * }
 */
export function resolveColumnContinuityOverrideAssignment({
  modelSource,
  nodeId,
  lowerColumnId,
  upperColumnId,
  projectDetailing,
} = {}) {
  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const entry = projectEntry(source);
  if (entry === PROJECT_ENTRY_MISSING) return inactive();
  if (!isPlainObject(entry)) {
    return unresolved('column-explicit-override-project-detailing-entry-invalid');
  }
  if (entry.productionEnabled !== true) return inactive('DISABLED');
  if (entry.productionMode !== 'EXPLICIT') {
    return unresolved('column-explicit-override-explicit-production-mode-required');
  }
  if (!Array.isArray(entry.assignments)) {
    return unresolved('column-explicit-override-assignments-required');
  }

  const key = {
    modelSource: normalizedModelSource(modelSource),
    nodeId: nonBlank(nodeId),
    lowerColumnId: nonBlank(lowerColumnId),
    upperColumnId: nonBlank(upperColumnId),
  };
  if (!key.modelSource) {
    return unresolved('column-explicit-override-model-source-required');
  }
  if (!key.nodeId || !key.lowerColumnId || !key.upperColumnId) {
    return unresolved('column-explicit-override-joint-key-invalid');
  }

  const validatedAssignments = [];
  for (const [index, assignment] of entry.assignments.entries()) {
    const checked = validateAssignmentSelector(assignment, index);
    if (!checked.ok) {
      // Local re-resolution must not be poisoned by a malformed assignment that is
      // clearly scoped to another model/joint. If every usable selector field still
      // agrees with the current joint (or the entry is too malformed to scope), keep
      // fail-closed behavior for the current joint.
      if (!isPlainObject(assignment)) return unresolved(checked.reason);
      const scopedFields = [
        [normalizedModelSource(assignment.modelSource), key.modelSource],
        [nonBlank(assignment.nodeId), key.nodeId],
        [nonBlank(assignment.lowerColumnId), key.lowerColumnId],
        [nonBlank(assignment.upperColumnId), key.upperColumnId],
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
      selector.lowerColumnId === key.lowerColumnId &&
      selector.upperColumnId === key.upperColumnId
    ) {
      validatedAssignments.push({ assignment, selector });
    }
  }

  const matches = validatedAssignments.map(({ assignment }) => assignment);
  if (matches.length === 0) return inactive('NO_ASSIGNMENT');
  if (matches.length !== 1) {
    return unresolved('column-explicit-override-assignment-ambiguous', {
      assignmentCount: matches.length,
    });
  }

  const assignment = matches[0];
  if (!Array.isArray(assignment.pairs) || assignment.pairs.length === 0) {
    return unresolved('column-explicit-override-pairs-required');
  }

  const pairs = [];
  const lowerIndexes = new Set();
  const upperIndexes = new Set();
  for (const [index, rawPair] of assignment.pairs.entries()) {
    const checked = validatePair(rawPair, index);
    if (!checked.ok) return unresolved(checked.reason);
    if (lowerIndexes.has(checked.pair.lowerBarIndex)) {
      return unresolved('column-explicit-override-lower-bar-reused', {
        barIndex: checked.pair.lowerBarIndex,
      });
    }
    if (upperIndexes.has(checked.pair.upperBarIndex)) {
      return unresolved('column-explicit-override-upper-bar-reused', {
        barIndex: checked.pair.upperBarIndex,
      });
    }
    lowerIndexes.add(checked.pair.lowerBarIndex);
    upperIndexes.add(checked.pair.upperBarIndex);
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
      lowerColumnId: key.lowerColumnId,
      upperColumnId: key.upperColumnId,
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
        ? 'column-explicit-override-bar-index-missing'
        : 'column-explicit-override-bar-index-ambiguous',
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
    Math.hypot(actual.u - expected.u, actual.v - expected.v) <= 1e-6
  );
}

function fingerprintMatches(bar, pair, side) {
  const semanticMatches = columnBarSemanticKey(bar) === pair.semanticKey;
  const position = side === 'lower' ? pair.lowerLocalPosition : pair.upperLocalPosition;
  const topology = side === 'lower' ? pair.lowerTopologyPosition : pair.upperTopologyPosition;
  return semanticMatches && localPositionMatches(bar, position) && topologyMatches(bar, topology);
}

function fingerprintIsUnique(bars, pair, side) {
  return (bars || []).filter((bar) => fingerprintMatches(bar, pair, side)).length === 1;
}

function alternativeRef(bar) {
  return {
    barIndex: nonNegativeInteger(bar?.barIndex),
    topologyRole: nonBlank(bar?.topologyRole),
    topologyPosition: nonBlank(bar?.topologyPosition),
    u: finiteCoordinate(bar?.u),
    v: finiteCoordinate(bar?.v),
  };
}

function rejectedAutomaticAlternatives(leftBar, selectedRightBar, upperBars, semanticKey) {
  return (upperBars || [])
    .filter(
      (candidate) =>
        candidate !== selectedRightBar && columnBarSemanticKey(candidate) === semanticKey,
    )
    .map((candidate) => {
      const distance = finiteDistance(leftBar, candidate);
      return {
        target: alternativeRef(candidate),
        reason:
          distance !== null && distance <= 1e-6
            ? 'OVERRIDDEN_WORLD_STRAIGHT_CANDIDATE'
            : 'LOWER_PRECEDENCE_AUTOMATIC_CANDIDATE',
      };
    });
}

/**
 * 解決済みassignmentをendpoint bar factsへ適用する。
 * semantic/topology fingerprintがstaleなら自動matchingへfallbackしない。
 */
export function applyColumnContinuityOverride(lowerBars, upperBars, resolvedAssignment) {
  if (!resolvedAssignment?.resolved) {
    return {
      resolved: false,
      reason: resolvedAssignment?.reason || 'column-explicit-override-unresolved',
      matches: [],
      lower: [],
      upper: [],
    };
  }
  if (!resolvedAssignment.active) {
    return {
      resolved: true,
      reason: null,
      matches: [],
      lower: (lowerBars || []).slice(),
      upper: (upperBars || []).slice(),
    };
  }

  const lower = (lowerBars || []).slice();
  const upper = (upperBars || []).slice();
  const matches = [];

  for (const pair of resolvedAssignment.pairs || []) {
    const left = uniqueBarByIndex(lower, pair.lowerBarIndex);
    const right = uniqueBarByIndex(upper, pair.upperBarIndex);
    if (!left.ok || !right.ok) {
      return {
        resolved: false,
        reason: left.reason || right.reason,
        matches: [],
        lower: [],
        upper: [],
      };
    }
    const actualLeftSemantic = columnBarSemanticKey(left.bar);
    const actualRightSemantic = columnBarSemanticKey(right.bar);
    if (
      actualLeftSemantic !== pair.semanticKey ||
      actualRightSemantic !== pair.semanticKey ||
      actualLeftSemantic !== actualRightSemantic
    ) {
      return {
        resolved: false,
        reason: 'column-explicit-override-semantic-mismatch',
        matches: [],
        lower: [],
        upper: [],
      };
    }
    if (
      !localPositionMatches(left.bar, pair.lowerLocalPosition) ||
      !localPositionMatches(right.bar, pair.upperLocalPosition)
    ) {
      return {
        resolved: false,
        reason: 'column-explicit-override-local-position-stale',
        matches: [],
        lower: [],
        upper: [],
      };
    }
    if (
      !topologyMatches(left.bar, pair.lowerTopologyPosition) ||
      !topologyMatches(right.bar, pair.upperTopologyPosition)
    ) {
      return {
        resolved: false,
        reason: 'column-explicit-override-topology-stale',
        matches: [],
        lower: [],
        upper: [],
      };
    }
    if (
      !fingerprintIsUnique(lowerBars, pair, 'lower') ||
      !fingerprintIsUnique(upperBars, pair, 'upper')
    ) {
      return {
        resolved: false,
        reason: 'column-explicit-override-fingerprint-ambiguous',
        matches: [],
        lower: [],
        upper: [],
      };
    }

    const distance = finiteDistance(left.bar, right.bar);
    if (distance === null) {
      return {
        resolved: false,
        reason: 'column-explicit-override-invalid-bar-position',
        matches: [],
        lower: [],
        upper: [],
      };
    }

    matches.push({
      left: left.bar,
      right: right.bar,
      distance,
      semanticKey: pair.semanticKey,
      matchBasis: 'column-explicit-override',
      rejectedAlternatives: rejectedAutomaticAlternatives(
        left.bar,
        right.bar,
        upperBars,
        pair.semanticKey,
      ),
      overrideSource: 'PROJECT_DETAILING:COLUMN_BAR_CONTINUITY_OVERRIDE',
      overrideNote: pair.note,
    });
    lower.splice(lower.indexOf(left.bar), 1);
    upper.splice(upper.indexOf(right.bar), 1);
  }

  return {
    resolved: true,
    reason: null,
    matches,
    lower,
    upper,
  };
}
