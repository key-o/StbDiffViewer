/**
 * @fileoverview R12-Y 一般小梁下端筋のL3h 90°フック定着をproduction planへ接続する。
 *
 * 直線L3を優先し、L3が支持大梁内に収まらないbarだけをL3h候補へ進める。
 * L3h、実90°Arc、上向き8d余長、同一identity主筋の端部trimを一体で解決し、
 * group内に未解決barがある場合は部分適用せずfail-closedとする。
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { assignBeamBarIdentities } from './rebarIdentityMatcher.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';
import { buildSmallBeamAnchorageRequirementFacts } from './smallBeamAnchorageRequirementFacts.js';
import { resolveSmallBeamSupportFaceGeometry } from './smallBeamSupportFaceGeometry.js';
import { resolveSmallBeamBottomUpTailAvailability } from './smallBeamBottomTailAvailability.js';
import { buildAnchoredHookPath, resolveHookBendGeometry } from './rebarHookGeometry.js';
import { getPathStart, validateRebarPath } from './rebarPath.js';
import {
  hasUnsupportedSmallBeamSectionRotation,
  resolveSmallBeamSectionRollDegrees,
  SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON,
} from './smallBeamSectionOrientation.js';

const TOLERANCE_MM = 1e-6;
const SOURCE = 'R12-Y-small-beam-bottom-L3h-render-plan';

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

function alternative(group, kind) {
  const key = String(kind || '').toUpperCase();
  return (group?.requirement?.alternatives || []).find(
    (item) => item?.ok === true && String(item.lengthKind || '').toUpperCase() === key,
  );
}

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function isTrueAttribute(element, name) {
  return ['true', '1'].includes(
    String(element?.getAttribute?.(name) ?? '')
      .trim()
      .toLowerCase(),
  );
}

function resolveBottomProjection({ scanTag, beamEl, supportEnd, supportContext, bar, index }) {
  const geometry = resolveSmallBeamSupportFaceGeometry(
    scanTag,
    beamEl,
    supportEnd,
    supportContext,
    { beamLateralOffsetMm: Number(bar?.u), index },
  );
  if (!geometry?.resolved) {
    return unresolved(geometry?.reason || 'small-beam-bottom-L3h-support-geometry-unresolved', {
      supportGeometry: geometry || null,
    });
  }

  const farFaceSide = geometry.farFaceSide;
  const coverFact = supportContext?.supportCoverBySide?.[farFaceSide];
  const coverMm = Number(coverFact?.coverMm);
  const sinSkew = Number(geometry.sinSkew);
  const dia = Number(bar?.dia);
  if (!farFaceSide || !coverFact?.resolved || !(coverMm >= 0)) {
    return unresolved(coverFact?.reason || 'small-beam-bottom-L3h-far-face-cover-unresolved');
  }
  if (!(sinSkew > 0) || !(dia > 0)) {
    return unresolved('small-beam-bottom-L3h-projection-input-unresolved');
  }

  const availableFromNearMm = Number(geometry.effectiveEmbedmentMm) - (coverMm + dia / 2) / sinSkew;
  const beamEndT = Number(geometry.beamEndT);
  const nearFaceT = Number(geometry.nearFaceT);
  if (!(availableFromNearMm > 0) || !Number.isFinite(beamEndT) || !Number.isFinite(nearFaceT)) {
    return unresolved('small-beam-bottom-L3h-available-projection-unresolved', {
      availableFromNearMm: Number.isFinite(availableFromNearMm) ? availableFromNearMm : null,
    });
  }

  const rawNear = supportEnd.side === 'start' ? nearFaceT - beamEndT : beamEndT - nearFaceT;
  if (rawNear < -TOLERANCE_MM) {
    return unresolved('small-beam-bottom-L3h-near-face-outside-member-side', {
      nearFaceFromMemberEndMm: rawNear,
    });
  }
  return {
    resolved: true,
    supportGeometry: geometry,
    availableFromNearMm,
    nearFaceFromMemberEndMm: Math.max(0, rawNear),
  };
}

/** 下端主筋1本について、L3優先 -> L3h実フック候補を解決する。 */
export function resolveSmallBeamBottomHookedL3hBar({
  scanTag,
  beamEl,
  supportGirderEl,
  supportEnd,
  supportContext,
  bar,
  l3Requirement,
  l3hRequirement,
  index = null,
  barIndex = null,
} = {}) {
  if (!beamEl) return unresolved('small-beam-element-not-found');
  if (isTrueAttribute(beamEl, 'isFoundation')) {
    return unresolved('foundation-small-beam-out-of-r12-scope');
  }
  if (bar?.role !== 'bottom') {
    return unresolved('small-beam-bottom-L3h-role-mismatch', { role: bar?.role || null });
  }
  if (supportEnd?.supportType !== 'GIRDER' || !supportEnd?.supportId) {
    return unresolved(`unsupported-bottom-support:${supportEnd?.supportType || 'UNKNOWN'}`);
  }
  if (!['start', 'end'].includes(supportEnd?.side)) {
    return unresolved('small-beam-bottom-L3h-anchor-unresolved');
  }
  if (!supportGirderEl) return unresolved('support-girder-not-found');
  if (hasUnsupportedSmallBeamSectionRotation(beamEl)) {
    return unresolved(SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON, {
      sectionRollDegrees: resolveSmallBeamSectionRollDegrees(beamEl),
    });
  }

  const identityKey = text(bar?.identityKey);
  if (!identityKey || bar?.unresolvedMatch === true || bar?.identityStatus === 'unresolved') {
    return unresolved('small-beam-bottom-L3h-identity-unresolved', { identityKey });
  }

  const l3RequiredMm = Number(l3Requirement?.requiredMm);
  const l3hRequiredMm = Number(l3hRequirement?.requiredMm);
  const barDiaMm = Number(bar?.dia);
  const u = Number(bar?.u);
  const v = Number(bar?.v);
  const grade = gradeKey(bar?.grade);
  if (
    !l3Requirement?.ok ||
    String(l3Requirement?.lengthKind).toUpperCase() !== 'L3' ||
    !(l3RequiredMm > 0)
  ) {
    return unresolved(l3Requirement?.reason || 'small-beam-bottom-L3-requirement-unresolved');
  }
  if (
    !l3hRequirement?.ok ||
    String(l3hRequirement?.lengthKind).toUpperCase() !== 'L3H' ||
    !(l3hRequiredMm > 0)
  ) {
    return unresolved(l3hRequirement?.reason || 'small-beam-bottom-L3h-requirement-unresolved');
  }
  if (!(barDiaMm > 0) || !Number.isFinite(u) || !Number.isFinite(v) || !grade) {
    return unresolved('small-beam-bottom-L3h-bar-facts-unresolved');
  }

  const projection = resolveBottomProjection({
    scanTag,
    beamEl,
    supportEnd,
    supportContext,
    bar,
    index,
  });
  if (!projection.resolved) return projection;

  if (projection.availableFromNearMm + TOLERANCE_MM >= l3RequiredMm) {
    return {
      resolved: true,
      productionReady: false,
      generationStatus: 'STRAIGHT_L3_PREFERRED',
      reason: null,
      source: SOURCE,
      side: supportEnd.side,
      supportId: String(supportEnd.supportId),
      identityKey,
      role: 'bottom',
      barIndex,
      l3RequiredMm,
      l3hRequiredMm,
      availableFromNearMm: projection.availableFromNearMm,
      productionPath: null,
      trimSpec: null,
    };
  }

  const hookRule = resolveHookBendGeometry({ grade, barDiaMm, bendAngleDeg: 90 });
  if (!hookRule.ok)
    return unresolved(hookRule.reason || 'small-beam-bottom-L3h-bend-rule-unresolved');

  const incomingTangentFromNearMm = l3hRequiredMm;
  const verticalLegCenterFromNearMm = l3hRequiredMm + hookRule.centerlineRadiusMm;
  if (verticalLegCenterFromNearMm > projection.availableFromNearMm + TOLERANCE_MM) {
    return {
      ...unresolved('small-beam-bottom-L3h-projection-insufficient', {
        l3RequiredMm,
        l3hRequiredMm,
        availableFromNearMm: projection.availableFromNearMm,
      }),
      generationStatus: 'L3H_INSUFFICIENT',
    };
  }

  const tailFact = resolveSmallBeamBottomUpTailAvailability({
    scanTag,
    beamEl,
    supportGirderEl,
    supportEnd,
    supportContext,
    bar,
    index,
  });
  if (!tailFact?.resolved)
    return unresolved(tailFact?.reason || 'small-beam-bottom-L3h-tail-unresolved');
  if (Math.abs(Number(tailFact.centerlineRadiusMm) - hookRule.centerlineRadiusMm) > TOLERANCE_MM) {
    return unresolved('small-beam-bottom-L3h-radius-mismatch');
  }

  const tailLengthMm = hookRule.minimumTailLengthMm;
  if (tailFact.availableTailMm + TOLERANCE_MM < tailLengthMm) {
    return {
      ...unresolved('small-beam-bottom-L3h-tail-insufficient', {
        tailLengthMm,
        availableTailMm: tailFact.availableTailMm,
      }),
      generationStatus: 'L3H_INSUFFICIENT',
    };
  }

  // L3hは支持面からincoming tangentまで。anchor-localは部材内向きが+z。
  const incomingTangentAtMm = projection.nearFaceFromMemberEndMm - l3hRequiredMm;
  const sharpCornerAtMm = incomingTangentAtMm - hookRule.centerlineRadiusMm;
  const trimRequiredMm = Math.max(0, incomingTangentAtMm);
  const hook = buildAnchoredHookPath({
    anchor: supportEnd.side,
    at: sharpCornerAtMm,
    u,
    v,
    barDiaMm,
    grade,
    bendAngleDeg: 90,
    outgoingDirection: { x: 0, y: 1, z: 0 },
    tailLengthMm,
    allowIncomingTangentInsideMember: trimRequiredMm > TOLERANCE_MM,
    metadata: {
      memberId: text(beamEl.getAttribute?.('id')),
      memberTag: 'StbBeam',
      role: 'bottom',
      layer: bar?.layer ?? null,
      identityKey,
      identityStatus: bar?.identityStatus || 'local',
      endpoint: supportEnd.side,
      source: 'small-beam-r12-bottom-L3h',
      ruleId: 'R12-Y',
      bendGeometry: 'actual-arc',
      bendDirection: 'UP',
      anchorageMode: 'HOOK_L3H_90',
      anchorageLengthKind: 'L3H',
      l3RequiredMm,
      l3hRequiredMm,
      supportId: String(supportEnd.supportId),
    },
  });
  if (!hook.ok || !hook.path || !validateRebarPath(hook.path).ok) {
    return unresolved(hook.reason || 'small-beam-bottom-L3h-generated-path-invalid');
  }

  const actualTrim = Number(hook.path.metadata?.mainBarTrimRequiredMm);
  const pathStart = getPathStart(hook.path);
  if (
    !Number.isFinite(actualTrim) ||
    Math.abs(actualTrim - trimRequiredMm) > TOLERANCE_MM ||
    !pathStart ||
    Math.abs(Number(pathStart.x) - u) > TOLERANCE_MM ||
    Math.abs(Number(pathStart.y) - v) > TOLERANCE_MM ||
    Math.abs(Number(pathStart.z) - trimRequiredMm) > TOLERANCE_MM
  ) {
    return unresolved('small-beam-bottom-L3h-trim-contract-mismatch');
  }

  const trimSpec =
    trimRequiredMm > TOLERANCE_MM
      ? {
          endpoint: supportEnd.side,
          trimMm: trimRequiredMm,
          identityKey,
          source: 'R12-Y-small-beam-bottom-L3h',
          bar: {
            role: 'bottom',
            layer: bar?.layer ?? null,
            dia: barDiaMm,
            grade,
            localPosition: { u, v },
          },
        }
      : null;

  return {
    resolved: true,
    productionReady: true,
    generationStatus: 'CENTERLINE_READY',
    reason: null,
    source: SOURCE,
    mode: 'HOOK_L3H_90',
    side: supportEnd.side,
    supportId: String(supportEnd.supportId),
    barIndex,
    identityKey,
    role: 'bottom',
    layer: bar?.layer ?? null,
    u,
    v,
    barDiaMm,
    grade,
    l3RequiredMm,
    l3hRequiredMm,
    availableFromNearMm: projection.availableFromNearMm,
    nearFaceFromMemberEndMm: projection.nearFaceFromMemberEndMm,
    incomingTangentFromNearMm,
    verticalLegCenterFromNearMm,
    incomingTangentAtMm,
    sharpCornerAtMm,
    trimRequiredMm,
    centerlineRadiusMm: hookRule.centerlineRadiusMm,
    insideDiameterMm: hookRule.insideDiameterMm,
    tailLengthMm,
    availableTailMm: tailFact.availableTailMm,
    trimSpec,
    productionPathCandidate: true,
    productionConsumer: 'beam-anchor-local-path-with-main-trim',
    productionPath: hook.path,
    validation: hook.validation,
  };
}

function groupFailed(fact) {
  return (
    fact?.resolved !== true ||
    (fact.generationStatus !== 'STRAIGHT_L3_PREFERRED' &&
      (fact.productionReady !== true || fact.generationStatus !== 'CENTERLINE_READY'))
  );
}

/** R12 requirement factsから、L3h actual hook + identity trimをmember planへ集約する。 */
export function buildSmallBeamBottomL3hRenderPlanFromFacts(
  requirementFacts,
  scanTag,
  options = {},
) {
  const members = new Map();
  const unresolvedFacts = [];
  const deferred = [];
  const modelIndex = options.modelIndex || options.index || null;

  for (const [elementId, beamFacts] of requirementFacts?.beam || []) {
    if (beamFacts?.isFoundation === true) continue;
    const beamEl = findElementById(scanTag, 'StbBeam', String(elementId), modelIndex);
    if (!beamEl) {
      unresolvedFacts.push({
        elementId: String(elementId),
        reason: 'small-beam-element-not-found',
      });
      continue;
    }

    const candidates = [];
    for (const end of beamFacts?.ends || []) {
      if (end?.status === 'FREE_END') continue;
      const supportGirderEl = end?.support?.supportId
        ? findElementById(scanTag, 'StbGirder', String(end.support.supportId), modelIndex)
        : null;

      for (const group of end?.requirements || []) {
        if (group?.role !== 'bottom') continue;
        const l3 = alternative(group, 'L3');
        const l3h = alternative(group, 'L3H');
        const bars = Array.isArray(group.bars) ? group.bars : [];
        if (!l3 || !l3h || bars.length === 0) {
          unresolvedFacts.push({
            elementId: String(elementId),
            side: end.side || null,
            reason:
              !l3 || !l3h
                ? 'small-beam-bottom-L3h-requirement-alternatives-unresolved'
                : 'small-beam-bottom-L3h-group-bars-missing',
          });
          continue;
        }

        const facts = bars.map((bar, barIndex) =>
          resolveSmallBeamBottomHookedL3hBar({
            scanTag,
            beamEl,
            supportGirderEl,
            supportEnd: end.support,
            supportContext: end.supportContext,
            bar,
            l3Requirement: l3,
            l3hRequirement: l3h,
            index: modelIndex,
            barIndex,
          }),
        );
        const failed = facts.find(groupFailed);
        if (failed) {
          unresolvedFacts.push({
            elementId: String(elementId),
            side: end.side || null,
            role: 'bottom',
            diaMm: group.diaMm,
            grade: group.grade || null,
            reason: failed.reason || 'small-beam-bottom-L3h-group-not-ready',
            atomicGroupRollback: true,
          });
          deferred.push(
            ...facts
              .filter((fact) => fact?.generationStatus === 'L3H_INSUFFICIENT')
              .map((fact) => ({
                elementId: String(elementId),
                side: end.side || null,
                barIndex: fact.barIndex,
                identityKey: fact.identityKey || null,
                reason: fact.reason,
                nextAlternative: 'SPECIAL',
              })),
          );
          continue;
        }

        candidates.push(
          ...facts
            .filter((fact) => fact.generationStatus === 'CENTERLINE_READY')
            .map((fact) => ({
              side: fact.side,
              role: 'bottom',
              barIndex: fact.barIndex,
              identityKey: fact.identityKey,
              generationStatus: 'CENTERLINE_READY',
              productionPathCandidate: true,
              productionConsumer: 'beam-anchor-local-path-with-main-trim',
              productionPath: fact.productionPath,
              trimRequiredMm: fact.trimRequiredMm,
              trimSpec: fact.trimSpec,
              l3RequiredMm: fact.l3RequiredMm,
              l3hRequiredMm: fact.l3hRequiredMm,
              availableTailMm: fact.availableTailMm,
            })),
        );
      }
    }

    const grouped = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.side}|${candidate.identityKey}`;
      const list = grouped.get(key) || [];
      list.push(candidate);
      grouped.set(key, list);
    }

    const entries = [];
    const endpointTrims = [];
    for (const [key, list] of grouped) {
      if (!list[0]?.identityKey || list.length !== 1) {
        unresolvedFacts.push({
          elementId: String(elementId),
          side: list[0]?.side || null,
          identityKey: list[0]?.identityKey || null,
          reason:
            list.length === 1
              ? 'small-beam-bottom-L3h-render-identity-unresolved'
              : 'small-beam-bottom-L3h-render-identity-duplicate',
          duplicateKey: key,
        });
        continue;
      }
      entries.push(list[0]);
      if (list[0].trimSpec) endpointTrims.push(list[0].trimSpec);
    }

    if (entries.length) {
      members.set(String(elementId), {
        elementId: String(elementId),
        elementName: beamFacts.elementName || null,
        sectionId: beamFacts.sectionId == null ? null : String(beamFacts.sectionId),
        entries,
        endpointTrims,
      });
    }
  }

  return {
    resolved: unresolvedFacts.length === 0,
    source: SOURCE,
    members,
    unresolved: unresolvedFacts,
    deferred,
  };
}

/** STB document + 既存beam layoutからR12-Y render/trim planを構築する。 */
export function buildSmallBeamBottomL3hRenderPlan(
  xmlDoc,
  beamLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  if (!xmlDoc || !beamLayoutMap?.size) {
    return { resolved: true, source: SOURCE, members: new Map(), unresolved: [], deferred: [] };
  }

  // trimはidentity単位でのみ許可するため、top R12-Wの副作用に依存せずidentityを付与する。
  for (const layout of beamLayoutMap.values()) {
    if (Array.isArray(layout?.segments) && layout.segments.length) {
      assignBeamBarIdentities(layout.segments, options.identityOptions || {});
    }
  }

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex =
    options.modelIndex || options.index || buildRebarModelIndex(xmlDoc, { scanTag });
  const supportFacts = buildSmallBeamSupportFacts(xmlDoc, scanTag, modelIndex);
  const requirementFacts = buildSmallBeamAnchorageRequirementFacts(
    xmlDoc,
    { beam: beamLayoutMap },
    supportFacts,
    scanTag,
    { ...options, modelIndex },
  );
  return buildSmallBeamBottomL3hRenderPlanFromFacts(requirementFacts, scanTag, {
    ...options,
    modelIndex,
  });
}
