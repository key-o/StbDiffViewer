/**
 * @fileoverview Issue #292: resolved cross-member conflict candidateを
 * member-specific beam layout cloneへ限定適用するproduction adapter。
 *
 * 初期production scope:
 * - movedBarがRC大梁主筋（StbGirder。StbBeamはresolver/traceのみ）
 * - SIDE_OUTER_BAR_INSET
 * - section roll = 0
 * - single-segment full-span layout
 * - Appendix A2 side-joint はwhole-member shiftへ拡大せず、対象endpointだけを内寄せする
 * - endpoint-local doglegとgeneric 90° anchorageを同じshift factへ追従させる
 * - STB explicit horizontal datumを上書きしない
 * - member内に未解決conflictが1件でもあればatomic rollback
 *
 * 多区間barとlayer escalationはこのsliceでは生成しない。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { buildBeamMemberRebarPaths } from './beamRebarPathBuilder.js';
import { buildDoglegTransitionPath } from './rebarTransitionArcGeometry.js';
import {
  collectRcColumnBeamPlacementConflictCandidates,
  resolveRebarPlacementConflictActivation,
} from './rebarPlacementConflictCandidates.js';

const EPS = 1e-6;

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim().toUpperCase();
}

function finite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cloneBar(bar) {
  return { ...bar };
}

function sameBarFingerprint(actual, expected) {
  const actualU = finite(actual?.u);
  const actualV = finite(actual?.v);
  const expectedU = finite(expected?.localPosition?.u);
  const expectedV = finite(expected?.localPosition?.v);
  return (
    actualU !== null &&
    actualV !== null &&
    expectedU !== null &&
    expectedV !== null &&
    Math.abs(actualU - expectedU) <= EPS &&
    Math.abs(actualV - expectedV) <= EPS &&
    text(actual?.role) === text(expected?.role) &&
    String(actual?.layer ?? '') === String(expected?.layer ?? '') &&
    Number(actual?.dia) === Number(expected?.dia) &&
    text(actual?.diaName || actual?.dia) === text(expected?.diaName || expected?.dia) &&
    text(actual?.grade) === text(expected?.grade)
  );
}

function protectedHorizontalDatum(beam) {
  // A2 side is expressed in a node-outward joint frame, which reverses at the
  // member end. STB left/right datum, however, belongs to the section-local u
  // frame, so choose the protected side from topology/local-u instead.
  const topologyPosition = text(beam?.topologyPosition);
  let key = topologyPosition.endsWith(':RIGHT')
    ? 'right'
    : topologyPosition.endsWith(':LEFT')
      ? 'left'
      : null;
  if (!key) {
    const localU = finite(beam?.localPosition?.u);
    if (localU !== null && Math.abs(localU) > EPS) {
      key = localU > 0 ? 'right' : 'left';
    }
  }
  const source = key ? String(beam?.sidePositionSources?.[key] || '') : '';
  return {
    protected: source.startsWith('stb-'),
    source: source || null,
    side: key,
  };
}

function localDeltaU(candidate) {
  const movement = candidate?.movement;
  // candidate movement is expressed in world coordinates using the joint-outward
  // transverse axis. Layout u, however, is based on the member start->end section
  // basis and reverses relative to the joint axis at the end endpoint.
  const transverse =
    candidate?.beam?.sectionTransverseDirection || candidate?.beam?.transverseDirection;
  if (
    movement?.kind !== 'TRANSLATE_PLAN' ||
    movement?.effectType !== 'SIDE_OUTER_BAR_INSET' ||
    !transverse ||
    !movement?.vector
  ) {
    return null;
  }
  const distanceMm = finite(movement.distanceMm);
  const vx = finite(movement.vector.x);
  const vy = finite(movement.vector.y);
  if (distanceMm === null || vx === null || vy === null) return null;
  const projection = vx * transverse.x + vy * transverse.y;
  if (Math.abs(Math.abs(projection) - 1) > 1e-6) return null;
  return projection * distanceMm;
}

function endpointInsetGeometry(candidate, deltaU) {
  const axialDistanceMm = finite(candidate?.geometry?.axialDistanceMm);
  const columnOuterDiameterMm = finite(candidate?.geometry?.columnOuterDiameterMm);
  const beamOuterDiameterMm = finite(candidate?.geometry?.beamOuterDiameterMm);
  const collisionToleranceMm = finite(candidate?.geometry?.collisionToleranceMm) ?? 0.5;
  const memberLengthMm = finite(candidate?.beam?.memberLengthMm);
  const diaMm = finite(candidate?.beam?.dia);
  const grade = candidate?.beam?.grade;

  if (
    axialDistanceMm === null ||
    !(columnOuterDiameterMm > 0) ||
    !(beamOuterDiameterMm > 0) ||
    !(memberLengthMm > 0) ||
    !(diaMm > 0) ||
    !grade
  ) {
    return { ok: false, reason: 'rebar-placement-conflict-endpoint-dogleg-input-unresolved' };
  }

  const transitionRunMm = Math.max(6 * Math.abs(deltaU), Math.abs(deltaU) + EPS);
  const probe = buildDoglegTransitionPath({
    sharpStart: { x: 0, y: 0, z: 0 },
    sharpEnd: { x: deltaU, y: 0, z: transitionRunMm },
    incomingDirection: { x: 0, y: 0, z: 1 },
    outgoingDirection: { x: 0, y: 0, z: 1 },
    grade,
    barDiaMm: diaMm,
    metadata: { dia: diaMm, grade, source: 'issue317-endpoint-inset-probe' },
  });
  if (!probe.ok || !probe.path) {
    return {
      ok: false,
      reason: probe.reason || 'rebar-placement-conflict-endpoint-dogleg-bend-unresolved',
    };
  }

  const radialClearMm = (columnOuterDiameterMm + beamOuterDiameterMm) / 2;
  const requiredLeadMm =
    Math.max(0, axialDistanceMm) + radialClearMm + Math.max(0, collisionToleranceMm);
  // sharpStartより手前にstart Arcの接点があるため、柱主筋clearance境界から
  // tangentDistance分だけさらに梁スパン側へ送って、Arc自体も柱主筋の外へ出す。
  const transitionLeadMm =
    requiredLeadMm + probe.startCorner.tangentDistanceMm + EPS;
  const requiredMemberMm =
    transitionLeadMm + transitionRunMm + probe.endCorner.tangentDistanceMm + EPS;
  if (!(memberLengthMm > requiredMemberMm)) {
    return {
      ok: false,
      reason: 'rebar-placement-conflict-endpoint-dogleg-member-length-insufficient',
      memberLengthMm,
      requiredMemberMm,
    };
  }

  return {
    ok: true,
    reason: null,
    transitionLeadMm,
    transitionRunMm,
    memberLengthMm,
    axialDistanceMm,
    radialClearMm,
    collisionToleranceMm,
    startTangentMm: probe.startCorner.tangentDistanceMm,
    endTangentMm: probe.endCorner.tangentDistanceMm,
  };
}

function memberDraft(memberId, memberTag, sectionId) {
  return {
    memberId,
    memberTag,
    sectionId,
    status: 'READY',
    reason: null,
    applicationMode: 'ENDPOINT_LOCAL',
    barShifts: new Map(),
    endpointShifts: new Map(),
    candidateKeys: [],
    rejectedCandidates: [],
    preflight: null,
  };
}

function rejectDraft(draft, candidate, reason, extra = {}) {
  draft.status = 'UNRESOLVED';
  draft.reason = draft.reason || reason;
  draft.rejectedCandidates.push({
    key: candidate?.key || null,
    reason,
    ...extra,
  });
}

function candidateExpectedBar(candidate) {
  return {
    role: candidate?.beam?.role ?? null,
    layer: candidate?.beam?.layer ?? null,
    dia: candidate?.beam?.dia ?? null,
    diaName: candidate?.beam?.diaName ?? null,
    grade: candidate?.beam?.grade ?? null,
    localPosition: candidate?.beam?.localPosition ? { ...candidate.beam.localPosition } : null,
  };
}

function sameExpectedBar(left, right) {
  if (!left || !right) return false;
  return sameBarFingerprint(
    {
      u: left.localPosition?.u,
      v: left.localPosition?.v,
      role: left.role,
      layer: left.layer,
      dia: left.dia,
      diaName: left.diaName,
      grade: left.grade,
    },
    right,
  );
}

function mergeShift(draft, candidate, deltaU, insetGeometry) {
  const index = Number(candidate?.beam?.barIndex);
  if (!Number.isInteger(index) || index < 0) {
    rejectDraft(draft, candidate, 'rebar-placement-conflict-beam-bar-index-unresolved');
    return;
  }

  const endpoint = String(candidate?.beam?.sourceEndpoint || '');
  if (!['start', 'end'].includes(endpoint)) {
    rejectDraft(draft, candidate, 'rebar-placement-conflict-beam-endpoint-unresolved');
    return;
  }

  const expectedBar = candidateExpectedBar(candidate);
  const endpointKey = `${endpoint}|${index}`;
  const existingEndpoint = draft.endpointShifts.get(endpointKey);
  if (existingEndpoint) {
    if (
      Math.abs(existingEndpoint.deltaU - deltaU) > EPS ||
      !sameExpectedBar(existingEndpoint.expectedBar, expectedBar)
    ) {
      rejectDraft(draft, candidate, 'rebar-placement-conflict-endpoint-shift-conflict', {
        barIndex: index,
        endpoint,
        existingDeltaU: existingEndpoint.deltaU,
        requestedDeltaU: deltaU,
      });
      return;
    }
    existingEndpoint.sourceRuleIds = [
      ...new Set([
        ...existingEndpoint.sourceRuleIds,
        ...(candidate.decision?.supportingRuleIds || []),
      ]),
    ].sort();
    existingEndpoint.candidateKeys.push(candidate.key);
    return;
  }

  const shift = {
    barIndex: index,
    endpoint,
    deltaU,
    semanticIdentity: candidate.beam.semanticIdentity,
    expectedBar,
    sourceRuleIds: (candidate.decision?.supportingRuleIds || []).slice(),
    candidateKeys: [candidate.key],
    movement: candidate.movement ? { ...candidate.movement } : null,
    transitionLeadMm: insetGeometry.transitionLeadMm,
    transitionRunMm: insetGeometry.transitionRunMm,
    memberLengthMm: insetGeometry.memberLengthMm,
    axialDistanceMm: insetGeometry.axialDistanceMm,
    radialClearMm: insetGeometry.radialClearMm,
    collisionToleranceMm: insetGeometry.collisionToleranceMm,
  };
  draft.endpointShifts.set(endpointKey, shift);

  // barShiftsはDecision Trace/後方互換用の集約値として保持する。
  // endpoint-local productionではstart/endのdeltaUが異なっても許容し、layout全体は移動しない。
  const aggregate = draft.barShifts.get(index);
  if (!aggregate) {
    draft.barShifts.set(index, {
      ...shift,
      endpoints: [endpoint],
      endpointLocalOnly: true,
    });
  } else if (
    Math.abs(aggregate.deltaU - deltaU) <= EPS &&
    sameExpectedBar(aggregate.expectedBar, expectedBar)
  ) {
    aggregate.endpoints = [...new Set([...aggregate.endpoints, endpoint])].sort();
    aggregate.sourceRuleIds = [
      ...new Set([...aggregate.sourceRuleIds, ...(candidate.decision?.supportingRuleIds || [])]),
    ].sort();
    aggregate.candidateKeys.push(candidate.key);
  } else {
    aggregate.endpointLocalOnly = true;
    aggregate.divergentEndpointShift = true;
  }
}

function endpointInsetSpecsForPreflight(draft) {
  return [...(draft?.endpointShifts?.values?.() || [])].map((shift) => ({
    endpoint: shift.endpoint,
    barIndex: shift.barIndex,
    deltaU: shift.deltaU,
    expectedBar: shift.expectedBar ? { ...shift.expectedBar } : null,
    sourceRuleIds: (shift.sourceRuleIds || []).slice(),
    candidateKeys: (shift.candidateKeys || []).slice(),
    movement: shift.movement ? { ...shift.movement } : null,
    transitionLeadMm: shift.transitionLeadMm,
    transitionRunMm: shift.transitionRunMm,
    memberLengthMm: shift.memberLengthMm,
    axialDistanceMm: shift.axialDistanceMm,
    radialClearMm: shift.radialClearMm,
    collisionToleranceMm: shift.collisionToleranceMm,
  }));
}

function cloneLayoutForPreflight(layout) {
  return {
    ...layout,
    segments: (layout?.segments || []).map((segment) => ({
      ...segment,
      bars: (segment?.bars || []).map((bar) => cloneBar(bar)),
    })),
  };
}

function preflightEndpointInsets(draft, layout) {
  const specs = endpointInsetSpecsForPreflight(draft);
  if (!specs.length) {
    return { ok: true, status: 'NO_SHIFT', appliedCount: 0, unresolved: [] };
  }
  const lengths = [
    ...new Set(
      specs
        .map((spec) => finite(spec.memberLengthMm))
        .filter((value) => value !== null)
        .map((value) => value.toFixed(6)),
    ),
  ].map(Number);
  if (lengths.length !== 1 || !(lengths[0] > 0)) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason: 'rebar-placement-conflict-preflight-member-length-ambiguous',
      appliedCount: 0,
      unresolved: [],
    };
  }

  const built = buildBeamMemberRebarPaths(cloneLayoutForPreflight(layout), lengths[0], {
    memberId: draft.memberId,
    endpointInsets: specs,
  });
  const transition = built?.placementConflictTransitions || {};
  const unresolved = Array.isArray(transition.unresolved) ? transition.unresolved : [];
  const appliedCount = Array.isArray(transition.applied) ? transition.applied.length : 0;
  if (unresolved.length > 0 || appliedCount !== specs.length) {
    return {
      ok: false,
      status: 'UNRESOLVED',
      reason:
        unresolved[0]?.reason ||
        'rebar-placement-conflict-endpoint-dogleg-preflight-incomplete',
      appliedCount,
      unresolved,
    };
  }

  return {
    ok: true,
    status: 'PASS',
    appliedCount,
    unresolved: [],
  };
}

function finalizeDraft(draft, layout) {
  if (draft.status !== 'READY') return draft;
  if (!layout) {
    draft.status = 'UNRESOLVED';
    draft.reason = 'rebar-placement-conflict-member-layout-unresolved';
    return draft;
  }
  if ((layout.segments || []).length !== 1) {
    draft.status = 'UNRESOLVED';
    draft.reason = 'rebar-placement-conflict-multi-segment-member-not-supported';
    return draft;
  }
  const segment = layout.segments[0];
  if (
    Math.abs(Number(segment?.startRatio)) > EPS ||
    Math.abs(Number(segment?.endRatio) - 1) > EPS
  ) {
    draft.status = 'UNRESOLVED';
    draft.reason = 'rebar-placement-conflict-single-segment-full-span-required';
    return draft;
  }
  for (const shift of draft.endpointShifts.values()) {
    const actual = segment?.bars?.[shift.barIndex];
    if (!sameBarFingerprint(actual, shift.expectedBar)) {
      draft.status = 'UNRESOLVED';
      draft.reason = 'rebar-placement-conflict-bar-fingerprint-mismatch';
      break;
    }
    const matchingBars = (segment?.bars || []).filter((bar) =>
      sameBarFingerprint(bar, shift.expectedBar),
    );
    if (matchingBars.length !== 1) {
      draft.status = 'UNRESOLVED';
      draft.reason = 'rebar-placement-conflict-bar-fingerprint-ambiguous';
      break;
    }
  }
  if (draft.status === 'READY' && draft.endpointShifts.size === 0) {
    draft.status = 'NO_SHIFT';
    draft.preflight = { status: 'NO_SHIFT', appliedCount: 0, unresolved: [] };
    return draft;
  }

  if (draft.status === 'READY') {
    const preflight = preflightEndpointInsets(draft, layout);
    draft.preflight = preflight;
    if (!preflight.ok) {
      draft.status = 'UNRESOLVED';
      draft.reason = preflight.reason;
      draft.rejectedCandidates.push({
        key: null,
        reason: preflight.reason,
        appliedCount: preflight.appliedCount,
        unresolved: preflight.unresolved,
      });
    }
  }
  return draft;
}

export function rebarPlacementConflictMemberKey(memberTypeOrTag, memberId) {
  const type = text(memberTypeOrTag);
  const memberTag =
    type === 'BEAM' || type === 'STBBEAM'
      ? 'StbBeam'
      : type === 'GIRDER' || type === 'STBGIRDER'
        ? 'StbGirder'
        : null;
  const id = String(memberId ?? '').trim();
  return memberTag && id ? `${memberTag}:${id}` : null;
}

function existingPathMutation(memberId, memberTag, options = {}) {
  const id = String(memberId);
  const endpointTrims =
    memberTag === 'StbGirder' ? options.jointTransitionPlan?.memberEndTrims?.get?.(id) || [] : [];
  const haunchTransitions =
    memberTag === 'StbGirder'
      ? options.haunchTransitionPlan?.memberTransitions?.get?.(id) || []
      : [];
  const memberKind = memberTag === 'StbBeam' ? 'beam' : 'girder';
  const anchorageMap =
    options.anchoragePieceMaps?.[memberKind] || options.anchoragePieceMap || null;
  const cutoffMap = options.cutoffPieceMaps?.[memberKind] || options.cutoffPieceMap || null;
  const anchorage = anchorageMap?.get?.(id) || null;
  const cutoff = cutoffMap?.get?.(id) || null;
  const foundation =
    memberTag === 'StbGirder'
      ? options.foundationBeamAnchorageRenderPlan?.members?.get?.(id) || null
      : null;

  const anchoragePieceCount = anchorage?.pieces?.length || 0;
  const appendixA2AnchoragePathCount = anchorage?.appendixA2CornerAnchoragePaths?.length || 0;
  const cutoffPieceCount = cutoff?.pieces?.length || 0;
  const foundationAnchorageEntryCount = foundation?.entries?.length || 0;

  if (
    !endpointTrims.length &&
    !haunchTransitions.length &&
    appendixA2AnchoragePathCount === 0 &&
    cutoffPieceCount === 0 &&
    foundationAnchorageEntryCount === 0
  ) {
    return null;
  }

  return {
    endpointTrimCount: endpointTrims.length,
    haunchTransitionCount: haunchTransitions.length,
    anchoragePieceCount,
    appendixA2AnchoragePathCount,
    cutoffPieceCount,
    foundationAnchorageEntryCount,
  };
}

export function buildRebarPlacementConflictProductionPlanFromCandidates(
  candidates,
  beamLayoutMaps,
  options = {},
) {
  const members = new Map();
  const byMember = new Map();

  for (const candidate of candidates || []) {
    const memberId = candidate?.beam?.sourceMemberId;
    const memberKey = rebarPlacementConflictMemberKey(candidate?.beam?.memberType, memberId);
    if (!memberKey) continue;
    if (!byMember.has(memberKey)) byMember.set(memberKey, []);
    byMember.get(memberKey).push(candidate);
  }

  for (const memberKey of [...byMember.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  )) {
    const memberCandidates = byMember
      .get(memberKey)
      .slice()
      .sort((a, b) => String(a.key).localeCompare(String(b.key)));
    const first = memberCandidates[0];
    const memberTag = first?.beam?.memberType === 'BEAM' ? 'StbBeam' : 'StbGirder';
    const memberId = String(first?.beam?.sourceMemberId || '');
    const sectionId = String(first?.beam?.sectionId || '');
    const draft = memberDraft(memberId, memberTag, sectionId);
    draft.candidateKeys = memberCandidates.map((candidate) => candidate.key);

    for (const candidate of memberCandidates) {
      if (candidate?.decision?.status !== 'RESOLVED') {
        rejectDraft(
          draft,
          candidate,
          candidate?.decision?.reason || 'rebar-placement-conflict-candidate-unresolved',
        );
        continue;
      }
      if (candidate.decision.movedBar !== candidate?.beam?.semanticIdentity) {
        rejectDraft(draft, candidate, 'rebar-placement-conflict-column-move-not-supported');
        continue;
      }
      if (candidate?.beam?.memberType === 'BEAM') {
        rejectDraft(
          draft,
          candidate,
          'rebar-placement-conflict-small-beam-production-not-supported',
        );
        continue;
      }
      if (Math.abs(Number(candidate?.beam?.sectionRollRad) || 0) > EPS) {
        rejectDraft(draft, candidate, 'rebar-placement-conflict-beam-section-roll-not-supported');
        continue;
      }
      const datum = protectedHorizontalDatum(candidate.beam);
      if (datum.protected) {
        rejectDraft(
          draft,
          candidate,
          'rebar-placement-conflict-explicit-stb-horizontal-datum-protected',
          {
            source: datum.source,
          },
        );
        continue;
      }
      const deltaU = localDeltaU(candidate);
      if (deltaU === null || Math.abs(deltaU) <= EPS) {
        rejectDraft(draft, candidate, 'rebar-placement-conflict-local-shift-unresolved');
        continue;
      }
      const insetGeometry = endpointInsetGeometry(candidate, deltaU);
      if (!insetGeometry.ok) {
        rejectDraft(draft, candidate, insetGeometry.reason, {
          memberLengthMm: insetGeometry.memberLengthMm ?? null,
          requiredMemberMm: insetGeometry.requiredMemberMm ?? null,
        });
        continue;
      }
      mergeShift(draft, candidate, deltaU, insetGeometry);
    }

    const mutation = existingPathMutation(memberId, memberTag, options);
    if (draft.status === 'READY' && mutation) {
      rejectDraft(draft, null, 'rebar-placement-conflict-existing-member-path-mutation', mutation);
    }

    const map = memberTag === 'StbBeam' ? beamLayoutMaps?.beam : beamLayoutMaps?.girder;
    members.set(memberKey, finalizeDraft(draft, map?.get(sectionId) || null));
  }

  return {
    members,
    geometryApplication: 'PRODUCTION_MEMBER_LAYOUT_READY',
    source: 'ISSUE_292_REBAR_PLACEMENT_CONFLICT',
  };
}

function effectiveProductionCandidates(candidates, ruleActivation) {
  const all = Array.isArray(candidates) ? candidates : [];
  if (!ruleActivation?.active) {
    return all.filter((candidate) => candidate?.explicitOverride?.active);
  }

  const autoRuleIds = new Set(ruleActivation.autoRuleIds || []);
  const projectRuleIds = (ruleActivation.enabledRuleIds || []).filter(
    (ruleId) => !autoRuleIds.has(ruleId),
  );
  if (projectRuleIds.length > 0) {
    // Explicit project opt-in keeps Issue #292's member-level atomic conflict contract.
    return all;
  }

  // Automatic geometry-conditioned rules must not turn unrelated column/beam clashes
  // into production blockers. Keep only pairs whose geometry activated an auto rule,
  // plus explicit L0 overrides.
  return all.filter(
    (candidate) =>
      candidate?.explicitOverride?.active === true ||
      (candidate?.enabledRuleIds || []).some((ruleId) => autoRuleIds.has(ruleId)),
  );
}

export function buildRebarPlacementConflictProductionPlan(xmlDoc, options = {}) {
  if (!xmlDoc) {
    return {
      members: new Map(),
      geometryApplication: 'PRODUCTION_MEMBER_LAYOUT_READY',
      source: 'ISSUE_292_REBAR_PLACEMENT_CONFLICT',
      activation: {
        active: false,
        resolved: true,
        status: 'NO_DOCUMENT',
        enabledRuleIds: [],
      },
    };
  }

  const projectDetailing =
    options.projectDetailing === undefined ? getRebarProjectDetailing() : options.projectDetailing;
  const activation = resolveRebarPlacementConflictActivation(projectDetailing);
  const { ruleActivation } = activation;
  if (!activation.active || !activation.resolved) {
    return {
      members: new Map(),
      geometryApplication: 'PRODUCTION_MEMBER_LAYOUT_READY',
      source: 'ISSUE_292_REBAR_PLACEMENT_CONFLICT',
      activation,
    };
  }

  const candidates =
    options.candidates ||
    collectRcColumnBeamPlacementConflictCandidates(xmlDoc, {
      ...options,
      projectDetailing,
      projectActivation: ruleActivation,
      enabledRuleIds: ruleActivation.resolved ? [...ruleActivation.enabledRuleIds] : [],
    });
  const effectiveCandidates = effectiveProductionCandidates(candidates, ruleActivation);
  const plan = buildRebarPlacementConflictProductionPlanFromCandidates(
    effectiveCandidates,
    options.beamLayoutMaps,
    {
      jointTransitionPlan: options.jointTransitionPlan,
      haunchTransitionPlan: options.haunchTransitionPlan,
      anchoragePieceMap: options.anchoragePieceMap,
      cutoffPieceMap: options.cutoffPieceMap,
      anchoragePieceMaps: options.anchoragePieceMaps,
      cutoffPieceMaps: options.cutoffPieceMaps,
      foundationBeamAnchorageRenderPlan: options.foundationBeamAnchorageRenderPlan,
    },
  );
  return {
    ...plan,
    activation,
    candidates: effectiveCandidates,
  };
}

export function rebarPlacementConflictEndpointInsets(memberPlan) {
  if (
    memberPlan?.status !== 'READY' ||
    memberPlan?.applicationMode !== 'ENDPOINT_LOCAL' ||
    !(memberPlan.endpointShifts instanceof Map)
  ) {
    return [];
  }
  return [...memberPlan.endpointShifts.values()]
    .map((shift) => ({
      endpoint: shift.endpoint,
      barIndex: shift.barIndex,
      deltaU: shift.deltaU,
      expectedBar: shift.expectedBar ? { ...shift.expectedBar } : null,
      sourceRuleIds: (shift.sourceRuleIds || []).slice(),
      candidateKeys: (shift.candidateKeys || []).slice(),
      movement: shift.movement ? { ...shift.movement } : null,
      transitionLeadMm: shift.transitionLeadMm,
      transitionRunMm: shift.transitionRunMm,
      memberLengthMm: shift.memberLengthMm,
      axialDistanceMm: shift.axialDistanceMm,
      radialClearMm: shift.radialClearMm,
      collisionToleranceMm: shift.collisionToleranceMm,
    }))
    .sort((left, right) => {
      const endpointOrder = left.endpoint === right.endpoint ? 0 : left.endpoint === 'start' ? -1 : 1;
      return endpointOrder || left.barIndex - right.barIndex;
    });
}

function sameAnchorageBarFingerprint(actual, expected) {
  const originalV = finite(actual?.appendixA2VerticalPlacementOriginalV) ?? finite(actual?.v);
  return sameBarFingerprint(
    {
      ...actual,
      v: originalV,
    },
    expected,
  );
}

function matchingAnchorageShift(memberPlan, endpoint, bar) {
  const shifts = rebarPlacementConflictEndpointInsets(memberPlan).filter(
    (shift) => shift.endpoint === endpoint && sameAnchorageBarFingerprint(bar, shift.expectedBar),
  );
  return shifts.length === 1 ? shifts[0] : null;
}

function matchingPieceShift(memberPlan, piece) {
  const shifts = rebarPlacementConflictEndpointInsets(memberPlan).filter((shift) => {
    const expected = shift.expectedBar?.localPosition;
    return (
      shift.endpoint === piece?.anchor &&
      expected &&
      Math.abs(Number(piece?.u) - Number(expected.u)) <= EPS &&
      Math.abs(
        Number(piece?.appendixA2VerticalPlacementOriginalV ?? piece?.v) - Number(expected.v),
      ) <= EPS &&
      Number(piece?.dia) === Number(shift.expectedBar?.dia)
    );
  });
  return shifts.length === 1 ? shifts[0] : null;
}

export function applyRebarPlacementConflictPlanToAnchorage(anchorage, memberPlan) {
  if (
    !anchorage ||
    memberPlan?.status !== 'READY' ||
    memberPlan?.applicationMode !== 'ENDPOINT_LOCAL' ||
    !(memberPlan.endpointShifts instanceof Map) ||
    memberPlan.endpointShifts.size === 0
  ) {
    return anchorage;
  }

  return {
    ...anchorage,
    ends: (anchorage.ends || []).map((end) => ({
      ...end,
      bars: (end.bars || []).map((bar) => {
        const shift = matchingAnchorageShift(memberPlan, end.side, bar);
        return shift
          ? {
              ...bar,
              u: Number(bar.u) + shift.deltaU,
              issue317PlacementConflictApplied: true,
              issue317PlacementConflictDeltaU: shift.deltaU,
            }
          : { ...bar };
      }),
    })),
    pieces: (anchorage.pieces || []).map((piece) => {
      const shift = matchingPieceShift(memberPlan, piece);
      return shift
        ? {
            ...piece,
            u: Number(piece.u) + shift.deltaU,
            issue317PlacementConflictApplied: true,
            issue317PlacementConflictDeltaU: shift.deltaU,
          }
        : { ...piece };
    }),
    issue317PlacementConflict: {
      memberId: memberPlan.memberId,
      applicationMode: memberPlan.applicationMode,
      candidateKeys: memberPlan.candidateKeys.slice(),
    },
  };
}

export function applyRebarPlacementConflictPlanToAnchorageMaps(anchorageMaps, productionPlan) {
  if (!anchorageMaps || !(productionPlan?.members instanceof Map)) return anchorageMaps;
  const result = {
    ...anchorageMaps,
    girder: new Map(anchorageMaps.girder || []),
    beam: new Map(anchorageMaps.beam || []),
  };
  for (const [memberType, map] of [
    ['GIRDER', result.girder],
    ['BEAM', result.beam],
  ]) {
    for (const [memberId, anchorage] of map) {
      const key = rebarPlacementConflictMemberKey(memberType, memberId);
      const memberPlan = key ? productionPlan.members.get(key) : null;
      if (!memberPlan || memberPlan.status !== 'READY') continue;
      map.set(memberId, applyRebarPlacementConflictPlanToAnchorage(anchorage, memberPlan));
    }
  }
  return result;
}

export function applyRebarPlacementConflictPlanToLayout(layout, memberPlan) {
  if (!layout || memberPlan?.status !== 'READY' || memberPlan?.barShifts?.size === 0) {
    return layout;
  }
  // Issue #317: geometry-conditioned A2 side-jointは対象endpointだけをdoglegで内寄せする。
  // span全体のsection layoutは変更せず、beamRebarPathBuilderへendpoint shift factを渡す。
  if (memberPlan.applicationMode === 'ENDPOINT_LOCAL') return layout;
  if ((layout.segments || []).length !== 1) return layout;

  const shifts = memberPlan.barShifts;
  return {
    ...layout,
    segments: layout.segments.map((segment) => ({
      ...segment,
      bars: (segment.bars || []).map((bar, index) => {
        const shift = shifts.get(index);
        if (!shift) return cloneBar(bar);
        return {
          ...bar,
          u: Number(bar.u) + shift.deltaU,
          issue292PlacementConflictApplied: true,
          issue292PlacementConflictDeltaU: shift.deltaU,
          issue292PlacementConflictSourceRules: shift.sourceRuleIds.slice(),
        };
      }),
    })),
    issue292PlacementConflict: {
      memberId: memberPlan.memberId,
      source: 'ISSUE_292_REBAR_PLACEMENT_CONFLICT',
      candidateKeys: memberPlan.candidateKeys.slice(),
    },
  };
}
