/**
 * @fileoverview 壁筋の属性・隣接・継手・壁接合部ゲートのDecision Trace。
 * 入力factsは読み取り専用。判定記録をproduction geometryへ戻さない。
 */

import { createTrace } from './rebarDecisionTrace.js';

function wallSpliceRegionSource(region) {
  if (!region?.memberType || !region?.memberId) return null;
  const prefix =
    region.memberType === 'COLUMN'
      ? 'StbColumn'
      : region.memberType === 'GIRDER'
        ? 'StbGirder'
        : region.memberType === 'BEAM'
          ? 'StbBeam'
          : null;
  return prefix ? `${prefix}:${region.memberId}` : null;
}

function wallWallSourceRuleIds(classification) {
  const ids = [];
  for (const treatment of classification?.treatments || []) {
    if (treatment?.disposition === 'L1_LAP') ids.push('WALL-WALL-L1-LAP');
    if (treatment?.disposition === 'L2_ANCHORAGE') ids.push('WALL-WALL-L2-ANCHORAGE');
    if (treatment?.disposition === 'CONTINUOUS_THROUGH') ids.push('WALL-WALL-T-MAIN-THROUGH');
  }
  if (classification?.status === 'REJECTED') {
    ids.push('WALL-JUNCTION-SUPPLEMENTAL-MIN-DIA');
  }
  if (classification?.status === 'UNRESOLVED') {
    ids.push('REBAR-FAIL-CLOSED-UNRESOLVED');
  }
  return [...new Set(ids)];
}

export function buildWallWallJunctionSourceDecisionTraces(
  classifications,
  { modelSource = null } = {},
) {
  const values = Array.isArray(classifications)
    ? classifications
    : classifications
      ? [classifications]
      : [];
  const result = [];
  for (const [index, classification] of values.entries()) {
    const unresolved = classification?.status === 'UNRESOLVED';
    const rejected = classification?.status === 'REJECTED';
    const disposition = unresolved
      ? 'UNRESOLVED'
      : rejected
        ? 'SOURCE_TREATMENT_REJECTED'
        : 'SOURCE_TREATMENT_CLASSIFIED';
    result.push(
      createTrace({
        decisionId: `WALL_WALL_SOURCE:${modelSource || '-'}:${index}`,
        subjectType: 'WALL_WALL_SOURCE_TREATMENT',
        subjectKey: `${classification?.topology || '-'}:${classification?.pattern || '-'}:${classification?.horizontalSpacingRelation || '-'}:${index}`,
        disposition,
        appliedRuleIds: wallWallSourceRuleIds(classification),
        metrics: {
          treatmentCount: classification?.treatments?.length,
        },
        unresolvedReason: unresolved
          ? classification.reason || 'wall-wall-source-treatment-unresolved'
          : null,
        rejectedAlternatives: rejected ? [classification] : [],
        sources: classification?.sourceFigure
          ? [`NIKKENREN_JSCA_RC_DETAILING_20230401_FIG_${classification.sourceFigure}`]
          : [],
        modelSource,
      }),
    );
  }
  return Object.freeze(result);
}

export function buildWallJunctionSupplementalGateDecisionTraces(
  evaluations,
  { modelSource = null } = {},
) {
  const values = Array.isArray(evaluations) ? evaluations : evaluations ? [evaluations] : [];
  const result = [];
  for (const [index, evaluation] of values.entries()) {
    const unresolved = evaluation?.status === 'UNRESOLVED';
    const disposition =
      evaluation?.status === 'PASS'
        ? 'SUPPLEMENTAL_DIA_ACCEPTED'
        : evaluation?.status === 'REJECTED'
          ? 'SUPPLEMENTAL_DIA_REJECTED'
          : 'UNRESOLVED';
    const appliedRuleIds = ['WALL-JUNCTION-SUPPLEMENTAL-MIN-DIA'];
    if (unresolved) appliedRuleIds.push('REBAR-FAIL-CLOSED-UNRESOLVED');
    result.push(
      createTrace({
        decisionId: `WALL_JUNCTION_SUPPLEMENTAL:${modelSource || '-'}:${index}`,
        subjectType: 'WALL_JUNCTION_SUPPLEMENTAL',
        subjectKey: `${modelSource || '-'}:${index}`,
        disposition,
        appliedRuleIds,
        metrics: {
          verticalDiaMm: evaluation?.directions?.vertical?.actualDiaMm,
          verticalRequiredDiaMm: evaluation?.directions?.vertical?.requiredDiaMm,
          horizontalDiaMm: evaluation?.directions?.horizontal?.actualDiaMm,
          horizontalRequiredDiaMm: evaluation?.directions?.horizontal?.requiredDiaMm,
        },
        unresolvedReason: unresolved
          ? evaluation.reason || 'wall-junction-supplemental-dia-unresolved'
          : null,
        rejectedAlternatives:
          evaluation?.status === 'REJECTED'
            ? [evaluation?.directions?.vertical, evaluation?.directions?.horizontal].filter(
                (item) => item?.status === 'REJECTED',
              )
            : [],
        sources: ['NIKKENREN_JSCA_RC_DETAILING_20230401_§11-2'],
        modelSource,
      }),
    );
  }
  return Object.freeze(result);
}

export function buildWallRebarSpliceGateDecisionTraces(evaluations, { modelSource = null } = {}) {
  const result = [];
  for (const [index, evaluation] of (evaluations || []).entries()) {
    const unresolved = evaluation?.status === 'UNRESOLVED';
    const disposition =
      evaluation?.status === 'PASS'
        ? 'SPLICE_REGION_ACCEPTED'
        : evaluation?.status === 'REJECTED'
          ? 'SPLICE_REGION_REJECTED'
          : 'UNRESOLVED';
    const appliedRuleIds = ['WALL-SPLICE-IN-WALL'];
    if (unresolved) appliedRuleIds.push('REBAR-FAIL-CLOSED-UNRESOLVED');
    result.push(
      createTrace({
        decisionId:
          evaluation?.candidateKey ||
          `WALL_SPLICE:${modelSource || '-'}:${evaluation?.wallMemberId || '-'}:${index}`,
        subjectType: 'WALL_SPLICE_REGION',
        subjectKey:
          evaluation?.candidateKey ||
          evaluation?.barIdentity ||
          `${evaluation?.wallMemberId || '-'}:${index}`,
        disposition,
        appliedRuleIds,
        metrics: {
          spliceStartStationMm: evaluation?.candidateInterval?.startStationMm,
          spliceEndStationMm: evaluation?.candidateInterval?.endStationMm,
          blockingRegionCount: evaluation?.blockingRegions?.length,
        },
        unresolvedReason: unresolved ? evaluation.reason || 'wall-splice-region-unresolved' : null,
        sourceRef: evaluation?.barIdentity || null,
        rejectedAlternatives:
          evaluation?.status === 'REJECTED' ? evaluation.blockingRegions || [] : [],
        sources: [
          evaluation?.wallMemberId ? `StbWall:${evaluation.wallMemberId}` : null,
          ...(evaluation?.blockingRegions || []).map(wallSpliceRegionSource),
        ],
        modelSource,
      }),
    );
  }
  return Object.freeze(result);
}

export function buildWallRebarAdjacencyDecisionTraces(adjacency) {
  const result = [];
  for (const candidate of adjacency?.candidates || []) {
    result.push(
      createTrace({
        decisionId: candidate.candidateKey,
        subjectType: 'WALL_BAR_ADJACENCY',
        subjectKey: candidate.candidateKey,
        disposition: 'ADJACENT_CANDIDATE',
        appliedRuleIds: ['REBAR-SEMANTIC-IDENTITY-MATCH', 'WALL-ADJACENCY-ONE-TO-ONE'],
        metrics: {
          boundaryLengthMm: candidate.boundaryLengthMm,
          endpointGapMm: candidate.endpointGapMm,
          axisDotAbs: candidate.axisDotAbs,
        },
        sourceRef: candidate.sourceSegmentIdentity || candidate.sourceIdentity || null,
        targetRef: candidate.targetSegmentIdentity || candidate.targetIdentity || null,
        sources: [
          candidate.sourceMemberId ? `StbWall:${candidate.sourceMemberId}` : null,
          candidate.targetMemberId ? `StbWall:${candidate.targetMemberId}` : null,
        ],
        modelSource: candidate.modelSource || adjacency?.modelSource || null,
      }),
    );
  }

  for (const [index, unresolved] of (adjacency?.unresolved || []).entries()) {
    const sourceRef =
      unresolved.sourceSegmentIdentity ||
      unresolved.sourceIdentity ||
      unresolved.sourceMemberId ||
      null;
    const targetRef =
      unresolved.targetSegmentIdentity ||
      unresolved.targetIdentity ||
      unresolved.targetMemberId ||
      null;
    result.push(
      createTrace({
        decisionId:
          unresolved.decisionId ||
          `WALL_ADJACENCY:${adjacency?.modelSource || '-'}:UNRESOLVED:${index}`,
        subjectType: unresolved.subjectType || 'WALL_ADJACENCY',
        subjectKey:
          unresolved.boundaryKey ||
          unresolved.sourceSegmentIdentity ||
          unresolved.targetSegmentIdentity ||
          `UNRESOLVED:${index}`,
        disposition: 'UNRESOLVED',
        appliedRuleIds: ['WALL-ADJACENCY-ONE-TO-ONE', 'REBAR-FAIL-CLOSED-UNRESOLVED'],
        unresolvedReason: unresolved.reason || 'wall-adjacency-unresolved',
        sourceRef,
        targetRef,
        rejectedAlternatives: [unresolved],
        sources: [
          unresolved.sourceMemberId ? `StbWall:${unresolved.sourceMemberId}` : null,
          unresolved.targetMemberId ? `StbWall:${unresolved.targetMemberId}` : null,
        ],
        modelSource: adjacency?.modelSource || null,
      }),
    );
  }

  return Object.freeze(result);
}

export function buildWallRebarSemanticDecisionTraces(topology) {
  const result = [];
  for (const [index, fact] of (topology?.facts || []).entries()) {
    result.push(
      createTrace({
        decisionId: `WALL:${fact.modelSource || '-'}:${fact.memberId}:SEMANTIC:${fact.barIndex}:${fact.segmentIndex}`,
        subjectType: 'WALL_BAR_SEMANTIC',
        subjectKey: fact.segmentIdentity || fact.semanticIdentity || `WALL:${index}`,
        disposition: 'CLASSIFIED',
        appliedRuleIds: ['REBAR-SEMANTIC-IDENTITY-MATCH'],
        sourceRef: fact.sourceIdentityKey || null,
        sources: [
          fact.memberId ? `StbWall:${fact.memberId}` : null,
          fact.sectionId ? `StbSecWall_RC:${fact.sectionId}` : null,
        ],
        modelSource: fact.modelSource || null,
      }),
    );
  }
  for (const [index, unresolved] of (topology?.unresolved || []).entries()) {
    result.push(
      createTrace({
        decisionId: `WALL:${unresolved.modelSource || '-'}:${unresolved.memberId || '-'}:SEMANTIC_UNRESOLVED:${index}`,
        subjectType: 'WALL_BAR_SEMANTIC',
        subjectKey: unresolved.sourceIdentityKey || `WALL_UNRESOLVED:${index}`,
        disposition: 'UNRESOLVED',
        appliedRuleIds: ['REBAR-FAIL-CLOSED-UNRESOLVED'],
        unresolvedReason: unresolved.reason || 'wall-semantic-unresolved',
        sourceRef: unresolved.sourceIdentityKey || null,
        sources: [unresolved.memberId ? `StbWall:${unresolved.memberId}` : null],
        modelSource: unresolved.modelSource || null,
      }),
    );
  }
  return Object.freeze(result);
}
