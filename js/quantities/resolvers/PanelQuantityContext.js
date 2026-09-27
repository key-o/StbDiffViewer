/**
 * @fileoverview 壁・スラブ・パラペット数量計算用context resolver。
 */

import { getSectionFromMap } from './LinearMemberQuantityContext.js';

const PANEL_QUANTITY_CONFIG = Object.freeze({
  Wall: {
    stbElementType: 'StbWall',
    elementsKey: 'wallElements',
    sectionsKey: 'wallSections',
    nodeMode: 'polygon',
  },
  Slab: {
    stbElementType: 'StbSlab',
    elementsKey: 'slabElements',
    sectionsKey: 'slabSections',
    nodeMode: 'polygon',
  },
  Parapet: {
    stbElementType: 'StbParapet',
    elementsKey: 'parapetElements',
    sectionsKey: 'parapetSections',
    nodeMode: 'line',
  },
});

function elementTagName(element) {
  const name = element?.localName || element?.nodeName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function findElementsByTagName(root, tagName) {
  if (!root || !tagName) return [];
  if (typeof root.getElementsByTagName === 'function') {
    const direct = Array.from(root.getElementsByTagName(tagName) || []);
    if (direct.length > 0) return direct;
  }
  if (typeof root.getElementsByTagNameNS === 'function') {
    const namespaced = Array.from(root.getElementsByTagNameNS('*', tagName) || []);
    if (namespaced.length > 0) return namespaced;
  }
  return [];
}

function findSectionNode(document, section) {
  const tagName = section?.sectionType;
  const sectionId = section?.id;
  if (!document || !tagName || sectionId === null || sectionId === undefined) return null;
  return (
    findElementsByTagName(document, tagName).find(
      (node) => String(node.getAttribute?.('id')) === String(sectionId),
    ) || null
  );
}

function firstDescendant(parent, tagNames) {
  for (const tagName of tagNames) {
    const found = findElementsByTagName(parent, tagName)[0];
    if (found) return found;
  }
  return null;
}

function numericAttributes(node, names) {
  const result = {};
  for (const name of names) {
    const raw = node?.getAttribute?.(name);
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    result[name] = Number.isFinite(value) ? value : raw;
  }
  return result;
}

function classifySectionShape(stbElementType, sectionNode, section) {
  const sectionTag = elementTagName(sectionNode) || section?.sectionType || '';

  if (stbElementType === 'StbWall') {
    if (sectionTag !== 'StbSecWall_RC') return { kind: 'UNSUPPORTED_SECTION', params: {} };
    const straight = firstDescendant(sectionNode, ['StbSecWall_RC_Straight']);
    if (straight) return { kind: 'WALL_STRAIGHT', params: numericAttributes(straight, ['t']) };
    const taper = firstDescendant(sectionNode, ['StbSecWall_RC_Taper']);
    if (taper) {
      return {
        kind: 'WALL_TAPER',
        params: numericAttributes(taper, ['t_bottom', 't_top', 'depth_Hb', 'depth_Ht']),
      };
    }
    return { kind: 'UNKNOWN', params: {} };
  }

  if (stbElementType === 'StbSlab') {
    if (sectionTag !== 'StbSecSlab_RC') return { kind: 'UNSUPPORTED_SECTION', params: {} };
    const straight = firstDescendant(sectionNode, [
      'StbSecSlab_RC_ConventionalStraight',
      'StbSecSlab_RC_Straight',
    ]);
    if (straight) return { kind: 'SLAB_STRAIGHT', params: numericAttributes(straight, ['depth']) };
    const nonuniform = firstDescendant(sectionNode, [
      'StbSecSlab_RC_ConventionalTaper',
      'StbSecSlab_RC_Taper',
      'StbSecSlab_RC_ConventionalHaunch',
      'StbSecSlab_RC_Haunch',
    ]);
    if (nonuniform) return { kind: 'SLAB_NONUNIFORM', params: {} };
    return { kind: 'UNKNOWN', params: {} };
  }

  if (stbElementType === 'StbParapet') {
    if (sectionTag !== 'StbSecParapet_RC') return { kind: 'UNSUPPORTED_SECTION', params: {} };
    const typeI = firstDescendant(sectionNode, ['StbSecParapet_RC_TypeI']);
    if (typeI) {
      return {
        kind: 'PARAPET_TYPE_I',
        params: numericAttributes(typeI, ['t_T', 'depth_H']),
      };
    }
    const typeL = firstDescendant(sectionNode, ['StbSecParapet_RC_TypeL']);
    if (typeL) return { kind: 'PARAPET_TYPE_L', params: {} };
    return { kind: 'UNKNOWN', params: {} };
  }

  return { kind: 'UNKNOWN', params: {} };
}

function pointFromNode(node) {
  if (!node) return null;
  const x = Number(node.x ?? node.X);
  const y = Number(node.y ?? node.Y);
  const z = Number(node.z ?? node.Z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

function resolvePoint(nodes, nodeId, offset = null) {
  const raw = nodes?.get?.(String(nodeId)) ?? nodes?.get?.(Number.parseInt(nodeId, 10));
  const point = pointFromNode(raw);
  if (!point) return null;
  return {
    x: point.x + Number(offset?.offset_X || 0),
    y: point.y + Number(offset?.offset_Y || 0),
    z: point.z + Number(offset?.offset_Z || 0),
  };
}

function resolveOpenings(parsedData, element, stbElementType) {
  const source = parsedData?.openingElements;
  if (!source || typeof source.values !== 'function') return [];
  const all = [...source.values()];
  const byId = new Map(all.map((opening) => [String(opening.id), opening]));
  const result = [];
  const seen = new Set();

  for (const id of element?.open_ids || []) {
    const opening = byId.get(String(id));
    if (opening && !seen.has(String(opening.id))) {
      result.push(opening);
      seen.add(String(opening.id));
    }
  }

  const kindMember =
    stbElementType === 'StbWall' ? 'WALL' : stbElementType === 'StbSlab' ? 'SLAB' : null;
  if (kindMember) {
    for (const opening of all) {
      if (
        String(opening?.id_member || '') === String(element?.id) &&
        String(opening?.kind_member || '').toUpperCase() === kindMember &&
        !seen.has(String(opening.id))
      ) {
        result.push(opening);
        seen.add(String(opening.id));
      }
    }
  }
  return result;
}

export function getPanelQuantityConfig(elementType) {
  if (!elementType) return null;
  return PANEL_QUANTITY_CONFIG[String(elementType).replace(/^Stb/, '')] || null;
}

export function buildPanelQuantityContexts(
  parsedData,
  elementType,
  { modelSide = null, revision = null, document = null } = {},
) {
  const config = getPanelQuantityConfig(elementType);
  if (!config || !parsedData) return [];
  const elements = parsedData[config.elementsKey];
  if (!Array.isArray(elements)) return [];
  const sections = parsedData[config.sectionsKey];
  const nodes = parsedData.nodes || parsedData.nodeMapRaw || new Map();

  return elements.map((element) => {
    const section = getSectionFromMap(sections, element.id_section);
    const sectionNode = findSectionNode(document, section);
    const shape = classifySectionShape(config.stbElementType, sectionNode, section);
    let points = [];
    if (config.nodeMode === 'polygon') {
      points = (element.node_ids || []).map((nodeId) =>
        resolvePoint(nodes, nodeId, element.offsets?.get?.(String(nodeId))),
      );
    } else {
      points = [
        resolvePoint(nodes, element.id_node_start),
        resolvePoint(nodes, element.id_node_end),
      ];
    }

    const openings = resolveOpenings(parsedData, element, config.stbElementType);
    return {
      modelSide,
      revision,
      elementType: config.stbElementType,
      element,
      section,
      sectionNode,
      shapeKind: shape.kind,
      shapeParameters: shape.params,
      points,
      openings,
    };
  });
}

export { PANEL_QUANTITY_CONFIG };
