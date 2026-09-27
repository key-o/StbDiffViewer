/**
 * @fileoverview R13 基礎大梁定着をidentity付きanchor-local production planへ集約する。
 *
 * topology -> end-bar facts -> 2023標準図requirement -> main-bar identity -> geometry gate
 * の順に解決し、member全体で一意にREADYな場合だけrendererへ渡す。
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import { buildFoundationBeamTopologyFacts } from './foundationBeamTopologyFacts.js';
import { buildFoundationBeamEndBarFacts } from './foundationBeamEndBarFacts.js';
import { applyFoundationBeamAnchorageRequirements2023 } from './foundationBeamAnchorageRequirementFacts2023.js';
import { applyFoundationBeamMainBarIdentities2023 } from './foundationBeamIdentityFacts2023.js';
import { resolveFoundationBeamAnchorageGeometry2023 } from './foundationBeamAnchorageGeometry2023.js';
import { createRebarPath, validateRebarPath } from './rebarPath.js';

const SOURCE = 'R13-foundation-beam-anchorage-render-plan-2023';

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

/** createBeamRebarMeshes()入力がStbGirder由来かを曖昧ケースを除外して判定する。 */
export function isFoundationGirderElementBatch(xmlDoc, elements, sharedScanTag = null) {
  if (!xmlDoc || !Array.isArray(elements) || elements.length === 0) return false;
  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const girderSignatures = new Set(scanTag('StbGirder').map(signatureFromXml));
  const beamSignatures = new Set(scanTag('StbBeam').map(signatureFromXml));
  return elements.every((element) => {
    const signature = signatureFromParsed(element);
    return girderSignatures.has(signature) && !beamSignatures.has(signature);
  });
}

function bySide(ends) {
  const result = new Map();
  for (const end of ends || []) {
    if (end?.side === 'start' || end?.side === 'end') result.set(end.side, end);
  }
  return result;
}

function unresolved(elementId, reason, extra = {}) {
  return { elementId: String(elementId), reason, source: SOURCE, ...extra };
}

function toProductionPath(path, beamFact, end, bar) {
  if (!path || !validateRebarPath(path).ok) return null;
  const productionPath = createRebarPath(path.primitives, {
    ...path.metadata,
    memberId: String(beamFact.elementId),
    memberTag: 'StbGirder',
    endpoint: end.side,
    role: bar.role,
    layer: bar.layer ?? null,
    identityKey: bar.identityKey,
    identityStatus: bar.identityStatus || 'local',
    source: 'foundation-beam-r13-anchorage-production-candidate',
    ruleId: 'R13',
    renderReady: false,
    productionReady: false,
    productionPathCandidate: true,
    productionConsumer: 'beam-anchor-local-path',
  });
  return validateRebarPath(productionPath).ok ? productionPath : null;
}

/**
 * requirement + identity済みfactsからmember単位のproduction planを構築する。
 * 片端・一部barだけの描画は行わず、member内で1件でも未解決ならそのmemberをplanへ入れない。
 */
export function buildFoundationBeamAnchorageRenderPlanFromFacts2023(
  identityFacts,
  topologyFacts,
  scanTag,
  options = {},
) {
  const members = new Map();
  const unresolvedFacts = [];
  const geometryResolver = options.geometryResolver || resolveFoundationBeamAnchorageGeometry2023;
  if (!(identityFacts?.beam instanceof Map) || !(topologyFacts?.beam instanceof Map)) {
    return { resolved: false, source: SOURCE, members, unresolved: [] };
  }

  for (const [elementId, beamFact] of identityFacts.beam) {
    if (beamFact?.memberTag !== 'StbGirder') continue;
    const topology = topologyFacts.beam.get(String(elementId)) || null;
    const beamEl = findElementById(scanTag, 'StbGirder', String(elementId), options.index || null);
    if (!topology || !beamEl) {
      unresolvedFacts.push(
        unresolved(
          elementId,
          !topology
            ? 'foundation-beam-render-topology-missing'
            : 'foundation-beam-render-element-missing',
        ),
      );
      continue;
    }
    if (beamFact.anchorageRequirementResolved !== true || beamFact.identityResolved !== true) {
      unresolvedFacts.push(
        unresolved(
          elementId,
          beamFact.anchorageRequirementResolved !== true
            ? 'foundation-beam-render-requirement-unresolved'
            : 'foundation-beam-render-identity-unresolved',
        ),
      );
      continue;
    }

    const topologyEnds = bySide(topology.ends);
    const entries = [];
    const memberUnresolved = [];
    for (const end of beamFact.ends || []) {
      const topologyEnd = topologyEnds.get(end.side) || null;
      if (!topologyEnd?.resolved) {
        memberUnresolved.push(
          unresolved(elementId, 'foundation-beam-render-end-topology-unresolved', {
            side: end.side || null,
          }),
        );
        continue;
      }
      for (const bar of end.bars || []) {
        if (bar?.identityResolved !== true || !bar.identityKey) {
          memberUnresolved.push(
            unresolved(
              elementId,
              bar?.identityReason || 'foundation-beam-render-bar-identity-unresolved',
              {
                side: end.side,
                barIndex: bar?.barIndex ?? null,
              },
            ),
          );
          continue;
        }
        const geometry = geometryResolver({
          scanTag,
          beamEl,
          endFact: topologyEnd,
          bar,
          index: options.index || null,
        });
        if (geometry?.status !== 'READY' || geometry?.geometryReady !== true || !geometry.path) {
          memberUnresolved.push(
            unresolved(
              elementId,
              geometry?.reason || 'foundation-beam-render-geometry-unresolved',
              {
                side: end.side,
                barIndex: bar.barIndex ?? null,
                stage: geometry?.stage || null,
              },
            ),
          );
          continue;
        }
        const productionPath = toProductionPath(geometry.path, beamFact, end, bar);
        if (!productionPath) {
          memberUnresolved.push(
            unresolved(elementId, 'foundation-beam-render-production-path-invalid', {
              side: end.side,
              barIndex: bar.barIndex ?? null,
            }),
          );
          continue;
        }
        entries.push({
          side: end.side,
          role: bar.role,
          layer: bar.layer ?? null,
          barIndex: bar.barIndex ?? null,
          identityKey: bar.identityKey,
          generationStatus: 'CENTERLINE_READY',
          geometryReady: true,
          productionReady: false,
          productionPathCandidate: true,
          productionConsumer: 'beam-anchor-local-path',
          productionPath,
          geometry,
        });
      }
    }

    const uniqueKeys = new Set();
    for (const entry of entries) {
      const key = `${entry.side}|${entry.identityKey}`;
      if (uniqueKeys.has(key)) {
        memberUnresolved.push(
          unresolved(elementId, 'foundation-beam-render-identity-duplicate', {
            side: entry.side,
            identityKey: entry.identityKey,
          }),
        );
      }
      uniqueKeys.add(key);
    }

    if (memberUnresolved.length > 0 || entries.length === 0) {
      unresolvedFacts.push(
        ...memberUnresolved.map((item) => ({ ...item, atomicMemberRollback: true })),
      );
      if (entries.length === 0 && memberUnresolved.length === 0) {
        unresolvedFacts.push(
          unresolved(elementId, 'foundation-beam-render-no-ready-entry', {
            atomicMemberRollback: true,
          }),
        );
      }
      continue;
    }

    members.set(String(elementId), {
      elementId: String(elementId),
      elementName: beamFact.elementName || null,
      sectionId: beamFact.sectionId == null ? null : String(beamFact.sectionId),
      memberTag: 'StbGirder',
      entries,
      endpointTrims: [],
      source: SOURCE,
    });
  }

  return {
    resolved: unresolvedFacts.length === 0,
    source: SOURCE,
    members,
    unresolved: unresolvedFacts,
  };
}

/** STB document + girder layoutからR13基礎大梁定着planを構築する。 */
export function buildFoundationBeamAnchorageRenderPlan2023(
  xmlDoc,
  girderLayoutMap,
  options = {},
  sharedScanTag = null,
) {
  const members = new Map();
  if (!xmlDoc || !(girderLayoutMap instanceof Map) || girderLayoutMap.size === 0) {
    return { resolved: true, source: SOURCE, members, unresolved: [] };
  }
  const scanTag = sharedScanTag || options.scanTag || createTagScanner(xmlDoc);
  const topologyFacts = buildFoundationBeamTopologyFacts(xmlDoc, scanTag);
  const endBarFacts = buildFoundationBeamEndBarFacts(xmlDoc, topologyFacts, {
    ...options,
    scanTag,
    layoutMaps: { girder: girderLayoutMap, beam: new Map() },
  });
  const requirementFacts = applyFoundationBeamAnchorageRequirements2023(
    endBarFacts,
    topologyFacts,
    options,
  );
  const identityFacts = applyFoundationBeamMainBarIdentities2023(
    requirementFacts,
    girderLayoutMap,
    options,
  );
  return buildFoundationBeamAnchorageRenderPlanFromFacts2023(
    identityFacts,
    topologyFacts,
    scanTag,
    options,
  );
}

export const _foundationBeamAnchorageRenderPlan2023Internals = Object.freeze({
  bySide,
  toProductionPath,
});
