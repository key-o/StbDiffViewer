/** @fileoverview R6の実主筋中心座標と梁主筋間の折曲げ区間。Three.js非依存。 */
import { calculateBeamBasis, normalizeVector } from '../../geometry/vectorMath.js';
import { getNodeCoord } from '../columnSupportUtils.js';
import { finiteTransitionNumber } from './columnRebarTransition.js';

const EPS = 1e-6;

function attributeNumber(element, name) {
  if (!element?.hasAttribute(name)) return 0;
  return finiteTransitionNumber(element.getAttribute(name)) ?? NaN;
}

function rotation(element) {
  const attribute = element.hasAttribute('rotate') ? 'rotate' : 'angle';
  return (attributeNumber(element, attribute) * Math.PI) / 180;
}

function adjustedNode(scanTag, element, nodeAttribute, prefix, index = null) {
  const node = getNodeCoord(scanTag, element.getAttribute(nodeAttribute), index);
  if (!node) return null;
  const point = {
    x: node.x + attributeNumber(element, `${prefix}_X`),
    y: node.y + attributeNumber(element, `${prefix}_Y`),
    z: node.z + attributeNumber(element, `${prefix}_Z`),
  };
  return Object.values(point).every(Number.isFinite) ? point : null;
}

export function columnTransitionGeometry(scanTag, element, index = null) {
  const bottom = adjustedNode(scanTag, element, 'id_node_bottom', 'offset_bottom', index);
  const top = adjustedNode(scanTag, element, 'id_node_top', 'offset_top', index);
  const angle = rotation(element);
  if (!bottom || !top || !Number.isFinite(angle)) return null;
  if (!(top.z > bottom.z + EPS) || Math.hypot(top.x - bottom.x, top.y - bottom.y) > EPS)
    return null;
  return { bottom, top, angle };
}

export function columnEndpointBarFacts(element, layout, geometry, endpoint) {
  // 明示endpointが空なら、通し筋segmentへ戻して筋を復活させない。
  const segment = endpoint === 'top' ? layout?.segments?.at(-1) : layout?.segments?.[0];
  const bars = layout?.endpointFacts
    ? layout.endpointFacts[endpoint]?.bars || []
    : segment?.bars || [];
  const center = geometry[endpoint];
  const cos = Math.cos(geometry.angle);
  const sin = Math.sin(geometry.angle);
  return bars.map((bar, barIndex) => {
    const u = finiteTransitionNumber(bar?.u);
    const v = finiteTransitionNumber(bar?.v);
    const x = u === null || v === null ? NaN : center.x + u * cos - v * sin;
    const y = u === null || v === null ? NaN : center.y + u * sin + v * cos;
    return {
      ...bar,
      u: x,
      v: y,
      grade: String(bar.grade || '').toUpperCase() || null,
      diaName: String(bar.diaName || `D${bar.dia}`).toUpperCase(),
      localPosition: { u, v },
      worldPosition: { x, y, z: center.z },
      columnId: element.getAttribute('id'),
      memberTag: element.localName || element.tagName,
      endpoint,
      barIndex,
    };
  });
}

function beamWindow(scanTag, element, layout, isStart, index = null) {
  const start = adjustedNode(scanTag, element, 'id_node_start', 'offset_start', index);
  const end = adjustedNode(scanTag, element, 'id_node_end', 'offset_end', index);
  const base = { beamId: element.getAttribute('id'), window: null, planDirection: null };
  if (!start || !end) return base;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const planLength = Math.hypot(dx, dy);
  if (!(planLength > EPS)) return base;
  base.planDirection = { x: dx / planLength, y: dy / planLength };
  // 傾斜梁は柱主筋との交点ごとにZが変わる。端部Zで近似しない。
  if (Math.abs(end.z - start.z) > EPS) return base;
  const depth = finiteTransitionNumber(layout?.depth);
  const angle = rotation(element);
  if (!(depth > 0) || !Number.isFinite(angle)) return base;
  const segment = isStart ? layout?.segments?.[0] : layout?.segments?.at(-1);
  if (
    !segment ||
    Math.abs((isStart ? segment.startRatio : segment.endRatio) - (isStart ? 0 : 1)) > EPS
  )
    return base;
  const basis = calculateBeamBasis(normalizeVector({ x: dx, y: dy, z: 0 }));
  const centerZ = (isStart ? start.z : end.z) - (basis.yAxis.z * depth) / 2;
  const roleZ = (role) => {
    const bars = (segment.bars || []).filter((bar) => bar.role === role && Number(bar.layer) === 1);
    if (bars.length === 0) return null;
    const values = bars.map((bar) => {
      const u = finiteTransitionNumber(bar.u);
      const v = finiteTransitionNumber(bar.v);
      if (u === null || v === null) return NaN;
      return centerZ + basis.yAxis.z * (u * Math.sin(angle) + v * Math.cos(angle));
    });
    return values.every(Number.isFinite) ? values : null;
  };
  const top = roleZ('top');
  const bottom = roleZ('bottom');
  if (!top || !bottom) return base;
  const upperZ = Math.min(...top);
  const lowerZ = Math.max(...bottom);
  if (upperZ > lowerZ + EPS) base.window = { lowerZ, upperZ };
  return base;
}

/** 未解決の接続梁も記録し、解けた梁だけでjtを確定しない。 */
export function collectTransitionBeamWindows(scanTag, nodeId, beamLayouts, index = null) {
  const windows = [];
  const appendWindow = (element, tagName, endpoint = null) => {
    const kind = String(element.getAttribute('kind_structure') || '').toUpperCase();
    if (kind && kind !== 'RC') return;
    const isStart = endpoint
      ? endpoint === 'start'
      : element.getAttribute('id_node_start') === nodeId;
    const isEnd = endpoint ? endpoint === 'end' : element.getAttribute('id_node_end') === nodeId;
    if (!isStart && !isEnd) return;
    const key = tagName === 'StbGirder' ? 'girder' : tagName === 'StbBeam' ? 'beam' : null;
    if (!key) return;
    const layout = beamLayouts?.[key]?.get(String(element.getAttribute('id_section')));
    windows.push(beamWindow(scanTag, element, layout, isStart, index));
  };

  if (index?.beamsByNodeId instanceof Map) {
    for (const connection of index.beamsByNodeId.get(String(nodeId)) || []) {
      appendWindow(connection.element, connection.tagName, connection.endpoint);
    }
    return windows;
  }

  for (const [tagName] of [
    ['StbGirder', 'girder'],
    ['StbBeam', 'beam'],
  ]) {
    for (const element of scanTag(tagName)) {
      appendWindow(element, tagName);
    }
  }
  return windows;
}

export function resolveTransitionBeamWindow(windows, bottom, top) {
  const dx = top.u - bottom.u;
  const dy = top.v - bottom.v;
  const e = Math.hypot(dx, dy);
  const relevant = windows.filter(
    ({ planDirection: direction }) =>
      !direction || Math.abs(direction.x * dx + direction.y * dy) > EPS * e,
  );
  if (relevant.length === 0 || relevant.some((entry) => !entry.window)) {
    return { window: null, reason: 'beam-main-window-unresolved' };
  }
  const lowerZ = Math.max(...relevant.map((entry) => entry.window.lowerZ));
  const upperZ = Math.min(...relevant.map((entry) => entry.window.upperZ));
  if (!(upperZ > lowerZ + EPS)) return { window: null, reason: 'beam-main-window-no-overlap' };
  return {
    window: {
      lowerZ,
      upperZ,
      jtMm: upperZ - lowerZ,
      beamIds: relevant.map((entry) => entry.beamId),
      source: 'beam-main-centerline-overlap',
    },
    reason: null,
  };
}
