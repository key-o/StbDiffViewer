/**
 * @fileoverview 壁形状生成モジュール
 *
 * BaseElementGeneratorを継承した統一アーキテクチャ:
 * - StbNodeIdOrder の順序を保持した壁外形
 * - 各ノードへの StbWallOffset 対応
 * - 第1基準点を原点とする ST-Bridge 壁部材座標系
 * - 厚さ（t）による押し出し形状
 * - StbOpen の position_X / position_Y / rotate 対応
 * - STB形式とJSON形式の両対応
 *
 * 作成: 2025-12
 */

import * as THREE from 'three';
import { colorManager } from '../../rendering/colorManager.js';
import { BaseElementGenerator } from '../core/BaseElementGenerator.js';

/**
 * 壁形状生成クラス
 */
export class WallGenerator extends BaseElementGenerator {
  /**
   * ジェネレーター設定
   */
  static getConfig() {
    return {
      elementName: 'Wall',
      loggerName: 'viewer:geometry:wall',
      defaultElementType: 'Wall',
    };
  }

  /**
   * 壁要素からメッシュを作成
   * @param {Array} wallElements - 壁要素配列
   * @param {Map<string, THREE.Vector3>} nodes - ノードマップ
   * @param {Map<string, Object>} wallSections - 壁断面マップ
   * @param {Map<string, Object>} steelSections - 鋼材形状マップ（未使用だがインターフェース統一のため）
   * @param {string} elementType - 要素タイプ（デフォルト: "Wall"）
   * @param {boolean} isJsonInput - JSON入力かどうか
   * @param {Map<string, Object>} openingElements - 開口情報マップ（オプション）
   * @returns {Array<THREE.Mesh>} 生成されたメッシュ配列
   */
  static createWallMeshes(
    wallElements,
    nodes,
    wallSections,
    steelSections,
    elementType = 'Wall',
    isJsonInput = false,
    openingElements = null,
  ) {
    const config = this.getConfig();
    const log = this._getLogger();

    if (!wallElements || wallElements.length === 0) {
      log.debug(`No ${config.elementName} elements provided.`);
      return [];
    }

    // STB 2.1.0形式では開口側に id_member があるため、壁IDの逆引き表を先に作る。
    const openingsByWallId = this._buildOpeningIndex(openingElements);

    const meshes = [];
    let processed = 0;
    let skipped = 0;

    for (const element of wallElements) {
      const context = {
        nodes,
        sections: wallSections,
        steelSections,
        elementType,
        isJsonInput,
        log,
        openingElements,
        openingsByWallId,
      };

      try {
        const mesh = this._createSingleMesh(element, context);
        if (mesh) {
          meshes.push(mesh);
          processed++;
        } else {
          skipped++;
        }
      } catch (error) {
        log.warn(`Error creating ${config.elementName} ${element.id}:`, error.message);
        skipped++;
      }
    }

    log.info(`${config.elementName}: Created ${processed}, Skipped ${skipped}`);
    return meshes;
  }

  /**
   * 開口要素の壁ID逆引きインデックスを構築
   * @param {Map<string, Object>|null} openingElements - 開口情報マップ
   * @returns {Map<string, Array<[string, Object]>>} 壁ID → [openId, opening][] のマップ
   */
  static _buildOpeningIndex(openingElements) {
    const index = new Map();
    if (!openingElements) return index;

    for (const [openId, opening] of openingElements) {
      if (opening.kind_member === 'WALL' && opening.id_member != null) {
        const wallId = String(opening.id_member);
        if (!index.has(wallId)) {
          index.set(wallId, []);
        }
        index.get(wallId).push([openId, opening]);
      }
    }
    return index;
  }

  /**
   * 単一壁メッシュを作成（BaseElementGeneratorの抽象メソッドを実装）
   *
   * ST-Bridge 2.0.2 の定義に従い、壁の表示座標は次の順で求める。
   * 1. StbNodeIdOrder の各節点に StbWallOffset を適用して周辺基準点を得る。
   * 2. オフセット後の第1基準点を壁ローカル原点とする。
   * 3. 第1基準点→第2基準点を壁ローカルX方向、全体Z上向きを壁ローカルY方向とする。
   * 4. 壁外形は4点をバウンディングボックス化せず、順序付き基準点そのものを投影して作る。
   * 5. StbOpen.position_X/Y は同じ第1基準点原点から直接配置する。
   *
   * @param {Object} wall - 壁要素
   * @param {Object} context - コンテキスト
   * @returns {THREE.Mesh|null} メッシュまたはnull
   */
  static _createSingleMesh(wall, context) {
    const { nodes, sections, elementType, isJsonInput, log, openingElements, openingsByWallId } =
      context;

    const nodeIds = wall.node_ids;
    if (!nodeIds || nodeIds.length < 3) {
      log.warn(
        `Skipping wall ${wall.id}: Insufficient nodes (need at least 3, got ${nodeIds?.length || 0})`,
      );
      return null;
    }

    // 各節点に StbWallOffset を適用した「周辺基準点」を StbNodeIdOrder の順で保持する。
    const referencePoints = [];
    const offsets = wall.offsets || new Map();

    for (const nodeId of nodeIds) {
      const node = nodes.get(nodeId);
      if (!node) {
        log.warn(`Skipping wall ${wall.id}: Node ${nodeId} not found`);
        return null;
      }

      const offset = offsets.get ? offsets.get(nodeId) : offsets[nodeId];
      const offsetX = offset?.offset_X || 0;
      const offsetY = offset?.offset_Y || 0;
      const offsetZ = offset?.offset_Z || 0;

      referencePoints.push(
        new THREE.Vector3(node.x + offsetX, node.y + offsetY, node.z + offsetZ),
      );
    }

    // 断面データの取得（厚さ）
    let thickness = 200;
    if (sections) {
      const rawId = wall.id_section;
      const parsedId = parseInt(rawId, 10);
      const sectionId = isNaN(parsedId) ? rawId : parsedId;
      const sectionData = sections.get(sectionId);
      if (sectionData) {
        thickness =
          sectionData.t ||
          sectionData.thickness ||
          sectionData.dimensions?.t ||
          sectionData.dimensions?.thickness ||
          200;
      }
    }

    const frame = this._buildWallReferenceFrame(referencePoints, log, wall.id);
    if (!frame) {
      return null;
    }

    const { origin, xAxis, extrusionNormal, profilePoints, maxNormalDeviation } = frame;
    const bounds = this._getProfileBounds(profilePoints);
    const wallWidth = bounds.maxX - bounds.minX;
    const wallHeight = bounds.maxY - bounds.minY;

    if (wallWidth < 1 || wallHeight < 1) {
      log.warn(
        `Skipping wall ${wall.id}: Invalid dimensions (width=${wallWidth}, height=${wallHeight})`,
      );
      return null;
    }

    const openings = this._getOpeningsForWall(wall, openingElements, log, openingsByWallId);
    const geometry = this._createWallGeometry(profilePoints, thickness, openings, log, wall.id);

    if (!geometry || !this._validateGeometry(geometry, wall, context)) {
      return null;
    }

    const mesh = new THREE.Mesh(
      geometry,
      colorManager.getMaterial('diff', { comparisonState: 'matched' }),
    );

    // ジオメトリのローカル原点そのものを「オフセット後の第1基準点」とする。
    // これにより position_X/Y を中心座標やbbox左下へ変換する必要がなくなる。
    mesh.position.copy(origin);
    const angle = Math.atan2(xAxis.y, xAxis.x);
    mesh.rotation.z = angle;

    // 表示・選択用の中心値は、外形のローカルbbox中心をグローバルへ戻して保持する。
    const centerLocalX = (bounds.minX + bounds.maxX) / 2;
    const centerLocalY = (bounds.minY + bounds.maxY) / 2;
    const center = new THREE.Vector3(
      origin.x + xAxis.x * centerLocalX,
      origin.y + xAxis.y * centerLocalX,
      origin.z + centerLocalY,
    );

    mesh.userData = {
      id: wall.id,
      elementId: wall.id,
      name: wall.name || `Wall_${wall.id}`,
      elementType,
      stbElementId: wall.id,
      isSTB: !isJsonInput,
      sectionId: wall.id_section,
      wallData: {
        nodeIds,
        thickness,
        width: wallWidth,
        height: wallHeight,
        center: { x: center.x, y: center.y, z: center.z },
        direction: { x: xAxis.x, y: xAxis.y, z: xAxis.z },
        normal: {
          x: extrusionNormal.x,
          y: extrusionNormal.y,
          z: extrusionNormal.z,
        },
        firstReferencePoint: { x: origin.x, y: origin.y, z: origin.z },
        // 新しい生成経路では Shape 原点 = 第1基準点なので常に (0, 0)。
        openingReference: { x: 0, y: 0 },
        referenceProfile: profilePoints.map((p) => ({ x: p.x, y: p.y })),
        maxNormalDeviation,
        kind_structure: wall.kind_structure,
        kind_layout: wall.kind_layout,
        kind_wall: wall.kind_wall,
        openIds: wall.open_ids,
        openings,
      },
    };

    log.debug(
      `Wall ${wall.id}: firstReference=(${origin.x.toFixed(0)}, ${origin.y.toFixed(0)}, ${origin.z.toFixed(0)}), ` +
        `width=${wallWidth.toFixed(0)}, height=${wallHeight.toFixed(0)}, ` +
        `angle=${((angle * 180) / Math.PI).toFixed(1)}deg`,
    );

    return mesh;
  }

  /**
   * オフセット後の周辺基準点から、ST-Bridge壁部材座標系と2D外形を構築する。
   *
   * Shape X = 第1基準点→第2基準点の水平投影方向
   * Shape Y = 全体Z上向き
   * Shape原点 = オフセット後の第1基準点
   *
   * @param {THREE.Vector3[]} referencePoints - StbNodeIdOrder順のオフセット後基準点
   * @param {Object|null} log - ロガー
   * @param {string|number|null} wallId - 壁ID（ログ用）
   * @returns {{origin:THREE.Vector3,xAxis:THREE.Vector3,extrusionNormal:THREE.Vector3,profilePoints:THREE.Vector2[],maxNormalDeviation:number}|null}
   */
  static _buildWallReferenceFrame(referencePoints, log = null, wallId = null) {
    if (!referencePoints || referencePoints.length < 3) {
      return null;
    }

    const origin = referencePoints[0].clone();
    const second = referencePoints[1];
    const xAxis = new THREE.Vector3(second.x - origin.x, second.y - origin.y, 0);

    // 仕様上は第1→第2点がX方向。退化データだけは第1点から最も離れた点をフォールバックにする。
    if (xAxis.lengthSq() <= 1e-8) {
      let maxDistSq = 0;
      let fallback = null;
      for (let i = 2; i < referencePoints.length; i++) {
        const dx = referencePoints[i].x - origin.x;
        const dy = referencePoints[i].y - origin.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > maxDistSq) {
          maxDistSq = distSq;
          fallback = referencePoints[i];
        }
      }

      if (!fallback || maxDistSq <= 1e-8) {
        log?.warn?.(`Skipping wall ${wallId ?? ''}: first and second reference points are degenerate`);
        return null;
      }

      xAxis.set(fallback.x - origin.x, fallback.y - origin.y, 0);
      log?.warn?.(
        `Wall ${wallId ?? ''}: first-to-second reference direction is degenerate; using fallback direction`,
      );
    }
    xAxis.normalize();

    // メッシュのローカル+Y方向。壁厚は±方向へ対称に出すため、押出方向の符号自体は形状に影響しない。
    const extrusionNormal = new THREE.Vector3(-xAxis.y, xAxis.x, 0);

    const profilePoints = [];
    let maxNormalDeviation = 0;

    for (const point of referencePoints) {
      const dx = point.x - origin.x;
      const dy = point.y - origin.y;
      const dz = point.z - origin.z;

      const localX = dx * xAxis.x + dy * xAxis.y;
      const localY = dz;
      const normalOffset = dx * extrusionNormal.x + dy * extrusionNormal.y;

      profilePoints.push(new THREE.Vector2(localX, localY));
      maxNormalDeviation = Math.max(maxNormalDeviation, Math.abs(normalOffset));
    }

    // ExtrudeGeometryは平面輪郭を前提とする。通常の壁では0になる。
    // 点ごとの面外offsetが混在する場合も第1基準点の壁面へ投影し、仕様原点は維持する。
    if (maxNormalDeviation > 1e-6) {
      log?.warn?.(
        `Wall ${wallId ?? ''}: reference points are not coplanar in wall-normal direction ` +
          `(max deviation=${maxNormalDeviation.toFixed(3)}mm); projecting to first-reference wall plane`,
      );
    }

    return {
      origin,
      xAxis,
      extrusionNormal,
      profilePoints,
      maxNormalDeviation,
    };
  }

  /**
   * 2D壁輪郭のbboxを取得する。bboxは寸法・中心メタデータにだけ用い、壁外形生成には用いない。
   * @param {THREE.Vector2[]} profilePoints - 壁ローカル輪郭
   * @returns {{minX:number,maxX:number,minY:number,maxY:number}}
   */
  static _getProfileBounds(profilePoints) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const point of profilePoints) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }

    return { minX, maxX, minY, maxY };
  }

  /**
   * 壁に関連付けられた開口情報を取得
   * @param {Object} wall - 壁要素
   * @param {Map<string, Object>} openingElements - 開口情報マップ
   * @param {Object} log - ロガー
   * @param {Map<string, Array>} [openingsByWallId] - 事前構築済み壁ID逆引きインデックス
   * @returns {Array<Object>} 開口情報配列
   */
  static _getOpeningsForWall(wall, openingElements, log, openingsByWallId = null) {
    const openings = [];

    if (!openingElements) {
      return openings;
    }

    const getOpeningPosition = (opening) => ({
      positionX: opening.position_X ?? opening.offset_X ?? 0,
      positionY: opening.position_Y ?? opening.offset_Y ?? 0,
    });

    const addOpening = (openId, opening) => {
      const pos = getOpeningPosition(opening);
      openings.push({
        id: opening.id,
        name: opening.name,
        positionX: pos.positionX,
        positionY: pos.positionY,
        width: opening.length_X,
        height: opening.length_Y,
        rotate: opening.rotate,
      });
      log.debug(
        `Wall ${wall.id}: Found opening ${openId} (${opening.length_X}x${opening.length_Y} at ${pos.positionX},${pos.positionY})`,
      );
    };

    if (wall.open_ids && wall.open_ids.length > 0) {
      for (const openId of wall.open_ids) {
        const opening = openingElements.get(openId);
        if (opening) {
          addOpening(openId, opening);
        } else {
          log.warn(`Wall ${wall.id}: Opening ${openId} not found in opening elements`);
        }
      }
    } else if (openingsByWallId) {
      const wallOpenings = openingsByWallId.get(String(wall.id));
      if (wallOpenings) {
        for (const [openId, opening] of wallOpenings) {
          addOpening(openId, opening);
        }
      }
    } else {
      for (const [openId, opening] of openingElements) {
        if (opening.kind_member === 'WALL' && String(opening.id_member) === String(wall.id)) {
          addOpening(openId, opening);
        }
      }
    }

    return openings;
  }

  /**
   * StbOpenを第1基準点原点の壁ローカル輪郭へ変換する。
   * positionX/positionY は開口始点、length_X/length_Y はそのローカルX/Y寸法、
   * rotate は壁ローカルX軸からの角度（度）として扱う。
   *
   * @param {Object} opening - 正規化済み開口情報
   * @returns {THREE.Vector2[]} 開口4隅（始点から反時計回り）
   */
  static _calculateOpeningProfilePoints(opening) {
    const x = Number(opening.positionX) || 0;
    const y = Number(opening.positionY) || 0;
    const width = Number(opening.width) || 0;
    const height = Number(opening.height) || 0;
    const angle = THREE.MathUtils.degToRad(Number(opening.rotate) || 0);

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ux = new THREE.Vector2(cos, sin);
    const uy = new THREE.Vector2(-sin, cos);

    const p0 = new THREE.Vector2(x, y);
    const p1 = p0.clone().addScaledVector(ux, width);
    const p2 = p1.clone().addScaledVector(uy, height);
    const p3 = p0.clone().addScaledVector(uy, height);

    return [p0, p1, p2, p3];
  }

  /**
   * ST-Bridgeの第1基準点を壁ローカルShapeへ変換する旧互換ヘルパー。
   * 新しい通常経路では Shape 原点そのものが第1基準点なので (0,0) を使用する。
   * @param {THREE.Vector3} firstReferencePoint - 第1基準点
   * @param {THREE.Vector3} center - 旧中心原点
   * @param {THREE.Vector3} wallDirection - 壁X軸
   * @returns {{x:number,y:number}}
   */
  static _calculateOpeningReference(firstReferencePoint, center, wallDirection) {
    const dx = firstReferencePoint.x - center.x;
    const dy = firstReferencePoint.y - center.y;

    return {
      x: dx * wallDirection.x + dy * wallDirection.y,
      y: firstReferencePoint.z - center.z,
    };
  }

  /**
   * 軸平行開口の旧互換境界計算ヘルパー。
   * @param {Object} opening - 開口情報
   * @param {{x:number,y:number}} openingReference - Shape上の第1基準点
   * @returns {{left:number,bottom:number,right:number,top:number}}
   */
  static _calculateOpeningBounds(opening, openingReference) {
    const left = openingReference.x + opening.positionX;
    const bottom = openingReference.y + opening.positionY;

    return {
      left,
      bottom,
      right: left + opening.width,
      top: bottom + opening.height,
    };
  }

  /**
   * 壁外形と開口を同一の「第1基準点原点」Shape座標で生成する。
   * @param {THREE.Vector2[]} profilePoints - StbWallOffset適用後の周辺基準点輪郭
   * @param {number} thickness - 壁厚
   * @param {Array<Object>} openings - 開口情報
   * @param {Object} log - ロガー
   * @param {string|number|null} wallId - 壁ID
   * @returns {THREE.BufferGeometry|null}
   */
  static _createWallGeometry(profilePoints, thickness, openings, log, wallId = null) {
    if (!profilePoints || profilePoints.length < 3) {
      return null;
    }

    const wallShape = new THREE.Shape();
    wallShape.moveTo(profilePoints[0].x, profilePoints[0].y);
    for (let i = 1; i < profilePoints.length; i++) {
      wallShape.lineTo(profilePoints[i].x, profilePoints[i].y);
    }
    wallShape.lineTo(profilePoints[0].x, profilePoints[0].y);

    const profileBounds = this._getProfileBounds(profilePoints);

    for (const opening of openings) {
      if (!(opening.width > 0) || !(opening.height > 0)) {
        log.warn(`Wall ${wallId ?? ''}: Opening ${opening.id} has invalid size, skipping`);
        continue;
      }

      const points = this._calculateOpeningProfilePoints(opening);
      const openingBounds = this._getProfileBounds(points);

      // STBデータは本来壁内に開口が収まる。ここでは形状を勝手にclampせず、
      // 仕様値をそのまま描画し、bboxを越える場合だけ診断ログを残す。
      if (
        openingBounds.minX < profileBounds.minX - 1e-6 ||
        openingBounds.maxX > profileBounds.maxX + 1e-6 ||
        openingBounds.minY < profileBounds.minY - 1e-6 ||
        openingBounds.maxY > profileBounds.maxY + 1e-6
      ) {
        log.warn(
          `Wall ${wallId ?? ''}: Opening ${opening.id} extends beyond wall profile bounds; ` +
            'rendering ST-Bridge coordinates without clamping',
        );
      }

      const hole = new THREE.Path();
      hole.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        hole.lineTo(points[i].x, points[i].y);
      }
      hole.lineTo(points[0].x, points[0].y);
      wallShape.holes.push(hole);
    }

    const geometry = new THREE.ExtrudeGeometry(wallShape, {
      depth: thickness,
      bevelEnabled: false,
    });

    // Shape X→壁ローカルX、Shape Y→全体Zとなるよう +90°回転する。
    // 押出方向はローカル-Yへ向くため、壁厚中央がY=0になるよう +t/2 移動する。
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, thickness / 2, 0);

    return geometry;
  }
}

if (typeof window !== 'undefined') {
  window.WallGenerator = WallGenerator;
}
