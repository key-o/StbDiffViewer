/** @fileoverview STB平面図の通り芯・寸法注記生成。 */
import { parseAxes, parseElements } from '../../common-stb/import/parser/stbParserCore.js';
import { normalizeDimensionIntent } from '../../data/drawing/dimensions/dimensionIntentDefinition.js';

const GRID_EXTEND_MM = 2500;
const DIM_OFFSET_1_MM = 3500;
const DIM_OFFSET_2_MM = 5500;
const GRID_BUBBLE_RADIUS_MM = 650;
const GRID_BUBBLE_GAP_MM = 550;
const GRID_BUBBLE_CENTER_OFFSET_MM = DIM_OFFSET_2_MM + GRID_BUBBLE_RADIUS_MM + GRID_BUBBLE_GAP_MM;
const STRUCTURAL_DIMENSION_FAMILY_ID = 'builtin:structural-dimension-v1';

function finiteBounds(bounds) {
  return (
    bounds &&
    [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite) &&
    bounds.minX <= bounds.maxX &&
    bounds.minY <= bounds.maxY
  );
}

function line(id, role, points, extra = {}) {
  return Object.freeze({ id, kind: 'line', role, points, ...extra });
}

function circle(id, role, center, radius, extra = {}) {
  return Object.freeze({ id, kind: 'circle', role, center, radius, ...extra });
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
  return (
    axes
      .filter(
        (axis) =>
          axis?.axisKind === 'parallel' &&
          axis?.name &&
          cardinalAngle(axis.angle, coordinateKey) &&
          Number.isFinite(axis[coordinateKey]),
      )
      // StbNodeIdListは所属ON_GRID節点の列挙であり、節点座標は軸交点と一致するとは限らない。
      // 軸位置はStbParallelAxesの基準座標・angleとStbParallelAxis.distanceから得た値を正本とする。
      .sort((a, b) => a[coordinateKey] - b[coordinateKey])
  );
}

function addXAnnotations(out, axes, bounds) {
  if (!axes.length) return;
  const y1 = bounds.maxY + GRID_EXTEND_MM;
  const bubbleY = bounds.minY - GRID_BUBBLE_CENTER_OFFSET_MM;
  const gridBottomY = bubbleY + GRID_BUBBLE_RADIUS_MM;
  for (const axis of axes) {
    out.push(
      line(
        `grid-x-${axis.id}`,
        'grid',
        [
          [axis.x, gridBottomY],
          [axis.x, y1],
        ],
        { axisName: axis.name },
      ),
    );
    out.push(
      circle(`grid-x-bubble-${axis.id}`, 'grid-bubble', [axis.x, bubbleY], GRID_BUBBLE_RADIUS_MM, {
        axisName: axis.name,
      }),
    );
    out.push(
      text(`grid-x-label-bottom-${axis.id}`, 'grid-label', [axis.x, bubbleY], axis.name, {
        anchor: 'middle',
      }),
    );
  }
}

function addYAnnotations(out, axes, bounds) {
  if (!axes.length) return;
  const x1 = bounds.maxX + GRID_EXTEND_MM;
  const bubbleX = bounds.minX - GRID_BUBBLE_CENTER_OFFSET_MM;
  const gridLeftX = bubbleX + GRID_BUBBLE_RADIUS_MM;
  for (const axis of axes) {
    out.push(
      line(
        `grid-y-${axis.id}`,
        'grid',
        [
          [gridLeftX, axis.y],
          [x1, axis.y],
        ],
        { axisName: axis.name },
      ),
    );
    out.push(
      circle(`grid-y-bubble-${axis.id}`, 'grid-bubble', [bubbleX, axis.y], GRID_BUBBLE_RADIUS_MM, {
        axisName: axis.name,
      }),
    );
    out.push(
      text(`grid-y-label-left-${axis.id}`, 'grid-label', [bubbleX, axis.y], axis.name, {
        anchor: 'middle',
      }),
    );
  }
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

function axisReference(axisId) {
  return Object.freeze({ kind: 'axis', axisId });
}

function linearChainIntent(id, axisIds, offsetModelMm) {
  return normalizeDimensionIntent({
    schemaVersion: 1,
    id,
    kind: 'linear-chain',
    references: axisIds.map(axisReference),
    placement: { offsetModelMm },
    familyId: STRUCTURAL_DIMENSION_FAMILY_ID,
  });
}

function parallelAxisGuidById(document) {
  const result = new Map();
  for (const element of parseElements(document, 'StbParallelAxis')) {
    const id = String(element.getAttribute('id') || '').trim();
    if (!id) continue;
    if (result.has(id)) throw new Error(`StbParallelAxis idが重複しています: ${id}`);
    result.set(id, element.getAttribute('guid') || null);
  }
  return result;
}

function dimensionReference(axis, coordinateKey, guidById) {
  const elementId = String(axis.id);
  return Object.freeze({
    id: `parallel:${elementId}`,
    kind: 'axis',
    axisKind: 'parallel',
    name: String(axis.name),
    sourceRef: Object.freeze({
      elementType: 'ParallelAxis',
      elementId,
      guid: guidById.get(elementId) ?? null,
    }),
    coordinateKey,
    coordinateValue: Number(axis[coordinateKey]),
  });
}

/**
 * 現行STB revisionの通り芯を、永続BindingRegistryから再解決できるDrawingModel参照として保持する。
 * 現段階では直交する平行軸のみを対象とする。
 */
export function buildStbPlanDimensionReferences({ document } = {}) {
  if (document?.nodeType !== 9) throw new TypeError('STB Documentが必要です。');
  const parsed = parseAxes(document);
  const xAxes = usableParallelAxes(parsed.xAxes, 'x');
  const yAxes = usableParallelAxes(parsed.yAxes, 'y');
  const guidById = parallelAxisGuidById(document);
  const references = [
    ...xAxes.map((axis) => dimensionReference(axis, 'x', guidById)),
    ...yAxes.map((axis) => dimensionReference(axis, 'y', guidById)),
  ];
  const ids = new Set();
  const sourceRefs = new Set();
  for (const reference of references) {
    if (ids.has(reference.id)) throw new Error(`寸法参照IDが重複しています: ${reference.id}`);
    ids.add(reference.id);
    const sourceKey = JSON.stringify([
      reference.sourceRef.elementType,
      reference.sourceRef.elementId,
    ]);
    if (sourceRefs.has(sourceKey))
      throw new Error(`寸法参照sourceRefが重複しています: ${sourceKey}`);
    sourceRefs.add(sourceKey);
  }
  return Object.freeze(references);
}

/**
 * 通り芯寸法を、描画primitiveではなくDimensionIntentとして構成する。
 *
 * 軸IDはDrawingModel内のsemantic referenceを指し、最終座標はcompile時に現行STBから解決する。
 */
export function buildStbPlanDimensionIntents({
  document,
  bounds,
  dimensionReferences = null,
} = {}) {
  if (document?.nodeType !== 9) throw new TypeError('STB Documentが必要です。');
  if (!finiteBounds(bounds)) return Object.freeze([]);
  const references =
    dimensionReferences == null
      ? buildStbPlanDimensionReferences({ document })
      : [...dimensionReferences];
  const xAxes = references.filter((reference) => reference.coordinateKey === 'x');
  const yAxes = references.filter((reference) => reference.coordinateKey === 'y');
  const intents = [];

  if (xAxes.length >= 2) {
    const axisIds = xAxes.map((axis) => axis.id);
    intents.push(linearChainIntent('dim:x:chain', axisIds, -DIM_OFFSET_1_MM));
    intents.push(
      linearChainIntent('dim:x:overall', [axisIds[0], axisIds.at(-1)], -DIM_OFFSET_2_MM),
    );
  }

  if (yAxes.length >= 2) {
    const axisIds = yAxes.map((axis) => axis.id);
    intents.push(linearChainIntent('dim:y:chain', axisIds, DIM_OFFSET_1_MM));
    intents.push(linearChainIntent('dim:y:overall', [axisIds[0], axisIds.at(-1)], DIM_OFFSET_2_MM));
  }

  return Object.freeze(intents);
}
