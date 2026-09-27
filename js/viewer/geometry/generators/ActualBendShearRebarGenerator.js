import * as THREE from 'three';
import { HOOP_RENDER_OPTIONS } from '../../../constants/rebarPlacementRules.js';
import {
  rebarPathToLineSegments,
  validateRebarPath,
} from '../../../data/extractors/rebar3d/rebarPath.js';
import { calculateBeamPlacement, calculateColumnPlacement } from '../core/GeometryCalculator.js';

const Z = new THREE.Vector3(0, 0, 1);
let unitGeometry = null;
let sharedMaterial = null;

function geometry() {
  if (!unitGeometry) {
    unitGeometry = new THREE.CylinderGeometry(
      0.5,
      0.5,
      1,
      HOOP_RENDER_OPTIONS.radialSegments,
      1,
      false,
    );
    unitGeometry.rotateX(Math.PI / 2);
  }
  return unitGeometry;
}

function material() {
  if (!sharedMaterial)
    sharedMaterial = new THREE.MeshLambertMaterial({ color: HOOP_RENDER_OPTIONS.colorHex });
  return sharedMaterial;
}

function columnPlacement(element, nodes) {
  const a = nodes?.get(String(element.id_node_bottom));
  const b = nodes?.get(String(element.id_node_top));
  if (!a || !b) return null;
  const roll = ((Number(element.rotate ?? element.angle ?? 0) || 0) * Math.PI) / 180;
  const p = calculateColumnPlacement(a, b, {
    bottomOffset: {
      x: Number(element.offset_bottom_X || 0),
      y: Number(element.offset_bottom_Y || 0),
      z: Number(element.offset_bottom_Z || 0),
    },
    topOffset: {
      x: Number(element.offset_top_X || 0),
      y: Number(element.offset_top_Y || 0),
      z: Number(element.offset_top_Z || 0),
    },
    rollAngle: roll,
  });
  return { ...p, localRollRad: 0 };
}

function beamPlacement(element, nodes, layout) {
  const a = nodes?.get(String(element.id_node_start));
  const b = nodes?.get(String(element.id_node_end));
  if (!a || !b) return null;
  const roll = ((Number(element.rotate ?? element.angle ?? 0) || 0) * Math.PI) / 180;
  const p = calculateBeamPlacement(a, b, {
    startOffset: {
      x: Number(element.offset_start_X || 0),
      y: Number(element.offset_start_Y || 0),
      z: Number(element.offset_start_Z || 0),
    },
    endOffset: {
      x: Number(element.offset_end_X || 0),
      y: Number(element.offset_end_Y || 0),
      z: Number(element.offset_end_Z || 0),
    },
    placementMode: 'top-aligned',
    sectionHeight: layout.depth || 0,
  });
  return { ...p, localRollRad: roll };
}

function positions(length, segment) {
  if (Number.isFinite(Number(segment?.positionRatio)))
    return [length * (Number(segment.positionRatio) - 0.5)];
  const s = Number(segment?.startRatio);
  const e = Number(segment?.endRatio);
  const pitch = Number(segment?.pitch);
  if (![s, e, pitch].every(Number.isFinite) || e <= s || pitch <= 0) return [];
  const start = length * (s - 0.5);
  const span = length * (e - s);
  const count = Math.max(1, Math.floor(span / pitch));
  const first = start + (span - (count - 1) * pitch) / 2;
  return Array.from({ length: count }, (_, i) => first + i * pitch);
}

function normalizeAux(layout, segment) {
  if (
    !layout?.memberSpecific ||
    !Number.isFinite(layout.memberPlanLengthMm) ||
    !Number.isFinite(layout.startFaceMm) ||
    !Number.isFinite(layout.endFaceMm)
  )
    return segment;
  const clear = layout.endFaceMm - layout.startFaceMm;
  if (!(clear > 0) || !(layout.memberPlanLengthMm > 0)) return segment;
  return {
    ...segment,
    startRatio:
      (layout.startFaceMm + clear * Number(segment.startRatio || 0)) / layout.memberPlanLengthMm,
    endRatio:
      (layout.startFaceMm + clear * Number(segment.endRatio ?? 1)) / layout.memberPlanLengthMm,
  };
}

function memberMatrix(p) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(p.center.x, p.center.y, p.center.z),
    new THREE.Quaternion(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w),
    new THREE.Vector3(1, 1, 1),
  );
}

function point(value, axial, roll) {
  const x = Number(value?.x) || 0;
  const y = Number(value?.y) || 0;
  const z = Number(value?.z) || 0;
  if (!roll) return new THREE.Vector3(x, y, axial + z);
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  return new THREE.Vector3(x * c - y * s, x * s + y * c, axial + z);
}

function selectedPath(item, sequence) {
  const paths = Array.isArray(item?.paths) && item.paths.length ? item.paths : [item?.path];
  const path = paths[Math.abs(sequence) % paths.length];
  return path && validateRebarPath(path).ok ? path : null;
}

function push(item, axial, sequence, placement, world, accumulator, tessellation) {
  const path = selectedPath(item, sequence);
  if (!path) return 0;
  const dia = Number(path.metadata?.dia ?? item?.dia);
  if (!(dia > 0)) return 0;

  // maxBarsPerModel は論理的な RebarPath 本数の保護に使う。
  // 1本の実折曲げ筋を表示用 chord へ細分した本数で上限を消費すると、
  // HRC のような大規模モデルで後続部材が無言で欠落する。
  if (accumulator.barCount >= accumulator.maxBars) return -1;

  const lines = rebarPathToLineSegments(path, tessellation);
  if (lines.length === 0) return 0;
  const list = accumulator.byDia.get(dia) || [];
  for (const line of lines) {
    const a = point(line.start, axial, placement.localRollRad || 0);
    const b = point(line.end, axial, placement.localRollRad || 0);
    const d = new THREE.Vector3().subVectors(b, a);
    const l = d.length();
    if (!(l > 1e-9)) continue;
    d.multiplyScalar(1 / l);
    const q = new THREE.Quaternion().setFromUnitVectors(Z, d);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const local = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(dia, dia, l));
    list.push(new THREE.Matrix4().multiplyMatrices(world, local));
  }
  accumulator.byDia.set(dia, list);
  accumulator.barCount += 1;
  return lines.length;
}

function collect(element, nodes, layout, memberType, accumulator, options) {
  const p =
    memberType === 'column'
      ? columnPlacement(element, nodes)
      : beamPlacement(element, nodes, layout);
  if (!p || !(p.length > 0)) return false;
  const world = memberMatrix(p);
  let sequence = 0;
  const groups = [
    ...(layout.segments || []).map((segment) => ({ segment, aux: false })),
    ...(layout.auxiliarySegments || []).map((segment) => ({ segment, aux: true })),
  ];
  for (const group of groups) {
    const segment = group.aux ? normalizeAux(layout, group.segment) : group.segment;
    for (const axial of positions(p.length, segment)) {
      for (const item of [...(segment.loops || []), ...(segment.ties || [])]) {
        if (item?.actualBendRequired !== true || item?.bendStatus !== 'RESOLVED') continue;
        const n = push(item, axial, sequence, p, world, accumulator, options.tessellation);
        if (n < 0) return true;
      }
      sequence += 1;
    }
  }
  return false;
}

function mesh(matrices, dia, options) {
  const result = new THREE.InstancedMesh(
    geometry(),
    options.material || material(),
    matrices.length,
  );
  matrices.forEach((matrix, index) => result.setMatrixAt(index, matrix));
  result.instanceMatrix.needsUpdate = true;
  result.computeBoundingSphere();
  result.raycast = () => {};
  result.userData = {
    isRebar: true,
    rebarKind: options.rebarKind,
    barDiameterMm: dia,
    modelSource: options.modelSource || null,
    actualBendGeometry: true,
    ruleId: 'R11',
  };
  return result;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function meshChunks(matrices, dia, options) {
  const maxInstancesPerMesh = positiveInteger(
    options.maxInstancesPerMesh,
    HOOP_RENDER_OPTIONS.maxBarsPerModel,
  );
  const result = [];
  for (let start = 0; start < matrices.length; start += maxInstancesPerMesh) {
    result.push(mesh(matrices.slice(start, start + maxInstancesPerMesh), dia, options));
  }
  return result;
}

export function createActualBendShearMeshes(elements, nodes, layoutMap, options = {}) {
  if (!elements?.length || !nodes?.size || !layoutMap?.size) return [];
  const memberType = options.memberType === 'column' ? 'column' : 'beam';
  const accumulator = {
    byDia: new Map(),
    barCount: 0,
    maxBars: positiveInteger(options.maxBarsPerModel, HOOP_RENDER_OPTIONS.maxBarsPerModel),
  };
  for (const element of elements) {
    const layout = layoutMap.get(String(element.id_section));
    if (layout && collect(element, nodes, layout, memberType, accumulator, options)) break;
  }
  const kind = options.rebarKind || `${memberType}ShearActualBend`;
  return [...accumulator.byDia]
    .filter(([, matrices]) => matrices.length)
    .flatMap(([dia, matrices]) => meshChunks(matrices, dia, { ...options, rebarKind: kind }));
}

function hasResolvedActualBend(item) {
  return item?.actualBendRequired === true && item?.bendStatus === 'RESOLVED';
}

function strip(segment) {
  return {
    ...segment,
    // 実Arcが解けた item だけ旧sharp geometryを抑制する。
    // SPECIAL / unresolved は曲げ半径を推定せず、表示用centerlineとしてlegacy形状を残す。
    loops: (segment.loops || []).filter((item) => !hasResolvedActualBend(item)),
    ties: (segment.ties || []).filter((item) => !hasResolvedActualBend(item)),
  };
}

export function createLegacyShearFallbackLayoutMap(layoutMap) {
  if (!layoutMap?.size) return layoutMap || new Map();
  const result = new Map();
  for (const [key, layout] of layoutMap) {
    result.set(key, {
      ...layout,
      segments: (layout.segments || []).map(strip),
      auxiliarySegments: (layout.auxiliarySegments || []).map(strip),
    });
  }
  for (const key of Object.keys(layoutMap)) result[key] = layoutMap[key];
  return result;
}
