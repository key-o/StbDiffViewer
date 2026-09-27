/**
 * @fileoverview 3D節点ピックサービス
 *
 * 「3Dビューで節点をクリックして選ぶ」ピックモードの状態管理と、
 * 選択中節点のハイライト表示を提供する。AddMemberForm から利用する。
 *
 * interactionController はクリック時に getState('ui.nodePick') を見て
 * 通常選択を抑止し、InteractionEvents.NODE_PICKED を発行する。本サービスは
 * その通知を購読してコールバックへ橋渡しするだけで、3Dシーンの選択状態は持たない。
 *
 * ハイライトは節点座標に専用マーカー球をオーバーレイする方式とする。
 * （節点は大規模モデルで InstancedMesh 描画されるため、メッシュのマテリアル差し替えでは
 *  個別インスタンスを強調できず、既存の選択ハイライトとも干渉するため。）
 *
 * @module ui/panels/element-info/nodePickService
 */

import * as THREE from 'three';
import { createLogger } from '../../../utils/logger.js';
import { getState, setState } from '../../../data/state/globalState.js';
import { eventBus, InteractionEvents } from '../../../data/events/index.js';
import editDocumentProvider from '../../../app/editing/editDocumentProvider.js';
import { scene, requestRender } from '../../../viewer/index.js';
import { showInfo } from '../../common/toast.js';

const log = createLogger('ui:panels:node-pick');

/** ハイライトマーカーの色・サイズ（節点球 r=50 より一回り大きく） */
const MARKER_COLOR = 0xff3b30;
const MARKER_RADIUS = 95;

/** @type {THREE.Group|null} ハイライトマーカーを束ねるグループ */
let highlightGroup = null;
/** @type {THREE.SphereGeometry|null} 共有マーカージオメトリ */
let markerGeometry = null;
/** @type {THREE.MeshBasicMaterial|null} 共有マーカーマテリアル */
let markerMaterial = null;

/** NODE_PICKED 購読ハンドラ参照（cancelPick で解除する） */
let activePickHandler = null;

/**
 * ピックモードを開始する。次に3Dビューで節点がクリックされると onPicked が呼ばれる。
 * 連続ピック（柱の上下端を続けて選ぶ）に備え、自動では解除しない。終わったら cancelPick を呼ぶこと。
 * @param {(payload: {nodeId: string, idA: string|null, idB: string|null}) => void} onPicked
 */
export function beginPick(onPicked) {
  cancelPick();
  setState('ui.nodePick', { active: true });
  document.body.classList.add('node-pick-active');

  activePickHandler = (payload) => {
    if (payload && payload.nodeId != null && payload.nodeId !== '') {
      onPicked(payload);
    }
  };
  eventBus.on(InteractionEvents.NODE_PICKED, activePickHandler);
  showInfo('3Dビューで節点をクリックしてください');
  log.info('節点ピックモード開始');
}

/**
 * ピックモードを終了する（購読解除・state解除・カーソル復帰）。
 */
export function cancelPick() {
  if (activePickHandler) {
    eventBus.off(InteractionEvents.NODE_PICKED, activePickHandler);
    activePickHandler = null;
  }
  setState('ui.nodePick', { active: false });
  document.body.classList.remove('node-pick-active');
}

/**
 * 現在ピックモード中か。
 * @returns {boolean}
 */
export function isPicking() {
  return !!getState('ui.nodePick')?.active;
}

/**
 * マーカー用の共有ジオメトリ／マテリアルを遅延生成する。
 * @returns {{geometry: THREE.SphereGeometry, material: THREE.MeshBasicMaterial}}
 */
function getMarkerAssets() {
  if (!markerGeometry) markerGeometry = new THREE.SphereGeometry(MARKER_RADIUS, 16, 12);
  if (!markerMaterial) {
    markerMaterial = new THREE.MeshBasicMaterial({
      color: MARKER_COLOR,
      transparent: true,
      opacity: 0.55,
      depthTest: false, // 部材に隠れても見えるように
    });
  }
  return { geometry: markerGeometry, material: markerMaterial };
}

/**
 * ハイライトグループを取得（無ければ生成してシーンに追加）。
 * @returns {THREE.Group}
 */
function getHighlightGroup() {
  // モデル再読込等で現在の scene から切り離された場合は作り直す（孤立グループ防止）
  if (!highlightGroup || highlightGroup.parent !== scene) {
    highlightGroup = new THREE.Group();
    highlightGroup.name = 'add-member-node-highlight';
    // elementType を持たないため通常の選択・ピックのレイキャスト対象にならない
    highlightGroup.userData = { isHelper: true };
    scene.add(highlightGroup);
  }
  return highlightGroup;
}

/**
 * 指定した節点群をマーカーでハイライト表示する（既存マーカーは置き換える）。
 * @param {Array<string|null|undefined>} nodeIds
 */
export function highlightNodes(nodeIds) {
  clearHighlights();
  const ids = (Array.isArray(nodeIds) ? nodeIds : [nodeIds]).filter((v) => v != null && v !== '');
  if (ids.length === 0) return;

  const group = getHighlightGroup();
  const { geometry, material } = getMarkerAssets();
  for (const id of ids) {
    const coords = getNodeCoords(id);
    if (!coords) continue;
    const x = Number(coords.X);
    const y = Number(coords.Y);
    const z = Number(coords.Z);
    if (![x, y, z].every(Number.isFinite)) continue;

    const marker = new THREE.Mesh(geometry, material);
    marker.position.set(x, y, z);
    marker.renderOrder = 999;
    marker.userData = { isHelper: true };
    group.add(marker);
  }
  requestRender();
}

/**
 * ハイライトマーカーを全て除去する（共有ジオメトリ／マテリアルは保持）。
 */
export function clearHighlights() {
  if (!highlightGroup) return;
  for (const child of [...highlightGroup.children]) {
    highlightGroup.remove(child);
  }
  requestRender();
}

/**
 * active edit document から節点IDの座標 {X,Y,Z} を取得する（スナップ・マーカー配置用）。
 * @param {string} nodeId
 * @returns {{X: string, Y: string, Z: string}|null}
 */
export function getNodeCoords(nodeId) {
  const doc = editDocumentProvider.getActiveEditDocument();
  if (!doc || nodeId == null) return null;
  const node = doc.querySelector(`StbNode[id="${String(nodeId).replace(/"/g, '\\"')}"]`);
  if (!node) return null;
  return {
    X: node.getAttribute('X') ?? '',
    Y: node.getAttribute('Y') ?? '',
    Z: node.getAttribute('Z') ?? '',
  };
}
