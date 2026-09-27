/**
 * @fileoverview R12-X 一般小梁下端筋の直線定着 L3 を production RebarPath へ接続する。
 *
 * 日建連・JSCA 2023 §9-2 / 表3-2-2の L3 requirement を、R12-Mの実支持面と
 * 支持大梁側かぶりに対して bar-level で照合する。L3 が支持大梁内に収まる場合だけ、
 * 既存 member-local 主筋端から不足分を anchor-local の直線 RebarPath として延長する。
 *
 * L3 が不足する場合は L3h 候補へ暗黙変換せず deferred とする。L3h actual hook、
 * 斜め定着、基礎小梁、member trim は後続 stage とし、本モジュールでは fail-closed を維持する。
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { createLine, createRebarPath, validateRebarPath } from './rebarPath.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';
import { buildSmallBeamAnchorageRequirementFacts } from './smallBeamAnchorageRequirementFacts.js';
import { resolveSmallBeamSupportFaceGeometry } from './smallBeamSupportFaceGeometry.js';
import {
  hasUnsupportedSmallBeamSectionRotation,
  resolveSmallBeamSectionRollDegrees,
  SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON,
} from './smallBeamSectionOrientation.js';

const TOLERANCE_MM = 1e-6;
const SOURCE = 'R12-X-small-beam-bottom-L3-render-plan';

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    productionReady: false,
    generationStatus: 'UNRESOLVED',
    reason,
    source: SOURCE,
    productionPath: null,
    ...extra,
  };
}

function gradeKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function straightL3Requirement(group) {
  return (group?.requirement?.alternatives || []).find(
    (item) => item?.ok === true && String(item.lengthKind || '').toUpperCase() === 'L3',
  );
}

/**
 * 下端主筋1本について、L3直線定着の確保長さと必要な端部延長を解決する。
 *
 * L3は支持側躯体面（near face）から定着先端までの必要長さとして扱う。
 * STB部材端が支持大梁内部にある分は既存member主筋が既に担うため、3Dで追加するのは
 * `requiredL3 - nearFaceFromMemberEnd` の正部分だけとする。
 */
export function resolveSmallBeamBottomStraightL3Bar({
  scanTag,
  beamEl,
  supportEnd,
  supportContext,
  bar,
  requirement,
  index = null,
  barIndex = null,
} = {}) {
  if (!beamEl) return unresolved('small-beam-element-not-found');
  if (bar?.role && bar.role !== 'bottom') {
    return unresolved('small-beam-bottom-L3-role-mismatch', { role: bar.role || null });
  }
  if (supportEnd?.supportType !== 'GIRDER' || !supportEnd?.supportId) {
    return unresolved(`unsupported-bottom-support:${supportEnd?.supportType || 'UNKNOWN'}`);
  }
  if (!['start', 'end'].includes(supportEnd?.side)) {
    return unresolved('small-beam-bottom-L3-anchor-unresolved', { side: supportEnd?.side ?? null });
  }
  if (hasUnsupportedSmallBeamSectionRotation(beamEl)) {
    return unresolved(SMALL_BEAM_ROTATED_SECTION_UNSUPPORTED_REASON, {
      sectionRollDegrees: resolveSmallBeamSectionRollDegrees(beamEl),
    });
  }

  const requiredMm = Number(requirement?.requiredMm);
  const barDiaMm = Number(bar?.dia);
  const u = Number(bar?.u);
  const v = Number(bar?.v);
  if (!requirement?.ok || String(requirement?.lengthKind || '').toUpperCase() !== 'L3') {
    return unresolved(requirement?.reason || 'small-beam-bottom-L3-requirement-unresolved');
  }
  if (!(requiredMm > 0) || !(barDiaMm > 0) || !Number.isFinite(u) || !Number.isFinite(v)) {
    return unresolved('small-beam-bottom-L3-bar-facts-unresolved', {
      requiredMm: Number.isFinite(requiredMm) ? requiredMm : null,
      barDiaMm: Number.isFinite(barDiaMm) ? barDiaMm : null,
      u: Number.isFinite(u) ? u : null,
      v: Number.isFinite(v) ? v : null,
    });
  }

  const geometry = resolveSmallBeamSupportFaceGeometry(
    scanTag,
    beamEl,
    supportEnd,
    supportContext,
    { beamLateralOffsetMm: u, index },
  );
  if (!geometry?.resolved) {
    return unresolved(geometry?.reason || 'small-beam-bottom-L3-support-geometry-unresolved', {
      supportGeometry: geometry || null,
    });
  }

  const farFaceSide = geometry.farFaceSide;
  const coverFact = supportContext?.supportCoverBySide?.[farFaceSide];
  const supportCoverMm = Number(coverFact?.coverMm);
  if (!farFaceSide || !coverFact?.resolved || !(supportCoverMm >= 0)) {
    return unresolved(coverFact?.reason || 'small-beam-bottom-L3-far-face-cover-unresolved', {
      farFaceSide: farFaceSide || null,
      supportCover: coverFact || null,
      supportGeometry: geometry,
    });
  }

  const sinSkew = Number(geometry.sinSkew);
  if (!(sinSkew > 0)) {
    return unresolved('small-beam-bottom-L3-skew-projection-unresolved', {
      supportGeometry: geometry,
    });
  }

  const barRadiusMm = barDiaMm / 2;
  const farFaceCenterInsetNormalMm = supportCoverMm + barRadiusMm;
  const farFaceCenterInsetAlongBarMm = farFaceCenterInsetNormalMm / sinSkew;
  const availableFromNearMm = Number(geometry.effectiveEmbedmentMm) - farFaceCenterInsetAlongBarMm;
  if (!(availableFromNearMm > 0)) {
    return unresolved('small-beam-bottom-L3-nonpositive-available-length', {
      availableFromNearMm: Number.isFinite(availableFromNearMm) ? availableFromNearMm : null,
      supportGeometry: geometry,
      supportCoverMm,
      barRadiusMm,
    });
  }

  const beamEndT = Number(geometry.beamEndT);
  const nearFaceT = Number(geometry.nearFaceT);
  if (!Number.isFinite(beamEndT) || !Number.isFinite(nearFaceT)) {
    return unresolved('small-beam-bottom-L3-near-face-unresolved', { supportGeometry: geometry });
  }
  const nearFaceFromMemberEndMm =
    supportEnd.side === 'start' ? nearFaceT - beamEndT : beamEndT - nearFaceT;
  if (nearFaceFromMemberEndMm < -TOLERANCE_MM) {
    return unresolved('small-beam-bottom-L3-near-face-outside-member-side', {
      nearFaceFromMemberEndMm,
      nearFaceT,
      beamEndT,
    });
  }

  const normalizedNearFaceFromMemberEndMm = Math.max(0, nearFaceFromMemberEndMm);
  const availableExtensionMm = Math.max(0, availableFromNearMm - normalizedNearFaceFromMemberEndMm);
  const requiredExtensionMm = Math.max(0, requiredMm - normalizedNearFaceFromMemberEndMm);
  const l3Satisfied = availableFromNearMm + TOLERANCE_MM >= requiredMm;

  const common = {
    resolved: true,
    reason: null,
    source: SOURCE,
    mode: 'STRAIGHT_L3',
    side: supportEnd.side,
    supportId: String(supportEnd.supportId),
    barIndex: Number.isInteger(barIndex) ? barIndex : null,
    identityKey: bar?.identityKey || null,
    role: 'bottom',
    layer: bar?.layer ?? null,
    u,
    v,
    barDiaMm,
    grade: gradeKey(bar?.grade) || null,
    requiredMm,
    availableFromNearMm,
    nearFaceFromMemberEndMm: normalizedNearFaceFromMemberEndMm,
    requiredExtensionMm,
    availableExtensionMm,
    farFaceSide,
    supportCoverMm,
    supportCoverSource: coverFact.source || null,
    supportGeometry: geometry,
    productionPathCandidate: false,
    productionConsumer: null,
    productionPath: null,
  };

  if (!l3Satisfied) {
    return {
      ...common,
      productionReady: false,
      generationStatus: 'L3_INSUFFICIENT',
      alternativeRequired: true,
      reason: 'small-beam-bottom-L3-insufficient-use-L3h-or-special',
    };
  }

  if (requiredExtensionMm <= TOLERANCE_MM) {
    return {
      ...common,
      productionReady: true,
      generationStatus: 'SATISFIED_BY_MEMBER_PATH',
      alternativeRequired: false,
    };
  }
  if (requiredExtensionMm > availableExtensionMm + TOLERANCE_MM) {
    return unresolved('small-beam-bottom-L3-extension-exceeds-available', common);
  }

  const memberId = beamEl.getAttribute?.('id');
  const path = createRebarPath(
    [createLine({ x: u, y: v, z: 0 }, { x: u, y: v, z: -requiredExtensionMm })],
    {
      memberId: memberId === null || memberId === undefined ? null : String(memberId),
      memberTag: 'StbBeam',
      role: 'bottom',
      layer: bar?.layer ?? null,
      dia: barDiaMm,
      grade: gradeKey(bar?.grade) || null,
      identityKey: bar?.identityKey || null,
      identityStatus: bar?.identityStatus || (bar?.identityKey ? 'local' : 'unresolved'),
      anchor: supportEnd.side,
      endpoint: supportEnd.side,
      coordinateSpace: 'anchor-local',
      source: 'small-beam-r12-bottom-L3',
      ruleId: 'R12-X',
      bendGeometry: 'straight',
      anchorageMode: 'STRAIGHT_L3',
      anchorageLengthKind: 'L3',
      requiredAnchorageFromNearMm: requiredMm,
      nearFaceFromMemberEndMm: normalizedNearFaceFromMemberEndMm,
      extensionLengthMm: requiredExtensionMm,
      supportId: String(supportEnd.supportId),
    },
  );
  const validation = validateRebarPath(path);
  if (!validation.ok) {
    return unresolved('small-beam-bottom-L3-generated-path-invalid', {
      ...common,
      validation,
    });
  }

  return {
    ...common,
    productionReady: true,
    generationStatus: 'CENTERLINE_READY',
    alternativeRequired: false,
    productionPathCandidate: true,
    productionConsumer: 'beam-anchor-local-path',
    productionPath: path,
    validation,
  };
}

/**
 * 既存R12 requirement factsから、下端L3のread-only 3D render planを作る。
 */
export function buildSmallBeamBottomL3RenderPlanFromFacts(requirementFacts, scanTag, options = {}) {
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

    const entries = [];
    for (const end of beamFacts?.ends || []) {
      if (end?.status === 'FREE_END') continue;
      for (const group of end?.requirements || []) {
        if (group?.role !== 'bottom') continue;
        const l3 = straightL3Requirement(group);
        if (!l3) {
          unresolvedFacts.push({
            elementId: String(elementId),
            side: end.side || null,
            reason: group?.requirement?.reason || 'small-beam-bottom-L3-requirement-unresolved',
          });
          continue;
        }

        const bars = Array.isArray(group.bars) ? group.bars : [];
        bars.forEach((bar, barIndex) => {
          const fact = resolveSmallBeamBottomStraightL3Bar({
            scanTag,
            beamEl,
            supportEnd: end.support,
            supportContext: end.supportContext,
            bar,
            requirement: l3,
            index: modelIndex,
            barIndex,
          });
          if (!fact.resolved) {
            unresolvedFacts.push({
              elementId: String(elementId),
              side: end.side || null,
              barIndex,
              reason: fact.reason,
            });
            return;
          }
          if (fact.generationStatus === 'L3_INSUFFICIENT') {
            deferred.push({
              elementId: String(elementId),
              side: end.side || null,
              barIndex,
              identityKey: fact.identityKey || null,
              requiredMm: fact.requiredMm,
              availableMm: fact.availableFromNearMm,
              reason: fact.reason,
              nextAlternative: 'L3H',
            });
            return;
          }
          if (fact.generationStatus === 'SATISFIED_BY_MEMBER_PATH') return;

          const identityKey = fact.identityKey;
          if (
            fact.generationStatus !== 'CENTERLINE_READY' ||
            fact.productionReady !== true ||
            fact.productionPathCandidate !== true ||
            !fact.productionPath ||
            typeof identityKey !== 'string' ||
            identityKey.trim() === '' ||
            fact.productionPath.metadata?.identityKey !== identityKey
          ) {
            unresolvedFacts.push({
              elementId: String(elementId),
              side: end.side || null,
              barIndex,
              reason: 'small-beam-bottom-L3-production-identity-unresolved',
            });
            return;
          }
          entries.push({
            side: fact.side,
            role: 'bottom',
            barIndex,
            identityKey,
            generationStatus: 'CENTERLINE_READY',
            productionPathCandidate: true,
            productionConsumer: 'beam-anchor-local-path',
            productionPath: fact.productionPath,
            requiredMm: fact.requiredMm,
            availableMm: fact.availableFromNearMm,
          });
        });
      }
    }

    const seen = new Set();
    const uniqueEntries = [];
    for (const entry of entries) {
      const key = `${entry.side}|${entry.identityKey}`;
      if (seen.has(key)) {
        unresolvedFacts.push({
          elementId: String(elementId),
          side: entry.side,
          identityKey: entry.identityKey,
          reason: 'small-beam-bottom-L3-render-identity-duplicate',
        });
        continue;
      }
      seen.add(key);
      uniqueEntries.push(entry);
    }

    if (uniqueEntries.length > 0) {
      members.set(String(elementId), {
        elementId: String(elementId),
        elementName: beamFacts.elementName || null,
        sectionId:
          beamFacts.sectionId === null || beamFacts.sectionId === undefined
            ? null
            : String(beamFacts.sectionId),
        entries: uniqueEntries,
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

/** STB document + 既存beam layoutから下端L3 render planを構築する。 */
export function buildSmallBeamBottomL3RenderPlan(
  xmlDoc,
  beamLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  if (!xmlDoc || !beamLayoutMap?.size) {
    return { resolved: true, source: SOURCE, members: new Map(), unresolved: [], deferred: [] };
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
  return buildSmallBeamBottomL3RenderPlanFromFacts(requirementFacts, scanTag, {
    ...options,
    modelIndex,
  });
}
