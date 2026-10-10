/**
 * @fileoverview R12-AF 片持ち小梁自由端の明示90°折曲げをidentity単位のproduction planへ変換する。
 */

import { createTagScanner } from '../columnSupportUtils.js';
import { assignBeamBarIdentities } from './rebarIdentityMatcher.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';
import { buildAnchoredHookPath, resolveHookBendGeometry } from './rebarHookGeometry.js';
import { getPathStart, rebarPathToLineSegments, validateRebarPath } from './rebarPath.js';
import { resolveSmallBeamCantileverFreeTipDetailing } from './smallBeamCantileverFreeTipDetailing.js';

const TOLERANCE_MM = 1e-6;
const SOURCE = 'R12-AF-small-beam-cantilever-free-tip-render-plan';

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}
function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    productionReady: false,
    generationStatus: 'UNRESOLVED',
    reason,
    source: SOURCE,
    productionPath: null,
    trimSpec: null,
    ...extra,
  };
}
function endSegment(layout, side) {
  const segments = Array.isArray(layout?.segments) ? layout.segments : [];
  if (segments.length === 0) return null;
  return side === 'end' ? segments[segments.length - 1] : segments[0];
}
function closeEnough(left, right) {
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TOLERANCE_MM;
}
function pathInsideSection(path, sectionDepthMm, barDiaMm) {
  const depth = Number(sectionDepthMm),
    dia = Number(barDiaMm);
  if (!(depth > 0) || !(dia > 0)) return false;
  const minY = -depth / 2 + dia / 2,
    maxY = depth / 2 - dia / 2;
  for (const line of rebarPathToLineSegments(path))
    for (const point of [line.start, line.end]) {
      const y = Number(point?.y);
      if (!Number.isFinite(y) || y < minY - TOLERANCE_MM || y > maxY + TOLERANCE_MM) return false;
    }
  return true;
}
export function resolveSmallBeamCantileverFreeTipBar({
  bar,
  memberId,
  freeSide,
  bendInsetMm,
  tailLengthMm,
  sectionDepthMm,
  barIndex = null,
} = {}) {
  if (bar?.role !== 'top')
    return unresolved('small-beam-cantilever-free-tip-role-mismatch', { role: bar?.role || null });
  if (!['start', 'end'].includes(freeSide))
    return unresolved('small-beam-cantilever-free-tip-side-unresolved');
  const identityKey = text(bar?.identityKey);
  if (!identityKey || bar?.unresolvedMatch === true || bar?.identityStatus === 'unresolved')
    return unresolved('small-beam-cantilever-free-tip-identity-unresolved', { identityKey });
  const u = Number(bar?.u),
    v = Number(bar?.v),
    dia = Number(bar?.dia),
    grade = text(bar?.grade),
    inset = Number(bendInsetMm),
    tail = Number(tailLengthMm),
    depth = Number(sectionDepthMm);
  if (
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    !(dia > 0) ||
    !grade ||
    !(inset > 0) ||
    !(tail > 0) ||
    !(depth > 0)
  )
    return unresolved('small-beam-cantilever-free-tip-input-unresolved');
  const bendRule = resolveHookBendGeometry({
    grade,
    barDiaMm: dia,
    bendAngleDeg: 90,
    tailLengthMm: tail,
  });
  if (!bendRule.ok)
    return unresolved(bendRule.reason || 'small-beam-cantilever-free-tip-bend-rule-unresolved');
  if (!closeEnough(bendRule.tailLengthMm, tail))
    return unresolved('small-beam-cantilever-free-tip-tail-below-standard-minimum', {
      requestedTailLengthMm: tail,
      minimumTailLengthMm: bendRule.minimumTailLengthMm,
    });
  const built = buildAnchoredHookPath({
    anchor: freeSide,
    at: inset,
    u,
    v,
    barDiaMm: dia,
    grade,
    bendAngleDeg: 90,
    outgoingDirection: { x: 0, y: -1, z: 0 },
    tailLengthMm: tail,
    allowIncomingTangentInsideMember: true,
    metadata: {
      memberId: String(memberId),
      memberTag: 'StbBeam',
      endpoint: freeSide,
      role: 'top',
      layer: bar?.layer ?? null,
      identityKey,
      identityStatus: bar?.identityStatus || 'local',
      source: 'PROJECT_EXPLICIT + NIKKENREN_JSCA_2023_FIG_9_3_3',
      ruleId: 'R12-AF',
      bendGeometry: 'actual-arc',
      bendDirection: 'DOWN',
      anchorageMode: 'CANTILEVER_FREE_TIP_90',
      bendInsetFromTipMm: inset,
      standardApproximateBendInsetMm: 100,
    },
  });
  if (!built.ok || !built.path || !validateRebarPath(built.path).ok)
    return unresolved(built.reason || 'small-beam-cantilever-free-tip-generated-path-invalid');
  const trimRequiredMm = Number(built.path.metadata?.mainBarTrimRequiredMm),
    pathStart = getPathStart(built.path);
  if (
    !(trimRequiredMm > 0) ||
    !pathStart ||
    !closeEnough(pathStart.x, u) ||
    !closeEnough(pathStart.y, v) ||
    !closeEnough(pathStart.z, trimRequiredMm)
  )
    return unresolved('small-beam-cantilever-free-tip-trim-contract-mismatch');
  if (!pathInsideSection(built.path, depth, dia))
    return unresolved('small-beam-cantilever-free-tip-tail-outside-section', {
      sectionDepthMm: depth,
      tailLengthMm: tail,
    });
  const trimSpec = {
    endpoint: freeSide,
    trimMm: trimRequiredMm,
    identityKey,
    source: 'R12-AF-small-beam-cantilever-free-tip',
    bar: { role: 'top', layer: bar?.layer ?? null, dia, grade, localPosition: { u, v } },
  };
  return {
    resolved: true,
    productionReady: true,
    generationStatus: 'CENTERLINE_READY',
    reason: null,
    source: SOURCE,
    mode: 'CANTILEVER_FREE_TIP_90',
    side: freeSide,
    memberId: String(memberId),
    barIndex: Number.isInteger(barIndex) ? barIndex : null,
    identityKey,
    role: 'top',
    layer: bar?.layer ?? null,
    u,
    v,
    barDiaMm: dia,
    grade,
    bendInsetMm: inset,
    tailLengthMm: tail,
    insideDiameterMm: bendRule.insideDiameterMm,
    centerlineRadiusMm: bendRule.centerlineRadiusMm,
    trimRequiredMm,
    trimSpec,
    productionPathCandidate: true,
    productionConsumer: 'beam-anchor-local-path-with-main-trim',
    productionPath: built.path,
    validation: built.validation,
  };
}
function deferredReason(reason) {
  return [
    'small-beam-cantilever-free-tip-explicit-detail-required',
    'small-beam-cantilever-free-tip-production-not-enabled',
    'small-beam-cantilever-free-tip-assignment-missing',
  ].includes(reason);
}
export function buildSmallBeamCantileverFreeTipRenderPlan(
  xmlDoc,
  beamLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  const members = new Map(),
    unresolvedFacts = [],
    deferred = [];
  if (!xmlDoc || !beamLayoutMap?.size)
    return { resolved: true, source: SOURCE, members, unresolved: unresolvedFacts, deferred };
  for (const layout of beamLayoutMap.values())
    if (Array.isArray(layout?.segments) && layout.segments.length)
      assignBeamBarIdentities(layout.segments, options.identityOptions || {});
  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex =
    options.modelIndex || options.index || buildRebarModelIndex(xmlDoc, { scanTag });
  const supports = buildSmallBeamSupportFacts(xmlDoc, scanTag, modelIndex);
  for (const [elementId, beamFacts] of supports.beam || []) {
    if (beamFacts?.isCanti !== true || beamFacts?.isFoundation === true) continue;
    const freeEnds = (beamFacts.ends || []).filter(
      (end) => end?.supportType === 'FREE_END' && end?.resolved !== false,
    );
    if (freeEnds.length !== 1) {
      unresolvedFacts.push({
        elementId: String(elementId),
        reason: 'small-beam-cantilever-free-tip-end-unresolved',
        freeEndCount: freeEnds.length,
      });
      continue;
    }
    const freeEnd = freeEnds[0];
    const detail = resolveSmallBeamCantileverFreeTipDetailing({
      memberId: elementId,
      endpoint: freeEnd.side,
      projectDetailing: options.projectDetailing,
    });
    if (!detail.resolved) {
      const row = {
        elementId: String(elementId),
        side: freeEnd.side,
        reason: detail.reason,
        approximateBendInsetMm: detail.approximateBendInsetMm ?? 100,
      };
      (deferredReason(detail.reason) ? deferred : unresolvedFacts).push(row);
      continue;
    }
    const layout = beamLayoutMap.get(String(beamFacts.sectionId));
    const segment = endSegment(layout, freeEnd.side);
    const bars = (segment?.bars || []).filter((bar) => bar?.role === 'top');
    const byIdentity = new Map();
    for (const bar of bars) {
      const key = text(bar?.identityKey);
      if (!key) continue;
      const list = byIdentity.get(key) || [];
      list.push(bar);
      byIdentity.set(key, list);
    }
    const assignment = detail.assignment,
      facts = [];
    for (const [barIndex, identityKey] of assignment.identityKeys.entries()) {
      const candidates = byIdentity.get(identityKey) || [];
      if (candidates.length !== 1) {
        facts.push(
          unresolved(
            candidates.length === 0
              ? 'small-beam-cantilever-free-tip-selected-identity-missing'
              : 'small-beam-cantilever-free-tip-selected-identity-ambiguous',
            { identityKey, candidateCount: candidates.length, barIndex },
          ),
        );
        continue;
      }
      facts.push(
        resolveSmallBeamCantileverFreeTipBar({
          bar: candidates[0],
          memberId: elementId,
          freeSide: freeEnd.side,
          bendInsetMm: assignment.bendInsetMm,
          tailLengthMm: assignment.tailLengthMm,
          sectionDepthMm: layout?.depth,
          barIndex,
        }),
      );
    }
    const failed = facts.filter((fact) => !fact.resolved || fact.productionReady !== true);
    if (failed.length > 0 || facts.length !== assignment.identityKeys.length) {
      unresolvedFacts.push({
        elementId: String(elementId),
        side: freeEnd.side,
        reason: failed[0]?.reason || 'small-beam-cantilever-free-tip-group-not-ready',
        atomicMemberRollback: true,
      });
      continue;
    }
    members.set(String(elementId), {
      elementId: String(elementId),
      elementName: beamFacts.elementName || null,
      sectionId: beamFacts.sectionId == null ? null : String(beamFacts.sectionId),
      side: freeEnd.side,
      entries: facts.map((fact) => ({
        side: fact.side,
        role: 'top',
        barIndex: fact.barIndex,
        identityKey: fact.identityKey,
        generationStatus: fact.generationStatus,
        productionPathCandidate: true,
        productionConsumer: fact.productionConsumer,
        productionPath: fact.productionPath,
        trimRequiredMm: fact.trimRequiredMm,
        trimSpec: fact.trimSpec,
        bendInsetMm: fact.bendInsetMm,
        tailLengthMm: fact.tailLengthMm,
      })),
      endpointTrims: facts.map((fact) => fact.trimSpec),
      detailSource: detail.source,
    });
  }
  return {
    resolved: unresolvedFacts.length === 0,
    source: SOURCE,
    members,
    unresolved: unresolvedFacts,
    deferred,
  };
}
