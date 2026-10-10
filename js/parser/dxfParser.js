/**
 * @fileoverview DXFファイルパーサーモジュール
 *
 * DXFファイルを読み込み、Three.jsで描画可能な形式に変換します。
 * dxf-parserライブラリを使用してDXFファイルをパースします。
 */

import { createLogger } from '../utils/logger.js';
import DxfParser from 'dxf-parser';

const log = createLogger('DXFParser');

/**
 * DXFファイルをパースして構造化データを返す
 * @param {string} dxfContent - DXFファイルの内容（テキスト）
 * @param {{entityHandlers?: Function[]}} [options] - 参照読込等から渡す追加entity handler
 * @returns {Object} パースされたDXFデータ
 */
export function parseDxf(dxfContent, { entityHandlers = [] } = {}) {
  try {
    const parser = new DxfParser();
    for (const handler of entityHandlers) parser.registerEntityHandler(handler);
    const dxf = parser.parseSync(dxfContent);

    if (!dxf) {
      throw new Error('DXFファイルのパースに失敗しました');
    }

    log.info('DXFパース完了:', {
      entities: dxf.entities?.length || 0,
      layers: Object.keys(dxf.tables?.layer?.layers || {}).length,
      blocks: Object.keys(dxf.blocks || {}).length,
    });

    return dxf;
  } catch (error) {
    log.error('DXFパースエラー:', error);
    throw error;
  }
}

/**
 * DXFファイルからエンティティを抽出
 * @param {Object} dxf - パースされたDXFデータ
 * @returns {Object} エンティティタイプ別に分類されたデータ
 */
export function extractEntities(dxf) {
  const entities = {
    lines: [],
    polylines: [],
    circles: [],
    arcs: [],
    lwpolylines: [],
    points: [],
    texts: [],
    inserts: [], // ブロック参照
    dimensions: [],
    others: [],
  };

  if (!dxf.entities) {
    return entities;
  }

  // メインエンティティを処理
  for (const entity of dxf.entities) {
    processEntity(entity, dxf, entities, 0, 0, 0, 1, 1, 1, 0);
  }

  log.info('エンティティ抽出完了:', {
    lines: entities.lines.length,
    polylines: entities.lwpolylines.length,
    circles: entities.circles.length,
    arcs: entities.arcs.length,
    texts: entities.texts.length,
    dimensions: entities.dimensions.length,
    inserts: entities.inserts.length,
  });

  return entities;
}

/**
 * 単一エンティティを処理（ブロック展開対応）
 * @param {Object} entity - DXFエンティティ
 * @param {Object} dxf - パースされたDXFデータ全体
 * @param {Object} entities - 抽出先エンティティオブジェクト
 * @param {number} offsetX - X オフセット（ブロック挿入位置）
 * @param {number} offsetY - Y オフセット
 * @param {number} offsetZ - Z オフセット
 * @param {number} scaleX - X スケール
 * @param {number} scaleY - Y スケール
 * @param {number} scaleZ - Z スケール
 * @param {number} rotation - 回転角度（度）
 */
function processEntity(
  entity,
  dxf,
  entities,
  offsetX,
  offsetY,
  offsetZ,
  scaleX,
  scaleY,
  scaleZ,
  rotation,
) {
  const layer = entity.layer || '0';
  const color = getEntityColor(entity, dxf);

  // 座標変換ヘルパー
  const transformPoint = (x, y, z = 0) => {
    // スケール適用
    let tx = x * scaleX;
    let ty = y * scaleY;
    const tz = (z || 0) * scaleZ;

    // 回転適用（Z軸周り）
    if (rotation !== 0) {
      const rad = (rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rx = tx * cos - ty * sin;
      const ry = tx * sin + ty * cos;
      tx = rx;
      ty = ry;
    }

    // オフセット適用
    return {
      x: tx + offsetX,
      y: ty + offsetY,
      z: tz + offsetZ,
    };
  };

  switch (entity.type) {
    case 'LINE': {
      const start = transformPoint(
        entity.vertices[0].x,
        entity.vertices[0].y,
        entity.vertices[0].z,
      );
      const end = transformPoint(entity.vertices[1].x, entity.vertices[1].y, entity.vertices[1].z);
      entities.lines.push({
        start,
        end,
        layer,
        color,
      });
      break;
    }

    case 'POLYLINE':
    case 'LWPOLYLINE': {
      const points = entity.vertices.map((v) => {
        const tp = transformPoint(v.x, v.y, v.z);
        return {
          x: tp.x,
          y: tp.y,
          z: tp.z,
          bulge: v.bulge || 0,
        };
      });
      entities.lwpolylines.push({
        points,
        closed: entity.shape || false,
        layer,
        color,
      });
      break;
    }

    case 'CIRCLE': {
      const center = transformPoint(entity.center.x, entity.center.y, entity.center.z);
      entities.circles.push({
        center,
        radius: entity.radius * Math.abs(scaleX), // スケールを適用
        layer,
        color,
      });
      break;
    }

    case 'ARC': {
      const center = transformPoint(entity.center.x, entity.center.y, entity.center.z);
      entities.arcs.push({
        center,
        radius: entity.radius * Math.abs(scaleX),
        startAngle: entity.startAngle + rotation,
        endAngle: entity.endAngle + rotation,
        layer,
        color,
      });
      break;
    }

    case 'POINT': {
      const position = transformPoint(entity.position.x, entity.position.y, entity.position.z);
      entities.points.push({
        position,
        layer,
        color,
      });
      break;
    }

    case 'TEXT':
    case 'MTEXT': {
      const x = entity.startPoint?.x || entity.position?.x || 0;
      const y = entity.startPoint?.y || entity.position?.y || 0;
      const z = entity.startPoint?.z || entity.position?.z || 0;
      const position = transformPoint(x, y, z);
      entities.texts.push({
        position,
        text: entity.text || '',
        height: (entity.textHeight || entity.height || 1) * Math.abs(scaleY),
        rotation: (entity.rotation || 0) + rotation,
        layer,
        color,
      });
      break;
    }

    case 'INSERT': {
      // ブロック参照を展開
      const blockName = entity.name;
      const block = dxf.blocks?.[blockName];

      if (block && block.entities) {
        // ブロックの挿入位置・スケール・回転を計算
        const insertX = entity.position?.x || 0;
        const insertY = entity.position?.y || 0;
        const insertZ = entity.position?.z || 0;
        const insertPos = transformPoint(insertX, insertY, insertZ);

        const newScaleX = scaleX * (entity.xScale || 1);
        const newScaleY = scaleY * (entity.yScale || 1);
        const newScaleZ = scaleZ * (entity.zScale || 1);
        const newRotation = rotation + (entity.rotation || 0);

        // ブロック内の全エンティティを再帰的に処理
        for (const blockEntity of block.entities) {
          processEntity(
            blockEntity,
            dxf,
            entities,
            insertPos.x,
            insertPos.y,
            insertPos.z,
            newScaleX,
            newScaleY,
            newScaleZ,
            newRotation,
          );
        }
      }

      // INSERT自体も記録（参照用）
      entities.inserts.push({
        name: entity.name,
        position: transformPoint(
          entity.position?.x || 0,
          entity.position?.y || 0,
          entity.position?.z || 0,
        ),
        scale: { x: entity.xScale || 1, y: entity.yScale || 1, z: entity.zScale || 1 },
        rotation: entity.rotation || 0,
        layer,
        color,
      });
      break;
    }

    case 'DIMENSION': {
      // 寸法ブロック（*D2 等）が存在する場合はブロックを展開して正確な描画を優先
      const dimBlockName = entity.block;
      const dimBlock = dxf.blocks?.[dimBlockName];
      if (dimBlock && dimBlock.entities && dimBlock.entities.length > 0) {
        // ブロックはモデル空間座標で定義されているのでオフセット不要 (0,0,0)
        for (const blockEntity of dimBlock.entities) {
          processEntity(
            blockEntity,
            dxf,
            entities,
            offsetX,
            offsetY,
            offsetZ,
            scaleX,
            scaleY,
            scaleZ,
            rotation,
          );
        }
      } else {
        // ブロックがない場合はフォールバックとして寸法データを再構成
        entities.dimensions.push(extractDimensionData(entity, layer, color));
      }
      break;
    }

    default:
      entities.others.push({
        type: entity.type,
        layer,
        color,
        raw: entity,
      });
  }
}

/**
 * DIMENSION エンティティからデータを抽出
 * @param {Object} entity - DXF DIMENSION エンティティ
 * @param {string} layer - レイヤー名
 * @param {number} color - 色
 * @returns {Object} 寸法データ
 */
function extractDimensionData(entity, layer, color) {
  // DXF寸法タイプ:
  // 0: Rotated, horizontal, or vertical (線形寸法)
  // 1: Aligned (平行寸法)
  // 2: Angular (角度寸法)
  // 3: Diameter (直径寸法)
  // 4: Radius (半径寸法)
  // 5: Angular 3-point
  // 6: Ordinate (座標寸法)

  const dimType = entity.dimensionType & 0x0f; // 下位4ビットがタイプ

  const dimension = {
    dimensionType: dimType,
    layer,
    color,
    // 寸法線の定義点
    anchorPoint: entity.anchorPoint
      ? {
          x: entity.anchorPoint.x || 0,
          y: entity.anchorPoint.y || 0,
          z: entity.anchorPoint.z || 0,
        }
      : null,
    // 寸法補助線の起点1 (線形寸法用)
    extLine1: entity.middleOfText
      ? {
          x: entity.middleOfText.x || 0,
          y: entity.middleOfText.y || 0,
          z: entity.middleOfText.z || 0,
        }
      : null,
    // 寸法補助線の起点2 (線形寸法用)
    extLine2: entity.insertionPoint
      ? {
          x: entity.insertionPoint.x || 0,
          y: entity.insertionPoint.y || 0,
          z: entity.insertionPoint.z || 0,
        }
      : null,
    // 寸法線の位置を決定する点
    dimensionLinePoint: entity.linearOrAngularPoint1
      ? {
          x: entity.linearOrAngularPoint1.x || 0,
          y: entity.linearOrAngularPoint1.y || 0,
          z: entity.linearOrAngularPoint1.z || 0,
        }
      : null,
    // 2つ目の点 (角度寸法用など)
    point2: entity.linearOrAngularPoint2
      ? {
          x: entity.linearOrAngularPoint2.x || 0,
          y: entity.linearOrAngularPoint2.y || 0,
          z: entity.linearOrAngularPoint2.z || 0,
        }
      : null,
    // テキスト
    text: entity.text || '',
    // 実測値
    actualMeasurement: entity.actualMeasurement,
    // 回転角度
    rotation: entity.rotation || 0,
    // ブロック参照名（寸法の見た目を定義するブロック）
    block: entity.block || null,
    // 生データ（デバッグ用）
    raw: entity,
  };

  return dimension;
}

/**
 * エンティティの色を取得
 * @param {Object} entity - DXFエンティティ
 * @param {Object} dxf - パースされたDXFデータ
 * @returns {number} RGB色値
 */
function getEntityColor(entity, dxf) {
  // エンティティ固有の色 (ByBlock=0, ByLayer=256 はレイヤー色に委ねる)
  if (entity.color !== undefined && entity.color !== 256 && entity.color !== 0) {
    return aciToRgb(entity.color);
  }

  // レイヤーの色を取得
  const layerName = entity.layer || '0';
  const layer = dxf.tables?.layer?.layers?.[layerName];
  if (layer && layer.color !== undefined) {
    return aciToRgb(layer.color);
  }

  // デフォルト色（白）
  return 0xffffff;
}

/**
 * AutoCAD Color Index (ACI) をRGBに変換
 * @param {number} aci - AutoCAD色インデックス
 * @returns {number} RGB色値
 */
function aciToRgb(aci) {
  // AutoCAD標準色のマッピング（簡略版）
  const aciColors = {
    0: 0x000000, // ByBlock
    1: 0xff0000, // Red
    2: 0xffff00, // Yellow
    3: 0x00ff00, // Green
    4: 0x00ffff, // Cyan
    5: 0x0000ff, // Blue
    6: 0xff00ff, // Magenta
    7: 0xffffff, // White
    8: 0x808080, // Dark Gray
    9: 0xc0c0c0, // Light Gray
    256: 0xffffff, // ByLayer (default to white)
  };

  return aciColors[aci] !== undefined ? aciColors[aci] : 0xffffff;
}

/**
 * DXFのレイヤー情報を取得
 * @param {Object} dxf - パースされたDXFデータ
 * @returns {Array} レイヤー情報の配列
 */
export function getLayers(dxf) {
  const layers = [];
  const layerTable = dxf.tables?.layer?.layers;

  if (layerTable) {
    for (const [name, layer] of Object.entries(layerTable)) {
      layers.push({
        name,
        color: aciToRgb(layer.color || 7),
        visible: !layer.frozen && layer.visible !== false,
        frozen: layer.frozen || false,
        locked: layer.locked || false,
      });
    }
  }

  return layers;
}

/**
 * DXFのバウンディングボックスを計算
 * @param {Object} entities - 抽出されたエンティティ
 * @returns {Object} バウンディングボックス {min, max}
 */
export function calculateBounds(entities) {
  const bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };

  function updateBounds(point) {
    bounds.min.x = Math.min(bounds.min.x, point.x);
    bounds.min.y = Math.min(bounds.min.y, point.y);
    bounds.min.z = Math.min(bounds.min.z, point.z || 0);
    bounds.max.x = Math.max(bounds.max.x, point.x);
    bounds.max.y = Math.max(bounds.max.y, point.y);
    bounds.max.z = Math.max(bounds.max.z, point.z || 0);
  }

  // 線分
  for (const line of entities.lines) {
    updateBounds(line.start);
    updateBounds(line.end);
  }

  // ポリライン
  for (const pl of entities.lwpolylines) {
    for (const pt of pl.points) {
      updateBounds(pt);
    }
  }

  // 円
  for (const circle of entities.circles) {
    updateBounds({
      x: circle.center.x - circle.radius,
      y: circle.center.y - circle.radius,
      z: circle.center.z,
    });
    updateBounds({
      x: circle.center.x + circle.radius,
      y: circle.center.y + circle.radius,
      z: circle.center.z,
    });
  }

  // 円弧
  for (const arc of entities.arcs) {
    updateBounds({ x: arc.center.x - arc.radius, y: arc.center.y - arc.radius, z: arc.center.z });
    updateBounds({ x: arc.center.x + arc.radius, y: arc.center.y + arc.radius, z: arc.center.z });
  }

  // 点
  for (const point of entities.points) {
    updateBounds(point.position);
  }

  // テキスト
  for (const text of entities.texts) {
    updateBounds(text.position);
  }

  // 有効なバウンドがない場合のデフォルト
  if (bounds.min.x === Infinity) {
    bounds.min = { x: 0, y: 0, z: 0 };
    bounds.max = { x: 1000, y: 1000, z: 0 };
  }

  return bounds;
}
