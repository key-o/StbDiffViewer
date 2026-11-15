/**
 * @fileoverview ブラウザ用 IFC → STB 変換オーケストレーター
 *
 * Node.js版 IfcToStbConverter のブラウザ対応版。
 * ArrayBuffer を受け取り、7段階パイプラインでSTB XMLを生成する。
 *
 * @module IfcToStbBrowserConverter
 */

import { IfcBrowserModelReader } from './IfcBrowserModelReader.js';
import { buildRestorationDiagnostics } from './diagnostics/restorationDiagnostics.js';
import { SpatialStructureExtractor } from './pipeline/SpatialStructureExtractor.js';
import { NodeReconstructor } from './pipeline/NodeReconstructor.js';
import { ElementClassifier } from './pipeline/ElementClassifier.js';
import { ProfileAnalyzer } from './pipeline/ProfileAnalyzer.js';
import { HaunchDetector } from './pipeline/HaunchDetector.js';
import { generateStbXml } from './pipeline/StbXmlGenerator.js';
import {
  extractSlabFaceNodes,
  extractSlabExtrusionDepth,
} from './pipeline/RectangularSlabNodes.js';
import * as WebIFC from 'web-ifc';
import {
  resolvePlacement,
  extractPosition,
  transformPoint,
  multiplyMatrices,
  buildMatrixFromAxis2Placement,
  collectMappedItemLeaves,
} from './util/CoordinateHelper.js';
import {
  buildSimpleElementRecord,
  buildWallElementRecord,
  buildWallOpeningMap,
  extractWallDimensions,
  buildPileAttrs,
  buildPileProfileResult,
  countElementsByType,
  parsePileMetadata,
  buildFoundationColumnSectionAttrs,
  recoverPilePoints,
  buildFootingElementRecord,
} from './elementRecordBuilders.js';
import {
  calculateBeamBasis,
  dotProduct,
  crossProduct,
  normalizeVector,
} from '../data/geometry/vectorMath.js';

export class IfcToStbBrowserConverter {
  /**
   * @param {Object} [options]
   * @param {number} [options.nodeTolerance=1.0] - 節点マージ許容差 (mm)
   * @param {boolean} [options.enableHaunch=false] - ハンチ検出
   * @param {number} [options.haunchSamples=20] - ハンチサンプリング数
   * @param {function} [options.onProgress] - 進捗コールバック (message: string) => void
   */
  constructor(options = {}) {
    this.nodeTolerance = options.nodeTolerance ?? 1.0;
    this.enableHaunch = options.enableHaunch ?? false;
    this.haunchSamples = options.haunchSamples ?? 20;
    this.onProgress = options.onProgress || null;
    this.reader = new IfcBrowserModelReader();
    this.warnings = [];
  }

  /**
   * web-ifc を初期化
   * @param {string} [wasmPath='./wasm/'] - WASMパス
   */
  async init(wasmPath = './wasm/') {
    this._progress('IFCエンジンを初期化中...');
    await this.reader.init(wasmPath);
  }

  /**
   * ArrayBuffer からSTB XMLに変換
   * @param {ArrayBuffer} arrayBuffer - IFCファイルデータ
   * @returns {Promise<{xml: string, summary: Object}>}
   */
  async convert(arrayBuffer) {
    // Stage 1: IFC読み込み
    this._progress('IFCモデルを解析中...');
    const { api, modelID, schema, unitFactor } = await this.reader.load(arrayBuffer);

    // Stage 2: 階情報
    this._progress('階情報を抽出中...');
    const spatialExtractor = new SpatialStructureExtractor(api, modelID, unitFactor);
    const { stories, elementToStory } = spatialExtractor.extract();

    // Stage 3: 節点テーブル
    const nodeReconstructor = new NodeReconstructor(this.nodeTolerance);

    // Stage 4: 要素分類
    this._progress('構造要素を分類中...');
    const classifier = new ElementClassifier(api, modelID, unitFactor);
    const rawElements = classifier.classify();

    // Stage 5: プロファイル解析
    this._progress('断面を解析中...');
    const profileAnalyzer = new ProfileAnalyzer(api, modelID, unitFactor);

    // Stage 6: ハンチ検出（オプション）
    const haunchDetector = this.enableHaunch
      ? new HaunchDetector(api, modelID, unitFactor, {
          numSamples: this.haunchSamples,
        })
      : null;

    // Stage 3+5+6 統合
    const placementCache = new Map();
    const processedElements = [];
    const processedOutcomes = [];
    let elementIdCounter = 1;

    // 開口マップ構築: wallExpressID → [openingInfo, ...]
    const wallOpeningMap = buildWallOpeningMap(api, modelID, unitFactor);

    for (const el of rawElements) {
      const processed = this._processElement(
        api,
        modelID,
        unitFactor,
        el,
        nodeReconstructor,
        profileAnalyzer,
        elementToStory,
        placementCache,
        elementIdCounter++,
        haunchDetector,
        wallOpeningMap,
      );
      processedOutcomes.push(processed || null);
      if (processed) {
        processedElements.push(processed);
      }
    }

    const nodes = nodeReconstructor.getNodes();
    const sections = profileAnalyzer.getSections();
    const restorationDiagnostics = buildRestorationDiagnostics(rawElements, processedOutcomes);

    // Stage 7: XML生成
    this._progress('STB形式に変換中...');
    const xml = generateStbXml({
      nodes,
      stories,
      elements: processedElements,
      sections,
      meta: { projectName: 'IFC-Converted' },
    });

    const summary = {
      schema,
      unitFactor,
      stories: stories.length,
      nodes: nodes.length,
      elements: processedElements.length,
      sections: sections.length,
      elementsByType: countElementsByType(processedElements),
      warnings: this.warnings,
      restorationDiagnostics,
    };

    return { xml, summary, schema };
  }

  /**
   * リソース解放
   */
  close() {
    this.reader.close();
  }

  _processElement(
    api,
    modelID,
    unitFactor,
    el,
    nodeReconstructor,
    profileAnalyzer,
    elementToStory,
    placementCache,
    elementId,
    haunchDetector,
    wallOpeningMap = new Map(),
  ) {
    if (el.stbType === 'StbFoundationColumn') {
      return this._processFoundationColumnElement(
        api,
        modelID,
        unitFactor,
        el,
        nodeReconstructor,
        profileAnalyzer,
        elementToStory,
        placementCache,
        elementId,
      );
    }
    if (['column', 'beam', 'brace', 'pile'].includes(el.stbCategory)) {
      return this._processLinearElement(
        api,
        modelID,
        unitFactor,
        el,
        nodeReconstructor,
        profileAnalyzer,
        elementToStory,
        placementCache,
        elementId,
        haunchDetector,
      );
    }
    if (el.stbCategory === 'wall') {
      return this._processWallElement(
        api,
        modelID,
        unitFactor,
        el,
        nodeReconstructor,
        profileAnalyzer,
        elementToStory,
        placementCache,
        elementId,
        wallOpeningMap,
      );
    }
    if (el.stbCategory === 'slab') {
      return this._processSurfaceElement(
        api,
        modelID,
        unitFactor,
        el,
        nodeReconstructor,
        profileAnalyzer,
        elementToStory,
        placementCache,
        elementId,
      );
    }
    return this._processSimpleElement(
      api,
      modelID,
      unitFactor,
      el,
      nodeReconstructor,
      profileAnalyzer,
      elementToStory,
      placementCache,
      elementId,
    );
  }

  _processFoundationColumnElement(
    api,
    modelID,
    unitFactor,
    el,
    nodeReconstructor,
    profileAnalyzer,
    elementToStory,
    placementCache,
    elementId,
  ) {
    if (!el.placementRef) return null;
    const worldMatrix = resolvePlacement(api, modelID, el.placementRef, placementCache);
    const origin = extractPosition(worldMatrix);
    const profileResult = profileAnalyzer.analyzeElement(el.representationRef, { element: el });
    const nodeStart = nodeReconstructor.addOrGet(
      origin.x * unitFactor,
      origin.y * unitFactor,
      origin.z * unitFactor,
    );
    return {
      id: String(elementId),
      stbType: el.stbType,
      stbCategory: el.stbCategory,
      name: el.name || `${el.stbType}-${elementId}`,
      nodeStart,
      sectionId: profileResult?.sectionId || null,
      storyId: elementToStory.get(el.expressID) || null,
      kindStructure: el.kindStructure || 'RC',
      rotate: this._extractRotation(worldMatrix, 'column'),
      ...buildFoundationColumnSectionAttrs(el.description, profileResult),
      offsetFDX: 0,
      offsetFDY: 0,
      offsetZ: 0,
    };
  }

  _processLinearElement(
    api,
    modelID,
    unitFactor,
    el,
    nodeReconstructor,
    profileAnalyzer,
    elementToStory,
    placementCache,
    elementId,
    haunchDetector,
  ) {
    if (!el.placementRef) return null;

    const worldMatrix = resolvePlacement(api, modelID, el.placementRef, placementCache);
    const pileMeta = el.stbCategory === 'pile' ? parsePileMetadata(el.description) : null;
    const analyzedProfile = profileAnalyzer.analyzeElement(el.representationRef, {
      element: el,
      ...(pileMeta ? { skipSectionRegistration: true } : {}),
    });
    const profileResult =
      el.stbCategory === 'pile' && pileMeta
        ? buildPileProfileResult(profileAnalyzer, pileMeta, analyzedProfile)
        : analyzedProfile;
    if (profileResult?.measuredBrepLoft && !profileResult.sectionId) {
      this.warnings.push(
        `BRep beam ${el.expressID}: source axis recovered, STB section/profile unrepresented`,
      );
    }
    const length = profileResult?.length || analyzedProfile?.length || 0;

    // Main's mapped-solid placement applies only to extrusion geometry.
    // BRep localAxis* is measured in the product's local placement instead.
    const solidPositionRef = analyzedProfile?.extrusionPositionRef;
    const mappedWorldMatrix = analyzedProfile?.mappingTransform
      ? multiplyMatrices(worldMatrix, analyzedProfile.mappingTransform)
      : worldMatrix;
    const solidWorldMatrix = solidPositionRef
      ? multiplyMatrices(
          mappedWorldMatrix,
          buildMatrixFromAxis2Placement(api, modelID, solidPositionRef),
        )
      : mappedWorldMatrix;
    const direction = analyzedProfile?.extrusionDirection || { x: 0, y: 0, z: 1 };
    const shapeStart = transformPoint({ x: 0, y: 0, z: 0 }, solidWorldMatrix);
    const shapeEnd = transformPoint(
      {
        x: direction.x * (length / unitFactor),
        y: direction.y * (length / unitFactor),
        z: direction.z * (length / unitFactor),
      },
      solidWorldMatrix,
    );
    const toMillimetres = (point) => ({
      x: point.x * unitFactor,
      y: point.y * unitFactor,
      z: point.z * unitFactor,
    });
    // readIfcRectangularBrepLoft already returns IFC-local coordinates in mm.
    // Convert back to IFC units before applying ObjectPlacement.
    const transformLocalAxis = (coords) =>
      toMillimetres(
        transformPoint(
          { x: coords[0] / unitFactor, y: coords[1] / unitFactor, z: coords[2] / unitFactor },
          worldMatrix,
        ),
      );
    const startPt = profileResult?.localAxisStart
      ? transformLocalAxis(profileResult.localAxisStart)
      : toMillimetres(shapeStart);
    const endPt = profileResult?.localAxisEnd
      ? transformLocalAxis(profileResult.localAxisEnd)
      : toMillimetres(shapeEnd);
    const dirX = (endPt.x - startPt.x) / unitFactor;
    const dirY = (endPt.y - startPt.y) / unitFactor;
    const dirZ = (endPt.z - startPt.z) / unitFactor;

    // Recover analytical STB nodes from measured IFC shape endpoints only when
    // explicitly sourced STB offsets survive in validated Description metadata.
    const sourceBeamOffsets = el.stbCategory === 'beam' ? el.sourceBeamOffsets : null;
    const sourceLinearOffsets =
      el.stbCategory === 'column' || el.stbCategory === 'brace' ? el.sourceLinearOffsets : null;
    const sourceOffsets = sourceBeamOffsets || sourceLinearOffsets;
    const startSide = el.stbCategory === 'column' ? 'bottom' : 'start';
    const endSide = el.stbCategory === 'column' ? 'top' : 'end';
    const analyticStart = sourceOffsets
      ? {
          x: startPt.x - sourceOffsets[startSide].x,
          y: startPt.y - sourceOffsets[startSide].y,
          z: startPt.z - sourceOffsets[startSide].z,
        }
      : startPt;
    const analyticEnd = sourceOffsets
      ? {
          x: endPt.x - sourceOffsets[endSide].x,
          y: endPt.y - sourceOffsets[endSide].y,
          z: endPt.z - sourceOffsets[endSide].z,
        }
      : endPt;
    const analytical = recoverPilePoints(analyticStart, analyticEnd, pileMeta);
    const nodeStart = nodeReconstructor.addOrGet(
      analytical.start.x,
      analytical.start.y,
      analytical.start.z,
    );
    const nodeEnd = nodeReconstructor.addOrGet(
      analytical.end.x,
      analytical.end.y,
      analytical.end.z,
    );

    let haunch = null;
    if (haunchDetector && el.stbCategory === 'beam') {
      const dirNorm = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
      const axisDir = dirNorm > 0 ? [dirX / dirNorm, dirY / dirNorm, dirZ / dirNorm] : [0, 0, 1];
      const originArr = [startPt.x / unitFactor, startPt.y / unitFactor, startPt.z / unitFactor];
      const haunchResult = haunchDetector.detect(
        el.expressID,
        el.representationRef,
        axisDir,
        originArr,
        length,
      );
      if (haunchResult && haunchResult.pattern !== 'SAME') {
        haunch = haunchResult;
      }
    }

    const rotate = this._extractRotation(
      profileResult?.localAxisStart ? worldMatrix : solidWorldMatrix,
      el.stbCategory,
    );
    const kindStructure = this._resolveLinearKindStructure(el, profileResult);

    return {
      id: String(elementId),
      stbType: el.stbType,
      stbCategory: el.stbCategory,
      name: el.name || `${el.stbType}-${elementId}`,
      nodeStart,
      nodeEnd,
      ...(sourceBeamOffsets ? { sourceBeamOffsets } : {}),
      ...(sourceLinearOffsets ? { sourceLinearOffsets } : {}),
      sectionId: profileResult?.sectionId || null,
      storyId: elementToStory.get(el.expressID) || null,
      kindStructure,
      ...(el.stbCategory === 'beam' && typeof el.isFoundation === 'boolean'
        ? { isFoundation: el.isFoundation }
        : {}),
      rotate,
      haunch,
      ...(el.stbCategory === 'pile'
        ? buildPileAttrs(startPt, endPt, nodeStart, nodeEnd, length, pileMeta)
        : {}),
    };
  }

  _processSurfaceElement(
    api,
    modelID,
    unitFactor,
    el,
    nodeReconstructor,
    profileAnalyzer,
    elementToStory,
    placementCache,
    elementId,
  ) {
    if (!el.placementRef) return null;

    const worldMatrix = resolvePlacement(api, modelID, el.placementRef, placementCache);
    const origin = extractPosition(worldMatrix);
    const profileResult = profileAnalyzer.analyzeElement(el.representationRef);

    const corners =
      this._extractSlabVertices(api, modelID, unitFactor, el.representationRef, worldMatrix) ||
      extractSlabFaceNodes(api, modelID, unitFactor, el.representationRef, worldMatrix);
    const measuredDepth = extractSlabExtrusionDepth(api, modelID, unitFactor, el.representationRef);
    const section =
      measuredDepth != null && (el.surfaceMetadata?.kindStructure || el.kindStructure) === 'RC'
        ? profileAnalyzer.registerSection({
            stbType: 'SLAB_RC',
            name: `Slab-RC-${measuredDepth}`,
            params: { depth: measuredDepth },
          })
        : null;
    const nodeIds = corners
      ? corners.map((point) => nodeReconstructor.addOrGet(point.x, point.y, point.z))
      : [
          nodeReconstructor.addOrGet(
            origin.x * unitFactor,
            origin.y * unitFactor,
            origin.z * unitFactor,
          ),
        ];

    return {
      id: String(elementId),
      stbType: el.stbType,
      stbCategory: el.stbCategory,
      name: el.name || `${el.stbType}-${elementId}`,
      nodeIds,
      kindSlab: el.surfaceMetadata?.kindSlab || null,
      isFoundation: el.surfaceMetadata?.isFoundation ?? null,
      sectionId: section?.id || profileResult?.sectionId || null,
      storyId: elementToStory.get(el.expressID) || null,
      kindStructure: el.surfaceMetadata?.kindStructure || el.kindStructure || 'S',
    };
  }

  _processSimpleElement(
    api,
    modelID,
    unitFactor,
    el,
    nodeReconstructor,
    profileAnalyzer,
    elementToStory,
    placementCache,
    elementId,
  ) {
    if (!el.placementRef) return null;

    const worldMatrix = resolvePlacement(api, modelID, el.placementRef, placementCache);
    const origin = extractPosition(worldMatrix);
    const profileResult = profileAnalyzer.analyzeElement(el.representationRef, { element: el });

    if (el.stbType === 'StbFooting') {
      return {
        ...buildFootingElementRecord({
          el,
          elementId,
          origin,
          unitFactor,
          nodeReconstructor,
          profileResult,
          storyId: elementToStory.get(el.expressID) || null,
        }),
        rotate: this._extractRotation(worldMatrix, 'beam'),
      };
    }
    return buildSimpleElementRecord({
      el,
      elementId,
      origin,
      unitFactor,
      nodeReconstructor,
      profileResult,
      storyId: elementToStory.get(el.expressID) || null,
    });
  }

  /**
   * 壁要素の処理: 4コーナーノードを復元し開口を付与
   */
  _processWallElement(
    api,
    modelID,
    unitFactor,
    el,
    nodeReconstructor,
    profileAnalyzer,
    elementToStory,
    placementCache,
    elementId,
    wallOpeningMap,
  ) {
    if (!el.placementRef) return null;

    const worldMatrix = resolvePlacement(api, modelID, el.placementRef, placementCache);
    const origin = extractPosition(worldMatrix);

    const dimensions = extractWallDimensions(api, modelID, unitFactor, el.representationRef);
    // Only a measured IFC wall thickness can become a 2.1 section definition.
    const thickness = Number(dimensions.thickness);
    const registered =
      thickness > 0 && (el.kindStructure || 'RC') === 'RC'
        ? profileAnalyzer.registerSection({
            stbType: 'WALL_RC',
            name: `Wall-RC-${thickness}`,
            params: { t: thickness },
          })
        : null;
    return buildWallElementRecord({
      el,
      elementId,
      origin,
      worldMatrix,
      unitFactor,
      dimensions,
      sectionId: registered?.id || null,
      nodeReconstructor,
      storyId: elementToStory.get(el.expressID) || null,
      wallOpenings: wallOpeningMap.get(el.expressID) || [],
    });
  }

  /**
   * IFC表現からスラブの平面頂点列をワールド座標で返す
   * @returns {Array<{x,y,z}>|null}
   */
  _extractSlabVertices(api, modelID, unitFactor, representationRef, worldMatrix) {
    if (!representationRef) return null;
    const productShape = api.GetLine(modelID, representationRef);
    if (!productShape?.Representations) return null;

    for (const repRef of productShape.Representations) {
      const repId = repRef?.value ?? repRef;
      const rep = api.GetLine(modelID, repId);
      if (!rep?.Items) continue;

      const leaves = rep.Items.flatMap((itemRef) => collectMappedItemLeaves(api, modelID, itemRef));
      for (const leaf of leaves) {
        const item = leaf.item;
        if (item.type !== WebIFC.IFCEXTRUDEDAREASOLID) continue;

        const sweptAreaRef = item.SweptArea?.value ?? item.SweptArea;
        if (!sweptAreaRef) continue;
        const profile = api.GetLine(modelID, sweptAreaRef);
        if (!profile) continue;

        let localPoints = [];

        if (
          profile.type === WebIFC.IFCARBITRARYCLOSEDPROFILEDEF ||
          profile.type === WebIFC.IFCARBITRARYPROFILEDEFWITHVOIDS
        ) {
          const curveRef = profile.OuterCurve?.value ?? profile.OuterCurve;
          if (curveRef) {
            const curve = api.GetLine(modelID, curveRef);
            if (curve?.Points) {
              for (const ptRef of curve.Points) {
                const ptId = ptRef?.value ?? ptRef;
                const pt = api.GetLine(modelID, ptId);
                const coords = pt?.Coordinates;
                if (coords) {
                  localPoints.push({
                    x: coords[0]?.value ?? coords[0] ?? 0,
                    y: coords[1]?.value ?? coords[1] ?? 0,
                    z: 0,
                  });
                }
              }
            }
          }
        } else if (profile.type === WebIFC.IFCRECTANGLEPROFILEDEF) {
          const hx = (profile.XDim?.value ?? profile.XDim ?? 0) / 2;
          const hy = (profile.YDim?.value ?? profile.YDim ?? 0) / 2;
          if (hx <= 0 || hy <= 0) continue;
          localPoints = [
            { x: -hx, y: -hy, z: 0 },
            { x: hx, y: -hy, z: 0 },
            { x: hx, y: hy, z: 0 },
            { x: -hx, y: hy, z: 0 },
          ];
        } else if (profile.type === WebIFC.IFCCIRCLEPROFILEDEF) {
          const radius = profile.Radius?.value ?? profile.Radius ?? 0;
          if (radius <= 0) continue;
          const segments = 48;
          localPoints = Array.from({ length: segments }, (_, i) => {
            const angle = (i * Math.PI * 2) / segments;
            return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), z: 0 };
          });
        }

        if (localPoints.length >= 3) {
          // IFC polylines usually repeat their first vertex as the closing point.
          // STB polygons must not contain this duplicate zero-length edge.
          const first = localPoints[0];
          const last = localPoints[localPoints.length - 1];
          if (first.x === last.x && first.y === last.y && first.z === last.z) {
            localPoints.pop();
          }
          const solidRef = item.Position?.value ?? item.Position;
          const profileRef = profile.Position?.value ?? profile.Position;
          const mappedWorldMatrix = multiplyMatrices(worldMatrix, leaf.mappingTransform);
          const solidMatrix = solidRef
            ? multiplyMatrices(
                mappedWorldMatrix,
                buildMatrixFromAxis2Placement(api, modelID, solidRef),
              )
            : mappedWorldMatrix;
          const finalMatrix = profileRef
            ? multiplyMatrices(solidMatrix, buildMatrixFromAxis2Placement(api, modelID, profileRef))
            : solidMatrix;
          return localPoints.map((p) => {
            const w = transformPoint(p, finalMatrix);
            return {
              x: w.x * unitFactor,
              y: w.y * unitFactor,
              z: w.z * unitFactor,
            };
          });
        }
      }
    }
    return null;
  }

  /**
   * IFCの局所基底からSTB部材の回転角を抽出する
   */
  _extractRotation(m, category) {
    const dirX = m[8];
    const dirY = m[9];
    const dirZ = m[10];
    const refX = m[0];
    const refY = m[1];
    const refZ = m[2];

    if (category === 'column') {
      const angle = Math.atan2(refY, refX) * (180 / Math.PI);
      return Math.round(angle * 1000) / 1000;
    }

    const dir = normalizeVector({ x: dirX, y: dirY, z: dirZ });
    const basis = calculateBeamBasis(dir);
    const defaultX = basis.xAxis;
    const actualRef = normalizeVector({ x: refX, y: refY, z: refZ });

    const crossed = crossProduct(defaultX, actualRef);
    const sinAngle = dotProduct(crossed, dir);
    const cosAngle = dotProduct(defaultX, actualRef);
    const angle = Math.atan2(sinAngle, cosAngle) * (180 / Math.PI);
    return Math.round(angle * 1000) / 1000;
  }

  _resolveLinearKindStructure(el, profileResult) {
    if (el.stbCategory === 'pile') {
      const profileType = profileResult?.sectionInfo?.stbType;
      if (profileType === 'PILE_RC' || profileType === 'CIRCLE') return 'RC';
      if (profileType === 'PILE_S' || profileType === 'PIPE') return 'S';
      if (profileType === 'PILE_PRODUCT') return 'PC';
    }
    return el.kindStructure || 'S';
  }

  _progress(message) {
    if (this.onProgress) this.onProgress(message);
  }
}
