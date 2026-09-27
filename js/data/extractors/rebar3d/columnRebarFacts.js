/**
 * @fileoverview RC柱3D配筋用の断面内bar facts正規化
 *
 * columnSectionListExtractor が抽出した1段/2段・異径筋・芯筋を、
 * 3D描画と後続の定着判定で共有できるbar factsへ変換する。
 *
 * ST-Bridge 2.0.2の方向定義:
 * - N_main_X_*: 左右辺に並び、Y方向へ分布する本数
 * - N_main_Y_*: 上下辺に並び、X方向へ分布する本数
 */

import { barDiameterMm, barOuterDiameterMm } from '../../../constants/beamOpeningRules.js';
import { COLUMN_REBAR_PLACEMENT_RULES } from '../../../constants/rebarPlacementRules.js';
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { evenlySpaced, resolveDt } from './rebarSectionUtils.js';

function toPositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function totalCount(mainBar) {
  return toPositiveInteger(mainBar?.countTotal) || toPositiveInteger(mainBar?.count);
}

function normalizeGroup(group, fallbackDia, fallbackGrade) {
  return {
    countX: toPositiveInteger(group?.countX),
    countY: toPositiveInteger(group?.countY),
    dia: group?.dia || fallbackDia || null,
    grade: group?.grade || fallbackGrade || null,
  };
}

function getLayerGroups(mainBar, step) {
  const explicit = Array.isArray(mainBar?.layers)
    ? mainBar.layers.find((layer) => Number(layer?.step) === step)
    : null;
  if (explicit?.groups?.length) {
    return explicit.groups
      .map((group) =>
        normalizeGroup(group, explicit.dia || mainBar?.dia, explicit.grade || mainBar?.grade),
      )
      .filter((group) => group.countX > 0 || group.countY > 0);
  }

  if (step === 2) {
    const second = mainBar?.secondLayer;
    if (!second) return [];
    const groups = second.groups?.length ? second.groups : [second];
    return groups
      .map((group) => normalizeGroup(group, mainBar?.dia, mainBar?.grade))
      .filter((group) => group.countX > 0 || group.countY > 0);
  }

  return [
    normalizeGroup(mainBar, mainBar?.dia, mainBar?.grade),
    ...(Array.isArray(mainBar?.firstLayerExtraGroups)
      ? mainBar.firstLayerExtraGroups.map((group) =>
          normalizeGroup(group, mainBar?.dia, mainBar?.grade),
        )
      : []),
  ].filter((group) => group.countX > 0 || group.countY > 0);
}

function layerCounts(groups) {
  return {
    countX: groups.reduce((sum, group) => sum + group.countX, 0),
    countY: groups.reduce((sum, group) => sum + group.countY, 0),
  };
}

function createOuterInSlotOrder(slotCount) {
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

function selectOuterInValues(values, count) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const target = Math.max(0, Math.min(values.length, toPositiveInteger(count)));
  return createOuterInSlotOrder(values.length)
    .slice(0, target)
    .sort((a, b) => a - b)
    .map((index) => values[index]);
}

function pointKey(point) {
  return `${Number(point.u).toFixed(6)}:${Number(point.v).toFixed(6)}`;
}

function rectangularPositions(horizontalValues, verticalValues, bounds) {
  const positions = new Map();
  const add = (u, v, direction) => {
    const key = pointKey({ u, v });
    const current = positions.get(key);
    if (current) {
      if (!current.directions.includes(direction)) current.directions.push(direction);
    } else {
      positions.set(key, { u, v, directions: [direction] });
    }
  };

  horizontalValues.forEach((u) => {
    add(u, bounds.vBottom, 'X');
    if (bounds.vTop !== bounds.vBottom) add(u, bounds.vTop, 'X');
  });
  verticalValues.forEach((v) => {
    add(bounds.uLeft, v, 'Y');
    if (bounds.uRight !== bounds.uLeft) add(bounds.uRight, v, 'Y');
  });
  return [...positions.values()];
}

function alignedSecondLayerPositions(countX, countY, sharedAxes, bounds) {
  const horizontalValues = selectOuterInValues(sharedAxes.u, countY);
  const verticalValues = selectOuterInValues(sharedAxes.v, countX);
  const positions = [];

  horizontalValues.forEach((u) => {
    positions.push({ u, v: bounds.vBottom, directions: ['X'] });
    if (bounds.vTop !== bounds.vBottom) {
      positions.push({ u, v: bounds.vTop, directions: ['X'] });
    }
  });

  const sideValues = horizontalValues.length >= 2 ? verticalValues.slice(1, -1) : verticalValues;
  sideValues.forEach((v) => {
    positions.push({ u: bounds.uLeft, v, directions: ['Y'] });
    if (bounds.uRight !== bounds.uLeft) {
      positions.push({ u: bounds.uRight, v, directions: ['Y'] });
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
  if (interiorTarget === 1 && interior.length > 0) {
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

function createMixedPatterns(groups, primaryDia) {
  if (!groups || groups.length <= 1) return null;
  return {
    X: createDiameterPattern(groups, 'countY', primaryDia),
    Y: createDiameterPattern(groups, 'countX', primaryDia),
  };
}

function resolveBarDesignation(mainBar, position, bounds, patterns, primaryDia) {
  if (patterns) {
    const direction =
      position.directions.length > 1
        ? mainBar?.mainDirection === 'Y'
          ? 'Y'
          : 'X'
        : position.directions[0];
    const pattern = patterns[direction];
    if (pattern?.length) {
      const start = direction === 'X' ? bounds.uLeft : bounds.vBottom;
      const end = direction === 'X' ? bounds.uRight : bounds.vTop;
      const value = direction === 'X' ? position.u : position.v;
      const ratio = end === start ? 0 : (value - start) / (end - start);
      const index = Math.max(
        0,
        Math.min(pattern.length - 1, Math.round(ratio * (pattern.length - 1))),
      );
      return pattern[index] || primaryDia;
    }
  }

  if (!mainBar?.diaSub || mainBar.diaSub === primaryDia) return primaryDia;
  const mainDirection = mainBar.mainDirection === 'Y' ? 'Y' : 'X';
  return position.directions.includes(mainDirection) ? primaryDia : mainBar.diaSub;
}

function mainBarFact(position, designation, grade, layer, corner) {
  const rules = COLUMN_REBAR_PLACEMENT_RULES;
  const fallbackDia = barDiameterMm(rules.defaultMainBarDia);
  return {
    u: position.u,
    v: position.v,
    dia: barDiameterMm(designation, fallbackDia),
    diaName: designation || rules.defaultMainBarDia,
    grade: grade || null,
    corner: Boolean(corner),
    role: 'main',
    layer,
  };
}

function resolveFirstLayerBounds(dimensions, arrangement, options) {
  const rules = COLUMN_REBAR_PLACEMENT_RULES;
  const mainBar = arrangement.mainBar || {};
  const coverMm = options.coverMm ?? arrangement.cover ?? rules.defaultCoverMm;
  const mainDiaName = mainBar.dia || rules.defaultMainBarDia;
  const hoopDiaName = arrangement.hoop?.dia || rules.defaultHoopDia;
  const mainDiaMm = barDiameterMm(mainDiaName, barDiameterMm(rules.defaultMainBarDia));
  const mainOuterMm = barOuterDiameterMm(mainDiaName, mainDiaMm);
  const hoopDiaMm = barDiameterMm(hoopDiaName, barDiameterMm(rules.defaultHoopDia));
  const hoopOuterMm = barOuterDiameterMm(hoopDiaName, hoopDiaMm);
  const fallbackX = resolveDt(mainBar.dtX, coverMm, hoopOuterMm, mainOuterMm);
  const fallbackY = resolveDt(mainBar.dtY, coverMm, hoopOuterMm, mainOuterMm);

  const startX = positiveNumber(mainBar.centerStartX) ?? fallbackX.value;
  const endX = positiveNumber(mainBar.centerEndX) ?? fallbackX.value;
  const startY = positiveNumber(mainBar.centerStartY) ?? fallbackY.value;
  const endY = positiveNumber(mainBar.centerEndY) ?? fallbackY.value;

  return {
    bounds: {
      uLeft: -dimensions.width / 2 + startX,
      uRight: dimensions.width / 2 - endX,
      vBottom: -dimensions.height / 2 + startY,
      vTop: dimensions.height / 2 - endY,
    },
    dt: { x: (startX + endX) / 2, y: (startY + endY) / 2 },
    dtFaces: { startX, endX, startY, endY },
    coverMm,
    hoopDiaName,
    mainDiaName,
    estimated: fallbackX.estimated || fallbackY.estimated,
  };
}

function resolveSecondLayerInterval(mainBar, secondGroups) {
  const second = mainBar?.secondLayer || {};
  const explicitCenter = positiveNumber(second.centerInterval);
  if (explicitCenter !== null) {
    return { value: explicitCenter, estimated: false, source: 'stb-center' };
  }

  const rules = COLUMN_REBAR_PLACEMENT_RULES;
  const firstDiaName = mainBar?.dia || rules.defaultMainBarDia;
  const firstDiaMm = barDiameterMm(firstDiaName, barDiameterMm(rules.defaultMainBarDia));
  const firstOuter = barOuterDiameterMm(firstDiaName, firstDiaMm);
  const explicitClear = positiveNumber(second.clearInterval);
  const candidates = [];

  for (const group of secondGroups) {
    const secondDiaName = group.dia || firstDiaName;
    const secondDiaMm = barDiameterMm(secondDiaName, firstDiaMm);
    const secondOuter = barOuterDiameterMm(secondDiaName, secondDiaMm);
    if (explicitClear !== null) {
      candidates.push(explicitClear + firstOuter / 2 + secondOuter / 2);
      continue;
    }

    if (String(secondDiaName).toUpperCase() === String(firstDiaName).toUpperCase()) {
      const row = REBAR_STANDARD_RULES.resolveSpacingByDesignation(secondDiaName);
      if (Number.isFinite(row?.layer2MinMm)) {
        candidates.push(row.layer2MinMm);
        continue;
      }
    }

    const clear = REBAR_STANDARD_RULES.resolveMainBarClearSpacingMm({
      firstDiaMm,
      secondDiaMm,
    });
    if (Number.isFinite(clear)) {
      candidates.push(clear + firstOuter / 2 + secondOuter / 2);
    }
  }

  return {
    value: candidates.length > 0 ? Math.max(...candidates) : null,
    estimated: explicitClear === null,
    source: explicitClear === null ? 'standard-table-2-4' : 'stb-clear',
  };
}

function buildFirstLayer(mainBar, groups, bounds, sharedAxes) {
  const counts = layerCounts(groups);
  const positions = rectangularPositions(
    selectOuterInValues(sharedAxes.u, counts.countY),
    selectOuterInValues(sharedAxes.v, counts.countX),
    bounds,
  );
  const target = totalCount(mainBar);
  const selected = target > 0 ? selectPerimeterPositions(positions, target) : positions;
  const primaryDia =
    mainBar?.dia || groups[0]?.dia || COLUMN_REBAR_PLACEMENT_RULES.defaultMainBarDia;
  const patterns = createMixedPatterns(groups, primaryDia);

  return selected.map((position) => {
    const designation = resolveBarDesignation(mainBar, position, bounds, patterns, primaryDia);
    const group = groups.find((candidate) => candidate.dia === designation);
    return mainBarFact(
      position,
      designation,
      group?.grade || mainBar?.grade,
      1,
      position.directions.length > 1,
    );
  });
}

function buildSecondLayer(mainBar, groups, firstBounds, sharedAxes, remaining) {
  if (groups.length === 0 || remaining <= 0) return { bars: [], interval: null };
  const counts = layerCounts(groups);
  const interval = resolveSecondLayerInterval(mainBar, groups);
  if (!Number.isFinite(interval.value) || interval.value <= 0) {
    return { bars: [], interval };
  }

  const bounds = {
    uLeft: firstBounds.uLeft + interval.value,
    uRight: firstBounds.uRight - interval.value,
    vBottom: firstBounds.vBottom + interval.value,
    vTop: firstBounds.vTop - interval.value,
  };
  if (bounds.uLeft > bounds.uRight || bounds.vBottom > bounds.vTop) {
    return { bars: [], interval: { ...interval, outOfRange: true } };
  }

  const all = alignedSecondLayerPositions(counts.countX, counts.countY, sharedAxes, bounds);
  const selected = Number.isFinite(remaining) ? selectPerimeterPositions(all, remaining) : all;
  const primaryDia =
    groups[0]?.dia || mainBar?.dia || COLUMN_REBAR_PLACEMENT_RULES.defaultMainBarDia;
  const patterns = createMixedPatterns(groups, primaryDia);
  const patternBounds = {
    uLeft: sharedAxes.u[0] ?? bounds.uLeft,
    uRight: sharedAxes.u.at(-1) ?? bounds.uRight,
    vBottom: sharedAxes.v[0] ?? bounds.vBottom,
    vTop: sharedAxes.v.at(-1) ?? bounds.vTop,
  };

  return {
    bars: selected.map((position) => {
      const designation = resolveBarDesignation(
        { ...mainBar, dia: primaryDia, diaSub: null },
        position,
        patternBounds,
        patterns,
        primaryDia,
      );
      const group = groups.find((candidate) => candidate.dia === designation);
      return mainBarFact(position, designation, group?.grade || mainBar?.grade, 2, false);
    }),
    interval,
  };
}

function rectangularCoreBars(coreBar, dimensions, sharedAxes) {
  const total =
    toPositiveInteger(coreBar?.total) ||
    toPositiveInteger(coreBar?.countX) + toPositiveInteger(coreBar?.countY);
  if (total <= 0) return { bars: [], unresolved: [] };
  if (!coreBar?.dia) return { bars: [], unresolved: ['core-bar-diameter'] };

  const explicit = Array.isArray(coreBar.positions)
    ? coreBar.positions
        .map((position) => ({
          u: Number(position?.u ?? position?.x ?? position?.X),
          v: Number(position?.v ?? position?.y ?? position?.Y),
          directions: [],
        }))
        .filter((position) => Number.isFinite(position.u) && Number.isFinite(position.v))
        .slice(0, total)
    : [];

  let estimated = null;
  const sideCount = (total + 4) / 4;
  if (
    Number.isInteger(sideCount) &&
    sideCount >= 2 &&
    sharedAxes.u.length >= sideCount + 2 &&
    sharedAxes.v.length >= sideCount + 2
  ) {
    const selectCentered = (values) => {
      const start = Math.floor((values.length - sideCount) / 2);
      return values.slice(start, start + sideCount);
    };
    const us = selectCentered(sharedAxes.u);
    const vs = selectCentered(sharedAxes.v);
    estimated = rectangularPositions(us, vs, {
      uLeft: us[0],
      uRight: us.at(-1),
      vBottom: vs[0],
      vTop: vs.at(-1),
    });
  }

  if (!estimated) {
    const halfWidth = dimensions.width * 0.22;
    const halfHeight = dimensions.height * 0.22;
    if (total === 1) {
      estimated = [{ u: 0, v: 0, directions: [] }];
    } else if (total === 2) {
      estimated = [
        { u: -halfWidth, v: 0, directions: [] },
        { u: halfWidth, v: 0, directions: [] },
      ];
    } else if (total === 3) {
      estimated = [
        { u: 0, v: halfHeight, directions: [] },
        { u: -halfWidth, v: -halfHeight, directions: [] },
        { u: halfWidth, v: -halfHeight, directions: [] },
      ];
    } else {
      const left = -halfWidth;
      const right = halfWidth;
      const bottom = -halfHeight;
      const top = halfHeight;
      const rectWidth = right - left;
      const rectHeight = top - bottom;
      const perimeter = 2 * (rectWidth + rectHeight);
      estimated = Array.from({ length: total }, (_, index) => {
        let distance = (perimeter * index) / total;
        if (distance <= rectWidth) return { u: left + distance, v: top, directions: [] };
        distance -= rectWidth;
        if (distance <= rectHeight) return { u: right, v: top - distance, directions: [] };
        distance -= rectHeight;
        if (distance <= rectWidth) return { u: right - distance, v: bottom, directions: [] };
        distance -= rectWidth;
        return { u: left, v: bottom + distance, directions: [] };
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

  const dia = barDiameterMm(
    coreBar.dia,
    barDiameterMm(COLUMN_REBAR_PLACEMENT_RULES.defaultMainBarDia),
  );
  return {
    bars: positions.map((position) => ({
      u: position.u,
      v: position.v,
      dia,
      diaName: coreBar.dia,
      grade: coreBar.grade || null,
      corner: false,
      role: 'core',
      layer: null,
      placementEstimated: explicit.length !== total,
    })),
    unresolved: [],
  };
}

function rectangularArrangement(dimensions, arrangement, options) {
  const mainBar = arrangement?.mainBar;
  if (!mainBar) return null;
  const firstGroups = getLayerGroups(mainBar, 1);
  if (firstGroups.length === 0) return null;
  const secondGroups = getLayerGroups(mainBar, 2);
  const resolved = resolveFirstLayerBounds(dimensions, arrangement, options);
  const { bounds } = resolved;
  const minSpan = COLUMN_REBAR_PLACEMENT_RULES.minInnerSpanMm;
  if (bounds.uRight - bounds.uLeft < minSpan || bounds.vTop - bounds.vBottom < minSpan) {
    return null;
  }

  const firstCounts = layerCounts(firstGroups);
  const secondCounts = layerCounts(secondGroups);
  const sharedAxes = {
    u: evenlySpaced(bounds.uLeft, bounds.uRight, Math.max(firstCounts.countY, secondCounts.countY)),
    v: evenlySpaced(bounds.vBottom, bounds.vTop, Math.max(firstCounts.countX, secondCounts.countX)),
  };
  const firstBars = buildFirstLayer(mainBar, firstGroups, bounds, sharedAxes);
  const requestedTotal = totalCount(mainBar);
  const remaining = requestedTotal > 0 ? Math.max(0, requestedTotal - firstBars.length) : Infinity;
  const second = buildSecondLayer(mainBar, secondGroups, bounds, sharedAxes, remaining);
  const core = rectangularCoreBars(arrangement.coreBar, dimensions, sharedAxes);
  const bars = [...firstBars, ...second.bars, ...core.bars];
  if (bars.length === 0) return null;

  return {
    bars,
    mainBars: [...firstBars, ...second.bars],
    coreBars: core.bars,
    dt: resolved.dt,
    dtFaces: resolved.dtFaces,
    coverMm: resolved.coverMm,
    hoopDia: resolved.hoopDiaName,
    mainDia: resolved.mainDiaName,
    secondLayerInterval: second.interval,
    unresolved: core.unresolved,
    estimated:
      resolved.estimated ||
      Boolean(second.interval?.estimated) ||
      core.bars.some((bar) => bar.placementEstimated),
  };
}

function circularArrangement(dimensions, arrangement, options) {
  const mainBar = arrangement?.mainBar;
  if (!mainBar) return null;
  const rules = COLUMN_REBAR_PLACEMENT_RULES;
  const diameter = dimensions.diameter || 0;
  const count = totalCount(mainBar);
  if (diameter <= 0 || count <= 0) return null;

  const coverMm = options.coverMm ?? arrangement.cover ?? rules.defaultCoverMm;
  const mainDiaName = mainBar.dia || rules.defaultMainBarDia;
  const hoopDiaName = arrangement.hoop?.dia || rules.defaultHoopDia;
  const mainDiaMm = barDiameterMm(mainDiaName, barDiameterMm(rules.defaultMainBarDia));
  const mainOuterMm = barOuterDiameterMm(mainDiaName, mainDiaMm);
  const hoopDiaMm = barDiameterMm(hoopDiaName, barDiameterMm(rules.defaultHoopDia));
  const hoopOuterMm = barOuterDiameterMm(hoopDiaName, hoopDiaMm);
  const dt = resolveDt(mainBar.dt, coverMm, hoopOuterMm, mainOuterMm);
  const radius = diameter / 2 - dt.value;
  if (radius <= 0) return null;

  const mainBars = Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * Math.PI * 2;
    return {
      u: radius * Math.cos(angle),
      v: radius * Math.sin(angle),
      dia: mainDiaMm,
      diaName: mainDiaName,
      grade: mainBar.grade || null,
      corner: false,
      role: 'main',
      layer: 1,
    };
  });

  const coreTotal = toPositiveInteger(arrangement.coreBar?.total);
  const coreBars = [];
  const unresolved = [];
  if (coreTotal > 0) {
    const coreBar = arrangement.coreBar;
    if (!coreBar?.dia) {
      unresolved.push('core-bar-diameter');
    } else {
      const coreDia = barDiameterMm(coreBar.dia, mainDiaMm);
      const explicit = Array.isArray(coreBar.positions)
        ? coreBar.positions
            .map((position) => ({
              u: Number(position?.u ?? position?.x ?? position?.X),
              v: Number(position?.v ?? position?.y ?? position?.Y),
            }))
            .filter((position) => Number.isFinite(position.u) && Number.isFinite(position.v))
            .slice(0, coreTotal)
        : [];
      const estimatedRadius = Math.max(0, radius * 0.55);
      const estimated =
        coreTotal === 1
          ? [{ u: 0, v: 0 }]
          : Array.from({ length: coreTotal }, (_, index) => {
              const angle = (index / coreTotal) * Math.PI * 2;
              return {
                u: estimatedRadius * Math.cos(angle),
                v: estimatedRadius * Math.sin(angle),
              };
            });
      const positions = [...explicit];
      const used = new Set(explicit.map(pointKey));
      for (const point of estimated) {
        if (positions.length >= coreTotal) break;
        const key = pointKey(point);
        if (!used.has(key)) {
          positions.push(point);
          used.add(key);
        }
      }
      coreBars.push(
        ...positions.map((position) => ({
          ...position,
          dia: coreDia,
          diaName: coreBar.dia,
          grade: coreBar.grade || null,
          corner: false,
          role: 'core',
          layer: null,
          placementEstimated: explicit.length !== coreTotal,
        })),
      );
    }
  }

  return {
    bars: [...mainBars, ...coreBars],
    mainBars,
    coreBars,
    dt: { r: dt.value },
    dtFaces: { r: dt.value },
    coverMm,
    hoopDia: hoopDiaName,
    mainDia: mainDiaName,
    secondLayerInterval: null,
    unresolved,
    estimated: dt.estimated || coreBars.some((bar) => bar.placementEstimated),
  };
}

/**
 * 配筋1組（SAME / TOP / BOTTOM）を3D用bar factsへ正規化する。
 */
export function buildColumnArrangementFacts(dimensions, arrangement, options = {}) {
  if (!dimensions?.type || !arrangement?.mainBar) return null;
  if (dimensions.type === 'CIRCLE') {
    return circularArrangement(dimensions, arrangement, options);
  }
  if (!(dimensions.width > 0) || !(dimensions.height > 0)) return null;
  return rectangularArrangement(dimensions, arrangement, options);
}
