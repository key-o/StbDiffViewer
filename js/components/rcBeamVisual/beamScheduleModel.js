/**
 * @fileoverview RC梁断面リストの共通プレゼンテーションモデル
 *
 * UI(SVG)とDXFで別々に配筋位置を計算しないため、断面寸法・主筋・STP・中子筋・腹筋を
 * mm単位のローカル座標（左上原点、X右向き、Y下向き）へ正規化する。
 *
 * かぶり・主筋重心位置の解決規則は柱リストと共通化する。
 * - 断面リストの「かぶり」はコンクリート面から外周HOOP芯までの作図距離とする
 * - 通常時は柱リストと同じ共通作図プロファイルを使用し、STB depth_coverは意味データとして保持する
 * - center_*は正値だけを明示主筋芯として優先する
 * - center_*欠損/0時は「作図かぶり + 柱リストと同じ基準差」で補う
 */

import { createOuterInSlotOrder } from '../rebarSlotLayout.js';
import {
  createEvenlySpacedValues,
  parseDtRebarDiameterMm,
} from '../rebarGeometryUtils.js';
import {
  BASELINE_RC_SCHEDULE_PROFILE,
  resolveRcScheduleProfile,
} from '../rcScheduleProfile.js';
import {
  hasRcScheduleFaceValue,
  normalizeRcScheduleFaces,
  resolveRcScheduleMainFaces,
} from '../rcSchedulePlacement.js';

const DEFAULT_MAIN_DIA = 'D25';
const DEFAULT_WEB_DIA = 'D13';
const BEAM_FACE_KEYS = ['top', 'bottom', 'left', 'right'];

export function parseBeamBarDiameterMm(dia, fallback = 25) {
  return parseDtRebarDiameterMm(dia, fallback);
}

export function beamBarRadiusMm(dia, fallback = 25) {
  return parseBeamBarDiameterMm(dia, fallback) / 2;
}

function mapColumnFacesToBeam(faces = {}) {
  return {
    top: Number(faces.endY),
    bottom: Number(faces.startY),
    left: Number(faces.startX),
    right: Number(faces.endX),
  };
}

function resolveBeamBaselineHoopFaces(profile) {
  const columnFaces = mapColumnFacesToBeam(profile?.column?.hoopCenterFaces);
  const compatibilityFallback = Number(profile?.beam?.defaultHoopCenterMm) || 50;
  return normalizeRcScheduleFaces(
    columnFaces,
    BEAM_FACE_KEYS,
    Object.fromEntries(BEAM_FACE_KEYS.map((key) => [key, compatibilityFallback])),
  );
}

function resolveBeamMainOffsets(profile, hoopFaces) {
  const columnMain = mapColumnFacesToBeam(profile?.column?.mainCenterFaces);
  const compatibilityOffset =
    Number(profile?.beam?.mainCenterOffsetFromHoopMm) ||
    (Number(profile?.beam?.defaultMainCenterMm) || 72) -
      (Number(profile?.beam?.defaultHoopCenterMm) || 50);

  return Object.fromEntries(
    BEAM_FACE_KEYS.map((key) => {
      const main = Number(columnMain[key]);
      const hoop = Number(hoopFaces[key]);
      const delta = main - hoop;
      return [key, Number.isFinite(delta) && delta >= 0 ? delta : compatibilityOffset];
    }),
  );
}

function hasOwnMetadata(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function resolveStrictSourceCover(positionData) {
  if (hasOwnMetadata(positionData, 'sourceCover')) return positionData.sourceCover;
  const cover = positionData?.cover || null;
  if (hasOwnMetadata(cover, 'sourceCover')) return cover.sourceCover;
  return cover;
}

function resolveExplicitMainCenters(positionData) {
  if (hasOwnMetadata(positionData, 'mainCenters')) return positionData.mainCenters;
  const cover = positionData?.cover || null;
  if (hasOwnMetadata(cover, 'mainCenters')) return cover.mainCenters;
  return null;
}

function normalizeBeamMainCenters(value) {
  if (!value) return null;
  const side = value.side;
  return {
    top: value.top,
    bottom: value.bottom,
    left: value.left ?? side,
    right: value.right ?? side,
  };
}

export function resolveBeamScheduleCovers(
  cover,
  profile = BASELINE_RC_SCHEDULE_PROFILE,
) {
  const source = cover || {};
  const defaultCover = Number(profile?.beam?.defaultSourceCoverMm) || 40;
  const top = Number.isFinite(source.top) ? source.top : defaultCover;
  const bottom = Number.isFinite(source.bottom) ? source.bottom : defaultCover;
  const left = Number.isFinite(source.left) ? source.left : top;
  const right = Number.isFinite(source.right) ? source.right : top;
  const estimated = ['top', 'bottom', 'left', 'right'].some(
    (key) => !Number.isFinite(source[key]),
  );
  return { top, bottom, left, right, estimated };
}

function hasDrawingOverride(value) {
  return hasRcScheduleFaceValue(value, BEAM_FACE_KEYS);
}

export function normalizeBeamScheduleBarLayers(bar) {
  const sourceLayers = Array.isArray(bar?.layers)
    ? bar.layers.filter((layer) => Number(layer?.count) > 0)
    : [];

  if (sourceLayers.length > 0) {
    return sourceLayers
      .map((layer, index) => {
        const barGroups = Array.isArray(layer.barGroups)
          ? layer.barGroups
              .filter((group) => Number(group?.count) > 0)
              .map((group) => ({
                count: Number(group.count),
                dia: group.dia || layer.dia || bar?.dia || DEFAULT_MAIN_DIA,
                grade: group.grade || layer.grade || bar?.grade || null,
                diaEstimated: !(group.dia || layer.dia || bar?.dia),
              }))
          : [];
        const largestGroup = barGroups.reduce(
          (largest, group) =>
            !largest || parseBeamBarDiameterMm(group.dia) > parseBeamBarDiameterMm(largest.dia)
              ? group
              : largest,
          null,
        );
        return {
          step: Number(layer.step) > 0 ? Number(layer.step) : index + 1,
          count: Number(layer.count),
          dia: largestGroup?.dia || layer.dia || bar?.dia || DEFAULT_MAIN_DIA,
          grade: layer.grade || bar?.grade || null,
          diaEstimated: largestGroup?.diaEstimated ?? !(layer.dia || bar?.dia),
          barGroups,
        };
      })
      .sort((a, b) => a.step - b.step);
  }

  if (!bar) return [];
  const dia = bar.dia || DEFAULT_MAIN_DIA;
  const diaEstimated = !bar.dia;
  return [
    { step: 1, count: Number(bar.count1st || bar.count) || 0 },
    { step: 2, count: Number(bar.count2nd) || 0 },
    { step: 3, count: Number(bar.count3rd) || 0 },
  ]
    .filter((layer) => layer.count > 0)
    .map((layer) => ({
      ...layer,
      dia,
      grade: bar.grade || null,
      diaEstimated,
      barGroups: [],
    }));
}

export function evenlySpacedBeamValues(count, start, end) {
  return createEvenlySpacedValues(start, end, count);
}

export function resolveBeamStirrupInnerAnchors(mainBarXs, innerLegCount, start, end) {
  const count = Math.max(0, Number.parseInt(innerLegCount, 10) || 0);
  if (count === 0) return [];
  const sorted = [...(mainBarXs || [])].filter(Number.isFinite).sort((a, b) => a - b);

  if (sorted.length >= count + 2) {
    const lastIndex = sorted.length - 1;
    const indices = [];
    for (let i = 1; i <= count; i += 1) {
      const minIndex = i;
      const maxIndex = lastIndex - (count - i) - 1;
      const targetIndex = Math.round((lastIndex * i) / (count + 1));
      indices.push(Math.max(minIndex, Math.min(maxIndex, targetIndex)));
    }
    return indices.map((index) => sorted[index]);
  }

  const span = end - start;
  if (!(span > 0)) return [];
  return Array.from({ length: count }, (_, index) => start + (span * (index + 1)) / (count + 1));
}

function resolveLayerGroups(layer) {
  if (layer.barGroups?.length > 0) return layer.barGroups;
  return [{ count: layer.count, dia: layer.dia, grade: layer.grade, diaEstimated: layer.diaEstimated }];
}

function createBarPlacement(x, y, group, layer, side) {
  return {
    x,
    y,
    dia: group.dia,
    grade: group.grade || null,
    layer: layer.step,
    role: side === 'TOP' ? 'top' : 'bottom',
    diaEstimated: !!group.diaEstimated,
  };
}

function createHorizontalLayers(bar, side, context) {
  const layers = normalizeBeamScheduleBarLayers(bar);
  const result = [];
  let previousY = null;
  let previousRadius = 0;

  layers.forEach((layer, index) => {
    const groups = resolveLayerGroups(layer);
    const layoutRadius = Math.max(...groups.map((group) => beamBarRadiusMm(group.dia)));
    const xPositions = evenlySpacedBeamValues(
      layer.count,
      context.mainCenters.left,
      context.mainCenters.right,
    );

    let y;
    if (index === 0) {
      y = side === 'TOP' ? context.mainCenters.top : context.mainCenters.bottom;
    } else {
      const centerSpacing = previousRadius + layoutRadius * 3;
      y = side === 'TOP' ? previousY + centerSpacing : previousY - centerSpacing;
    }

    let placements;
    if (layer.barGroups?.length > 0) {
      placements = [];
      const slotOrder = createOuterInSlotOrder(xPositions.length);
      let slotCursor = 0;
      groups.forEach((group) => {
        for (let i = 0; i < group.count && slotCursor < slotOrder.length; i += 1) {
          placements.push(createBarPlacement(xPositions[slotOrder[slotCursor]], y, group, layer, side));
          slotCursor += 1;
        }
      });
      const fallbackGroup = {
        dia: layer.dia,
        grade: layer.grade,
        diaEstimated: layer.diaEstimated,
      };
      while (slotCursor < slotOrder.length) {
        placements.push(
          createBarPlacement(xPositions[slotOrder[slotCursor]], y, fallbackGroup, layer, side),
        );
        slotCursor += 1;
      }
    } else {
      const group = groups[0];
      placements = xPositions.map((x) => createBarPlacement(x, y, group, layer, side));
    }

    result.push({
      step: layer.step,
      count: layer.count,
      dia: layer.dia,
      barRadius: layoutRadius,
      xPositions,
      y,
      placements,
    });
    previousY = y;
    previousRadius = layoutRadius;
  });

  return result;
}

export function buildBeamScheduleGeometry(positionData, options = {}) {
  const width = Number(positionData?.width) || 0;
  const depth = Number(positionData?.depth) || 0;
  if (!(width > 0) || !(depth > 0)) return null;

  const profile = resolveRcScheduleProfile(options.profile || {});
  const strictSourceCover = resolveStrictSourceCover(positionData);
  const explicitCenters = normalizeBeamMainCenters(resolveExplicitMainCenters(positionData));
  const sourceCovers = resolveBeamScheduleCovers(strictSourceCover, profile);
  const baselineHoopFaces = resolveBeamBaselineHoopFaces(profile);
  const mainOffsets = resolveBeamMainOffsets(profile, baselineHoopFaces);
  const drawingOverride = options.drawingCoverOverride ?? options.coverOverride ?? null;
  const overrideActive = hasDrawingOverride(drawingOverride);

  // 柱リストと同じく、作図かぶりは断面リスト設定値（HOOP芯）を基準とする。
  // STB depth_coverは意味データとしてsourceCoversへ保持するが、通常作図位置には直接使わない。
  const hoopFaces = normalizeRcScheduleFaces(
    overrideActive ? drawingOverride : baselineHoopFaces,
    BEAM_FACE_KEYS,
    baselineHoopFaces,
  );
  // 柱リストと同じく、明示center_*は作図かぶり設定より優先する。
  const mainFaces = resolveRcScheduleMainFaces(
    explicitCenters,
    hoopFaces,
    BEAM_FACE_KEYS,
    mainOffsets,
  );

  const stirrup = positionData?.stirrup || null;
  const hasStirrup = !!stirrup?.dia;
  const stirrupBounds = hasStirrup
    ? {
        left: hoopFaces.left,
        right: width - hoopFaces.right,
        top: hoopFaces.top,
        bottom: depth - hoopFaces.bottom,
      }
    : null;
  const mainCenters = {
    left: mainFaces.left,
    right: width - mainFaces.right,
    top: mainFaces.top,
    bottom: depth - mainFaces.bottom,
  };

  const context = { width, depth, mainCenters };
  const topLayers = createHorizontalLayers(positionData?.topBar, 'TOP', context);
  const bottomLayers = createHorizontalLayers(positionData?.bottomBar, 'BOTTOM', context);
  const mainBars = [...topLayers, ...bottomLayers].flatMap((layer) => layer.placements);

  const innerLegs = [];
  if (stirrupBounds) {
    const innerLegCount = Math.max(0, (Number.parseInt(stirrup?.count, 10) || 0) - 2);
    const firstLayers = [...topLayers, ...bottomLayers].filter((layer) => layer.step === 1);
    const referenceLayer = firstLayers.reduce(
      (best, current) => (!best || current.count > best.count ? current : best),
      null,
    );
    const anchors = resolveBeamStirrupInnerAnchors(
      referenceLayer?.xPositions || [],
      innerLegCount,
      stirrupBounds.left,
      stirrupBounds.right,
    );
    const centerX = (stirrupBounds.left + stirrupBounds.right) / 2;
    const offset = Math.max(1, (referenceLayer?.barRadius || 0) * 0.75);
    anchors.forEach((anchorX) => {
      const isMainBarAnchor = referenceLayer?.xPositions.some(
        (value) => Math.abs(value - anchorX) < 1e-6,
      );
      const direction = anchorX <= centerX ? -1 : 1;
      const x = isMainBarAnchor
        ? Math.max(stirrupBounds.left, Math.min(stirrupBounds.right, anchorX + direction * offset))
        : anchorX;
      innerLegs.push({ x, anchorX, top: stirrupBounds.top, bottom: stirrupBounds.bottom });
    });
  }

  const webBars = [];
  const webBar = positionData?.webBar;
  if (webBar && Number(webBar.count) > 0) {
    const dia = webBar.dia || DEFAULT_WEB_DIA;
    const spacing = (mainCenters.bottom - mainCenters.top) / (Number(webBar.count) + 1);
    for (let i = 1; i <= Number(webBar.count); i += 1) {
      const y = mainCenters.top + spacing * i;
      webBars.push({
        x: mainCenters.left,
        y,
        dia,
        role: 'web',
        layer: null,
        diaEstimated: !webBar.dia,
      });
      webBars.push({
        x: mainCenters.right,
        y,
        dia,
        role: 'web',
        layer: null,
        diaEstimated: !webBar.dia,
      });
    }
  }

  const hasCenterPlacement = hasRcScheduleFaceValue(explicitCenters, BEAM_FACE_KEYS);

  return {
    width,
    depth,
    covers: sourceCovers,
    sourceCovers,
    scheduleHoopFaces: hoopFaces,
    scheduleMainFaces: mainFaces,
    profile,
    placementMode: overrideActive
      ? 'DRAWING_COVER_OVERRIDE'
      : hasCenterPlacement
        ? 'STB_CENTER'
        : 'BASELINE_SCHEDULE',
    concrete: { left: 0, top: 0, right: width, bottom: depth },
    stirrup: stirrupBounds
      ? {
          ...stirrupBounds,
          dia: stirrup.dia,
          count: Number(stirrup.count) || 0,
          pitch: stirrup.pitch || null,
          innerLegs,
        }
      : null,
    topLayers,
    bottomLayers,
    mainBars,
    webBars,
    estimatedCover: sourceCovers.estimated,
    estimatedBarDia: [...mainBars, ...webBars].some((bar) => bar.diaEstimated),
  };
}
