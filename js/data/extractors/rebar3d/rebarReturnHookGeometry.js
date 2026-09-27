/**
 * @fileoverview R10-B 最上階柱頭180°フックの実折曲げ中心線カーネル。
 *
 * 日建連・JSCA 2023 表2-1から解決した中心線半径を使い、
 * 柱頭四隅主筋の180°フックを Arc -> Line のUターン中心線として表す。
 *
 * 座標系は部材端基準の anchor-local とする。
 * x=u、y=v、z=部材端から内向きを正とした距離 [mm]。
 * `apexAtMm` はフック最外端（コンクリート面に最も近い中心線位置）の
 * 部材端からの距離である。
 *
 * @module data/extractors/rebar3d/rebarReturnHookGeometry
 */

import { resolveHookBendGeometry } from './rebarHookGeometry.js';
import { createArc, createLine, createRebarPath, validateRebarPath } from './rebarPath.js';

const EPS = 1e-9;

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

function failure(reason, extra = {}) {
  return {
    ...extra,
    ok: false,
    specialRequired: true,
    reason,
    path: null,
  };
}

/**
 * 180°Uターンフックを anchor-local RebarPath として生成する。
 *
 * incoming主筋は元の(u,v)位置を材端側へ進み、最外端 apexAtMm でUターンして
 * `returnDirection` 側へ中心線直径 2R だけ移動し、部材内向きへ余長を戻す。
 *
 * main bar本体は incoming tangent までで止める必要があるため、
 * `requiredMainBarTrimMm = apexAtMm + R` を返す。production側でこのtrimを
 * 原子的に適用できるまでは、このpathだけを単独生成してはならない。
 */
export function buildAnchoredReturnHookPath({
  anchor = 'end',
  apexAtMm,
  u,
  v,
  barDiaMm,
  grade,
  returnDirection,
  tailLengthMm = null,
  metadata = {},
} = {}) {
  const rule = resolveHookBendGeometry({
    grade,
    barDiaMm,
    bendAngleDeg: 180,
    tailLengthMm,
  });
  if (!rule.ok) return failure(rule.reason || 'return-hook-rule-unresolved', rule);
  if (!['start', 'end'].includes(anchor)) return failure('invalid-anchor', rule);
  if (![apexAtMm, u, v].every(finite)) return failure('non-finite-return-hook-position', rule);

  const returnDir = normalize(vec3(returnDirection));
  if (!returnDir || Math.abs(returnDir.z) > 1e-7) {
    return failure('invalid-return-direction', rule);
  }

  const radius = rule.centerlineRadiusMm;
  const axial = { x: 0, y: 0, z: 1 };
  const original = {
    x: Number(u),
    y: Number(v),
    z: Number(apexAtMm) + radius,
  };
  const center = add(original, scale(returnDir, radius));
  const returnTangent = add(original, scale(returnDir, 2 * radius));
  const tailEnd = add(returnTangent, scale(axial, rule.tailLengthMm));
  const radialStart = scale(returnDir, -1);
  const planeNormal = normalize(cross(returnDir, axial));
  if (!planeNormal) return failure('invalid-return-hook-plane', rule);

  // start tangent = -axial（材端側）、end tangent = +axial（部材内側）となる向き。
  const startTangent = normalize(cross(planeNormal, radialStart));
  if (!startTangent || dot(startTangent, axial) > -1 + 1e-7) {
    return failure('invalid-return-hook-start-tangent', rule);
  }

  const path = createRebarPath(
    [
      createArc({
        center,
        radius,
        planeNormal,
        startDirection: radialStart,
        sweepAngleRad: Math.PI,
      }),
      createLine(returnTangent, tailEnd),
    ],
    {
      ...metadata,
      dia: rule.barDiaMm,
      grade: rule.grade,
      anchor,
      coordinateSpace: 'anchor-local',
      source: metadata.source || 'column-r10-top-180-hook',
      ruleId: metadata.ruleId || 'R10-B',
      bendAngleDeg: 180,
      apexAtMm: Number(apexAtMm),
      insideDiameterMm: rule.insideDiameterMm,
      centerlineRadiusMm: radius,
      returnOffsetMm: 2 * radius,
      hookTailLengthMm: rule.tailLengthMm,
      hookTailMinimumMm: rule.minimumTailLengthMm,
      requiredMainBarTrimMm: Number(apexAtMm) + radius,
    },
  );
  const validation = validateRebarPath(path);
  if (!validation.ok) {
    return failure('invalid-generated-return-hook-path', {
      ...rule,
      validation,
    });
  }

  return {
    ...rule,
    path,
    validation,
    center,
    incomingTangent: original,
    returnTangent,
    tailEnd,
    returnOffsetMm: 2 * radius,
    requiredMainBarTrimMm: Number(apexAtMm) + radius,
  };
}
