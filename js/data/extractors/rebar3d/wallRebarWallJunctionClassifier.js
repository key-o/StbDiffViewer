/**
 * @fileoverview Issue #310 Phase 6a-D1b:
 * 図11-2-1の wall-wall source treatment を pure classification する。
 *
 * このmoduleはbar geometryを変更しない。L/T、single/double、横筋間隔の
 * source factsから必要な treatment type を返すだけで、bar/face assignmentは後続D2へ残す。
 */

const TOPOLOGIES = new Set(['L', 'T']);
const PATTERNS = new Set(['SINGLE', 'DOUBLE_NET']);
const SPACING = new Set(['SAME', 'DIFFERENT']);

function unresolved(reason, facts = {}) {
  return Object.freeze({
    status: 'UNRESOLVED',
    sourceFigure: '11-2-1',
    reason,
    topology: facts?.topology || null,
    pattern: facts?.pattern || null,
    horizontalSpacingRelation: facts?.horizontalSpacingRelation || null,
    treatments: Object.freeze([]),
    requiredLengthKinds: Object.freeze([]),
    productionReady: false,
  });
}

function rejected(reason, facts = {}) {
  return Object.freeze({
    status: 'REJECTED',
    sourceFigure: '11-2-1',
    reason,
    topology: facts?.topology || null,
    pattern: facts?.pattern || null,
    horizontalSpacingRelation: facts?.horizontalSpacingRelation || null,
    treatments: Object.freeze([]),
    requiredLengthKinds: Object.freeze([]),
    productionReady: false,
  });
}

function treatment(disposition, scope, lengthKind = null) {
  return Object.freeze({
    disposition,
    scope,
    ...(lengthKind ? { lengthKind } : {}),
  });
}

function classified(facts, treatments) {
  const requiredLengthKinds = [
    ...new Set(treatments.map((item) => item.lengthKind).filter(Boolean)),
  ].sort();
  return Object.freeze({
    status: 'SOURCE_CLASSIFIED',
    sourceFigure: '11-2-1',
    reason: null,
    topology: facts.topology,
    pattern: facts.pattern,
    horizontalSpacingRelation: facts.horizontalSpacingRelation,
    treatments: Object.freeze(treatments),
    requiredLengthKinds: Object.freeze(requiredLengthKinds),
    composite: treatments.length > 1,
    barLevelAssignmentRequired: true,
    productionReady: false,
  });
}

/**
 * @param {{
 *  topology:'L'|'T',
 *  pattern:'SINGLE'|'DOUBLE_NET',
 *  horizontalSpacingRelation:'SAME'|'DIFFERENT',
 *  supplementalGate?:{status:string}
 * }} facts
 */
export function classifyWallWallJunctionSourceTreatment(facts) {
  const topology = facts?.topology;
  const pattern = facts?.pattern;
  const spacing = facts?.horizontalSpacingRelation;
  const gateStatus = facts?.supplementalGate?.status;

  if (gateStatus === 'REJECTED') {
    return rejected('wall-junction-supplemental-dia-hard-reject', facts);
  }
  if (gateStatus !== 'PASS') {
    return unresolved('wall-junction-supplemental-dia-gate-unresolved', facts);
  }
  if (!TOPOLOGIES.has(topology)) {
    return unresolved('wall-wall-junction-topology-unresolved', facts);
  }
  if (!PATTERNS.has(pattern)) {
    return unresolved('wall-wall-junction-pattern-unsupported', facts);
  }
  if (!SPACING.has(spacing)) {
    return unresolved('wall-wall-horizontal-spacing-relation-unresolved', facts);
  }

  if (topology === 'L' && pattern === 'SINGLE' && spacing === 'SAME') {
    return classified(facts, [treatment('L1_LAP', 'WALL_HORIZONTAL_RELATION', 'L1')]);
  }
  if (topology === 'L' && pattern === 'SINGLE' && spacing === 'DIFFERENT') {
    return classified(facts, [treatment('L2_ANCHORAGE', 'BOTH_WALL_HORIZONTAL_RELATIONS', 'L2')]);
  }
  if (topology === 'L' && pattern === 'DOUBLE_NET' && spacing === 'SAME') {
    return classified(facts, [
      treatment('L1_LAP', 'SOURCE_FIGURE_FACE_SET', 'L1'),
      treatment('L2_ANCHORAGE', 'SOURCE_FIGURE_FACE_SET', 'L2'),
    ]);
  }
  if (topology === 'L' && pattern === 'DOUBLE_NET' && spacing === 'DIFFERENT') {
    return classified(facts, [treatment('L2_ANCHORAGE', 'SOURCE_FIGURE_FACE_SET', 'L2')]);
  }

  // T形では主壁側の横筋は通し、直交壁側の横筋をL2定着する図示。
  if (topology === 'T') {
    return classified(facts, [
      treatment('CONTINUOUS_THROUGH', 'MAIN_WALL_HORIZONTAL_RELATION'),
      treatment('L2_ANCHORAGE', 'BRANCH_WALL_HORIZONTAL_RELATION', 'L2'),
    ]);
  }

  return unresolved('wall-wall-source-treatment-unresolved', facts);
}

export const __testOnly = Object.freeze({
  TOPOLOGIES,
  PATTERNS,
  SPACING,
});
