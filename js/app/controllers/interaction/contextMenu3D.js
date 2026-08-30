/**
 * @fileoverview 3Dビューコンテキストメニューモジュール
 *
 * 3Dビューでの右クリックメニュー表示と、メニューアクション
 * （非表示、プロパティコピー、セクションボックス、フォーカス）を処理します。
 *
 * 選択状態は interactionController が保持するため、必要な操作は
 * deps（依存性注入）経由で受け取ります。
 *
 * @typedef {Object} ContextMenu3DDeps
 * @property {Function} performRaycast - レイキャスト実行関数
 * @property {Function} getSelectedObjects - 現在の選択オブジェクト配列を返す関数
 * @property {Function} resetSelection - 選択リセット関数
 * @property {Function} selectElement3D - 単一要素選択関数
 * @property {Function} getContextMenuActionCallback - アクションコールバックを返す関数
 */

import * as THREE from 'three';
import { createLogger, WarnCategory } from '../../../utils/logger.js';
import { camera, controls } from '../../../viewer/index.js';
import { eventBus, InteractionEvents } from '../../../data/events/index.js';
import { findSelectableAncestor } from './selectionInfoUtils.js';

const logger = createLogger('interaction:contextMenu3D');

/** @type {Set<THREE.Object3D>} 3Dコンテキストメニューで非表示にした要素の台帳 */
const hiddenContextMenuObjects = new Set();

/**
 * 3Dビューでの右クリック（コンテキストメニュー）を処理
 * @param {MouseEvent} event - マウスイベント
 * @param {Function} scheduleRender - 再描画要求関数
 * @param {ContextMenu3DDeps} deps - 依存サービス群
 */
export function handleContextMenu(event, scheduleRender, deps) {
  const intersects = deps.performRaycast(event);
  if (!intersects) return;

  // 選択可能なオブジェクトを探す
  let targetObject = null;
  for (const hit of intersects) {
    const selectable = findSelectableAncestor(hit.object);
    if (selectable) {
      targetObject = selectable;
      break;
    }
  }

  if (targetObject) {
    // オブジェクトがまだ選択されていなければ選択する
    if (!deps.getSelectedObjects().includes(targetObject)) {
      deps.selectElement3D(targetObject, scheduleRender, { addToSelection: false });
    }

    // コンテキストメニューを表示
    show3DContextMenu(event.clientX, event.clientY, targetObject, scheduleRender, deps);
  } else {
    // 空の領域を右クリックした場合は汎用メニューを表示
    showEmpty3DContextMenu(event.clientX, event.clientY, scheduleRender, deps);
  }
}

/**
 * 3Dビューの要素用コンテキストメニューを表示
 * @param {number} x - X座標
 * @param {number} y - Y座標
 * @param {THREE.Object3D} targetObject - 対象オブジェクト
 * @param {Function} scheduleRender - 再描画要求関数
 * @param {ContextMenu3DDeps} deps - 依存サービス群
 */
function show3DContextMenu(x, y, targetObject, scheduleRender, deps) {
  const selectedCount = deps.getSelectedObjects().length;
  const isMultipleSelected = selectedCount > 1;

  const menuItems = [
    {
      label: isMultipleSelected ? `${selectedCount}個の要素を非表示` : '要素を非表示',
      icon: '👁️',
      action: () => handle3DHideElements(scheduleRender, deps),
    },
    { separator: true },
    {
      label: 'セクションボックスをかける',
      icon: '📦',
      action: () => handleActivateSectionBoxForSelection(deps),
    },
    { separator: true },
    {
      label: '選択をリセット',
      icon: '🔄',
      action: () => {
        deps.resetSelection(scheduleRender);
      },
    },
    { separator: true },
    {
      label: 'プロパティをコピー',
      icon: '📋',
      action: () => handle3DCopyProperties(targetObject, deps),
      disabled: isMultipleSelected,
    },
    {
      label: 'この要素にフォーカス',
      icon: '🎯',
      action: () => handle3DFocusElement(targetObject),
      disabled: isMultipleSelected,
    },
    { separator: true },
    ...buildDisplayWindowMenuItems(),
  ];

  // 大梁/小梁は貫通孔配置可能範囲図を表示できる
  const elementType = targetObject.userData?.elementType;
  if (!isMultipleSelected && (elementType === 'Girder' || elementType === 'Beam')) {
    menuItems.push(
      { separator: true },
      {
        label: '貫通孔 配置可能範囲図',
        icon: '⭕',
        action: () =>
          eventBus.emit(InteractionEvents.OPEN_BEAM_OPENING_DIAGRAM, {
            elementType,
            elementId: targetObject.userData?.elementId,
            elementIdA: targetObject.userData?.elementIdA,
            elementIdB: targetObject.userData?.elementIdB,
            modelSource: targetObject.userData?.modelSource,
          }),
      },
    );
  }

  eventBus.emit(InteractionEvents.SHOW_CONTEXT_MENU, { x, y, menuItems });
}

/**
 * 表示系ウィンドウ（要素情報 / 表示要素設定 / 色分けモード設定）を開くメニュー項目を返す。
 * 各項目は OPEN_WINDOW イベントを発行し、UI層でウィンドウを表示する（R1遵守）。
 * @returns {Array<Object>} メニュー項目の配列
 */
function buildDisplayWindowMenuItems() {
  const windows = [
    { label: '要素情報', icon: '📋', windowId: 'component-info' },
    { label: '表示要素設定', icon: '🏗️', windowId: 'element-settings-float' },
    { label: '色分けモード設定', icon: '🎨', windowId: 'display-settings-float' },
  ];
  return windows.map(({ label, icon, windowId }) => ({
    label,
    icon,
    action: () => eventBus.emit(InteractionEvents.OPEN_WINDOW, { windowId }),
  }));
}

/**
 * 空の3Dビュー領域用コンテキストメニューを表示
 * @param {number} x - X座標
 * @param {number} y - Y座標
 * @param {Function} scheduleRender - 再描画要求関数
 * @param {ContextMenu3DDeps} deps - 依存サービス群
 */
function showEmpty3DContextMenu(x, y, scheduleRender, deps) {
  const hasSelection = deps.getSelectedObjects().length > 0;
  const hasHiddenObjects = hiddenContextMenuObjects.size > 0;

  const menuItems = [
    ...(hasHiddenObjects
      ? [
          {
            label: '非表示要素を元に戻す',
            icon: '👁️',
            action: () => restoreHiddenContextMenuElements(scheduleRender),
          },
          { separator: true },
        ]
      : []),
    {
      label: '選択をリセット',
      icon: '🔄',
      action: () => {
        deps.resetSelection(scheduleRender);
      },
      disabled: !hasSelection,
    },
    { separator: true },
    {
      label: 'ビューをリセット',
      icon: '🏠',
      action: () => {
        if (controls && typeof controls.reset === 'function') {
          controls.reset();
          if (scheduleRender) scheduleRender();
        }
      },
    },
    { separator: true },
    ...buildDisplayWindowMenuItems(),
  ];

  eventBus.emit(InteractionEvents.SHOW_CONTEXT_MENU, { x, y, menuItems });
}

/**
 * 3Dビューで選択された要素を非表示にする
 * @param {Function} scheduleRender - 再描画要求関数
 * @param {ContextMenu3DDeps} deps - 依存サービス群
 */
function handle3DHideElements(scheduleRender, deps) {
  const selectedObjects = deps.getSelectedObjects();
  if (selectedObjects.length === 0) return;

  const elementsToHide = selectedObjects.map((obj) => ({
    elementType: obj.userData?.elementType,
    elementId: obj.userData?.elementId,
    modelSource: obj.userData?.modelSource,
    object: obj,
  }));

  // 非表示にする
  selectedObjects.forEach((obj) => {
    obj.visible = false;
    hiddenContextMenuObjects.add(obj);
  });

  // 選択をリセット
  deps.resetSelection(scheduleRender);

  // コールバックを呼び出す
  const callback = deps.getContextMenuActionCallback();
  if (callback) {
    callback({
      action: 'hide',
      multiple: elementsToHide.length > 1,
      elements: elementsToHide,
    });
  }

  if (scheduleRender) scheduleRender();
}

/**
 * 3Dコンテキストメニューで非表示にした要素を元に戻す
 * @param {Function} scheduleRender - 再描画要求関数
 */
function restoreHiddenContextMenuElements(scheduleRender) {
  const hiddenObjects = Array.from(hiddenContextMenuObjects);
  if (hiddenObjects.length === 0) return;

  hiddenObjects.forEach((obj) => {
    obj.visible = true;
    hiddenContextMenuObjects.delete(obj);
  });

  if (scheduleRender) scheduleRender();
}

/**
 * 3Dオブジェクトのプロパティをクリップボードにコピー
 * @param {THREE.Object3D} targetObject - 対象オブジェクト
 * @param {ContextMenu3DDeps} deps - 依存サービス群
 */
function handle3DCopyProperties(targetObject, deps) {
  const userData = targetObject.userData || {};

  const properties = {
    タイプ: userData.elementType || '-',
    ID: userData.elementId || '-',
    名前: userData.name || '-',
    GUID: userData.guid || '-',
    ステータス:
      userData.modelSource === 'matched'
        ? '一致'
        : userData.modelSource === 'onlyA'
          ? 'Aのみ'
          : userData.modelSource === 'onlyB'
            ? 'Bのみ'
            : '-',
  };

  // 位置情報を追加
  if (targetObject.position) {
    properties['位置'] =
      `(${targetObject.position.x.toFixed(2)}, ${targetObject.position.y.toFixed(2)}, ${targetObject.position.z.toFixed(2)})`;
  }

  // 断面情報があれば追加
  if (userData.section) {
    properties['断面'] = userData.section;
  }

  const text = Object.entries(properties)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  navigator.clipboard
    .writeText(text)
    .then(() => {
      const callback = deps.getContextMenuActionCallback();
      if (callback) {
        callback({
          action: 'copyProperties',
          success: true,
          properties: properties,
        });
      }
    })
    .catch((err) => {
      logger.error('クリップボードへのコピーに失敗しました:', err);
    });
}

/**
 * 選択要素にセクションボックスを適用する
 * @param {ContextMenu3DDeps} deps - 依存サービス群
 */
function handleActivateSectionBoxForSelection(deps) {
  const selectedObjects = deps.getSelectedObjects();
  if (selectedObjects.length === 0) return;

  const box = new THREE.Box3();
  for (const obj of selectedObjects) {
    const mainObj = findSelectableAncestor(obj) || obj;
    const objBox = new THREE.Box3().setFromObject(mainObj);
    if (!objBox.isEmpty()) {
      box.union(objBox);
    }
  }

  if (box.isEmpty()) {
    logger.warn(`${WarnCategory.UI} セクションボックス: バウンディングボックスが空です`);
    return;
  }

  eventBus.emit(InteractionEvents.ACTIVATE_SECTION_BOX_FOR_SELECTION, { box3: box });
}

/**
 * 要素にカメラをフォーカスする
 * @param {THREE.Object3D} targetObject - 対象オブジェクト
 */
function handle3DFocusElement(targetObject) {
  if (!targetObject || !controls) return;

  // バウンディングボックスを計算
  const box = new THREE.Box3().setFromObject(targetObject);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // カメラターゲットを要素の中心に設定
  if (controls.target) {
    controls.target.copy(center);
  }

  // 適切な距離を計算
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = camera.fov * (Math.PI / 180);
  let cameraDistance = maxDim / (2 * Math.tan(fov / 2));
  cameraDistance = Math.max(cameraDistance * 2, 5); // 最小距離を確保

  // カメラ位置を更新
  const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  camera.position.copy(center).add(direction.multiplyScalar(cameraDistance));

  controls.update();
}
