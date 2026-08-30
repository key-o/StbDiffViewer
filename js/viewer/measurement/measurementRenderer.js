/**
 * @fileoverview 寸法測定の3D描画モジュール（Layer 4: viewer）
 *
 * 面法線方向への投影距離を示す寸法線・矢印・テキストスプライトを描画する。
 * UI層には依存せず、Three.js とスケジューラーのみ使用する。
 */

import * as THREE from 'three';
import { scheduleRender } from '../../utils/renderScheduler.js';
import { buildCanvasFont } from '../../utils/typography.js';

const MEASUREMENT_ELEMENT_TYPE = 'Measurement';
const DIM_COLOR = 0x2255cc;
const NORMAL_COLOR = 0x2255ff;
const ARROW_ANGLE = Math.PI / 6;

/** @type {THREE.Group|null} */
let _group = null;

/**
 * 測定グループを初期化しシーンに追加する
 * @param {THREE.Scene} scene
 */
export function initMeasurementGroup(scene) {
  if (_group) {
    clearAllMeasurementObjects();
    scene.remove(_group);
  }
  _group = new THREE.Group();
  _group.renderOrder = 500;
  _group.name = 'measurementGroup';
  scene.add(_group);
  return _group;
}

export function getMeasurementGroup() {
  return _group;
}

/**
 * 第1点選択後の法線方向矢印を描画する
 * @param {THREE.Vector3} point - 選択点（ワールド座標）
 * @param {THREE.Vector3} normal - ワールド空間法線（正規化済み）
 * @param {number} arrowLength - 矢印長さ（mm）
 * @returns {THREE.Object3D[]}
 */
export function renderNormalIndicator(point, normal, arrowLength = 800) {
  if (!_group) return [];
  const objects = [];

  const arrow = new THREE.ArrowHelper(
    normal,
    point,
    arrowLength,
    NORMAL_COLOR,
    arrowLength * 0.2,
    arrowLength * 0.1,
  );
  arrow.frustumCulled = false;
  arrow.renderOrder = 600;
  arrow.line.material.depthTest = false;
  arrow.cone.material.depthTest = false;
  arrow.userData = { elementType: MEASUREMENT_ELEMENT_TYPE, isTemp: true };
  _group.add(arrow);
  objects.push(arrow);

  // 選択点のマーカー（小球）
  const markerGeo = new THREE.SphereGeometry(arrowLength * 0.05, 8, 8);
  const markerMat = new THREE.MeshBasicMaterial({ color: NORMAL_COLOR, depthTest: false });
  const marker = new THREE.Mesh(markerGeo, markerMat);
  marker.position.copy(point);
  marker.frustumCulled = false;
  marker.renderOrder = 600;
  marker.userData = { elementType: MEASUREMENT_ELEMENT_TYPE, isTemp: true };
  _group.add(marker);
  objects.push(marker);

  scheduleRender();
  return objects;
}

/**
 * 2点間の投影距離を表す寸法線を描画する
 * @param {THREE.Vector3} p1 - 第1点
 * @param {THREE.Vector3} p2 - 第2点（任意クリック点）
 * @param {THREE.Vector3} normal - 制約方向（第1点の法線）
 * @param {number} distance - 測定値（mm）
 * @param {number} id - 測定ID（userData用）
 * @returns {THREE.Object3D[]}
 */
export function renderDimensionLine(p1, p2, normal, distance, id) {
  if (!_group) return [];
  const objects = [];

  // p1 から normal 方向に distance だけ進んだ点を dim端点とする
  const sign = Math.sign(p2.clone().sub(p1).dot(normal)) || 1;
  const p1dim = p1.clone();
  const p2dim = p1.clone().add(normal.clone().multiplyScalar(sign * distance));

  // 引き出し線オフセット方向（法線に垂直）
  const up = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const offsetDir = new THREE.Vector3().crossVectors(normal, up).normalize();
  const offsetLen = Math.max(200, distance * 0.15);
  const offset = offsetDir.clone().multiplyScalar(offsetLen);

  const arrowLen = Math.max(100, distance * 0.07);

  // 各 LineSegments はマテリアルを個別に持ち、dispose 時の多重解放を防ぐ
  function makeMat() {
    return new THREE.LineBasicMaterial({ color: DIM_COLOR, depthTest: false });
  }

  function addSegment(...pts) {
    const verts = new Float32Array(pts.flatMap((v) => [v.x, v.y, v.z]));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const line = new THREE.LineSegments(geo, makeMat());
    line.frustumCulled = false;
    line.renderOrder = 500;
    line.userData = { elementType: MEASUREMENT_ELEMENT_TYPE, measurementId: id };
    _group.add(line);
    objects.push(line);
  }

  // 引出線（p1, p2 → 寸法線位置へ）
  addSegment(p1, p1dim.clone().add(offset));
  addSegment(p2, p2dim.clone().add(offset));

  // 寸法線本体
  const dimStart = p1dim.clone().add(offset);
  const dimEnd = p2dim.clone().add(offset);
  addSegment(dimStart, dimEnd);

  // 矢印ヘッド（両端）
  // dimDir は normal 方向と平行なため、perpA には offsetDir を使用する
  // （dimDir.cross(normal) はゼロベクトルになるため offsetDir で代替する）
  const dimDir = p2dim.clone().sub(p1dim).normalize();
  const perpA = offsetDir.clone();
  const addArrow = (tip, dir) => {
    const base = tip.clone().add(dir.clone().multiplyScalar(-arrowLen * Math.cos(ARROW_ANGLE)));
    const wing1 = base.clone().add(perpA.clone().multiplyScalar(arrowLen * Math.sin(ARROW_ANGLE)));
    const wing2 = base.clone().sub(perpA.clone().multiplyScalar(arrowLen * Math.sin(ARROW_ANGLE)));
    addSegment(tip, wing1, tip, wing2);
  };
  addArrow(dimStart, dimDir.clone().negate());
  addArrow(dimEnd, dimDir);

  // テキストスプライト
  const mid = dimStart.clone().add(dimEnd).multiplyScalar(0.5);
  const sprite = _createDimSprite(`${Math.round(distance)} mm`, mid, distance, id);
  _group.add(sprite);
  objects.push(sprite);

  // 選択点マーカー
  const mkSize = Math.max(60, distance * 0.03);
  [p1, p2].forEach((pt) => {
    const geo = new THREE.SphereGeometry(mkSize, 6, 6);
    const mat = new THREE.MeshBasicMaterial({ color: DIM_COLOR, depthTest: false });
    const mk = new THREE.Mesh(geo, mat);
    mk.position.copy(pt);
    mk.frustumCulled = false;
    mk.renderOrder = 500;
    mk.userData = { elementType: MEASUREMENT_ELEMENT_TYPE, measurementId: id };
    _group.add(mk);
    objects.push(mk);
  });

  scheduleRender();
  return objects;
}

function _createDimSprite(text, position, distance, id) {
  const fontSize = 28;
  const padding = 8;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = buildCanvasFont(fontSize, { weight: 'bold' });
  const textW = Math.ceil(ctx.measureText(text).width) + padding * 2;
  const textH = fontSize + padding * 2;
  canvas.width = textW;
  // NOTE: canvas サイズ変更でコンテキスト状態がリセットされるため font を再設定する
  canvas.height = textH;
  ctx.fillStyle = 'rgba(34,85,204,0.85)';
  ctx.fillRect(0, 0, textW, textH);
  ctx.font = buildCanvasFont(fontSize, { weight: 'bold' });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, textW / 2, textH / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.frustumCulled = false;
  sprite.renderOrder = 510;
  const spriteH = Math.max(200, distance * 0.12);
  sprite.scale.set(spriteH * (textW / textH), spriteH, 1);
  sprite.position.copy(position);
  sprite.userData = { elementType: MEASUREMENT_ELEMENT_TYPE, measurementId: id, isDimText: true };
  return sprite;
}

/**
 * 指定オブジェクト群をグループから削除して dispose する
 * @param {THREE.Object3D[]} objects
 */
export function removeMeasurementObjects(objects) {
  if (!_group) return;
  for (const obj of objects) {
    _group.remove(obj);
    _disposeObject(obj);
  }
  scheduleRender();
}

/**
 * グループ内の全測定オブジェクトを削除する
 */
export function clearAllMeasurementObjects() {
  if (!_group) return;
  const children = [..._group.children];
  for (const obj of children) {
    _group.remove(obj);
    _disposeObject(obj);
  }
  scheduleRender();
}

function _disposeObject(obj) {
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) {
      obj.material.forEach((m) => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
    } else {
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  }
  if (obj.children && obj.children.length > 0) {
    [...obj.children].forEach(_disposeObject);
  }
}
