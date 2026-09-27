/**
 * @fileoverview R13 基礎梁端と基礎柱・独立基礎・杭・布基礎の接続topologyをfacts化する。
 *
 * geometry・定着長・あばら筋範囲はここでは決めない。
 * StbGirder / StbBeam の isFoundation と参照 StbSecBeam_RC.isFoundation を正規化し、
 * 各始終端節点で ST-Bridge に明示された同一節点関係だけを収集する。
 * 同一カテゴリに複数候補がある場合は推定せず unresolved とする。
 *
 * @module data/extractors/rebar3d/foundationBeamTopologyFacts
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';

const BEAM_SPECS = Object.freeze([
  { tagName: 'StbGirder', memberType: 'GIRDER' },
  { tagName: 'StbBeam', memberType: 'BEAM' },
]);

const END_SPECS = Object.freeze([
  { side: 'start', nodeAttr: 'id_node_start' },
  { side: 'end', nodeAttr: 'id_node_end' },
]);

function readBooleanAttribute(element, name) {
  const value = String(element?.getAttribute?.(name) ?? '')
    .trim()
    .toLowerCase();
  return value === 'true' || value === '1';
}

function normalizeStructure(element) {
  return String(element?.getAttribute?.('kind_structure') || '').toUpperCase() || null;
}

function elementFact(element, extra = {}) {
  return {
    id: element?.getAttribute?.('id') || null,
    name: element?.getAttribute?.('name') || null,
    ...extra,
  };
}

function sameNode(element, attrName, nodeId) {
  return String(element?.getAttribute?.(attrName) || '') === String(nodeId || '');
}

function collectAtNode(scanTag, tagName, attrName, nodeId, extraFactory = null) {
  return scanTag(tagName)
    .filter((element) => sameNode(element, attrName, nodeId))
    .map((element) =>
      elementFact(element, {
        tagName,
        ...(typeof extraFactory === 'function' ? extraFactory(element) : {}),
      }),
    );
}

function collectStripFootings(scanTag, nodeId) {
  const result = [];
  for (const element of scanTag('StbStripFooting')) {
    let endpoint = null;
    if (sameNode(element, 'id_node_start', nodeId)) endpoint = 'start';
    if (sameNode(element, 'id_node_end', nodeId)) endpoint = endpoint ? 'both' : 'end';
    if (!endpoint) continue;
    result.push(
      elementFact(element, {
        tagName: 'StbStripFooting',
        endpoint,
        sectionId: element.getAttribute('id_section') || null,
        kindStructure: normalizeStructure(element),
      }),
    );
  }
  return result;
}

function collectColumnsAbove(scanTag, nodeId) {
  const result = [];
  for (const tagName of ['StbColumn', 'StbPost']) {
    for (const element of scanTag(tagName)) {
      if (!sameNode(element, 'id_node_bottom', nodeId)) continue;
      result.push(
        elementFact(element, {
          tagName,
          sectionId: element.getAttribute('id_section') || null,
          kindStructure: normalizeStructure(element),
        }),
      );
    }
  }
  return result;
}

function uniqueOrNull(values) {
  return values.length === 1 ? values[0] : null;
}

function primaryContext(end) {
  if (end.foundationColumn) return 'FOUNDATION_COLUMN';
  if (end.footing) return 'FOOTING';
  if (end.pile) return 'PILE';
  if (end.columnsAbove.length === 1) return 'COLUMN';
  if (end.stripFootings.length > 0) return 'STRIP_FOOTING';
  return 'UNRESOLVED';
}

function ambiguityReasons(end) {
  const reasons = [];
  if (end.foundationColumns.length > 1) reasons.push('multiple-foundation-columns-at-node');
  if (end.footings.length > 1) reasons.push('multiple-footings-at-node');
  if (end.piles.length > 1) reasons.push('multiple-piles-at-node');
  if (end.columnsAbove.length > 1) reasons.push('multiple-columns-above-at-node');
  return reasons;
}

function resolveEndFacts(scanTag, endSpec, member) {
  const nodeId = member.getAttribute(endSpec.nodeAttr) || null;
  if (!nodeId) {
    return {
      side: endSpec.side,
      nodeId: null,
      node: null,
      foundationColumns: [],
      foundationColumn: null,
      footings: [],
      footing: null,
      piles: [],
      pile: null,
      stripFootings: [],
      columnsAbove: [],
      primaryContext: 'UNRESOLVED',
      resolved: false,
      reasons: ['missing-end-node-id'],
    };
  }

  const node = findElementById(scanTag, 'StbNode', nodeId);
  const foundationColumns = collectAtNode(
    scanTag,
    'StbFoundationColumn',
    'id_node',
    nodeId,
    (element) => ({
      sectionFdId: element.getAttribute('id_section_FD') || null,
      sectionWrId: element.getAttribute('id_section_WR') || null,
      lengthFdMm: Number(element.getAttribute('length_FD')) || null,
      lengthWrMm: Number(element.getAttribute('length_WR')) || null,
      rotateDeg: Number(element.getAttribute('rotate')) || 0,
      offsetZMm: Number(element.getAttribute('offset_Z')) || 0,
      offsetFdXmm: Number(element.getAttribute('offset_FD_X')) || 0,
      offsetFdYmm: Number(element.getAttribute('offset_FD_Y')) || 0,
      offsetWrXmm: Number(element.getAttribute('offset_WR_X')) || 0,
      offsetWrYmm: Number(element.getAttribute('offset_WR_Y')) || 0,
      thicknessAddFdStartXmm: Number(element.getAttribute('thickness_add_FD_start_X')) || 0,
      thicknessAddFdEndXmm: Number(element.getAttribute('thickness_add_FD_end_X')) || 0,
      thicknessAddFdStartYmm: Number(element.getAttribute('thickness_add_FD_start_Y')) || 0,
      thicknessAddFdEndYmm: Number(element.getAttribute('thickness_add_FD_end_Y')) || 0,
      kindStructure: normalizeStructure(element),
    }),
  );
  const footings = collectAtNode(scanTag, 'StbFooting', 'id_node', nodeId, (element) => ({
    sectionId: element.getAttribute('id_section') || null,
    rotateDeg: Number(element.getAttribute('rotate')) || 0,
    offsetXmm: Number(element.getAttribute('offset_X')) || 0,
    offsetYmm: Number(element.getAttribute('offset_Y')) || 0,
    levelBottomMm: Number(element.getAttribute('level_bottom')) || 0,
  }));
  const piles = collectAtNode(scanTag, 'StbPile', 'id_node', nodeId, (element) => ({
    sectionId: element.getAttribute('id_section') || null,
    kindStructure: normalizeStructure(element),
    offsetXmm: Number(element.getAttribute('offset_X')) || 0,
    offsetYmm: Number(element.getAttribute('offset_Y')) || 0,
    levelTopMm: Number(element.getAttribute('level_top')) || 0,
  }));
  const stripFootings = collectStripFootings(scanTag, nodeId);
  const columnsAbove = collectColumnsAbove(scanTag, nodeId);

  const end = {
    side: endSpec.side,
    nodeId,
    node: node
      ? {
          id: nodeId,
          kind: node.getAttribute('kind') || null,
          X: Number(node.getAttribute('X')),
          Y: Number(node.getAttribute('Y')),
          Z: Number(node.getAttribute('Z')),
        }
      : null,
    foundationColumns,
    foundationColumn: uniqueOrNull(foundationColumns),
    footings,
    footing: uniqueOrNull(footings),
    piles,
    pile: uniqueOrNull(piles),
    stripFootings,
    columnsAbove,
    primaryContext: null,
    resolved: false,
    reasons: [],
  };

  if (!node) end.reasons.push('end-node-not-found');
  end.reasons.push(...ambiguityReasons(end));
  end.primaryContext = primaryContext(end);
  end.resolved = end.reasons.length === 0;
  return end;
}

function resolveSectionFacts(scanTag, member) {
  const sectionId = member.getAttribute('id_section') || null;
  if (!sectionId) {
    return {
      sectionId: null,
      sectionName: null,
      sectionIsFoundation: false,
      resolved: false,
      reason: 'missing-section-id',
    };
  }
  const section = findElementById(scanTag, 'StbSecBeam_RC', sectionId);
  if (!section) {
    return {
      sectionId,
      sectionName: null,
      sectionIsFoundation: false,
      resolved: false,
      reason: 'rc-beam-section-not-found',
    };
  }
  return {
    sectionId,
    sectionName: section.getAttribute('name') || null,
    sectionIsFoundation: readBooleanAttribute(section, 'isFoundation'),
    resolved: true,
    reason: null,
  };
}

export function buildFoundationBeamTopologyFacts(xmlDoc, sharedScanTag = null) {
  const beam = new Map();
  const entries = [];
  const unresolved = [];
  if (!xmlDoc) return { beam, entries, unresolved };

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  for (const spec of BEAM_SPECS) {
    for (const member of scanTag(spec.tagName)) {
      const kindStructure = normalizeStructure(member);
      if (kindStructure && kindStructure !== 'RC') continue;

      const elementId = member.getAttribute('id');
      if (!elementId) continue;

      const section = resolveSectionFacts(scanTag, member);
      const memberIsFoundation = readBooleanAttribute(member, 'isFoundation');
      const isFoundation = memberIsFoundation || section.sectionIsFoundation;
      if (!isFoundation) continue;

      const ends = END_SPECS.map((endSpec) => resolveEndFacts(scanTag, endSpec, member));
      const facts = {
        elementId,
        elementName: member.getAttribute('name') || null,
        memberTag: spec.tagName,
        memberType: spec.memberType,
        kindStructure,
        sectionId: section.sectionId,
        sectionName: section.sectionName,
        memberIsFoundation,
        sectionIsFoundation: section.sectionIsFoundation,
        sectionResolved: section.resolved,
        sectionUnresolvedReason: section.reason,
        source: 'R13-foundation-beam-topology-facts',
        ends,
        resolved: ends.every((end) => end.resolved),
      };
      entries.push(facts);
      beam.set(String(elementId), facts);

      for (const end of ends) {
        if (end.resolved) continue;
        unresolved.push({
          elementId: String(elementId),
          elementName: facts.elementName,
          memberTag: spec.tagName,
          side: end.side,
          nodeId: end.nodeId,
          reasons: [...end.reasons],
          source: facts.source,
        });
      }
    }
  }

  return { beam, entries: Object.freeze(entries.slice()), unresolved };
}
