/**
 * @fileoverview 3Dラベル生成・管理モジュール
 *
 * このファイルは、3D空間内のラベル表示に関する機能を提供します:
 * - 要素情報を表示するためのラベルスプライトの生成
 * - カメラ視点に応じたラベル表示の動的調整
 * - ラベルの視認性と表示制御
 * - 各種要素（柱、梁、階、通り芯など）用の特殊ラベル
 * - ビューフラスタムとクリッピングに対応したラベル表示
 *
 * このモジュールは、3Dモデル内の要素に識別情報を付加し、
 * ユーザーの視点に合わせた読みやすいラベル表示を実現します。
 */

import * as THREE from 'three';
import { createLogger } from '../../utils/logger.js';
import { buildCanvasFont, getBaseFontFamily } from '../../utils/typography.js';
import { LABEL_SETTINGS, LABEL_OCCLUSION_SETTINGS } from '../../config/renderingConstants.js';
import { elementGroups } from '../core/core.js';

const log = createLogger('viewer/ui/labels');
let cachedOcclusionTargets = [];
let cachedOcclusionTargetsFrame = -1;

function getLabelOcclusionTargets() {
  return Object.values(elementGroups).filter((group) => group && group.visible !== false);
}

function getLabelOcclusionTargetsForFrame() {
  if (cachedOcclusionTargetsFrame !== globalFrameCounter) {
    cachedOcclusionTargets = getLabelOcclusionTargets();
    cachedOcclusionTargetsFrame = globalFrameCounter;
  }
  return cachedOcclusionTargets;
}

// オクルージョンチェック用のフレームカウンター
let globalFrameCounter = 0;
let lastFrameTime = 0;
const FRAME_TIME_MS = 1000 / 60; // 60FPS想定

/**
 * 指定されたテキストと位置を持つラベルスプライトを作成し、指定されたグループに追加する。
 * カメラからの距離に応じてスプライトのスケールを調整する。
 * StoryとAxisラベルはクリッピングの影響を受けない。 // コメント修正
 * StoryとAxisラベルはビュー範囲外判定をスキップする。 // コメント追加
 * @param {string} text - ラベルに表示するテキスト。
 * @param {THREE.Vector3} position - ラベルを表示する3D空間上の元の位置。
 * @param {THREE.Group} spriteGroup - 作成したスプライトを追加するグループ。
 * @param {string} elementType - ラベルが属する要素タイプ (表示制御用)。
 * @returns {THREE.Sprite|null} 作成されたラベルスプライト、またはエラー時にnull。
 */
export function createLabelSprite(text, position, spriteGroup, elementType, meta = {}) {
  const labelFontSize = LABEL_SETTINGS.FONT_SIZE;
  const labelCanvasWidth = LABEL_SETTINGS.CANVAS_WIDTH;
  const labelCanvasHeight = LABEL_SETTINGS.CANVAS_HEIGHT;
  const labelBaseScaleX = LABEL_SETTINGS.BASE_SCALE_X;
  const labelBaseScaleY = LABEL_SETTINGS.BASE_SCALE_Y;
  const labelOffsetX = LABEL_SETTINGS.OFFSET_X;
  const labelOffsetY = LABEL_SETTINGS.OFFSET_Y;
  const referenceDistance = LABEL_SETTINGS.REFERENCE_DISTANCE;
  const minScaleFactor = LABEL_SETTINGS.MIN_SCALE_FACTOR;
  const maxScaleFactor = LABEL_SETTINGS.MAX_SCALE_FACTOR;

  // 通り芯ラベル用の丸い背景設定
  const isAxisLabel = elementType === 'Axis';
  const isStoryLabel = elementType === 'Story';
  const balloonSize = LABEL_SETTINGS.BALLOON_SIZE;
  const balloonFontSize = LABEL_SETTINGS.BALLOON_FONT_SIZE;

  // 階ラベル用の四角い背景設定
  const storyBoxWidth = LABEL_SETTINGS.STORY_BOX_WIDTH;
  const storyBoxHeight = LABEL_SETTINGS.STORY_BOX_HEIGHT;
  const storyFontSize = LABEL_SETTINGS.STORY_FONT_SIZE;

  try {
    let canvas, ctx, baseScaleX, baseScaleY;

    if (isAxisLabel) {
      // 通り芯ラベル: 丸い背景（バルーン）付き
      canvas = document.createElement('canvas');
      canvas.width = balloonSize;
      canvas.height = balloonSize;
      ctx = canvas.getContext('2d');
      if (!ctx) {
        log.error('Failed to get 2D context for axis label canvas.');
        return null;
      }
      ctx.clearRect(0, 0, balloonSize, balloonSize);

      // 丸い背景を描画
      const centerX = balloonSize / 2;
      const centerY = balloonSize / 2;
      const radius = balloonSize / 2 - 4; // 余白を残す

      // 白い塗りつぶしの円
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();

      // 黒い円の縁
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 3;
      ctx.stroke();

      // テキストを描画（通り芯名のみ、@以降は省略）
      const displayText = text.includes('@') ? text.split('@')[0] : text;
      ctx.font = buildCanvasFont(balloonFontSize, { weight: 'bold' });
      ctx.fillStyle = 'black';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(displayText, centerX, centerY);

      baseScaleX = 200; // 丸いラベル用のスケール
      baseScaleY = 200;
    } else if (isStoryLabel) {
      // 階ラベル: 四角い背景付き
      canvas = document.createElement('canvas');
      canvas.width = storyBoxWidth;
      canvas.height = storyBoxHeight;
      ctx = canvas.getContext('2d');
      if (!ctx) {
        log.error('Failed to get 2D context for story label canvas.');
        return null;
      }
      ctx.clearRect(0, 0, storyBoxWidth, storyBoxHeight);

      // 四角い背景を描画
      const padding = 3;

      // 白い塗りつぶしの四角
      ctx.fillStyle = 'white';
      ctx.fillRect(padding, padding, storyBoxWidth - padding * 2, storyBoxHeight - padding * 2);

      // 黒い四角の縁
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 3;
      ctx.strokeRect(padding, padding, storyBoxWidth - padding * 2, storyBoxHeight - padding * 2);

      // テキストを描画（階名のみ）
      const displayText = text.includes('(') ? text.split('(')[0].trim() : text;
      ctx.font = buildCanvasFont(storyFontSize, { weight: 'bold' });
      ctx.fillStyle = 'black';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(displayText, storyBoxWidth / 2, storyBoxHeight / 2);

      baseScaleX = 250; // 四角いラベル用のスケール（通り芯と同程度の大きさ）
      baseScaleY = 150;
    } else {
      // 通常のラベル: 従来の横長キャンバス
      canvas = document.createElement('canvas');
      canvas.width = labelCanvasWidth;
      canvas.height = labelCanvasHeight;
      ctx = canvas.getContext('2d');
      if (!ctx) {
        log.error('Failed to get 2D context for label canvas.');
        return null;
      }
      ctx.clearRect(0, 0, labelCanvasWidth, labelCanvasHeight);
      ctx.font = buildCanvasFont(labelFontSize, { weight: 'bold' });
      // テキストを描画（透明背景）
      ctx.fillStyle = 'black';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // より太い白い縁取りでテキストの視認性を向上
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 5; // 縁取りを元の太さに戻す
      ctx.strokeText(text, labelOffsetX, labelOffsetY);

      // 黒いテキストを描画
      ctx.fillText(text, labelOffsetX, labelOffsetY);

      baseScaleX = labelBaseScaleX;
      baseScaleY = labelBaseScaleY;
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      sizeAttenuation: true,
      // ★★★ テスト用: 深度テストを一時的に無効化してみる ★★★
      // depthTest: true, // 通常はこちら
      depthTest: true, // <<< テストする場合はこちらを有効化 (他の要素との前後関係がおかしくなります)
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);

    const baseScale = new THREE.Vector3(baseScaleX, baseScaleY, 1);
    sprite.userData.baseScale = baseScale;
    sprite.userData.referenceDistance = referenceDistance;
    sprite.userData.minScaleFactor = minScaleFactor; // 更新された minScaleFactor を使用
    sprite.userData.maxScaleFactor = maxScaleFactor;
    sprite.userData.elementType = elementType;
    sprite.userData.originalPosition = position.clone();
    sprite.userData.isLabel = true;
    // store optional metadata for special handling (axis, story, model bounds, etc.)
    sprite.userData.meta = meta || {};

    // オクルージョンチェック用の状態
    sprite.userData.occlusionState = {
      lastCheckFrame: 0,
      lastCameraPosition: new THREE.Vector3(),
      lastCameraQuaternion: new THREE.Quaternion(),
      isOccluded: false,
      targetPushDistance: 0,
      currentPushDistance: 0,
      occludedFrameCount: 0,
      visibleFrameCount: 0,
    };

    // ラベルを要素から少し前面にオフセット
    const labelOffset = new THREE.Vector3(0, 0, 50); // Z方向に50mm前面に移動（元に戻す）
    const offsetPosition = position.clone().add(labelOffset);
    sprite.position.copy(offsetPosition);

    sprite.onBeforeRender = function (rendererInstance, scene, cameraInstance) {
      const originalPos = this.userData.originalPosition;
      const elementType = this.userData.elementType;
      const meta = this.userData.meta || {};

      // 全要素でカメラ方向に基づいた動的オフセットを適用
      const cameraDirection = new THREE.Vector3();
      cameraInstance.getWorldDirection(cameraDirection);
      cameraDirection.normalize();

      // カメラの方向に50mmオフセット
      const dynamicOffset = cameraDirection.clone().multiplyScalar(-50);
      const currentPos = originalPos.clone().add(dynamicOffset);

      // --- Axis label specific: 通り芯の端（レベル面の端）に固定配置 ---
      if (elementType === 'Axis' && meta && meta.axisType && meta.modelBounds) {
        try {
          const mb = meta.modelBounds;
          const min = new THREE.Vector3(mb.min.x, mb.min.y, mb.min.z);
          const max = new THREE.Vector3(mb.max.x, mb.max.y, mb.max.z);
          const size = new THREE.Vector3().subVectors(max, min);
          // 通り芯の延長距離（layout.jsのdrawAxes/drawStoriesと同じ計算式）
          // レベル面と通り芯のラインが同じ範囲になるように合わせる
          const extendXY = Math.max(size.x, size.y) * 0.15 + 500;
          // ラベル中心をレベル外形ライン上（通り芯の終端）に配置
          const labelMargin = 0;

          if (meta.axisType === 'X') {
            // X軸通り芯: Y方向の線の端（min.y側）に固定
            currentPos.x = meta.distance || originalPos.x;
            currentPos.y = min.y - extendXY - labelMargin;
            currentPos.z = meta.storyHeight !== undefined ? meta.storyHeight : originalPos.z;
          } else if (meta.axisType === 'Y') {
            // Y軸通り芯: X方向の線の端（min.x側）に固定
            currentPos.x = min.x - extendXY - labelMargin;
            currentPos.y = meta.distance || originalPos.y;
            currentPos.z = meta.storyHeight !== undefined ? meta.storyHeight : originalPos.z;
          }
        } catch (err) {
          log.warn('Axis label meta handling failed:', err);
        }
      }

      // --- Occlusion check with throttling and smoothing ---
      // フレームカウンターの更新（時間ベース）
      const now = performance.now();
      if (now - lastFrameTime > FRAME_TIME_MS) {
        globalFrameCounter++;
        lastFrameTime = now;
      }

      const state = this.userData.occlusionState;
      const settings = LABEL_OCCLUSION_SETTINGS;

      // カメラ移動/回転検出
      const cameraPos = cameraInstance.position.clone();
      const cameraQuat = cameraInstance.quaternion.clone();
      const cameraMoved =
        state.lastCameraPosition.distanceTo(cameraPos) > settings.CAMERA_MOVE_THRESHOLD;
      const cameraRotated =
        state.lastCameraQuaternion.angleTo(cameraQuat) > settings.CAMERA_ROTATE_THRESHOLD;

      // チェックを実行すべきか判定（間引き）
      const framesSinceLastCheck = globalFrameCounter - state.lastCheckFrame;
      const shouldCheck =
        cameraMoved || cameraRotated || framesSinceLastCheck >= settings.CHECK_INTERVAL_FRAMES;

      if (shouldCheck) {
        state.lastCheckFrame = globalFrameCounter;
        state.lastCameraPosition.copy(cameraPos);
        state.lastCameraQuaternion.copy(cameraQuat);

        try {
          let skipOcclusionRaycast = false;
          if (elementType !== 'Story' && elementType !== 'Axis') {
            const projectedCurrentPosition = currentPos.clone().project(cameraInstance);
            const occlusionMargin = 1.1;
            if (
              projectedCurrentPosition.x < -occlusionMargin ||
              projectedCurrentPosition.x > occlusionMargin ||
              projectedCurrentPosition.y < -occlusionMargin ||
              projectedCurrentPosition.y > occlusionMargin ||
              projectedCurrentPosition.z < -1 ||
              projectedCurrentPosition.z > 1
            ) {
              state.visibleFrameCount++;
              state.occludedFrameCount = 0;
              state.targetPushDistance = 0;
              skipOcclusionRaycast = true;
            }
          }

          const dirToLabel = new THREE.Vector3().subVectors(currentPos, cameraPos);
          const distance = dirToLabel.length();

          if (!skipOcclusionRaycast && distance > 0) {
            const ray = new THREE.Raycaster(cameraPos, dirToLabel.normalize(), 0.01, distance);
            ray.camera = cameraInstance;
            const intersects = ray.intersectObjects(getLabelOcclusionTargetsForFrame(), true);

            const firstBlocker = intersects.find((hit) => {
              if (!hit || !hit.object) return false;
              if (hit.object === this) return false;
              const t = hit.object.userData && hit.object.userData.elementType;
              if (t === 'Axis' || t === 'Story') return false;
              return true;
            });

            const isCurrentlyOccluded = !!firstBlocker;

            // ヒステリシス処理: 状態変化に連続フレーム数の閾値を設ける
            if (isCurrentlyOccluded) {
              state.occludedFrameCount++;
              state.visibleFrameCount = 0;
            } else {
              state.visibleFrameCount++;
              state.occludedFrameCount = 0;
            }

            // 状態変更判定（ヒステリシス閾値を超えた場合のみ変更）
            if (state.occludedFrameCount >= settings.HYSTERESIS_FRAMES && !state.isOccluded) {
              state.isOccluded = true;
              const pushDist = Math.min(
                settings.MAX_PUSH_DISTANCE,
                distance * settings.PUSH_DISTANCE_RATIO,
              );
              state.targetPushDistance = pushDist;
            } else if (state.visibleFrameCount >= settings.HYSTERESIS_FRAMES && state.isOccluded) {
              state.isOccluded = false;
              state.targetPushDistance = 0;
            }
          }
        } catch (err) {
          // Raycast失敗時は何もしない
        }
      }

      // 補間による滑らかな位置変化（毎フレーム実行）
      state.currentPushDistance = THREE.MathUtils.lerp(
        state.currentPushDistance,
        state.targetPushDistance,
        settings.LERP_FACTOR,
      );

      // 押し出し適用（最小閾値を超えた場合のみ）
      if (Math.abs(state.currentPushDistance) > 0.1) {
        const push = cameraDirection.clone().multiplyScalar(-state.currentPushDistance);
        currentPos.add(push);
      }

      const initialVisibility = this.userData.labelBaseVisible ?? this.visible; // UIによる表示状態
      let shouldBeVisible = initialVisibility; // 基本的にUIの状態に従う
      let isOutsideView = false;

      // --- ビュー範囲 (Frustum) チェック ---
      // shouldBeVisible が true で、かつ Story/Axis 以外の場合のみチェック
      if (shouldBeVisible && elementType !== 'Story' && elementType !== 'Axis') {
        // ... (frustum culling logic - unchanged) ...
        const worldPosition = new THREE.Vector3();
        this.getWorldPosition(worldPosition);
        const projectedPosition = worldPosition.clone().project(cameraInstance);
        const margin = 1.1;
        if (
          projectedPosition.x < -margin ||
          projectedPosition.x > margin ||
          projectedPosition.y < -margin ||
          projectedPosition.y > margin ||
          projectedPosition.z < -1 ||
          projectedPosition.z > 1
        ) {
          shouldBeVisible = false;
          isOutsideView = true;
        }
      }

      // --- デバッグログ (変更時のみ、かつUIで表示ONの場合) ---
      if (this.visible !== shouldBeVisible && initialVisibility) {
        let reason = '';
        // if (isClipped && elementType !== 'Story' && elementType !== 'Axis' && !shouldBeVisible) reason += `Clipped (${elementType}); `; // 削除
        if (isOutsideView && !shouldBeVisible) reason += 'Outside view; ';
        if (reason === '' && !shouldBeVisible) reason = 'Unknown reason; ';
      }

      // --- 最終設定 ---
      this.position.copy(currentPos);
      // UIによる表示状態とビュー範囲外判定のみで表示を決定
      this.visible = initialVisibility && shouldBeVisible;

      // --- スケール調整 ---
      if (this.visible) {
        // 全要素で動的スケール調整を適用
        const spriteWorldPosition = new THREE.Vector3();
        this.getWorldPosition(spriteWorldPosition);

        let scaleFactor;

        // 正投影カメラの場合はzoomプロパティを使用してスケールを調整
        if (cameraInstance.isOrthographicCamera) {
          // 正投影カメラではzoomが大きいほどオブジェクトが大きく見える
          // ラベルもzoomに応じてスケールする必要がある
          // zoom = 1.0 を基準として、zoomが2倍になればラベルも2倍小さくする
          const baseZoom = 1.0;
          scaleFactor = baseZoom / cameraInstance.zoom;
          // 正投影カメラでも最小/最大スケールを適用
          scaleFactor = Math.max(
            this.userData.minScaleFactor,
            Math.min(scaleFactor, this.userData.maxScaleFactor),
          );
        } else {
          // 透視投影カメラの場合は従来通り距離ベースでスケール
          const distance = spriteWorldPosition.distanceTo(cameraInstance.position);
          scaleFactor = distance / this.userData.referenceDistance;
          scaleFactor = Math.max(
            this.userData.minScaleFactor,
            Math.min(scaleFactor, this.userData.maxScaleFactor),
          );
        }

        this.scale.copy(this.userData.baseScale).multiplyScalar(scaleFactor);
      }
    };

    // 初期状態をチェックボックスの状態に基づいて設定
    const labelCheckbox = document.getElementById(`toggleLabel-${elementType}`);
    const shouldBeVisible = labelCheckbox ? labelCheckbox.checked : false;
    sprite.userData.labelBaseVisible = shouldBeVisible;
    sprite.visible = shouldBeVisible;

    if (spriteGroup) {
      spriteGroup.add(sprite);
    }
    return sprite;
  } catch (error) {
    log.error('Error creating label sprite:', error);
    return null;
  }
}

/**
 * @typedef {Object} LabelConfig
 * @property {string} text - ラベルテキスト
 * @property {{x: number, y: number, z: number}} position - ラベル位置
 * @property {string} elementType - 要素タイプ (例: 'Node', 'Column')
 * @property {string} elementId - 要素ID
 * @property {string} [modelSource='A'] - モデルソース ('A', 'B', 'matched')
 * @property {Object} [options={}] - 追加オプション
 * @property {number} [options.fontSize=16] - フォントサイズ
 * @property {string} [options.fontFamily] - フォントファミリー。省略時は共通UIフォント。
 * @property {string} [options.color='rgba(0, 0, 0, 1)'] - テキスト色
 * @property {number} [options.padding=6] - パディング
 */

/**
 * ラベル用のスプライトを作成する
 * @param {LabelConfig} config - ラベル設定
 * @returns {THREE.Sprite} 作成されたラベルスプライト
 */
export function createLabel(config) {
  const { text, position, elementType, elementId, modelSource = 'A', options = {} } = config;
  const { x, y, z } = position;

  const fontSize = options.fontSize || 16;
  const fontFamily = options.fontFamily || getBaseFontFamily();
  const textColor = options.color || 'rgba(0, 0, 0, 1)'; // デフォルトは黒
  const padding = options.padding || 6; // パディングを少し増加

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = `${fontSize}px ${fontFamily}`;

  // テキスト幅を測定
  const textMetrics = context.measureText(text);
  const textWidth = textMetrics.width;

  // キャンバスサイズを設定 (パディング込み)
  canvas.width = textWidth + padding * 2;
  canvas.height = fontSize + padding * 2; // 高さもフォントサイズとパディング基準に

  // 背景は透明のため描画をスキップ
  // （透明背景のため背景と境界線の描画は不要）

  // テキストを描画
  context.font = `${fontSize}px ${fontFamily}`; // 再度フォント設定 (重要)
  context.fillStyle = textColor;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  // より太い白い縁取りを追加（透明背景での視認性向上）
  context.strokeStyle = 'white';
  context.lineWidth = 4; // 縁取りを太くして視認性向上
  context.strokeText(text, canvas.width / 2, canvas.height / 2);

  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false, // 深度テスト無効化で常に前面表示
    depthWrite: false, // 深度バッファ書き込み無効
    alphaTest: 0.01, // 透明背景のため閾値を低く設定
    // レンダー順序を高く設定してより前面に表示
    renderOrder: 1000,
  });

  const sprite = new THREE.Sprite(material);

  // スプライトのスケールを調整して、画面上でのサイズ感を一定に保つ
  const scaleFactor = 0.1; // この値を調整して基本サイズを決める
  sprite.scale.set(canvas.width * scaleFactor, canvas.height * scaleFactor, 1.0);

  // ラベルを要素から少し前面にオフセット
  const labelOffset = new THREE.Vector3(0, 0, 25); // Z方向に25mm前面に移動
  sprite.position.set(x + labelOffset.x, y + labelOffset.y, z + labelOffset.z);

  // レンダー順序を設定
  sprite.renderOrder = 1000;

  // ユーザーデータに情報を追加
  sprite.userData = {
    ...sprite.userData, // 既存のuserDataを保持
    isLabel: true,
    elementType: elementType, // ラベルがどの要素タイプに属するか
    elementId: elementId, // 関連する要素のID
    modelSource: modelSource, // どのモデル由来か
    originalText: text, // 元のテキスト
    labelBaseVisible: false,
  };

  // 初期状態はチェックボックスの状態に基づいて設定
  const labelCheckbox = document.getElementById(`toggleLabel-${elementType}`);
  const shouldBeVisible = labelCheckbox ? labelCheckbox.checked : false;
  sprite.userData.labelBaseVisible = shouldBeVisible;
  sprite.visible = shouldBeVisible;

  return sprite;
}
