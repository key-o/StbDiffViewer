/**
 * @fileoverview R10-D RC主筋の連続折曲げを実半径Arcへ置換する共通geometry kernel。
 *
 * 日建連・JSCA 2023 表2-1と§2-1注2に従い、90°未満の折曲げは、projectで
 * 実角度の内法直径が明示されていればそれを優先し、未指定なら90°フックと同じ
 * 内法直径を使用する。90°を超える任意角度は表・project overrideで一意に
 * 解ける場合だけ生成し、nearest angleには丸めない。
 *
 * @module data/extractors/rebar3d/rebarTransitionArcGeometry
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { createArc, createLine, createRebarPath, validateRebarPath } from './rebarPath.js';

const EPS = 1e-9;
const DEG_EPS = 1e-7;

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

function distance(left, right) {
  return magnitude(subtract(right, left));
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
 * 主筋の実折曲げ角度から内法直径・中心線半径を解決する。
 *
 * §2-1注2: 90°未満は構造図による。記載がない場合は表2-1の90°フックと同じ。
 * project insideDiameterTableに実角度があればそれを先に採用する。
 */
export function resolveTransitionBendGeometry({ grade, barDiaMm, bendAngleDeg } = {}) {
  const dia = Number(barDiaMm);
  const angle = Number(bendAngleDeg);
  const normalizedGrade = REBAR_STANDARD_RULES.normalizeGrade(grade);
  if (!(dia > 0) || !Number.isFinite(angle) || !normalizedGrade) {
    return failure('invalid-transition-bend-input', {
      grade: normalizedGrade,
      barDiaMm: dia,
      bendAngleDeg: angle,
    });
  }
  if (!(angle > DEG_EPS) || !(angle < 180 - DEG_EPS)) {
    return failure('transition-bend-angle-out-of-range', {
      grade: normalizedGrade,
      barDiaMm: dia,
      bendAngleDeg: angle,
    });
  }

  let resolved = REBAR_STANDARD_RULES.resolveBendInsideDiameterFactor({
    grade: normalizedGrade,
    barDiaMm: dia,
    bendAngle: angle,
  });
  let ruleAngleDeg = angle;
  let ruleSource = 'exact-angle-table';

  if (!resolved.ok && angle < 90 - DEG_EPS) {
    resolved = REBAR_STANDARD_RULES.resolveBendInsideDiameterFactor({
      grade: normalizedGrade,
      barDiaMm: dia,
      bendAngle: 90,
    });
    ruleAngleDeg = 90;
    ruleSource = 'under-90-default-to-90-table';
  }

  if (!resolved.ok || !Number.isFinite(resolved.factor)) {
    return failure('transition-bend-rule-out-of-table', {
      grade: normalizedGrade,
      barDiaMm: dia,
      bendAngleDeg: angle,
      ruleAngleDeg,
      standardId: REBAR_STANDARD_RULES.standardId,
    });
  }

  const insideDiameterMm = resolved.factor * dia;
  const centerlineRadiusMm = (insideDiameterMm + dia) / 2;
  return {
    ok: true,
    specialRequired: false,
    reason: null,
    grade: normalizedGrade,
    barDiaMm: dia,
    bendAngleDeg: angle,
    ruleAngleDeg,
    ruleSource,
    insideDiameterFactor: resolved.factor,
    insideDiameterMm,
    centerlineRadiusMm,
    standardId: resolved.standardId || REBAR_STANDARD_RULES.standardId,
  };
}

/**
 * 2本の接線がsharp cornerで交わる箇所を、接線連続Arcへ置換する。
 * incomingDirection / outgoingDirectionはいずれもpath進行方向を指定する。
 */
export function resolveRoundedTransitionCorner({
  corner,
  incomingDirection,
  outgoingDirection,
  grade,
  barDiaMm,
} = {}) {
  const c = vec3(corner);
  const incoming = normalize(vec3(incomingDirection));
  const outgoing = normalize(vec3(outgoingDirection));
  if (![c.x, c.y, c.z].every(Number.isFinite) || !incoming || !outgoing) {
    return failure('invalid-transition-corner-geometry');
  }

  const turnAngleRad = Math.acos(clamp(dot(incoming, outgoing), -1, 1));
  const turnAngleDeg = (turnAngleRad * 180) / Math.PI;
  if (!(turnAngleRad > EPS)) return failure('transition-corner-is-straight');
  if (!(turnAngleRad < Math.PI - EPS)) {
    return failure('transition-corner-180-use-return-hook-kernel');
  }

  const rule = resolveTransitionBendGeometry({
    grade,
    barDiaMm,
    bendAngleDeg: turnAngleDeg,
  });
  if (!rule.ok) return rule;

  const radius = rule.centerlineRadiusMm;
  const tangentDistanceMm = radius * Math.tan(turnAngleRad / 2);
  if (!(tangentDistanceMm > EPS) || !Number.isFinite(tangentDistanceMm)) {
    return failure('invalid-transition-tangent-distance', rule);
  }

  const incomingTangent = subtract(c, scale(incoming, tangentDistanceMm));
  const outgoingTangent = add(c, scale(outgoing, tangentDistanceMm));
  const planeNormal = normalize(cross(incoming, outgoing));
  if (!planeNormal) return failure('invalid-transition-bend-plane', rule);

  // positive sweep時のArc開始接線がincomingとなるradial direction。
  const radialStart = normalize(cross(incoming, planeNormal));
  if (!radialStart) return failure('invalid-transition-radial-start', rule);
  const center = subtract(incomingTangent, scale(radialStart, radius));
  const radialEnd = normalize(subtract(outgoingTangent, center));
  if (!radialEnd) return failure('invalid-transition-radial-end', rule);
  const expectedOutgoing = normalize(cross(planeNormal, radialEnd));
  if (!expectedOutgoing || dot(expectedOutgoing, outgoing) < 1 - 1e-7) {
    return failure('transition-arc-tangent-mismatch', rule);
  }

  const arc = createArc({
    center,
    radius,
    planeNormal,
    startDirection: radialStart,
    sweepAngleRad: turnAngleRad,
  });
  const validation = validateRebarPath(
    createRebarPath([arc], { dia: rule.barDiaMm, grade: rule.grade }),
  );
  if (!validation.ok) {
    return failure('invalid-transition-arc', { ...rule, validation });
  }

  return {
    ...rule,
    ok: true,
    specialRequired: false,
    reason: null,
    corner: c,
    incomingDirection: incoming,
    outgoingDirection: outgoing,
    incomingTangent,
    outgoingTangent,
    center,
    planeNormal,
    tangentDistanceMm,
    sweepAngleRad: turnAngleRad,
    arc,
  };
}

/**
 * 直線run -> 斜めtransition -> 直線run の2箇所を同時に丸める。
 * 戻り値pathはincoming tangentからoutgoing tangentまでで、隣接する主筋本体側の
 * 切戻し量はstartCorner/endCorner.tangentDistanceMmを使用する。
 */
export function buildDoglegTransitionPath({
  sharpStart,
  sharpEnd,
  incomingDirection,
  outgoingDirection,
  grade,
  barDiaMm,
  metadata = {},
} = {}) {
  const start = vec3(sharpStart);
  const end = vec3(sharpEnd);
  if (![start, end].flatMap((point) => Object.values(point)).every(Number.isFinite)) {
    return { ...failure('invalid-dogleg-endpoints'), path: null };
  }
  const transitionVector = subtract(end, start);
  const transitionLengthMm = magnitude(transitionVector);
  const transitionDirection = normalize(transitionVector);
  if (!(transitionLengthMm > EPS) || !transitionDirection) {
    return { ...failure('dogleg-transition-run-nonpositive'), path: null };
  }

  const startCorner = resolveRoundedTransitionCorner({
    corner: start,
    incomingDirection,
    outgoingDirection: transitionDirection,
    grade,
    barDiaMm,
  });
  if (!startCorner.ok) return { ...startCorner, path: null };

  const endCorner = resolveRoundedTransitionCorner({
    corner: end,
    incomingDirection: transitionDirection,
    outgoingDirection,
    grade,
    barDiaMm,
  });
  if (!endCorner.ok) return { ...endCorner, path: null };

  const remainingTransitionMm =
    transitionLengthMm - startCorner.tangentDistanceMm - endCorner.tangentDistanceMm;
  if (!(remainingTransitionMm > EPS)) {
    return {
      ...failure('dogleg-transition-run-too-short-for-bend-radius'),
      path: null,
      transitionLengthMm,
      startCorner,
      endCorner,
    };
  }

  const tangentRunMm = distance(startCorner.outgoingTangent, endCorner.incomingTangent);
  if (Math.abs(tangentRunMm - remainingTransitionMm) > 1e-5) {
    return {
      ...failure('dogleg-transition-tangent-run-inconsistent'),
      path: null,
      transitionLengthMm,
      remainingTransitionMm,
      tangentRunMm,
      startCorner,
      endCorner,
    };
  }

  const primitives = [
    startCorner.arc,
    createLine(startCorner.outgoingTangent, endCorner.incomingTangent),
    endCorner.arc,
  ];
  const path = createRebarPath(primitives, {
    ...metadata,
    dia: Number(barDiaMm),
    grade: startCorner.grade,
    bendGeometry: 'actual-arc',
    bendAnglesDeg: [startCorner.bendAngleDeg, endCorner.bendAngleDeg],
    bendRuleAnglesDeg: [startCorner.ruleAngleDeg, endCorner.ruleAngleDeg],
    insideDiameterMm: [startCorner.insideDiameterMm, endCorner.insideDiameterMm],
    centerlineRadiusMm: [startCorner.centerlineRadiusMm, endCorner.centerlineRadiusMm],
    standardId: startCorner.standardId || endCorner.standardId,
  });
  const validation = validateRebarPath(path);
  if (!validation.ok) {
    return {
      ...failure('invalid-dogleg-transition-path'),
      path: null,
      validation,
      startCorner,
      endCorner,
    };
  }

  return {
    ok: true,
    specialRequired: false,
    reason: null,
    path,
    validation,
    startCorner,
    endCorner,
    transitionDirection,
    transitionLengthMm,
    tangentRunMm,
  };
}
