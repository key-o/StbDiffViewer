/**
 * @fileoverview 線形要素（梁・柱・ブレース）のIFCエクスポーター
 * IFCExporterBaseを継承し、梁・柱・ブレースの出力機能を提供
 * @module export/ifc/IFCBeamExporter
 */

import { IFCExporterBase } from './IFCExporterBase.js';
import { createLogger } from '../../utils/logger.js';
import { STB_TAG_NAMES } from '../../constants/elementTypes.js';
import { validateLinearElementData } from './builders/linearElementValidation.js';
import { createBeamEntities } from './builders/beamEntityBuilder.js';
import { createTaperedBeamEntities } from './builders/taperedBeamEntityBuilder.js';
import { createColumnEntities, createPostEntities } from './builders/columnEntityBuilder.js';
import { createBraceEntities } from './builders/braceEntityBuilder.js';

const log = createLogger('IFCBeamExporter');

/**
 * 線形要素をIFCファイルとしてエクスポートするクラス
 * 梁（Beam）、柱（Column）、ブレース（Brace）に対応
 */
export class IFCBeamExporter extends IFCExporterBase {
  constructor() {
    super();
  }

  /**
   * 梁を追加
   * @param {Object} beamData - 梁データ
   * @param {string} beamData.name - 梁名
   * @param {Object} beamData.startPoint - 始点座標 {x, y, z} (mm)
   * @param {Object} beamData.endPoint - 終点座標 {x, y, z} (mm)
   * @param {Object} beamData.profile - プロファイル情報
   * @param {string} beamData.profile.type - プロファイルタイプ ('H', 'BOX', 'PIPE', 'RECTANGLE')
   * @param {Object} beamData.profile.params - プロファイルパラメータ
   * @param {number} [beamData.rotation=0] - 断面の回転角度（度）、軸周りの回転
   * @param {string} [beamData.placementMode='center'] - 配置モード ('center' | 'top-aligned')
   * @param {number} [beamData.sectionHeight=0] - 断面高さ（mm）天端基準配置用
   * @returns {number|null} 梁エンティティID（未対応の場合はnull）
   * @throws {TypeError} If beamData is not a valid object
   */
  addBeam(beamData) {
    this._ensureInitialized();

    // 共通バリデーション
    const validation = this._validateLinearElementData(beamData, '梁', {
      point1: 'startPoint',
      point2: 'endPoint',
    });

    if (!validation.isValid) {
      log.error(`[IFC Export] 梁をスキップ: ${validation.error}`);
      return null;
    }

    const {
      name = 'Beam',
      placementMode = 'center',
      sectionHeight = 0,
      isSRC = false,
      steelProfile = null,
      kindStructure = 'S',
      stbType = STB_TAG_NAMES.GIRDER,
    } = beamData;

    // Validate name
    if (typeof name !== 'string') {
      log.warn(`[IFC Export] beamData.name must be a string, using default "Beam"`);
    }

    // Validate placementMode
    if (placementMode !== 'center' && placementMode !== 'top-aligned') {
      log.warn(
        `[IFC Export] 梁 "${name}": invalid placementMode "${placementMode}", using "center"`,
      );
    }

    // Validate sectionHeight
    if (typeof sectionHeight !== 'number' || !isFinite(sectionHeight) || sectionHeight < 0) {
      log.warn(
        `[IFC Export] 梁 "${name}": sectionHeight must be a non-negative finite number, using 0`,
      );
    }

    const { point1: startPoint, point2: endPoint, profile, length, rotation } = validation;

    // プロファイルを作成
    const profileId = this._createProfileId(profile, false);
    if (profileId === null) {
      log.warn(
        `[IFC Export] 梁 "${name}" をスキップ: 未対応のプロファイルタイプ "${profile.type}"`,
      );
      return null;
    }

    const { beamId, beamZ } = createBeamEntities(this.writer, {
      name,
      startPoint,
      endPoint,
      length,
      rotation,
      placementMode,
      sectionHeight,
      kindStructure,
      stbType,
      profileId,
      bodyContext: this._refs.bodyContext,
      // SRC造の鉄骨プロファイルはコンクリート押出の後に生成する（エンティティ順を維持）
      createSteelProfileId:
        isSRC && steelProfile ? () => this._createProfileId(steelProfile, false) : null,
    });

    // 梁を階に所属させる（天端基準配置調整後のZ座標で適切な階を決定）
    this._addToStorey(beamId, beamZ);

    return beamId;
  }

  /**
   * テーパー（ハンチ）付き梁を追加
   * マルチセクション形状をIFCFACETEDBREPで表現
   * @param {Object} beamData - 梁データ
   * @param {string} beamData.name - 梁名
   * @param {Object} beamData.startPoint - 始点座標 {x, y, z} (mm)
   * @param {Object} beamData.endPoint - 終点座標 {x, y, z} (mm)
   * @param {Array<Object>} beamData.sections - 断面情報配列
   * @param {number} beamData.sections[].pos - 断面位置 (0.0〜1.0)
   * @param {Array<{x: number, y: number}>} beamData.sections[].vertices - 断面頂点（ローカル座標）
   * @param {number} [beamData.rotation=0] - 断面の回転角度（度）
   * @param {string} [beamData.placementMode='center'] - 配置モード ('center' | 'top-aligned')
   * @returns {number|null} 梁エンティティID（未対応の場合はnull）
   */
  addTaperedBeam(beamData) {
    this._ensureInitialized();

    const result = createTaperedBeamEntities(this.writer, beamData, {
      bodyContext: this._refs.bodyContext,
      createProfileId: (profile) => this._createProfileId(profile, false),
    });

    if (result === null) {
      return null;
    }

    // 階に所属
    this._addToStorey(result.beamId, result.beamZ);

    return result.beamId;
  }

  /**
   * 柱を追加
   * @param {Object} columnData - 柱データ
   * @param {string} columnData.name - 柱名
   * @param {Object} columnData.bottomPoint - 底部座標 {x, y, z} (mm)
   * @param {Object} columnData.topPoint - 頂部座標 {x, y, z} (mm)
   * @param {Object} columnData.profile - プロファイル情報
   * @param {string} columnData.profile.type - プロファイルタイプ ('H', 'BOX', 'PIPE', 'RECTANGLE')
   * @param {Object} columnData.profile.params - プロファイルパラメータ
   * @param {number} [columnData.rotation=0] - 断面の回転角度（度）
   * @param {boolean} [columnData.isReferenceDirection=true] - 基準方向フラグ（falseの場合90度回転追加）
   * @returns {number|null} 柱エンティティID（未対応の場合はnull）
   * @throws {TypeError} If columnData is not a valid object
   */
  addColumn(columnData) {
    this._ensureInitialized();

    // 共通バリデーション
    const validation = this._validateLinearElementData(columnData, '柱', {
      point1: 'bottomPoint',
      point2: 'topPoint',
    });

    if (!validation.isValid) {
      log.error(`[IFC Export] 柱をスキップ: ${validation.error}`);
      return null;
    }

    const {
      name = 'Column',
      isReferenceDirection = true,
      isSRC = false,
      steelProfile = null,
      kindStructure = 'S',
    } = columnData;

    // Validate isReferenceDirection
    if (typeof isReferenceDirection !== 'boolean') {
      log.warn(`[IFC Export] 柱 "${name}": isReferenceDirection must be a boolean, using true`);
    }

    const { point1: bottomPoint, profile, length, rotation } = validation;

    // プロファイルを作成（Position は null）
    const profileId = this._createProfileId(profile, true);
    if (profileId === null) {
      log.warn(
        `[IFC Export] 柱 "${name}" をスキップ: 未対応のプロファイルタイプ "${profile.type}"`,
      );
      return null;
    }

    const columnId = createColumnEntities(this.writer, {
      name,
      bottomPoint,
      length,
      rotation,
      isReferenceDirection,
      kindStructure,
      profileId,
      bodyContext: this._refs.bodyContext,
      // SRC造の鉄骨プロファイルはコンクリート押出の後に生成する（エンティティ順を維持）
      createSteelProfileId:
        isSRC && steelProfile ? () => this._createProfileId(steelProfile, true) : null,
    });

    // 柱を階に所属させる（底部Z座標で適切な階を決定）
    this._addToStorey(columnId, bottomPoint.z);

    return columnId;
  }

  /**
   * 間柱を追加
   * @param {Object} postData - 間柱データ
   * @param {string} postData.name - 間柱名
   * @param {Object} postData.bottomPoint - 底部座標 {x, y, z} (mm)
   * @param {Object} postData.topPoint - 頂部座標 {x, y, z} (mm)
   * @param {Object} postData.profile - プロファイル情報
   * @param {string} postData.profile.type - プロファイルタイプ ('H', 'BOX', 'PIPE', 'RECTANGLE')
   * @param {Object} postData.profile.params - プロファイルパラメータ
   * @param {number} [postData.rotation=0] - 断面の回転角度（度）
   * @param {boolean} [postData.isReferenceDirection=true] - 基準方向フラグ（falseの場合90度回転追加）
   * @returns {number|null} 間柱エンティティID（未対応の場合はnull）
   */
  addPost(postData) {
    this._ensureInitialized();

    // 共通バリデーション
    const validation = this._validateLinearElementData(postData, '間柱', {
      point1: 'bottomPoint',
      point2: 'topPoint',
    });

    if (!validation.isValid) {
      log.error(`[IFC Export] 間柱をスキップ: ${validation.error}`);
      return null;
    }

    const { name = 'Post', isReferenceDirection = true, kindStructure = 'S' } = postData;

    const { point1: bottomPoint, profile, length, rotation } = validation;

    // プロファイルを作成（Position は null）
    const profileId = this._createProfileId(profile, true);
    if (profileId === null) {
      log.warn(
        `[IFC Export] 間柱 "${name}" をスキップ: 未対応のプロファイルタイプ "${profile.type}"`,
      );
      return null;
    }

    const postId = createPostEntities(this.writer, {
      name,
      bottomPoint,
      length,
      rotation,
      isReferenceDirection,
      kindStructure,
      profileId,
      bodyContext: this._refs.bodyContext,
    });

    // 間柱を階に所属させる（底部Z座標で適切な階を決定）
    this._addToStorey(postId, bottomPoint.z);

    return postId;
  }

  /**
   * ブレースを追加
   * @param {Object} braceData - ブレースデータ
   * @param {string} braceData.name - ブレース名
   * @param {Object} braceData.startPoint - 始点座標 {x, y, z} (mm)
   * @param {Object} braceData.endPoint - 終点座標 {x, y, z} (mm)
   * @param {Object} braceData.profile - プロファイル情報
   * @param {number} [braceData.rotation=0] - 断面の回転角度（度）、軸周りの回転
   * @returns {number|null} ブレースエンティティID（未対応の場合はnull）
   * @throws {TypeError} If braceData is not a valid object
   */
  addBrace(braceData) {
    this._ensureInitialized();

    // 共通バリデーション
    const validation = this._validateLinearElementData(braceData, 'ブレース', {
      point1: 'startPoint',
      point2: 'endPoint',
    });

    if (!validation.isValid) {
      log.error(`[IFC Export] ブレースをスキップ: ${validation.error}`);
      return null;
    }

    const { name = 'Brace', kindStructure = 'S' } = braceData;

    const { point1: startPoint, point2: endPoint, profile, length, rotation } = validation;

    // プロファイルを作成（シンプル版、Position = null）
    const profileId = this._createProfileId(profile, true);
    if (profileId === null) {
      log.warn(
        `[IFC Export] ブレース "${name}" をスキップ: 未対応のプロファイルタイプ "${profile.type}"`,
      );
      return null;
    }

    const braceId = createBraceEntities(this.writer, {
      name,
      startPoint,
      endPoint,
      length,
      rotation,
      kindStructure,
      profileId,
      bodyContext: this._refs.bodyContext,
    });

    // 階に所属させる（Z座標で適切な階を決定）
    const braceZ = Math.min(startPoint.z, endPoint.z);
    this._addToStorey(braceId, braceZ);

    return braceId;
  }

  /**
   * 線形要素データのバリデーション（梁・柱・ブレース共通）
   * @protected
   * @param {Object} data - バリデーション対象オブジェクト
   * @param {string} elementType - 要素型の日本語名（例: '梁', '柱', 'ブレース'）
   * @param {Object} pointFieldNames - ポイントフィールド名 {point1, point2}
   * @returns {Object} バリデーション結果
   * @see module:export/ifc/builders/linearElementValidation
   */
  _validateLinearElementData(data, elementType, pointFieldNames) {
    return validateLinearElementData(data, elementType, pointFieldNames);
  }

  /**
   * IFCファイルを生成（梁用のデフォルトオプション）
   * @param {Object} options - オプション
   * @param {string} [options.fileName='beam_export.ifc'] - ファイル名
   * @returns {string} IFCファイル内容
   */
  generate(options = {}) {
    return super.generate({
      fileName: options.fileName || 'beam_export.ifc',
      description: options.description || 'Single Beam IFC Export',
      ...options,
    });
  }
}

/**
 * 簡易エクスポート関数
 * @param {Object} beamData - 梁データ
 * @returns {string} IFCファイル内容
 * @throws {TypeError} If beamData is not a valid object
 */
export function exportSingleBeamToIFC(beamData) {
  // Validate beamData
  if (!beamData || typeof beamData !== 'object' || Array.isArray(beamData)) {
    const error = new TypeError('beamData must be a non-null object');
    log.error('Validation failed:', error);
    throw error;
  }

  const exporter = new IFCBeamExporter();
  exporter.addBeam(beamData);
  return exporter.generate();
}
