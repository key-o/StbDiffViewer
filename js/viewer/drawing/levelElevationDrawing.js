/**
 * @fileoverview #455: Level lines compiled from STB to an elevation DrawingModel.
 * This is an isolated acceptance slice. Legacy runtime export remains intact.
 */
import {
  createElementRef,
  elementRefKey,
  normalizeDrawingSource,
} from '../../data/drawing/drawingModel.js';
import { createAxisElevationView } from '../../data/drawing/axisElevationView.js';
import { buildAxisElevationGridAnnotations } from './axisElevationGridAnnotations.js';
import { buildStbPlanDimensionIntents } from './stbPlanAnnotations.js';
import {
  buildLevelElevationDimensionIntents,
  formatLevelElevationDimensionValue,
} from './levelElevationDimensions.js';
import { addAxisElevationMemberCenterlines } from './axisElevationMemberCenterlines.js';
import { addAxisElevationWallOutlines } from './axisElevationWallOutlines.js';
import { parseAxes, parseElements } from '../../common-stb/import/parser/stbParserCore.js';
import { createDrawingSheetLayout } from './drawingSheetLayout.js';
import { compileDrawingRenderPlan } from '../../data/drawing/drawingRenderPlan.js';

export const LEVEL_ELEVATION_PROFILE_ID = 'sdv-level-elevation-v1';
export const LEVEL_ELEVATION_MARGIN_MIN_MM = 500;
export const LEVEL_ELEVATION_MARGIN_RATIO = 0.15;
// Model-mm offset above each FL line (the default label height is 200 mm).
export const LEVEL_ELEVATION_LABEL_RISE_MM = 300;

function finiteAttribute(value, label) {
  if (value == null || String(value).trim() === '') throw new TypeError(`${label}がありません。`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label}は有限値で指定してください。`);
  return number;
}

function checkView(view) {
  if (
    view?.type !== 'elevation' ||
    view.units !== 'mm' ||
    view.cutPolicyKey !== 'sdv-axis-elevation-v1'
  ) {
    throw new TypeError('Level出力は明示した通り芯立面viewのみ対応しています。');
  }
  const direction = view.axisDirection;
  const plane = direction === 'X' ? ['Y', 'Z'] : direction === 'Y' ? ['X', 'Z'] : null;
  if (
    !plane ||
    view.depthAxis !== direction ||
    !Array.isArray(view.planeAxes) ||
    view.planeAxes.length !== 2 ||
    view.planeAxes.some((axis, i) => axis !== plane[i]) ||
    !String(view.axisId || '').trim() ||
    ![view.position, view.lowerBound, view.upperBound].every(Number.isFinite) ||
    view.lowerBound >= view.upperBound ||
    Math.abs((view.lowerBound + view.upperBound) / 2 - view.position) > 1e-6
  ) {
    throw new TypeError('通り芯立面viewの投影面・範囲が不正です。');
  }
  const expectedDirection = direction === 'X' ? [-1, 0, 0] : [0, 1, 0];
  if (
    !Array.isArray(view.viewDirection) ||
    !view.viewDirection.every((v, i) => v === expectedDirection[i]) ||
    view.viewDirection.length !== 3
  ) {
    throw new TypeError('通り芯立面のviewDirectionが不正です。');
  }
}

function normalizeStories(stories) {
  if (!Array.isArray(stories) || stories.length === 0)
    throw new TypeError('STBの階情報が必要です。');
  const seen = new Set();
  return stories
    .map((story) => {
      const id = String(story?.id ?? '').trim();
      const name = String(story?.name ?? '').trim();
      if (!id || !name || seen.has(id))
        throw new Error('Story ID・階名の欠落またはStory ID重複があります。');
      seen.add(id);
      return {
        id,
        name,
        height: finiteAttribute(story.height, `Story ${id} height`),
        guid: story.guid ?? null,
      };
    })
    .sort((a, b) => a.height - b.height || a.id.localeCompare(b.id));
}

function normalizeNodeEntries(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new TypeError('STBの節点情報が必要です。');
  const seen = new Set();
  return nodes.map((node) => {
    const id = String(node?.id ?? '').trim();
    if (!id || seen.has(id)) throw new Error('Node IDの欠落または重複があります。');
    seen.add(id);
    return {
      id,
      x: finiteAttribute(node.x, `Node ${id} X`),
      y: finiteAttribute(node.y, `Node ${id} Y`),
      z: finiteAttribute(node.z, `Node ${id} Z`),
    };
  });
}

function levelLabel(story) {
  const floorName = /FL$/i.test(story.name) ? story.name : `${story.name.replace(/F$/i, '')}FL`;
  return `▽${floorName}`;
}

/** 2D elevation XY = world YZ for X-grid, or world XZ for Y-grid, in STB mm. */
export function createLevelElevationDrawing({ source, view, stories, nodes } = {}) {
  const normalizedSource = normalizeDrawingSource(source);
  if (normalizedSource.modelKey !== 'A') throw new TypeError('Level図面正本はSTB-Aに限定します。');
  checkView(view);
  const levels = normalizeStories(stories);
  const modelNodes = normalizeNodeEntries(nodes);
  const inDepth = modelNodes.filter((node) => {
    const depth = view.axisDirection === 'X' ? node.x : node.y;
    return depth >= view.lowerBound && depth <= view.upperBound;
  });
  if (inDepth.length === 0) throw new Error('指定した通り芯の奥行範囲に節点が存在しません。');
  const horizontal = inDepth.map((node) => (view.axisDirection === 'X' ? node.y : node.x));
  const min = Math.min(...horizontal);
  const max = Math.max(...horizontal);
  if (!(max > min)) throw new Error('立面の水平範囲が一意に確定できません。');
  const margin = Math.max(
    LEVEL_ELEVATION_MARGIN_MIN_MM,
    (max - min) * LEVEL_ELEVATION_MARGIN_RATIO,
  );
  const start = min - margin;
  const end = max + margin;
  const drawing = {
    schemaVersion: 1,
    units: 'mm',
    source: normalizedSource,
    view: Object.freeze({ ...view }),
    primitives: [],
    annotations: [],
    dimensionReferences: [],
    dimensionIntents: [
      ...buildLevelElevationDimensionIntents({ stories: levels, bounds: { minX: start } }),
    ],
    elements: [],
    diagnostics: [],
    bounds: {
      minX: start,
      minY: levels[0].height,
      maxX: end,
      maxY: levels.at(-1).height,
    },
  };
  for (const story of levels) {
    const ref = createElementRef(normalizedSource, 'Story', story.id, story.guid);
    const key = elementRefKey(ref);
    const id = JSON.stringify([key, 'level-line']);
    drawing.elements.push({
      key,
      ref,
      renderType: 'Level',
      state: 'drawn',
      mark: '',
      sectionId: null,
      taggable: false,
      primitiveIds: [id],
    });
    drawing.primitives.push({
      id,
      kind: 'polyline',
      role: 'member-outline',
      closed: false,
      ref,
      elementKey: key,
      points: [
        [start, story.height],
        [end, story.height],
      ],
    });
    drawing.annotations.push({
      id: JSON.stringify([key, 'level-label']),
      kind: 'text',
      role: 'level-label',
      point: [start, story.height + LEVEL_ELEVATION_LABEL_RISE_MM],
      anchor: 'start',
      text: levelLabel(story),
    });
  }
  return drawing;
}

/** Shared scene-independent RenderPlan for the existing R12 writer. */
export function compileLevelElevationRenderPlan({
  drawing,
  scaleDenominator = 200,
  labelHeightModelMm = 200,
} = {}) {
  if (drawing?.view?.type !== 'elevation' || drawing?.source?.modelKey !== 'A')
    throw new TypeError('STB-Aの立面DrawingModelが必要です。');
  const scale = Number(scaleDenominator);
  const height = Number(labelHeightModelMm);
  if (!(scale > 0) || !Number.isFinite(scale) || !(height > 0) || !Number.isFinite(height))
    throw new RangeError('縮尺分母とLevel文字高さは正の数値が必要です。');
  const layout = createDrawingSheetLayout({ drawing, scaleDenominator: scale });
  const renderPlan = compileDrawingRenderPlan({
    drawing,
    profile: {
      id: LEVEL_ELEVATION_PROFILE_ID,
      modelToPaper: [...layout.modelToPaper],
      textStyle: { textHeightMm: height / scale },
      output: { preferredSpace: 'model', editableText: true },
    },
    // Axis-elevation openings are true unfilled contours (no opaque wall hatch).
    // Both SVG and DXF use the same outer/notch and inner-opening polylines.
    displaySettings: { visibility: { Level: true }, cutSurfaceFill: false },
    formatDimensionValue: formatLevelElevationDimensionValue,
  });
  return Object.freeze({ drawing, layout, renderPlan });
}

export function makeLevelElevationView(axesData, axisDirection, axisId, depth) {
  return createAxisElevationView(axesData, axisDirection, axisId, depth);
}

/**
 * STB XML entrypoint. Parse every Story directly rather than parseStories()
 * (which filters invalid heights), to prevent silently dropped level lines.
 */
export function compileStbLevelElevationRenderPlan({
  document,
  source,
  axisDirection,
  axisId,
  depth,
  scaleDenominator,
  labelHeightModelMm,
} = {}) {
  if (document?.nodeType !== 9 || document.documentElement?.localName !== 'ST_BRIDGE')
    throw new TypeError('ST_BRIDGE Documentが必要です。');
  const axesData = parseAxes(document);
  const view = makeLevelElevationView(axesData, axisDirection, axisId, depth);
  const stories = parseElements(document, 'StbStory').map((element) => ({
    id: element.getAttribute('id'),
    name: element.getAttribute('name'),
    height: element.getAttribute('height'),
    guid: element.getAttribute('guid'),
  }));
  const nodes = parseElements(document, 'StbNode').map((element) => ({
    id: element.getAttribute('id'),
    x: element.getAttribute('X'),
    y: element.getAttribute('Y'),
    z: element.getAttribute('Z'),
  }));
  const drawing = createLevelElevationDrawing({ source, view, stories, nodes });
  // #510: plot intersecting X/Y axis circles BELOW the lowest FL; no 3D camera or clip.
  // Preserve the original STB GUID for each grid binding. Parallel-axis IDs
  // are unique within the source revision; never resolve a duplicate by order.
  const axisGuidById = new Map();
  for (const axis of parseElements(document, 'StbParallelAxis')) {
    const id = String(axis.getAttribute('id') ?? '').trim();
    if (!id || axisGuidById.has(id))
      throw new Error('StbParallelAxis IDの欠落または重複があります。');
    axisGuidById.set(id, axis.getAttribute('guid') || null);
  }
  const grids = buildAxisElevationGridAnnotations({
    axesData,
    view,
    bounds: drawing.bounds,
    axisGuidById,
  });
  drawing.annotations.push(...grids.annotations);
  drawing.dimensionReferences.push(...grids.dimensionReferences);
  drawing.bounds = { ...grids.bounds };
  drawing.dimensionIntents.push(
    ...buildStbPlanDimensionIntents({
      document,
      bounds: drawing.bounds,
      dimensionReferences: grids.dimensionReferences,
    }),
  );
  // Project STB-A linear members after grids, keeping bubbles anchored to the lowest FL.
  addAxisElevationMemberCenterlines({ drawing, document, nodes: normalizeNodeEntries(nodes) });
  addAxisElevationWallOutlines({ drawing, document, nodes: normalizeNodeEntries(nodes) });
  return compileLevelElevationRenderPlan({ drawing, scaleDenominator, labelHeightModelMm });
}
