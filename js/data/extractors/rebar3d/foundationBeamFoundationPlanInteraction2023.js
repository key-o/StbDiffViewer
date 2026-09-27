/**
 * @fileoverview 日建連・JSCA 2023標準図 §6-3 の基礎梁–フーチング平面取合いgate。
 *
 * StbGirderの実平面材軸（member offset反映）とRC梁断面幅・horizontal_offset、
 * StbFootingの図心offset・rotate・平面形状を用い、梁端断面幅がフーチング平面内に
 * 収まることだけを確認する。補強筋pathや定着長は後段の責務とする。
 */

import { findElementById } from '../columnSupportUtils.js';
import { resolveBeamPlanAxis } from './rebarClearGeometry.js';
import { planPolygon } from './foundationRebarGeometry.js';

const SOURCE = 'R13-foundation-beam-foundation-plan-interaction-2023';
const EPS = 1e-6;

function outcome(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY' || status === 'BLOCKED',
    satisfied: status === 'READY' ? true : status === 'BLOCKED' ? false : null,
    reason: reason || null,
    blockers: reason ? [reason] : [],
    source: SOURCE,
    planInteractionResolved: status === 'READY' || status === 'BLOCKED',
    productionReady: false,
    ...extra,
  };
}
function ready(extra = {}) {
  return outcome('READY', null, extra);
}
function blocked(reason, extra = {}) {
  return outcome('BLOCKED', reason, extra);
}
function unresolved(reason, extra = {}) {
  return outcome('UNRESOLVED', reason, extra);
}
function invalid(reason, extra = {}) {
  return outcome('INVALID', reason, extra);
}
function finiteAttribute(element, name, fallback = null) {
  if (!element?.hasAttribute?.(name)) return fallback;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}
function firstDescendant(element, tagName) {
  return element?.getElementsByTagName?.(tagName)?.[0] || null;
}
function firstElementChild(element) {
  return Array.from(element?.childNodes || []).find((child) => child?.nodeType === 1) || null;
}
function rotateIntoLocal(vector, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { x: cos * vector.x + sin * vector.y, y: -sin * vector.x + cos * vector.y };
}
function pointOnSegment(point, a, b) {
  const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
  if (Math.abs(cross) > EPS) return false;
  const dot = (point.x - a.x) * (point.x - b.x) + (point.y - a.y) * (point.y - b.y);
  return dot <= EPS;
}
function pointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[j];
    const b = polygon[i];
    if (pointOnSegment(point, a, b)) return true;
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function parseFootingShape(section) {
  const figure = firstDescendant(section, 'StbSecFigureFoundation_RC');
  const shapeEl = firstElementChild(figure);
  const shapeName = shapeEl?.localName || shapeEl?.tagName || null;
  if (shapeName === 'StbSecFoundation_RC_Rect') {
    const widthXmm = finiteAttribute(shapeEl, 'width_X');
    const widthYmm = finiteAttribute(shapeEl, 'width_Y');
    if (!(widthXmm > 0) || !(widthYmm > 0)) return null;
    return { type: 'RECT', widthXmm, widthYmm };
  }
  if (shapeName === 'StbSecFoundation_RC_Triangle') {
    const widthXmm = finiteAttribute(shapeEl, 'width_X');
    const widthYmm = finiteAttribute(shapeEl, 'width_Y');
    const chamferXmm = finiteAttribute(shapeEl, 'width_chamfer_X', 0);
    const chamferYmm = finiteAttribute(shapeEl, 'width_chamfer_Y', 0);
    if (!(widthXmm > 0) || !(widthYmm > 0) || chamferXmm === null || chamferYmm === null)
      return null;
    return { type: 'TRIANGLE', widthXmm, widthYmm, chamferXmm, chamferYmm };
  }
  if (shapeName === 'StbSecFoundation_RC_EquiTriangle') {
    const widthBaseMm = finiteAttribute(shapeEl, 'width_base');
    const widthChamferMm = finiteAttribute(shapeEl, 'width_chamfer');
    if (!(widthBaseMm > 0) || !(widthChamferMm >= 0)) return null;
    return { type: 'EQUI_TRIANGLE', widthBaseMm, widthChamferMm };
  }
  if (shapeName === 'StbSecFoundation_RC_Octagon') {
    const widthXmm = finiteAttribute(shapeEl, 'width_X');
    const widthYmm = finiteAttribute(shapeEl, 'width_Y');
    const chamfers = [1, 2, 3, 4].map((index) => ({
      x: finiteAttribute(shapeEl, `width_chamfer${index}_X`),
      y: finiteAttribute(shapeEl, `width_chamfer${index}_Y`),
    }));
    if (
      !(widthXmm > 0) ||
      !(widthYmm > 0) ||
      chamfers.some((item) => !(item.x >= 0) || !(item.y >= 0))
    )
      return null;
    return { type: 'OCTAGON', widthXmm, widthYmm, chamfers };
  }
  return null;
}

function footingPolygon(scanTag, footingEl, index = null) {
  const sectionId = footingEl?.getAttribute?.('id_section');
  const section = sectionId
    ? findElementById(scanTag, 'StbSecFoundation_RC', sectionId, index)
    : null;
  if (!section) return unresolved('foundation-interaction-plan-footing-section-unresolved');
  const shape = parseFootingShape(section);
  if (!shape) {
    return unresolved('foundation-interaction-plan-footing-shape-unsupported', { sectionId });
  }

  const additions = {
    startX: finiteAttribute(footingEl, 'thickness_add_start_X', 0),
    endX: finiteAttribute(footingEl, 'thickness_add_end_X', 0),
    startY: finiteAttribute(footingEl, 'thickness_add_start_Y', 0),
    endY: finiteAttribute(footingEl, 'thickness_add_end_Y', 0),
  };
  if (Object.values(additions).some((value) => value === null || value < 0)) {
    return invalid('foundation-interaction-plan-footing-fukashi-invalid', { sectionId });
  }

  let polygon;
  if (shape.type === 'RECT') {
    polygon = [
      { x: -shape.widthXmm / 2 - additions.startX, y: -shape.widthYmm / 2 - additions.startY },
      { x: shape.widthXmm / 2 + additions.endX, y: -shape.widthYmm / 2 - additions.startY },
      { x: shape.widthXmm / 2 + additions.endX, y: shape.widthYmm / 2 + additions.endY },
      { x: -shape.widthXmm / 2 - additions.startX, y: shape.widthYmm / 2 + additions.endY },
    ];
  } else {
    if (Object.values(additions).some((value) => value > EPS)) {
      return unresolved('foundation-interaction-plan-nonrect-fukashi-unsupported', {
        sectionId,
        shapeType: shape.type,
      });
    }
    polygon = planPolygon(shape);
  }
  return polygon?.length >= 3
    ? ready({ sectionId, shape, polygon, additions })
    : unresolved('foundation-interaction-plan-footing-polygon-unresolved', { sectionId });
}

function beamHorizontalOffset(scanTag, beamEl, side, index = null) {
  const sectionId = beamEl?.getAttribute?.('id_section');
  const section = sectionId ? findElementById(scanTag, 'StbSecBeam_RC', sectionId, index) : null;
  if (!section) return unresolved('foundation-interaction-plan-beam-section-unresolved');
  const figures = Array.from(section.getElementsByTagName?.('StbSecFigureBeam_RC') || [])
    .map((figure) => ({ figure, order: Number(figure.getAttribute('order')) }))
    .filter((entry) => Number.isFinite(entry.order))
    .sort((a, b) => a.order - b.order);
  if (!figures.length) return unresolved('foundation-interaction-plan-beam-figure-unresolved');
  const figure = side === 'end' ? figures[figures.length - 1].figure : figures[0].figure;
  const shape = firstElementChild(figure);
  const shapeName = shape?.localName || shape?.tagName || null;
  const attr = shapeName === 'StbSecBeamTaper' ? `${side}_horizontal_offset` : 'horizontal_offset';
  if (!['StbSecBeamStraight', 'StbSecBeamTaper'].includes(shapeName)) {
    return unresolved('foundation-interaction-plan-beam-shape-unsupported', { shapeName });
  }
  const offsetMm = finiteAttribute(shape, attr, 0);
  return offsetMm === null
    ? invalid('foundation-interaction-plan-beam-horizontal-offset-invalid', { attr })
    : ready({ offsetMm, attr, shapeName });
}

export function resolveFoundationBeamFoundationPlanInteraction2023({
  scanTag,
  beamEl,
  endFact,
  stepGeometry,
  index = null,
} = {}) {
  if (typeof scanTag !== 'function') return invalid('foundation-interaction-plan-scan-tag-missing');
  if (!beamEl) return unresolved('foundation-interaction-plan-beam-element-missing');
  if (stepGeometry?.status !== 'READY' || !(stepGeometry.beamWidthMm > 0)) {
    return unresolved(
      stepGeometry?.reason || 'foundation-interaction-plan-step-geometry-unresolved',
    );
  }
  const footingId = endFact?.footing?.id;
  const footingEl = footingId ? findElementById(scanTag, 'StbFooting', footingId, index) : null;
  if (!footingEl) return unresolved('foundation-interaction-plan-footing-element-unresolved');
  const axis = resolveBeamPlanAxis(scanTag, beamEl, index);
  if (!axis) return unresolved('foundation-interaction-plan-beam-axis-unresolved');
  const side = endFact?.side;
  if (!['start', 'end'].includes(side)) return invalid('foundation-interaction-plan-side-invalid');

  const nodeX = Number(endFact?.node?.X);
  const nodeY = Number(endFact?.node?.Y);
  if (![nodeX, nodeY].every(Number.isFinite)) {
    return unresolved('foundation-interaction-plan-node-coordinate-unresolved');
  }
  const footingOffsetX = finiteAttribute(footingEl, 'offset_X', 0);
  const footingOffsetY = finiteAttribute(footingEl, 'offset_Y', 0);
  const rotateDeg = finiteAttribute(footingEl, 'rotate', 0);
  if (![footingOffsetX, footingOffsetY, rotateDeg].every(Number.isFinite)) {
    return invalid('foundation-interaction-plan-footing-placement-invalid');
  }
  const polygonResolution = footingPolygon(scanTag, footingEl, index);
  if (polygonResolution.status !== 'READY') return polygonResolution;
  const sectionOffset = beamHorizontalOffset(scanTag, beamEl, side, index);
  if (sectionOffset.status !== 'READY') return sectionOffset;

  const endpoint = side === 'end' ? axis.end : axis.start;
  const left = { x: -axis.direction.y, y: axis.direction.x };
  const beamCenter = {
    x: endpoint.x + left.x * sectionOffset.offsetMm,
    y: endpoint.y + left.y * sectionOffset.offsetMm,
  };
  const halfWidth = stepGeometry.beamWidthMm / 2;
  const beamEdges = [
    { x: beamCenter.x + left.x * halfWidth, y: beamCenter.y + left.y * halfWidth },
    { x: beamCenter.x - left.x * halfWidth, y: beamCenter.y - left.y * halfWidth },
  ];
  const footingCenter = { x: nodeX + footingOffsetX, y: nodeY + footingOffsetY };
  const angleRad = (rotateDeg * Math.PI) / 180;
  const toLocal = (point) =>
    rotateIntoLocal({ x: point.x - footingCenter.x, y: point.y - footingCenter.y }, angleRad);
  const localCenter = toLocal(beamCenter);
  const localEdges = beamEdges.map(toLocal);
  const localPoints = [localCenter, ...localEdges];
  const inside = localPoints.every((point) => pointInPolygon(point, polygonResolution.polygon));
  const common = {
    side,
    nodeId: endFact?.nodeId || null,
    footingId: String(footingId),
    footingSectionId: polygonResolution.sectionId,
    footingShapeType: polygonResolution.shape.type,
    footingCenter,
    footingRotateDeg: rotateDeg,
    beamAxisEndpoint: endpoint,
    beamCenter,
    beamEdges,
    beamWidthMm: stepGeometry.beamWidthMm,
    beamHorizontalOffsetMm: sectionOffset.offsetMm,
    localBeamCenter: localCenter,
    localBeamEdges: localEdges,
    basis: 'STB_BEAM_END_SECTION_WIDTH_WITHIN_STB_FOOTING_PLAN',
  };
  return inside
    ? ready(common)
    : blocked('foundation-interaction-plan-beam-section-outside-footing', common);
}

export const _foundationBeamFoundationPlanInteraction2023Internals = Object.freeze({
  rotateIntoLocal,
  pointInPolygon,
  parseFootingShape,
  footingPolygon,
  beamHorizontalOffset,
});
