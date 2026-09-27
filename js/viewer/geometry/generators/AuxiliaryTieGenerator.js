/**
 * @fileoverview RC柱・梁の中子筋／幅止筋など、閉ループではない補助せん断補強筋の3D描画。
 *
 * hoopPlacement が返す segment.ties / auxiliarySegments の断面内中心線を、
 * 既存の帯筋・あばら筋と同じ材軸位置へ載せる。フック形状はR11で扱うため、
 * R4では断面内の直線中心線だけを描画する。
 */

import * as THREE from 'three';
import { calculateBeamPlacement, calculateColumnPlacement } from '../core/GeometryCalculator.js';
import { HOOP_RENDER_OPTIONS } from '../../../constants/rebarPlacementRules.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('viewer:rebar-auxiliary-tie');

let unitBarGeometry = null;
let sharedMaterial = null;

function getUnitBarGeometry() {
  if (!unitBarGeometry) {
    unitBarGeometry = new THREE.CylinderGeometry(
      0.5,
      0.5,
      1,
      HOOP_RENDER_OPTIONS.radialSegments,
      1,
      false,
    );
    unitBarGeometry.rotateX(Math.PI / 2);
  }
  return unitBarGeometry;
}

function getSharedMaterial() {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshLambertMaterial({ color: HOOP_RENDER_OPTIONS.colorHex });
  }
  return sharedMaterial;
}

const LINE_QUATERNIONS = {
  u: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
  v: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
};

function resolveColumnPlacement(column, nodes) {
  const bottom = nodes?.get(String(column.id_node_bottom));
  const top = nodes?.get(String(column.id_node_top));
  if (!bottom || !top) return null;

  const rollAngleDegrees = Number(column.rotate ?? column.angle ?? 0) || 0;
  const placement = calculateColumnPlacement(
    { x: bottom.x, y: bottom.y, z: bottom.z },
    { x: top.x, y: top.y, z: top.z },
    {
      bottomOffset: {
        x: Number(column.offset_bottom_X || 0),
        y: Number(column.offset_bottom_Y || 0),
        z: Number(column.offset_bottom_Z || 0),
      },
      topOffset: {
        x: Number(column.offset_top_X || 0),
        y: Number(column.offset_top_Y || 0),
        z: Number(column.offset_top_Z || 0),
      },
      rollAngle: (rollAngleDegrees * Math.PI) / 180,
    },
  );
  return { ...placement, localRollRad: 0 };
}

function resolveBeamPlacement(beam, nodes, layout) {
  const start = nodes?.get(String(beam.id_node_start));
  const end = nodes?.get(String(beam.id_node_end));
  if (!start || !end) return null;

  const rollAngleDegrees = Number(beam.rotate ?? beam.angle ?? 0) || 0;
  const placement = calculateBeamPlacement(
    { x: start.x, y: start.y, z: start.z },
    { x: end.x, y: end.y, z: end.z },
    {
      startOffset: {
        x: Number(beam.offset_start_X || 0),
        y: Number(beam.offset_start_Y || 0),
        z: Number(beam.offset_start_Z || 0),
      },
      endOffset: {
        x: Number(beam.offset_end_X || 0),
        y: Number(beam.offset_end_Y || 0),
        z: Number(beam.offset_end_Z || 0),
      },
      placementMode: 'top-aligned',
      sectionHeight: layout.depth || 0,
    },
  );
  return { ...placement, localRollRad: (rollAngleDegrees * Math.PI) / 180 };
}

function spreadPositions(placementLength, segment) {
  if (Number.isFinite(segment?.positionRatio)) {
    return [placementLength * (segment.positionRatio - 0.5)];
  }

  const startRatio = Number(segment?.startRatio);
  const endRatio = Number(segment?.endRatio);
  const pitch = Number(segment?.pitch);
  if (
    !Number.isFinite(startRatio) ||
    !Number.isFinite(endRatio) ||
    !Number.isFinite(pitch) ||
    pitch <= 0 ||
    endRatio <= startRatio
  ) {
    return [];
  }

  const start = placementLength * (startRatio - 0.5);
  const length = placementLength * (endRatio - startRatio);
  const count = Math.max(1, Math.floor(length / pitch));
  const spread = (count - 1) * pitch;
  const first = start + (length - spread) / 2;
  return Array.from({ length: count }, (_, index) => first + index * pitch);
}

function normalizedAuxiliarySegment(layout, segment) {
  if (
    !layout?.memberSpecific ||
    !Number.isFinite(layout.memberPlanLengthMm) ||
    !(layout.memberPlanLengthMm > 0) ||
    !Number.isFinite(layout.startFaceMm) ||
    !Number.isFinite(layout.endFaceMm) ||
    !(layout.endFaceMm > layout.startFaceMm)
  ) {
    return segment;
  }

  const clearLength = layout.endFaceMm - layout.startFaceMm;
  return {
    ...segment,
    startRatio:
      (layout.startFaceMm + clearLength * Number(segment.startRatio || 0)) /
      layout.memberPlanLengthMm,
    endRatio:
      (layout.startFaceMm + clearLength * Number(segment.endRatio ?? 1)) /
      layout.memberPlanLengthMm,
  };
}

function pushTieMatrix(tie, axialPos, placement, memberMatrix, matricesByDia) {
  const dia = Number(tie?.dia);
  if (!(dia > 0)) return false;

  const axis = tie.axis === 'v' ? 'v' : 'u';
  let centerU;
  let centerV;
  let length;
  if (axis === 'u') {
    const uMin = Number(tie.uMin);
    const uMax = Number(tie.uMax);
    const v = Number(tie.v);
    if (!Number.isFinite(uMin) || !Number.isFinite(uMax) || !Number.isFinite(v)) return false;
    centerU = (uMin + uMax) / 2;
    centerV = v;
    length = Math.abs(uMax - uMin);
  } else {
    const u = Number(tie.u);
    const vMin = Number(tie.vMin);
    const vMax = Number(tie.vMax);
    if (!Number.isFinite(u) || !Number.isFinite(vMin) || !Number.isFinite(vMax)) return false;
    centerU = u;
    centerV = (vMin + vMax) / 2;
    length = Math.abs(vMax - vMin);
  }
  if (!(length > 0)) return false;

  const roll = placement.localRollRad || 0;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const u = roll === 0 ? centerU : centerU * cos - centerV * sin;
  const v = roll === 0 ? centerV : centerU * sin + centerV * cos;
  const rollQuaternion =
    roll === 0 ? null : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);
  const direction = LINE_QUATERNIONS[axis];
  const quaternion = rollQuaternion ? rollQuaternion.clone().multiply(direction) : direction;

  const localMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(u, v, axialPos),
    quaternion,
    new THREE.Vector3(dia, dia, length),
  );
  const matrix = new THREE.Matrix4().multiplyMatrices(memberMatrix, localMatrix);
  const list = matricesByDia.get(dia);
  if (list) list.push(matrix);
  else matricesByDia.set(dia, [matrix]);
  return true;
}

function collectMemberTies(element, nodes, layout, memberType, accumulator) {
  const placement =
    memberType === 'column'
      ? resolveColumnPlacement(element, nodes)
      : resolveBeamPlacement(element, nodes, layout);
  if (!placement || !(placement.length > 0)) return false;

  const memberMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(placement.center.x, placement.center.y, placement.center.z),
    new THREE.Quaternion(
      placement.rotation.x,
      placement.rotation.y,
      placement.rotation.z,
      placement.rotation.w,
    ),
    new THREE.Vector3(1, 1, 1),
  );

  const groups = [
    ...(layout.segments || []).map((segment) => ({ segment, auxiliary: false })),
    ...(layout.auxiliarySegments || []).map((segment) => ({ segment, auxiliary: true })),
  ];

  for (const { segment: rawSegment, auxiliary } of groups) {
    const ties = rawSegment?.ties || [];
    if (ties.length === 0) continue;
    const segment = auxiliary ? normalizedAuxiliarySegment(layout, rawSegment) : rawSegment;
    for (const axialPos of spreadPositions(placement.length, segment)) {
      for (const tie of ties) {
        if (accumulator.count >= accumulator.max) return true;
        if (pushTieMatrix(tie, axialPos, placement, memberMatrix, accumulator.matricesByDia)) {
          accumulator.count += 1;
        }
      }
    }
  }
  return false;
}

function createInstancedMesh(geometry, material, matrices, options) {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.raycast = () => {};
  mesh.userData = {
    isRebar: true,
    rebarKind: options.rebarKind,
    barDiameterMm: options.dia,
    modelSource: options.modelSource || null,
  };
  return mesh;
}

/**
 * 帯筋・あばら筋レイアウトに含まれる補助直線筋を3Dメッシュ化する。
 * @param {Array<Object>} elements
 * @param {Map<string,Object>} nodes
 * @param {Map<string,Object>} layoutMap
 * @param {{memberType:'column'|'beam', rebarKind?:string, modelSource?:string}} options
 * @returns {Array<THREE.InstancedMesh>}
 */
export function createAuxiliaryTieMeshes(elements, nodes, layoutMap, options = {}) {
  if (!elements?.length || !nodes?.size || !layoutMap?.size) return [];
  const memberType = options.memberType === 'column' ? 'column' : 'beam';
  const accumulator = {
    matricesByDia: new Map(),
    count: 0,
    max: HOOP_RENDER_OPTIONS.maxBarsPerModel,
  };
  let truncated = false;

  for (const element of elements) {
    const layout = layoutMap.get(String(element.id_section));
    if (!layout) continue;
    if (collectMemberTies(element, nodes, layout, memberType, accumulator)) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    log.warn(`[Render] 補助せん断補強筋が上限（${accumulator.max}本）に達したため打ち切りました`);
  }
  if (accumulator.count === 0) return [];

  const geometry = getUnitBarGeometry();
  const material = getSharedMaterial();
  const rebarKind = options.rebarKind || `${memberType}HoopAuxiliary`;
  const meshes = [];
  for (const [dia, matrices] of accumulator.matricesByDia) {
    meshes.push(createInstancedMesh(geometry, material, matrices, { ...options, rebarKind, dia }));
  }
  log.info(`[Render] ${rebarKind} を生成しました: ${accumulator.count}本`);
  return meshes;
}
