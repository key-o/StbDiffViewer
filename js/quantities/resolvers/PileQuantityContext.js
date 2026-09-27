/**
 * @fileoverview StbPile quantity context resolver。
 */

import { getSectionFromMap } from './LinearMemberQuantityContext.js';

export const PILE_QUANTITY_CONFIG = Object.freeze({
  Pile: {
    stbElementType: 'StbPile',
    elementsKey: 'pileElements',
    sectionsKey: 'pileSections',
  },
});

function tagName(node) {
  const name = node?.localName || node?.nodeName || '';
  const index = name.indexOf(':');
  return index >= 0 ? name.slice(index + 1) : name;
}

function elementsByTag(root, name) {
  if (!root || !name) return [];
  const direct = Array.from(root.getElementsByTagName?.(name) || []);
  if (direct.length) return direct;
  return Array.from(root.getElementsByTagNameNS?.('*', name) || []);
}

function findSectionNode(document, section) {
  if (!document || !section?.sectionType || section.id === null || section.id === undefined)
    return null;
  return (
    elementsByTag(document, section.sectionType).find(
      (node) => String(node.getAttribute?.('id')) === String(section.id),
    ) || null
  );
}

function numberAttr(node, name) {
  const raw = node?.getAttribute?.(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function pointFromNode(node) {
  if (!node) return null;
  const x = Number(node.x ?? node.X);
  const y = Number(node.y ?? node.Y);
  const z = Number(node.z ?? node.Z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function resolvePoint(nodes, id) {
  return pointFromNode(nodes?.get?.(String(id)) ?? nodes?.get?.(Number.parseInt(id, 10)));
}

function firstByNames(root, names) {
  for (const name of names) {
    const node = elementsByTag(root, name)[0];
    if (node) return node;
  }
  return null;
}

function parseRcShape(sectionNode) {
  const straight = firstByNames(sectionNode, [
    'StbSecPile_RC_ConventionalStraight',
    'StbSecPile_RC_Straight',
  ]);
  if (straight) return { kind: 'RC_STRAIGHT', Dmm: numberAttr(straight, 'D') };

  const extendedFoot = firstByNames(sectionNode, [
    'StbSecPile_RC_ConventionalExtendedFoot',
    'StbSecPile_RC_ExtendedFoot',
  ]);
  if (extendedFoot) {
    return {
      kind: 'RC_EXTENDED_FOOT',
      DaxialMm: numberAttr(extendedFoot, 'D_axial'),
      DextendedFootMm: numberAttr(extendedFoot, 'D_extended_foot'),
      lengthExtendedFootMm: numberAttr(extendedFoot, 'length_extended_foot'),
      angleExtendedFootDeg: numberAttr(extendedFoot, 'angle_extended_foot_taper'),
    };
  }

  const extendedTop = firstByNames(sectionNode, [
    'StbSecPile_RC_ConventionalExtendedTop',
    'StbSecPile_RC_ExtendedTop',
  ]);
  if (extendedTop) {
    return {
      kind: 'RC_EXTENDED_TOP',
      DaxialMm: numberAttr(extendedTop, 'D_axial'),
      DextendedTopMm: numberAttr(extendedTop, 'D_extended_top'),
      angleExtendedTopDeg: numberAttr(extendedTop, 'angle_extended_top_taper'),
    };
  }

  const extendedTopFoot = firstByNames(sectionNode, [
    'StbSecPile_RC_ConventionalExtendedTopFoot',
    'StbSecPile_RC_ExtendedTopFoot',
  ]);
  if (extendedTopFoot) {
    return {
      kind: 'RC_EXTENDED_TOP_FOOT',
      DaxialMm: numberAttr(extendedTopFoot, 'D_axial'),
      DextendedTopMm: numberAttr(extendedTopFoot, 'D_extended_top'),
      DextendedFootMm: numberAttr(extendedTopFoot, 'D_extended_foot'),
      angleExtendedTopDeg: numberAttr(extendedTopFoot, 'angle_extended_top_taper'),
      lengthExtendedFootMm: numberAttr(extendedTopFoot, 'length_extended_foot'),
      angleExtendedFootDeg: numberAttr(extendedTopFoot, 'angle_extended_foot_taper'),
    };
  }

  return { kind: 'RC_UNKNOWN' };
}

function parseSteelSegments(sectionNode) {
  const figure = elementsByTag(sectionNode, 'StbSecFigurePile_S')[0];
  if (!figure) return { kind: 'S_UNKNOWN', segments: [] };
  const segments = [];
  for (const [kind, name, attrs] of [
    ['STRAIGHT', 'StbSecPile_S_Straight', ['id_order', 'length_pile', 'D', 't']],
    ['ROTATIONAL', 'StbSecPile_S_Rotational', ['id_order', 'length_pile', 'D1', 'D2', 't']],
    ['TAPER', 'StbSecPile_S_Taper', ['id_order', 'length_pile', 'D1', 'D2', 't']],
    ['PRODUCT', 'StbSecPile_S_Product', ['id_order', 'length_pile']],
  ]) {
    for (const node of elementsByTag(figure, name)) {
      const data = { kind };
      for (const attr of attrs) data[attr] = numberAttr(node, attr);
      if (kind === 'PRODUCT') {
        data.product_code = node.getAttribute?.('product_code') || null;
        data.release_time = node.getAttribute?.('release_time') || null;
      }
      segments.push(data);
    }
  }
  segments.sort((a, b) => Number(a.id_order || 0) - Number(b.id_order || 0));
  return { kind: 'S_SEGMENTS', segments };
}

function resolveShape(sectionNode) {
  if (!sectionNode) return { kind: 'MISSING' };
  const name = tagName(sectionNode);
  if (name === 'StbSecPile_RC') return parseRcShape(sectionNode);
  if (name === 'StbSecPile_S') return parseSteelSegments(sectionNode);
  if (name === 'StbSecPilePrecast' || name === 'StbSecPileProduct') {
    return { kind: 'PRODUCT_SECTION' };
  }
  return { kind: 'UNSUPPORTED_SECTION', sectionTag: name };
}

export function buildPileQuantityContexts(
  parsedData,
  elementType,
  { modelSide = null, revision = null, document = null } = {},
) {
  const shortType = String(elementType || '').replace(/^Stb/, '');
  const config = PILE_QUANTITY_CONFIG[shortType];
  if (!config || !parsedData) return [];
  const elements = parsedData[config.elementsKey];
  if (!Array.isArray(elements)) return [];
  const sections = parsedData[config.sectionsKey];
  const nodes = parsedData.nodes || parsedData.nodeMapRaw || new Map();

  return elements.map((element) => {
    const section = getSectionFromMap(sections, element.id_section);
    const sectionNode = findSectionNode(document, section);
    const points =
      element.pileFormat === '2node' || (element.id_node_bottom && element.id_node_top)
        ? [resolvePoint(nodes, element.id_node_bottom), resolvePoint(nodes, element.id_node_top)]
        : [];
    return {
      modelSide,
      revision,
      elementType: config.stbElementType,
      element,
      section,
      sectionNode,
      shape: resolveShape(sectionNode),
      points,
    };
  });
}
