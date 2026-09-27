/**
 * @fileoverview R11 帯筋・あばら筋・中子筋・幅止筋の実折曲げ中心線カーネル。
 *
 * 日建連・JSCA 2023 表2-1の折曲げ内法直径と余長を既存の
 * `REBAR_STANDARD_RULES` から解決し、矩形閉鎖筋および開放補助筋を
 * Line / Arc の接線連続な RebarPath として表す。
 *
 * 座標系は断面ローカル座標で x=u, y=v, z=0 とする。
 * welded closure は hook closure と別sourceで生成し、相互にfallbackしない。
 */

import { resolveHookBendGeometry } from './rebarHookGeometry.js';
import { resolveRoundedTransitionCorner } from './rebarTransitionArcGeometry.js';
import {
  createArc,
  createLine,
  createRebarPath,
  getPrimitiveEnd,
  getPrimitiveStart,
  validateRebarPath,
} from './rebarPath.js';

const EPS = 1e-7;
const HOOK_ANGLES = new Set([90, 135, 180]);

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

function rotateAroundAxis(vector, axis, angle) {
  const n = normalize(axis);
  if (!n) return vec(NaN, NaN, NaN);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return add(
    add(scale(vector, cos), scale(cross(n, vector), sin)),
    scale(n, dot(n, vector) * (1 - cos)),
  );
}

function failure(reason, extra = {}) {
  return { ok: false, specialRequired: true, reason, ...extra, path: null, paths: [] };
}

function lineDirection(line) {
  return normalize(subtract(line.end, line.start));
}

function arcBasis(arc) {
  const normal = normalize(arc.planeNormal);
  const start = normalize(arc.startDirection);
  if (!normal || !start) return null;
  return { normal, start };
}

function primitiveTangent(primitive, atEnd = false) {
  if (primitive?.type === 'line') return lineDirection(primitive);
  if (primitive?.type !== 'arc') return null;
  const basis = arcBasis(primitive);
  if (!basis) return null;
  const radial = atEnd
    ? rotateAroundAxis(basis.start, basis.normal, primitive.sweepAngleRad)
    : basis.start;
  const sign = primitive.sweepAngleRad >= 0 ? 1 : -1;
  return normalize(scale(cross(basis.normal, radial), sign));
}

/**
 * RebarPathの位置連続に加えて接線連続も検証する。
 */
export function validateTangentContinuousRebarPath(path, options = {}) {
  const tolerance = Number(options.tolerance) || 1e-6;
  const validation = validateRebarPath(path, options);
  const errors = [...validation.errors];
  const primitives = path?.primitives || [];

  for (let index = 1; index < primitives.length; index += 1) {
    const previous = primitives[index - 1];
    const current = primitives[index];
    const previousEnd = getPrimitiveEnd(previous);
    const currentStart = getPrimitiveStart(current);
    if (distance(previousEnd, currentStart) > tolerance) continue;
    const left = primitiveTangent(previous, true);
    const right = primitiveTangent(current, false);
    if (!left || !right || dot(left, right) < 1 - tolerance) {
      errors.push(`primitive-${index}:tangent-discontinuous`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function resolveHookRule({ grade, barDiaMm, hookAngleDeg, tailLengthMm, allowConditional90 }) {
  const angle = Number(hookAngleDeg);
  if (!HOOK_ANGLES.has(angle)) {
    return failure('unsupported-shear-hook-angle', { hookAngleDeg: angle });
  }
  if (angle === 90 && allowConditional90 !== true) {
    return failure('conditional-90-hook-not-authorized', { hookAngleDeg: angle });
  }
  return resolveHookBendGeometry({
    grade,
    barDiaMm,
    bendAngleDeg: angle,
    tailLengthMm,
  });
}

function appendLine(primitives, start, end) {
  if (distance(start, end) <= EPS) return;
  primitives.push(createLine(start, end));
}

function buildTerminalFillet({
  position,
  corner,
  mainDirection,
  inwardDirection,
  hookRule,
  grade,
  barDiaMm,
}) {
  const main = normalize(mainDirection);
  const inward = normalize(inwardDirection);
  if (!main || !inward || Math.abs(dot(main, inward)) > 1e-6) {
    return failure('invalid-terminal-hook-directions');
  }
  const angleRad = (hookRule.angleDeg * Math.PI) / 180;

  if (hookRule.angleDeg === 180) {
    const radius = hookRule.centerlineRadiusMm;
    const normal = normalize(cross(scale(inward, -1), main));
    if (!normal) return failure('invalid-return-hook-plane', hookRule);

    if (position === 'start') {
      const mainTangent = add(corner, scale(main, radius));
      const center = add(mainTangent, scale(inward, radius));
      const tailTangent = add(mainTangent, scale(inward, 2 * radius));
      const free = add(tailTangent, scale(main, hookRule.tailLengthMm));
      return {
        ok: true,
        start: free,
        end: mainTangent,
        primitives: [
          createLine(free, tailTangent),
          createArc({
            center,
            radius,
            planeNormal: normal,
            startDirection: inward,
            sweepAngleRad: Math.PI,
          }),
        ],
      };
    }

    const mainTangent = subtract(corner, scale(main, radius));
    const center = add(mainTangent, scale(inward, radius));
    const tailTangent = add(mainTangent, scale(inward, 2 * radius));
    const free = subtract(tailTangent, scale(main, hookRule.tailLengthMm));
    return {
      ok: true,
      start: mainTangent,
      end: free,
      primitives: [
        createArc({
          center,
          radius,
          planeNormal: normal,
          startDirection: scale(inward, -1),
          sweepAngleRad: Math.PI,
        }),
        createLine(tailTangent, free),
      ],
    };
  }

  if (position === 'start') {
    const incoming = normalize(
      add(scale(main, Math.cos(angleRad)), scale(inward, -Math.sin(angleRad))),
    );
    if (!incoming) return failure('invalid-start-hook-direction');
    const rounded = resolveRoundedTransitionCorner({
      corner,
      incomingDirection: incoming,
      outgoingDirection: main,
      grade,
      barDiaMm,
    });
    if (!rounded.ok) return failure(rounded.reason, rounded);
    const free = subtract(rounded.incomingTangent, scale(incoming, hookRule.tailLengthMm));
    return {
      ok: true,
      start: free,
      end: rounded.outgoingTangent,
      primitives: [createLine(free, rounded.incomingTangent), rounded.arc],
    };
  }

  const outgoing = normalize(
    add(scale(main, Math.cos(angleRad)), scale(inward, Math.sin(angleRad))),
  );
  if (!outgoing) return failure('invalid-end-hook-direction');
  const rounded = resolveRoundedTransitionCorner({
    corner,
    incomingDirection: main,
    outgoingDirection: outgoing,
    grade,
    barDiaMm,
  });
  if (!rounded.ok) return failure(rounded.reason, rounded);
  const free = add(rounded.outgoingTangent, scale(outgoing, hookRule.tailLengthMm));
  return {
    ok: true,
    start: rounded.incomingTangent,
    end: free,
    primitives: [rounded.arc, createLine(rounded.outgoingTangent, free)],
  };
}

function roundedCorner({ corner, incoming, outgoing, grade, barDiaMm }) {
  const result = resolveRoundedTransitionCorner({
    corner,
    incomingDirection: incoming,
    outgoingDirection: outgoing,
    grade,
    barDiaMm,
  });
  return result.ok ? result : failure(result.reason, result);
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

/**
 * 135°フック閉鎖は、2端を同一中心線へ重ねず、同じ角部の隣接2辺へ1dだけ離して配置する。
 * 135°の余長方向は45°なので、各辺方向のsetbackを d/sqrt(2) とすると、
 * 2本の余長中心線間隔がちょうど1dとなり、実径mesh同士が重ならない。
 *
 * 外周loop自体はhoopPlacementで主筋外周へ接する位置に解かれているため、
 * このsplitにより角主筋を挟み込む実配筋に近いhook topologyとなる。
 */
function pairedHookCorners(traversal, hookRule, barDiaMm) {
  if (hookRule?.angleDeg !== 135) {
    return {
      start: traversal.closure,
      end: traversal.closure,
      cornerSetbackMm: 0,
      centerlineSeparationMm: 0,
      geometry: 'SHARED_CORNER',
    };
  }
  const centerlineSeparationMm = Number(barDiaMm);
  const cornerSetbackMm = centerlineSeparationMm / Math.SQRT2;
  return {
    start: add(traversal.closure, scale(traversal.startDirection, cornerSetbackMm)),
    end: subtract(traversal.closure, scale(traversal.endDirection, cornerSetbackMm)),
    cornerSetbackMm,
    centerlineSeparationMm,
    geometry: 'ADJACENT_LEG_OFFSET',
  };
}

function finalizePath(primitives, metadata, { requireClosed = false } = {}) {
  const path = createRebarPath(primitives, metadata);
  const validation = validateTangentContinuousRebarPath(path);
  if (!validation.ok) return failure('invalid-shear-rebar-path', { validation });
  if (
    requireClosed &&
    distance(getPrimitiveStart(primitives[0]), getPrimitiveEnd(primitives.at(-1))) > 1e-6
  ) {
    return failure('welded-loop-not-closed');
  }
  return { ok: true, specialRequired: false, reason: null, path, validation };
}

function buildHookedRectVariant({
  uMin,
  uMax,
  vMin,
  vMax,
  grade,
  barDiaMm,
  hookRule,
  hookPosition,
  metadata,
}) {
  const traversal = rectTraversal(uMin, uMax, vMin, vMax, hookPosition);
  const hookCorners = pairedHookCorners(traversal, hookRule, barDiaMm);
  const startHook = buildTerminalFillet({
    position: 'start',
    corner: hookCorners.start,
    mainDirection: traversal.startDirection,
    inwardDirection: traversal.startInward,
    hookRule,
    grade,
    barDiaMm,
  });
  if (!startHook.ok) return startHook;
  const endHook = buildTerminalFillet({
    position: 'end',
    corner: hookCorners.end,
    mainDirection: traversal.endDirection,
    inwardDirection: traversal.endInward,
    hookRule,
    grade,
    barDiaMm,
  });
  if (!endHook.ok) return endHook;

  const corners = traversal.corners.map((item) =>
    roundedCorner({ ...item, corner: item.point, grade, barDiaMm }),
  );
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

  return finalizePath(primitives, {
    ...metadata,
    dia: Number(barDiaMm),
    grade: hookRule.grade,
    bendGeometry: 'actual-arc',
    closureType: 'HOOK',
    hookAngleDeg: hookRule.angleDeg,
    hookPosition,
    hookTailLengthMm: hookRule.tailLengthMm,
    hookTailMinimumMm: hookRule.minimumTailLengthMm,
    insideDiameterMm: hookRule.insideDiameterMm,
    centerlineRadiusMm: hookRule.centerlineRadiusMm,
    hookPairGeometry: hookCorners.geometry,
    hookPairCornerSetbackMm: hookCorners.cornerSetbackMm,
    hookPairCenterlineSeparationMm: hookCorners.centerlineSeparationMm,
    standardId: hookRule.standardId,
  });
}

function buildWeldedRect({ uMin, uMax, vMin, vMax, grade, barDiaMm, metadata }) {
  const defs = [
    { point: vec(uMax, vMax), incoming: vec(1, 0), outgoing: vec(0, -1) },
    { point: vec(uMax, vMin), incoming: vec(0, -1), outgoing: vec(-1, 0) },
    { point: vec(uMin, vMin), incoming: vec(-1, 0), outgoing: vec(0, 1) },
    { point: vec(uMin, vMax), incoming: vec(0, 1), outgoing: vec(1, 0) },
  ];
  const corners = defs.map((item) =>
    roundedCorner({ ...item, corner: item.point, grade, barDiaMm }),
  );
  const failed = corners.find((item) => !item.ok);
  if (failed) return failed;

  const primitives = [];
  let cursor = corners[0].outgoingTangent;
  for (let index = 1; index < corners.length; index += 1) {
    appendLine(primitives, cursor, corners[index].incomingTangent);
    primitives.push(corners[index].arc);
    cursor = corners[index].outgoingTangent;
  }
  appendLine(primitives, cursor, corners[0].incomingTangent);
  primitives.push(corners[0].arc);

  return finalizePath(
    primitives,
    {
      ...metadata,
      dia: Number(barDiaMm),
      grade: corners[0].grade,
      bendGeometry: 'actual-arc',
      closureType: 'WELDED',
      hookAngleDeg: null,
      insideDiameterMm: corners[0].insideDiameterMm,
      centerlineRadiusMm: corners[0].centerlineRadiusMm,
      standardId: corners[0].standardId,
    },
    { requireClosed: true },
  );
}

/**
 * 矩形帯筋・あばら筋の外周を実曲げ形状へ変換する。
 * HOOKは対角2箇所を交互配置用variantとして返し、WELDEDは閉鎖Arc loopを返す。
 */
export function buildRoundedRectShearPath({
  uMin,
  uMax,
  vMin,
  vMax,
  grade,
  barDiaMm,
  closureType = 'HOOK',
  hookAngleDeg = 135,
  tailLengthMm = null,
  allowConditional90 = false,
  metadata = {},
} = {}) {
  const bounds = [uMin, uMax, vMin, vMax, barDiaMm].map(Number);
  if (!bounds.every(Number.isFinite) || !(uMax > uMin) || !(vMax > vMin) || !(barDiaMm > 0)) {
    return failure('invalid-rect-shear-geometry');
  }

  const closure = String(closureType || 'HOOK').toUpperCase();
  if (closure === 'WELDED') {
    const welded = buildWeldedRect({ uMin, uMax, vMin, vMax, grade, barDiaMm, metadata });
    return welded.ok ? { ...welded, paths: [welded.path], source: 'welded-closure' } : welded;
  }
  if (closure !== 'HOOK')
    return failure('unsupported-shear-closure-type', { closureType: closure });

  const hookRule = resolveHookRule({
    grade,
    barDiaMm,
    hookAngleDeg,
    tailLengthMm,
    allowConditional90,
  });
  if (!hookRule.ok) return { ...hookRule, path: null, paths: [] };

  const variants = ['TOP_RIGHT', 'BOTTOM_LEFT'].map((hookPosition) =>
    buildHookedRectVariant({
      uMin,
      uMax,
      vMin,
      vMax,
      grade,
      barDiaMm,
      hookRule,
      hookPosition,
      metadata,
    }),
  );
  const failed = variants.find((item) => !item.ok);
  if (failed) return failed;
  const paths = variants.map((item) => item.path);
  return {
    ok: true,
    specialRequired: false,
    reason: null,
    path: paths[0],
    paths,
    source: 'hook-closure',
    hookRule,
    hookPairGeometry: paths[0]?.metadata?.hookPairGeometry ?? null,
    hookPairCornerSetbackMm: paths[0]?.metadata?.hookPairCornerSetbackMm ?? null,
    hookPairCenterlineSeparationMm: paths[0]?.metadata?.hookPairCenterlineSeparationMm ?? null,
    alternateHookPosition: true,
  };
}

function tieDirections(axis, sideSign) {
  if (axis === 'v') {
    return {
      main: vec(0, 1),
      inwardStart: vec(sideSign, 0),
      inwardEnd: vec(sideSign, 0),
    };
  }
  return {
    main: vec(1, 0),
    inwardStart: vec(0, sideSign),
    inwardEnd: vec(0, sideSign),
  };
}

function tieEndpoints(tie) {
  if (tie?.axis === 'v') {
    const u = Number(tie.u);
    const vMin = Number(tie.vMin);
    const vMax = Number(tie.vMax);
    if (![u, vMin, vMax].every(Number.isFinite) || !(vMax > vMin)) return null;
    return { start: vec(u, vMin), end: vec(u, vMax), axis: 'v' };
  }
  const uMin = Number(tie?.uMin);
  const uMax = Number(tie?.uMax);
  const v = Number(tie?.v);
  if (![uMin, uMax, v].every(Number.isFinite) || !(uMax > uMin)) return null;
  return { start: vec(uMin, v), end: vec(uMax, v), axis: 'u' };
}

function buildHookedTieVariant({ tie, grade, barDiaMm, hookRule, sideSign, metadata }) {
  const endpoints = tieEndpoints(tie);
  if (!endpoints) return failure('invalid-open-tie-geometry');
  const directions = tieDirections(endpoints.axis, sideSign);
  const startHook = buildTerminalFillet({
    position: 'start',
    corner: endpoints.start,
    mainDirection: directions.main,
    inwardDirection: directions.inwardStart,
    hookRule,
    grade,
    barDiaMm,
  });
  if (!startHook.ok) return startHook;
  const endHook = buildTerminalFillet({
    position: 'end',
    corner: endpoints.end,
    mainDirection: directions.main,
    inwardDirection: directions.inwardEnd,
    hookRule,
    grade,
    barDiaMm,
  });
  if (!endHook.ok) return endHook;
  if (distance(startHook.end, endHook.start) <= EPS) {
    return failure('open-tie-too-short-for-bend-radius');
  }

  const primitives = [...startHook.primitives];
  appendLine(primitives, startHook.end, endHook.start);
  primitives.push(...endHook.primitives);
  return finalizePath(primitives, {
    ...metadata,
    dia: Number(barDiaMm),
    grade: hookRule.grade,
    bendGeometry: 'actual-arc',
    closureType: 'OPEN_HOOKED',
    hookAngleDeg: hookRule.angleDeg,
    hookSideSign: sideSign,
    hookTailLengthMm: hookRule.tailLengthMm,
    insideDiameterMm: hookRule.insideDiameterMm,
    centerlineRadiusMm: hookRule.centerlineRadiusMm,
    standardId: hookRule.standardId,
  });
}

/**
 * 中子筋・副帯筋・幅止筋などの開放直線中心線へ両端フックを付与する。
 */
export function buildHookedOpenTiePath({
  tie,
  grade,
  barDiaMm = tie?.dia,
  hookAngleDeg = 135,
  tailLengthMm = null,
  allowConditional90 = false,
  metadata = {},
} = {}) {
  const dia = Number(barDiaMm);
  if (!(dia > 0)) return failure('invalid-open-tie-diameter');
  const hookRule = resolveHookRule({
    grade,
    barDiaMm: dia,
    hookAngleDeg,
    tailLengthMm,
    allowConditional90,
  });
  if (!hookRule.ok) return { ...hookRule, path: null, paths: [] };

  const variants = [1, -1].map((sideSign) =>
    buildHookedTieVariant({ tie, grade, barDiaMm: dia, hookRule, sideSign, metadata }),
  );
  const failed = variants.find((item) => !item.ok);
  if (failed) return failed;
  const paths = variants.map((item) => item.path);
  return {
    ok: true,
    specialRequired: false,
    reason: null,
    path: paths[0],
    paths,
    hookRule,
    alternateHookSide: true,
  };
}
