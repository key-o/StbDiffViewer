/**
 * @fileoverview PDF照合用の読取専用STB→DrawingModel境界。
 * 比較scene・カメラ・表示/非表示・A/B共用sectionMapを正本にしない。
 * 既存パーサー・形状生成・DXF切断を共用し、元データと部材参照を保持する。
 */
import * as THREE from 'three';
import { parseStbFile } from '../geometry/stbStructureReader.js';
import { geometryGeneratorFactory } from '../geometry/GeometryGeneratorFactory.js';
import { getElementRedrawConfig } from '../../config/elementRedrawConfig.js';
import { getViewerWallElementType } from '../../common-stb/walls/wallClassification.js';
import { parseElements, parseStories } from '../../common-stb/import/parser/stbParserCore.js';
import {
  createEmptyDrawing,
  createElementRef,
  elementRefKey,
} from '../../data/drawing/drawingModel.js';
import { assertPoint } from '../../data/drawing/affine2d.js';
import {
  planPolygon,
  polygonCentroid,
} from '../../data/extractors/rebar3d/foundationRebarGeometry.js';
import { resolveMemberAxisModel } from '../../data/drawing/memberAxisAnchor.js';
import { resolveStoryPlanCutZ } from '../../export/dxf/stb-to-dxf/DxfPlanCut.js';
import { extractHorizontalSectionLoops } from '../../export/dxf/stb-to-dxf/DxfSectionExtractor.js';
import { collectWallOpeningPolylinesFromMesh } from '../../export/dxf/stb-to-dxf/DxfOpeningCollector.js';
import { resolveDxfElementMark } from '../../export/dxf/stb-to-dxf/DxfMarkResolver.js';
import {
  buildStbPlanAnnotations,
  buildStbPlanDimensionIntents,
  buildStbPlanDimensionReferences,
} from './stbPlanAnnotations.js';
import { resolveStripFootingPlanGeometry } from './stripFootingPlanGeometry.js';
import { resolvePilePlanGeometry } from './pilePlanGeometry.js';
import { resolveParapetPlanGeometry } from './parapetPlanGeometry.js';

export const PLAN_MEMBER_TYPES = Object.freeze([
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
  'Footing',
  'StripFooting',
  'Pile',
  'Parapet',
]);

const VIA_NODE_TAG_BY_MEMBER = Object.freeze({
  Column: 'StbColumnViaNode',
  Post: 'StbPostViaNode',
  Girder: 'StbGirderViaNode',
  Beam: 'StbBeamViaNode',
});

function elementLocalName(element) {
  const name = element?.localName || element?.nodeName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function directChildElements(parent, tagName) {
  return Array.from(parent?.childNodes || []).filter(
    (child) => child?.nodeType === 1 && elementLocalName(child) === tagName,
  );
}

function readFiniteOffsetAttribute(element, name) {
  const raw = element?.getAttribute?.(name);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readMemberViaNodes(member, elementType) {
  const viaTag = VIA_NODE_TAG_BY_MEMBER[elementType];
  if (!viaTag) return [];
  const containers = directChildElements(member, viaTag);
  if (containers.length === 0) return [];
  if (containers.length !== 1) return null;

  const orderElements = directChildElements(containers[0], 'StbNodeIdOrder');
  if (orderElements.length !== 1) return null;
  const ids = String(orderElements[0].textContent || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length === 0 || new Set(ids).size !== ids.length) return null;

  const offsetByNode = new Map();
  for (const offset of directChildElements(containers[0], 'StbMemberOffsetList')) {
    const id = String(offset.getAttribute?.('id_node') || '').trim();
    if (!id || offsetByNode.has(id) || !ids.includes(id)) return null;
    const offset_X = readFiniteOffsetAttribute(offset, 'offset_X');
    const offset_Y = readFiniteOffsetAttribute(offset, 'offset_Y');
    const offset_Z = readFiniteOffsetAttribute(offset, 'offset_Z');
    if (offset_X == null || offset_Y == null || offset_Z == null) return null;
    offsetByNode.set(id, { offset_X, offset_Y, offset_Z });
  }

  return ids.map((id_node) => ({
    id_node,
    ...(offsetByNode.get(id_node) || { offset_X: 0, offset_Y: 0, offset_Z: 0 }),
  }));
}

function checkCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error('図面抽出を中止しました。');
    error.name = 'AbortError';
    throw error;
  }
}

function disposeMeshes(meshes) {
  const resources = new Set();
  for (const mesh of meshes) {
    mesh?.traverse?.((child) => {
      if (child.geometry) resources.add(child.geometry);
      // colorManagerのMaterialは通常3D表示と共有される。disposeしない。
      // ここで所有するのは新規生成した一時Geometryだけ。
    });
  }
  for (const resource of resources) resource.dispose?.();
}

function extendBounds(bounds, points) {
  for (const [x, y] of points) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
}

function indexElements(elements) {
  const indexed = new Map();
  for (const element of elements || []) {
    const key = String(element.id);
    if (indexed.has(key)) throw new Error(`パース結果の部材IDが重複しています: ${key}`);
    indexed.set(key, element);
  }
  return indexed;
}

function indexRawElements(elements, label) {
  const indexed = new Map();
  for (const element of elements || []) {
    const id = element?.getAttribute?.('id');
    if (id == null || String(id).trim() === '') continue;
    const key = String(id);
    if (indexed.has(key)) throw new Error(`${label}のIDが重複しています: ${key}`);
    indexed.set(key, element);
  }
  return indexed;
}

function readNumberAttribute(element, name, { required = false, fallback = 0 } = {}) {
  const raw = element?.getAttribute?.(name);
  if (raw == null || raw === '') {
    if (required) throw new Error(`FOOTING_ATTRIBUTE_REQUIRED:${name}`);
    return fallback;
  }
  if (String(raw).trim() === '') {
    throw new Error(`FOOTING_ATTRIBUTE_INVALID:${name}=${raw}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`FOOTING_ATTRIBUTE_INVALID:${name}=${raw}`);
  return value;
}

function readPositiveAttribute(element, name) {
  const value = readNumberAttribute(element, name, { required: true });
  if (!(value > 0)) throw new Error(`FOOTING_ATTRIBUTE_NONPOSITIVE:${name}=${value}`);
  return value;
}

function resolveFootingStoryOwnership(raw, targetStory, stories, nodes, tolerance = 0.1) {
  const nodeId = String(
    raw?.getAttribute?.('id_node') || raw?.getAttribute?.('id_node_start') || '',
  ).trim();
  if (!nodeId) {
    return {
      status: 'unresolved',
      resolution: 'none',
      detail: 'StbFooting/StbPile id_node (or StbParapet id_node_start) is required',
    };
  }

  const explicitMatches = (stories || []).filter((story) =>
    Array.isArray(story?.node_ids) ? story.node_ids.map(String).includes(nodeId) : false,
  );
  if (explicitMatches.length > 1) {
    return {
      status: 'unresolved',
      resolution: 'node-list',
      detail: `id_node=${nodeId} is assigned to multiple StbStory node lists: ${explicitMatches
        .map((story) => story.id)
        .join(',')}`,
    };
  }
  if (explicitMatches.length === 1) {
    const owner = explicitMatches[0];
    return {
      status: String(owner.id) === String(targetStory?.id) ? 'belongs' : 'outside',
      resolution: 'node-list',
      ownerStoryId: String(owner.id),
      detail: `id_node=${nodeId}; ownerStory=${owner.id}`,
    };
  }

  const hasAnyExplicitStoryNodes = (stories || []).some(
    (story) => Array.isArray(story?.node_ids) && story.node_ids.length > 0,
  );
  if (hasAnyExplicitStoryNodes) {
    return {
      status: 'unresolved',
      resolution: 'node-list',
      detail: `id_node=${nodeId} is not assigned to any StbStory node list; Z fallback is disabled while explicit story node lists exist`,
    };
  }

  const node =
    nodes instanceof Map
      ? nodes.get(nodeId) || nodes.get(String(nodeId)) || nodes.get(Number(nodeId))
      : null;
  const nodeZ = Number(node?.z);
  if (!Number.isFinite(nodeZ)) {
    return {
      status: 'unresolved',
      resolution: 'z-fallback',
      detail: `id_node=${nodeId} has no finite node Z`,
    };
  }

  const zMatches = (stories || []).filter((story) => {
    const height = Number(story?.height);
    return Number.isFinite(height) && Math.abs(nodeZ - height) <= tolerance;
  });
  if (zMatches.length !== 1) {
    return {
      status: 'unresolved',
      resolution: 'z-fallback',
      detail: `id_node=${nodeId}; nodeZ=${nodeZ}; matchingStories=${
        zMatches.map((story) => story.id).join(',') || 'none'
      }`,
    };
  }

  const owner = zMatches[0];
  return {
    status: String(owner.id) === String(targetStory?.id) ? 'belongs' : 'outside',
    resolution: 'z-fallback',
    ownerStoryId: String(owner.id),
    detail: `id_node=${nodeId}; nodeZ=${nodeZ}; ownerStory=${owner.id}`,
  };
}

function resolveStripFootingStoryOwnership(raw, targetStory, stories, nodes, tolerance = 0.1) {
  const startId = String(raw?.getAttribute?.('id_node_start') || '').trim();
  const endId = String(raw?.getAttribute?.('id_node_end') || '').trim();
  if (!startId || !endId) {
    return {
      status: 'unresolved',
      resolution: 'none',
      detail: 'StbStripFooting.id_node_start/id_node_end are required',
    };
  }

  const resolveNode = (nodeId) =>
    resolveFootingStoryOwnership(
      {
        getAttribute(name) {
          return name === 'id_node' ? nodeId : null;
        },
      },
      targetStory,
      stories,
      nodes,
      tolerance,
    );
  const start = resolveNode(startId);
  const end = resolveNode(endId);
  const unresolved = [start, end].find((result) => result.status === 'unresolved');
  if (unresolved) {
    return {
      status: 'unresolved',
      resolution: unresolved.resolution,
      detail: `id_node_start=${startId}; id_node_end=${endId}; ${unresolved.detail}`,
    };
  }

  const ownerIds = new Set([start.ownerStoryId, end.ownerStoryId].filter(Boolean));
  if (ownerIds.size !== 1) {
    return {
      status: 'unresolved',
      resolution:
        start.resolution === 'z-fallback' || end.resolution === 'z-fallback'
          ? 'z-fallback'
          : 'node-list',
      detail: `StripFooting endpoints resolve to different stories: start=${
        start.ownerStoryId || 'unknown'
      }, end=${end.ownerStoryId || 'unknown'}`,
    };
  }

  const [ownerStoryId] = ownerIds;
  return {
    status: String(ownerStoryId) === String(targetStory?.id) ? 'belongs' : 'outside',
    resolution:
      start.resolution === 'z-fallback' || end.resolution === 'z-fallback'
        ? 'z-fallback'
        : 'node-list',
    ownerStoryId: String(ownerStoryId),
    detail: `id_node_start=${startId}; id_node_end=${endId}; ownerStory=${ownerStoryId}`,
  };
}

function parseFootingPlanShape(section) {
  const figures = directChildElements(section, 'StbSecFigureFoundation_RC');
  if (figures.length !== 1) throw new Error('FOOTING_SECTION_FIGURE_UNRESOLVED');
  const shapes = Array.from(figures[0].childNodes || []).filter((child) => child?.nodeType === 1);
  if (shapes.length !== 1) throw new Error('FOOTING_SECTION_SHAPE_AMBIGUOUS');

  const shapeElement = shapes[0];
  const shapeName = elementLocalName(shapeElement);
  if (shapeName === 'StbSecFoundation_RC_Rect') {
    const widthXmm = readPositiveAttribute(shapeElement, 'width_X');
    const widthYmm = readPositiveAttribute(shapeElement, 'width_Y');
    readPositiveAttribute(shapeElement, 'depth');
    return { shapeName, shape: { type: 'RECT', widthXmm, widthYmm } };
  }
  if (shapeName === 'StbSecFoundation_RC_TaperedRect') {
    const widthXmm = readPositiveAttribute(shapeElement, 'width_X');
    const widthYmm = readPositiveAttribute(shapeElement, 'width_Y');
    readPositiveAttribute(shapeElement, 'depth_base');
    readPositiveAttribute(shapeElement, 'depth_tip');
    return { shapeName, shape: { type: 'RECT', widthXmm, widthYmm } };
  }
  if (shapeName === 'StbSecFoundation_RC_Triangle') {
    const widthXmm = readPositiveAttribute(shapeElement, 'width_X');
    const widthYmm = readPositiveAttribute(shapeElement, 'width_Y');
    const chamferXmm = readNumberAttribute(shapeElement, 'width_chamfer_X');
    const chamferYmm = readNumberAttribute(shapeElement, 'width_chamfer_Y');
    readPositiveAttribute(shapeElement, 'depth');
    if (chamferXmm < 0 || chamferYmm < 0 || chamferXmm > widthXmm || chamferYmm > widthYmm) {
      throw new Error('FOOTING_TRIANGLE_CHAMFER_INVALID');
    }
    return {
      shapeName,
      shape: { type: 'TRIANGLE', widthXmm, widthYmm, chamferXmm, chamferYmm },
    };
  }
  if (shapeName === 'StbSecFoundation_RC_EquiTriangle') {
    const widthBaseMm = readPositiveAttribute(shapeElement, 'width_base');
    const widthChamferMm = readNumberAttribute(shapeElement, 'width_chamfer', { required: true });
    readPositiveAttribute(shapeElement, 'depth');
    if (!(widthChamferMm > 0)) throw new Error('FOOTING_EQUI_TRIANGLE_CHAMFER_INVALID');
    return {
      shapeName,
      shape: { type: 'EQUI_TRIANGLE', widthBaseMm, widthChamferMm },
    };
  }
  if (shapeName === 'StbSecFoundation_RC_Octagon') {
    const widthXmm = readPositiveAttribute(shapeElement, 'width_X');
    const widthYmm = readPositiveAttribute(shapeElement, 'width_Y');
    const chamfers = [1, 2, 3, 4].map((index) => ({
      x: readNumberAttribute(shapeElement, `width_chamfer${index}_X`, { required: true }),
      y: readNumberAttribute(shapeElement, `width_chamfer${index}_Y`, { required: true }),
    }));
    readPositiveAttribute(shapeElement, 'depth');
    if (
      chamfers.some((item) => item.x < 0 || item.y < 0 || item.x > widthXmm || item.y > widthYmm)
    ) {
      throw new Error('FOOTING_OCTAGON_CHAMFER_INVALID');
    }
    if (
      chamfers[0].x + chamfers[1].x > widthXmm ||
      chamfers[1].y + chamfers[2].y > widthYmm ||
      chamfers[2].x + chamfers[3].x > widthXmm ||
      chamfers[3].y + chamfers[0].y > widthYmm
    )
      throw new Error('FOOTING_OCTAGON_CHAMFER_OVERLAP');
    return { shapeName, shape: { type: 'OCTAGON', widthXmm, widthYmm, chamfers } };
  }
  if (shapeName === 'StbSecFoundation_RC_Continuous') {
    throw new Error('FOOTING_CONTINUOUS_SECTION_REQUIRES_STRIP_FOOTING');
  }
  throw new Error(`FOOTING_SECTION_SHAPE_UNSUPPORTED:${shapeName || 'unknown'}`);
}

function resolveFootingPlanOutline(raw, foundationSections, nodes) {
  const sectionId = String(raw?.getAttribute?.('id_section') || '').trim();
  if (!sectionId) throw new Error('FOOTING_SECTION_ID_REQUIRED');
  const section = foundationSections?.get?.(sectionId);
  if (!section) throw new Error(`FOOTING_SECTION_NOT_FOUND:${sectionId}`);

  const { shapeName, shape } = parseFootingPlanShape(section);
  const additions = {
    startX: readNumberAttribute(raw, 'thickness_add_start_X'),
    endX: readNumberAttribute(raw, 'thickness_add_end_X'),
    startY: readNumberAttribute(raw, 'thickness_add_start_Y'),
    endY: readNumberAttribute(raw, 'thickness_add_end_Y'),
    top: readNumberAttribute(raw, 'thickness_add_top'),
    bottom: readNumberAttribute(raw, 'thickness_add_bottom'),
  };
  if (Object.values(additions).some((value) => value < 0)) {
    throw new Error('FOOTING_FUKASHI_INVALID');
  }

  let localPoints;
  if (shape.type === 'RECT') {
    localPoints = [
      {
        x: -shape.widthXmm / 2 - additions.startX,
        y: -shape.widthYmm / 2 - additions.startY,
      },
      {
        x: shape.widthXmm / 2 + additions.endX,
        y: -shape.widthYmm / 2 - additions.startY,
      },
      {
        x: shape.widthXmm / 2 + additions.endX,
        y: shape.widthYmm / 2 + additions.endY,
      },
      {
        x: -shape.widthXmm / 2 - additions.startX,
        y: shape.widthYmm / 2 + additions.endY,
      },
    ];
  } else {
    if (
      [additions.startX, additions.endX, additions.startY, additions.endY].some(
        (value) => value > 0,
      )
    ) {
      throw new Error(`FOOTING_NONRECT_FUKASHI_UNSUPPORTED:${shapeName}`);
    }
    const polygon = planPolygon(shape);
    if (!Array.isArray(polygon) || polygon.length < 3) {
      throw new Error(`FOOTING_PLAN_POLYGON_UNRESOLVED:${shapeName}`);
    }
    const centroid = polygonCentroid(polygon);
    if (!centroid || !Number.isFinite(centroid.x) || !Number.isFinite(centroid.y)) {
      throw new Error(`FOOTING_PLAN_CENTROID_UNRESOLVED:${shapeName}`);
    }
    localPoints = polygon.map((point) => ({
      x: point.x - centroid.x,
      y: point.y - centroid.y,
    }));
  }

  const nodeId = String(raw?.getAttribute?.('id_node') || '').trim();
  const node =
    nodes instanceof Map
      ? nodes.get(nodeId) || nodes.get(String(nodeId)) || nodes.get(Number(nodeId))
      : null;
  const nodeX = Number(node?.x);
  const nodeY = Number(node?.y);
  if (!Number.isFinite(nodeX) || !Number.isFinite(nodeY)) {
    throw new Error(`FOOTING_NODE_NOT_FOUND:${nodeId || 'missing'}`);
  }

  const offsetX = readNumberAttribute(raw, 'offset_X');
  const offsetY = readNumberAttribute(raw, 'offset_Y');
  const rotateDeg = readNumberAttribute(raw, 'rotate');
  if (!(rotateDeg >= 0 && rotateDeg < 360)) {
    throw new Error(`FOOTING_ROTATE_OUT_OF_RANGE:${rotateDeg}`);
  }
  if (
    [
      'StbSecFoundation_RC_Rect',
      'StbSecFoundation_RC_TaperedRect',
      'StbSecFoundation_RC_Octagon',
    ].includes(shapeName) &&
    !(rotateDeg < 180)
  ) {
    throw new Error(`FOOTING_ROTATE_OUT_OF_RANGE:${shapeName}:${rotateDeg}`);
  }

  // ST-Bridgeの角度は反時計回りを正とする。
  // Z軸回りは「Z軸を下から見て時計回り」と表現されるため、XY平面では通常の正角を用いる。
  const angle = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centerX = nodeX + offsetX;
  const centerY = nodeY + offsetY;
  const points = localPoints.map((point) =>
    assertPoint([centerX + point.x * cos - point.y * sin, centerY + point.x * sin + point.y * cos]),
  );
  if (points.length < 3) throw new Error('FOOTING_PLAN_POLYGON_INVALID');

  return {
    points,
    sectionName: String(section.getAttribute?.('name') || '').trim(),
    shapeName,
  };
}

function resolveSlabPlanOutline(element, nodes) {
  const nodeIds = element?.node_ids;
  if (!Array.isArray(nodeIds) || nodeIds.length < 3 || !(nodes instanceof Map)) return null;
  const offsets = element.offsets || new Map();
  const points = [];
  for (const nodeId of nodeIds) {
    const node = nodes.get(nodeId) || nodes.get(String(nodeId)) || nodes.get(Number(nodeId));
    if (!node) return null;
    const offset = offsets.get?.(nodeId) || offsets.get?.(String(nodeId)) || offsets[nodeId] || {};
    const x = Number(node.x) + Number(offset.offset_X || 0);
    const y = Number(node.y) + Number(offset.offset_Y || 0);
    const z = Number(node.z) + Number(offset.offset_Z || 0);
    if (![x, y, z].every(Number.isFinite)) return null;
    points.push(new THREE.Vector3(x, y, z));
  }
  return points;
}

/**
 * snapshotは照合対象の独立Document。さらに複製しパーサーの副作用から保護する。
 * signalの検査は部材単位。UIスレッドからの割込みはyieldControlで可能にする。
 * source.modelRevisionの生成・最新性確認は呼出し側の責務。
 */
export async function buildStbPlanDrawing({
  document: sourceDocument,
  source,
  view,
  signal = null,
  // 開口の表示可否を親Wallから切り離す場合に指定する(例: Open単独出力)。
  openingVisibilitySource = null,
  parse = parseStbFile,
  getGeneratorInfo = (type) => geometryGeneratorFactory.getGeneratorInfo(type),
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  const drawing = createEmptyDrawing(source, view);
  if (sourceDocument?.nodeType !== 9 || sourceDocument.documentElement?.localName !== 'ST_BRIDGE') {
    throw new TypeError('ST_BRIDGE Documentが必要です。');
  }
  const snapshot = sourceDocument.cloneNode(true);
  const allStories = parseStories(snapshot, { includeNodeIds: true });
  const stories = allStories.filter((story) => story.id === drawing.view.storyId);
  if (stories.length !== 1 || Math.abs(stories[0].height - drawing.view.baseZ) > 0.1) {
    throw new Error('対象階・階高さが選択したSTB原本に一致しません。');
  }
  const story = stories[0];
  checkCancelled(signal);
  // modelKeyを渡さない。既存のA/B parse cacheを参照・更新しない。
  const parsed = parse(snapshot, { saveToGlobalState: false, forceReparse: true });
  const foundationSections = indexRawElements(
    parseElements(snapshot, 'StbSecFoundation_RC'),
    'StbSecFoundation_RC',
  );
  checkCancelled(signal);
  const clip = {
    type: 'story',
    bounds: { height: view.baseZ, lowerBound: view.lowerZ, upperBound: view.upperZ },
  };
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const seen = new Set();
  const openingRecords = new Map();
  let count = 0;
  for (const canonicalType of PLAN_MEMBER_TYPES) {
    const config = getElementRedrawConfig(canonicalType);
    const rawElements = parseElements(snapshot, config.stbTagName);
    const parsedElements = indexElements(parsed[config.elementsKey]);
    const parsedUndefinedElements = new Map(
      (parsed.undefinedElements || [])
        .filter((element) => element?.originalType === canonicalType)
        .map((element) => [String(element.id), element]),
    );
    for (const raw of rawElements) {
      checkCancelled(signal);
      const ref = createElementRef(
        source,
        canonicalType,
        raw.getAttribute('id'),
        raw.getAttribute('guid'),
      );
      const key = elementRefKey(ref);
      if (seen.has(key)) throw new Error(`原本の部材IDが重複しています: ${key}`);
      seen.add(key);
      const element = parsedElements.get(ref.elementId);
      const renderType = canonicalType === 'Wall' ? getViewerWallElementType(raw) : canonicalType;
      const record = {
        key,
        ref,
        renderType,
        mark: '',
        sectionId: raw.getAttribute('id_section'),
        state: 'failed',
        primitiveIds: [],
        memberAxisModel: null,
      };
      drawing.elements.push(record);
      const diagnostic = (code, detail = '') =>
        drawing.diagnostics.push({ code, elementKey: key, detail });
      if (canonicalType === 'Footing') {
        const ownership = resolveFootingStoryOwnership(raw, story, allStories, parsed.nodes);
        if (ownership.status === 'unresolved') {
          diagnostic('FOOTING_STORY_OWNERSHIP_UNRESOLVED', ownership.detail);
          if (++count % 25 === 0) await yieldControl();
          continue;
        }
        if (ownership.status === 'outside') {
          record.state = 'outside-view';
          if (++count % 25 === 0) await yieldControl();
          continue;
        }
        if (ownership.resolution === 'z-fallback') {
          diagnostic('FOOTING_STORY_Z_FALLBACK', ownership.detail);
        }
      }
      if (canonicalType === 'Pile') {
        const ownership = resolveFootingStoryOwnership(raw, story, allStories, parsed.nodes);
        if (ownership.status === 'unresolved') {
          diagnostic('PILE_STORY_OWNERSHIP_UNRESOLVED', ownership.detail);
          if (++count % 25 === 0) await yieldControl();
          continue;
        }
        if (ownership.status === 'outside') {
          record.state = 'outside-view';
          if (++count % 25 === 0) await yieldControl();
          continue;
        }
        if (ownership.resolution === 'z-fallback') {
          diagnostic('PILE_STORY_Z_FALLBACK', ownership.detail);
        }
      }
      if (canonicalType === 'Parapet') {
        // ST-Bridge仕様: パラペットの所属階は始端節点が属する階。
        const ownership = resolveFootingStoryOwnership(raw, story, allStories, parsed.nodes);
        if (ownership.status === 'unresolved') {
          diagnostic('PARAPET_STORY_OWNERSHIP_UNRESOLVED', ownership.detail);
          if (++count % 25 === 0) await yieldControl();
          continue;
        }
        if (ownership.status === 'outside') {
          record.state = 'outside-view';
          if (++count % 25 === 0) await yieldControl();
          continue;
        }
        if (ownership.resolution === 'z-fallback') {
          diagnostic('PARAPET_STORY_Z_FALLBACK', ownership.detail);
        }
      }
      if (canonicalType === 'StripFooting') {
        const ownership = resolveStripFootingStoryOwnership(raw, story, allStories, parsed.nodes);
        if (ownership.status === 'unresolved') {
          diagnostic('STRIP_FOOTING_STORY_OWNERSHIP_UNRESOLVED', ownership.detail);
          if (++count % 25 === 0) await yieldControl();
          continue;
        }
        if (ownership.status === 'outside') {
          record.state = 'outside-view';
          if (++count % 25 === 0) await yieldControl();
          continue;
        }
        if (ownership.resolution === 'z-fallback') {
          diagnostic('STRIP_FOOTING_STORY_Z_FALLBACK', ownership.detail);
        }
      }
      const undefinedElement = parsedUndefinedElements.get(ref.elementId);
      if (!element && undefinedElement) {
        // StbSecUndefined is an auxiliary/dummy member with no section geometry by definition.
        // Keep it explicit in DrawingModel/coverage, but do not fail the whole story batch.
        record.state = 'reference-only';
        record.taggable = false;
        diagnostic(
          'UNDEFINED_SECTION_REFERENCE_ONLY',
          'StbSecUndefined has no drawable section geometry',
        );
        if (++count % 25 === 0) await yieldControl();
        continue;
      }
      if (canonicalType === 'Footing') {
        try {
          if (!element) throw new Error('PARSER_DROPPED_MEMBER');
          const resolved = resolveFootingPlanOutline(raw, foundationSections, parsed.nodes);
          record.mark =
            resolved.sectionName ||
            resolveDxfElementMark('Footing', { sectionId: record.sectionId }, parsed);
          const primitive = {
            id: JSON.stringify([key, 'plan-outline']),
            kind: 'polyline',
            closed: true,
            ref,
            elementKey: key,
            sectionPart: 0,
            cutZ: view.baseZ,
            points: resolved.points,
          };
          drawing.primitives.push(primitive);
          record.primitiveIds.push(primitive.id);
          extendBounds(bounds, primitive.points);
          record.state = 'drawn';
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          diagnostic('MEMBER_EXTRACTION_FAILED', error.message);
        }
        if (++count % 25 === 0) await yieldControl();
        continue;
      }
      if (canonicalType === 'Pile') {
        try {
          if (!element) throw new Error('PARSER_DROPPED_MEMBER');
          const resolved = resolvePilePlanGeometry({
            document: snapshot,
            member: raw,
            nodes: parsed.nodes,
          });
          const points = resolved.points.map((point) => assertPoint(point));
          const primitive = {
            id: JSON.stringify([key, 'pile-plan']),
            kind: 'polyline',
            closed: true,
            ref,
            elementKey: key,
            sectionPart: 0,
            cutZ: view.baseZ,
            points,
          };
          drawing.primitives.push(primitive);
          record.primitiveIds.push(primitive.id);
          record.mark = resolveDxfElementMark(
            canonicalType,
            { sectionId: record.sectionId, elementId: ref.elementId },
            parsed,
          );
          record.state = 'drawn';
          extendBounds(bounds, points);
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          diagnostic('MEMBER_EXTRACTION_FAILED', error.message);
        }
        if (++count % 25 === 0) await yieldControl();
        continue;
      }
      if (canonicalType === 'Parapet') {
        try {
          if (!element) throw new Error('PARSER_DROPPED_MEMBER');
          const resolved = resolveParapetPlanGeometry({
            document: snapshot,
            member: raw,
            nodes: parsed.nodes,
          });
          const points = resolved.points.map((point) => assertPoint(point));
          const primitive = {
            id: JSON.stringify([key, 'parapet-plan']),
            kind: 'polyline',
            closed: true,
            ref,
            elementKey: key,
            sectionPart: 0,
            cutZ: view.baseZ,
            points,
          };
          drawing.primitives.push(primitive);
          record.primitiveIds.push(primitive.id);
          record.memberAxisModel = resolved.memberAxisModel;
          record.mark = resolveDxfElementMark(
            canonicalType,
            { sectionId: record.sectionId, elementId: ref.elementId },
            parsed,
          );
          record.state = 'drawn';
          extendBounds(bounds, points);
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          diagnostic('MEMBER_EXTRACTION_FAILED', error.message);
        }
        if (++count % 25 === 0) await yieldControl();
        continue;
      }
      if (canonicalType === 'StripFooting') {
        try {
          if (!element) throw new Error('PARSER_DROPPED_MEMBER');
          const sectionMap = parsed[config.sectionsKey];
          if (
            !(sectionMap instanceof Map) ||
            (!sectionMap.has(record.sectionId) && !sectionMap.has(Number(record.sectionId)))
          ) {
            throw new Error('SECTION_UNAVAILABLE');
          }
          const resolved = resolveStripFootingPlanGeometry({
            document: snapshot,
            member: raw,
            nodes: parsed.nodes,
          });
          const points = resolved.points.map((point) => assertPoint(point));
          const primitive = {
            id: JSON.stringify([key, 'strip-footing-plan']),
            kind: 'polyline',
            closed: true,
            ref,
            elementKey: key,
            sectionPart: 0,
            cutZ: view.baseZ,
            points,
          };
          drawing.primitives.push(primitive);
          record.primitiveIds.push(primitive.id);
          record.memberAxisModel = resolved.memberAxisModel;
          record.mark = resolveDxfElementMark(
            canonicalType,
            { sectionId: record.sectionId, elementId: ref.elementId },
            parsed,
          );
          record.state = 'drawn';
          extendBounds(bounds, points);
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          diagnostic('MEMBER_EXTRACTION_FAILED', error.message);
        }
        if (++count % 25 === 0) await yieldControl();
        continue;
      }
      let meshes = [];
      try {
        if (!element) throw new Error('PARSER_DROPPED_MEMBER');
        const viaNodes = readMemberViaNodes(raw, canonicalType);
        if (viaNodes === null) {
          diagnostic('MEMBER_AXIS_PATH_INVALID', 'via-node order/offset is invalid');
        } else {
          record.memberAxisModel = resolveMemberAxisModel({
            elementType: canonicalType,
            element,
            nodes: parsed.nodes,
            viaNodes,
          });
          if (viaNodes.length > 0 && record.memberAxisModel === null) {
            diagnostic(
              'MEMBER_AXIS_PATH_UNRESOLVED',
              'via-node path could not be resolved from parsed nodes/offsets',
            );
          }
        }
        const sectionMap = parsed[config.sectionsKey];
        if (
          !(sectionMap instanceof Map) ||
          (!sectionMap.has(record.sectionId) && !sectionMap.has(Number(record.sectionId)))
        ) {
          throw new Error('SECTION_UNAVAILABLE');
        }
        const info = getGeneratorInfo(renderType);
        if (typeof info?.class?.[info.method] !== 'function')
          throw new Error('GENERATOR_UNAVAILABLE');
        const result = info.class[info.method](
          [element],
          parsed.nodes,
          parsed[config.sectionsKey],
          parsed.steelSections,
          renderType,
          false,
          canonicalType === 'Wall' ? parsed.openingElements || null : null,
        );
        if (!Array.isArray(result)) throw new Error('INVALID_GENERATOR_RESULT');
        meshes = result.filter(Boolean);
        if (meshes.length === 0) throw new Error('GEOMETRY_UNAVAILABLE');
        // 元STBから生成した一時Meshのみ扱う。既存sceneに触れない。
        // 部材・開口とも全partの抽出が成功するまでDrawingModelへcommitしない。
        const pending = [];
        const pendingOpenings = [];
        const slabPlanOutline =
          canonicalType === 'Slab' ? resolveSlabPlanOutline(element, parsed.nodes) : null;
        let intersects = false;
        for (const [part, mesh] of meshes.entries()) {
          checkCancelled(signal);
          if (!mesh.isMesh || mesh.isInstancedMesh) throw new Error('UNSUPPORTED_GENERATED_OBJECT');
          const box = new THREE.Box3().setFromObject(mesh);
          if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite))
            throw new Error('INVALID_GEOMETRY_BOUNDS');
          const cutZ = resolveStoryPlanCutZ(canonicalType, box, clip, view.verticalCutOffset);
          if (cutZ == null) continue;
          intersects = true;
          if (!record.mark)
            record.mark = resolveDxfElementMark(
              canonicalType,
              { ...mesh.userData, sectionId: record.sectionId },
              parsed,
            );
          const loops =
            canonicalType === 'Slab' && slabPlanOutline
              ? [slabPlanOutline]
              : extractHorizontalSectionLoops(mesh, cutZ);
          if (loops.length === 0) throw new Error('SECTION_EXTRACTION_EMPTY');
          for (const [loopIndex, loop] of loops.entries()) {
            const points = loop.map((point) => assertPoint([point.x, point.y]));
            if (points.length < 3) throw new Error('INVALID_SECTION_LOOP');
            pending.push({
              id: JSON.stringify([key, part, loopIndex]),
              kind: 'polyline',
              closed: true,
              ref,
              elementKey: key,
              sectionPart: part,
              cutZ,
              points,
            });
          }
          if (canonicalType === 'Wall') {
            for (const opening of collectWallOpeningPolylinesFromMesh(mesh, clip, {
              planCutOffset: view.verticalCutOffset,
            })) {
              // STB 2.1.x の開口は StbOpenArrangement。要素情報・ツリーはref.elementTypeからStbタグを引くため、
              // 参照型だけを実体に合わせ、表示レイヤ(renderType)は 'Open' のまま保つ。
              const openingRef = createElementRef(
                source,
                opening.opening?.sourceVersion === '2.1.0' ? 'OpenArrangement' : 'Open',
                opening.openingId,
                opening.opening?.guid || null,
              );
              const openingKey = elementRefKey(openingRef);
              const points = opening.points.map((point) => assertPoint([point.x, point.y]));
              if (points.length < 4) throw new Error('INVALID_OPENING_LOOP');
              pendingOpenings.push({
                openingKey,
                openingRef,
                parentElementKey: key,
                visibilitySource: openingVisibilitySource || renderType,
                mark: opening.opening?.name || '',
                sectionId: opening.opening?.sectionId || null,
                primitive: {
                  id: JSON.stringify([openingKey, key, part, opening.cutZ]),
                  kind: 'polyline',
                  closed: true,
                  ref: openingRef,
                  elementKey: openingKey,
                  sectionPart: part,
                  cutZ: opening.cutZ,
                  points,
                  parentElementKey: key,
                  role: 'wall-opening-outline',
                },
              });
            }
          }
        }
        // 既存Open identityとのparent競合をcommit前に検証する。
        for (const pendingOpening of pendingOpenings) {
          const existing = openingRecords.get(pendingOpening.openingKey);
          if (existing && existing.parentElementKey !== pendingOpening.parentElementKey) {
            throw new Error(
              `OPENING_PARENT_CONFLICT: ${pendingOpening.openingRef.elementId} is linked to multiple walls`,
            );
          }
        }

        for (const primitive of pending) {
          drawing.primitives.push(primitive);
          record.primitiveIds.push(primitive.id);
          extendBounds(bounds, primitive.points);
        }
        for (const pendingOpening of pendingOpenings) {
          let openingRecord = openingRecords.get(pendingOpening.openingKey);
          if (!openingRecord) {
            openingRecord = {
              key: pendingOpening.openingKey,
              ref: pendingOpening.openingRef,
              renderType: 'Open',
              mark: pendingOpening.mark,
              sectionId: pendingOpening.sectionId,
              state: 'drawn',
              primitiveIds: [],
              parentElementKey: pendingOpening.parentElementKey,
              visibilitySource: pendingOpening.visibilitySource,
              taggable: false,
            };
            openingRecords.set(pendingOpening.openingKey, openingRecord);
            drawing.elements.push(openingRecord);
          }
          if (!openingRecord.primitiveIds.includes(pendingOpening.primitive.id)) {
            drawing.primitives.push(pendingOpening.primitive);
            openingRecord.primitiveIds.push(pendingOpening.primitive.id);
            extendBounds(bounds, pendingOpening.primitive.points);
          }
        }
        record.state = intersects ? 'drawn' : 'outside-view';
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        diagnostic('MEMBER_EXTRACTION_FAILED', error.message);
      } finally {
        disposeMeshes(meshes);
      }
      if (++count % 25 === 0) await yieldControl();
    }
  }
  checkCancelled(signal);
  drawing.bounds = drawing.primitives.length ? bounds : null;
  if (drawing.bounds) {
    drawing.annotations = [
      ...buildStbPlanAnnotations({ document: snapshot, bounds: drawing.bounds }),
    ];
    drawing.dimensionReferences = buildStbPlanDimensionReferences({ document: snapshot });
    // #447: 通り芯寸法はsemantic intentを正本とし、最終primitiveはDrawingRenderPlanでcompileする。
    drawing.dimensionIntents = buildStbPlanDimensionIntents({
      document: snapshot,
      bounds: drawing.bounds,
      dimensionReferences: drawing.dimensionReferences,
    });
  }
  const primaryElements = drawing.elements.filter((element) => element.renderType !== 'Open');
  drawing.coverage = {
    supportedTypes: [...PLAN_MEMBER_TYPES],
    auxiliaryTypes: ['Open'],
    sourceMembers: primaryElements.length,
    drawn: primaryElements.filter((element) => element.state === 'drawn').length,
    outsideView: primaryElements.filter((element) => element.state === 'outside-view').length,
    referenceOnly: primaryElements.filter((element) => element.state === 'reference-only').length,
    failed: primaryElements.filter((element) => element.state === 'failed').length,
    openingsDrawn: drawing.elements.filter(
      (element) => element.renderType === 'Open' && element.state === 'drawn',
    ).length,
    scopeNote:
      '柱・間柱・大梁・小梁・ブレース・スラブ外形・壁外形・壁開口・フーチング・布基礎・杭頭・パラペット + STB明示平行通り芯・通り間寸法・全体寸法。',
  };
  return drawing;
}
