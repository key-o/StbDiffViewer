/**
 * @fileoverview R12-W 一般小梁 VERTICAL_90 production gateを3D consumer向けplanへ集約する。
 *
 * R12 requirement -> candidate -> mode -> path plan -> actual path -> continuity -> identity
 * -> production gate の既存pipelineを再利用し、CENTERLINE_READYになったbarだけを
 * member単位のread-only render planへ抽出する。world変換・mesh生成はviewer側へ残す。
 */

import { createTagScanner } from '../columnSupportUtils.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';
import { buildSmallBeamAnchorageRequirementFacts } from './smallBeamAnchorageRequirementFacts.js';
import { attachSmallBeamVertical90CandidateFacts } from './smallBeamVerticalAnchorageCandidateFacts.js';
import { attachSmallBeamTopAnchorageModeFacts } from './smallBeamAnchorageModeFacts.js';
import { attachSmallBeamVertical90PathPlanFacts } from './smallBeamVerticalAnchoragePathPlanFacts.js';
import { attachSmallBeamVertical90ActualPathFacts } from './smallBeamVerticalAnchorageActualPathFacts.js';
import { attachSmallBeamVertical90ContinuityFacts } from './smallBeamVerticalAnchorageContinuity.js';
import { attachSmallBeamVertical90IdentityFacts } from './smallBeamVerticalAnchorageIdentity.js';
import { attachSmallBeamVertical90ProductionGateFacts } from './smallBeamVerticalAnchorageProductionGate.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';

const SOURCE = 'R12-W-small-beam-vertical-90-render-plan';

function signatureFromParsed(element) {
  return [element?.id, element?.id_section, element?.id_node_start, element?.id_node_end]
    .map((value) => (value === null || value === undefined ? '' : String(value)))
    .join('|');
}

function signatureFromXml(element) {
  return [
    element?.getAttribute?.('id'),
    element?.getAttribute?.('id_section'),
    element?.getAttribute?.('id_node_start'),
    element?.getAttribute?.('id_node_end'),
  ]
    .map((value) => (value === null || value === undefined ? '' : String(value)))
    .join('|');
}

/**
 * createBeamRebarMeshes() の入力配列が StbBeam 由来かをfail-closedで判定する。
 * StbGirder と完全同一signatureが存在する曖昧ケースでは false とする。
 */
export function isSmallBeamElementBatch(xmlDoc, elements, sharedScanTag = null) {
  if (!xmlDoc || !Array.isArray(elements) || elements.length === 0) return false;
  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const beamSignatures = new Set(scanTag('StbBeam').map(signatureFromXml));
  const girderSignatures = new Set(scanTag('StbGirder').map(signatureFromXml));
  return elements.every((element) => {
    const signature = signatureFromParsed(element);
    return beamSignatures.has(signature) && !girderSignatures.has(signature);
  });
}

function groupGateReady(gate, group) {
  const bars = Array.isArray(group?.bars) ? group.bars : [];
  if (
    gate?.resolved !== true ||
    gate.productionReady !== true ||
    gate.productionGateReady !== true ||
    gate.generationStatus !== 'CENTERLINE_READY' ||
    gate.productionPathCandidate !== true ||
    gate.productionConsumer !== 'beam-anchor-local-path' ||
    !Array.isArray(gate.barGates) ||
    bars.length === 0 ||
    gate.barGates.length !== bars.length
  ) {
    return false;
  }

  return gate.barGates.every((barGate, index) => {
    const barIdentityKey = bars[index]?.identityKey;
    return (
      barGate?.barIndex === index &&
      typeof barIdentityKey === 'string' &&
      barIdentityKey.trim() !== '' &&
      barGate.identityKey === barIdentityKey
    );
  });
}

function gateReady(gate) {
  return (
    gate?.resolved === true &&
    gate.productionReady === true &&
    gate.productionGateReady === true &&
    gate.generationStatus === 'CENTERLINE_READY' &&
    gate.productionPathCandidate === true &&
    gate.productionConsumer === 'beam-anchor-local-path' &&
    gate.productionPath
  );
}

function gateMatchesEnd(gate, endSide) {
  return (
    ['start', 'end'].includes(endSide) &&
    gate?.side === endSide &&
    gate.productionPath?.metadata?.anchor === endSide
  );
}

function gateIdentityMatchesPath(gate) {
  return (
    Boolean(gate?.identityKey) && gate.productionPath?.metadata?.identityKey === gate.identityKey
  );
}

/**
 * R12-V factsから3D consumerに必要な最小情報だけをmember mapへ抽出する。
 */
export function buildSmallBeamVertical90RenderPlanFromFacts(requirementFacts) {
  const members = new Map();
  const unresolved = [];

  for (const [elementId, beamFacts] of requirementFacts?.beam || []) {
    if (beamFacts?.isFoundation === true) continue;
    const candidates = [];

    for (const end of beamFacts?.ends || []) {
      if (end?.status === 'FREE_END') continue;
      for (const group of end?.requirements || []) {
        if (group?.role !== 'top') continue;
        const gate = group.vertical90ProductionGate;
        if (group.anchorageMode?.mode !== 'VERTICAL_90') continue;
        if (!groupGateReady(gate, group)) {
          unresolved.push({
            elementId: String(elementId),
            side: end.side || null,
            reason: gate?.reason || 'small-beam-vertical-90-production-gate-not-ready',
          });
          continue;
        }

        for (const barGate of gate.barGates) {
          if (!gateReady(barGate)) {
            unresolved.push({
              elementId: String(elementId),
              side: end.side || null,
              barIndex: barGate?.barIndex ?? null,
              reason: barGate?.reason || 'small-beam-vertical-90-bar-production-gate-not-ready',
            });
            continue;
          }
          if (!gateMatchesEnd(barGate, end.side)) {
            unresolved.push({
              elementId: String(elementId),
              side: end.side || null,
              barIndex: barGate?.barIndex ?? null,
              reason: 'small-beam-vertical-90-render-end-anchor-mismatch',
              gateSide: barGate?.side || null,
              pathAnchor: barGate?.productionPath?.metadata?.anchor || null,
            });
            continue;
          }
          if (!gateIdentityMatchesPath(barGate)) {
            unresolved.push({
              elementId: String(elementId),
              side: end.side || null,
              barIndex: barGate?.barIndex ?? null,
              reason: 'small-beam-vertical-90-render-gate-identity-mismatch',
              gateIdentityKey: barGate?.identityKey || null,
              pathIdentityKey: barGate?.productionPath?.metadata?.identityKey || null,
            });
            continue;
          }
          candidates.push({
            side: barGate.side,
            role: group.role,
            barIndex: barGate.barIndex ?? null,
            identityKey: barGate.identityKey,
            generationStatus: barGate.generationStatus,
            productionPathCandidate: true,
            productionConsumer: 'beam-anchor-local-path',
            productionPath: barGate.productionPath,
          });
        }
      }
    }

    const byKey = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.side || ''}|${candidate.identityKey || ''}`;
      const list = byKey.get(key);
      if (list) list.push(candidate);
      else byKey.set(key, [candidate]);
    }

    const entries = [];
    for (const [key, list] of byKey) {
      if (!list[0]?.identityKey || list.length !== 1) {
        unresolved.push({
          elementId: String(elementId),
          side: list[0]?.side || null,
          identityKey: list[0]?.identityKey || null,
          reason:
            list.length === 1
              ? 'small-beam-vertical-90-render-identity-unresolved'
              : 'small-beam-vertical-90-render-identity-duplicate',
          duplicateKey: key,
        });
        continue;
      }
      entries.push(list[0]);
    }

    if (entries.length > 0) {
      members.set(String(elementId), {
        elementId: String(elementId),
        elementName: beamFacts.elementName || null,
        sectionId:
          beamFacts.sectionId === null || beamFacts.sectionId === undefined
            ? null
            : String(beamFacts.sectionId),
        entries,
      });
    }
  }

  return {
    resolved: unresolved.length === 0,
    source: SOURCE,
    members,
    unresolved,
  };
}

/**
 * STB documentと既存beam layoutからR12-S〜Vを実行し、3D render planへ抽出する。
 * layoutの再構築は行わないため、viewerが描画に使うbar identityと同じobjectを共有する。
 */
export function buildSmallBeamVertical90RenderPlan(
  xmlDoc,
  beamLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  if (!xmlDoc || !beamLayoutMap?.size) {
    return { resolved: true, source: SOURCE, members: new Map(), unresolved: [] };
  }

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex =
    options.modelIndex || options.index || buildRebarModelIndex(xmlDoc, { scanTag });
  const beamLayoutMaps = { beam: beamLayoutMap };
  const supportFacts = buildSmallBeamSupportFacts(xmlDoc, scanTag, modelIndex);
  let requirementFacts = buildSmallBeamAnchorageRequirementFacts(
    xmlDoc,
    beamLayoutMaps,
    supportFacts,
    scanTag,
    { ...options, modelIndex },
  );
  requirementFacts = attachSmallBeamVertical90CandidateFacts(requirementFacts);
  requirementFacts = attachSmallBeamTopAnchorageModeFacts(requirementFacts);
  requirementFacts = attachSmallBeamVertical90PathPlanFacts(requirementFacts);
  requirementFacts = attachSmallBeamVertical90ActualPathFacts(requirementFacts);
  requirementFacts = attachSmallBeamVertical90ContinuityFacts(
    requirementFacts,
    beamLayoutMaps,
    scanTag,
    modelIndex,
  );
  requirementFacts = attachSmallBeamVertical90IdentityFacts(requirementFacts);
  requirementFacts = attachSmallBeamVertical90ProductionGateFacts(requirementFacts);

  return buildSmallBeamVertical90RenderPlanFromFacts(requirementFacts);
}
