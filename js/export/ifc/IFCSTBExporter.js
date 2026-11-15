/**
 * @fileoverview STB構造要素の統合IFCエクスポーター
 * 梁、柱、ブレース、床、壁を一つのIFCファイルにエクスポート
 */

import { IFCBeamExporter } from './IFCBeamExporter.js';
import { encodeSurfaceMetadata } from '../../common-ifc/pipeline/StbSurfaceMetadata.js';
import { generateIfcGuid } from './IFCExporterBase.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('export:ifc:IFCSTBExporter');

/**
 * STB構造要素の統合エクスポーター
 * IFCBeamExporterを拡張して床・壁機能を追加
 */
export class IFCSTBExporter extends IFCBeamExporter {
  constructor() {
    super();
  }

  /**
   * 床を追加
   * @param {Object} slabData - 床データ
   * @param {string} slabData.name - 床名
   * @param {Array<{x: number, y: number, z: number}>} slabData.vertices - 頂点座標配列 (mm)
   * @param {number} slabData.thickness - 床厚 (mm)
   * @param {string} [slabData.predefinedType='FLOOR'] - 床タイプ
   * @returns {number|null} 床エンティティID
   */
  addSlab(slabData) {
    this._ensureInitialized();
    const w = this.writer;
    const { name = 'Slab', vertices, thickness = 150, predefinedType = 'FLOOR' } = slabData;

    if (!vertices || vertices.length < 3) {
      log.warn(`[IFC Export] 床 "${name}" をスキップ: 頂点が3点未満`);
      return null;
    }

    if (thickness <= 0) {
      log.warn(`[IFC Export] 床 "${name}" をスキップ: 厚さが不正`);
      return null;
    }

    // 頂点の中心を計算
    const center = { x: 0, y: 0, z: 0 };
    for (const v of vertices) {
      center.x += v.x;
      center.y += v.y;
      center.z += v.z;
    }
    center.x /= vertices.length;
    center.y /= vertices.length;
    center.z /= vertices.length;

    const topZ = center.z;

    // ポリライン頂点を作成
    const polylinePoints = [];
    for (const v of vertices) {
      const pointId = w.createEntity('IFCCARTESIANPOINT', [[v.x - center.x, v.y - center.y]]);
      polylinePoints.push(`#${pointId}`);
    }
    // 閉じる
    const firstPointId = w.createEntity('IFCCARTESIANPOINT', [
      [vertices[0].x - center.x, vertices[0].y - center.y],
    ]);
    polylinePoints.push(`#${firstPointId}`);

    const polylineId = w.createEntity('IFCPOLYLINE', [polylinePoints]);

    const profileId = w.createEntity('IFCARBITRARYCLOSEDPROFILEDEF', [
      '.AREA.',
      'SlabProfile',
      `#${polylineId}`,
    ]);

    const extrudeDirId = w.createEntity('IFCDIRECTION', [[0.0, 0.0, -1.0]]);

    const solidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
      `#${profileId}`,
      null,
      `#${extrudeDirId}`,
      thickness,
    ]);

    const slabOrigin = w.createEntity('IFCCARTESIANPOINT', [[center.x, center.y, topZ]]);

    const slabPlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [`#${slabOrigin}`, null, null]);

    const slabLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [null, `#${slabPlacement3D}`]);

    const shapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
      `#${this._refs.bodyContext}`,
      'Body',
      'SweptSolid',
      [`#${solidId}`],
    ]);

    const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [
      null,
      null,
      [`#${shapeRep}`],
    ]);

    const slabId = w.createEntity('IFCSLAB', [
      generateIfcGuid(),
      null,
      name,
      encodeSurfaceMetadata('slab', slabData),
      null,
      `#${slabLocalPlacement}`,
      `#${productShape}`,
      null,
      `.${predefinedType}.`,
    ]);

    // 床を階に所属させる（Z座標で適切な階を決定）
    const slabZ = Math.min(...vertices.map((v) => v.z));
    this._addToStorey(slabId, slabZ);
    return slabId;
  }

  // addWall() と _addOpeningsToWall() は IFCExporterBase に定義（共通実装）

  /**
   * 基礎柱を追加
   * @param {Object} foundationColumnData - 基礎柱データ
   * @param {string} foundationColumnData.name - 基礎柱名
   * @param {Object} foundationColumnData.bottomPoint - 底部座標 {x, y, z} (mm)
   * @param {Object} foundationColumnData.topPoint - 頂部座標 {x, y, z} (mm)
   * @param {Object} foundationColumnData.profile - プロファイル情報
   * @param {string} foundationColumnData.profile.type - プロファイルタイプ ('H', 'BOX', 'PIPE', 'RECTANGLE')
   * @param {Object} foundationColumnData.profile.params - プロファイルパラメータ
   * @param {number} [foundationColumnData.rotation=0] - 断面の回転角度（度）
   * @param {boolean} [foundationColumnData.isReferenceDirection=true] - 基準方向フラグ
   * @returns {number|null} 基礎柱エンティティID（未対応の場合はnull）
   */
  /**
   * 基礎柱の1セグメント（FDまたはWR）の押出形状を作成
   * @private
   * @param {Object} profile - 断面プロファイル
   * @param {number} segmentLength - セグメント長さ (mm)
   * @param {number} segmentBottomZ - セグメント底部Z座標（ローカル、配置点からの相対）
   * @returns {number|null} IFCEXTRUDEDAREASOLID のエンティティID
   */
  _createFoundationColumnSegmentSolid(profile, segmentLength, segmentBottomZ) {
    const w = this.writer;

    const profileId = this._createProfileId(profile, true);
    if (profileId === null) return null;

    const extrudeDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);
    const extrudeOrigin = w.createEntity('IFCCARTESIANPOINT', [[0.0, 0.0, segmentBottomZ]]);
    const extrudePosition = w.createEntity('IFCAXIS2PLACEMENT3D', [
      `#${extrudeOrigin}`,
      null,
      null,
    ]);

    return w.createEntity('IFCEXTRUDEDAREASOLID', [
      `#${profileId}`,
      `#${extrudePosition}`,
      `#${extrudeDir}`,
      segmentLength,
    ]);
  }

  /**
   * 基礎柱を追加（FD/WR二重断面対応）
   * 基礎柱は1節点（topPoint）から下方向に伸びる。
   * FD（基礎部）とWR（立上り部）で異なる断面を持つことができる。
   * @param {Object} data - 基礎柱データ
   * @param {string} data.name - 名前
   * @param {Object} data.topPoint - 上端座標 {x, y, z} (mm) = id_nodeの位置
   * @param {Object} data.bottomPoint - 下端座標 {x, y, z} (mm)
   * @param {number} data.lengthFD - 基礎部の長さ (mm)
   * @param {number} data.lengthWR - 立上り部の長さ (mm)
   * @param {Object|null} data.profileFD - 基礎部の断面プロファイル
   * @param {Object|null} data.profileWR - 立上り部の断面プロファイル
   * @param {number} [data.rotation=0] - 回転角度（度）
   * @returns {number|null} IFCCOLUMNエンティティID
   */
  addFoundationColumn(data) {
    this._ensureInitialized();
    const w = this.writer;
    const {
      name = 'FoundationColumn',
      topPoint,
      bottomPoint,
      lengthFD = 0,
      lengthWR = 0,
      profileFD,
      profileWR,
      sourceFoundationPart = null,
      rotation = 0,
    } = data;

    if (!topPoint || !bottomPoint) {
      log.warn(`[IFC Export] 基礎柱 "${name}" をスキップ: 座標が不足しています`);
      return null;
    }

    const totalLength = lengthFD + lengthWR;
    if (totalLength < 1e-6) {
      log.warn(`[IFC Export] 基礎柱 "${name}" をスキップ: 長さが0です`);
      return null;
    }

    // 各セグメントの押出形状を作成
    // 配置原点 = topPoint とし、ローカルZ軸負方向に伸びる
    // ローカル座標系: topPoint が原点、下端が -totalLength
    const solidIds = [];

    // WR部（立上り部）: topPoint直下 → FD部の上端
    // ローカルZ: -lengthWR ～ 0
    if (profileWR && lengthWR > 0) {
      const solidWR = this._createFoundationColumnSegmentSolid(profileWR, lengthWR, -lengthWR);
      if (solidWR) solidIds.push(solidWR);
    }

    // FD部（基礎部）: WRの下 → 底部
    // ローカルZ: -(lengthWR + lengthFD) ～ -lengthWR
    if (profileFD && lengthFD > 0) {
      const solidFD = this._createFoundationColumnSegmentSolid(
        profileFD,
        lengthFD,
        -(lengthWR + lengthFD),
      );
      if (solidFD) solidIds.push(solidFD);
    }

    if (solidIds.length === 0) {
      log.warn(`[IFC Export] 基礎柱 "${name}" をスキップ: 形状を生成できませんでした`);
      return null;
    }

    // 配置点（topPoint）
    const originId = w.createEntity('IFCCARTESIANPOINT', [[topPoint.x, topPoint.y, topPoint.z]]);

    // 回転
    const rotationRad = (rotation * Math.PI) / 180;
    const cosVal = Math.cos(rotationRad);
    const sinVal = Math.sin(rotationRad);
    const axisDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);
    const refDir = w.createEntity('IFCDIRECTION', [[cosVal, sinVal, 0.0]]);

    const placement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
      `#${originId}`,
      `#${axisDir}`,
      `#${refDir}`,
    ]);

    const localPlacement = w.createEntity('IFCLOCALPLACEMENT', [null, `#${placement3D}`]);

    // 形状表現（複数solidの場合もまとめて1つのShapeRepresentationに）
    const shapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
      `#${this._refs.bodyContext}`,
      'Body',
      'SweptSolid',
      solidIds.map((id) => `#${id}`),
    ]);

    const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [
      null,
      null,
      [`#${shapeRep}`],
    ]);

    // 基礎柱エンティティ（IFCCOLUMNとして出力、ObjectTypeで区別）
    const foundationColumnId = w.createEntity('IFCCOLUMN', [
      generateIfcGuid(),
      null, // OwnerHistory
      name,
      sourceFoundationPart === 'FD' || sourceFoundationPart === 'WR'
        ? `STBFOUNDATION_META:${JSON.stringify({ part: sourceFoundationPart })}`
        : 'FoundationColumn', // Description: only single-section forms have unambiguous provenance
      'FoundationColumn', // ObjectType
      `#${localPlacement}`,
      `#${productShape}`,
      null, // Tag
      null, // PredefinedType
    ]);

    this._addToStorey(foundationColumnId, bottomPoint.z);

    return foundationColumnId;
  }

  /**
   * 基礎（フーチング）を追加
   * @param {Object} footingData - 基礎データ
   * @param {string} footingData.name - 基礎名
   * @param {Object} footingData.position - 配置位置 {x, y, z} (mm) - 基礎の上端中心
   * @param {number} footingData.width_X - X方向の幅 (mm)
   * @param {number} footingData.width_Y - Y方向の幅 (mm)
   * @param {number} footingData.depth - 基礎の深さ（厚さ） (mm)
   * @param {number} [footingData.rotation=0] - 回転角度（度）
   * @param {string} [footingData.predefinedType='PAD_FOOTING'] - 基礎タイプ
   * @returns {number|null} 基礎エンティティID
   */
  addFooting(footingData) {
    this._ensureInitialized();
    const w = this.writer;
    const {
      name = 'Footing',
      position,
      width_X = 1500,
      width_Y = 1500,
      depth = 500,
      rotation = 0,
      predefinedType = 'PAD_FOOTING',
      sourceFootingMeta = null,
    } = footingData;

    // 必須パラメータのチェック
    if (!position) {
      log.warn(`[IFC Export] 基礎 "${name}" をスキップ: 位置が不足しています`);
      return null;
    }

    if (width_X <= 0 || width_Y <= 0 || depth <= 0) {
      log.warn(`[IFC Export] 基礎 "${name}" をスキップ: 寸法が不正です`);
      return null;
    }

    // 矩形プロファイル（X方向 × Y方向）
    const profileId = w.createEntity('IFCRECTANGLEPROFILEDEF', [
      '.AREA.',
      'FootingProfile',
      null,
      width_X, // XDim
      width_Y, // YDim
    ]);

    // 押出方向: Z軸（下向き = -Z）
    const extrudeDirId = w.createEntity('IFCDIRECTION', [[0.0, 0.0, -1.0]]);

    // 押出形状
    const solidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
      `#${profileId}`,
      null, // Position: デフォルト
      `#${extrudeDirId}`,
      depth, // Depth: 基礎の深さ
    ]);

    // 基礎の配置原点（上端中心）
    const footingOrigin = w.createEntity('IFCCARTESIANPOINT', [
      [position.x, position.y, position.z],
    ]);

    // 回転角度を適用
    let refDirX = 1.0;
    let refDirY = 0.0;
    if (Math.abs(rotation) > 1e-6) {
      const rotationRad = (rotation * Math.PI) / 180;
      refDirX = Math.cos(rotationRad);
      refDirY = Math.sin(rotationRad);
    }
    const footingRefDir = w.createEntity('IFCDIRECTION', [[refDirX, refDirY, 0.0]]);

    const footingPlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
      `#${footingOrigin}`,
      null, // Axis: デフォルト（Z方向）
      `#${footingRefDir}`, // RefDirection: 回転を反映
    ]);

    const footingLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [
      null,
      `#${footingPlacement3D}`,
    ]);

    const shapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
      `#${this._refs.bodyContext}`,
      'Body',
      'SweptSolid',
      [`#${solidId}`],
    ]);

    const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [
      null,
      null,
      [`#${shapeRep}`],
    ]);

    // 基礎エンティティ（IFCFOOTING）
    const footingId = w.createEntity('IFCFOOTING', [
      generateIfcGuid(),
      null, // OwnerHistory
      name,
      sourceFootingMeta ? `STBFOOTING_META:${JSON.stringify(sourceFootingMeta)}` : null,
      null, // ObjectType
      `#${footingLocalPlacement}`,
      `#${productShape}`,
      null, // Tag
      `.${predefinedType}.`, // PredefinedType
    ]);

    // 基礎を階に所属させる（位置Z座標で適切な階を決定）
    this._addToStorey(footingId, position.z - depth);

    return footingId;
  }

  /**
   * 杭を追加
   * @param {Object} pileData - 杭データ
   * @param {string} pileData.name - 杭名
   * @param {Object} pileData.topPoint - 杭頭座標 {x, y, z} (mm)
   * @param {Object} pileData.bottomPoint - 杭先端座標 {x, y, z} (mm)
   * @param {number} pileData.diameter - 杭径 (mm)
   * @param {number} [pileData.wallThickness] - 管厚 (mm) - 鋼管杭の場合のみ
   * @param {string} [pileData.predefinedType='BORED'] - 杭タイプ (BORED, DRIVEN, JETGROUTING, COHESION, FRICTION, SUPPORT, USERDEFINED, NOTDEFINED)
   * @param {string} [pileData.constructionType='CAST_IN_PLACE'] - 施工タイプ (CAST_IN_PLACE, COMPOSITE, PRECAST_CONCRETE, PREFAB_STEEL, USERDEFINED, NOTDEFINED)
   * @returns {number|null} 杭エンティティID
   */
  addPile(pileData) {
    this._ensureInitialized();
    const w = this.writer;
    const {
      name = 'Pile',
      topPoint,
      bottomPoint,
      diameter = 600,
      wallThickness = null,
      kindStructure = 'S',
      predefinedType = 'BORED',
      constructionType = 'CAST_IN_PLACE',
      stbSectionMeta = null,
      sourcePileMeta = null,
    } = pileData;

    // 必須パラメータのチェック
    if (!topPoint || !bottomPoint) {
      log.warn(`[IFC Export] 杭 "${name}" をスキップ: 杭頭・杭先端座標が不足しています`);
      return null;
    }

    if (diameter <= 0) {
      log.warn(`[IFC Export] 杭 "${name}" をスキップ: 杭径が不正です`);
      return null;
    }

    // 杭の長さを計算
    const dx = bottomPoint.x - topPoint.x;
    const dy = bottomPoint.y - topPoint.y;
    const dz = bottomPoint.z - topPoint.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (length < 1e-6) {
      log.warn(`[IFC Export] 杭 "${name}" をスキップ: 長さが0です`);
      return null;
    }

    // 杭の方向ベクトル（正規化）
    const dirX = dx / length;
    const dirY = dy / length;
    const dirZ = dz / length;

    // プロファイルを作成（円形または円形中空）
    let profileId;
    if (wallThickness && wallThickness > 0) {
      // 鋼管杭（円形中空）
      profileId = w.createEntity('IFCCIRCLEHOLLOWPROFILEDEF', [
        '.AREA.',
        'PileProfile',
        null,
        diameter / 2, // Radius
        wallThickness, // WallThickness
      ]);
    } else {
      // 場所打ち杭等（中実円）
      profileId = w.createEntity('IFCCIRCLEPROFILEDEF', [
        '.AREA.',
        'PileProfile',
        null,
        diameter / 2, // Radius
      ]);
    }

    // 杭の配置点（杭頭）
    const pileOrigin = w.createEntity('IFCCARTESIANPOINT', [[topPoint.x, topPoint.y, topPoint.z]]);

    // 杭の軸方向（杭頭から杭先端へ）
    const pileAxisDir = w.createEntity('IFCDIRECTION', [[dirX, dirY, dirZ]]);

    // 参照方向の計算
    let refDirX, refDirY, refDirZ;
    if (Math.abs(dirZ) < 0.99) {
      // 非垂直: グローバルZ方向との外積
      const crossX = dirY * 1 - dirZ * 0;
      const crossY = dirZ * 0 - dirX * 1;
      const crossZ = dirX * 0 - dirY * 0;
      const crossLen = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
      if (crossLen > 1e-6) {
        refDirX = crossX / crossLen;
        refDirY = crossY / crossLen;
        refDirZ = crossZ / crossLen;
      } else {
        refDirX = 1;
        refDirY = 0;
        refDirZ = 0;
      }
    } else {
      // ほぼ垂直: グローバルX方向を参照
      refDirX = 1;
      refDirY = 0;
      refDirZ = 0;
    }
    const pileRefDir = w.createEntity('IFCDIRECTION', [[refDirX, refDirY, refDirZ]]);

    // 配置座標系
    const pilePlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
      `#${pileOrigin}`,
      `#${pileAxisDir}`,
      `#${pileRefDir}`,
    ]);

    // ローカル配置
    const pileLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [null, `#${pilePlacement3D}`]);

    // 押出方向（ローカルZ方向 = 杭軸方向）
    const extrudeDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);

    // 押出形状
    const solidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
      `#${profileId}`,
      null, // Position: デフォルト
      `#${extrudeDir}`,
      length, // Depth: 杭長さ
    ]);

    // 形状表現
    const shapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
      `#${this._refs.bodyContext}`,
      'Body',
      'SweptSolid',
      [`#${solidId}`],
    ]);

    // 製品定義形状
    const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [
      null,
      null,
      [`#${shapeRep}`],
    ]);

    // 杭エンティティ（IFCPILE）
    const pileDescription = this._buildPileDescription(stbSectionMeta, sourcePileMeta);

    const pileId = w.createEntity('IFCPILE', [
      generateIfcGuid(),
      null, // OwnerHistory
      name,
      pileDescription,
      kindStructure, // ObjectType: kind_structure (RC/S)
      `#${pileLocalPlacement}`,
      `#${productShape}`,
      null, // Tag
      `.${predefinedType}.`, // PredefinedType
      `.${constructionType}.`, // ConstructionType
    ]);

    // 杭を階に所属させる（杭頭Z座標で適切な階を決定）
    this._addToStorey(pileId, topPoint.z);

    return pileId;
  }

  _buildPileDescription(stbSectionMeta, sourcePileMeta) {
    if (!stbSectionMeta && !sourcePileMeta) return null;

    return `STBPILE_META:${JSON.stringify({
      section: stbSectionMeta || null,
      element: sourcePileMeta || null,
    })}`;
  }

  /**
   * IFCファイルを生成
   * @param {Object} options - オプション
   * @returns {string} IFCファイル内容
   */
  generate(options = {}) {
    return super.generate({
      fileName: options.fileName || 'stb_export.ifc',
      description: options.description || 'STB Structure IFC Export',
      ...options,
    });
  }
}

export { generateIfcGuid };
