/**
 * @fileoverview R7: 大梁§8-3の仕口端主筋を全体座標へ展開する純粋幾何。
 * 梁主筋の水平方向折曲げは自動生成せず、同一直線または鉛直位置差を判定する。
 */
import { calculateBeamBasis, normalizeVector } from '../../geometry/vectorMath.js';
import { getNodeCoord } from '../columnSupportUtils.js';

const EPS = 1e-6;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function attributeNumber(element, name, fallback = 0) {
  if (!element?.hasAttribute?.(name)) return fallback;
  return finiteNumber(element.getAttribute(name));
}

function adjustedNode(scanTag, element, nodeAttribute, prefix) {
  const node = getNodeCoord(scanTag, element.getAttribute(nodeAttribute));
  if (!node) return null;
  const offsets = ['X', 'Y', 'Z'].map((axis) => attributeNumber(element, `${prefix}_${axis}`));
  if (!offsets.every(Number.isFinite)) return null;
  return {
    x: node.x + offsets[0],
    y: node.y + offsets[1],
    z: node.z + offsets[2],
  };
}

function addScaled(point, vector, scale) {
  return {
    x: point.x + vector.x * scale,
    y: point.y + vector.y * scale,
    z: point.z + vector.z * scale,
  };
}

function worldSectionPoint(center, basis, u, v, rollRad) {
  const cos = Math.cos(rollRad);
  const sin = Math.sin(rollRad);
  const rotatedU = u * cos - v * sin;
  const rotatedV = u * sin + v * cos;
  return addScaled(addScaled(center, basis.xAxis, rotatedU), basis.yAxis, rotatedV);
}

export function resolveGirderEndpointGeometry(scanTag, element, layout, endpoint) {
  const start = adjustedNode(scanTag, element, 'id_node_start', 'offset_start');
  const end = adjustedNode(scanTag, element, 'id_node_end', 'offset_end');
  const depth = finiteNumber(layout?.depth);
  const rollDegrees = attributeNumber(element, 'rotate', 0);
  if (!start || !end || !(depth > 0) || !Number.isFinite(rollDegrees)) return null;

  const delta = {
    x: end.x - start.x,
    y: end.y - start.y,
    z: end.z - start.z,
  };
  const length = Math.hypot(delta.x, delta.y, delta.z);
  const planLength = Math.hypot(delta.x, delta.y);
  if (!(length > EPS) || !(planLength > EPS) || Math.abs(delta.z) > EPS) return null;

  const direction = normalizeVector(delta);
  const planDirection = { x: delta.x / planLength, y: delta.y / planLength };
  const basis = calculateBeamBasis(direction);
  const topReference = endpoint === 'start' ? start : end;
  const center = addScaled(topReference, basis.yAxis, -depth / 2);
  const outwardPlanDirection =
    endpoint === 'start' ? planDirection : { x: -planDirection.x, y: -planDirection.y };

  return {
    endpoint,
    start,
    end,
    center,
    direction,
    planDirection,
    outwardPlanDirection,
    basis,
    depth,
    rollRad: (rollDegrees * Math.PI) / 180,
  };
}

export function girderEndpointBarFacts(element, layout, geometry) {
  if (!element || !layout || !geometry) return [];
  const endpoint = geometry.endpoint;
  const segment = endpoint === 'start' ? layout.segments?.[0] : layout.segments?.at(-1);
  if (!segment) return [];
  const ratio = endpoint === 'start' ? segment.startRatio : segment.endRatio;
  if (Math.abs(Number(ratio) - (endpoint === 'start' ? 0 : 1)) > EPS) return [];

  return (segment.bars || [])
    .map((bar, barIndex) => ({ bar, barIndex }))
    .filter(({ bar }) => bar?.role === 'top' || bar?.role === 'bottom')
    .map(({ bar, barIndex }) => {
      const u = finiteNumber(bar.u);
      const v = finiteNumber(bar.v);
      const worldPosition =
        u === null || v === null
          ? { x: NaN, y: NaN, z: NaN }
          : worldSectionPoint(geometry.center, geometry.basis, u, v, geometry.rollRad);
      return {
        ...bar,
        localPosition: { u, v },
        worldPosition,
        memberId: element.getAttribute('id') || null,
        memberName: element.getAttribute('name') || null,
        sectionId: element.getAttribute('id_section') || null,
        endpoint,
        barIndex,
      };
    });
}

function canonicalAxis(direction) {
  const x = Math.abs(direction.x) <= EPS ? 0 : direction.x;
  const y = Math.abs(direction.y) <= EPS ? 0 : direction.y;
  if (Math.abs(x) >= Math.abs(y)) {
    return x >= 0 ? { x, y } : { x: -x, y: -y };
  }
  return y >= 0 ? { x, y } : { x: -x, y: -y };
}

export function resolveOpposedGirderFrame(first, second, tolerance = 1e-6) {
  const a = first?.outwardPlanDirection;
  const b = second?.outwardPlanDirection;
  if (!a || !b) return null;
  const dot = a.x * b.x + a.y * b.y;
  const cross = a.x * b.y - a.y * b.x;
  if (dot > -1 + tolerance || Math.abs(cross) > tolerance) return null;
  const axis = canonicalAxis(a);
  return { axis, transverse: { x: -axis.y, y: axis.x } };
}

export function projectGirderBarToJointFrame(bar, frame) {
  const point = bar?.worldPosition;
  if (!point || !Object.values(point).every(Number.isFinite) || !frame) return null;
  return {
    ...bar,
    jointTransverseMm: point.x * frame.transverse.x + point.y * frame.transverse.y,
    jointElevationMm: point.z,
  };
}
