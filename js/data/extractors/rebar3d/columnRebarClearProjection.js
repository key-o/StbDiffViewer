/**
 * @fileoverview 梁主筋の柱内定着に用いる実柱配筋からの投影可能長 resolver。
 *
 * 柱断面ローカル(u,v)の主筋factsを柱rotateで平面へ戻し、梁スパン側から見た
 * 反対側主筋の内側境界までをavailableProjectionとして解く。
 */

import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';

const FACE_TOLERANCE_MM = 1;

function rotatePoint(u, v, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { x: u * cos - v * sin, y: u * sin + v * cos };
}

function projectedRectDepth(dims, direction, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const localX = direction.x * cos + direction.y * sin;
  const localY = -direction.x * sin + direction.y * cos;
  return Math.abs(localX) * dims.widthX + Math.abs(localY) * dims.widthY;
}

/** 柱rotateを含む梁軸方向柱せい。 */
export function projectColumnDepthWithRotation(dims, beamDirection, rotateDegrees = 0) {
  if (!dims || !beamDirection) return 0;
  if (dims.shape === 'CIRCLE') return Number(dims.widthX) || 0;
  const widthX = Number(dims.widthX) || 0;
  const widthY = Number(dims.widthY) || 0;
  if (!(widthX > 0) || !(widthY > 0)) return 0;
  return projectedRectDepth(
    { widthX, widthY },
    beamDirection,
    ((Number(rotateDegrees) || 0) * Math.PI) / 180,
  );
}

function endpointBars(columnEl, layout, nodeId) {
  if (!layout) return [];
  const isTop = columnEl?.getAttribute?.('id_node_top') === nodeId;
  const isBottom = columnEl?.getAttribute?.('id_node_bottom') === nodeId;
  if (layout.endpointFacts) {
    if (isTop && layout.endpointFacts.top?.bars?.length) return layout.endpointFacts.top.bars;
    if (isBottom && layout.endpointFacts.bottom?.bars?.length)
      return layout.endpointFacts.bottom.bars;
  }
  return layout.segments?.[0]?.bars || [];
}

/**
 * 実柱主筋から梁主筋の水平投影可能長を算定する。
 * @returns {{resolved:boolean, availableProjectionMm:number|null, columnDepthMm:number,
 *   farBoundaryFromCenterMm:number|null, source:string, unresolvedReasons:string[], barsUsed:number}}
 */
export function resolveColumnRebarAvailableProjection({
  columnEl,
  columnLayout,
  columnDimensions,
  nodeId,
  beamDirection,
  beamSide,
}) {
  const unresolvedReasons = [];
  if (!columnEl) unresolvedReasons.push('missing-column-element');
  if (!columnDimensions) unresolvedReasons.push('missing-column-dimensions');
  if (!beamDirection || !Number.isFinite(beamDirection.x) || !Number.isFinite(beamDirection.y)) {
    unresolvedReasons.push('missing-beam-direction');
  }
  if (unresolvedReasons.length) {
    return {
      resolved: false,
      availableProjectionMm: null,
      columnDepthMm: 0,
      farBoundaryFromCenterMm: null,
      source: 'unresolved',
      unresolvedReasons,
      barsUsed: 0,
    };
  }

  const rotateDegrees =
    Number(columnEl.getAttribute('rotate') ?? columnEl.getAttribute('angle') ?? 0) || 0;
  const spanDirection =
    beamSide === 'end'
      ? { x: -beamDirection.x, y: -beamDirection.y }
      : { x: beamDirection.x, y: beamDirection.y };
  const columnDepthMm = projectColumnDepthWithRotation(
    columnDimensions,
    spanDirection,
    rotateDegrees,
  );
  if (!(columnDepthMm > 0)) {
    return {
      resolved: false,
      availableProjectionMm: null,
      columnDepthMm: 0,
      farBoundaryFromCenterMm: null,
      source: 'unresolved',
      unresolvedReasons: ['invalid-column-depth'],
      barsUsed: 0,
    };
  }
  if (!columnLayout) {
    return {
      resolved: false,
      availableProjectionMm: null,
      columnDepthMm,
      farBoundaryFromCenterMm: null,
      source: 'unresolved',
      unresolvedReasons: ['missing-column-rebar-layout'],
      barsUsed: 0,
    };
  }

  const bars = endpointBars(columnEl, columnLayout, nodeId).filter(
    (bar) =>
      Number.isFinite(Number(bar?.u)) && Number.isFinite(Number(bar?.v)) && Number(bar?.dia) > 0,
  );
  if (bars.length === 0) {
    return {
      resolved: false,
      availableProjectionMm: null,
      columnDepthMm,
      farBoundaryFromCenterMm: null,
      source: 'unresolved',
      unresolvedReasons: ['missing-column-main-bars'],
      barsUsed: 0,
    };
  }

  const angleRad = (rotateDegrees * Math.PI) / 180;
  const projected = bars.map((bar) => {
    const point = rotatePoint(Number(bar.u), Number(bar.v), angleRad);
    const center = point.x * spanDirection.x + point.y * spanDirection.y;
    const diaName = bar.diaName || `D${Number(bar.dia)}`;
    const radius = barOuterDiameterMm(diaName, barDiameterMm(diaName, Number(bar.dia))) / 2;
    return { bar, center, radius };
  });
  const farCenter = Math.min(...projected.map((item) => item.center));
  const maxRadius = Math.max(...projected.map((item) => item.radius));
  const farBars = projected.filter(
    (item) => item.center <= farCenter + Math.max(FACE_TOLERANCE_MM, maxRadius),
  );
  if (farBars.length === 0) {
    return {
      resolved: false,
      availableProjectionMm: null,
      columnDepthMm,
      farBoundaryFromCenterMm: null,
      source: 'unresolved',
      unresolvedReasons: ['missing-far-face-column-bars'],
      barsUsed: 0,
    };
  }

  // 反対側主筋の梁スパン側外面（中心投影 + 半径）のうち、最も内側となる境界を採用。
  const farBoundaryFromCenterMm = Math.max(...farBars.map((item) => item.center + item.radius));
  const nearConcreteFaceFromCenterMm = columnDepthMm / 2;
  const availableProjectionMm = nearConcreteFaceFromCenterMm - farBoundaryFromCenterMm;
  if (!(availableProjectionMm > 0)) {
    return {
      resolved: false,
      availableProjectionMm: null,
      columnDepthMm,
      farBoundaryFromCenterMm,
      source: 'unresolved',
      unresolvedReasons: ['nonpositive-available-projection'],
      barsUsed: farBars.length,
    };
  }

  return {
    resolved: true,
    availableProjectionMm,
    columnDepthMm,
    farBoundaryFromCenterMm,
    source: 'actual-column-rebar',
    unresolvedReasons: [],
    barsUsed: farBars.length,
  };
}
