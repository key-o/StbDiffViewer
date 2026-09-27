/**
 * @fileoverview 外周HOOP/STPの135°フックを角主筋へ実際に巻き付けるgeometry kernel。
 *
 * 従来の矩形closure角をそのまま135°filletのsharp cornerに使うと、曲げ接点が
 * 角主筋から大きく離れ、余長同士は分離できても主筋を抱かない形になる。
 *
 * 本kernelはplacementで解いた角主筋bar factを正本とし、外周脚中心線が角主筋へ
 * 接する点を135°Arcの主脚側接点として固定する。曲げ内法直径は標準最小値を下回らず、
 * 角主筋径が大きい場合は主筋を切らないよう実曲げ半径だけを拡大する。
 */

import { resolveHookBendGeometry } from './rebarHookGeometry.js';
import { resolveRoundedTransitionCorner } from './rebarTransitionArcGeometry.js';
import { createArc, createLine, createRebarPath } from './rebarPath.js';
import { validateTangentContinuousRebarPath } from './shearRebarPathGeometry.js';

const EPS = 1e-7;
const POINT_TOLERANCE_MM = 1e-5;
const HOOK_ANGLE_DEG = 135;
const HOOK_ANGLE_RAD = (HOOK_ANGLE_DEG * Math.PI) / 180;

function vec(x, y, z = 0) {
  return { x: Number(x), y: Number(y), z: Number(z) };
}

function add(a, b) {
  return vec(a.x + b.x, a.y + b.y, a.z + b.z);
}

function subtract(a, b) {
  return vec(a.x - b.x, a.y - b.y, a.z - b.z);
}

function scale(a, factor) {
  return vec(a.x * factor, a.y * factor, a.z * factor);
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

function magnitude(a) {
  return Math.hypot(a.x, a.y, a.z);
}

function normalize(a) {
  const length = magnitude(a);
  return length > EPS ? scale(a, 1 / length) : null;
}

function distance(a, b) {
  return magnitude(subtract(a, b));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function failure(reason, extra = {}) {
  return { ok: false, specialRequired: true, reason, ...extra, path: null, paths: [] };
}

function appendLine(primitives, start, end) {
  if (distance(start, end) <= EPS) return;
  primitives.push(createLine(start, end));
}

function normalizeAnchor(anchor) {
  const u = Number(anchor?.u);
  const v = Number(anchor?.v);
  const dia = Number(anchor?.dia);
  if (![u, v, dia].every(Number.isFinite) || !(dia > 0)) return null;
  return { u, v, dia };
}

function rectTraversal(uMin, uMax, vMin, vMax, hookPosition) {
  if (hookPosition === 'BOTTOM_LEFT') {
    return {
      closure: vec(uMin, vMin),
      startDirection: vec(0, 1),
      startInward: vec(1, 0),
      endDirection: vec(-1, 0),
      endInward: vec(0, 1),
      corners: [
        { point: vec(uMin, vMax), incoming: vec(0, 1), outgoing: vec(1, 0) },
        { point: vec(uMax, vMax), incoming: vec(1, 0), outgoing: vec(0, -1) },
        { point: vec(uMax, vMin), incoming: vec(0, -1), outgoing: vec(-1, 0) },
      ],
    };
  }

  return {
    closure: vec(uMax, vMax),
    startDirection: vec(0, -1),
    startInward: vec(-1, 0),
    endDirection: vec(1, 0),
    endInward: vec(0, -1),
    corners: [
      { point: vec(uMax, vMin), incoming: vec(0, -1), outgoing: vec(-1, 0) },
      { point: vec(uMin, vMin), incoming: vec(-1, 0), outgoing: vec(0, 1) },
      { point: vec(uMin, vMax), incoming: vec(0, 1), outgoing: vec(1, 0) },
    ],
  };
}

function roundedCornerWithRadius({ corner, incomingDirection, outgoingDirection, radius }) {
  const incoming = normalize(incomingDirection);
  const outgoing = normalize(outgoingDirection);
  const r = Number(radius);
  if (!incoming || !outgoing || !(r > 0)) return failure('invalid-wrapped-hook-corner-input');

  const turnAngleRad = Math.acos(clamp(dot(incoming, outgoing), -1, 1));
  if (!(turnAngleRad > EPS) || !(turnAngleRad < Math.PI - EPS)) {
    return failure('invalid-wrapped-hook-turn-angle');
  }
  const tangentDistanceMm = r * Math.tan(turnAngleRad / 2);
  if (!(tangentDistanceMm > EPS) || !Number.isFinite(tangentDistanceMm)) {
    return failure('invalid-wrapped-hook-tangent-distance');
  }

  const incomingTangent = subtract(corner, scale(incoming, tangentDistanceMm));
  const outgoingTangent = add(corner, scale(outgoing, tangentDistanceMm));
  const planeNormal = normalize(cross(incoming, outgoing));
  if (!planeNormal) return failure('invalid-wrapped-hook-plane');
  const radialStart = normalize(cross(incoming, planeNormal));
  if (!radialStart) return failure('invalid-wrapped-hook-radial-start');
  const center = subtract(incomingTangent, scale(radialStart, r));
  const radialEnd = normalize(subtract(outgoingTangent, center));
  if (!radialEnd) return failure('invalid-wrapped-hook-radial-end');
  const expectedOutgoing = normalize(cross(planeNormal, radialEnd));
  if (!expectedOutgoing || dot(expectedOutgoing, outgoing) < 1 - 1e-7) {
    return failure('wrapped-hook-arc-tangent-mismatch');
  }

  return {
    ok: true,
    specialRequired: false,
    reason: null,
    incomingTangent,
    outgoingTangent,
    center,
    tangentDistanceMm,
    radius: r,
    arc: createArc({
      center,
      radius: r,
      planeNormal,
      startDirection: radialStart,
      sweepAngleRad: turnAngleRad,
    }),
  };
}

function pointToLineDistance(point, linePoint, direction) {
  const dir = normalize(direction);
  if (!dir) return NaN;
  return magnitude(cross(subtract(point, linePoint), dir));
}

function buildWrappedTerminal({ position, traversal, anchor, hookRule, barDiaMm }) {
  const mainDirection = position === 'start' ? traversal.startDirection : traversal.endDirection;
  const inwardDirection = position === 'start' ? traversal.startInward : traversal.endInward;
  const main = normalize(mainDirection);
  const inward = normalize(inwardDirection);
  if (!main || !inward || Math.abs(dot(main, inward)) > 1e-6) {
    return failure('invalid-wrapped-hook-directions');
  }

  const anchorPoint = vec(anchor.u, anchor.v);
  const clearanceRadiusMm = (Number(anchor.dia) + Number(barDiaMm)) / 2;
  const minimumRadiusMm = Number(hookRule.centerlineRadiusMm);
  const actualRadiusMm = Math.max(minimumRadiusMm, clearanceRadiusMm);
  const actualInsideDiameterMm = 2 * actualRadiusMm - Number(barDiaMm);
  const mainTangent = add(anchorPoint, scale(inward, -clearanceRadiusMm));

  if (pointToLineDistance(mainTangent, traversal.closure, main) > POINT_TOLERANCE_MM) {
    return failure('wrapped-hook-anchor-not-on-outer-leg', {
      hookPosition: position,
      anchor,
      mainTangent,
      clearanceRadiusMm,
    });
  }

  if (position === 'start') {
    const incoming = normalize(
      add(scale(main, Math.cos(HOOK_ANGLE_RAD)), scale(inward, -Math.sin(HOOK_ANGLE_RAD))),
    );
    if (!incoming) return failure('invalid-wrapped-start-hook-direction');
    const tangentDistanceMm = actualRadiusMm * Math.tan(HOOK_ANGLE_RAD / 2);
    const corner = subtract(mainTangent, scale(main, tangentDistanceMm));
    const rounded = roundedCornerWithRadius({
      corner,
      incomingDirection: incoming,
      outgoingDirection: main,
      radius: actualRadiusMm,
    });
    if (!rounded.ok) return rounded;
    if (distance(rounded.outgoingTangent, mainTangent) > POINT_TOLERANCE_MM) {
      return failure('wrapped-start-hook-main-tangent-mismatch');
    }
    const free = subtract(rounded.incomingTangent, scale(incoming, hookRule.tailLengthMm));
    return {
      ok: true,
      start: free,
      end: rounded.outgoingTangent,
      mainTangent,
      clearanceRadiusMm,
      actualRadiusMm,
      actualInsideDiameterMm,
      radiusAdjustedForMainBar: actualRadiusMm > minimumRadiusMm + EPS,
      primitives: [createLine(free, rounded.incomingTangent), rounded.arc],
    };
  }

  const outgoing = normalize(
    add(scale(main, Math.cos(HOOK_ANGLE_RAD)), scale(inward, Math.sin(HOOK_ANGLE_RAD))),
  );
  if (!outgoing) return failure('invalid-wrapped-end-hook-direction');
  const tangentDistanceMm = actualRadiusMm * Math.tan(HOOK_ANGLE_RAD / 2);
  const corner = add(mainTangent, scale(main, tangentDistanceMm));
  const rounded = roundedCornerWithRadius({
    corner,
    incomingDirection: main,
    outgoingDirection: outgoing,
    radius: actualRadiusMm,
  });
  if (!rounded.ok) return rounded;
  if (distance(rounded.incomingTangent, mainTangent) > POINT_TOLERANCE_MM) {
    return failure('wrapped-end-hook-main-tangent-mismatch');
  }
  const free = add(rounded.outgoingTangent, scale(outgoing, hookRule.tailLengthMm));
  return {
    ok: true,
    start: rounded.incomingTangent,
    end: free,
    mainTangent,
    clearanceRadiusMm,
    actualRadiusMm,
    actualInsideDiameterMm,
    radiusAdjustedForMainBar: actualRadiusMm > minimumRadiusMm + EPS,
    primitives: [rounded.arc, createLine(rounded.outgoingTangent, free)],
  };
}

function roundedOuterCorner({ point, incoming, outgoing, grade, barDiaMm }) {
  const result = resolveRoundedTransitionCorner({
    corner: point,
    incomingDirection: incoming,
    outgoingDirection: outgoing,
    grade,
    barDiaMm,
  });
  return result.ok ? result : failure(result.reason, result);
}

function parallelLineSeparationMm(lineA, lineB) {
  if (lineA?.type !== 'line' || lineB?.type !== 'line') return NaN;
  const a = subtract(lineA.end, lineA.start);
  const length = magnitude(a);
  if (!(length > EPS)) return NaN;
  const separation = magnitude(cross(subtract(lineB.start, lineA.start), scale(a, 1 / length)));
  return separation;
}

function buildVariant({
  uMin,
  uMax,
  vMin,
  vMax,
  grade,
  barDiaMm,
  hookRule,
  hookPosition,
  anchor,
  metadata,
}) {
  const traversal = rectTraversal(uMin, uMax, vMin, vMax, hookPosition);
  const startHook = buildWrappedTerminal({
    position: 'start',
    traversal,
    anchor,
    hookRule,
    barDiaMm,
  });
  if (!startHook.ok) return startHook;
  const endHook = buildWrappedTerminal({
    position: 'end',
    traversal,
    anchor,
    hookRule,
    barDiaMm,
  });
  if (!endHook.ok) return endHook;

  const corners = traversal.corners.map((item) => roundedOuterCorner({ ...item, grade, barDiaMm }));
  const failed = corners.find((item) => !item.ok);
  if (failed) return failed;

  const primitives = [...startHook.primitives];
  let cursor = startHook.end;
  for (const corner of corners) {
    appendLine(primitives, cursor, corner.incomingTangent);
    primitives.push(corner.arc);
    cursor = corner.outgoingTangent;
  }
  appendLine(primitives, cursor, endHook.start);
  primitives.push(...endHook.primitives);

  const tailSeparationMm = parallelLineSeparationMm(primitives[0], primitives.at(-1));
  if (!Number.isFinite(tailSeparationMm) || tailSeparationMm < Number(barDiaMm) - 1e-6) {
    return failure('wrapped-hook-tail-overlap', { tailSeparationMm, barDiaMm });
  }

  const path = createRebarPath(primitives, {
    ...metadata,
    dia: Number(barDiaMm),
    grade: hookRule.grade,
    bendGeometry: 'actual-arc',
    closureType: 'HOOK',
    hookAngleDeg: HOOK_ANGLE_DEG,
    hookPosition,
    hookTailLengthMm: hookRule.tailLengthMm,
    hookTailMinimumMm: hookRule.minimumTailLengthMm,
    minimumInsideDiameterMm: hookRule.insideDiameterMm,
    minimumCenterlineRadiusMm: hookRule.centerlineRadiusMm,
    insideDiameterMm: Math.max(startHook.actualInsideDiameterMm, endHook.actualInsideDiameterMm),
    centerlineRadiusMm: Math.max(startHook.actualRadiusMm, endHook.actualRadiusMm),
    hookRadiusAdjustedForMainBar:
      startHook.radiusAdjustedForMainBar || endHook.radiusAdjustedForMainBar,
    hookPairGeometry: 'MAIN_BAR_WRAPPED',
    hookPairCornerSetbackMm: null,
    hookPairCenterlineSeparationMm: tailSeparationMm,
    hookAnchorBar: { ...anchor },
    hookAnchorClearanceRadiusMm: startHook.clearanceRadiusMm,
    hookStartLegTangent: startHook.mainTangent,
    hookEndLegTangent: endHook.mainTangent,
    mainBarEnclosure: true,
    standardId: hookRule.standardId,
  });
  const validation = validateTangentContinuousRebarPath(path);
  if (!validation.ok) return failure('invalid-main-bar-wrapped-shear-path', { validation });

  return { ok: true, specialRequired: false, reason: null, path, validation };
}

/**
 * actual-main-barsから解いた角主筋を正本として、外周HOOP/STPの135°フックを生成する。
 * TOP_RIGHT / BOTTOM_LEFTの2variantを返し、材軸方向の交互配置は既存consumerへ委ねる。
 */
export function buildMainBarWrappedRectShearPath({
  uMin,
  uMax,
  vMin,
  vMax,
  grade,
  barDiaMm,
  hookAnchorBars,
  tailLengthMm = null,
  metadata = {},
} = {}) {
  const bounds = [uMin, uMax, vMin, vMax, barDiaMm].map(Number);
  if (!bounds.every(Number.isFinite) || !(uMax > uMin) || !(vMax > vMin) || !(barDiaMm > 0)) {
    return failure('invalid-main-bar-wrapped-rect-geometry');
  }

  const hookRule = resolveHookBendGeometry({
    grade,
    barDiaMm,
    bendAngleDeg: HOOK_ANGLE_DEG,
    tailLengthMm,
  });
  if (!hookRule.ok) return { ...hookRule, path: null, paths: [] };

  const positions = ['TOP_RIGHT', 'BOTTOM_LEFT'];
  const variants = [];
  for (const hookPosition of positions) {
    const anchor = normalizeAnchor(hookAnchorBars?.[hookPosition]);
    if (!anchor) {
      return failure('outer-hook-main-bar-anchor-unresolved', { hookPosition });
    }
    const built = buildVariant({
      uMin,
      uMax,
      vMin,
      vMax,
      grade,
      barDiaMm,
      hookRule,
      hookPosition,
      anchor,
      metadata,
    });
    if (!built.ok) return built;
    variants.push(built);
  }

  const paths = variants.map((item) => item.path);
  return {
    ok: true,
    specialRequired: false,
    reason: null,
    path: paths[0],
    paths,
    source: 'main-bar-wrapped-hook-closure',
    hookRule,
    hookPairGeometry: 'MAIN_BAR_WRAPPED',
    hookPairCornerSetbackMm: null,
    hookPairCenterlineSeparationMm: paths[0]?.metadata?.hookPairCenterlineSeparationMm ?? null,
    alternateHookPosition: true,
  };
}
