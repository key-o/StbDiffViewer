/**
 * @fileoverview StbFooting quantity context resolver。
 */

import { getSectionFromMap } from './LinearMemberQuantityContext.js';

export const FOOTING_QUANTITY_CONFIG = Object.freeze({
  Footing: {
    stbElementType: 'StbFooting',
    elementsKey: 'footingElements',
    sectionsKey: 'footingSections',
    nodeMode: 'single',
  },
  StripFooting: {
    stbElementType: 'StbStripFooting',
    elementsKey: 'stripFootingElements',
    sectionsKey: 'footingSections',
    nodeMode: 'line',
  },
});

function elementTagName(element) {
  const name = element?.localName || element?.nodeName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function elementsByTag(root, tagName) {
  if (!root || !tagName) return [];
  const direct = Array.from(root.getElementsByTagName?.(tagName) || []);
  if (direct.length > 0) return direct;
  return Array.from(root.getElementsByTagNameNS?.('*', tagName) || []);
}

function findSectionNode(document, section) {
  if (!document || !section?.sectionType || section?.id === null || section?.id === undefined) {
    return null;
  }
  return (
    elementsByTag(document, section.sectionType).find(
      (node) => String(node.getAttribute?.('id')) === String(section.id),
    ) || null
  );
}

function findMemberNode(document, elementType, element) {
  if (!document || !elementType || element?.id === null || element?.id === undefined) return null;
  return (
    elementsByTag(document, elementType).find(
      (node) => String(node.getAttribute?.('id')) === String(element.id),
    ) || null
  );
}

function firstDescendant(root, tagName) {
  return elementsByTag(root, tagName)[0] || null;
}

function numberAttr(node, name, fallback = null) {
  const raw = node?.getAttribute?.(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function numberValueOrAttr(element, propertyName, node, attrName, fallback = null) {
  const raw = element?.[propertyName];
  if (raw !== null && raw !== undefined && raw !== '') {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  return numberAttr(node, attrName, fallback);
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

function resolveShape(sectionNode) {
  if (!sectionNode || elementTagName(sectionNode) !== 'StbSecFoundation_RC') {
    return { kind: 'MISSING' };
  }

  const rect = firstDescendant(sectionNode, 'StbSecFoundation_RC_Rect');
  if (rect) {
    return {
      kind: 'RECT',
      widthXmm: numberAttr(rect, 'width_X'),
      widthYmm: numberAttr(rect, 'width_Y'),
      depthMm: numberAttr(rect, 'depth'),
    };
  }

  const taperedRect = firstDescendant(sectionNode, 'StbSecFoundation_RC_TaperedRect');
  if (taperedRect) {
    return {
      kind: 'TAPERED_RECT',
      widthXmm: numberAttr(taperedRect, 'width_X'),
      widthYmm: numberAttr(taperedRect, 'width_Y'),
      depthBaseMm: numberAttr(taperedRect, 'depth_base'),
      depthTipMm: numberAttr(taperedRect, 'depth_tip'),
    };
  }

  const triangle = firstDescendant(sectionNode, 'StbSecFoundation_RC_Triangle');
  if (triangle) {
    return {
      kind: 'TRIANGLE',
      widthXmm: numberAttr(triangle, 'width_X'),
      widthYmm: numberAttr(triangle, 'width_Y'),
      chamferXmm: numberAttr(triangle, 'width_chamfer_X', 0),
      chamferYmm: numberAttr(triangle, 'width_chamfer_Y', 0),
      depthMm: numberAttr(triangle, 'depth'),
    };
  }

  const equiTriangle = firstDescendant(sectionNode, 'StbSecFoundation_RC_EquiTriangle');
  if (equiTriangle) {
    return {
      kind: 'EQUI_TRIANGLE',
      widthBaseMm: numberAttr(equiTriangle, 'width_base'),
      widthChamferMm: numberAttr(equiTriangle, 'width_chamfer'),
      depthMm: numberAttr(equiTriangle, 'depth'),
    };
  }

  const octagon = firstDescendant(sectionNode, 'StbSecFoundation_RC_Octagon');
  if (octagon) {
    return {
      kind: 'OCTAGON',
      widthXmm: numberAttr(octagon, 'width_X'),
      widthYmm: numberAttr(octagon, 'width_Y'),
      depthMm: numberAttr(octagon, 'depth'),
      chamfers: [1, 2, 3, 4].map((index) => ({
        x: numberAttr(octagon, `width_chamfer${index}_X`),
        y: numberAttr(octagon, `width_chamfer${index}_Y`),
      })),
    };
  }

  const continuous = firstDescendant(sectionNode, 'StbSecFoundation_RC_Continuous');
  if (continuous) {
    return {
      kind: 'CONTINUOUS',
      widthMm: numberAttr(continuous, 'width'),
      depthBaseMm: numberAttr(continuous, 'depth_base'),
      depthTipMm: numberAttr(continuous, 'depth_tip'),
      type: continuous.getAttribute?.('type') || null,
    };
  }

  return { kind: 'UNKNOWN' };
}

export function buildFootingQuantityContexts(
  parsedData,
  elementType,
  { modelSide = null, revision = null, document = null } = {},
) {
  const shortType = String(elementType || '').replace(/^Stb/, '');
  const config = FOOTING_QUANTITY_CONFIG[shortType];
  if (!config || !parsedData) return [];

  const elements = parsedData[config.elementsKey];
  if (!Array.isArray(elements)) return [];
  const sections = parsedData[config.sectionsKey];
  const nodes = parsedData.nodes || parsedData.nodeMapRaw || new Map();

  return elements.map((element) => {
    const section = getSectionFromMap(sections, element.id_section);
    const sectionNode = findSectionNode(document, section);
    const memberNode = findMemberNode(document, config.stbElementType, element);
    return {
      modelSide,
      revision,
      elementType: config.stbElementType,
      element,
      section,
      sectionNode,
      shape: resolveShape(sectionNode),
      points:
        config.nodeMode === 'line'
          ? [resolvePoint(nodes, element.id_node_start), resolvePoint(nodes, element.id_node_end)]
          : [],
      lengthExStartMm:
        config.nodeMode === 'line'
          ? numberValueOrAttr(element, 'length_ex_start', memberNode, 'length_ex_start', 0)
          : 0,
      lengthExEndMm:
        config.nodeMode === 'line'
          ? numberValueOrAttr(element, 'length_ex_end', memberNode, 'length_ex_end', 0)
          : 0,
    };
  });
}
