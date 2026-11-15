/**
 * @fileoverview RC梁の2D断面リスト/3D配筋で共有する断面内主筋位置resolver。
 *
 * ST-Bridgeの主筋重心位置、かぶり、段筋重心間距離/あきを同じ優先順位で解決し、
 * 1段目・多段筋の位置sourceをfactsとして保持する。
 */

import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { BEAM_REBAR_PLACEMENT_RULES } from '../../../constants/rebarPlacementRules.js';
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';

const DEFAULT_MAIN_DIA = BEAM_REBAR_PLACEMENT_RULES.defaultMainBarDia;
const FACE_KEYS = ['top', 'bottom', 'left', 'right'];

function hasOwnMetadata(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function positiveDistance(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeDistance(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeCenters(value) {
  if (!value) return null;
  const side = value.side;
  return {
    top: value.top,
    bottom: value.bottom,
    left: value.left ?? side,
    right: value.right ?? side,
  };
}

function coverMetadata(cover, key) {
  return hasOwnMetadata(cover, key) ? cover[key] : null;
}

function resolveRawMetadata(positionData, fallbackCover = null) {
  const cover = positionData?.cover ?? fallbackCover ?? null;
  const sourceCover = hasOwnMetadata(positionData, 'sourceCover')
    ? positionData.sourceCover
    : (coverMetadata(cover, 'sourceCover') ?? cover);
  const mainCenters = hasOwnMetadata(positionData, 'mainCenters')
    ? positionData.mainCenters
    : coverMetadata(cover, 'mainCenters');
  const layerSpacing = hasOwnMetadata(positionData, 'layerSpacing')
    ? positionData.layerSpacing
    : coverMetadata(cover, 'layerSpacing');
  const applyDefaults = hasOwnMetadata(positionData, 'applyDefaults')
    ? positionData.applyDefaults
    : coverMetadata(cover, 'applyDefaults');

  return {
    sourceCover: sourceCover || null,
    mainCenters: normalizeCenters(mainCenters),
    layerSpacing: layerSpacing || null,
    applyDefaults: applyDefaults || null,
  };
}

function groupDiameterMm(group, fallbackDia = DEFAULT_MAIN_DIA) {
  return barDiameterMm(group?.dia || fallbackDia, barDiameterMm(fallbackDia));
}

/**
 * 梁主筋を段単位のfactsへ正規化する。
 * @param {Object|null} bar topBar / bottomBar
 * @param {string} [defaultDia]
 * @returns {Array<Object>}
 */
export function normalizeBeamRebarLayers(bar, defaultDia = DEFAULT_MAIN_DIA) {
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
                dia: group.dia || layer.dia || bar?.dia || defaultDia,
                grade: group.grade || layer.grade || bar?.grade || null,
                diaEstimated: !(group.dia || layer.dia || bar?.dia),
              }))
          : [];
        const largestGroup = barGroups.reduce(
          (largest, group) =>
            !largest || groupDiameterMm(group, defaultDia) > groupDiameterMm(largest, defaultDia)
              ? group
              : largest,
          null,
        );
        return {
          step: Number(layer.step) > 0 ? Number(layer.step) : index + 1,
          count: Number(layer.count),
          dia: largestGroup?.dia || layer.dia || bar?.dia || defaultDia,
          grade: layer.grade || bar?.grade || null,
          diaEstimated: largestGroup?.diaEstimated ?? !(layer.dia || bar?.dia),
          barGroups,
        };
      })
      .sort((a, b) => a.step - b.step);
  }

  if (!bar) return [];
  const dia = bar.dia || defaultDia;
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

export function resolveBeamLayerGroups(layer) {
  if (layer?.barGroups?.length > 0) return layer.barGroups;
  if (!layer) return [];
  return [
    {
      count: layer.count,
      dia: layer.dia,
      grade: layer.grade,
      diaEstimated: layer.diaEstimated,
    },
  ];
}

export function beamLayerLayoutRadiusMm(layer, defaultDia = DEFAULT_MAIN_DIA) {
  const groups = resolveBeamLayerGroups(layer);
  if (groups.length === 0) return barDiameterMm(defaultDia) / 2;
  return Math.max(...groups.map((group) => groupDiameterMm(group, defaultDia) / 2));
}

function outerInSlotOrder(slotCount) {
  const count = Math.max(0, Number.parseInt(slotCount, 10) || 0);
  const order = [];
  let start = 0;
  let end = count - 1;
  while (start <= end) {
    order.push(start);
    if (start !== end) order.push(end);
    start += 1;
    end -= 1;
  }
  return order;
}

/**
 * STPの外周脚・中子筋を1段筋のslotへ割り当て、2段筋の優先候補を返す。
 * 中子筋の本数がslot数を超える場合は、実際の主筋と対応しないため外周脚のみを候補とする。
 */
export function resolveBeamStirrupPreferredPositions(firstLayerPositions, stirrupCount) {
  const slots = [...(firstLayerPositions || [])].filter(Number.isFinite).sort((a, b) => a - b);
  if (!slots.length || !(Number(stirrupCount) >= 2)) return [];
  const innerCount = Math.max(0, Math.trunc(Number(stirrupCount)) - 2);
  const anchors = [slots[0], slots[slots.length - 1]];
  if (slots.length < innerCount + 2) return anchors;
  const lastIndex = slots.length - 1;
  for (let i = 1; i <= innerCount; i += 1) {
    const targetIndex = Math.round((lastIndex * i) / (innerCount + 1));
    const index = Math.max(i, Math.min(lastIndex - (innerCount - i) - 1, targetIndex));
    anchors.push(slots[index]);
  }
  return anchors;
}

/**
 * 2段目以降の筋を、1段目から間引いたslotに配置する。
 * STP脚のslotを優先しつつ、左右端と全体の均等性を保つ。
 * 上段より本数が多い場合はslotを間引けないためnullを返し、従来の均等割付へ戻す。
 */
export function selectBeamLayerXPositions(count, firstLayerPositions, preferredPositions = []) {
  const slots = [...(firstLayerPositions || [])];
  const required = Math.trunc(Number(count));
  if (!Number.isFinite(required) || required <= 0) return [];
  if (!slots.length || required > slots.length) return null;
  // 2段筋が1本だけの場合は中央へ寄せず、左側外周STPに沿う1段筋の左端slotを使用する。
  // 1段筋のslotはX座標の昇順で生成されるため、先頭が左側の配置位置となる。
  if (required === 1) return [slots[0]];
  if (required === slots.length) return slots;

  // 断面図におけるslotの均等配置と、STP脚に対応するslotの優先配置を
  // 動的計画法で両立させる。必要本数は変えず、同じslotを二度選ばない。
  const n = slots.length;
  const preferred = slots.map((x) =>
    preferredPositions.some((anchor) => Number.isFinite(anchor) && Math.abs(anchor - x) < 1e-6),
  );
  let previous = new Map([[-1, { cost: 0, indices: [] }]]);
  for (let position = 0; position < required; position += 1) {
    const next = new Map();
    const ideal = ((n - 1) * position) / (required - 1);
    for (let index = position; index <= n - (required - position); index += 1) {
      // 2本以上は左右端を保持し、段筋が片側へ偏らないようにする。
      if (required > 1 && position === 0 && index !== 0) continue;
      if (required > 1 && position === required - 1 && index !== n - 1) continue;
      const placementCost = (index - ideal) ** 2 + (preferred[index] ? 0 : 1.25);
      for (const [last, candidate] of previous) {
        if (last >= index) continue;
        const cost = candidate.cost + placementCost;
        const current = next.get(index);
        if (!current || cost < current.cost - 1e-9) {
          next.set(index, { cost, indices: [...candidate.indices, index] });
        }
      }
    }
    previous = next;
  }
  const optimal = [...previous.values()].reduce(
    (best, current) => (!best || current.cost < best.cost ? current : best),
    null,
  );
  return optimal ? optimal.indices.map((index) => slots[index]) : null;
}

/**
 * 1段内に異径groupがある場合、外側から内側へslotを割り当てる。
 * @param {Object} layer normalized layer
 * @param {number[]} positions 断面幅方向座標
 * @returns {Array<{position:number,dia:string,grade:string|null,diaEstimated:boolean}>}
 */
export function assignBeamLayerGroupsToPositions(layer, positions) {
  const groups = resolveBeamLayerGroups(layer);
  if (positions.length === 0 || groups.length === 0) return [];
  if (!layer?.barGroups?.length) {
    const group = groups[0];
    return positions.map((position) => ({ position, ...group }));
  }

  const result = [];
  const slotOrder = outerInSlotOrder(positions.length);
  let cursor = 0;
  for (const group of groups) {
    for (let i = 0; i < Number(group.count) && cursor < slotOrder.length; i += 1) {
      result.push({ position: positions[slotOrder[cursor]], ...group });
      cursor += 1;
    }
  }
  const fallback = {
    count: 1,
    dia: layer.dia,
    grade: layer.grade || null,
    diaEstimated: !!layer.diaEstimated,
  };
  while (cursor < slotOrder.length) {
    result.push({ position: positions[slotOrder[cursor]], ...fallback });
    cursor += 1;
  }
  return result;
}

function applyValue(applyDefaults, group, key) {
  if (!applyDefaults?.setDefault) return null;
  return group === 'center'
    ? positiveDistance(applyDefaults.mainCenters?.[key])
    : group === 'cover'
      ? nonNegativeDistance(applyDefaults.sourceCover?.[key])
      : null;
}

/**
 * 1段目の主筋芯を4面からの距離へ解決する。
 * center > apply center > depth_cover + 主筋半径 > apply cover + 主筋半径 > fallback。
 */
export function resolveBeamFirstLayerFaces({
  positionData,
  fallbackCover = null,
  fallbackFaces = null,
  fallbackSource = 'caller-fallback',
  useSourceCover = true,
  fallbackCoverMm = null,
  allowFallbackWhenNotApplicable = false,
  defaultMainDia = DEFAULT_MAIN_DIA,
} = {}) {
  const metadata = resolveRawMetadata(positionData, fallbackCover);
  const topLayer = normalizeBeamRebarLayers(positionData?.topBar, defaultMainDia)[0];
  const bottomLayer = normalizeBeamRebarLayers(positionData?.bottomBar, defaultMainDia)[0];
  const topRadius = beamLayerLayoutRadiusMm(topLayer, defaultMainDia);
  const bottomRadius = beamLayerLayoutRadiusMm(bottomLayer, defaultMainDia);
  const sideRadius = Math.max(topRadius, bottomRadius);
  const radii = { top: topRadius, bottom: bottomRadius, left: sideRadius, right: sideRadius };
  const faces = {};
  const faceSources = {};
  const unresolved = [];
  const notApplicable = metadata.applyDefaults?.applicable === false;

  for (const key of FACE_KEYS) {
    const explicitCenter = positiveDistance(metadata.mainCenters?.[key]);
    if (explicitCenter !== null) {
      faces[key] = explicitCenter;
      faceSources[key] = 'stb-center';
      continue;
    }

    const defaultCenter = applyValue(metadata.applyDefaults, 'center', key);
    if (defaultCenter !== null) {
      faces[key] = defaultCenter;
      faceSources[key] = 'stb-apply-center';
      continue;
    }

    const explicitCover = nonNegativeDistance(metadata.sourceCover?.[key]);
    if (useSourceCover && explicitCover !== null) {
      faces[key] = explicitCover + radii[key];
      faceSources[key] = 'stb-cover';
      continue;
    }

    const defaultCover = applyValue(metadata.applyDefaults, 'cover', key);
    if (useSourceCover && defaultCover !== null) {
      faces[key] = defaultCover + radii[key];
      faceSources[key] = 'stb-apply-cover';
      continue;
    }

    if (notApplicable && !allowFallbackWhenNotApplicable) {
      faces[key] = null;
      faceSources[key] = 'unresolved';
      unresolved.push(`apply-not-applicable:${key}`);
      continue;
    }

    const callerFallback = positiveDistance(fallbackFaces?.[key]);
    if (callerFallback !== null) {
      faces[key] = callerFallback;
      faceSources[key] = fallbackSource;
      continue;
    }

    const standardCover = nonNegativeDistance(fallbackCoverMm);
    if (standardCover !== null) {
      faces[key] = standardCover + radii[key];
      faceSources[key] = 'standard-cover';
      continue;
    }

    faces[key] = null;
    faceSources[key] = 'unresolved';
    unresolved.push(`missing-first-layer-position:${key}`);
  }

  return { ...metadata, faces, faceSources, unresolved };
}

function spacingSource(layerSpacing) {
  if (hasOwnMetadata(layerSpacing, 'centerSource')) return layerSpacing.centerSource;
  return 'stb-center-interval';
}

function layerDesignation(layer, defaultDia) {
  return layer?.dia || defaultDia;
}

/**
 * 隣接する段筋の重心間距離を解決する。
 * center距離 > clear interval + 呼び径半径和 > 日建連2023 表2-4。
 */
export function resolveBeamLayerCenterSpacingMm({
  previousLayer,
  currentLayer,
  layerSpacing = null,
  applyDefaults = null,
  standardRules = REBAR_STANDARD_RULES,
  defaultMainDia = DEFAULT_MAIN_DIA,
  allowStandardWhenNotApplicable = false,
} = {}) {
  const directCenter = positiveDistance(layerSpacing?.centerInterval);
  if (directCenter !== null) {
    return { value: directCenter, source: spacingSource(layerSpacing), estimated: false };
  }

  const applyCenter = applyDefaults?.setDefault
    ? positiveDistance(applyDefaults.layerSpacing?.centerInterval)
    : null;
  if (applyCenter !== null) {
    return { value: applyCenter, source: 'stb-apply-length-to-center', estimated: false };
  }

  const previousRadius = beamLayerLayoutRadiusMm(previousLayer, defaultMainDia);
  const currentRadius = beamLayerLayoutRadiusMm(currentLayer, defaultMainDia);
  const directClear = positiveDistance(layerSpacing?.clearInterval);
  if (directClear !== null) {
    return {
      value: directClear + previousRadius + currentRadius,
      source: 'stb-clear-interval',
      estimated: false,
    };
  }

  const applyClear = applyDefaults?.setDefault
    ? positiveDistance(applyDefaults.layerSpacing?.clearInterval)
    : null;
  if (applyClear !== null) {
    return {
      value: applyClear + previousRadius + currentRadius,
      source: 'stb-apply-clear-interval',
      estimated: false,
    };
  }

  if (applyDefaults?.applicable === false && !allowStandardWhenNotApplicable) {
    return { value: null, source: 'unresolved', estimated: false };
  }

  const previousDia = layerDesignation(previousLayer, defaultMainDia);
  const currentDia = layerDesignation(currentLayer, defaultMainDia);
  if (String(previousDia).toUpperCase() === String(currentDia).toUpperCase()) {
    const row = standardRules.resolveSpacingByDesignation(previousDia);
    if (Number.isFinite(row?.layer2MinMm)) {
      return { value: row.layer2MinMm, source: 'standard-table-2-4', estimated: true };
    }
  }

  const previousDiaMm = barDiameterMm(previousDia, barDiameterMm(defaultMainDia));
  const currentDiaMm = barDiameterMm(currentDia, barDiameterMm(defaultMainDia));
  const clear = standardRules.resolveMainBarClearSpacingMm({
    firstDiaMm: previousDiaMm,
    secondDiaMm: currentDiaMm,
  });
  if (!Number.isFinite(clear)) {
    return { value: null, source: 'unresolved', estimated: true };
  }

  const previousOuter = barOuterDiameterMm(previousDia, previousDiaMm);
  const currentOuter = barOuterDiameterMm(currentDia, currentDiaMm);
  return {
    value: clear + previousOuter / 2 + currentOuter / 2,
    source: 'standard-table-2-4',
    estimated: true,
  };
}

export function getBeamPositionMetadata(positionData, fallbackCover = null) {
  return resolveRawMetadata(positionData, fallbackCover);
}
