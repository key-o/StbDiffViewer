/**
 * @fileoverview Issue #310 Phase 6a-D2b bar-level wall junction treatment。
 *
 * D1b classification後のL1/L2/CONTINUOUS_THROUGH割当と、
 * design-length / available-length / W-001 gateをpureに適用する。
 */

const DEFAULT_Z_TOLERANCE_MM = 1e-4;
const DEFAULT_LENGTH_TOLERANCE_MM = 1e-4;
const SUPPORTED_TOPOLOGIES = new Set(['L', 'T']);
const SUPPORTED_PATTERNS = new Set(['SINGLE', 'DOUBLE_NET']);
const SUPPORTED_SPACING_RELATIONS = new Set(['SAME', 'DIFFERENT']);
const SUPPORTED_ASSIGNMENT_DISPOSITIONS = new Set(['L1_LAP', 'L2_ANCHORAGE', 'CONTINUOUS_THROUGH']);

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positive(value) {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function unresolved(reason, values = {}) {
  return Object.freeze({ status: 'UNRESOLVED', reason, productionReady: false, ...values });
}

function normalizedEvaluation(value, expectedRuleId = null) {
  if (!value || !['PASS', 'REJECTED', 'UNRESOLVED'].includes(value.status)) return null;
  if (expectedRuleId && value.ruleId !== expectedRuleId) return null;
  return Object.freeze({
    ...value,
    ...(expectedRuleId ? { ruleId: expectedRuleId } : {}),
  });
}

function mapValue(source, key) {
  if (source instanceof Map) return source.get(key);
  if (source && typeof source === 'object') return source[key];
  return undefined;
}

function normalizeProvenance(value) {
  if (typeof value === 'string') {
    const source = text(value);
    return source ? Object.freeze({ source }) : null;
  }
  if (!value || typeof value !== 'object') return null;
  const source = text(value.source);
  if (!source) return null;
  return Object.freeze({ ...value, source });
}

function designLengthFact(designLengths, kind) {
  const requiredMm = positive(designLengths?.[`${kind}Mm`]);
  const rawProvenance = designLengths?.provenance;
  const sharedProvenance =
    rawProvenance &&
    typeof rawProvenance === 'object' &&
    !Array.isArray(rawProvenance) &&
    !Object.prototype.hasOwnProperty.call(rawProvenance, 'source')
      ? rawProvenance[kind]
      : rawProvenance;
  const provenance = normalizeProvenance(designLengths?.[`${kind}Provenance`] ?? sharedProvenance);
  if (requiredMm === null || !provenance) return null;
  return Object.freeze({ kind, requiredMm, provenance });
}

export function requiredWallWallDesignLengthFacts(classification, designLengths) {
  const result = {};
  const kinds = classification?.requiredLengthKinds;
  if (!Array.isArray(kinds) || kinds.length === 0) return null;
  for (const kind of kinds) {
    if (kind !== 'L1' && kind !== 'L2') return null;
    const fact = designLengthFact(designLengths, kind);
    if (!fact) return null;
    result[kind] = fact;
  }
  return Object.freeze(result);
}

function requiredLengthKindsForTopology(topologyFact) {
  if (topologyFact?.topology === 'L' && topologyFact.pattern === 'SINGLE') {
    if (topologyFact.horizontalSpacingRelation === 'SAME') return ['L1'];
    if (topologyFact.horizontalSpacingRelation === 'DIFFERENT') return ['L2'];
  }
  if (topologyFact?.topology === 'L' && topologyFact.pattern === 'DOUBLE_NET') {
    if (topologyFact.horizontalSpacingRelation === 'SAME') return ['L1', 'L2'];
    if (topologyFact.horizontalSpacingRelation === 'DIFFERENT') return ['L2'];
  }
  if (topologyFact?.topology === 'T') return ['L2'];
  return null;
}

function requiredLengthFactsForTopology(topologyFact, lengths) {
  const kinds = requiredLengthKindsForTopology(topologyFact);
  if (!kinds) return null;
  const result = {};
  for (const kind of kinds) {
    const fact = lengths?.[kind];
    if (
      !fact ||
      fact.kind !== kind ||
      positive(fact.requiredMm) === null ||
      !normalizeProvenance(fact.provenance)
    ) {
      return null;
    }
    result[kind] = fact;
  }
  return Object.freeze(result);
}

function requiredDispositionsForTopology(topologyFact) {
  if (topologyFact?.topology === 'L' && topologyFact.pattern === 'SINGLE') {
    return topologyFact.horizontalSpacingRelation === 'SAME'
      ? ['L1_LAP']
      : topologyFact.horizontalSpacingRelation === 'DIFFERENT'
        ? ['L2_ANCHORAGE']
        : null;
  }
  if (topologyFact?.topology === 'L' && topologyFact.pattern === 'DOUBLE_NET') {
    return topologyFact.horizontalSpacingRelation === 'SAME'
      ? ['L1_LAP', 'L2_ANCHORAGE']
      : topologyFact.horizontalSpacingRelation === 'DIFFERENT'
        ? ['L2_ANCHORAGE']
        : null;
  }
  if (topologyFact?.topology === 'T') return ['CONTINUOUS_THROUGH', 'L2_ANCHORAGE'];
  return null;
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  return (
    normalizedActual.length === normalizedExpected.length &&
    normalizedActual.every((value, index) => value === normalizedExpected[index])
  );
}

function expectedTreatmentsForTopology(topologyFact) {
  if (topologyFact?.topology === 'L' && topologyFact.pattern === 'SINGLE') {
    return topologyFact.horizontalSpacingRelation === 'SAME'
      ? [{ disposition: 'L1_LAP', scope: 'WALL_HORIZONTAL_RELATION', lengthKind: 'L1' }]
      : topologyFact.horizontalSpacingRelation === 'DIFFERENT'
        ? [
            {
              disposition: 'L2_ANCHORAGE',
              scope: 'BOTH_WALL_HORIZONTAL_RELATIONS',
              lengthKind: 'L2',
            },
          ]
        : null;
  }
  if (topologyFact?.topology === 'L' && topologyFact.pattern === 'DOUBLE_NET') {
    return topologyFact.horizontalSpacingRelation === 'SAME'
      ? [
          { disposition: 'L1_LAP', scope: 'SOURCE_FIGURE_FACE_SET', lengthKind: 'L1' },
          { disposition: 'L2_ANCHORAGE', scope: 'SOURCE_FIGURE_FACE_SET', lengthKind: 'L2' },
        ]
      : topologyFact.horizontalSpacingRelation === 'DIFFERENT'
        ? [{ disposition: 'L2_ANCHORAGE', scope: 'SOURCE_FIGURE_FACE_SET', lengthKind: 'L2' }]
        : null;
  }
  if (topologyFact?.topology === 'T') {
    return [
      { disposition: 'CONTINUOUS_THROUGH', scope: 'MAIN_WALL_HORIZONTAL_RELATION' },
      { disposition: 'L2_ANCHORAGE', scope: 'BRANCH_WALL_HORIZONTAL_RELATION', lengthKind: 'L2' },
    ];
  }
  return null;
}

function sameTreatmentSet(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) {
    return false;
  }
  const normalize = (item) =>
    JSON.stringify({
      disposition: item?.disposition || null,
      scope: item?.scope || null,
      lengthKind: item?.lengthKind || null,
    });
  return sameStringSet(actual.map(normalize), expected.map(normalize));
}

function topologyMemberIdsValid(topologyFact) {
  const sourceMemberId = text(topologyFact?.sourceMemberId);
  const targetMemberId = text(topologyFact?.targetMemberId);
  if (!sourceMemberId || !targetMemberId || sourceMemberId === targetMemberId) return false;
  if (topologyFact?.topology !== 'T') return true;

  const mainMemberId = text(topologyFact.mainMemberId);
  const branchMemberId = text(topologyFact.branchMemberId);
  return (
    Boolean(mainMemberId && branchMemberId) &&
    mainMemberId !== branchMemberId &&
    [sourceMemberId, targetMemberId].includes(mainMemberId) &&
    [sourceMemberId, targetMemberId].includes(branchMemberId)
  );
}

function topologyContractValid(topologyFact) {
  return (
    SUPPORTED_TOPOLOGIES.has(topologyFact?.topology) &&
    SUPPORTED_PATTERNS.has(topologyFact?.pattern) &&
    SUPPORTED_SPACING_RELATIONS.has(topologyFact?.horizontalSpacingRelation) &&
    topologyMemberIdsValid(topologyFact)
  );
}

function classificationMatchesTopology(topologyFact, classification) {
  if (classification?.status !== 'SOURCE_CLASSIFIED') return false;
  if (!topologyContractValid(topologyFact)) return false;
  if (!Array.isArray(classification.treatments)) return false;
  if (!Array.isArray(classification.requiredLengthKinds)) return false;
  if (
    classification.topology !== topologyFact?.topology ||
    classification.pattern !== topologyFact?.pattern ||
    classification.horizontalSpacingRelation !== topologyFact?.horizontalSpacingRelation
  ) {
    return false;
  }
  const expectedDispositions = requiredDispositionsForTopology(topologyFact);
  const actualDispositions = classification.treatments.map((item) => item?.disposition);
  if (!expectedDispositions || !sameStringSet(actualDispositions, expectedDispositions)) {
    return false;
  }
  const expectedTreatments = expectedTreatmentsForTopology(topologyFact);
  if (!sameTreatmentSet(classification.treatments, expectedTreatments)) return false;
  return sameStringSet(
    classification.requiredLengthKinds,
    requiredLengthKindsForTopology(topologyFact),
  );
}

function zOf(bar) {
  return finite(bar?.junctionPoint?.z);
}

function pairBarsByElevation(sourceBars, targetBars, zToleranceMm) {
  const source = [...sourceBars].sort((a, b) => a.segmentIdentity.localeCompare(b.segmentIdentity));
  const target = [...targetBars].sort((a, b) => a.segmentIdentity.localeCompare(b.segmentIdentity));
  if (source.length !== target.length || source.length === 0) {
    return unresolved('wall-wall-junction-l1-bar-count-mismatch', {
      sourceCount: source.length,
      targetCount: target.length,
    });
  }

  const pairs = [];
  const used = new Set();
  for (const sourceBar of source) {
    const sourceZ = zOf(sourceBar);
    if (sourceZ === null) return unresolved('wall-wall-junction-l1-bar-z-unresolved');
    const candidates = target.filter((targetBar, index) => {
      if (used.has(index)) return false;
      const targetZ = zOf(targetBar);
      return targetZ !== null && Math.abs(sourceZ - targetZ) <= zToleranceMm;
    });
    if (candidates.length !== 1) {
      return unresolved('wall-wall-junction-l1-elevation-pair-unresolved', {
        sourceSegmentIdentity: sourceBar.segmentIdentity,
        candidateCount: candidates.length,
      });
    }
    const targetBar = candidates[0];
    const targetIndex = target.indexOf(targetBar);
    used.add(targetIndex);
    const sourceDia = positive(sourceBar.dia);
    const targetDia = positive(targetBar.dia);
    if (sourceDia === null || targetDia === null) {
      return unresolved('wall-wall-junction-l1-diameter-unresolved', {
        sourceSegmentIdentity: sourceBar.segmentIdentity,
        targetSegmentIdentity: targetBar.segmentIdentity,
      });
    }
    if (Math.abs(sourceDia - targetDia) > 1e-9) {
      return unresolved('wall-wall-junction-l1-diameter-mismatch', {
        sourceSegmentIdentity: sourceBar.segmentIdentity,
        targetSegmentIdentity: targetBar.segmentIdentity,
      });
    }
    if (!sourceBar.grade || !targetBar.grade) {
      return unresolved('wall-wall-junction-l1-grade-unresolved', {
        sourceSegmentIdentity: sourceBar.segmentIdentity,
        targetSegmentIdentity: targetBar.segmentIdentity,
      });
    }
    if (sourceBar.grade !== targetBar.grade) {
      return unresolved('wall-wall-junction-l1-grade-mismatch', {
        sourceSegmentIdentity: sourceBar.segmentIdentity,
        targetSegmentIdentity: targetBar.segmentIdentity,
      });
    }
    pairs.push(Object.freeze({ sourceBar, targetBar }));
  }
  return Object.freeze({ status: 'RESOLVED', pairs: Object.freeze(pairs) });
}

function assignmentKey(junctionKey, disposition, sourceRef, targetRef = null) {
  return ['WALL_WALL_BAR', junctionKey, disposition, sourceRef || '-', targetRef || '-'].join(':');
}

function baseAssignment({
  junctionKey,
  disposition,
  memberId,
  sourceBar,
  targetBar = null,
  length = null,
}) {
  const sourceRef = sourceBar?.segmentIdentity || sourceBar?.semanticIdentity || null;
  const targetRef = targetBar?.segmentIdentity || targetBar?.semanticIdentity || null;
  return Object.freeze({
    assignmentKey: assignmentKey(junctionKey, disposition, sourceRef, targetRef),
    status: 'CANDIDATE',
    reason: null,
    disposition,
    memberId: memberId ? String(memberId) : null,
    sourceRef,
    targetRef,
    sourceSemanticIdentity: sourceBar?.semanticIdentity || null,
    targetSemanticIdentity: targetBar?.semanticIdentity || null,
    sourceFace: sourceBar?.face || null,
    targetFace: targetBar?.face || null,
    sourceCornerSide: sourceBar?.cornerSide || null,
    targetCornerSide: targetBar?.cornerSide || null,
    requiredLengthKind: length?.kind || null,
    requiredLengthMm: length?.requiredMm ?? null,
    designLengthProvenance: length?.provenance || null,
    availability: null,
    spliceGate: null,
    productionReady: false,
  });
}

function l1Drafts(topologyFact, sourceBars, targetBars, lengthFact, zToleranceMm) {
  const paired = pairBarsByElevation(sourceBars, targetBars, zToleranceMm);
  if (paired.status !== 'RESOLVED') return paired;
  return Object.freeze({
    status: 'RESOLVED',
    assignments: Object.freeze(
      paired.pairs.map((pair) =>
        baseAssignment({
          junctionKey: topologyFact.junctionKey,
          disposition: 'L1_LAP',
          memberId: null,
          sourceBar: pair.sourceBar,
          targetBar: pair.targetBar,
          length: lengthFact,
        }),
      ),
    ),
  });
}

function individualAssignments(topologyFact, bars, memberId, disposition, lengthFact = null) {
  return bars.map((bar) =>
    baseAssignment({
      junctionKey: topologyFact.junctionKey,
      disposition,
      memberId,
      sourceBar: bar,
      length: lengthFact,
    }),
  );
}

function barFactValid(bar) {
  return Boolean(
    bar &&
    typeof bar === 'object' &&
    typeof bar.semanticIdentity === 'string' &&
    text(bar.semanticIdentity) &&
    typeof bar.segmentIdentity === 'string' &&
    text(bar.segmentIdentity) &&
    bar.direction === 'HORIZONTAL' &&
    typeof bar.face === 'string' &&
    text(bar.face) &&
    positive(bar.dia) !== null &&
    typeof bar.grade === 'string' &&
    text(bar.grade) &&
    finite(bar.junctionPoint?.z) !== null,
  );
}

function barFactsValid(bars) {
  return Array.isArray(bars) && bars.length > 0 && bars.every(barFactValid);
}

function l1PairingBarsValid(bars) {
  return (
    Array.isArray(bars) &&
    bars.length > 0 &&
    bars.every(
      (bar) =>
        bar &&
        typeof bar === 'object' &&
        typeof bar.semanticIdentity === 'string' &&
        text(bar.semanticIdentity) &&
        typeof bar.segmentIdentity === 'string' &&
        text(bar.segmentIdentity) &&
        bar.direction === 'HORIZONTAL' &&
        typeof bar.face === 'string' &&
        text(bar.face),
    )
  );
}

function usesIndividualBarAssignments(topologyFact) {
  return (
    topologyFact?.topology === 'T' ||
    (topologyFact?.topology === 'L' &&
      (topologyFact.pattern === 'DOUBLE_NET' ||
        topologyFact.horizontalSpacingRelation === 'DIFFERENT'))
  );
}

export function buildWallWallJunctionAssignments(
  topologyFact,
  classification,
  lengths,
  { zToleranceMm = DEFAULT_Z_TOLERANCE_MM } = {},
) {
  const zTolerance = finite(zToleranceMm);
  if (zTolerance === null || zTolerance < 0) {
    throw new RangeError('wall junction assignment zToleranceMm must be finite and non-negative');
  }
  if (topologyFact?.status !== 'RESOLVED') {
    return unresolved(topologyFact?.reason || 'wall-wall-junction-topology-fact-unresolved', {
      topologyFact: topologyFact || null,
    });
  }
  if (!Array.isArray(topologyFact.sourceBars) || !Array.isArray(topologyFact.targetBars)) {
    return unresolved('wall-wall-junction-horizontal-bars-unresolved', {
      topologyFact,
    });
  }
  const sourceBars = [...topologyFact.sourceBars];
  const targetBars = [...topologyFact.targetBars];
  if (sourceBars.length === 0 || targetBars.length === 0) {
    return unresolved('wall-wall-junction-horizontal-bars-unresolved', {
      topologyFact,
    });
  }
  if (!classificationMatchesTopology(topologyFact, classification)) {
    return unresolved('wall-wall-junction-source-treatment-unresolved', {
      topologyFact,
      classification: classification || null,
    });
  }
  const lengthFacts = requiredLengthFactsForTopology(topologyFact, lengths);
  if (!lengthFacts) {
    return unresolved('wall-wall-junction-design-length-unresolved', {
      topologyFact,
    });
  }
  if (
    usesIndividualBarAssignments(topologyFact) &&
    (!barFactsValid(sourceBars) || !barFactsValid(targetBars))
  ) {
    return unresolved('wall-wall-junction-horizontal-bars-unresolved', {
      topologyFact,
    });
  }
  if (
    topologyFact?.topology === 'L' &&
    topologyFact.pattern === 'SINGLE' &&
    topologyFact.horizontalSpacingRelation === 'SAME' &&
    (!l1PairingBarsValid(sourceBars) || !l1PairingBarsValid(targetBars))
  ) {
    return unresolved('wall-wall-junction-l1-bar-unresolved', {
      topologyFact,
    });
  }
  const assignments = [];

  if (topologyFact?.topology === 'L' && topologyFact.pattern === 'SINGLE') {
    if (topologyFact.horizontalSpacingRelation === 'SAME') {
      return l1Drafts(topologyFact, sourceBars, targetBars, lengthFacts.L1, zTolerance);
    }
    assignments.push(
      ...individualAssignments(
        topologyFact,
        sourceBars,
        topologyFact.sourceMemberId,
        'L2_ANCHORAGE',
        lengthFacts.L2,
      ),
      ...individualAssignments(
        topologyFact,
        targetBars,
        topologyFact.targetMemberId,
        'L2_ANCHORAGE',
        lengthFacts.L2,
      ),
    );
  } else if (topologyFact?.topology === 'L' && topologyFact.pattern === 'DOUBLE_NET') {
    if (topologyFact.horizontalSpacingRelation === 'SAME') {
      const sourceOuter = sourceBars.filter((bar) => bar.cornerSide === 'OUTER');
      const targetOuter = targetBars.filter((bar) => bar.cornerSide === 'OUTER');
      const sourceInner = sourceBars.filter((bar) => bar.cornerSide === 'INNER');
      const targetInner = targetBars.filter((bar) => bar.cornerSide === 'INNER');
      if (
        sourceOuter.length === 0 ||
        targetOuter.length === 0 ||
        sourceInner.length === 0 ||
        targetInner.length === 0 ||
        sourceOuter.length + sourceInner.length !== sourceBars.length ||
        targetOuter.length + targetInner.length !== targetBars.length
      ) {
        return unresolved('wall-wall-junction-double-face-assignment-unresolved');
      }
      const l1 = l1Drafts(topologyFact, sourceOuter, targetOuter, lengthFacts.L1, zTolerance);
      if (l1.status !== 'RESOLVED') return l1;
      assignments.push(...l1.assignments);
      // 図11-2-1(2): physical OUTER側をL1、INNER側をL2として扱う。
      assignments.push(
        ...individualAssignments(
          topologyFact,
          sourceInner,
          topologyFact.sourceMemberId,
          'L2_ANCHORAGE',
          lengthFacts.L2,
        ),
        ...individualAssignments(
          topologyFact,
          targetInner,
          topologyFact.targetMemberId,
          'L2_ANCHORAGE',
          lengthFacts.L2,
        ),
      );
    } else {
      assignments.push(
        ...individualAssignments(
          topologyFact,
          sourceBars,
          topologyFact.sourceMemberId,
          'L2_ANCHORAGE',
          lengthFacts.L2,
        ),
        ...individualAssignments(
          topologyFact,
          targetBars,
          topologyFact.targetMemberId,
          'L2_ANCHORAGE',
          lengthFacts.L2,
        ),
      );
    }
  } else if (topologyFact?.topology === 'T') {
    const sourceMemberId = text(topologyFact.sourceMemberId);
    const mainMemberId = text(topologyFact.mainMemberId);
    const branchMemberId = text(topologyFact.branchMemberId);
    const mainBars = mainMemberId === sourceMemberId ? sourceBars : targetBars;
    const branchBars = branchMemberId === sourceMemberId ? sourceBars : targetBars;
    assignments.push(
      ...individualAssignments(topologyFact, mainBars, mainMemberId, 'CONTINUOUS_THROUGH'),
      ...individualAssignments(
        topologyFact,
        branchBars,
        branchMemberId,
        'L2_ANCHORAGE',
        lengthFacts.L2,
      ),
    );
  } else {
    return unresolved('wall-wall-junction-bar-assignment-unresolved', {
      classificationStatus: classification?.status || null,
    });
  }

  assignments.sort((a, b) => a.assignmentKey.localeCompare(b.assignmentKey));
  return Object.freeze({ status: 'RESOLVED', assignments: Object.freeze(assignments) });
}

function normalizeAvailability(value, draft, toleranceMm) {
  // available lengthはgeometry/source provenanceを伴うnormalized factだけを受け取る。
  // 数値単体は由来を追跡できないため、十分な長さであってもfail-closedする。
  if (typeof value === 'number') return null;
  if (!value || typeof value !== 'object') return null;
  if (value.status === 'REJECTED' || value.status === 'UNRESOLVED') {
    return Object.freeze({ ...value });
  }
  const sourceMm = positive(value.sourceMm ?? value.availableMm ?? value.lengthMm);
  const targetRequired = Boolean(draft.targetSemanticIdentity);
  const targetMm = targetRequired
    ? positive(value.targetMm ?? value.availableTargetMm)
    : (positive(value.targetMm ?? value.availableTargetMm) ?? null);
  const provenance = normalizeProvenance(value.provenance ?? value.source);
  if (sourceMm === null || (targetRequired && targetMm === null) || !provenance) return null;
  const minimum = targetRequired ? Math.min(sourceMm, targetMm) : sourceMm;
  return Object.freeze({
    status: minimum + toleranceMm >= draft.requiredLengthMm ? 'PASS' : 'REJECTED',
    sourceMm,
    targetMm,
    provenance,
    reason:
      minimum + toleranceMm >= draft.requiredLengthMm
        ? null
        : 'wall-wall-junction-required-length-not-available',
  });
}

function resolveAvailabilityEvaluation(draft, options) {
  if (!draft.requiredLengthKind) return Object.freeze({ status: 'PASS', notRequired: true });
  let value = null;
  if (typeof options?.availableLengthResolver === 'function') {
    try {
      value = options.availableLengthResolver(draft);
    } catch {
      return Object.freeze({
        status: 'UNRESOLVED',
        reason: 'wall-wall-junction-available-length-evaluator-error',
      });
    }
  } else if (options?.availableLengthEvaluations) {
    value = mapValue(options.availableLengthEvaluations, draft.assignmentKey);
  } else if (options?.availableLengths) {
    value = mapValue(options.availableLengths, draft.assignmentKey);
  }
  return normalizeAvailability(value, draft, options.lengthToleranceMm);
}

function resolveSpliceEvaluation(draft, options) {
  let value = null;
  if (typeof options?.spliceGateResolver === 'function') {
    try {
      value = options.spliceGateResolver(draft);
    } catch {
      return Object.freeze({
        status: 'UNRESOLVED',
        ruleId: 'WALL-SPLICE-IN-WALL',
        reason: 'wall-wall-junction-l1-splice-gate-evaluator-error',
      });
    }
  } else if (options?.spliceGateEvaluations) {
    value = mapValue(options.spliceGateEvaluations, draft.assignmentKey);
  } else if (options?.spliceGate) {
    value = options.spliceGate;
  }
  return normalizedEvaluation(value, 'WALL-SPLICE-IN-WALL');
}

function evaluateAssignment(draft, options) {
  if (!draft.requiredLengthKind) {
    return Object.freeze({ ...draft, status: 'RESOLVED', reason: null });
  }

  let spliceGate = null;
  if (draft.disposition === 'L1_LAP') {
    spliceGate = resolveSpliceEvaluation(draft, options);
    if (!spliceGate || spliceGate.status === 'UNRESOLVED') {
      return Object.freeze({
        ...draft,
        status: 'UNRESOLVED',
        reason: spliceGate?.reason || 'wall-wall-junction-l1-splice-gate-unresolved',
        spliceGate: spliceGate || null,
      });
    }
    if (spliceGate.status === 'REJECTED') {
      return Object.freeze({
        ...draft,
        status: 'REJECTED',
        reason: spliceGate.reason || 'wall-wall-junction-l1-splice-hard-reject',
        spliceGate,
      });
    }
  }

  const availability = resolveAvailabilityEvaluation(draft, options);
  if (!availability || availability.status === 'UNRESOLVED') {
    return Object.freeze({
      ...draft,
      status: 'UNRESOLVED',
      reason: availability?.reason || 'wall-wall-junction-available-length-unresolved',
      availability: availability || null,
      spliceGate,
    });
  }
  if (availability.status === 'REJECTED') {
    return Object.freeze({
      ...draft,
      status: 'REJECTED',
      reason: availability.reason || 'wall-wall-junction-required-length-not-available',
      availability,
      spliceGate,
    });
  }

  return Object.freeze({
    ...draft,
    status: 'RESOLVED',
    reason: null,
    availability,
    spliceGate,
  });
}

function assignmentDraftValid(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
  if (
    draft.status !== 'CANDIDATE' ||
    typeof draft.assignmentKey !== 'string' ||
    !text(draft.assignmentKey) ||
    typeof draft.disposition !== 'string' ||
    !SUPPORTED_ASSIGNMENT_DISPOSITIONS.has(draft.disposition) ||
    typeof draft.sourceRef !== 'string' ||
    !text(draft.sourceRef) ||
    typeof draft.sourceSemanticIdentity !== 'string' ||
    !text(draft.sourceSemanticIdentity) ||
    typeof draft.sourceFace !== 'string' ||
    !text(draft.sourceFace)
  ) {
    return false;
  }
  if (draft.disposition === 'L1_LAP') {
    if (
      typeof draft.targetRef !== 'string' ||
      !text(draft.targetRef) ||
      typeof draft.targetSemanticIdentity !== 'string' ||
      !text(draft.targetSemanticIdentity) ||
      typeof draft.targetFace !== 'string' ||
      !text(draft.targetFace)
    ) {
      return false;
    }
  } else if (!text(draft.memberId)) {
    return false;
  }
  if (draft.disposition === 'CONTINUOUS_THROUGH') {
    return draft.requiredLengthKind === null || draft.requiredLengthKind === undefined;
  }
  return (
    (draft.requiredLengthKind === 'L1' || draft.requiredLengthKind === 'L2') &&
    positive(draft.requiredLengthMm) !== null &&
    Boolean(normalizeProvenance(draft.designLengthProvenance))
  );
}

export function evaluateWallWallJunctionAssignments(
  assignments,
  {
    availableLengths = null,
    availableLengthEvaluations = null,
    availableLengthResolver = null,
    lengthToleranceMm = DEFAULT_LENGTH_TOLERANCE_MM,
    ...spliceOptions
  } = {},
) {
  const tolerance = finite(lengthToleranceMm);
  if (tolerance === null || tolerance < 0) {
    throw new RangeError(
      'wall junction treatment lengthToleranceMm must be finite and non-negative',
    );
  }
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return Object.freeze({
      status: 'UNRESOLVED',
      reason: 'wall-wall-junction-assignments-missing',
      assignments: Object.freeze([]),
      productionReady: false,
    });
  }
  if (!assignments.every(assignmentDraftValid)) {
    return Object.freeze({
      status: 'UNRESOLVED',
      reason: 'wall-wall-junction-assignment-facts-unresolved',
      assignments: Object.freeze([]),
      productionReady: false,
    });
  }
  const options = {
    availableLengths,
    availableLengthEvaluations,
    availableLengthResolver,
    lengthToleranceMm: tolerance,
    ...spliceOptions,
  };
  const values = (assignments || []).map((assignment) => evaluateAssignment(assignment, options));
  values.sort((a, b) => a.assignmentKey.localeCompare(b.assignmentKey));
  const rejectedValues = values.filter((value) => value.status === 'REJECTED');
  if (rejectedValues.length) {
    return Object.freeze({
      status: 'REJECTED',
      reason: rejectedValues[0].reason,
      assignments: Object.freeze(values),
      productionReady: false,
    });
  }
  const unresolvedValues = values.filter((value) => value.status === 'UNRESOLVED');
  if (unresolvedValues.length) {
    return Object.freeze({
      status: 'UNRESOLVED',
      reason: unresolvedValues[0].reason,
      assignments: Object.freeze(values),
      productionReady: false,
    });
  }
  return Object.freeze({
    status: 'RESOLVED',
    reason: null,
    assignments: Object.freeze(values),
    productionReady: false,
  });
}

export const __testOnly = Object.freeze({
  designLengthFact,
  pairBarsByElevation,
  assignmentKey,
  normalizeAvailability,
});
