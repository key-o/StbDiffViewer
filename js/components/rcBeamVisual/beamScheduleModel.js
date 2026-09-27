/**
 * @fileoverview RC梁断面リストの共通プレゼンテーションモデル
 *
 * UI(SVG)とDXFで別々に配筋位置を計算しないため、断面寸法・主筋・STP・中子筋・腹筋を
 * mm単位のローカル座標（左上原点、X右向き、Y下向き）へ正規化する。
 *
 * かぶり・主筋重心位置の解決規則:
 * - center_* が正値なら主筋芯として最優先する
 * - center_* がなく STB depth_cover が明示されていれば、かぶり + 1段筋半径で主筋芯を求める
 * - 位置情報がなければ基準DXF由来の作図プロファイル（HOOP芯50mm・主筋芯72mm）で補う
 * - 作図かぶりoverride時は従来どおりHOOP芯を優先し、center欠損面は共通オフセットで補う
 * - 多段筋は重心間距離、段筋あき、日建連2023 表2-4の順に段間隔を解決する
 */

import { createEvenlySpacedValues, parseDtRebarDiameterMm } from '../rebarGeometryUtils.js';
import { BASELINE_RC_SCHEDULE_PROFILE, resolveRcScheduleProfile } from '../rcScheduleProfile.js';
import {
  hasRcScheduleFaceValue,
  normalizeRcScheduleFaces,
  resolveRcScheduleMainFaces,
} from '../rcSchedulePlacement.js';
import {
  assignBeamLayerGroupsToPositions,
  beamLayerLayoutRadiusMm,
  getBeamPositionMetadata,
  normalizeBeamRebarLayers,
  resolveBeamFirstLayerFaces,
  resolveBeamLayerCenterSpacingMm,
} from '../../data/extractors/beamSectionList/beamRebarPositionResolver.js';

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

function resolveStrictSourceCover(positionData) {
  return getBeamPositionMetadata(positionData).sourceCover;
}

function resolveExplicitMainCenters(positionData) {
  return getBeamPositionMetadata(positionData).mainCenters;
}

function resolveBeamLayerSpacing(positionData) {
  return getBeamPositionMetadata(positionData).layerSpacing;
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

function positiveDistance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveBeamLayerCenterSpacing(
  previousRadius,
  currentRadius,
  layerSpacing,
  stirrupDiameter = 0,
) {
  const explicitCenter = positiveDistance(layerSpacing?.centerInterval);
  if (explicitCenter !== null) return explicitCenter;

  const clearInterval = positiveDistance(layerSpacing?.clearInterval);
  if (clearInterval !== null) {
    return clearInterval + previousRadius + currentRadius;
  }

  // 柱リストと同じ推定規則。STBに段間隔がない場合だけ使用する。
  return Math.max(30, Number(stirrupDiameter) + previousRadius + currentRadius);
}

export function resolveBeamScheduleCovers(cover, profile = BASELINE_RC_SCHEDULE_PROFILE) {
  const source = cover || {};
  const defaultCover = Number(profile?.beam?.defaultSourceCoverMm) || 40;
  const top = Number.isFinite(source.top) ? source.top : defaultCover;
  const bottom = Number.isFinite(source.bottom) ? source.bottom : defaultCover;
  const left = Number.isFinite(source.left) ? source.left : top;
  const right = Number.isFinite(source.right) ? source.right : top;
  const estimated = ['top', 'bottom', 'left', 'right'].some((key) => !Number.isFinite(source[key]));
  return { top, bottom, left, right, estimated };
}

function hasDrawingOverride(value) {
  return hasRcScheduleFaceValue(value, BEAM_FACE_KEYS);
}

export function normalizeBeamScheduleBarLayers(bar) {
  return normalizeBeamRebarLayers(bar, DEFAULT_MAIN_DIA);
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

function createBarPlacement(x, y, assignment, layer, side, positionSource) {
  return {
    x,
    y,
    dia: assignment.dia,
    grade: assignment.grade || null,
    layer: layer.step,
    role: side === 'TOP' ? 'top' : 'bottom',
    diaEstimated: !!assignment.diaEstimated,
    positionSource,
  };
}

function createHorizontalLayers(bar, side, context) {
  const layers = normalizeBeamScheduleBarLayers(bar);
  const result = [];
  let previousY = null;
  let previousLayer = null;
  let blocked = false;

  layers.forEach((layer, index) => {
    if (blocked) return;
    const layoutRadius = beamLayerLayoutRadiusMm(layer, DEFAULT_MAIN_DIA);
    const xPositions = evenlySpacedBeamValues(
      layer.count,
      context.mainCenters.left,
      context.mainCenters.right,
    );

    let y;
    let positionSource;
    if (index === 0) {
      y = side === 'TOP' ? context.mainCenters.top : context.mainCenters.bottom;
      positionSource = side === 'TOP' ? context.faceSources.top : context.faceSources.bottom;
    } else {
      const resolved = resolveBeamLayerCenterSpacingMm({
        previousLayer,
        currentLayer: layer,
        layerSpacing: context.layerSpacing,
        applyDefaults: context.applyDefaults,
      });
      if (!Number.isFinite(resolved.value)) {
        blocked = true;
        return;
      }
      y = side === 'TOP' ? previousY + resolved.value : previousY - resolved.value;
      positionSource = resolved.source;
    }

    if (!Number.isFinite(y)) {
      blocked = true;
      return;
    }

    const assignments = assignBeamLayerGroupsToPositions(layer, xPositions);
    const placements = assignments.map((assignment) =>
      createBarPlacement(assignment.position, y, assignment, layer, side, positionSource),
    );

    result.push({
      step: layer.step,
      count: layer.count,
      dia: layer.dia,
      barRadius: layoutRadius,
      xPositions,
      y,
      placements,
      positionSource,
    });
    previousY = y;
    previousLayer = layer;
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

  // HOOP芯はDXF作図プロファイルを基準とする。STB depth_coverは主筋かぶりなので、
  // HOOP芯へ直接流用しない。作図overrideがある場合のみHOOP芯を置き換える。
  const hoopFaces = normalizeRcScheduleFaces(
    overrideActive ? drawingOverride : baselineHoopFaces,
    BEAM_FACE_KEYS,
    baselineHoopFaces,
  );
  const baselineMainFaces = resolveRcScheduleMainFaces(
    explicitCenters,
    hoopFaces,
    BEAM_FACE_KEYS,
    mainOffsets,
  );
  const positionResolution = resolveBeamFirstLayerFaces({
    positionData,
    fallbackFaces: baselineMainFaces,
    fallbackSource: 'baseline-schedule',
    useSourceCover: !overrideActive,
    allowFallbackWhenNotApplicable: false,
  });
  const mainFaces = positionResolution.faces;
  const layerSpacing = positionResolution.layerSpacing || resolveBeamLayerSpacing(positionData);

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

  const context = {
    width,
    depth,
    mainCenters,
    layerSpacing,
    applyDefaults: positionResolution.applyDefaults,
    faceSources: positionResolution.faceSources,
  };
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
  const webUnresolved = [];
  const webBar = positionData?.webBar;
  const webCount = Number.parseInt(webBar?.count, 10) || 0;
  if (webBar && webCount > 0) {
    if (webCount % 2 !== 0) {
      webUnresolved.push(`web-bar-count-not-pairable:${webCount}`);
    } else {
      const dia = webBar.dia || DEFAULT_WEB_DIA;
      const levelCount = webCount / 2;
      const spacing = (mainCenters.bottom - mainCenters.top) / (levelCount + 1);
      for (let i = 1; i <= levelCount; i += 1) {
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
  }

  const hasCenterPlacement = hasRcScheduleFaceValue(explicitCenters, BEAM_FACE_KEYS);
  const hasSourceCoverPlacement =
    !overrideActive && hasRcScheduleFaceValue(strictSourceCover, BEAM_FACE_KEYS);

  return {
    width,
    depth,
    covers: sourceCovers,
    sourceCovers,
    layerSpacing,
    scheduleHoopFaces: hoopFaces,
    scheduleMainFaces: mainFaces,
    positionSources: positionResolution.faceSources,
    unresolvedPlacement: [...positionResolution.unresolved, ...webUnresolved],
    profile,
    placementMode: overrideActive
      ? 'DRAWING_COVER_OVERRIDE'
      : hasCenterPlacement
        ? 'STB_CENTER'
        : hasSourceCoverPlacement
          ? 'STB_COVER'
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
