/** @fileoverview ST-Bridge StbStripFooting の構造平面図外形を原本DOMから解決する。 */

const EPSILON = 1e-9;

function localName(element) {
  const name = element?.localName || element?.nodeName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function descendants(root, tagName) {
  const all = root?.getElementsByTagName?.('*');
  if (!all) return [];
  return Array.from(all).filter((element) => localName(element) === tagName);
}

function textAttr(element, name) {
  const raw = element?.getAttribute?.(name);
  return raw == null || raw === '' ? null : String(raw);
}

function numberAttr(element, name, fallback = null) {
  const raw = element?.getAttribute?.(name);
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function nodePoint(nodes, id) {
  if (!(nodes instanceof Map) || id == null) return null;
  const node = nodes.get(String(id)) || nodes.get(id) || nodes.get(Number(id));
  if (!node) return null;
  const point = [Number(node.x), Number(node.y), Number(node.z)];
  return point.every(Number.isFinite) ? point : null;
}

function offsetEndpoint(node, element, prefix) {
  if (!node) return null;
  const dx = numberAttr(element, `offset_${prefix}_X`, 0);
  const dy = numberAttr(element, `offset_${prefix}_Y`, 0);
  const dz = numberAttr(element, `offset_${prefix}_Z`, 0);
  if (![dx, dy, dz].every(Number.isFinite)) return null;
  return [node[0] + dx, node[1] + dy, node[2] + dz];
}

function hasViaNode(element, tagName) {
  return descendants(element, tagName).length > 0;
}

function candidateFoundationBeamReferences(document, member, nodes) {
  const startNodeId = textAttr(member, 'id_node_start');
  const endNodeId = textAttr(member, 'id_node_end');
  if (!startNodeId || !endNodeId) return [];

  const candidates = [];
  for (const [tagName, viaTagName] of [
    ['StbGirder', 'StbGirderViaNode'],
    ['StbBeam', 'StbBeamViaNode'],
  ]) {
    for (const beam of descendants(document, tagName)) {
      const foundation = String(beam.getAttribute?.('isFoundation') || '')
        .trim()
        .toLowerCase();
      if (foundation !== 'true' && foundation !== '1') continue;
      const beamStartId = textAttr(beam, 'id_node_start');
      const beamEndId = textAttr(beam, 'id_node_end');
      const direct = beamStartId === startNodeId && beamEndId === endNodeId;
      const reverse = beamStartId === endNodeId && beamEndId === startNodeId;
      if (!direct && !reverse) continue;

      const beamStart = offsetEndpoint(nodePoint(nodes, beamStartId), beam, 'start');
      const beamEnd = offsetEndpoint(nodePoint(nodes, beamEndId), beam, 'end');
      candidates.push({
        tagName,
        id: textAttr(beam, 'id'),
        valid: !hasViaNode(beam, viaTagName) && beamStart != null && beamEnd != null,
        reason: hasViaNode(beam, viaTagName) ? 'VIA_NODE_UNSUPPORTED' : null,
        start: direct ? beamStart : beamEnd,
        end: direct ? beamEnd : beamStart,
      });
    }
  }
  return candidates;
}

function resolveFoundationBeamReference(document, member, nodes) {
  const candidates = candidateFoundationBeamReferences(document, member, nodes);
  if (candidates.length === 0) {
    throw new Error('STRIP_FOOTING_REFERENCE_NOT_FOUND');
  }
  if (candidates.length !== 1) {
    throw new Error(`STRIP_FOOTING_REFERENCE_AMBIGUOUS:${candidates.length}`);
  }
  const [candidate] = candidates;
  if (!candidate.valid || !candidate.start || !candidate.end) {
    throw new Error(`STRIP_FOOTING_REFERENCE_UNRESOLVED:${candidate.reason || 'INVALID'}`);
  }
  return candidate;
}

function resolveContinuousSection(document, sectionId) {
  const matches = descendants(document, 'StbSecFoundation_RC').filter(
    (section) => textAttr(section, 'id') === String(sectionId),
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'STRIP_FOOTING_SECTION_NOT_FOUND'
        : `STRIP_FOOTING_SECTION_AMBIGUOUS:${matches.length}`,
    );
  }

  const shapes = descendants(matches[0], 'StbSecFoundation_RC_Continuous');
  if (shapes.length !== 1) {
    throw new Error('STRIP_FOOTING_CONTINUOUS_SECTION_REQUIRED');
  }
  const width = numberAttr(shapes[0], 'width');
  if (!(width > 0)) throw new Error('STRIP_FOOTING_WIDTH_INVALID');
  return { width, section: matches[0], shape: shapes[0] };
}

function freezePoint(point) {
  return Object.freeze([point[0], point[1]]);
}

/**
 * ST-Bridge仕様の布基礎平面外形を返す。
 *
 * - 対応する基礎梁の始終端基準点を正本とする。
 * - offsetは始端→終端の左側を正とする。
 * - length_ex_start/endは梁基準点から外側を正とする。
 * - level/depthは平面外形には影響させない。
 */
export function resolveStripFootingPlanGeometry({ document, member, nodes } = {}) {
  if (!document || !member || !(nodes instanceof Map)) {
    throw new TypeError('StripFooting plan geometryにはdocument/member/nodesが必要です。');
  }

  const kindStructure = textAttr(member, 'kind_structure');
  if (kindStructure && kindStructure.toUpperCase() !== 'RC') {
    throw new Error(`STRIP_FOOTING_STRUCTURE_UNSUPPORTED:${kindStructure}`);
  }

  const sectionId = textAttr(member, 'id_section');
  if (!sectionId) throw new Error('STRIP_FOOTING_SECTION_ID_MISSING');
  const { width } = resolveContinuousSection(document, sectionId);
  const reference = resolveFoundationBeamReference(document, member, nodes);

  const offset = numberAttr(member, 'offset', 0);
  const level = numberAttr(member, 'level', 0);
  const lengthExStart = numberAttr(member, 'length_ex_start', 0);
  const lengthExEnd = numberAttr(member, 'length_ex_end', 0);
  if (![offset, level, lengthExStart, lengthExEnd].every(Number.isFinite)) {
    throw new Error('STRIP_FOOTING_PLACEMENT_INVALID');
  }

  const dx = reference.end[0] - reference.start[0];
  const dy = reference.end[1] - reference.start[1];
  const length = Math.hypot(dx, dy);
  if (!(length > EPSILON)) throw new Error('STRIP_FOOTING_PLAN_AXIS_ZERO_LENGTH');
  if (!(length + lengthExStart + lengthExEnd > EPSILON))
    throw new Error('STRIP_FOOTING_PLAN_AXIS_REVERSED_OR_ZERO_LENGTH');
  const ux = dx / length;
  const uy = dy / length;
  const leftX = -uy;
  const leftY = ux;

  const centerStart = [
    reference.start[0] + leftX * offset - ux * lengthExStart,
    reference.start[1] + leftY * offset - uy * lengthExStart,
  ];
  const centerEnd = [
    reference.end[0] + leftX * offset + ux * lengthExEnd,
    reference.end[1] + leftY * offset + uy * lengthExEnd,
  ];
  const halfWidth = width / 2;
  const points = [
    [centerStart[0] + leftX * halfWidth, centerStart[1] + leftY * halfWidth],
    [centerEnd[0] + leftX * halfWidth, centerEnd[1] + leftY * halfWidth],
    [centerEnd[0] - leftX * halfWidth, centerEnd[1] - leftY * halfWidth],
    [centerStart[0] - leftX * halfWidth, centerStart[1] - leftY * halfWidth],
  ];

  return Object.freeze({
    points: Object.freeze(points.map(freezePoint)),
    width,
    level,
    referenceBeam: Object.freeze({
      elementType: reference.tagName,
      elementId: reference.id,
    }),
    memberAxisModel: Object.freeze({
      kind: 'straight-member-axis',
      start: freezePoint(centerStart),
      end: freezePoint(centerEnd),
      units: 'mm',
    }),
  });
}
