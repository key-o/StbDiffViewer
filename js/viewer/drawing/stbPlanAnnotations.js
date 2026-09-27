/** @fileoverview STB平面図の通り芯・寸法注記生成。 */
import { parseAxes } from '../../common-stb/import/parser/stbParserCore.js';

const GRID_EXTEND_MM = 2500;
const DIM_OFFSET_1_MM = 3500;
const DIM_OFFSET_2_MM = 5500;
const TICK_MM = 250;

function finiteBounds(bounds) {
  return bounds &&
    [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) &&
    bounds.minX <= bounds.maxX &&
    bounds.minY <= bounds.maxY;
}

function formatDimension(value) {
  const rounded = Math.round(Math.abs(value));
  return String(rounded);
}

function line(id, role, points, extra = {}) {
  return Object.freeze({ id, kind: 'line', role, points, ...extra });
}

function text(id, role, point, value, extra = {}) {
  return Object.freeze({ id, kind: 'text', role, point, text: String(value), ...extra });
}

function cardinalAngle(angle, coordinateKey, toleranceDeg = 1e-6) {
  if (!Number.isFinite(angle)) return false;
  const normalized = ((angle % 180) + 180) % 180;
  const target = coordinateKey === 'x' ? 90 : 0;
  const delta = Math.abs(normalized - target);
  return Math.min(delta, 180 - delta) <= toleranceDeg;
}

function usableParallelAxes(axes, coordinateKey) {
  return axes
    .filter((axis) =>
      axis?.axisKind === 'parallel' &&
      axis?.name &&
      cardinalAngle(axis.angle, coordinateKey) &&
      Number.isFinite(axis[coordinateKey])
    )
    // StbNodeIdListは所属ON_GRID節点の列挙であり、節点座標は軸交点と一致するとは限らない。
    // 軸位置はStbParallelAxesの基準座標・angleとStbParallelAxis.distanceから得た値を正本とする。
    .sort((a, b) => a[coordinateKey] - b[coordinateKey]);
}

function addXAnnotations(out, axes, bounds) {
  if (!axes.length) return;
  const y0 = bounds.minY - GRID_EXTEND_MM;
  const y1 = bounds.maxY + GRID_EXTEND_MM;
  for (const axis of axes) {
    out.push(line(`grid-x-${axis.id}`, 'grid', [[axis.x, y0], [axis.x, y1]], { axisName: axis.name }));
    out.push(text(`grid-x-label-bottom-${axis.id}`, 'grid-label', [axis.x, y0 - 450], axis.name, {
      anchor: 'middle',
    }));
    out.push(text(`grid-x-label-top-${axis.id}`, 'grid-label', [axis.x, y1 + 450], axis.name, {
      anchor: 'middle',
    }));
  }

  if (axes.length < 2) return;
  const chainY = bounds.minY - DIM_OFFSET_1_MM;
  const overallY = bounds.minY - DIM_OFFSET_2_MM;
  const first = axes[0].x;
  const last = axes.at(-1).x;

  out.push(line('dim-x-chain', 'dimension', [[first, chainY], [last, chainY]]));
  for (const axis of axes) {
    out.push(line(`dim-x-ext-${axis.id}`, 'dimension-extension', [[axis.x, bounds.minY], [axis.x, overallY - TICK_MM]]));
    out.push(line(`dim-x-tick-${axis.id}`, 'dimension-tick', [[axis.x - TICK_MM, chainY - TICK_MM], [axis.x + TICK_MM, chainY + TICK_MM]]));
  }
  for (let i = 0; i < axes.length - 1; i++) {
    const a = axes[i].x;
    const b = axes[i + 1].x;
    out.push(text(`dim-x-value-${i}`, 'dimension-text', [(a + b) / 2, chainY - 350], formatDimension(b - a), {
      anchor: 'middle',
    }));
  }

  out.push(line('dim-x-overall', 'dimension-overall', [[first, overallY], [last, overallY]]));
  for (const x of [first, last]) {
    out.push(line(`dim-x-overall-tick-${x}`, 'dimension-tick', [[x - TICK_MM, overallY - TICK_MM], [x + TICK_MM, overallY + TICK_MM]]));
  }
  out.push(text('dim-x-overall-value', 'dimension-text', [(first + last) / 2, overallY - 350], formatDimension(last - first), {
    anchor: 'middle',
  }));
}

function addYAnnotations(out, axes, bounds) {
  if (!axes.length) return;
  const x0 = bounds.minX - GRID_EXTEND_MM;
  const x1 = bounds.maxX + GRID_EXTEND_MM;
  for (const axis of axes) {
    out.push(line(`grid-y-${axis.id}`, 'grid', [[x0, axis.y], [x1, axis.y]], { axisName: axis.name }));
    out.push(text(`grid-y-label-left-${axis.id}`, 'grid-label', [x0 - 450, axis.y], axis.name, {
      anchor: 'middle',
    }));
    out.push(text(`grid-y-label-right-${axis.id}`, 'grid-label', [x1 + 450, axis.y], axis.name, {
      anchor: 'middle',
    }));
  }

  if (axes.length < 2) return;
  const chainX = bounds.minX - DIM_OFFSET_1_MM;
  const overallX = bounds.minX - DIM_OFFSET_2_MM;
  const first = axes[0].y;
  const last = axes.at(-1).y;

  out.push(line('dim-y-chain', 'dimension', [[chainX, first], [chainX, last]]));
  for (const axis of axes) {
    out.push(line(`dim-y-ext-${axis.id}`, 'dimension-extension', [[bounds.minX, axis.y], [overallX - TICK_MM, axis.y]]));
    out.push(line(`dim-y-tick-${axis.id}`, 'dimension-tick', [[chainX - TICK_MM, axis.y - TICK_MM], [chainX + TICK_MM, axis.y + TICK_MM]]));
  }
  for (let i = 0; i < axes.length - 1; i++) {
    const a = axes[i].y;
    const b = axes[i + 1].y;
    out.push(text(`dim-y-value-${i}`, 'dimension-text', [chainX - 350, (a + b) / 2], formatDimension(b - a), {
      anchor: 'middle',
      rotationDeg: -90,
    }));
  }

  out.push(line('dim-y-overall', 'dimension-overall', [[overallX, first], [overallX, last]]));
  for (const y of [first, last]) {
    out.push(line(`dim-y-overall-tick-${y}`, 'dimension-tick', [[overallX - TICK_MM, y - TICK_MM], [overallX + TICK_MM, y + TICK_MM]]));
  }
  out.push(text('dim-y-overall-value', 'dimension-text', [overallX - 350, (first + last) / 2], formatDimension(last - first), {
    anchor: 'middle',
    rotationDeg: -90,
  }));
}

export function buildStbPlanAnnotations({ document, bounds } = {}) {
  if (document?.nodeType !== 9) throw new TypeError('STB Documentが必要です。');
  if (!finiteBounds(bounds)) return Object.freeze([]);
  const parsed = parseAxes(document);
  const xAxes = usableParallelAxes(parsed.xAxes, 'x');
  const yAxes = usableParallelAxes(parsed.yAxes, 'y');
  const annotations = [];
  addXAnnotations(annotations, xAxes, bounds);
  addYAnnotations(annotations, yAxes, bounds);
  return Object.freeze(annotations);
}
