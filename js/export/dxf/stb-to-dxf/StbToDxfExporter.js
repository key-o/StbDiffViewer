/**
 * @fileoverview STB→DXFエクスポーター メインモジュール
 *
 * 平面図の階出力では、完成済みThree.js Meshを要素別の構造平面図高さで切断し、
 * 閉ポリラインとして出力する。その他のビューは従来の稜線投影を維持する。
 */

import * as THREE from 'three';
import { createLogger } from '../../../utils/logger.js';
import {
  EXPORTABLE_ELEMENT_TYPES,
  getActiveCameraInternal,
  getOrthographicCameraInternal,
  getElementGroupsInternal,
  getCurrentClippingStateInternal,
} from './DxfProviders.js';
import {
  detectViewDirection,
  projectPointTo2D,
  extractEdgesFromMesh,
  isPointWithinClippingBounds,
  collectAxisLines,
  generateAxisLinesAtClippingHeight,
  collectLevelLines,
} from './DxfGeometryCollector.js';
import { collectDxfElementMarks } from './DxfMarkCollector.js';
import { extractHorizontalSectionLoops } from './DxfSectionExtractor.js';
import { collectWallOpeningPolylines } from './DxfOpeningCollector.js';
import { DEFAULT_PLAN_CUT_OFFSET, resolveStoryPlanCutZ } from './DxfPlanCut.js';
import { generatePlanDxfContent, downloadDxf } from './DxfPlanFormatWriter.js';
import { eventBus, ToastEvents } from '../../../data/events/index.js';

const log = createLogger('StbToDxfExporter');

function isTopView(viewDirection) {
  return viewDirection === 'top' || viewDirection === 'bottom';
}

function isStoryPlanMode(viewDirection, clippingState) {
  return isTopView(viewDirection) && clippingState?.type === 'story';
}

/**
 * エクスポート可能かどうかを判定
 * @returns {{canExport: boolean, reason: string, solidElementTypes?:Array<string>}}
 */
export function canExportStbToDxf() {
  const elementGroups = getElementGroupsInternal();
  if (!elementGroups || Object.keys(elementGroups).length === 0) {
    return { canExport: false, reason: 'モデルが読み込まれていません' };
  }

  const orthographicCamera = getOrthographicCameraInternal();
  if (!orthographicCamera) {
    return { canExport: false, reason: 'カメラが初期化されていません' };
  }

  let hasExportableObject = false;
  const solidElementTypes = [];
  for (const [type, group] of Object.entries(elementGroups)) {
    if (!EXPORTABLE_ELEMENT_TYPES.includes(type) || !group?.traverse) continue;

    let visibleObjectCount = 0;
    group.traverse((child) => {
      if (
        child.visible &&
        (child.isMesh || child.isLine || child.isLineSegments || child.isInstancedMesh)
      ) {
        visibleObjectCount++;
        hasExportableObject = true;
      }
    });
    if (visibleObjectCount > 0) solidElementTypes.push(type);
  }

  if (!hasExportableObject) {
    return { canExport: false, reason: '表示可能なメッシュがありません', solidElementTypes: [] };
  }
  return { canExport: true, reason: '', solidElementTypes };
}

function updateBounds(bounds, point1, point2 = null) {
  bounds.min.x = Math.min(bounds.min.x, point1.x);
  bounds.min.y = Math.min(bounds.min.y, point1.y);
  bounds.max.x = Math.max(bounds.max.x, point1.x);
  bounds.max.y = Math.max(bounds.max.y, point1.y);

  if (point2) {
    bounds.min.x = Math.min(bounds.min.x, point2.x);
    bounds.min.y = Math.min(bounds.min.y, point2.y);
    bounds.max.x = Math.max(bounds.max.x, point2.x);
    bounds.max.y = Math.max(bounds.max.y, point2.y);
  }
}

function projectPolyline(points, camera, viewDirection, layer, bounds) {
  const projected = points.map((point) => projectPointTo2D(point, camera, viewDirection));
  for (const point of projected) updateBounds(bounds, point);
  return { points: projected, layer, closed: true };
}

function collectLineObjectSegments(child, clippingState) {
  const geometry = child.geometry;
  const positions = geometry?.getAttribute?.('position');
  if (!positions) return [];

  child.updateWorldMatrix(true, false);
  const matrixWorld = child.matrixWorld;
  const result = [];
  const step = child.isLineSegments ? 2 : 1;
  const limit = child.isLineSegments ? positions.count : positions.count - 1;

  for (let i = 0; i < limit; i += step) {
    const j = i + 1;
    if (j >= positions.count) continue;

    const start = new THREE.Vector3(
      positions.getX(i),
      positions.getY(i),
      positions.getZ(i),
    ).applyMatrix4(matrixWorld);
    const end = new THREE.Vector3(
      positions.getX(j),
      positions.getY(j),
      positions.getZ(j),
    ).applyMatrix4(matrixWorld);

    if (clippingState?.type) {
      const startIn = isPointWithinClippingBounds(start, clippingState);
      const endIn = isPointWithinClippingBounds(end, clippingState);
      if (!startIn && !endIn) continue;
    }
    result.push({ start, end });
  }
  return result;
}

function appendProjectedSegments(segments, layer, camera, viewDirection, lines2D, bounds) {
  for (const edge of segments) {
    const start = projectPointTo2D(edge.start, camera, viewDirection);
    const end = projectPointTo2D(edge.end, camera, viewDirection);
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < 1) continue;
    lines2D.push({ start, end, layer });
    updateBounds(bounds, start, end);
  }
}

function collectElementGeometry({
  selectedElementTypes,
  elementGroups,
  camera,
  viewDirection,
  clippingState,
  planCutOffset,
  lines2D,
  polylines2D,
  bounds,
}) {
  const planMode = isStoryPlanMode(viewDirection, clippingState);

  for (const elementType of selectedElementTypes) {
    if (elementType === 'Open') continue;
    const group = elementGroups[elementType];
    if (!group?.traverse) continue;

    group.traverse((child) => {
      if (!child.visible) return;

      if (child.isMesh) {
        if (planMode) {
          child.updateWorldMatrix(true, false);
          const box = new THREE.Box3().setFromObject(child);
          if (box.isEmpty()) return;
          const cutZ = resolveStoryPlanCutZ(elementType, box, clippingState, planCutOffset);
          if (cutZ == null) return;

          const loops = extractHorizontalSectionLoops(child, cutZ);
          for (const loop of loops) {
            if (loop.length < 3) continue;
            polylines2D.push(projectPolyline(loop, camera, viewDirection, elementType, bounds));
          }
        } else {
          appendProjectedSegments(
            extractEdgesFromMesh(child, clippingState),
            elementType,
            camera,
            viewDirection,
            lines2D,
            bounds,
          );
        }
      }

      if (child.isLine || child.isLineSegments) {
        appendProjectedSegments(
          collectLineObjectSegments(child, clippingState),
          elementType,
          camera,
          viewDirection,
          lines2D,
          bounds,
        );
      }
    });
  }
}

function appendOpenPolylines({
  selectedElementTypes,
  elementGroups,
  camera,
  viewDirection,
  clippingState,
  planCutOffset,
  polylines2D,
  bounds,
}) {
  if (!selectedElementTypes.includes('Open') || !isStoryPlanMode(viewDirection, clippingState)) {
    return 0;
  }

  const openings = collectWallOpeningPolylines(elementGroups.Wall, clippingState, {
    planCutOffset,
  });
  for (const opening of openings) {
    polylines2D.push(projectPolyline(opening.points, camera, viewDirection, 'Open', bounds));
  }
  return openings.length;
}

/**
 * STBモデルをDXFにエクスポート
 * @param {Array<string>} selectedElementTypes
 * @param {string} filename
 * @param {Object} options
 * @param {boolean} [options.includeLabels=true]
 * @param {boolean} [options.includeAxes=true]
 * @param {boolean} [options.includeLevels=true]
 * @param {number} [options.labelHeight=200]
 * @param {number} [options.planCutOffset=1500] - 鉛直部材の構造平面図切断高さ（FLからmm）
 * @returns {Promise<boolean>}
 */
export async function exportStbToDxf(selectedElementTypes, filename = 'stb_export', options = {}) {
  const includeLabels = options.includeLabels !== undefined ? options.includeLabels : true;
  const includeAxes = options.includeAxes !== undefined ? options.includeAxes : true;
  const includeLevels = options.includeLevels !== undefined ? options.includeLevels : true;
  const labelHeight = options.labelHeight || 200;
  const directoryHandle = options.directoryHandle || null;
  const forceViewDirection = options.forceViewDirection || null;
  const planCutOffset = options.planCutOffset ?? DEFAULT_PLAN_CUT_OFFSET;

  try {
    const { canExport, reason } = canExportStbToDxf();
    if (!canExport) {
      eventBus.emit(ToastEvents.SHOW_WARNING, { message: `エクスポートできません: ${reason}` });
      return false;
    }

    const camera = getActiveCameraInternal() || getOrthographicCameraInternal();
    if (!camera) throw new Error('カメラが初期化されていません');

    const viewDirection = forceViewDirection || detectViewDirection(camera);
    const clippingState = getCurrentClippingStateInternal();
    const elementGroups = getElementGroupsInternal();
    const lines2D = [];
    const polylines2D = [];
    const texts2D = [];
    const bounds = {
      min: { x: Infinity, y: Infinity },
      max: { x: -Infinity, y: -Infinity },
    };

    log.info('STB→DXFエクスポート開始:', {
      selectedElementTypes,
      viewDirection,
      clippingType: clippingState?.type || null,
      planCutOffset,
    });

    collectElementGeometry({
      selectedElementTypes,
      elementGroups,
      camera,
      viewDirection,
      clippingState,
      planCutOffset,
      lines2D,
      polylines2D,
      bounds,
    });

    const openingCount = appendOpenPolylines({
      selectedElementTypes,
      elementGroups,
      camera,
      viewDirection,
      clippingState,
      planCutOffset,
      polylines2D,
      bounds,
    });

    if (lines2D.length === 0 && polylines2D.length === 0) {
      eventBus.emit(ToastEvents.SHOW_WARNING, { message: 'エクスポートする線分がありません' });
      return false;
    }

    if (includeLabels) {
      const marks = collectDxfElementMarks(selectedElementTypes, clippingState, { planCutOffset });
      for (const mark of marks) {
        const position = projectPointTo2D(mark.position, camera, viewDirection);
        texts2D.push({
          position,
          text: mark.text,
          layer: mark.elementType,
          height: labelHeight,
        });
        updateBounds(bounds, position);
      }
      log.info(`DXF符号: ${marks.length}個`);
    }

    let axisLayerAdded = false;
    if (includeAxes) {
      const axisLines =
        clippingState?.type === 'story'
          ? generateAxisLinesAtClippingHeight(camera, clippingState)
          : collectAxisLines(camera, clippingState);

      for (const axisLine of axisLines) {
        const start = projectPointTo2D(axisLine.start, camera, viewDirection);
        const end = projectPointTo2D(axisLine.end, camera, viewDirection);
        if (Math.hypot(end.x - start.x, end.y - start.y) < 1) continue;
        lines2D.push({ start, end, layer: 'Axis' });
        axisLayerAdded = true;
        updateBounds(bounds, start, end);
      }

      if (includeLabels) {
        for (const axisLine of axisLines) {
          const position = projectPointTo2D(
            axisLine.labelPosition || axisLine.start,
            camera,
            viewDirection,
          );
          texts2D.push({
            position,
            text: axisLine.name,
            layer: 'Axis',
            height: labelHeight,
          });
          updateBounds(bounds, position);
        }
      }
    }

    let levelLayerAdded = false;
    if (includeLevels) {
      const levelLines = collectLevelLines(camera, clippingState);
      for (const levelLine of levelLines) {
        const start = projectPointTo2D(levelLine.start, camera, viewDirection);
        const end = projectPointTo2D(levelLine.end, camera, viewDirection);
        if (Math.hypot(end.x - start.x, end.y - start.y) < 1) continue;
        lines2D.push({ start, end, layer: 'Level' });
        levelLayerAdded = true;
        updateBounds(bounds, start, end);
      }

      if (includeLabels) {
        for (const levelLine of levelLines) {
          const position = projectPointTo2D(
            levelLine.labelPosition || levelLine.start,
            camera,
            viewDirection,
          );
          const heightM = (levelLine.height / 1000).toFixed(2);
          texts2D.push({
            position,
            text: `${levelLine.name} (FL+${heightM}m)`,
            layer: 'Level',
            height: labelHeight,
          });
          updateBounds(bounds, position);
        }
      }
    }

    if (bounds.min.x === Infinity) {
      bounds.min = { x: 0, y: 0 };
      bounds.max = { x: 1000, y: 1000 };
    }

    const layers = [...new Set(selectedElementTypes)];
    if (axisLayerAdded) layers.push('Axis');
    if (levelLayerAdded) layers.push('Level');

    const dxfContent = generatePlanDxfContent(
      bounds,
      [...new Set(layers)],
      lines2D,
      polylines2D,
      texts2D,
    );
    await downloadDxf(dxfContent, filename, directoryHandle);

    log.info('STB→DXFエクスポート完了:', {
      lineCount: lines2D.length,
      polylineCount: polylines2D.length,
      openingCount,
      textCount: texts2D.length,
    });
    return true;
  } catch (error) {
    log.error('STB→DXFエクスポートエラー:', error);
    eventBus.emit(ToastEvents.SHOW_ERROR, {
      message: `STB→DXFエクスポートに失敗しました: ${error.message}`,
    });
    return false;
  }
}

/**
 * エクスポート統計を取得
 * @param {Array<string>} selectedElementTypes
 * @returns {Object}
 */
export function getStbExportStats(selectedElementTypes) {
  const elementGroups = getElementGroupsInternal();
  const clippingState = getCurrentClippingStateInternal();
  const stats = {
    totalMeshes: 0,
    totalLabels: 0,
    byElementType: {},
    labelsByElementType: {},
  };

  for (const elementType of selectedElementTypes) {
    if (elementType === 'Open') continue;
    const group = elementGroups[elementType];
    if (!group?.traverse) continue;
    let meshCount = 0;
    group.traverse((child) => {
      if (child.isMesh && child.visible) meshCount++;
    });
    stats.byElementType[elementType] = meshCount;
    stats.totalMeshes += meshCount;
  }

  const marks = collectDxfElementMarks(selectedElementTypes, clippingState);
  for (const mark of marks) {
    stats.labelsByElementType[mark.elementType] =
      (stats.labelsByElementType[mark.elementType] || 0) + 1;
  }
  stats.totalLabels = marks.length;

  if (selectedElementTypes.includes('Open') && clippingState?.type === 'story') {
    const openings = collectWallOpeningPolylines(elementGroups.Wall, clippingState);
    stats.byElementType.Open = openings.length;
  }

  return stats;
}
