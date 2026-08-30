/**
 * @fileoverview テーパー（ハンチ）付き梁のIFCエンティティ生成
 * マルチセクション形状をIFCFACETEDBREPで表現する
 * IFCBeamExporter から分離した処理
 * @module export/ifc/builders/taperedBeamEntityBuilder
 */

import { generateIfcGuid } from '../StepWriter.js';
import { calculateBeamBasis } from '../../../data/geometry/vectorMath.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('export:ifc:taperedBeamEntityBuilder');

/**
 * テーパー付き梁のIFCエンティティを作成
 * @param {Object} w - StepWriterインスタンス
 * @param {Object} beamData - 梁データ
 * @param {string} beamData.name - 梁名
 * @param {Object} beamData.startPoint - 始点座標 {x, y, z} (mm)
 * @param {Object} beamData.endPoint - 終点座標 {x, y, z} (mm)
 * @param {Array<Object>} beamData.sections - 断面情報配列
 * @param {number} beamData.sections[].pos - 断面位置 (0.0〜1.0)
 * @param {Array<{x: number, y: number}>} beamData.sections[].vertices - 断面頂点（ローカル座標）
 * @param {number} [beamData.rotation=0] - 断面の回転角度（度）
 * @param {Object} context - 生成コンテキスト
 * @param {number} context.bodyContext - Body表現コンテキストのエンティティID
 * @param {Function} context.createProfileId - 補助プロファイル生成関数
 * @returns {{beamId: number, beamZ: number}|null} 梁エンティティIDと階判定用Z座標
 */
export function createTaperedBeamEntities(w, beamData, { bodyContext, createProfileId }) {
  const { name = 'TaperedBeam', startPoint, endPoint, sections, rotation = 0 } = beamData;

  // 必須パラメータのチェック
  if (!startPoint || !endPoint || !sections || sections.length < 2) {
    log.warn(
      `[IFC Export] テーパー梁 "${name}" をスキップ: 必須パラメータ（startPoint, endPoint, sections>=2）が不足しています`,
    );
    return null;
  }

  const vertexCount = sections[0].vertices?.length;
  if (!vertexCount || vertexCount < 3) {
    log.warn(`[IFC Export] テーパー梁 "${name}" をスキップ: 断面の頂点が不足しています`);
    return null;
  }

  for (const section of sections) {
    if (!section.vertices || section.vertices.length !== vertexCount) {
      log.warn(`[IFC Export] テーパー梁 "${name}" をスキップ: 断面の頂点数が一致しません`);
      return null;
    }
  }

  // 梁の長さと方向を計算
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const dz = endPoint.z - startPoint.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (length < 1e-6) {
    log.warn(`[IFC Export] テーパー梁 "${name}" をスキップ: 長さが0です`);
    return null;
  }

  // 方向ベクトル（梁軸=Z軸方向）
  const dirX = dx / length;
  const dirY = dy / length;
  const dirZ = dz / length;

  // ローカル座標系の基底ベクトルを計算（vectorMath共通関数を使用）
  // calculateBeamBasis は水平梁・傾斜梁・垂直要素いずれにも正しい基底を返す
  // - 水平梁: yAxis = {0,0,1}（真上向き）
  // - 傾斜梁: yAxis は梁軸に垂直かつ鉛直面内の上向き成分
  // - 垂直要素: globalX基準のフォールバック
  const dir = { x: dirX, y: dirY, z: dirZ };
  const basis = calculateBeamBasis(dir);
  let localX = basis.xAxis;
  let localY = basis.yAxis;

  // 回転を適用（梁軸周りのX/Y軸回転）
  if (Math.abs(rotation) > 1e-6) {
    const rotRad = (rotation * Math.PI) / 180;
    const cosR = Math.cos(rotRad);
    const sinR = Math.sin(rotRad);

    const newX = {
      x: localX.x * cosR + localY.x * sinR,
      y: localX.y * cosR + localY.y * sinR,
      z: localX.z * cosR + localY.z * sinR,
    };
    const newY = {
      x: -localX.x * sinR + localY.x * cosR,
      y: -localX.y * sinR + localY.y * cosR,
      z: -localX.z * sinR + localY.z * cosR,
    };
    localX = newX;
    localY = newY;
  }

  // 断面をposでソート
  const sortedSections = [...sections].sort((a, b) => a.pos - b.pos);

  // 各断面のローカル3D頂点を計算
  // IFCLOCALPLACEMENT で始点・軸方向を与えるため、BRep 頂点はローカル座標で保持する。
  const sectionVertices3D = [];
  for (const section of sortedSections) {
    const zPos = section.pos * length;
    const vertices3D = [];

    for (const v of section.vertices) {
      vertices3D.push({ x: v.x, y: v.y, z: zPos });
    }

    sectionVertices3D.push(vertices3D);
  }

  // IFCCARTESIANPOINTを作成
  const pointIds = [];
  for (const sectionVerts of sectionVertices3D) {
    const sectionPointIds = [];
    for (const v of sectionVerts) {
      const pointId = w.createEntity('IFCCARTESIANPOINT', [[v.x, v.y, v.z]]);
      sectionPointIds.push(pointId);
    }
    pointIds.push(sectionPointIds);
  }

  // IFCFACEを作成
  const faceIds = [];

  // 側面を作成（隣接する断面間）
  for (let s = 0; s < sectionVertices3D.length - 1; s++) {
    const currSection = pointIds[s];
    const nextSection = pointIds[s + 1];

    for (let i = 0; i < vertexCount; i++) {
      const i1 = i;
      const i2 = (i + 1) % vertexCount;

      // 四角形面を2つの三角形に分割、または四角形として
      // IFCでは四角形面が使えるのでそのまま使用
      const loop = w.createEntity('IFCPOLYLOOP', [
        [
          `#${currSection[i1]}`,
          `#${currSection[i2]}`,
          `#${nextSection[i2]}`,
          `#${nextSection[i1]}`,
        ],
      ]);
      const bound = w.createEntity('IFCFACEOUTERBOUND', [`#${loop}`, '.T.']);
      const face = w.createEntity('IFCFACE', [[`#${bound}`]]);
      faceIds.push(face);
    }
  }

  // 始端面（最初の断面）
  {
    const firstSection = pointIds[0];
    // 面の向きを反転（外向き）
    const reversedPoints = [...firstSection].reverse();
    const loop = w.createEntity('IFCPOLYLOOP', [reversedPoints.map((id) => `#${id}`)]);
    const bound = w.createEntity('IFCFACEOUTERBOUND', [`#${loop}`, '.T.']);
    const face = w.createEntity('IFCFACE', [[`#${bound}`]]);
    faceIds.push(face);
  }

  // 終端面（最後の断面）
  {
    const lastSection = pointIds[pointIds.length - 1];
    const loop = w.createEntity('IFCPOLYLOOP', [lastSection.map((id) => `#${id}`)]);
    const bound = w.createEntity('IFCFACEOUTERBOUND', [`#${loop}`, '.T.']);
    const face = w.createEntity('IFCFACE', [[`#${bound}`]]);
    faceIds.push(face);
  }

  // IFCCLOSEDSHELLを作成
  const shellId = w.createEntity('IFCCLOSEDSHELL', [faceIds.map((id) => `#${id}`)]);

  // IFCFACETEDBREPを作成
  const brepId = w.createEntity('IFCFACETEDBREP', [`#${shellId}`]);

  // 梁の配置：始点と方向ベクトルを使用（ifc-to-stbがノード位置を正しく復元できるよう）
  const beamAxisDir = w.createEntity('IFCDIRECTION', [[dirX, dirY, dirZ]]);
  const beamRefDir = w.createEntity('IFCDIRECTION', [[localX.x, localX.y, localX.z]]);
  const beamOriginPt = w.createEntity('IFCCARTESIANPOINT', [
    [startPoint.x, startPoint.y, startPoint.z],
  ]);
  const beamPlacement3D = w.createEntity('IFCAXIS2PLACEMENT3D', [
    `#${beamOriginPt}`,
    `#${beamAxisDir}`,
    `#${beamRefDir}`,
  ]);
  const beamLocalPlacement = w.createEntity('IFCLOCALPLACEMENT', [null, `#${beamPlacement3D}`]);

  // Brep形状表現（視覚表現）
  const brepShapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
    `#${bodyContext}`,
    'Body',
    'Brep',
    [`#${brepId}`],
  ]);

  // SweptSolid補助表現（ProfileAnalyzerが梁長さを抽出できるよう IFCEXTRUDEDAREASOLID を追加）
  const repIds = [`#${brepShapeRep}`];
  const firstProfile = sections[0]?.profile;
  const auxProfileId = firstProfile ? createProfileId(firstProfile) : null;
  if (auxProfileId !== null) {
    const extrudeOrigin = w.createEntity('IFCCARTESIANPOINT', [[0.0, 0.0, 0.0]]);
    const extrudeDir = w.createEntity('IFCDIRECTION', [[0.0, 0.0, 1.0]]);
    const extrudePlacement = w.createEntity('IFCAXIS2PLACEMENT3D', [
      `#${extrudeOrigin}`,
      null,
      null,
    ]);
    const auxSolidId = w.createEntity('IFCEXTRUDEDAREASOLID', [
      `#${auxProfileId}`,
      `#${extrudePlacement}`,
      `#${extrudeDir}`,
      length,
    ]);
    const auxShapeRep = w.createEntity('IFCSHAPEREPRESENTATION', [
      `#${bodyContext}`,
      'Body',
      'SweptSolid',
      [`#${auxSolidId}`],
    ]);
    repIds.push(`#${auxShapeRep}`);
  }

  // 製品定義形状
  const productShape = w.createEntity('IFCPRODUCTDEFINITIONSHAPE', [null, null, repIds]);

  // 梁エンティティ
  const beamId = w.createEntity('IFCBEAM', [
    generateIfcGuid(),
    null,
    name,
    null,
    null,
    `#${beamLocalPlacement}`,
    `#${productShape}`,
    null,
    '.BEAM.',
  ]);

  // 階に所属
  const beamZ = Math.min(startPoint.z, endPoint.z);

  return { beamId, beamZ };
}
