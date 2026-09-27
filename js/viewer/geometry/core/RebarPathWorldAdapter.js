/**
 * @fileoverview anchor-local RebarPathをviewer world座標へ変換する共通adapter。
 *
 * 梁は`rotate`をlocalRollRadとして断面内座標へ別適用し、柱は
 * calculateColumnPlacementのrotationへ材軸回転を含める。両者を同じ境界で扱う。
 */

import * as THREE from 'three';
import {
  createLine,
  createRebarPath,
  rebarPathToLineSegments,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';

function axialFromAnchor(anchor, distance, length) {
  return anchor === 'end' ? length / 2 - distance : -length / 2 + distance;
}

function resolveLocalRollRad(placement) {
  const raw = placement?.localRollRad;
  if (raw === null || raw === undefined) return 0;
  if (String(raw).trim() === '') return null;
  const roll = Number(raw);
  return Number.isFinite(roll) ? roll : null;
}

function placementIsFinite(placement) {
  if (!placement || !(Number(placement.length) > 0)) return false;
  const center = placement.center;
  const rotation = placement.rotation;
  if (!center || !rotation) return false;
  return [center.x, center.y, center.z, rotation.x, rotation.y, rotation.z, rotation.w].every(
    (value) => Number.isFinite(Number(value)),
  );
}

/** anchor-local 1点をworld座標へ変換する。 */
function anchorLocalPointToWorld(point, placement, anchor) {
  if (!placementIsFinite(placement) || !['start', 'end'].includes(anchor)) return null;

  const roll = resolveLocalRollRad(placement);
  if (!Number.isFinite(roll)) return null;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const localU = Number(point?.x);
  const localV = Number(point?.y);
  const localAxial = Number(point?.z);
  if (![localU, localV, localAxial, Number(placement.length)].every(Number.isFinite)) return null;

  const u = roll === 0 ? localU : localU * cos - localV * sin;
  const v = roll === 0 ? localV : localU * sin + localV * cos;
  const axial = axialFromAnchor(anchor, localAxial, placement.length);
  const vector = new THREE.Vector3(u, v, axial);
  vector.applyQuaternion(
    new THREE.Quaternion(
      Number(placement.rotation.x),
      Number(placement.rotation.y),
      Number(placement.rotation.z),
      Number(placement.rotation.w),
    ),
  );
  vector.add(
    new THREE.Vector3(
      Number(placement.center.x),
      Number(placement.center.y),
      Number(placement.center.z),
    ),
  );
  if (![vector.x, vector.y, vector.z].every(Number.isFinite)) return null;
  return { x: vector.x, y: vector.y, z: vector.z };
}

/**
 * anchor-local RebarPathをArc chord化したworld Line RebarPathへ変換する。
 * ルール判定は行わず、座標変換とpath validationだけを担当する。
 */
export function anchorLocalPathToWorldLines(path, placement, options = {}) {
  const anchor = options.anchor || path?.metadata?.anchor;
  if (path?.metadata?.coordinateSpace !== 'anchor-local' || !['start', 'end'].includes(anchor)) {
    return null;
  }
  if (!placementIsFinite(placement) || !Number.isFinite(resolveLocalRollRad(placement)))
    return null;

  const primitives = [];
  for (const line of rebarPathToLineSegments(path, options.tessellation)) {
    const start = anchorLocalPointToWorld(line.start, placement, anchor);
    const end = anchorLocalPointToWorld(line.end, placement, anchor);
    if (!start || !end) return null;
    primitives.push(createLine(start, end));
  }
  if (!primitives.length) return null;

  const worldPath = createRebarPath(primitives, {
    ...path.metadata,
    memberId: options.memberId || path.metadata.memberId || null,
    memberTag: options.memberTag || path.metadata.memberTag || null,
    coordinateSpace: 'world',
    sourceCoordinateSpace: 'anchor-local',
  });
  return validateRebarPath(worldPath).ok ? worldPath : null;
}
