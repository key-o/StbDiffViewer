/**
 * @fileoverview #510: deterministic STB linear-member centreline projections for axis elevations.
 * STB coordinates and member offsets are model mm. Not a section-outline producer.
 */
import { createElementRef, elementRefKey } from '../../data/drawing/drawingModel.js';
import { resolveAxisElevationMemberOutline } from './axisElevationMemberProfiles.js';

const MEMBER_KINDS = Object.freeze([
  { tag: 'StbColumn', type: 'Column', from: 'bottom', to: 'top' },
  { tag: 'StbPost', type: 'Post', from: 'bottom', to: 'top' },
  { tag: 'StbGirder', type: 'Girder', from: 'start', to: 'end' },
  { tag: 'StbBeam', type: 'Beam', from: 'start', to: 'end' },
  { tag: 'StbBrace', type: 'Brace', from: 'start', to: 'end' },
]);
const EPS = 1e-7;

function readOffset(element, end, axis) {
  const name = `offset_${end}_${axis}`;
  const raw = element.getAttribute(name);
  if (raw == null) return 0;
  if (!raw.trim() || !Number.isFinite(Number(raw)))
    throw new TypeError(`部材 ${element.getAttribute('id')} の ${name} が不正です。`);
  return Number(raw);
}

function nodeEnd(element, end, nodes) {
  const id = element.getAttribute(`id_node_${end}`);
  if (!id || !nodes.has(id))
    throw new Error(`部材 ${element.getAttribute('id')} の ${end} 節点がありません。`);
  const node = nodes.get(id);
  return {
    x: node.x + readOffset(element, end, 'X'),
    y: node.y + readOffset(element, end, 'Y'),
    z: node.z + readOffset(element, end, 'Z'),
  };
}

function clipToDepth(start, end, axis, lower, upper) {
  const a = start[axis];
  const delta = end[axis] - a;
  if (Math.abs(delta) < EPS) {
    return a >= lower - EPS && a <= upper + EPS ? [start, end] : null;
  }
  const tA = (lower - a) / delta;
  const tB = (upper - a) / delta;
  const startT = Math.max(0, Math.min(tA, tB));
  const endT = Math.min(1, Math.max(tA, tB));
  if (startT > endT - EPS) return null;
  const pointAt = (t) => ({
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t,
  });
  return [pointAt(startT), pointAt(endT)];
}

function project(point, horizontalAxis) {
  return [point[horizontalAxis], point.z];
}

function same2D(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS;
}

function same3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= EPS;
}

/** Follow STB ordered intermediate node references and their member offsets. */
function memberPath(element, tag, from, to, nodes) {
  const first = nodeEnd(element, from, nodes);
  const last = nodeEnd(element, to, nodes);
  const viaContainers = Array.from(element.getElementsByTagNameNS('*', `${tag}ViaNode`));
  if (!viaContainers.length) {
    if (element.getElementsByTagNameNS('*', 'StbNodeIdOrder').length)
      throw new Error('中間節点の親要素が不正です。');
    return [first, last];
  }
  if (viaContainers.length !== 1) throw new Error('中間節点の経路が重複しています。');
  const via = viaContainers[0];
  const orders = Array.from(via.getElementsByTagNameNS('*', 'StbNodeIdOrder'));
  if (orders.length !== 1) throw new Error('中間節点の順序がありません。');
  const ids = String(orders[0].textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const startId = element.getAttribute(`id_node_${from}`);
  const endId = element.getAttribute(`id_node_${to}`);
  if (!ids.length || new Set([startId, ...ids, endId]).size !== ids.length + 2)
    throw new Error('中間節点の順序に重複または欠落があります。');

  const offsets = new Map();
  for (const offset of Array.from(via.getElementsByTagNameNS('*', 'StbMemberOffsetList'))) {
    const id = offset.getAttribute('id_node');
    if (!id || !ids.includes(id) || offsets.has(id))
      throw new Error('中間節点のオフセット参照が不正です。');
    const xyz = {};
    for (const [axis, key] of [
      ['X', 'x'],
      ['Y', 'y'],
      ['Z', 'z'],
    ]) {
      const value = offset.getAttribute(`offset_${axis}`);
      if (value == null || !value.trim() || !Number.isFinite(Number(value)))
        throw new Error(`中間節点 ${id} の offset_${axis} が不正です。`);
      xyz[key] = Number(value);
    }
    offsets.set(id, xyz);
  }
  const path = [first];
  for (const id of ids) {
    const node = nodes.get(id);
    if (!node) throw new Error(`中間節点 ${id} がありません。`);
    const offset = offsets.get(id) || { x: 0, y: 0, z: 0 };
    path.push({ x: node.x + offset.x, y: node.y + offset.y, z: node.z + offset.z });
  }
  path.push(last);
  if (path.some((point, i) => i > 0 && same3D(point, path[i - 1])))
    throw new Error('中間節点を含む経路に長さ0の区間があります。');
  return path;
}

/** Clip each 3D segment and join only actually contiguous segments in the band. */
function projectedRuns(path, depthAxis, horizontalAxis, lower, upper) {
  const runs = [];
  let current = [];
  let previousEnd = null;
  const flush = () => {
    if (current.length > 1) runs.push(current);
    current = [];
  };
  for (let i = 1; i < path.length; i++) {
    const clipped = clipToDepth(path[i - 1], path[i], depthAxis, lower, upper);
    if (!clipped) {
      flush();
      previousEnd = null;
      continue;
    }
    if (previousEnd && !same3D(previousEnd, clipped[0])) flush();
    const start = project(clipped[0], horizontalAxis);
    const end = project(clipped[1], horizontalAxis);
    if (!current.length) current.push(start);
    else if (!same2D(current.at(-1), start)) current.push(start);
    if (!same2D(current.at(-1), end)) current.push(end);
    previousEnd = clipped[1];
  }
  flush();
  return runs;
}

/**
 * Append identifiable projected member centrelines to a level/grid elevation DrawingModel.
 * Unknown members are not treated as section outlines. Unsupported via-node geometry
 * fails closed rather than drawing an incorrect straight member.
 */
export function addAxisElevationMemberCenterlines({ drawing, document, nodes } = {}) {
  if (drawing?.view?.type !== 'elevation' || drawing?.source?.modelKey !== 'A')
    throw new TypeError('STB-Aの軸組図DrawingModelが必要です。');
  if (document?.nodeType !== 9) throw new TypeError('STB XML Documentが必要です。');
  const { view } = drawing;
  const depthAxis = view.axisDirection === 'X' ? 'x' : view.axisDirection === 'Y' ? 'y' : null;
  if (!depthAxis || ![view.lowerBound, view.upperBound].every(Number.isFinite))
    throw new TypeError('軸組図の奥行指定が不正です。');
  const horizontalAxis = depthAxis === 'x' ? 'y' : 'x';
  const nodeIndex = new Map();
  for (const node of nodes || []) {
    if (!node?.id || nodeIndex.has(node.id)) throw new Error('STB節点のIDが不正です。');
    if (![node.x, node.y, node.z].every(Number.isFinite))
      throw new TypeError(`STB節点 ${node.id} の座標が不正です。`);
    nodeIndex.set(node.id, node);
  }
  let count = 0;
  let outlinedCount = 0;
  for (const { tag, type, from, to } of MEMBER_KINDS) {
    const seen = new Set();
    for (const element of Array.from(document.getElementsByTagNameNS('*', tag))) {
      const id = element.getAttribute('id');
      if (!id || seen.has(id)) throw new Error(`${tag} IDの欠落または重複があります。`);
      seen.add(id);
      const ref = createElementRef(drawing.source, type, id, element.getAttribute('guid'));
      const key = elementRefKey(ref);
      const hasVia = element.getElementsByTagNameNS('*', tag + 'ViaNode').length > 0;
      let path;
      try {
        path = memberPath(element, tag, from, to, nodeIndex);
      } catch (error) {
        // Preserve strict validation for conventional members. Malformed ViaNodes
        // are isolated so all other members remain visible.
        if (!hasVia) throw error;
        drawing.diagnostics.push({
          code: 'ELEVATION_MEMBER_PATH_INVALID',
          elementKey: key,
          detail: `${tag} ${id}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const runs = projectedRuns(path, depthAxis, horizontalAxis, view.lowerBound, view.upperBound);
      if (!runs.length) {
        if (
          path.some(
            (p) => p[depthAxis] >= view.lowerBound - EPS && p[depthAxis] <= view.upperBound + EPS,
          )
        ) {
          drawing.diagnostics.push({
            code: 'ELEVATION_MEMBER_EDGE_ON',
            elementKey: key,
            detail: '投影芯線は長さ0、または通り芯面と直交するため未描画です。',
          });
        }
        continue;
      }
      const sectionId = element.getAttribute('id_section');
      const primitiveIds = [];
      for (const [index, points] of runs.entries()) {
        const primitiveId = JSON.stringify([
          key,
          'elevation-centreline',
          ...(runs.length > 1 ? [index] : []),
        ]);
        drawing.primitives.push({
          id: primitiveId,
          kind: 'polyline',
          role: 'member-axis',
          closed: false,
          ref,
          elementKey: key,
          points,
        });
        primitiveIds.push(primitiveId);
      }
      const mark = String(element.getAttribute('name') || '').trim();
      drawing.elements.push({
        key,
        ref,
        renderType: type,
        state: 'drawn',
        mark,
        sectionId,
        // Only an explicit saved tag may label this STB projected centreline.
        // Empty STB names stay untaggable.
        taggable: mark.length > 0,
        // A straight two-node member projects to one run; via-node polylines
        // have no single axis segment to expose.
        ...(path.length === 2 && runs.length === 1 && runs[0].length === 2
          ? {
              memberAxisModel: {
                kind: 'straight-member-axis',
                start: [...runs[0][0]],
                end: [...runs[0][1]],
                units: 'mm',
              },
            }
          : {}),
        primitiveIds,
      });
      // Bent or intermediate-node sections cannot be inferred from the end chord.
      let outline;
      if (path.length > 2) {
        outline = {
          status: 'unsupported',
          reason: '中間節点を含む部材の断面外形は未対応です（芯線のみ描画）。',
        };
      } else {
        try {
          outline = resolveAxisElevationMemberOutline({
            document,
            member: element,
            type,
            sectionId,
            axisDirection: view.axisDirection,
            projectedPoints: runs[0],
          });
        } catch (error) {
          outline = {
            status: 'unsupported',
            reason: `断面 ${sectionId || '未指定'}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      if (outline.status === 'outline') {
        const outlineId = JSON.stringify([key, 'elevation-section-outline']);
        drawing.primitives.push({
          id: outlineId,
          kind: 'polyline',
          role: 'member-outline',
          closed: true,
          ref,
          elementKey: key,
          points: outline.points,
        });
        drawing.elements.at(-1).primitiveIds.push(outlineId);
        outlinedCount++;
      } else {
        drawing.diagnostics.push({
          code: 'ELEVATION_SECTION_OUTLINE_UNSUPPORTED',
          elementKey: key,
          detail: outline.reason,
        });
      }
      for (const [x, y] of [
        ...runs.flat(),
        ...(outline.status === 'outline' ? outline.points : []),
      ]) {
        drawing.bounds.minX = Math.min(drawing.bounds.minX, x);
        drawing.bounds.maxX = Math.max(drawing.bounds.maxX, x);
        drawing.bounds.minY = Math.min(drawing.bounds.minY, y);
        drawing.bounds.maxY = Math.max(drawing.bounds.maxY, y);
      }
      count++;
    }
  }
  if (count > outlinedCount) {
    drawing.diagnostics.push({
      code: 'ELEVATION_MEMBERS_PARTIAL_OUTLINE',
      detail: `${outlinedCount}/${count}部材にSTB断面外形を描画。残りは芯線のみで、断面未対応の診断があります。`,
    });
  }
  const unsupported = ['StbSlab', 'StbFooting', 'StbFoundationColumn'].filter(
    (tag) => document.getElementsByTagNameNS('*', tag).length > 0,
  );
  if (unsupported.length) {
    drawing.diagnostics.push({
      code: 'ELEVATION_SECTION_OUTLINES_PENDING',
      detail: `${unsupported.join(', ')} の断面外形はこの芯線段階では投影しません。`,
    });
  }
  return count;
}
