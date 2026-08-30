/**
 * @fileoverview RC部材（柱・梁）主筋の3Dメッシュ生成
 *
 * 断面内の主筋芯座標（data/extractors/rebar3d/*）を部材の配置に載せて、
 * 材軸方向の直線部を円柱で描く。
 *
 * 配置は「材軸方向の区間（segment）」単位で扱う。柱は全長1区間、
 * 梁は LEFT / CENTER / RIGHT ごとに区間を分けて本数の違いを表す。
 *
 * 本数が多くなるため、呼び径ごとに単位円柱1個を共有する InstancedMesh へまとめる。
 *
 * @module viewer/geometry/generators/RebarGenerator
 */

import * as THREE from 'three';
import { calculateBeamPlacement, calculateColumnPlacement } from '../core/GeometryCalculator.js';
import {
  HOOP_RENDER_OPTIONS,
  REBAR_RENDER_OPTIONS,
} from '../../../constants/rebarPlacementRules.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('viewer:rebar');

/** 単位円柱（半径0.5・高さ1）。インスタンスのスケールで実寸にする */
let unitBarGeometry = null;
/** 鉄筋の共有マテリアル（メッシュ破棄時も保持する） */
let sharedBarMaterial = null;
/** 帯筋・あばら筋の共有マテリアル */
let sharedHoopMaterial = null;
/** 円形フープのトーラスジオメトリ（`半径|呼び径` をキーに共有） */
const circleHoopGeometries = new Map();

/**
 * 単位円柱ジオメトリを取得する（材軸をローカルZ軸に合わせて生成）
 * @returns {THREE.CylinderGeometry} 単位円柱
 */
function getUnitBarGeometry() {
  if (!unitBarGeometry) {
    unitBarGeometry = new THREE.CylinderGeometry(
      0.5,
      0.5,
      1,
      REBAR_RENDER_OPTIONS.radialSegments,
      1,
      false,
    );
    // CylinderGeometry はY軸方向。押し出し方向（ローカルZ軸）に合わせる。
    unitBarGeometry.rotateX(Math.PI / 2);
  }
  return unitBarGeometry;
}

/**
 * 鉄筋の共有マテリアルを取得する
 * @returns {THREE.MeshLambertMaterial} 共有マテリアル
 */
function getSharedBarMaterial() {
  if (!sharedBarMaterial) {
    sharedBarMaterial = new THREE.MeshLambertMaterial({ color: REBAR_RENDER_OPTIONS.colorHex });
  }
  return sharedBarMaterial;
}

/**
 * 帯筋・あばら筋の共有マテリアルを取得する
 * @returns {THREE.MeshLambertMaterial} 共有マテリアル
 */
function getSharedHoopMaterial() {
  if (!sharedHoopMaterial) {
    sharedHoopMaterial = new THREE.MeshLambertMaterial({ color: HOOP_RENDER_OPTIONS.colorHex });
  }
  return sharedHoopMaterial;
}

/**
 * 円形フープのトーラスジオメトリを取得する（半径・呼び径ごとに共有）
 *
 * トーラスは管径が半径に比例しないためインスタンスのスケールで実寸にできない。
 * 円形柱は種類が限られるため、組み合わせごとに実寸で作って共有する。
 * @param {number} radius - ループ半径 [mm]
 * @param {number} diaMm - 呼び径 [mm]
 * @returns {THREE.TorusGeometry} トーラスジオメトリ（軸はローカルZ）
 */
function getCircleHoopGeometry(radius, diaMm) {
  const key = `${radius}|${diaMm}`;
  let geometry = circleHoopGeometries.get(key);
  if (!geometry) {
    // TorusGeometry はXY平面上に作られ、軸がZ軸になる（材軸と一致）
    geometry = new THREE.TorusGeometry(
      radius,
      diaMm / 2,
      HOOP_RENDER_OPTIONS.radialSegments,
      HOOP_RENDER_OPTIONS.tubularSegments,
    );
    circleHoopGeometries.set(key, geometry);
  }
  return geometry;
}

/**
 * 柱要素の配置（中心・回転・長さ）を求める
 *
 * `rotate` は配置の四元数に含まれるため、断面内座標の追加回転は不要。
 * @param {Object} column - 柱要素
 * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
 * @returns {{center:Object, rotation:Object, length:number, localRollRad:number}|null} 配置
 */
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

/**
 * 梁要素の配置（中心・回転・長さ）を求める
 *
 * 梁は天端基準（top-aligned）で配置され、`rotate` は配置の四元数ではなく
 * ジオメトリ側へ適用される。そのため断面内座標を材軸回りに回す必要がある。
 * @param {Object} beam - 梁要素
 * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
 * @param {Object} layout - 断面配置（梁せいの取得に使う）
 * @returns {{center:Object, rotation:Object, length:number, localRollRad:number}|null} 配置
 */
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

/**
 * 1部材分の鉄筋インスタンス行列を集める
 * @param {Object} placement - resolveColumnPlacement / resolveBeamPlacement の結果
 * @param {Object} layout - 断面配置（segments を持つ）
 * @param {Object} accumulator - {matricesByDia, count, max}
 * @returns {boolean} 上限に達して打ち切った場合 true
 */
function collectMemberMatrices(placement, layout, accumulator) {
  const { matricesByDia, max } = accumulator;

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

  const roll = placement.localRollRad || 0;
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);
  const identity = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  const barScale = new THREE.Vector3();
  const localMatrix = new THREE.Matrix4();

  for (const segment of layout.segments) {
    const segmentLength = placement.length * (segment.endRatio - segment.startRatio);
    if (!(segmentLength > 0)) continue;
    // 区間中心の材軸方向位置（部材中心が原点）
    const segmentCenter = placement.length * ((segment.startRatio + segment.endRatio) / 2 - 0.5);

    for (const bar of segment.bars) {
      if (accumulator.count >= max) return true;

      // rotate がジオメトリ側へ適用される部材では断面内座標を回す
      const u = roll === 0 ? bar.u : bar.u * cosRoll - bar.v * sinRoll;
      const v = roll === 0 ? bar.v : bar.u * sinRoll + bar.v * cosRoll;

      offset.set(u, v, segmentCenter);
      barScale.set(bar.dia, bar.dia, segmentLength);
      localMatrix.compose(offset, identity, barScale);

      const matrix = new THREE.Matrix4().multiplyMatrices(memberMatrix, localMatrix);
      const list = matricesByDia.get(bar.dia);
      if (list) {
        list.push(matrix);
      } else {
        matricesByDia.set(bar.dia, [matrix]);
      }
      accumulator.count++;
    }
  }
  return false;
}

/** 矩形ループ1組を分解したときの直線本数（4辺） */
const RECT_LOOP_LEG_COUNT = 4;

/** ローカルZ軸の単位円柱を各方向へ向けるための回転 */
const LEG_DIRECTION_QUATERNIONS = {
  /** 断面内u方向（ローカルX）へ向ける */
  u: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2),
  /** 断面内v方向（ローカルY）へ向ける */
  v: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
};

/**
 * 区間内のループ中心を材軸方向に並べる
 *
 * 本数はピッチで割った数とし、区間内で中央寄せに配置する。
 * 区間がピッチに満たない場合も1組は置く（配筋が無いように見えるのを避ける）。
 * @param {number} segmentStart - 区間始点の材軸座標（部材中心が原点）
 * @param {number} segmentLength - 区間長 [mm]
 * @param {number} pitch - ピッチ [mm]
 * @returns {number[]} ループ中心の材軸座標
 */
function spreadLoopPositions(segmentStart, segmentLength, pitch) {
  const count = Math.max(1, Math.floor(segmentLength / pitch));
  const spread = (count - 1) * pitch;
  const first = segmentStart + (segmentLength - spread) / 2;
  return Array.from({ length: count }, (_, index) => first + index * pitch);
}

/**
 * 矩形ループ1組を4辺の直線に分解して行列を積む
 *
 * 角の折り曲げ・フックは表現せず、水平辺を呼び径ぶん伸ばして角を閉じる。
 * @param {Object} loop - {uMin, uMax, vMin, vMax, dia}
 * @param {number} axialPos - 材軸方向の位置
 * @param {Object} context - {memberMatrix, cosRoll, sinRoll, roll, rectByDia}
 * @returns {number} 積んだ本数
 */
function pushRectLoopMatrices(loop, axialPos, context) {
  const { memberMatrix, cosRoll, sinRoll, roll, rectByDia } = context;
  const spanU = loop.uMax - loop.uMin;
  const spanV = loop.vMax - loop.vMin;
  const centerU = (loop.uMin + loop.uMax) / 2;
  const centerV = (loop.vMin + loop.vMax) / 2;

  const legs = [
    { u: centerU, v: loop.vMin, length: spanU + loop.dia, dir: 'u' },
    { u: centerU, v: loop.vMax, length: spanU + loop.dia, dir: 'u' },
    { u: loop.uMin, v: centerV, length: spanV, dir: 'v' },
    { u: loop.uMax, v: centerV, length: spanV, dir: 'v' },
  ];

  const rollQuaternion =
    roll === 0 ? null : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);

  for (const leg of legs) {
    // rotate がジオメトリ側へ適用される部材では断面内座標と辺の向きを回す
    const u = roll === 0 ? leg.u : leg.u * cosRoll - leg.v * sinRoll;
    const v = roll === 0 ? leg.v : leg.u * sinRoll + leg.v * cosRoll;

    const direction = LEG_DIRECTION_QUATERNIONS[leg.dir];
    const quaternion = rollQuaternion ? rollQuaternion.clone().multiply(direction) : direction;

    const localMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(u, v, axialPos),
      quaternion,
      new THREE.Vector3(loop.dia, loop.dia, leg.length),
    );
    const matrix = new THREE.Matrix4().multiplyMatrices(memberMatrix, localMatrix);

    const list = rectByDia.get(loop.dia);
    if (list) {
      list.push(matrix);
    } else {
      rectByDia.set(loop.dia, [matrix]);
    }
  }
  return legs.length;
}

/**
 * 円形ループ1組の行列を積む
 * @param {Object} loop - {radius, dia}
 * @param {number} axialPos - 材軸方向の位置
 * @param {Object} context - {memberMatrix, circleByKey}
 * @returns {number} 積んだ本数
 */
function pushCircleLoopMatrix(loop, axialPos, context) {
  const { memberMatrix, circleByKey } = context;
  const localMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, axialPos),
    new THREE.Quaternion(),
    new THREE.Vector3(1, 1, 1),
  );
  const matrix = new THREE.Matrix4().multiplyMatrices(memberMatrix, localMatrix);

  const key = `${loop.radius}|${loop.dia}`;
  const entry = circleByKey.get(key);
  if (entry) {
    entry.matrices.push(matrix);
  } else {
    circleByKey.set(key, {
      geometry: getCircleHoopGeometry(loop.radius, loop.dia),
      dia: loop.dia,
      matrices: [matrix],
    });
  }
  return 1;
}

/**
 * 1部材分の帯筋・あばら筋インスタンス行列を集める
 * @param {Object} placement - resolveColumnPlacement / resolveBeamPlacement の結果
 * @param {Object} layout - ループ配置（segments を持つ）
 * @param {Object} accumulator - {rectByDia, circleByKey, count, max}
 * @returns {boolean} 上限に達して打ち切った場合 true
 */
function collectHoopMatrices(placement, layout, accumulator) {
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

  const roll = placement.localRollRad || 0;
  const context = {
    memberMatrix,
    roll,
    cosRoll: Math.cos(roll),
    sinRoll: Math.sin(roll),
    rectByDia: accumulator.rectByDia,
    circleByKey: accumulator.circleByKey,
  };

  for (const segment of layout.segments) {
    const segmentLength = placement.length * (segment.endRatio - segment.startRatio);
    if (!(segmentLength > 0) || !(segment.pitch > 0)) continue;
    const segmentStart = placement.length * (segment.startRatio - 0.5);

    for (const axialPos of spreadLoopPositions(segmentStart, segmentLength, segment.pitch)) {
      for (const loop of segment.loops) {
        const isCircle = loop.type === 'CIRCLE';
        // 矩形は1組が4辺まとめて積まれるため、積む前に必要数ぶんの空きを確かめる
        if (accumulator.count + (isCircle ? 1 : RECT_LOOP_LEG_COUNT) > accumulator.max) {
          return true;
        }
        accumulator.count += isCircle
          ? pushCircleLoopMatrix(loop, axialPos, context)
          : pushRectLoopMatrices(loop, axialPos, context);
      }
    }
  }
  return false;
}

/**
 * 集めたインスタンス行列から InstancedMesh を作る
 * @param {Map<number, THREE.Matrix4[]>} matricesByDia - 呼び径ごとの行列
 * @param {Object} options - {material, modelSource, rebarKind}
 * @returns {Array<THREE.InstancedMesh>} 生成メッシュ
 */
function buildInstancedMeshes(matricesByDia, options) {
  const geometry = getUnitBarGeometry();
  const material = options.material || getSharedBarMaterial();

  const meshes = [];
  for (const [dia, matrices] of matricesByDia) {
    meshes.push(createInstancedMesh(geometry, material, matrices, { ...options, dia }));
  }
  return meshes;
}

/**
 * インスタンス行列から InstancedMesh を1つ作る
 * @param {THREE.BufferGeometry} geometry - 共有ジオメトリ
 * @param {THREE.Material} material - 共有マテリアル
 * @param {THREE.Matrix4[]} matrices - インスタンス行列
 * @param {Object} options - {rebarKind, dia, modelSource}
 * @returns {THREE.InstancedMesh} 生成メッシュ
 */
function createInstancedMesh(geometry, material, matrices, options) {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  // 1メッシュに全部材分の鉄筋が入るため、インスタンス行列から実際の範囲を求めて
  // フラスタムカリングを効かせる（既定の境界球はモデル全体を覆ってしまう）
  mesh.computeBoundingSphere();
  // 鉄筋は表示専用のオーバーレイなのでピック対象から外す
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
 * 集めた帯筋・あばら筋の行列から InstancedMesh を作る
 * @param {Object} accumulator - {rectByDia, circleByKey}
 * @param {Object} options - {material, modelSource, rebarKind}
 * @returns {Array<THREE.InstancedMesh>} 生成メッシュ
 */
function buildHoopMeshes(accumulator, options) {
  const material = options.material || getSharedHoopMaterial();
  const meshes = [];

  for (const [dia, matrices] of accumulator.rectByDia) {
    meshes.push(createInstancedMesh(getUnitBarGeometry(), material, matrices, { ...options, dia }));
  }
  for (const { geometry, dia, matrices } of accumulator.circleByKey.values()) {
    // トーラスは実寸で作られているためスケールは掛けない
    meshes.push(createInstancedMesh(geometry, material, matrices, { ...options, dia }));
  }
  return meshes;
}

/**
 * 主筋のインスタンス収集・生成の手順
 * @type {{createAccumulator: Function, collect: Function, build: Function}}
 */
const MAIN_BAR_PIPELINE = {
  createAccumulator: () => ({
    matricesByDia: new Map(),
    count: 0,
    max: REBAR_RENDER_OPTIONS.maxBarsPerModel,
  }),
  collect: collectMemberMatrices,
  build: (accumulator, options) => buildInstancedMeshes(accumulator.matricesByDia, options),
};

/**
 * 帯筋・あばら筋のインスタンス収集・生成の手順
 * @type {{createAccumulator: Function, collect: Function, build: Function}}
 */
const HOOP_PIPELINE = {
  createAccumulator: () => ({
    rectByDia: new Map(),
    circleByKey: new Map(),
    count: 0,
    max: HOOP_RENDER_OPTIONS.maxBarsPerModel,
  }),
  collect: collectHoopMatrices,
  build: buildHoopMeshes,
};

/**
 * 部材配列から鉄筋メッシュを作る共通処理
 * @param {Array<Object>} elements - 部材要素配列
 * @param {Map<string, Object>} layoutMap - 断面ID → 配置
 * @param {Function} resolvePlacement - (element, layout) => placement|null
 * @param {Object} options - {modelSource, material, rebarKind}
 * @param {Object} pipeline - MAIN_BAR_PIPELINE / HOOP_PIPELINE
 * @returns {Array<THREE.InstancedMesh>} 生成メッシュ
 */
function createRebarMeshes(elements, layoutMap, resolvePlacement, options, pipeline) {
  const accumulator = pipeline.createAccumulator();
  let truncated = false;

  for (const element of elements) {
    const layout = layoutMap.get(String(element.id_section));
    if (!layout) continue;

    const placement = resolvePlacement(element, layout);
    if (!placement || !(placement.length > 0)) continue;

    if (pipeline.collect(placement, layout, accumulator)) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    log.warn(
      `[Render] ${options.rebarKind} の本数が上限（${accumulator.max}本）に達したため打ち切りました`,
    );
  }
  if (accumulator.count === 0) return [];

  const meshes = pipeline.build(accumulator, options);
  log.info(
    `[Render] ${options.rebarKind} を生成しました: ${accumulator.count}本 / ${meshes.length}インスタンスメッシュ`,
  );
  return meshes;
}

/**
 * RC柱主筋の3Dメッシュ（InstancedMesh）を生成する
 *
 * @param {Array<Object>} columnElements - 柱要素配列（id_node_bottom/top, id_section を持つ）
 * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
 * @param {Map<string, Object>} layoutMap - 断面ID → 主筋配置
 * @param {Object} [options] - {material, modelSource}
 * @returns {Array<THREE.InstancedMesh>} 生成したメッシュ配列
 */
export function createColumnRebarMeshes(columnElements, nodes, layoutMap, options = {}) {
  if (!columnElements?.length || !nodes?.size || !layoutMap?.size) return [];
  return createRebarMeshes(
    columnElements,
    layoutMap,
    (column) => resolveColumnPlacement(column, nodes),
    { ...options, rebarKind: 'columnMain' },
    MAIN_BAR_PIPELINE,
  );
}

/**
 * RC梁（大梁・小梁）主筋の3Dメッシュ（InstancedMesh）を生成する
 *
 * @param {Array<Object>} beamElements - 梁要素配列（id_node_start/end, id_section を持つ）
 * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
 * @param {Map<string, Object>} layoutMap - 断面ID → 主筋配置
 * @param {Object} [options] - {material, modelSource}
 * @returns {Array<THREE.InstancedMesh>} 生成したメッシュ配列
 */
export function createBeamRebarMeshes(beamElements, nodes, layoutMap, options = {}) {
  if (!beamElements?.length || !nodes?.size || !layoutMap?.size) return [];
  return createRebarMeshes(
    beamElements,
    layoutMap,
    (beam, layout) => resolveBeamPlacement(beam, nodes, layout),
    { ...options, rebarKind: 'beamMain' },
    MAIN_BAR_PIPELINE,
  );
}

/**
 * RC柱帯筋（フープ）の3Dメッシュ（InstancedMesh）を生成する
 *
 * @param {Array<Object>} columnElements - 柱要素配列（id_node_bottom/top, id_section を持つ）
 * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
 * @param {Map<string, Object>} layoutMap - 断面ID → 帯筋配置
 * @param {Object} [options] - {material, modelSource}
 * @returns {Array<THREE.InstancedMesh>} 生成したメッシュ配列
 */
export function createColumnHoopMeshes(columnElements, nodes, layoutMap, options = {}) {
  if (!columnElements?.length || !nodes?.size || !layoutMap?.size) return [];
  return createRebarMeshes(
    columnElements,
    layoutMap,
    (column) => resolveColumnPlacement(column, nodes),
    { ...options, rebarKind: 'columnHoop' },
    HOOP_PIPELINE,
  );
}

/**
 * RC梁（大梁・小梁）あばら筋（スターラップ）の3Dメッシュを生成する
 *
 * @param {Array<Object>} beamElements - 梁要素配列（id_node_start/end, id_section を持つ）
 * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
 * @param {Map<string, Object>} layoutMap - 断面ID → あばら筋配置
 * @param {Object} [options] - {material, modelSource}
 * @returns {Array<THREE.InstancedMesh>} 生成したメッシュ配列
 */
export function createBeamStirrupMeshes(beamElements, nodes, layoutMap, options = {}) {
  if (!beamElements?.length || !nodes?.size || !layoutMap?.size) return [];
  return createRebarMeshes(
    beamElements,
    layoutMap,
    (beam, layout) => resolveBeamPlacement(beam, nodes, layout),
    { ...options, rebarKind: 'beamStirrup' },
    HOOP_PIPELINE,
  );
}

/**
 * 部材端を基準にした距離を、部材中心を原点とする材軸座標へ変換する
 * @param {'start'|'end'} anchor - 基準にする部材端
 * @param {number} distance - 基準端からの距離 [mm]（内向き正）
 * @param {number} length - 部材長 [mm]
 * @returns {number} 材軸座標
 */
function axialFromAnchor(anchor, distance, length) {
  return anchor === 'end' ? length / 2 - distance : -length / 2 + distance;
}

/**
 * 1部材分の鉄筋片（定着・カットオフ）の行列を集める
 *
 * 鉄筋片は「部材端からの実寸距離」で表されるため、区間比率で表す
 * segments とは別にここで材軸座標へ載せ替える。
 * @param {Object} placement - resolveColumnPlacement / resolveBeamPlacement の結果
 * @param {{pieces:Array<Object>}} entry - 要素ごとの鉄筋片
 * @param {Object} accumulator - {matricesByDia, count, max}
 * @returns {boolean} 上限に達して打ち切った場合 true
 */
function collectPieceMatrices(placement, entry, accumulator) {
  const { matricesByDia, max } = accumulator;

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

  const roll = placement.localRollRad || 0;
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);
  const rollQuaternion =
    roll === 0 ? null : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll);
  const identity = rollQuaternion || new THREE.Quaternion();
  /** rotate がジオメトリ側へ適用される部材では断面内座標を材軸回りに回す */
  const rotate = (u, v) =>
    roll === 0 ? { u, v } : { u: u * cosRoll - v * sinRoll, v: u * sinRoll + v * cosRoll };
  const orient = (dir) => {
    if (dir === 'axial') return identity;
    const direction = LEG_DIRECTION_QUATERNIONS[dir];
    return rollQuaternion ? rollQuaternion.clone().multiply(direction) : direction;
  };

  const push = (u, v, axial, quaternion, dia, length) => {
    const localMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(u, v, axial),
      quaternion,
      new THREE.Vector3(dia, dia, length),
    );
    const matrix = new THREE.Matrix4().multiplyMatrices(memberMatrix, localMatrix);
    const list = matricesByDia.get(dia);
    if (list) list.push(matrix);
    else matricesByDia.set(dia, [matrix]);
    accumulator.count++;
  };

  for (const piece of entry.pieces) {
    if (accumulator.count >= max) return true;

    if (piece.kind === 'axial') {
      const from = axialFromAnchor(piece.anchor, piece.from, placement.length);
      const to = axialFromAnchor(piece.anchor, piece.to, placement.length);
      const { u, v } = rotate(piece.u, piece.v);
      push(u, v, (from + to) / 2, identity, piece.dia, Math.abs(to - from));
      continue;
    }

    // 折曲げ余長: 折曲げ開始点から dir 方向へ length だけ伸ばす
    const bendAxial = axialFromAnchor(piece.anchor, piece.at, placement.length);
    const half = (piece.sign * piece.length) / 2;
    const centerU = piece.u + piece.offsetU + (piece.dir === 'u' ? half : 0);
    const centerV = piece.v + piece.offsetV + (piece.dir === 'v' ? half : 0);
    const { u, v } = rotate(centerU, centerV);
    // 材軸方向の折り返し（180°フック）は部材内向きを正とする
    const inwardSign = piece.anchor === 'end' ? -1 : 1;
    const axial = piece.dir === 'axial' ? bendAxial + inwardSign * half : bendAxial;
    push(u, v, axial, orient(piece.dir), piece.dia, piece.length);
  }
  return false;
}

/**
 * 定着・カットオフの鉄筋片から3Dメッシュを生成する
 *
 * 主筋と同じ色・同じ単位円柱を共有するため、主筋メッシュと並べて
 * 1本の鉄筋に見えるようにつながる。
 * @param {Array<Object>} elements - 部材要素配列（id, id_section を持つ）
 * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
 * @param {Map<string, Object>} layoutMap - 断面ID → 主筋配置
 * @param {Map<string, {pieces:Array}>} pieceMap - 要素ID → 鉄筋片
 * @param {Object} [options] - {material, modelSource, rebarKind, memberType}
 * @returns {Array<THREE.InstancedMesh>} 生成したメッシュ配列
 */
export function createRebarPieceMeshes(elements, nodes, layoutMap, pieceMap, options = {}) {
  if (!elements?.length || !nodes?.size || !layoutMap?.size || !pieceMap?.size) return [];

  const isColumn = options.memberType === 'column';
  const accumulator = MAIN_BAR_PIPELINE.createAccumulator();
  const rebarKind = options.rebarKind || 'rebarPiece';
  let truncated = false;

  for (const element of elements) {
    const entry = pieceMap.get(String(element.id));
    if (!entry?.pieces?.length) continue;

    const layout = layoutMap.get(String(element.id_section));
    if (!layout) continue;

    const placement = isColumn
      ? resolveColumnPlacement(element, nodes)
      : resolveBeamPlacement(element, nodes, layout);
    if (!placement || !(placement.length > 0)) continue;

    if (collectPieceMatrices(placement, entry, accumulator)) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    log.warn(
      `[Render] ${rebarKind} の本数が上限（${accumulator.max}本）に達したため打ち切りました`,
    );
  }
  if (accumulator.count === 0) return [];

  const meshes = buildInstancedMeshes(accumulator.matricesByDia, { ...options, rebarKind });
  log.info(
    `[Render] ${rebarKind} を生成しました: ${accumulator.count}本 / ${meshes.length}インスタンスメッシュ`,
  );
  return meshes;
}

/**
 * 生成済み鉄筋メッシュを破棄する
 *
 * 単位ジオメトリとマテリアルは全メッシュで共有しているため破棄しない
 * （InstancedMesh.dispose がインスタンス用バッファのみを解放する）。
 * @param {Array<THREE.InstancedMesh>} meshes - 破棄対象
 */
export function disposeRebarMeshes(meshes) {
  for (const mesh of meshes || []) {
    if (mesh?.dispose) mesh.dispose();
  }
}
