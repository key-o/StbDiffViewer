/**
 * @fileoverview 建築レイアウト要素描画モジュール
 *
 * このファイルは、建築モデルの補助的なレイアウト要素の描画機能を提供します:
 * - 通り芯（X軸・Y軸）の平面表示
 * - 階（ストーリー）の平面表示
 * - レイアウト要素へのラベル付与
 * - 建築モデルの基準面表示
 *
 * これらのレイアウト要素は、モデルを理解するための空間的な参照を提供し、
 * クリッピング機能と連携することで特定の通り芯や階での断面表示を可能にします。
 */

import * as THREE from 'three';
import { createLabelSprite } from './labels.js';
import { colorManager } from '../rendering/colorManager.js';
import { AXIS_LINE_PATTERN } from '../../config/renderingConstants.js';
import { createLogger } from '../../utils/logger.js';
import { buildCanvasFont } from '../../utils/typography.js';
import { disposeRecursive } from '../utils/ResourceDisposer.js';

const log = createLogger('viewer:annotations:layout');

/**
 * 平行通り芯間の寸法（引出線・寸法線・矢印・テキスト）を描画する
 * @param {Array} sortedAxes - 座標順にソートされた平行通り芯の配列
 * @param {'X'|'Y'} axisType - 通り芯の種類（X: Y軸平行、Y: X軸平行）
 * @param {THREE.Group} group - 描画対象グループ
 * @param {number} z - Z座標
 * @param {THREE.Box3} modelBounds - モデルバウンディングボックス
 * @param {number} extendXY - 通り芯の延長量（mm）
 */
function drawAxisDimensions(sortedAxes, axisType, group, z, modelBounds, extendXY) {
  if (sortedAxes.length < 2) return;

  const dimMaterial = new THREE.LineBasicMaterial({ color: 0x555555, linewidth: 1 });
  const arrowLen = Math.max(150, extendXY * 0.08);
  const arrowAngle = Math.PI / 6;
  const dimGap = Math.max(500, extendXY * 0.4);
  const extLineOffset = 200;

  function addLine(p1, p2) {
    const verts = new Float32Array([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const line = new THREE.Line(geo, dimMaterial);
    line.frustumCulled = false;
    line.userData = { elementType: 'Axis', isDimension: true };
    group.add(line);
  }

  // 水平寸法線用矢印（direction: +1=右向き, -1=左向き）
  function addArrowH(x, y, direction) {
    const wingX = x - direction * arrowLen * Math.cos(arrowAngle);
    const wingY = arrowLen * Math.sin(arrowAngle);
    const verts = new Float32Array([x, y, z, wingX, y + wingY, z, x, y, z, wingX, y - wingY, z]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const line = new THREE.LineSegments(geo, dimMaterial);
    line.frustumCulled = false;
    line.userData = { elementType: 'Axis', isDimension: true };
    group.add(line);
  }

  // 垂直寸法線用矢印（direction: +1=上向き, -1=下向き）
  function addArrowV(x, y, direction) {
    const wingY = y + direction * arrowLen * Math.cos(arrowAngle);
    const wingX = arrowLen * Math.sin(arrowAngle);
    const verts = new Float32Array([x, y, z, x + wingX, wingY, z, x, y, z, x - wingX, wingY, z]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const line = new THREE.LineSegments(geo, dimMaterial);
    line.frustumCulled = false;
    line.userData = { elementType: 'Axis', isDimension: true };
    group.add(line);
  }

  function createDimSprite(text, position) {
    const fontSize = 28;
    const padding = 6;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = buildCanvasFont(fontSize);
    const textW = Math.ceil(ctx.measureText(text).width) + padding * 2;
    const textH = fontSize + padding * 2;
    canvas.width = textW;
    canvas.height = textH;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(0, 0, textW, textH);
    ctx.font = buildCanvasFont(fontSize);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#333333';
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
    const spriteH = dimGap * 0.5;
    sprite.scale.set(spriteH * (textW / textH), spriteH, 1);
    sprite.position.copy(position);
    sprite.userData = { elementType: 'Axis', isDimension: true, isDimText: true };
    return sprite;
  }

  const min = modelBounds.min;

  if (axisType === 'X') {
    const baseY = min.y - extendXY;
    const level1Y = baseY - extLineOffset - dimGap;
    const level2Y = level1Y - dimGap;

    // 引出線（各通り芯から level2Y まで）
    sortedAxes.forEach((axis) => {
      const x = Number.isFinite(axis.x) ? axis.x : axis.distance;
      addLine(new THREE.Vector3(x, baseY - extLineOffset, z), new THREE.Vector3(x, level2Y, z));
    });

    // 隣接間 寸法線・矢印・テキスト
    for (let i = 0; i < sortedAxes.length - 1; i++) {
      const x1 = Number.isFinite(sortedAxes[i].x) ? sortedAxes[i].x : sortedAxes[i].distance;
      const x2 = Number.isFinite(sortedAxes[i + 1].x)
        ? sortedAxes[i + 1].x
        : sortedAxes[i + 1].distance;
      const dist = Math.round(Math.abs(x2 - x1));
      if (dist === 0) continue;

      addLine(new THREE.Vector3(x1, level1Y, z), new THREE.Vector3(x2, level1Y, z));
      addArrowH(x1, level1Y, +1);
      addArrowH(x2, level1Y, -1);
      group.add(createDimSprite(`${dist}`, new THREE.Vector3((x1 + x2) / 2, level1Y, z)));
    }

    // 累計 寸法線
    const xFirst = Number.isFinite(sortedAxes[0].x) ? sortedAxes[0].x : sortedAxes[0].distance;
    const xLast = Number.isFinite(sortedAxes[sortedAxes.length - 1].x)
      ? sortedAxes[sortedAxes.length - 1].x
      : sortedAxes[sortedAxes.length - 1].distance;
    const total = Math.round(Math.abs(xLast - xFirst));
    if (total > 0) {
      addLine(new THREE.Vector3(xFirst, level2Y, z), new THREE.Vector3(xLast, level2Y, z));
      addArrowH(xFirst, level2Y, +1);
      addArrowH(xLast, level2Y, -1);
      group.add(createDimSprite(`${total}`, new THREE.Vector3((xFirst + xLast) / 2, level2Y, z)));
    }
  } else {
    const baseX = min.x - extendXY;
    const level1X = baseX - extLineOffset - dimGap;
    const level2X = level1X - dimGap;

    // 引出線（各通り芯から level2X まで）
    sortedAxes.forEach((axis) => {
      const y = Number.isFinite(axis.y) ? axis.y : axis.distance;
      addLine(new THREE.Vector3(baseX - extLineOffset, y, z), new THREE.Vector3(level2X, y, z));
    });

    // 隣接間 寸法線・矢印・テキスト
    for (let i = 0; i < sortedAxes.length - 1; i++) {
      const y1 = Number.isFinite(sortedAxes[i].y) ? sortedAxes[i].y : sortedAxes[i].distance;
      const y2 = Number.isFinite(sortedAxes[i + 1].y)
        ? sortedAxes[i + 1].y
        : sortedAxes[i + 1].distance;
      const dist = Math.round(Math.abs(y2 - y1));
      if (dist === 0) continue;

      addLine(new THREE.Vector3(level1X, y1, z), new THREE.Vector3(level1X, y2, z));
      addArrowV(level1X, y1, +1);
      addArrowV(level1X, y2, -1);
      group.add(createDimSprite(`${dist}`, new THREE.Vector3(level1X, (y1 + y2) / 2, z)));
    }

    // 累計 寸法線
    const yFirst = Number.isFinite(sortedAxes[0].y) ? sortedAxes[0].y : sortedAxes[0].distance;
    const yLast = Number.isFinite(sortedAxes[sortedAxes.length - 1].y)
      ? sortedAxes[sortedAxes.length - 1].y
      : sortedAxes[sortedAxes.length - 1].distance;
    const total = Math.round(Math.abs(yLast - yFirst));
    if (total > 0) {
      addLine(new THREE.Vector3(level2X, yFirst, z), new THREE.Vector3(level2X, yLast, z));
      addArrowV(level2X, yFirst, +1);
      addArrowV(level2X, yLast, -1);
      group.add(createDimSprite(`${total}`, new THREE.Vector3(level2X, (yFirst + yLast) / 2, z)));
    }
  }
}

/**
 * レイアウト要素（通り芯・レベル面）の共通延長量を計算
 * @param {THREE.Box3} modelBounds - モデルのバウンディングボックス
 * @returns {number} 延長量（mm）
 */
function getLayoutExtend(modelBounds) {
  if (!modelBounds || modelBounds.isEmpty()) {
    return 500; // デフォルト値
  }
  const size = modelBounds.getSize(new THREE.Vector3());
  return Math.max(size.x, size.y) * 0.15 + 500;
}

/**
 * 通り芯（軸）を指定された階高さに沿った線（Line）として描画する。
 * @param {object} axesData - parseAxesから返される軸データ ({ xAxes: [], yAxes: [] })。
 * @param {Array<object>} storiesData - parseStoriesから返される階データ。
 * @param {THREE.Group} group - 描画対象の要素グループ (Axis)。
 * @param {THREE.Box3} modelBounds - モデル全体のバウンディングボックス。
 * @param {boolean} labelToggle - ラベル表示の有無。
 * @param {THREE.Camera} camera - カメラ（未使用、互換性のため）。
 * @param {Object} options - オプション。
 * @param {string} [options.targetStoryId] - 通り芯を描画する階のID。指定しない場合は最下階。
 * @param {boolean} [options.is2DMode=false] - 2Dモードかどうか。2Dモードでは延長を制限。
 * @returns {Array<THREE.Sprite>} 作成されたラベルスプライトの配列。
 */
export function drawAxes(
  axesData,
  storiesData,
  group,
  modelBounds,
  labelToggle,
  camera,
  options = {},
) {
  disposeRecursive(group, { removeFromParent: false });
  group.clear();

  const createdLabels = [];

  if (!modelBounds || modelBounds.isEmpty()) return createdLabels;
  const min = modelBounds.min;
  const max = modelBounds.max;
  const center = modelBounds.getCenter(new THREE.Vector3());
  // 通り芯の延長量（共通関数を使用してレベル面と確実に一致させる）
  const extendXY = getLayoutExtend(modelBounds);
  const labelMargin = 0; // ラベルを通り芯の端（レベル線上）に配置

  // 通り芯を描画する階を決定
  // options.targetStoryId が指定されていればその階、なければ最下階
  let targetStory = null;
  if (storiesData && storiesData.length > 0) {
    if (options.targetStoryId && options.targetStoryId !== 'all') {
      // 指定された階を検索
      targetStory = storiesData.find((story) => story.id === options.targetStoryId);
    }
    // 見つからない場合は最下階を使用
    if (!targetStory) {
      targetStory = storiesData.reduce((lowest, story) => {
        if (!lowest || story.height < lowest.height) {
          return story;
        }
        return lowest;
      }, null);
    }
  }

  /**
   * @typedef {Object} DotPatternConfig
   * @property {THREE.Vector3} start - 線の始点
   * @property {THREE.Vector3} direction - 正規化された方向ベクトル
   * @property {number} totalLength - 線の全長
   * @property {DotPatternStyle} style - 点パターンスタイル
   * @property {Object} userData - セグメントのメタデータ
   */

  /**
   * @typedef {Object} DotPatternStyle
   * @property {number} cycleLength - 1サイクルの長さ (DASH + GAP + DOT + GAP)
   * @property {number} dashLength - ダッシュ（長い実線）の長さ
   * @property {number} gapLength - 隙間の長さ
   * @property {number} dotLength - 点（短い実線）の長さ
   */

  /**
   * 点パターン（短い実線）を追加する
   * @param {DotPatternConfig} config - 点パターン設定
   */
  function addDotPattern(config) {
    const { start, direction, totalLength, style, userData } = config;
    const { cycleLength, dashLength, gapLength, dotLength } = style;

    // 点の開始位置: 各サイクルの DASH_LENGTH + GAP_LENGTH の位置から開始
    const dotStartOffset = dashLength + gapLength;

    for (let dist = dotStartOffset; dist < totalLength; dist += cycleLength) {
      const dotStart = new THREE.Vector3().copy(start).addScaledVector(direction, dist);
      const dotEndDist = Math.min(dist + dotLength, totalLength);
      const dotEnd = new THREE.Vector3().copy(start).addScaledVector(direction, dotEndDist);

      const dotVertices = new Float32Array([
        dotStart.x,
        dotStart.y,
        dotStart.z,
        dotEnd.x,
        dotEnd.y,
        dotEnd.z,
      ]);
      const dotGeometry = new THREE.BufferGeometry();
      dotGeometry.setAttribute('position', new THREE.BufferAttribute(dotVertices, 3));

      const dotMaterial = new THREE.LineBasicMaterial({
        color: 0x888888,
        linewidth: 1,
      });

      const dotLine = new THREE.Line(dotGeometry, dotMaterial);
      dotLine.frustumCulled = false;
      dotLine.userData = { ...userData, isDot: true };
      group.add(dotLine);
    }
  }

  /**
   * 直線セグメントを一点鎖線パターンで生成してグループに追加
   * @param {THREE.Vector3} p1 - 始点
   * @param {THREE.Vector3} p2 - 終点
   * @param {Object} userData - セグメントのメタデータ
   */
  function addLineToGroup(p1, p2, userData) {
    // 座標の妥当性チェック
    if (
      !Number.isFinite(p1.x) ||
      !Number.isFinite(p1.y) ||
      !Number.isFinite(p1.z) ||
      !Number.isFinite(p2.x) ||
      !Number.isFinite(p2.y) ||
      !Number.isFinite(p2.z)
    ) {
      log.warn('Invalid axis line points:', p1, p2);
      return;
    }

    // 長さが極端に短い場合はスキップ
    const direction = new THREE.Vector3().subVectors(p2, p1);
    const totalLength = direction.length();
    if (totalLength < 1e-6) return;
    direction.normalize();

    // 一点鎖線パターンの定数を取得
    const { DASH_LENGTH, DOT_LENGTH, GAP_LENGTH } = AXIS_LINE_PATTERN;
    const cycleLength = DASH_LENGTH + GAP_LENGTH + DOT_LENGTH + GAP_LENGTH;

    // 1. ダッシュライン（長い実線部分）をLineDashedMaterialで描画
    const vertices = new Float32Array([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    const dashMaterial = new THREE.LineDashedMaterial({
      color: 0x888888,
      dashSize: DASH_LENGTH,
      gapSize: GAP_LENGTH + DOT_LENGTH + GAP_LENGTH, // 点を含む隙間
      linewidth: 1,
    });

    const line = new THREE.Line(geometry, dashMaterial);
    line.computeLineDistances(); // LineDashedMaterialに必須
    line.frustumCulled = false;
    line.userData = userData;

    group.add(line);

    // 2. 点パターン（短い実線として追加）
    addDotPattern({
      start: p1,
      direction,
      totalLength,
      style: {
        cycleLength,
        dashLength: DASH_LENGTH,
        gapLength: GAP_LENGTH,
        dotLength: DOT_LENGTH,
      },
      userData,
    });
  }

  /**
   * 折れ線を一点鎖線パターンでグループに追加
   * @param {THREE.Vector3[]} points - 折れ線を構成する点列
   * @param {Object} userData - セグメントのメタデータ
   */
  function addPolylineToGroup(points, userData) {
    const validPoints = points.filter(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z),
    );
    if (validPoints.length < 2) return;

    const geometry = new THREE.BufferGeometry().setFromPoints(validPoints);
    const { DASH_LENGTH, DOT_LENGTH, GAP_LENGTH } = AXIS_LINE_PATTERN;
    const dashMaterial = new THREE.LineDashedMaterial({
      color: 0x888888,
      dashSize: DASH_LENGTH,
      gapSize: GAP_LENGTH + DOT_LENGTH + GAP_LENGTH,
      linewidth: 1,
    });

    const line = new THREE.Line(geometry, dashMaterial);
    line.computeLineDistances();
    line.frustumCulled = false;
    line.userData = userData;
    group.add(line);
  }

  function getAxisZ() {
    return targetStory ? targetStory.height : center.z;
  }

  function getStoryMetadata(z) {
    if (!targetStory) return {};
    return {
      storyId: targetStory.id,
      storyName: targetStory.name,
      storyHeight: z,
    };
  }

  function getBoundsMetadata() {
    return {
      modelBounds: {
        min: min.clone(),
        max: max.clone(),
        center: center.clone(),
      },
    };
  }

  function addAxisLabel(text, labelPos, meta) {
    if (!labelToggle) return;
    const sprite = createLabelSprite(text, labelPos, group, 'Axis', meta);
    if (sprite) createdLabels.push(sprite);
  }

  function getRadialLineEndpoints(axis, z) {
    const angleRad = ((axis.angle || 0) * Math.PI) / 180;
    const direction = new THREE.Vector3(Math.cos(angleRad), Math.sin(angleRad), 0);
    const origin = new THREE.Vector3(axis.originX || 0, axis.originY || 0, z);
    const corners = [
      new THREE.Vector3(min.x, min.y, z),
      new THREE.Vector3(min.x, max.y, z),
      new THREE.Vector3(max.x, min.y, z),
      new THREE.Vector3(max.x, max.y, z),
    ];
    const length = Math.max(...corners.map((corner) => corner.distanceTo(origin))) + extendXY;
    return {
      start: origin.clone(),
      end: origin.clone().addScaledVector(direction, length),
    };
  }

  function getArcPoints(axis, z) {
    const startAngle = axis.startAngle;
    const endAngle = axis.endAngle;
    const radius = axis.radius;
    if (!Number.isFinite(startAngle) || !Number.isFinite(endAngle) || !Number.isFinite(radius)) {
      return [];
    }

    const sweep = endAngle - startAngle;
    const segmentCount = Math.max(16, Math.ceil(Math.abs(sweep) / 5));
    const points = [];
    for (let i = 0; i <= segmentCount; i++) {
      const angle = startAngle + (sweep * i) / segmentCount;
      const angleRad = (angle * Math.PI) / 180;
      points.push(
        new THREE.Vector3(
          (axis.originX || 0) + radius * Math.cos(angleRad),
          (axis.originY || 0) + radius * Math.sin(angleRad),
          z,
        ),
      );
    }
    return points;
  }

  function drawParallelAxis(axis, axisType) {
    const z = getAxisZ();
    const storyMeta = getStoryMetadata(z);
    if (axisType === 'X') {
      const x = Number.isFinite(axis.x) ? axis.x : axis.distance;
      const yStart = min.y - extendXY;
      const yEnd = max.y + extendXY;
      const userData = {
        elementType: 'Axis',
        elementId: axis.name,
        axisType,
        distance: axis.distance,
        ...storyMeta,
      };
      addLineToGroup(new THREE.Vector3(x, yStart, z), new THREE.Vector3(x, yEnd, z), userData);
      addAxisLabel(axis.name, new THREE.Vector3(x, yStart - labelMargin, z), {
        axisType,
        distance: axis.distance,
        ...storyMeta,
        ...getBoundsMetadata(),
      });
      return;
    }

    const y = Number.isFinite(axis.y) ? axis.y : axis.distance;
    const xStart = min.x - extendXY;
    const xEnd = max.x + extendXY;
    const userData = {
      elementType: 'Axis',
      elementId: axis.name,
      axisType,
      distance: axis.distance,
      ...storyMeta,
    };
    addLineToGroup(new THREE.Vector3(xStart, y, z), new THREE.Vector3(xEnd, y, z), userData);
    addAxisLabel(axis.name, new THREE.Vector3(xStart - labelMargin, y, z), {
      axisType,
      distance: axis.distance,
      ...storyMeta,
      ...getBoundsMetadata(),
    });
  }

  function drawArcAxis(axis, axisType) {
    const z = getAxisZ();
    const storyMeta = getStoryMetadata(z);
    const points = getArcPoints(axis, z);
    if (points.length < 2) return;
    const userData = {
      elementType: 'Axis',
      elementId: axis.name,
      axisType,
      axisKind: 'arc',
      radius: axis.radius,
      distance: axis.distance,
      ...storyMeta,
    };
    addPolylineToGroup(points, userData);
    addAxisLabel(axis.name, points[0].clone(), {
      axisType,
      axisKind: 'arc',
      radius: axis.radius,
      distance: axis.distance,
      ...storyMeta,
      ...getBoundsMetadata(),
    });
  }

  function drawRadialAxis(axis, axisType) {
    const z = getAxisZ();
    const storyMeta = getStoryMetadata(z);
    const { start, end } = getRadialLineEndpoints(axis, z);
    const userData = {
      elementType: 'Axis',
      elementId: axis.name,
      axisType,
      axisKind: 'radial',
      angle: axis.angle,
      distance: axis.distance,
      ...storyMeta,
    };
    addLineToGroup(start, end, userData);
    addAxisLabel(axis.name, end.clone(), {
      axisType,
      axisKind: 'radial',
      angle: axis.angle,
      distance: axis.distance,
      ...storyMeta,
      ...getBoundsMetadata(),
    });
  }

  // X axes: lines parallel to Y at a given X（最下階のみ描画）
  axesData.xAxes.forEach((axis) => {
    if (axis.axisKind === 'arc') {
      drawArcAxis(axis, 'X');
      return;
    }
    if (axis.axisKind === 'radial') {
      drawRadialAxis(axis, 'X');
      return;
    }
    drawParallelAxis(axis, 'X');
  });

  // Y axes: lines parallel to X at a given Y（最下階のみ描画）
  axesData.yAxes.forEach((axis) => {
    if (axis.axisKind === 'arc') {
      drawArcAxis(axis, 'Y');
      return;
    }
    if (axis.axisKind === 'radial') {
      drawRadialAxis(axis, 'Y');
      return;
    }
    drawParallelAxis(axis, 'Y');
  });

  // 寸法表示
  if (options.showDimensions) {
    const z = getAxisZ();

    const parallelXAxes = axesData.xAxes
      .filter((a) => a.axisKind !== 'arc' && a.axisKind !== 'radial')
      .sort((a, b) => {
        const ax = Number.isFinite(a.x) ? a.x : a.distance;
        const bx = Number.isFinite(b.x) ? b.x : b.distance;
        return ax - bx;
      });

    const parallelYAxes = axesData.yAxes
      .filter((a) => a.axisKind !== 'arc' && a.axisKind !== 'radial')
      .sort((a, b) => {
        const ay = Number.isFinite(a.y) ? a.y : a.distance;
        const by = Number.isFinite(b.y) ? b.y : b.distance;
        return ay - by;
      });

    if (parallelXAxes.length >= 2) {
      drawAxisDimensions(parallelXAxes, 'X', group, z, modelBounds, extendXY);
    }
    if (parallelYAxes.length >= 2) {
      drawAxisDimensions(parallelYAxes, 'Y', group, z, modelBounds, extendXY);
    }
  }

  return createdLabels;
}

/**
 * 階（ストーリー）を面として描画する。
 * @param {Array<object>} storiesData - parseStoriesから返される階データ。
 * @param {THREE.Group} group - 描画対象の要素グループ (Story)。
 * @param {THREE.Box3} modelBounds - モデル全体のバウンディングボックス。
 * @param {boolean} labelToggle - ラベル表示の有無。
 * @returns {Array<THREE.Sprite>} 作成されたラベルスプライトの配列。
 */
export function drawStories(storiesData, group, modelBounds, labelToggle) {
  disposeRecursive(group, { removeFromParent: false });
  group.clear();
  const createdLabels = [];
  const storyMaterial = colorManager.getMaterial('layout', { layoutType: 'story', isLine: false });

  if (modelBounds.isEmpty()) {
    log.warn('Cannot draw stories accurately without model bounds.');
    return createdLabels;
  }

  const min = modelBounds.min;
  const max = modelBounds.max;
  const size = modelBounds.getSize(new THREE.Vector3());
  // 面のサイズをモデル範囲より少し広げる（共通関数を使用して通り芯と確実に一致させる）
  const extend = getLayoutExtend(modelBounds);
  const labelMargin = 0; // ラベルをレベル面の端（通り芯と同じ位置）に配置
  const center = modelBounds.getCenter(new THREE.Vector3());

  storiesData.forEach((story) => {
    const z = story.height;
    // XY平面を作成
    const planeWidth = size.x + 2 * extend; // X方向のサイズ
    const planeHeight = size.y + 2 * extend; // Y方向のサイズ
    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    const plane = new THREE.Mesh(geometry, storyMaterial);
    // ★★★ 平面メッシュに userData を追加 ★★★
    plane.userData = {
      elementType: 'Story',
      elementId: story.id,
      name: story.name,
      height: story.height,
    };
    // 位置を設定 (向きはデフォルトでXY平面)
    plane.position.set(center.x, center.y, z);

    // ★★★ Render Order を負の値に変更 ★★★
    plane.renderOrder = -1;

    if (
      !Number.isFinite(plane.position.x) ||
      !Number.isFinite(plane.position.y) ||
      !Number.isFinite(plane.position.z)
    ) {
      log.error(`Invalid position calculated for Story Plane '${story.name}'. Skipping.`);
      return;
    }

    group.add(plane);

    if (labelToggle) {
      const labelText = story.name;

      // 左下コーナー（通り芯ラベルと同じ位置）にラベルを配置
      const labelPosMin = new THREE.Vector3(
        min.x - extend - labelMargin,
        min.y - extend - labelMargin,
        z,
      );
      const spriteMin = createLabelSprite(labelText, labelPosMin, group, 'Story');
      if (spriteMin) createdLabels.push(spriteMin);

      // 右上コーナー（対角）にもラベルを配置
      const labelPosMax = new THREE.Vector3(
        max.x + extend + labelMargin,
        max.y + extend + labelMargin,
        z,
      );
      const spriteMax = createLabelSprite(labelText, labelPosMax, group, 'Story');
      if (spriteMax) createdLabels.push(spriteMax);
    }
  });

  return createdLabels;
}
