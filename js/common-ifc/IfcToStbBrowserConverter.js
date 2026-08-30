/**
 * @fileoverview ブラウザ用 IFC → STB 変換オーケストレーター
 *
 * Node.js版 IfcToStbConverter のブラウザ対応版。
 * ArrayBuffer を受け取り、7段階パイプラインでSTB XMLを生成する。
 *
 * @module IfcToStbBrowserConverter
 */

import * as WebIFC from 'web-ifc';
import { IfcBrowserModelReader } from './IfcBrowserModelReader.js';
import { SpatialStructureExtractor } from './pipeline/SpatialStructureExtractor.js';
import { NodeReconstructor } from './pipeline/NodeReconstructor.js';
import { ElementClassifier } from './pipeline/ElementClassifier.js';
import { ProfileAnalyzer } from './pipeline/ProfileAnalyzer.js';
import { HaunchDetector } from './pipeline/HaunchDetector.js';
import { generateStbXml } from './pipeline/StbXmlGenerator.js';
import { resolvePlacement, extractPosition, transformPoint } from './util/CoordinateHelper.js';
import {
  buildSimpleElementRecord,
  buildWallElementRecord,
  buildWallOpeningMap,
  extractWallDimensions,
  buildPileAttrs,
  buildPileProfileResult,
  countElementsByType,
  parsePileMetadata,
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
      if (processed) {
        processedElements.push(processed);
      }
    }

    const nodes = nodeReconstructor.getNodes();
    const sections = profileAnalyzer.getSections();

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
        elementToStory,
        placementCache,
        elementId,
        wallOpeningMap,
      );
    }
    if (el.stbCategory === 'slab') {
      return this._processSlabElement(
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
    const origin = extractPosition(worldMatrix);
    const pileMeta = el.stbCategory === 'pile' ? parsePileMetadata(el.description) : null;
    const analyzedProfile = profileAnalyzer.analyzeElement(
      el.representationRef,
      pileMeta ? { skipSectionRegistration: true } : {},
    );
    const profileResult =
      el.stbCategory === 'pile' && pileMeta
        ? buildPileProfileResult(profileAnalyzer, pileMeta, analyzedProfile)
        : analyzedProfile;
    const length = profileResult?.length || analyzedProfile?.length || 0;

    const dirX = worldMatrix[8];
    const dirY = worldMatrix[9];
    const dirZ = worldMatrix[10];

    const startPt = {
      x: origin.x * unitFactor,
      y: origin.y * unitFactor,
      z: origin.z * unitFactor,
    };
    const endPt = {
      x: (origin.x + dirX * (length / unitFactor)) * unitFactor,
      y: (origin.y + dirY * (length / unitFactor)) * unitFactor,
      z: (origin.z + dirZ * (length / unitFactor)) * unitFactor,
    };

    const nodeStart = nodeReconstructor.addOrGet(startPt.x, startPt.y, startPt.z);
    const nodeEnd = nodeReconstructor.addOrGet(endPt.x, endPt.y, endPt.z);

    let haunch = null;
    if (haunchDetector && el.stbCategory === 'beam') {
      const dirNorm = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
      const axisDir = dirNorm > 0 ? [dirX / dirNorm, dirY / dirNorm, dirZ / dirNorm] : [0, 0, 1];
      const originArr = [origin.x, origin.y, origin.z];
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

    const rotate = this._extractRotation(worldMatrix, el.stbCategory);
    const kindStructure = this._resolveLinearKindStructure(el, profileResult);

    return {
      id: String(elementId),
      stbType: el.stbType,
      stbCategory: el.stbCategory,
      name: el.name || `${el.stbType}-${elementId}`,
      nodeStart,
      nodeEnd,
      sectionId: profileResult?.sectionId || null,
      storyId: elementToStory.get(el.expressID) || null,
      kindStructure,
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

    const nodeId = nodeReconstructor.addOrGet(
      origin.x * unitFactor,
      origin.y * unitFactor,
      origin.z * unitFactor,
    );

    return {
      id: String(elementId),
      stbType: el.stbType,
      stbCategory: el.stbCategory,
      name: el.name || `${el.stbType}-${elementId}`,
      nodeIds: [nodeId],
      sectionId: profileResult?.sectionId || null,
      storyId: elementToStory.get(el.expressID) || null,
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
    const profileResult = profileAnalyzer.analyzeElement(el.representationRef);

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
    elementToStory,
    placementCache,
    elementId,
    wallOpeningMap,
  ) {
    if (!el.placementRef) return null;

    const worldMatrix = resolvePlacement(api, modelID, el.placementRef, placementCache);
    const origin = extractPosition(worldMatrix);

    const dimensions = extractWallDimensions(api, modelID, unitFactor, el.representationRef);
    return buildWallElementRecord({
      el,
      elementId,
      origin,
      worldMatrix,
      unitFactor,
      dimensions,
      nodeReconstructor,
      storyId: elementToStory.get(el.expressID) || null,
      wallOpenings: wallOpeningMap.get(el.expressID) || [],
    });
  }

  /**
   * スラブ要素の処理: プロファイル多角形から複数ノードを復元
   */
  _processSlabElement(
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
    const profileResult = profileAnalyzer.analyzeElement(el.representationRef);

    const vertices = this._extractSlabVertices(
      api,
      modelID,
      unitFactor,
      el.representationRef,
      worldMatrix,
    );
    if (!vertices || vertices.length < 3) return null;

    const nodeIds = vertices.map((v) => nodeReconstructor.addOrGet(v.x, v.y, v.z));

    return {
      id: String(elementId),
      stbType: el.stbType,
      stbCategory: el.stbCategory,
      name: el.name || `${el.stbType}-${elementId}`,
      nodeIds,
      sectionId: profileResult?.sectionId || null,
      storyId: elementToStory.get(el.expressID) || null,
      kindStructure: el.kindStructure || 'RC',
    };
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

      for (const itemRef of rep.Items) {
        const itemId = itemRef?.value ?? itemRef;
        const item = api.GetLine(modelID, itemId);
        if (!item || item.type !== WebIFC.IFCEXTRUDEDAREASOLID) continue;

        const sweptAreaRef = item.SweptArea?.value ?? item.SweptArea;
        if (!sweptAreaRef) continue;
        const profile = api.GetLine(modelID, sweptAreaRef);
        if (!profile) continue;

        let localPoints = [];

        if (profile.type === WebIFC.IFCARBITRARYCLOSEDPROFILEDEF) {
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
          localPoints = [
            { x: -hx, y: -hy, z: 0 },
            { x: hx, y: -hy, z: 0 },
            { x: hx, y: hy, z: 0 },
            { x: -hx, y: hy, z: 0 },
          ];
        }

        if (localPoints.length >= 3) {
          return localPoints.map((p) => {
            const w = transformPoint(p, worldMatrix);
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
   * ワールド変換行列から断面回転角度（度）を復元
   * column-major 4x4行列: X軸=[m0,m1,m2], Y軸=[m4,m5,m6], Z軸=[m8,m9,m10]
   * @param {number[]} m - 16要素 column-major 行列
   * @param {string} category - 'column' | 'beam' | 'brace'
   * @returns {number} 回転角度（度）
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
