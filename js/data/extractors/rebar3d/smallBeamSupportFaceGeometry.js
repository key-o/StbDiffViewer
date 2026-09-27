/**
 * @fileoverview R12 一般小梁の実支持面と斜交時のみこみ長さを平面geometryから解決する。
 *
 * 支持大梁を有限長の帯状矩形として扱い、小梁材軸との交差区間を求める。
 * R12-Nでは同じintersectionを小梁主筋ごとの平面軸へも適用できるよう、
 * 小梁中心軸からの幅方向offsetを任意指定できる。
 * この段階では確保長さavailableMm・折曲げ方向・RebarPathへは接続しない。
 */

import { findElementById } from '../columnSupportUtils.js';
import { resolveBeamPlanAxis } from './rebarClearGeometry.js';
import { resolveSmallBeamGirderSupportContext } from './smallBeamSupportGirderContext.js';

const EPS = 1e-9;
const BOUNDARY_TOLERANCE_MM = 1e-6;
const MIN_CROSS_SIN = 1e-3;

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    reason,
    source: 'R12-small-beam-support-face-geometry',
    effectiveEmbedmentMm: null,
    ...extra,
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function pointAt(axis, t) {
  return {
    x: axis.start.x + axis.direction.x * t,
    y: axis.start.y + axis.direction.y * t,
  };
}

function toSupportLocal(point, supportAxis) {
  const dx = point.x - supportAxis.start.x;
  const dy = point.y - supportAxis.start.y;
  const normal = { x: -supportAxis.direction.y, y: supportAxis.direction.x };
  return {
    u: dx * supportAxis.direction.x + dy * supportAxis.direction.y,
    v: dx * normal.x + dy * normal.y,
  };
}

function offsetBeamAxis(axis, lateralOffsetMm) {
  if (Math.abs(lateralOffsetMm) <= EPS) return axis;
  const normal = { x: -axis.direction.y, y: axis.direction.x };
  const dx = normal.x * lateralOffsetMm;
  const dy = normal.y * lateralOffsetMm;
  return {
    ...axis,
    start: { x: axis.start.x + dx, y: axis.start.y + dy },
    end: { x: axis.end.x + dx, y: axis.end.y + dy },
  };
}

function attributePresent(element, name) {
  if (!element) return false;
  if (typeof element.hasAttribute === 'function') return element.hasAttribute(name);
  const raw = element.getAttribute?.(name);
  return raw !== null && raw !== undefined;
}

function invalidPlanOffsets(element) {
  const invalidOffsets = [];
  for (const side of ['start', 'end']) {
    for (const axis of ['X', 'Y']) {
      const attribute = `offset_${side}_${axis}`;
      if (!attributePresent(element, attribute)) continue;
      const raw = element?.getAttribute?.(attribute);
      if (String(raw).trim() === '' || !Number.isFinite(Number(raw))) {
        invalidOffsets.push({ side, axis, attribute, raw });
      }
    }
  }
  return invalidOffsets;
}

function resolveLateralOffset(value) {
  if (value === null || value === undefined) return { resolved: true, value: 0 };
  if (String(value).trim() === '') return { resolved: false, value: null, raw: value };
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? { resolved: true, value: parsed }
    : { resolved: false, value: null, raw: value };
}

function memberContainsNode(element, nodeId) {
  if (!element || nodeId === null || nodeId === undefined) return false;
  const id = String(nodeId);
  if (
    element.getAttribute?.('id_node_start') === id ||
    element.getAttribute?.('id_node_end') === id
  ) {
    return true;
  }
  const orders = element.getElementsByTagName?.('StbNodeIdOrder');
  if (!orders) return false;
  for (let index = 0; index < orders.length; index += 1) {
    const text = orders[index]?.textContent;
    if (text && text.trim().split(/\s+/).includes(id)) return true;
  }
  return false;
}

function explicitGirderLinkMatches(supportEnd, girder) {
  if (supportEnd?.source !== 'stb-node-kind-id-member') return false;
  if (String(supportEnd?.nodeKind || '').toUpperCase() !== 'ON_GIRDER') return false;
  const linkedId = supportEnd?.linkedMemberId || supportEnd?.supportId;
  const girderId = girder?.getAttribute?.('id');
  return Boolean(linkedId && girderId && String(linkedId) === String(girderId));
}

function hasViaPlanGeometry(element, viaTagName) {
  if (!element) return false;
  const viaNodes = element.getElementsByTagName?.(viaTagName);
  if (viaNodes?.length) return true;
  const offsets = element.getElementsByTagName?.('StbMemberOffsetList');
  return Boolean(offsets?.length);
}

function clipInterval(interval, value, delta, min, max) {
  if (Math.abs(delta) <= EPS) {
    if (value < min - EPS || value > max + EPS) return null;
    return interval;
  }

  const first = (min - value) / delta;
  const second = (max - value) / delta;
  const near = Math.min(first, second);
  const far = Math.max(first, second);
  const next = {
    enter: Math.max(interval.enter, near),
    exit: Math.min(interval.exit, far),
  };
  return next.enter <= next.exit + EPS ? next : null;
}

function intersectBeamLineWithSupportRect(beamAxis, supportAxis, supportWidthMm) {
  const normal = { x: -supportAxis.direction.y, y: supportAxis.direction.x };
  const localStart = toSupportLocal(beamAxis.start, supportAxis);
  const du = dot(beamAxis.direction, supportAxis.direction);
  const dv = dot(beamAxis.direction, normal);
  let interval = { enter: -Infinity, exit: Infinity };

  interval = clipInterval(interval, localStart.u, du, 0, supportAxis.lengthMm);
  if (!interval) return null;
  interval = clipInterval(interval, localStart.v, dv, -supportWidthMm / 2, supportWidthMm / 2);
  if (!interval || !Number.isFinite(interval.enter) || !Number.isFinite(interval.exit)) return null;
  return interval;
}

function classifyBoundary(point, supportAxis, supportWidthMm) {
  const local = toSupportLocal(point, supportAxis);
  const halfWidth = supportWidthMm / 2;
  const atWidthFace = Math.abs(Math.abs(local.v) - halfWidth) <= BOUNDARY_TOLERANCE_MM;
  const atEndFace =
    Math.abs(local.u) <= BOUNDARY_TOLERANCE_MM ||
    Math.abs(local.u - supportAxis.lengthMm) <= BOUNDARY_TOLERANCE_MM;

  if (atWidthFace && atEndFace) return 'CORNER';
  if (atWidthFace) return 'WIDTH_FACE';
  if (atEndFace) return 'END_FACE';
  return 'UNKNOWN';
}

function axisIntersectionFacts(beamAxis, supportAxis) {
  const cross =
    beamAxis.direction.x * supportAxis.direction.y - beamAxis.direction.y * supportAxis.direction.x;
  const sinSkew = Math.abs(cross);
  const dotAbs = Math.min(1, Math.abs(dot(beamAxis.direction, supportAxis.direction)));
  const skewAngleDeg = (Math.acos(dotAbs) * 180) / Math.PI;

  if (sinSkew < MIN_CROSS_SIN) {
    return { resolved: false, reason: 'support-axes-near-parallel', sinSkew, skewAngleDeg };
  }

  const supportNormal = { x: -supportAxis.direction.y, y: supportAxis.direction.x };
  const offset = {
    x: beamAxis.start.x - supportAxis.start.x,
    y: beamAxis.start.y - supportAxis.start.y,
  };
  const v0 = dot(offset, supportNormal);
  const dv = dot(beamAxis.direction, supportNormal);
  const centerT = -v0 / dv;
  const center = pointAt(beamAxis, centerT);
  const supportLocal = toSupportLocal(center, supportAxis);

  return {
    resolved: true,
    reason: null,
    sinSkew,
    skewAngleDeg,
    centerT,
    center,
    supportAxisCoordinateMm: supportLocal.u,
  };
}

function supportFaceSide(localV) {
  if (!Number.isFinite(localV) || Math.abs(localV) <= BOUNDARY_TOLERANCE_MM) return null;
  return localV > 0 ? 'left' : 'right';
}

export function resolveSmallBeamSupportFaceGeometry(
  scanTag,
  beamEl,
  supportEnd,
  supportContext = null,
  options = {},
) {
  if (supportEnd?.supportType !== 'GIRDER' || !supportEnd.supportId) {
    return unresolved(`support-not-girder:${supportEnd?.supportType || 'UNKNOWN'}`);
  }
  if (!beamEl) return unresolved('small-beam-element-not-found');
  const side = supportEnd?.side;
  if (!['start', 'end'].includes(side)) {
    return unresolved('small-beam-support-side-unresolved', { side: side ?? null });
  }
  const index = options.index || null;
  const expectedBeamNodeId = beamEl.getAttribute(side === 'end' ? 'id_node_end' : 'id_node_start');
  const supportNodeId = supportEnd?.nodeId;
  if (!expectedBeamNodeId) {
    return unresolved('small-beam-end-node-id-missing', { side });
  }
  if (!supportNodeId || String(supportNodeId) !== String(expectedBeamNodeId)) {
    return unresolved('small-beam-support-node-side-mismatch', {
      side,
      supportNodeId:
        supportNodeId === null || supportNodeId === undefined ? null : String(supportNodeId),
      expectedBeamNodeId: String(expectedBeamNodeId),
    });
  }

  const girder = findElementById(scanTag, 'StbGirder', String(supportEnd.supportId), index);
  if (!girder) return unresolved('support-girder-not-found');
  const topologyConnected = memberContainsNode(girder, supportNodeId);
  const explicitGirderLink = explicitGirderLinkMatches(supportEnd, girder);
  const trustedExplicitSupportContext =
    supportContext &&
    supportEnd?.source !== 'connected-topology' &&
    supportEnd?.nodeKind !== 'ON_GRID';
  if (!topologyConnected && !explicitGirderLink && !trustedExplicitSupportContext) {
    return unresolved('support-girder-not-connected-at-support-node', {
      side,
      supportId: String(supportEnd.supportId),
      supportNodeId: String(supportNodeId),
    });
  }

  const context =
    supportContext ||
    resolveSmallBeamGirderSupportContext(scanTag, supportEnd, {
      coverMm: options.coverMm,
      index,
    });
  const supportWidthMm = Number(context?.supportWidthMm);
  if (!context?.resolved || !(supportWidthMm > 0)) {
    return unresolved(context?.reason || 'support-girder-width-unresolved', {
      supportWidthMm: supportWidthMm > 0 ? supportWidthMm : null,
    });
  }

  // resolveBeamPlanAxis() は start/end chord のみを扱うため、ViaNodeやvia固有offsetを持つ
  // polyline部材は局所端segmentを正しく反映できない。専用local-segment resolverが
  // 実装されるまでは、小梁側・支持大梁側ともにglobal chord近似せずfail-closedとする。
  if (hasViaPlanGeometry(beamEl, 'StbBeamViaNode')) {
    return unresolved('small-beam-via-plan-geometry-unresolved', { supportWidthMm });
  }
  if (hasViaPlanGeometry(girder, 'StbGirderViaNode')) {
    return unresolved('support-girder-via-plan-geometry-unresolved', {
      supportWidthMm,
      supportConnection: context.supportConnection || null,
    });
  }

  const beamInvalidOffsets = invalidPlanOffsets(beamEl);
  if (beamInvalidOffsets.length > 0) {
    return unresolved('small-beam-plan-offset-invalid', {
      supportWidthMm,
      invalidOffsets: beamInvalidOffsets,
    });
  }
  const supportInvalidOffsets = invalidPlanOffsets(girder);
  if (supportInvalidOffsets.length > 0) {
    return unresolved('support-girder-plan-offset-invalid', {
      supportWidthMm,
      invalidOffsets: supportInvalidOffsets,
    });
  }

  const centerBeamAxis = resolveBeamPlanAxis(scanTag, beamEl, index);
  const supportAxis = resolveBeamPlanAxis(scanTag, girder, index);
  if (!centerBeamAxis) return unresolved('small-beam-plan-axis-unresolved', { supportWidthMm });
  if (!supportAxis) return unresolved('support-girder-plan-axis-unresolved', { supportWidthMm });

  const lateralOffsetFact = resolveLateralOffset(options.beamLateralOffsetMm);
  if (!lateralOffsetFact.resolved) {
    return unresolved('small-beam-lateral-offset-invalid', {
      supportWidthMm,
      beamLateralOffsetMm: null,
      rawBeamLateralOffset: lateralOffsetFact.raw,
    });
  }
  const lateralOffsetMm = lateralOffsetFact.value;
  const beamAxis = offsetBeamAxis(centerBeamAxis, lateralOffsetMm);
  const intersection = axisIntersectionFacts(beamAxis, supportAxis);
  if (!intersection.resolved) {
    return unresolved(intersection.reason, {
      supportWidthMm,
      beamLateralOffsetMm: lateralOffsetMm,
      sinSkew: intersection.sinSkew,
      skewAngleDeg: intersection.skewAngleDeg,
    });
  }

  const interval = intersectBeamLineWithSupportRect(beamAxis, supportAxis, supportWidthMm);
  if (!interval) {
    return unresolved('small-beam-axis-does-not-cross-support-rectangle', {
      supportWidthMm,
      beamLateralOffsetMm: lateralOffsetMm,
      sinSkew: intersection.sinSkew,
      skewAngleDeg: intersection.skewAngleDeg,
    });
  }

  const beamEndT = side === 'end' ? beamAxis.lengthMm : 0;
  const beamEndInsideSupport =
    beamEndT >= interval.enter - BOUNDARY_TOLERANCE_MM &&
    beamEndT <= interval.exit + BOUNDARY_TOLERANCE_MM;
  if (!beamEndInsideSupport) {
    return unresolved('small-beam-end-outside-support-rectangle', {
      supportWidthMm,
      beamLateralOffsetMm: lateralOffsetMm,
      beamEndT,
      intervalStartT: interval.enter,
      intervalEndT: interval.exit,
      sinSkew: intersection.sinSkew,
      skewAngleDeg: intersection.skewAngleDeg,
    });
  }

  const nearFaceT = side === 'end' ? interval.enter : interval.exit;
  const farFaceT = side === 'end' ? interval.exit : interval.enter;
  const nearFace = pointAt(beamAxis, nearFaceT);
  const farFace = pointAt(beamAxis, farFaceT);
  const nearLocal = toSupportLocal(nearFace, supportAxis);
  const farLocal = toSupportLocal(farFace, supportAxis);
  const nearBoundary = classifyBoundary(nearFace, supportAxis, supportWidthMm);
  const farBoundary = classifyBoundary(farFace, supportAxis, supportWidthMm);
  const geometricPathMm = Math.abs(interval.exit - interval.enter);

  if (nearBoundary !== 'WIDTH_FACE' || farBoundary !== 'WIDTH_FACE') {
    return unresolved('support-embedment-truncated-by-girder-end', {
      supportWidthMm,
      beamLateralOffsetMm: lateralOffsetMm,
      geometricPathMm,
      nearFace,
      farFace,
      nearBoundary,
      farBoundary,
      nearFaceSupportV: nearLocal.v,
      farFaceSupportV: farLocal.v,
      sinSkew: intersection.sinSkew,
      skewAngleDeg: intersection.skewAngleDeg,
      axisIntersection: intersection.center,
      supportAxisCoordinateMm: intersection.supportAxisCoordinateMm,
    });
  }

  return {
    resolved: true,
    reason: null,
    source: 'R12-small-beam-support-face-geometry',
    side,
    supportId: String(supportEnd.supportId),
    supportWidthMm,
    supportWidthSource: context.supportWidthSource || null,
    supportConnection: context.supportConnection || null,
    beamLateralOffsetMm: lateralOffsetMm,
    beamEndT,
    beamEndInsideSupport: true,
    nearFaceT,
    farFaceT,
    nearFace,
    farFace,
    nearFaceSupportV: nearLocal.v,
    farFaceSupportV: farLocal.v,
    nearFaceSide: supportFaceSide(nearLocal.v),
    farFaceSide: supportFaceSide(farLocal.v),
    nearBoundary,
    farBoundary,
    axisIntersection: intersection.center,
    supportAxisCoordinateMm: intersection.supportAxisCoordinateMm,
    sinSkew: intersection.sinSkew,
    skewAngleDeg: intersection.skewAngleDeg,
    effectiveEmbedmentMm: geometricPathMm,
    expectedWidthPathMm: supportWidthMm / intersection.sinSkew,
  };
}
