/**
 * @fileoverview RC配筋の実柱面・内法スパン Lo・柱内法高さ Ho を解決する幾何ヘルパー。
 *
 * 柱断面は回転・端部オフセット・ふかしを反映し、梁軸と断面外周の実交点から柱面を求める。
 */

import {
  createTagScanner,
  extractColumnPlanDimensions,
  findColumnAtNode,
  findElementById,
  getNodeCoord,
} from '../columnSupportUtils.js';

const EPS = 1e-9;
const BEAM_MEMBER_TAGS = [
  { member: 'StbGirder', sections: ['StbSecGirder_RC', 'StbSecBeam_RC'] },
  { member: 'StbBeam', sections: ['StbSecBeam_RC', 'StbSecGirder_RC'] },
];

function readNumberAttribute(element, name) {
  const value = parseFloat(element?.getAttribute(name));
  return Number.isFinite(value) ? value : 0;
}

function readNonNegativeAttribute(element, name) {
  return Math.max(0, readNumberAttribute(element, name));
}

function readOffset(element, prefix) {
  return {
    x: readNumberAttribute(element, `${prefix}_X`),
    y: readNumberAttribute(element, `${prefix}_Y`),
    z: readNumberAttribute(element, `${prefix}_Z`),
  };
}

function resolveColumnCenterAtNode(columnEl, nodeId, node) {
  let prefix = null;
  if (columnEl?.getAttribute('id_node_top') === nodeId) prefix = 'offset_top';
  else if (columnEl?.getAttribute('id_node_bottom') === nodeId) prefix = 'offset_bottom';
  const offset = prefix ? readOffset(columnEl, prefix) : { x: 0, y: 0, z: 0 };
  return { x: node.x + offset.x, y: node.y + offset.y, z: node.z + offset.z };
}

function rotateIntoLocal(vector, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: cos * vector.x + sin * vector.y,
    y: -sin * vector.x + cos * vector.y,
  };
}

function resolveRectangleBounds(columnEl, dims) {
  return {
    minX: -dims.widthX / 2 - readNonNegativeAttribute(columnEl, 'thickness_add_start_X'),
    maxX: dims.widthX / 2 + readNonNegativeAttribute(columnEl, 'thickness_add_end_X'),
    minY: -dims.widthY / 2 - readNonNegativeAttribute(columnEl, 'thickness_add_start_Y'),
    maxY: dims.widthY / 2 + readNonNegativeAttribute(columnEl, 'thickness_add_end_Y'),
  };
}

function intersectLineWithRectangle(origin, direction, center, bounds, rotateDeg) {
  const angleRad = (rotateDeg * Math.PI) / 180;
  const localOrigin = rotateIntoLocal({ x: origin.x - center.x, y: origin.y - center.y }, angleRad);
  const localDirection = rotateIntoLocal(direction, angleRad);
  let tMin = -Infinity;
  let tMax = Infinity;

  for (const axis of ['x', 'y']) {
    const value = localOrigin[axis];
    const delta = localDirection[axis];
    const min = axis === 'x' ? bounds.minX : bounds.minY;
    const max = axis === 'x' ? bounds.maxX : bounds.maxY;
    if (Math.abs(delta) <= EPS) {
      if (value < min - EPS || value > max + EPS) return null;
      continue;
    }
    const first = (min - value) / delta;
    const second = (max - value) / delta;
    const near = Math.min(first, second);
    const far = Math.max(first, second);
    tMin = Math.max(tMin, near);
    tMax = Math.min(tMax, far);
    if (tMin > tMax + EPS) return null;
  }

  return Number.isFinite(tMin) && Number.isFinite(tMax) ? { entryT: tMin, exitT: tMax } : null;
}

function intersectLineWithCircle(origin, direction, center, diameterMm) {
  const radius = diameterMm / 2;
  const dx = origin.x - center.x;
  const dy = origin.y - center.y;
  const b = 2 * (dx * direction.x + dy * direction.y);
  const c = dx * dx + dy * dy - radius * radius;
  const discriminant = b * b - 4 * c;
  if (discriminant < -EPS) return null;
  const root = Math.sqrt(Math.max(0, discriminant));
  return { entryT: (-b - root) / 2, exitT: (-b + root) / 2 };
}

function resolveColumnLineInterval({ origin, direction, columnEl, nodeId, node, dims }) {
  const center = resolveColumnCenterAtNode(columnEl, nodeId, node);
  if (dims.shape === 'CIRCLE') {
    const fukashi = readNonNegativeAttribute(columnEl, 'thickness_add_start_X');
    return {
      center,
      interval: intersectLineWithCircle(origin, direction, center, dims.widthX + 2 * fukashi),
    };
  }
  const rotateDeg = readNumberAttribute(columnEl, 'rotate');
  return {
    center,
    interval: intersectLineWithRectangle(
      origin,
      direction,
      center,
      resolveRectangleBounds(columnEl, dims),
      rotateDeg,
    ),
  };
}

function readBeamDepthAtEnd(sectionEl, side) {
  const wantedPos = side === 'start' ? 'START' : 'END';
  const wantedAttr = side === 'start' ? 'depth_start' : 'depth_end';
  let exact = 0;
  let straight = 0;
  let center = 0;
  let fallback = 0;

  const walk = (el) => {
    const positionalDepth = parseFloat(el.getAttribute?.(wantedAttr));
    if (Number.isFinite(positionalDepth) && positionalDepth > exact) exact = positionalDepth;

    const depth = parseFloat(el.getAttribute?.('depth'));
    if (Number.isFinite(depth) && depth > 0) {
      fallback = Math.max(fallback, depth);
      const pos = (el.getAttribute?.('pos') || '').toUpperCase();
      if (pos === wantedPos) exact = Math.max(exact, depth);
      else if (pos === 'CENTER') center = Math.max(center, depth);
      else if (!pos) straight = Math.max(straight, depth);
    }

    const centerDepth = parseFloat(el.getAttribute?.('depth_center'));
    if (Number.isFinite(centerDepth) && centerDepth > center) center = centerDepth;

    const children = el.childNodes || [];
    for (let i = 0; i < children.length; i += 1) {
      if (children[i].nodeType === 1) walk(children[i]);
    }
  };
  walk(sectionEl);
  return exact || straight || center || fallback;
}

function beamSectionsForTag(tagName) {
  return BEAM_MEMBER_TAGS.find((entry) => entry.member === tagName)?.sections || [];
}

function collectBeamFaceLevelsAtNode(scanTag, nodeId, index = null) {
  const node = getNodeCoord(scanTag, nodeId, index);
  if (!node) return null;

  const topZs = [];
  const bottomZs = [];

  const processBeam = (beamEl, memberTag, endpoint = null) => {
    const isStart = endpoint
      ? endpoint === 'start'
      : beamEl.getAttribute('id_node_start') === nodeId;
    const isEnd = endpoint ? endpoint === 'end' : beamEl.getAttribute('id_node_end') === nodeId;
    if (!isStart && !isEnd) return;

    const sectionId = beamEl.getAttribute('id_section');
    let sectionEl = null;
    for (const tag of beamSectionsForTag(memberTag)) {
      sectionEl = findElementById(scanTag, tag, sectionId, index);
      if (sectionEl) break;
    }
    if (!sectionEl) return;

    const depth = readBeamDepthAtEnd(sectionEl, isStart ? 'start' : 'end');
    if (!(depth > 0)) return;

    const offsetZ = readNumberAttribute(beamEl, isStart ? 'offset_start_Z' : 'offset_end_Z');
    const baseTopZ = node.z + offsetZ;
    const topZ = baseTopZ + readNonNegativeAttribute(beamEl, 'thickness_add_top');
    const bottomZ = baseTopZ - depth - readNonNegativeAttribute(beamEl, 'thickness_add_bottom');
    topZs.push(topZ);
    bottomZs.push(bottomZ);
  };

  if (index?.beamsByNodeId instanceof Map) {
    for (const connection of index.beamsByNodeId.get(String(nodeId)) || []) {
      processBeam(connection.element, connection.tagName, connection.endpoint);
    }
  } else {
    for (const { member } of BEAM_MEMBER_TAGS) {
      for (const beamEl of scanTag(member)) {
        processBeam(beamEl, member);
      }
    }
  }

  if (topZs.length === 0) return null;

  return {
    highestBottomZ: Math.max(...bottomZs),
    lowestTopZ: Math.min(...topZs),
  };
}

/**
 * 梁端オフセットを反映した平面材軸を解決する。
 * @param {function(string): Element[]} scanTag タグ走査関数
 * @param {Element} beamEl 梁要素
 * @param {Object|null} [index=null] RebarModelIndex
 * @returns {{start:Object,end:Object,direction:Object,lengthMm:number}|null}
 */
export function resolveBeamPlanAxis(scanTag, beamEl, index = null) {
  const startNode = getNodeCoord(scanTag, beamEl?.getAttribute('id_node_start'), index);
  const endNode = getNodeCoord(scanTag, beamEl?.getAttribute('id_node_end'), index);
  if (!startNode || !endNode) return null;
  const startOffset = readOffset(beamEl, 'offset_start');
  const endOffset = readOffset(beamEl, 'offset_end');
  const start = { x: startNode.x + startOffset.x, y: startNode.y + startOffset.y };
  const end = { x: endNode.x + endOffset.x, y: endNode.y + endOffset.y };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthMm = Math.hypot(dx, dy);
  if (!(lengthMm > EPS)) return null;
  return { start, end, direction: { x: dx / lengthMm, y: dy / lengthMm }, lengthMm };
}

/**
 * 梁端の実柱面を梁始端からの距離 t で返す。
 * @param {Object} params 解決条件
 * @returns {Object|null} 柱面情報。梁軸が柱断面と交差しない場合 null
 */
export function resolveBeamEndColumnFace({ scanTag, beamEl, beamAxis, side, index = null }) {
  const nodeAttr = side === 'start' ? 'id_node_start' : 'id_node_end';
  const nodeId = beamEl?.getAttribute(nodeAttr);
  const node = getNodeCoord(scanTag, nodeId, index);
  const columnEl = findColumnAtNode(scanTag, nodeId, index);
  if (!node || !columnEl || !beamAxis) return null;
  const dims = extractColumnPlanDimensions(scanTag, columnEl.getAttribute('id_section'), index);
  if (!dims || !(dims.widthX > 0) || !(dims.widthY > 0)) return null;

  const resolved = resolveColumnLineInterval({
    origin: beamAxis.start,
    direction: beamAxis.direction,
    columnEl,
    nodeId,
    node,
    dims,
  });
  if (!resolved.interval) return null;

  const faceT = side === 'start' ? resolved.interval.exitT : resolved.interval.entryT;
  return {
    side,
    nodeId,
    columnId: columnEl.getAttribute('id') || null,
    columnName: columnEl.getAttribute('name') || dims.name || null,
    columnShape: dims.shape,
    columnCenter: resolved.center,
    columnRotateDeg: readNumberAttribute(columnEl, 'rotate'),
    entryT: resolved.interval.entryT,
    exitT: resolved.interval.exitT,
    faceT,
    face: {
      x: beamAxis.start.x + beamAxis.direction.x * faceT,
      y: beamAxis.start.y + beamAxis.direction.y * faceT,
    },
  };
}

/**
 * 共有scannerから梁の左右実柱面と内法スパン Lo を解決する。
 * @param {function(string): Element[]} scanTag タグ走査関数
 * @param {Element} beamEl 梁要素
 * @param {Object|null} [index=null] RebarModelIndex
 * @returns {{loMm:number,startFace:Object,endFace:Object,beamAxis:Object}|null}
 */
export function resolveBeamClearSpanFromScanner(scanTag, beamEl, index = null) {
  const beamAxis = resolveBeamPlanAxis(scanTag, beamEl, index);
  if (!beamAxis) return null;
  const startFace = resolveBeamEndColumnFace({
    scanTag,
    beamEl,
    beamAxis,
    side: 'start',
    index,
  });
  const endFace = resolveBeamEndColumnFace({ scanTag, beamEl, beamAxis, side: 'end', index });
  if (!startFace || !endFace) return null;
  const loMm = endFace.faceT - startFace.faceT;
  if (!(loMm > EPS)) return null;
  return { loMm, startFace, endFace, beamAxis };
}

/**
 * 梁の左右実柱面と内法スパン Lo を解決する。
 * @param {Document} xmlDoc STB XML
 * @param {Element} beamEl 梁要素
 * @param {Object|null} [index=null] RebarModelIndex
 * @returns {{loMm:number,startFace:Object,endFace:Object,beamAxis:Object}|null}
 */
export function resolveBeamClearSpan(xmlDoc, beamEl, index = null) {
  return resolveBeamClearSpanFromScanner(createTagScanner(xmlDoc), beamEl, index);
}

/**
 * 共有scannerから柱の最大内法高さ Ho を上下節点に取り付く梁の実面から解決する。
 * 最大内法なので、上端側は最も高い梁下端、下端側は最も低い梁天端を用いる。
 * @param {function(string): Element[]} scanTag タグ走査関数
 * @param {Element} columnEl 柱要素
 * @param {Object|null} [index=null] RebarModelIndex
 * @returns {{hoMm:number,upperFaceZ:number,lowerFaceZ:number}|null}
 */
export function resolveColumnClearHeightFromScanner(scanTag, columnEl, index = null) {
  const topNodeId = columnEl?.getAttribute('id_node_top');
  const bottomNodeId = columnEl?.getAttribute('id_node_bottom');
  const topLevels = collectBeamFaceLevelsAtNode(scanTag, topNodeId, index);
  const bottomLevels = collectBeamFaceLevelsAtNode(scanTag, bottomNodeId, index);
  if (!topLevels || !bottomLevels) return null;

  const upperFaceZ = topLevels.highestBottomZ;
  const lowerFaceZ = bottomLevels.lowestTopZ;
  const hoMm = upperFaceZ - lowerFaceZ;
  if (!(hoMm > EPS)) return null;
  return { hoMm, upperFaceZ, lowerFaceZ };
}

/**
 * 柱の最大内法高さ Ho を上下節点に取り付く梁の実面から解決する。
 * @param {Document} xmlDoc STB XML
 * @param {Element} columnEl 柱要素
 * @param {Object|null} [index=null] RebarModelIndex
 * @returns {{hoMm:number,upperFaceZ:number,lowerFaceZ:number}|null}
 */
export function resolveColumnClearHeight(xmlDoc, columnEl, index = null) {
  return resolveColumnClearHeightFromScanner(createTagScanner(xmlDoc), columnEl, index);
}
