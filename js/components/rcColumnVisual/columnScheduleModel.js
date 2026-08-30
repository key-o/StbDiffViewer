/**
 * @fileoverview RC柱断面リストの共通プレゼンテーションモデル
 *
 * UI(SVG)とDXFで柱配筋位置を別々に計算しないため、矩形/円形断面、
 * 主筋1・2段、異径主筋、芯鉄筋、HOOP外周・中子筋をmm単位の
 * ローカル座標（左上原点、X右向き、Y下向き）へ正規化する。
 */

import { selectOuterInValues } from '../rebarSlotLayout.js';
import {
  createEvenlySpacedValues,
  parseNumericRebarDiameterMm,
} from '../rebarGeometryUtils.js';
import {
  BASELINE_COLUMN_COVER_FACES,
  averageColumnCoverFaces,
  normalizeColumnCoverFaces,
  resolveColumnMainCenterFaces,
  selectBaselineInnerLegSlotIndices,
} from '../../ui/panels/sectionList/columnSectionCover.js';

const DEFAULT_MAIN_DIA = 'D22';

function toPositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function parseColumnBarDiameterMm(dia) {
  return parseNumericRebarDiameterMm(dia, 0);
}

function resolveCenterDistance(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function evenlySpaced(start, end, count) {
  return createEvenlySpacedValues(start, end, count);
}

function pointKey(point) {
  return `${Number(point.x).toFixed(6)}:${Number(point.y).toFixed(6)}`;
}

function uniqueSorted(values) {
  return [
    ...new Set(values.filter(Number.isFinite).map((value) => Number(value.toFixed(9)))),
  ].sort((a, b) => a - b);
}

function createSharedAxisValues(start, end, firstCount, secondCount, minimumSlotCount = 0) {
  const maxCount = Math.max(
    toPositiveInteger(firstCount),
    toPositiveInteger(secondCount),
    toPositiveInteger(minimumSlotCount),
  );
  return evenlySpaced(start, end, maxCount);
}

function calculateRectangularPositionsFromValues(
  xValues,
  yValues,
  xLeft,
  xRight,
  yTop,
  yBottom,
) {
  const positions = new Map();
  const add = (point, direction) => {
    const key = pointKey(point);
    const existing = positions.get(key);
    if (existing) {
      if (!existing.directions.includes(direction)) existing.directions.push(direction);
    } else {
      positions.set(key, { ...point, directions: [direction] });
    }
  };

  xValues.forEach((x) => {
    add({ x, y: yTop }, 'X');
    add({ x, y: yBottom }, 'X');
  });
  yValues.forEach((y) => {
    add({ x: xLeft, y }, 'Y');
    add({ x: xRight, y }, 'Y');
  });
  return Array.from(positions.values());
}

function calculateAlignedSecondLayerPositions(countX, countY, sharedAxes, bounds) {
  const xValues = selectOuterInValues(sharedAxes.x, countY);
  const yValues = selectOuterInValues(sharedAxes.y, countX);
  const positions = [];

  xValues.forEach((x) => {
    positions.push({ x, y: bounds.yTop, directions: ['X'] });
    if (bounds.yBottom !== bounds.yTop) {
      positions.push({ x, y: bounds.yBottom, directions: ['X'] });
    }
  });

  // 上下辺に2本以上ある場合、側辺の隅は上下辺で表現済みとみなし内側だけを使う。
  const sideValues = xValues.length >= 2 ? yValues.slice(1, -1) : yValues;
  sideValues.forEach((y) => {
    positions.push({ x: bounds.xLeft, y, directions: ['Y'] });
    if (bounds.xRight !== bounds.xLeft) {
      positions.push({ x: bounds.xRight, y, directions: ['Y'] });
    }
  });
  return positions;
}

function selectPerimeterPositions(positions, targetTotal) {
  if (!Number.isFinite(targetTotal) || targetTotal >= positions.length) return positions;
  if (targetTotal <= 0) return [];

  const corners = positions.filter((position) => position.directions.length > 1);
  if (targetTotal <= corners.length) return corners.slice(0, targetTotal);

  const interior = positions.filter((position) => position.directions.length === 1);
  const interiorTarget = targetTotal - corners.length;
  const selectedInterior = new Set();
  if (interiorTarget === 1) {
    selectedInterior.add(interior[Math.floor(interior.length / 2)]);
  } else if (interiorTarget > 1 && interior.length > 0) {
    for (let index = 0; index < interiorTarget; index += 1) {
      const sourceIndex = Math.round((index * (interior.length - 1)) / (interiorTarget - 1));
      selectedInterior.add(interior[sourceIndex]);
    }
  }
  const selectedCorners = new Set(corners);
  return positions.filter(
    (position) => selectedCorners.has(position) || selectedInterior.has(position),
  );
}

function createDiameterPattern(groups, countKey, cornerDia) {
  const diameters = groups.flatMap((group) =>
    Array(toPositiveInteger(group[countKey])).fill(group.dia || cornerDia),
  );
  if (diameters.length <= 2) return diameters;

  const firstCorner = diameters.indexOf(cornerDia);
  if (firstCorner > 0) {
    [diameters[0], diameters[firstCorner]] = [diameters[firstCorner], diameters[0]];
  }
  const lastCorner = diameters.lastIndexOf(cornerDia);
  if (lastCorner >= 0 && lastCorner < diameters.length - 1) {
    [diameters[diameters.length - 1], diameters[lastCorner]] = [
      diameters[lastCorner],
      diameters[diameters.length - 1],
    ];
  }
  return diameters;
}

function resolveBarDiameter(mainBar, position, bounds, mixedPatterns, primaryDia) {
  if (mixedPatterns) {
    const direction =
      position.directions.length > 1
        ? mainBar.mainDirection === 'Y'
          ? 'Y'
          : 'X'
        : position.directions[0];
    const pattern = mixedPatterns[direction];
    if (pattern?.length) {
      const start = direction === 'X' ? bounds.xLeft : bounds.yTop;
      const end = direction === 'X' ? bounds.xRight : bounds.yBottom;
      const value = direction === 'X' ? position.x : position.y;
      const ratio = end === start ? 0 : (value - start) / (end - start);
      const index = Math.max(
        0,
        Math.min(pattern.length - 1, Math.round(ratio * (pattern.length - 1))),
      );
      return pattern[index] || primaryDia;
    }
  }

  if (!mainBar.diaSub || mainBar.diaSub === primaryDia) return primaryDia;
  const mainDirection = mainBar.mainDirection === 'Y' ? 'Y' : 'X';
  return position.directions.includes(mainDirection) ? primaryDia : mainBar.diaSub;
}

function normalizeDirectionalGroup(group, fallbackDia, fallbackGrade) {
  return {
    countX: toPositiveInteger(group?.countX),
    countY: toPositiveInteger(group?.countY),
    dia: group?.dia || fallbackDia || DEFAULT_MAIN_DIA,
    grade: group?.grade || fallbackGrade || null,
  };
}

function getFirstLayerGroups(mainBar) {
  const explicitLayer = Array.isArray(mainBar?.layers)
    ? mainBar.layers.find((layer) => Number(layer?.step) === 1) || mainBar.layers[0]
    : null;
  if (explicitLayer?.groups?.length) {
    return explicitLayer.groups.map((group) =>
      normalizeDirectionalGroup(
        group,
        explicitLayer.dia || mainBar?.dia,
        explicitLayer.grade || mainBar?.grade,
      ),
    );
  }

  return [
    normalizeDirectionalGroup(mainBar, mainBar?.dia, mainBar?.grade),
    ...(Array.isArray(mainBar?.firstLayerExtraGroups)
      ? mainBar.firstLayerExtraGroups.map((group) =>
          normalizeDirectionalGroup(group, mainBar?.dia, mainBar?.grade),
        )
      : []),
  ].filter((group) => group.countX > 0 || group.countY > 0);
}

function getSecondLayerGroups(mainBar) {
  const explicitLayer = Array.isArray(mainBar?.layers)
    ? mainBar.layers.find((layer) => Number(layer?.step) === 2)
    : null;
  if (explicitLayer?.groups?.length) {
    return {
      centerInterval: explicitLayer.centerInterval ?? mainBar?.secondLayer?.centerInterval,
      clearInterval: explicitLayer.clearInterval ?? mainBar?.secondLayer?.clearInterval,
      groups: explicitLayer.groups.map((group) =>
        normalizeDirectionalGroup(
          group,
          explicitLayer.dia || mainBar?.dia,
          explicitLayer.grade || mainBar?.grade,
        ),
      ),
    };
  }

  const second = mainBar?.secondLayer;
  if (!second) return null;
  const groups = second.groups?.length ? second.groups : [second];
  return {
    centerInterval: second.centerInterval,
    clearInterval: second.clearInterval,
    groups: groups.map((group) =>
      normalizeDirectionalGroup(group, mainBar?.dia, mainBar?.grade),
    ),
  };
}

function createMixedPatterns(groups, primaryDia) {
  if (!groups || groups.length <= 1) return null;
  return {
    X: createDiameterPattern(groups, 'countY', primaryDia),
    Y: createDiameterPattern(groups, 'countX', primaryDia),
  };
}

function placeFirstLayer(mainBar, bounds, sharedAxes) {
  const groups = getFirstLayerGroups(mainBar);
  if (groups.length === 0) return { bars: [], countX: 0, countY: 0, groups };

  const countX = groups.reduce((sum, group) => sum + group.countX, 0);
  const countY = groups.reduce((sum, group) => sum + group.countY, 0);
  const xValues = selectOuterInValues(sharedAxes.x, countY);
  const yValues = selectOuterInValues(sharedAxes.y, countX);
  const all = calculateRectangularPositionsFromValues(
    xValues,
    yValues,
    bounds.xLeft,
    bounds.xRight,
    bounds.yTop,
    bounds.yBottom,
  );
  const targetTotal = toPositiveInteger(mainBar?.countTotal ?? mainBar?.count);
  const selected = targetTotal > 0 ? selectPerimeterPositions(all, targetTotal) : all;
  const primaryDia = mainBar?.dia || groups[0]?.dia || DEFAULT_MAIN_DIA;
  const mixedPatterns = createMixedPatterns(groups, primaryDia);

  return {
    bars: selected.map((position) => ({
      ...position,
      dia: resolveBarDiameter(mainBar || {}, position, bounds, mixedPatterns, primaryDia),
      role: 'main',
      layer: 1,
    })),
    countX,
    countY,
    groups,
  };
}

function placeSecondLayer(mainBar, firstBounds, sharedAxes, remaining, hoopDiameter) {
  const second = getSecondLayerGroups(mainBar);
  if (!second?.groups?.length || remaining <= 0) {
    return { bars: [], countX: 0, countY: 0 };
  }

  const countX = second.groups.reduce((sum, group) => sum + group.countX, 0);
  const countY = second.groups.reduce((sum, group) => sum + group.countY, 0);
  if (countX === 0 && countY === 0) return { bars: [], countX, countY };

  const primaryDia = second.groups[0].dia || mainBar?.dia || DEFAULT_MAIN_DIA;
  const mainDia = parseColumnBarDiameterMm(mainBar?.dia || primaryDia);
  const secondDia = parseColumnBarDiameterMm(primaryDia);
  const estimatedInterval = Math.max(30, hoopDiameter + mainDia / 2 + secondDia / 2);
  const clearInterval = Number(second.clearInterval);
  const clearCenterInterval =
    Number.isFinite(clearInterval) && clearInterval > 0
      ? clearInterval + mainDia / 2 + secondDia / 2
      : estimatedInterval;
  const interval = resolveCenterDistance(second.centerInterval, clearCenterInterval);

  const bounds = {
    xLeft: firstBounds.xLeft + interval,
    xRight: firstBounds.xRight - interval,
    yTop: firstBounds.yTop + interval,
    yBottom: firstBounds.yBottom - interval,
  };
  if (bounds.xLeft > bounds.xRight || bounds.yTop > bounds.yBottom) {
    return { bars: [], countX, countY };
  }

  const all = calculateAlignedSecondLayerPositions(countX, countY, sharedAxes, bounds);
  const selected = Number.isFinite(remaining) ? selectPerimeterPositions(all, remaining) : all;
  const mixedPatterns = createMixedPatterns(second.groups, primaryDia);
  const patternBounds = {
    xLeft: sharedAxes.x[0] ?? bounds.xLeft,
    xRight: sharedAxes.x.at(-1) ?? bounds.xRight,
    yTop: sharedAxes.y[0] ?? bounds.yTop,
    yBottom: sharedAxes.y.at(-1) ?? bounds.yBottom,
  };

  return {
    bars: selected.map((position) => ({
      ...position,
      dia: resolveBarDiameter(
        { ...mainBar, dia: primaryDia, diaSub: null },
        position,
        patternBounds,
        mixedPatterns,
        primaryDia,
      ),
      role: 'main',
      layer: 2,
    })),
    countX,
    countY,
  };
}

function createRectangularCoreBars(coreBar, width, height, sharedAxes) {
  const legacyTotal = toPositiveInteger(coreBar?.countX) + toPositiveInteger(coreBar?.countY);
  const total = toPositiveInteger(coreBar?.total) || legacyTotal;
  if (total === 0 || !coreBar?.dia) return [];

  const explicit = Array.isArray(coreBar.positions)
    ? coreBar.positions
        .map((position) => ({
          x: Number(position?.x ?? position?.X),
          y: Number(position?.y ?? position?.Y),
        }))
        .filter((position) => Number.isFinite(position.x) && Number.isFinite(position.y))
        .map((position) => ({
          x: width / 2 + position.x,
          y: height / 2 - position.y,
          directions: [],
        }))
        .slice(0, total)
    : [];
  if (explicit.length === total) {
    return explicit.map((position) => ({
      ...position,
      dia: coreBar.dia,
      role: 'core',
      layer: null,
    }));
  }

  let estimated = null;
  const sideCount = (total + 4) / 4;
  if (
    Number.isInteger(sideCount) &&
    sideCount >= 2 &&
    sharedAxes.x.length >= sideCount + 2 &&
    sharedAxes.y.length >= sideCount + 2
  ) {
    const selectCentered = (values) => {
      const start = Math.floor((values.length - sideCount) / 2);
      return values.slice(start, start + sideCount);
    };
    const xs = selectCentered(sharedAxes.x);
    const ys = selectCentered(sharedAxes.y);
    estimated = calculateRectangularPositionsFromValues(
      xs,
      ys,
      xs[0],
      xs.at(-1),
      ys[0],
      ys.at(-1),
    );
  }

  if (!estimated) {
    const cx = width / 2;
    const cy = height / 2;
    const halfWidth = width * 0.22;
    const halfHeight = height * 0.22;
    if (total === 1) {
      estimated = [{ x: cx, y: cy, directions: [] }];
    } else if (total === 2) {
      estimated = [
        { x: cx - halfWidth, y: cy, directions: [] },
        { x: cx + halfWidth, y: cy, directions: [] },
      ];
    } else if (total === 3) {
      estimated = [
        { x: cx, y: cy - halfHeight, directions: [] },
        { x: cx - halfWidth, y: cy + halfHeight, directions: [] },
        { x: cx + halfWidth, y: cy + halfHeight, directions: [] },
      ];
    } else {
      const left = cx - halfWidth;
      const right = cx + halfWidth;
      const top = cy - halfHeight;
      const bottom = cy + halfHeight;
      const rectWidth = right - left;
      const rectHeight = bottom - top;
      const perimeter = 2 * (rectWidth + rectHeight);
      estimated = Array.from({ length: total }, (_, index) => {
        let distance = (perimeter * index) / total;
        if (distance <= rectWidth) return { x: left + distance, y: top, directions: [] };
        distance -= rectWidth;
        if (distance <= rectHeight) return { x: right, y: top + distance, directions: [] };
        distance -= rectHeight;
        if (distance <= rectWidth) return { x: right - distance, y: bottom, directions: [] };
        distance -= rectWidth;
        return { x: left, y: bottom - distance, directions: [] };
      });
    }
  }

  const positions = [...explicit];
  const used = new Set(explicit.map(pointKey));
  for (const point of estimated) {
    if (positions.length >= total) break;
    const key = pointKey(point);
    if (!used.has(key)) {
      positions.push(point);
      used.add(key);
    }
  }
  return positions.map((position) => ({
    ...position,
    dia: coreBar.dia,
    role: 'core',
    layer: null,
  }));
}

function buildRectangularColumnGeometry(sectionData, options) {
  const width = Number(sectionData?.width) || 0;
  const height = Number(sectionData?.height) || 0;
  if (!(width > 0) || !(height > 0)) return null;

  const coverFaces = normalizeColumnCoverFaces(
    options.coverFaces || BASELINE_COLUMN_COVER_FACES,
  );
  const mainBar = sectionData?.mainBar || {};
  const hoop = sectionData?.hoop || {};
  const centers = resolveColumnMainCenterFaces(mainBar, coverFaces);
  const firstBounds = {
    xLeft: centers.startX,
    xRight: width - centers.endX,
    yTop: centers.endY,
    yBottom: height - centers.startY,
  };
  if (firstBounds.xLeft > firstBounds.xRight || firstBounds.yTop > firstBounds.yBottom) {
    return null;
  }

  const firstGroups = getFirstLayerGroups(mainBar);
  const firstCountX = firstGroups.reduce((sum, group) => sum + group.countX, 0);
  const firstCountY = firstGroups.reduce((sum, group) => sum + group.countY, 0);
  const secondLayer = getSecondLayerGroups(mainBar);
  const secondCountX =
    secondLayer?.groups?.reduce((sum, group) => sum + group.countX, 0) || 0;
  const secondCountY =
    secondLayer?.groups?.reduce((sum, group) => sum + group.countY, 0) || 0;
  const shared = options.sharedSlotCounts || {};
  const sharedAxes = {
    x: createSharedAxisValues(
      firstBounds.xLeft,
      firstBounds.xRight,
      firstCountY,
      secondCountY,
      Math.max(toPositiveInteger(shared.y), toPositiveInteger(hoop.countY)),
    ),
    y: createSharedAxisValues(
      firstBounds.yTop,
      firstBounds.yBottom,
      firstCountX,
      secondCountX,
      Math.max(toPositiveInteger(shared.x), toPositiveInteger(hoop.countX)),
    ),
  };

  const first = placeFirstLayer(mainBar, firstBounds, sharedAxes);
  const targetTotal = toPositiveInteger(mainBar?.countTotal ?? mainBar?.count);
  const remaining = targetTotal > 0 ? Math.max(0, targetTotal - first.bars.length) : Infinity;
  const second = placeSecondLayer(
    mainBar,
    firstBounds,
    sharedAxes,
    remaining,
    parseColumnBarDiameterMm(hoop?.dia),
  );
  const mainBars = [...first.bars, ...second.bars];

  const xAnchors = uniqueSorted(
    first.bars.filter((bar) => bar.directions.includes('X')).map((bar) => bar.x),
  );
  const yAnchors = uniqueSorted(
    first.bars.filter((bar) => bar.directions.includes('Y')).map((bar) => bar.y),
  );
  const hoopBounds = hoop?.dia
    ? {
        left: coverFaces.startX,
        right: width - coverFaces.endX,
        top: coverFaces.endY,
        bottom: height - coverFaces.startY,
      }
    : null;
  const innerLegs = [];
  if (hoopBounds) {
    const offset = Math.max(0, parseColumnBarDiameterMm(mainBar?.dia));
    const offsetFromCenter = (anchor, start, end) => {
      const direction = anchor <= (start + end) / 2 ? -1 : 1;
      return Math.max(start, Math.min(end, anchor + direction * offset));
    };

    selectBaselineInnerLegSlotIndices(yAnchors.length, hoop.countX).forEach((slotIndex) => {
      const anchorY = yAnchors[slotIndex];
      if (!Number.isFinite(anchorY)) return;
      const y = offsetFromCenter(anchorY, hoopBounds.top, hoopBounds.bottom);
      innerLegs.push({
        orientation: 'H',
        x1: hoopBounds.left,
        y1: y,
        x2: hoopBounds.right,
        y2: y,
        anchorY,
      });
    });
    selectBaselineInnerLegSlotIndices(xAnchors.length, hoop.countY).forEach((slotIndex) => {
      const anchorX = xAnchors[slotIndex];
      if (!Number.isFinite(anchorX)) return;
      const x = offsetFromCenter(anchorX, hoopBounds.left, hoopBounds.right);
      innerLegs.push({
        orientation: 'V',
        x1: x,
        y1: hoopBounds.top,
        x2: x,
        y2: hoopBounds.bottom,
        anchorX,
      });
    });
  }

  const coreBars = createRectangularCoreBars(sectionData?.coreBar, width, height, sharedAxes);
  return {
    kind: 'RECT',
    width,
    height,
    coverFaces,
    concrete: { left: 0, top: 0, right: width, bottom: height },
    hoop: hoopBounds
      ? {
          ...hoopBounds,
          dia: hoop.dia,
          countX: hoop.countX,
          countY: hoop.countY,
          pitch: hoop.pitch,
          innerLegs,
        }
      : null,
    mainBars,
    coreBars,
    sharedAxes,
    mainCenterFaces: centers,
  };
}

function buildCircularColumnGeometry(sectionData, options) {
  const diameter = Number(sectionData?.diameter) || 0;
  if (!(diameter > 0)) return null;

  const coverFaces = normalizeColumnCoverFaces(
    options.coverFaces || BASELINE_COLUMN_COVER_FACES,
  );
  const coverAverage = averageColumnCoverFaces(coverFaces);
  const center = diameter / 2;
  const mainBar = sectionData?.mainBar || {};
  const hoop = sectionData?.hoop || {};
  const count = toPositiveInteger(mainBar.countTotal ?? mainBar.count);
  const explicitCenter = Number(mainBar.center ?? mainBar.dt);
  const centerDistance =
    Number.isFinite(explicitCenter) && explicitCenter > 0
      ? explicitCenter
      : resolveColumnMainCenterFaces({}, coverFaces).startX;
  const mainRadius = Math.max(0, center - centerDistance);
  const mainBars = [];
  if (count > 0 && mainBar.dia) {
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      mainBars.push({
        x: center + mainRadius * Math.cos(angle),
        y: center + mainRadius * Math.sin(angle),
        dia: mainBar.dia,
        role: 'main',
        layer: 1,
        directions: [],
      });
    }
  }

  const coreBar = sectionData?.coreBar;
  const coreLegacyTotal = toPositiveInteger(coreBar?.countX) + toPositiveInteger(coreBar?.countY);
  const coreTotal = toPositiveInteger(coreBar?.total) || coreLegacyTotal;
  const coreBars = [];
  if (coreTotal > 0 && coreBar?.dia) {
    const explicit = Array.isArray(coreBar.positions)
      ? coreBar.positions
          .map((position) => ({
            x: Number(position?.x ?? position?.X),
            y: Number(position?.y ?? position?.Y),
          }))
          .filter((position) => Number.isFinite(position.x) && Number.isFinite(position.y))
          .map((position) => ({ x: center + position.x, y: center - position.y }))
          .slice(0, coreTotal)
      : [];
    const used = new Set(explicit.map(pointKey));
    coreBars.push(
      ...explicit.map((point) => ({
        ...point,
        dia: coreBar.dia,
        role: 'core',
        layer: null,
      })),
    );
    const estimatedRadius = Math.max(0, mainRadius * 0.55);
    const estimated =
      coreTotal === 1
        ? [{ x: center, y: center }]
        : Array.from({ length: coreTotal }, (_, index) => {
            const angle = (index / coreTotal) * Math.PI * 2 - Math.PI / 2;
            return {
              x: center + estimatedRadius * Math.cos(angle),
              y: center + estimatedRadius * Math.sin(angle),
            };
          });
    for (const point of estimated) {
      if (coreBars.length >= coreTotal) break;
      const key = pointKey(point);
      if (!used.has(key)) {
        coreBars.push({ ...point, dia: coreBar.dia, role: 'core', layer: null });
        used.add(key);
      }
    }
  }

  return {
    kind: 'CIRCLE',
    width: diameter,
    height: diameter,
    diameter,
    coverFaces,
    concrete: { cx: center, cy: center, radius: center },
    hoop: hoop?.dia
      ? {
          cx: center,
          cy: center,
          radius: Math.max(0, center - coverAverage),
          dia: hoop.dia,
          pitch: hoop.pitch,
          innerLegs: [],
        }
      : null,
    mainBars,
    coreBars,
    sharedAxes: { x: [], y: [] },
    mainRadius,
  };
}

/**
 * 柱断面リストの描画幾何を生成する。
 * @param {Object} sectionData ColumnSectionListRenderer.prepareSvgData() 相当
 * @param {{coverFaces?:Object,sharedSlotCounts?:Object}} options
 */
export function buildColumnScheduleGeometry(sectionData, options = {}) {
  if (sectionData?.diameter || sectionData?.isCircular) {
    return buildCircularColumnGeometry(sectionData, options);
  }
  return buildRectangularColumnGeometry(sectionData, options);
}

export default buildColumnScheduleGeometry;
