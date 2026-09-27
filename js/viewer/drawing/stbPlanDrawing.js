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
import { resolveStoryPlanCutZ } from '../../export/dxf/stb-to-dxf/DxfPlanCut.js';
import { extractHorizontalSectionLoops } from '../../export/dxf/stb-to-dxf/DxfSectionExtractor.js';
import { resolveDxfElementMark } from '../../export/dxf/stb-to-dxf/DxfMarkResolver.js';
import { buildStbPlanAnnotations } from './stbPlanAnnotations.js';

export const PLAN_MEMBER_TYPES = Object.freeze([
  'Column',
  'Post',
  'Girder',
  'Beam',
  'Brace',
  'Slab',
  'Wall',
]);

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
  parse = parseStbFile,
  getGeneratorInfo = (type) => geometryGeneratorFactory.getGeneratorInfo(type),
  yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  const drawing = createEmptyDrawing(source, view);
  if (sourceDocument?.nodeType !== 9 || sourceDocument.documentElement?.localName !== 'ST_BRIDGE') {
    throw new TypeError('ST_BRIDGE Documentが必要です。');
  }
  const snapshot = sourceDocument.cloneNode(true);
  const stories = parseStories(snapshot).filter((story) => story.id === drawing.view.storyId);
  if (stories.length !== 1 || Math.abs(stories[0].height - drawing.view.baseZ) > 0.1) {
    throw new Error('対象階・階高さが選択したSTB原本に一致しません。');
  }
  checkCancelled(signal);
  // modelKeyを渡さない。既存のA/B parse cacheを参照・更新しない。
  const parsed = parse(snapshot, { saveToGlobalState: false, forceReparse: true });
  checkCancelled(signal);
  const clip = {
    type: 'story',
    bounds: { height: view.baseZ, lowerBound: view.lowerZ, upperBound: view.upperZ },
  };
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const seen = new Set();
  let count = 0;
  for (const canonicalType of PLAN_MEMBER_TYPES) {
    const config = getElementRedrawConfig(canonicalType);
    const rawElements = parseElements(snapshot, config.stbTagName);
    const parsedElements = indexElements(parsed[config.elementsKey]);
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
      };
      drawing.elements.push(record);
      const diagnostic = (code, detail = '') =>
        drawing.diagnostics.push({ code, elementKey: key, detail });
      let meshes = [];
      try {
        if (!element) throw new Error('PARSER_DROPPED_MEMBER');
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
        const pending = [];
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
          const loops = extractHorizontalSectionLoops(mesh, cutZ);
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
              cutZ,
              points,
            });
          }
          if (mesh.userData?.wallData?.openings?.length) {
            // 現DXFの壁外形断面は開口をくり抜かない。誤って「穴なし」と確定させない。
            diagnostic('WALL_OPENING_OVERLAY_PENDING', '壁外形のみ。開口別レイヤの接続は未実装。');
          }
        }
        for (const primitive of pending) {
          drawing.primitives.push(primitive);
          record.primitiveIds.push(primitive.id);
          extendBounds(bounds, primitive.points);
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
  }
  drawing.coverage = {
    supportedTypes: [...PLAN_MEMBER_TYPES],
    sourceMembers: drawing.elements.length,
    drawn: drawing.elements.filter((element) => element.state === 'drawn').length,
    outsideView: drawing.elements.filter((element) => element.state === 'outside-view').length,
    failed: drawing.elements.filter((element) => element.state === 'failed').length,
    scopeNote:
      '柱・間柱・大梁・小梁・ブレース・スラブ外形・壁外形 + STB明示平行通り芯・通り間寸法・全体寸法。壁開口別表示は未接続。',
  };
  return drawing;
}
