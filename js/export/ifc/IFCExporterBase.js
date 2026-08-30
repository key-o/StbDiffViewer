/**
 * @fileoverview IFCエクスポーターの基底クラス
 * 共通のIFCエンティティ（プロジェクト階層、座標系、単位系）と
 * プロファイル作成機能を提供
 * @module export/ifc/IFCExporterBase
 */

import { StepWriter, generateIfcGuid } from './StepWriter.js';
import { resolveProfileType } from '../../constants/profileTypeAliases.js';
import { downloadBlob } from '../../utils/downloadHelper.js';
import { eventBus, ExportEvents } from '../../data/events/index.js';
import {
  createSpatialContextEntities,
  createSingleStoreyEntity,
} from './builders/spatialStructureBuilder.js';
import {
  createIShapeProfileEntity,
  createRectangleProfileEntity,
  createHollowRectangleProfileEntity,
  createCircularHollowProfileEntity,
  createCircleProfileEntity,
  createLShapeProfileEntity,
  createUShapeProfileEntity,
  createTShapeProfileEntity,
} from './builders/profileEntityBuilder.js';
import { createWallEntities, createWallOpeningEntities } from './builders/wallEntityBuilder.js';

/**
 * IFCエクスポーターの基底クラス
 * 梁、柱、床、壁など各要素タイプのエクスポーターはこのクラスを継承する
 */
export class IFCExporterBase {
  constructor() {
    this.writer = new StepWriter();
    this._refs = {};
    this._initialized = false;
    // 階データ（STBから取得した階情報）
    this._storiesData = [];
    // 階IDとIFCエンティティIDのマップ
    this._storeyMap = new Map();
    // 各階の要素リスト
    this._storeyElements = new Map();
  }

  /**
   * STB階データを設定
   * @param {Array<{id: string, name: string, height: number}>} stories - 階情報配列（heightはmm）
   */
  setStories(stories) {
    if (stories && Array.isArray(stories) && stories.length > 0) {
      // 高さでソート
      this._storiesData = [...stories].sort((a, b) => a.height - b.height);
    }
  }

  /**
   * 共通エンティティが作成されていることを保証
   * @protected
   */
  _ensureInitialized() {
    if (!this._initialized) {
      this._createCommonEntities();
      this._initialized = true;
    }
  }

  /**
   * 共通のIFCエンティティ（プロジェクト階層、座標系など）を作成
   * @protected
   */
  _createCommonEntities() {
    const w = this.writer;

    // ===== 基本ジオメトリ・単位系・コンテキスト・プロジェクト階層 =====
    Object.assign(this._refs, createSpatialContextEntities(w));

    // ===== 階 =====
    this._createStoreys(w);
  }

  /**
   * 階（IFCBUILDINGSTOREY）を作成
   * @param {StepWriter} w - StepWriterインスタンス
   * @protected
   */
  _createStoreys(w) {
    const storeyIds = [];

    // 階データがある場合は複数階を作成
    if (this._storiesData.length > 0) {
      for (const story of this._storiesData) {
        const storeyId = this._createSingleStorey(w, story.name, story.height);
        this._storeyMap.set(story.id, storeyId);
        this._storeyElements.set(storeyId, []);
        storeyIds.push(`#${storeyId}`);
      }
      // デフォルトの階（最初の階）を設定
      this._refs.storey = this._storeyMap.get(this._storiesData[0].id);
    } else {
      // フォールバック: 階データがない場合は単一の1Fを作成
      const storeyId = this._createSingleStorey(w, '1F', 0.0);
      this._storeyMap.set('default', storeyId);
      this._storeyElements.set(storeyId, []);
      storeyIds.push(`#${storeyId}`);
      this._refs.storey = storeyId;
    }

    // 建物 → 階 関係
    this._refs.relBuildingStorey = w.createEntity('IFCRELAGGREGATES', [
      generateIfcGuid(), // GlobalId
      null, // OwnerHistory
      null, // Name
      null, // Description
      `#${this._refs.building}`, // RelatingObject
      storeyIds, // RelatedObjects
    ]);
  }

  /**
   * 単一の階を作成
   * @param {StepWriter} w - StepWriterインスタンス
   * @param {string} name - 階名
   * @param {number} elevation - 階高さ（mm）
   * @returns {number} 階エンティティID
   * @protected
   */
  _createSingleStorey(w, name, elevation) {
    const { storeyId, storeyPlacement } = createSingleStoreyEntity(w, name, elevation, this._refs);

    // 最初の階の配置をデフォルトとして保持
    if (!this._refs.storeyPlacement) {
      this._refs.storeyPlacement = storeyPlacement;
    }

    return storeyId;
  }

  // ===== プロファイル作成メソッド =====

  /**
   * プロファイルの Position 参照を取得
   * @private
   * @param {boolean} simple - true の場合は Position を null にする
   * @returns {string|null} IFCAXIS2PLACEMENT2D への参照
   */
  _profilePosition(simple) {
    return simple ? null : `#${this._refs.profilePlacement}`;
  }

  /**
   * H形鋼プロファイルを作成
   * @param {Object} params - プロファイルパラメータ
   * @param {Object} [options] - 生成オプション
   * @param {boolean} [options.simple=false] - Position を null にする
   * @returns {number} プロファイルエンティティID
   */
  createIShapeProfile(params, { simple = false } = {}) {
    this._ensureInitialized();
    return createIShapeProfileEntity(this.writer, this._profilePosition(simple), params);
  }

  /**
   * 矩形プロファイルを作成
   * @param {Object} params - プロファイルパラメータ
   * @param {Object} [options] - 生成オプション
   * @param {boolean} [options.simple=false] - Position を null にする
   * @returns {number} プロファイルエンティティID
   */
  createRectangleProfile(params, { simple = false } = {}) {
    this._ensureInitialized();
    return createRectangleProfileEntity(this.writer, this._profilePosition(simple), params);
  }

  /**
   * 角形鋼管（BOX）プロファイルを作成
   * @param {Object} params - プロファイルパラメータ
   * @param {Object} [options] - 生成オプション
   * @param {boolean} [options.simple=false] - Position を null にする
   * @returns {number} プロファイルエンティティID
   */
  createHollowRectangleProfile(params, { simple = false } = {}) {
    this._ensureInitialized();
    return createHollowRectangleProfileEntity(this.writer, this._profilePosition(simple), params);
  }

  /**
   * 円形鋼管（PIPE）プロファイルを作成
   * @param {Object} params - プロファイルパラメータ
   * @param {Object} [options] - 生成オプション
   * @param {boolean} [options.simple=false] - Position を null にする
   * @returns {number} プロファイルエンティティID
   */
  createCircularHollowProfile(params, { simple = false } = {}) {
    this._ensureInitialized();
    return createCircularHollowProfileEntity(this.writer, this._profilePosition(simple), params);
  }

  /**
   * 中実円（丸鋼）プロファイルを作成
   * @param {Object} params - プロファイルパラメータ
   * @param {Object} [options] - 生成オプション
   * @param {boolean} [options.simple=false] - Position を null にする
   * @returns {number} プロファイルエンティティID
   */
  createCircleProfile(params, { simple = false } = {}) {
    this._ensureInitialized();
    return createCircleProfileEntity(this.writer, this._profilePosition(simple), params);
  }

  /**
   * L形鋼プロファイルを作成
   * @param {Object} params - プロファイルパラメータ
   * @param {Object} [options] - 生成オプション
   * @param {boolean} [options.simple=false] - Position を null にする
   * @returns {number} プロファイルエンティティID
   */
  createLShapeProfile(params, { simple = false } = {}) {
    this._ensureInitialized();
    return createLShapeProfileEntity(this.writer, this._profilePosition(simple), params);
  }

  /**
   * U形鋼（C形鋼・チャンネル）プロファイルを作成
   * @param {Object} params - プロファイルパラメータ
   * @param {Object} [options] - 生成オプション
   * @param {boolean} [options.simple=false] - Position を null にする
   * @returns {number} プロファイルエンティティID
   */
  createUShapeProfile(params, { simple = false } = {}) {
    this._ensureInitialized();
    return createUShapeProfileEntity(this.writer, this._profilePosition(simple), params);
  }

  /**
   * T形鋼プロファイルを作成
   * @param {Object} params - プロファイルパラメータ
   * @param {Object} [options] - 生成オプション
   * @param {boolean} [options.simple=false] - Position を null にする
   * @returns {number} プロファイルエンティティID
   */
  createTShapeProfile(params, { simple = false } = {}) {
    this._ensureInitialized();
    return createTShapeProfileEntity(this.writer, this._profilePosition(simple), params);
  }

  /**
   * プロファイルIDを作成（共通ヘルパー）
   * @protected
   * @param {Object} profile - プロファイル情報 {type, params}
   * @param {boolean} [useSimple=false] - Position = null のシンプル版を使用するか
   * @returns {number|null} プロファイルエンティティID（未対応の場合はnull）
   */
  _createProfileId(profile, useSimple = false) {
    const canonical = resolveProfileType(profile.type);
    const p = profile.params || {};
    const opts = { simple: useSimple };

    switch (canonical) {
      case 'H':
        return this.createIShapeProfile(p, opts);

      case 'BOX':
        return this.createHollowRectangleProfile(p, opts);

      case 'PIPE':
        return this.createCircularHollowProfile(p, opts);

      case 'L':
        return this.createLShapeProfile(p, opts);

      case 'C':
        return this.createUShapeProfile(p, opts);

      case 'FB': {
        const fbParams = {
          width: p.width || p.A || 100,
          height: p.thickness || p.t || 9,
        };
        return this.createRectangleProfile(fbParams, opts);
      }

      case 'CIRCLE': {
        const circleParams = { diameter: p.diameter || p.D || (p.radius ? p.radius * 2 : 60) };
        return this.createCircleProfile(circleParams, opts);
      }

      case 'T': {
        const tParams = {
          depth: p.depth || p.overallDepth || p.H || p.A || 200,
          flangeWidth: p.flangeWidth || p.B || 150,
          webThickness: p.webThickness || p.t1 || p.tw || 8,
          flangeThickness: p.flangeThickness || p.t2 || p.tf || 12,
          filletRadius: p.filletRadius || p.r || 0,
        };
        return this.createTShapeProfile(tParams, opts);
      }

      case 'SRC': {
        const srcParams = {
          width: p.width || p.width_X || p.B || 800,
          height: p.height || p.width_Y || p.A || 800,
        };
        return this.createRectangleProfile(srcParams, opts);
      }

      case 'CFT': {
        // CFT（充填鋼管）はコンクリートで充填されているため、
        // IFC上では中実断面（矩形）として表現する
        // 鋼管の板厚情報はプロパティセットで補完可能
        const cftParams = {
          width: p.width || p.outer_width || p.B || 200,
          height: p.height || p.outer_height || p.A || 200,
        };
        return this.createRectangleProfile(cftParams, opts);
      }

      case 'RECTANGLE':
        return this.createRectangleProfile(p, opts);

      default:
        return null;
    }
  }

  /**
   * 押出形状を作成
   * @param {number} profileId - プロファイルエンティティID
   * @param {number} length - 押出長さ (mm)
   * @param {Object} [direction] - 押出方向
   * @returns {number} ExtrudedAreaSolidエンティティID
   */
  createExtrudedSolid(profileId, length, direction = null) {
    const w = this.writer;

    // 押出方向（デフォルトはX方向 = 梁の長手方向）
    const dirRef = direction || this._refs.dirX;

    return w.createEntity('IFCEXTRUDEDAREASOLID', [
      `#${profileId}`, // SweptArea
      `#${this._refs.worldCoordSystem}`, // Position
      `#${dirRef}`, // ExtrudedDirection
      length, // Depth (mm)
    ]);
  }

  /**
   * 要素を階に追加（containedElementsに登録）
   * @protected
   * @param {number} elementId - 要素エンティティID
   * @param {number} [zCoordinate] - 要素のZ座標（mm）。指定された場合、適切な階に割り当てる
   */
  _addToStorey(elementId, zCoordinate = null) {
    // Z座標が指定され、階データがある場合は適切な階を検索
    if (zCoordinate !== null && this._storiesData.length > 0) {
      const storeyId = this._findStoreyForElevation(zCoordinate);
      if (storeyId) {
        if (!this._storeyElements.has(storeyId)) {
          this._storeyElements.set(storeyId, []);
        }
        this._storeyElements.get(storeyId).push(`#${elementId}`);
        return;
      }
    }

    // フォールバック: デフォルトの階に追加
    if (!this._refs.containedElements) {
      this._refs.containedElements = [];
    }
    this._refs.containedElements.push(`#${elementId}`);
  }

  /**
   * Z座標に対応する階を検索
   * @param {number} zCoordinate - Z座標（mm）
   * @returns {number|null} 階エンティティID
   * @protected
   */
  _findStoreyForElevation(zCoordinate) {
    if (this._storiesData.length === 0) {
      return null;
    }

    // 要素のZ座標が属する階を検索
    // 要素は、その階の高さ以上で次の階の高さ未満にある場合にその階に属する
    for (let i = this._storiesData.length - 1; i >= 0; i--) {
      const story = this._storiesData[i];
      if (zCoordinate >= story.height) {
        return this._storeyMap.get(story.id);
      }
    }

    // 最も低い階より下の場合は最初の階に割り当て
    return this._storeyMap.get(this._storiesData[0].id);
  }

  /**
   * 階と要素の包含関係を作成
   * @protected
   */
  _createContainmentRelation() {
    // 各階の包含関係を作成
    for (const [storeyId, elements] of this._storeyElements) {
      if (elements && elements.length > 0) {
        this.writer.createEntity('IFCRELCONTAINEDINSPATIALSTRUCTURE', [
          generateIfcGuid(), // GlobalId
          null, // OwnerHistory
          null, // Name
          null, // Description
          elements, // RelatedElements
          `#${storeyId}`, // RelatingStructure
        ]);
      }
    }

    // デフォルトの要素リスト（互換性のため）
    if (this._refs.containedElements && this._refs.containedElements.length > 0) {
      this.writer.createEntity('IFCRELCONTAINEDINSPATIALSTRUCTURE', [
        generateIfcGuid(), // GlobalId
        null, // OwnerHistory
        null, // Name
        null, // Description
        this._refs.containedElements, // RelatedElements
        `#${this._refs.storey}`, // RelatingStructure
      ]);
    }
  }

  /**
   * IFCファイルを生成
   * @param {Object} options - オプション
   * @param {string} [options.fileName='export.ifc'] - ファイル名
   * @returns {string} IFCファイル内容
   */
  generate(options = {}) {
    this._ensureInitialized();
    this._createContainmentRelation();

    return this.writer.generate({
      fileName: options.fileName || 'export.ifc',
      description: options.description || 'IFC Export',
      ...options,
    });
  }

  /**
   * Blobを生成（ダウンロード用）
   * @param {Object} options - オプション
   * @returns {Blob} IFCファイルのBlob
   */
  generateBlob(options = {}) {
    const content = this.generate(options);
    return new Blob([content], { type: 'application/x-step' });
  }

  /**
   * ファイルをダウンロード
   * @param {Object} options - オプション
   * @param {string} [options.fileName='export.ifc'] - ファイル名
   */
  download(options = {}) {
    const fileName = options.fileName || 'export.ifc';
    eventBus.emit(ExportEvents.STARTED, { type: 'ifc', fileName });
    try {
      const blob = this.generateBlob(options);
      downloadBlob(blob, fileName);
      eventBus.emit(ExportEvents.COMPLETED, { type: 'ifc', fileName });
    } catch (error) {
      eventBus.emit(ExportEvents.ERROR, { type: 'ifc', error });
      throw error;
    }
  }

  /**
   * 壁を追加（共通実装）
   * IFCSTBExporter で使用する壁生成ロジック
   * @param {Object} wallData - 壁データ
   * @param {string} wallData.name - 壁名
   * @param {Object} wallData.startPoint - 始点 {x, y, z} (mm)
   * @param {Object} wallData.endPoint - 終点 {x, y, z} (mm)
   * @param {number} wallData.height - 高さ (mm)
   * @param {number} wallData.thickness - 厚さ (mm)
   * @param {string} [wallData.predefinedType='STANDARD'] - 壁タイプ
   * @param {Array<Object>} [wallData.openings] - 開口情報配列
   * @returns {number|null} 壁エンティティID
   */
  addWall(wallData) {
    this._ensureInitialized();

    const wall = createWallEntities(this.writer, wallData, this._refs.bodyContext);
    if (wall === null) {
      return null;
    }

    this._addToStorey(wall.wallId, wall.baseZ);

    // 開口を追加
    if (wall.openings && wall.openings.length > 0) {
      this._addOpeningsToWall(wall.wallId, wall.openings, {
        wallLength: wall.wallLength,
        thickness: wall.thickness,
        wallLocalPlacement: wall.wallLocalPlacement,
      });
    }

    return wall.wallId;
  }

  /**
   * 壁に開口を追加（共通実装）
   * @param {number} wallId - 壁エンティティID
   * @param {Array<Object>} openings - 開口情報配列
   * @param {Object} wallContext - 壁のコンテキスト情報
   */
  _addOpeningsToWall(wallId, openings, wallContext) {
    createWallOpeningEntities(this.writer, wallId, openings, wallContext, this._refs.bodyContext);
  }
}

// Re-export generateIfcGuid for convenience
export { generateIfcGuid } from './StepWriter.js';
