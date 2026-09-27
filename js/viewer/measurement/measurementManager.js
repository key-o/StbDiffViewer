/**
 * @fileoverview 寸法測定の状態管理モジュール（Layer 4: viewer）
 *
 * クリックベースの2点間距離測定フローを管理する。
 * 状態機械: IDLE → FIRST_PICKED → IDLE（測定完了で次へ継続）
 *
 * UI層には依存せず、EventBus 経由でのみ通知する。
 * DOM操作（CSSクラス付与等）は MODE_ENTERED / MODE_EXITED を受けた ui 層が行う。
 */

import * as THREE from 'three';
import { scene } from '../index.js';
import { eventBus, MeasurementEvents } from '../../data/events/index.js';
import { ELEMENT_LABELS } from '../../config/elementLabels.js';
import { scheduleRender } from '../../utils/renderScheduler.js';
import {
  initMeasurementGroup,
  renderNormalIndicator,
  renderDimensionLine,
  removeMeasurementObjects,
  clearAllMeasurementObjects,
} from './measurementRenderer.js';

const State = { IDLE: 'idle', FIRST_PICKED: 'firstPicked' };

let _state = State.IDLE;
let _isActive = false;
let _firstPoint = null;
let _firstNormal = null;
let _tempObjects = [];
/** @type {Array<{id:number, p1:THREE.Vector3, p2:THREE.Vector3, normal:THREE.Vector3, distance:number, objects:THREE.Object3D[]}>} */
let _measurements = [];
let _nextId = 1;
let _sharedEventsBound = false;

/**
 * 測定マネージャーを初期化する（アプリ起動時に1度呼ぶ）
 */
export function initMeasurementManager() {
  initMeasurementGroup(scene);
  if (!_sharedEventsBound) {
    eventBus.on(MeasurementEvents.DELETE_REQUESTED, ({ id } = {}) => deleteMeasurement(id));
    eventBus.on(MeasurementEvents.SEQUENCE_RESET, resetPendingMeasurementSequence);
    _sharedEventsBound = true;
  }
}

/**
 * 未完了の1点目だけを破棄する。
 * 完了済み寸法は保持し、3D/PDFの描画面切替時に古い1点目を持ち越さない。
 */
export function resetPendingMeasurementSequence() {
  const hadPending =
    _state === State.FIRST_PICKED ||
    _firstPoint !== null ||
    _firstNormal !== null ||
    _tempObjects.length > 0;

  if (_tempObjects.length > 0) {
    removeMeasurementObjects(_tempObjects);
    _tempObjects = [];
  }
  _firstPoint = null;
  _firstNormal = null;
  _state = State.IDLE;

  if (hadPending) scheduleRender();
}

/** 測定モードが有効かを返す */
export function isMeasurementModeActive() {
  return _isActive;
}

/** 現在の測定ステップを返す（'idle' | 'firstPicked'） */
export function getMeasurementStep() {
  return _state;
}

/** 測定モードを有効化する */
export function enterMeasurementMode() {
  if (_isActive) return;
  _isActive = true;
  _state = State.IDLE;
  eventBus.emit(MeasurementEvents.MODE_ENTERED);
}

/**
 * 測定モードを解除し全測定をクリアする
 * emit 順序: MODE_EXITED → ALL_CLEARED
 * （UI側で _isActive を先に false にしてから clear を処理させる）
 */
export function exitMeasurementMode() {
  if (!_isActive) return;
  _isActive = false;
  _state = State.IDLE;

  // 一時オブジェクトを明示的に dispose してからグループ全体をクリア
  if (_tempObjects.length > 0) {
    removeMeasurementObjects(_tempObjects);
    _tempObjects = [];
  }
  _firstPoint = null;
  _firstNormal = null;
  _measurements = [];
  _nextId = 1;

  clearAllMeasurementObjects();

  // MODE_EXITED を先に emit して UI の isActive を false にしてから ALL_CLEARED を通知する
  eventBus.emit(MeasurementEvents.MODE_EXITED);
  eventBus.emit(MeasurementEvents.ALL_CLEARED);
}

/**
 * クリックイベントを受け取り測定フローを進める
 * interactionController から委譲される
 * @param {import('three').Intersection} intersection
 */
export function handleMeasurementClick(intersection) {
  if (!_isActive || !intersection) return;

  if (_state === State.IDLE) {
    _handleFirstPick(intersection);
  } else if (_state === State.FIRST_PICKED) {
    _handleSecondPick(intersection);
  }
}

function _handleFirstPick(intersection) {
  // PDF側に未完了の1点目が残っていても、新しい3D測定へ持ち越さない。
  eventBus.emit(MeasurementEvents.SEQUENCE_RESET, {
    targetSurface: '3d',
    reason: 'first-pick',
  });

  let worldNormal;
  if (intersection.face && intersection.face.normal) {
    worldNormal = intersection.face.normal
      .clone()
      .transformDirection(intersection.object.matrixWorld)
      .normalize();
  } else {
    worldNormal = new THREE.Vector3(0, 1, 0);
  }

  worldNormal = _snapToAxis(worldNormal);

  _firstPoint = intersection.point.clone();
  _firstNormal = worldNormal;

  if (_tempObjects.length > 0) {
    removeMeasurementObjects(_tempObjects);
    _tempObjects = [];
  }

  _tempObjects = renderNormalIndicator(_firstPoint, _firstNormal);
  _state = State.FIRST_PICKED;

  const ud = intersection.object?.userData || {};
  const elementType = ud.elementType || ud.stbNodeType || null;
  const elementLabel = elementType ? ELEMENT_LABELS[elementType] || elementType : null;
  const elementName = ud.name || ud.label || null;
  const rawSource = ud.modelSource || null;
  const modelSide =
    rawSource === 'A' || rawSource === 'onlyA'
      ? 'A'
      : rawSource === 'B' || rawSource === 'onlyB'
        ? 'B'
        : rawSource === 'matched'
          ? 'A/B'
          : null;

  eventBus.emit(MeasurementEvents.FIRST_POINT_PICKED, {
    point: _firstPoint.clone(),
    normal: _firstNormal.clone(),
    surface: '3d',
    elementInfo: { elementType, elementLabel, elementName, modelSide },
  });
}

function _handleSecondPick(intersection) {
  const p2 = intersection.point.clone();
  const diff = p2.clone().sub(_firstPoint);
  const distance = Math.abs(diff.dot(_firstNormal));

  // 1mm 未満は同一点とみなして無視し、次のクリックを待つ
  if (distance < 1) return;

  removeMeasurementObjects(_tempObjects);
  _tempObjects = [];

  const id = _nextId++;
  const objects = renderDimensionLine(_firstPoint, p2, _firstNormal, distance, id);

  _measurements.push({
    id,
    p1: _firstPoint.clone(),
    p2: p2.clone(),
    normal: _firstNormal.clone(),
    distance,
    objects,
  });

  eventBus.emit(MeasurementEvents.MEASUREMENT_COMPLETED, {
    id,
    distance,
    p1: _firstPoint.clone(),
    p2: p2.clone(),
  });

  _firstPoint = null;
  _firstNormal = null;
  _state = State.IDLE;

  scheduleRender();
}

/**
 * 指定IDの測定を削除する
 * @param {number} id
 */
export function deleteMeasurement(id) {
  const idx = _measurements.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const [entry] = _measurements.splice(idx, 1);
  removeMeasurementObjects(entry.objects);
  eventBus.emit(MeasurementEvents.MEASUREMENT_DELETED, { id });
}

/**
 * 法線ベクトルを最も近い座標軸に揃える（各成分の絶対値が 0.94 以上なら軸に）
 * @param {THREE.Vector3} v
 * @returns {THREE.Vector3}
 */
function _snapToAxis(v) {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  const max = Math.max(ax, ay, az);
  const threshold = 0.94; // ≈ cos(20°)
  if (max < threshold) return v.clone().normalize();
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(v.x), 0, 0);
  if (ay >= ax && ay >= az) return new THREE.Vector3(0, Math.sign(v.y), 0);
  return new THREE.Vector3(0, 0, Math.sign(v.z));
}
