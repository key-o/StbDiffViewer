/**
 * @fileoverview R10 RC主筋フックの実折曲げ中心線を生成する。
 *
 * 日建連・JSCA 2023 表2-1の折曲げ内法直径と余長を、既存の共通ルール
 * `REBAR_STANDARD_RULES` から解決し、Line -> Arc -> Line の接線連続な
 * RebarPathへ変換する。
 *
 * このモジュールの座標系は部材端基準の anchor-local とする。
 * x=u、y=v、z=部材端から内向きを正とした距離 [mm]。
 *
 * @module data/extractors/rebar3d/rebarHookGeometry
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { createArc, createLine, createRebarPath, validateRebarPath } from './rebarPath.js';

const EPS = 1e-9;
const ANGLE_TOLERANCE_RAD = 1e-7;

function finite(value) {
  return Number.isFinite(Number(value));
}

function vec3(value) {
  return {
    x: Number(value?.x),
    y: Number(value?.y),
    z: Number(value?.z),
  };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(value, factor) {
  return { x: value.x * factor, y: value.y * factor, z: value.z * factor };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function magnitude(value) {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize(value) {
  const length = magnitude(value);
  if (!(length > EPS)) return null;
  return scale(value, 1 / length);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function failure(reason, extra = {}) {
  return {
    ...extra,
    ok: false,
    specialRequired: true,
    reason,
  };
}

/**
 * 表2-1からフックの内法直径・中心線半径・最小余長を解決する。
 * 表外径・表外鋼種・許容されない曲げ角度は近似せずSPECIALとする。
 */
export function resolveHookBendGeometry({
  grade,
  barDiaMm,
  bendAngleDeg,
  tailLengthMm = null,
} = {}) {
  const dia = Number(barDiaMm);
  const angle = Number(bendAngleDeg);
  const normalizedGrade = REBAR_STANDARD_RULES.normalizeGrade(grade);
  if (!(dia > 0) || !Number.isFinite(angle) || !normalizedGrade) {
    return failure('invalid-hook-input', {
      grade: normalizedGrade,
      barDiaMm: dia,
      angleDeg: angle,
    });
  }

  const inside = REBAR_STANDARD_RULES.resolveBendInsideDiameterFactor({
    grade: normalizedGrade,
    barDiaMm: dia,
    bendAngle: angle,
  });
  const tailFactor = REBAR_STANDARD_RULES.resolveHookTailFactor(angle);
  if (!inside.ok || !Number.isFinite(tailFactor)) {
    return failure('hook-rule-out-of-table', {
      grade: normalizedGrade,
      barDiaMm: dia,
      angleDeg: angle,
      insideDiameterFactor: inside.factor ?? null,
      tailDiaFactor: Number.isFinite(tailFactor) ? tailFactor : null,
      standardId: REBAR_STANDARD_RULES.standardId,
    });
  }

  const insideDiameterMm = inside.factor * dia;
  const centerlineRadiusMm = (insideDiameterMm + dia) / 2;
  const minimumTailLengthMm = tailFactor * dia;
  const requestedTailLengthMm = Number(tailLengthMm);
  const effectiveTailLengthMm = Number.isFinite(requestedTailLengthMm)
    ? Math.max(minimumTailLengthMm, requestedTailLengthMm)
    : minimumTailLengthMm;

  return {
    ok: true,
    specialRequired: false,
    reason: null,
    standardId: REBAR_STANDARD_RULES.standardId,
    source: 'REBAR_STANDARD_RULES',
    grade: normalizedGrade,
    barDiaMm: dia,
    angleDeg: angle,
    insideDiameterFactor: inside.factor,
    insideDiameterMm,
    centerlineRadiusMm,
    tailDiaFactor: tailFactor,
    minimumTailLengthMm,
    tailLengthMm: effectiveTailLengthMm,
  };
}

/**
 * 部材端基準の鋭角交点を、実曲げ半径を持つ接線Arcへ置換する。
 *
 * `at` は従来の sharp corner の部材端からの距離で、通常の梁柱定着では
 * 柱内へ伸びるため負値となる。incoming側の接点が部材内へ入り込む場合は、
 * 梁本体のtrimが必要になるためR10-Aではfail-closedとする。
 *
 * 180°フックは単一sharp cornerのfilletでは表せないため、R10-Aではpath生成対象外。
 */
export function buildAnchoredHookPath({
  anchor,
  at,
  u,
  v,
  barDiaMm,
  grade,
  bendAngleDeg = 90,
  outgoingDirection,
  tailLengthMm = null,
  allowIncomingTangentInsideMember = false,
  metadata = {},
} = {}) {
  const rule = resolveHookBendGeometry({ grade, barDiaMm, bendAngleDeg, tailLengthMm });
  if (!rule.ok) return { ...rule, path: null };
  if (!['start', 'end'].includes(anchor)) {
    return { ...failure('invalid-anchor', rule), path: null };
  }
  if (![at, u, v].every(finite)) {
    return { ...failure('non-finite-hook-position', rule), path: null };
  }

  const angleRad = (rule.angleDeg * Math.PI) / 180;
  if (!(angleRad > EPS) || !(angleRad < Math.PI - EPS)) {
    return { ...failure('hook-angle-path-not-supported', rule), path: null };
  }

  const rayIncoming = { x: 0, y: 0, z: 1 };
  const rayOutgoing = normalize(vec3(outgoingDirection));
  if (!rayOutgoing) return { ...failure('invalid-outgoing-direction', rule), path: null };

  const includedAngleRad = Math.acos(clamp(dot(rayIncoming, rayOutgoing), -1, 1));
  const actualBendAngleRad = Math.PI - includedAngleRad;
  if (
    !(includedAngleRad > EPS) ||
    !(includedAngleRad < Math.PI - EPS) ||
    Math.abs(actualBendAngleRad - angleRad) > ANGLE_TOLERANCE_RAD
  ) {
    return { ...failure('bend-angle-direction-mismatch', rule), path: null };
  }

  const radius = rule.centerlineRadiusMm;
  const tangentDistanceMm = radius / Math.tan(includedAngleRad / 2);
  const sharpCorner = { x: Number(u), y: Number(v), z: Number(at) };
  const incomingTangent = add(sharpCorner, scale(rayIncoming, tangentDistanceMm));
  const outgoingTangent = add(sharpCorner, scale(rayOutgoing, tangentDistanceMm));

  // 通常は梁本体内へ接点が入るケースを拒否する。R12-Yなど、呼出側が
  // 同一identityのmain barをincomingTangentまで明示trimする場合だけ許可する。
  if (incomingTangent.z > EPS && allowIncomingTangentInsideMember !== true) {
    return {
      ...failure('incoming-tangent-inside-member', rule),
      path: null,
      sharpCorner,
      incomingTangent,
      tangentDistanceMm,
    };
  }

  const bisector = normalize(add(rayIncoming, rayOutgoing));
  if (!bisector) return { ...failure('invalid-bend-bisector', rule), path: null };
  const centerDistanceMm = radius / Math.sin(includedAngleRad / 2);
  const center = add(sharpCorner, scale(bisector, centerDistanceMm));
  const radialStart = normalize(subtract(incomingTangent, center));
  const radialEnd = normalize(subtract(outgoingTangent, center));
  if (!radialStart || !radialEnd) {
    return { ...failure('invalid-bend-radial', rule), path: null };
  }
  const planeNormal = normalize(cross(radialStart, radialEnd));
  if (!planeNormal) return { ...failure('invalid-bend-plane', rule), path: null };
  const sweepAngleRad = Math.acos(clamp(dot(radialStart, radialEnd), -1, 1));
  if (Math.abs(sweepAngleRad - angleRad) > ANGLE_TOLERANCE_RAD) {
    return { ...failure('resolved-sweep-mismatch', rule), path: null };
  }

  const tailEnd = add(outgoingTangent, scale(rayOutgoing, rule.tailLengthMm));
  const primitives = [];
  const memberEnd = { x: Number(u), y: Number(v), z: 0 };
  if (incomingTangent.z < -EPS) primitives.push(createLine(memberEnd, incomingTangent));
  primitives.push(
    createArc({
      center,
      radius,
      planeNormal,
      startDirection: radialStart,
      sweepAngleRad,
    }),
  );
  primitives.push(createLine(outgoingTangent, tailEnd));

  const path = createRebarPath(primitives, {
    ...metadata,
    dia: rule.barDiaMm,
    grade: rule.grade,
    anchor,
    coordinateSpace: 'anchor-local',
    source: metadata.source || 'beam-r10-hook',
    ruleId: metadata.ruleId || 'R10',
    bendAngleDeg: rule.angleDeg,
    sharpCornerAtMm: Number(at),
    insideDiameterMm: rule.insideDiameterMm,
    centerlineRadiusMm: rule.centerlineRadiusMm,
    hookTailLengthMm: rule.tailLengthMm,
    hookTailMinimumMm: rule.minimumTailLengthMm,
    mainBarTrimRequiredMm: incomingTangent.z > EPS ? incomingTangent.z : 0,
    incomingTangentInsideMember: incomingTangent.z > EPS,
  });
  const validation = validateRebarPath(path);
  if (!validation.ok) {
    return {
      ...failure('invalid-generated-hook-path', rule),
      path: null,
      validation,
    };
  }

  return {
    ...rule,
    path,
    validation,
    sharpCorner,
    incomingTangent,
    outgoingTangent,
    center,
    tangentDistanceMm,
    sweepAngleRad,
  };
}
