/**
 * @fileoverview DXF寸法レンダラー
 *
 * 線形寸法、半径寸法、直径寸法、角度寸法、汎用寸法の描画を担当します。
 */

import * as THREE from 'three';
import { buildCanvasFont } from '../utils/typography.js';
import { convertDxfSpecialChars } from './dxfTextRenderer.js';

/**
 * 寸法を描画
 * @param {Array} dimensions - 寸法エンティティの配列
 * @param {THREE.Group} group - 追加先グループ
 * @param {Object} transformOptions - 座標変換オプション
 * @param {Array|null} visibleLayers - 表示レイヤーリスト
 */
export function renderDimensions(dimensions, group, transformOptions, visibleLayers) {
  // transformOptionsから個別の値を取り出す（既存の子関数との互換性のため）
  // 注意: 現在、寸法描画は座標変換(plane)に未対応。将来対応予定。
  const { scale = 1, offsetX = 0, offsetY = 0, offsetZ = 0 } = transformOptions;

  for (const dim of dimensions) {
    if (visibleLayers && !visibleLayers.includes(dim.layer)) continue;

    // 寸法グループを作成
    const dimGroup = new THREE.Group();
    dimGroup.userData = {
      type: 'DXF_DIMENSION',
      dimensionType: dim.dimensionType,
      layer: dim.layer,
      sourceType: 'dxf',
      text: dim.text,
      actualMeasurement: dim.actualMeasurement,
    };

    // 線形寸法 (type 0, 1) の描画
    if (dim.dimensionType === 0 || dim.dimensionType === 1) {
      renderLinearDimension(dim, dimGroup, scale, offsetX, offsetY, offsetZ);
    }
    // 半径寸法 (type 4) の描画
    else if (dim.dimensionType === 4) {
      renderRadiusDimension(dim, dimGroup, scale, offsetX, offsetY, offsetZ);
    }
    // 直径寸法 (type 3) の描画
    else if (dim.dimensionType === 3) {
      renderDiameterDimension(dim, dimGroup, scale, offsetX, offsetY, offsetZ);
    }
    // 角度寸法 (type 2, 5) の描画
    else if (dim.dimensionType === 2 || dim.dimensionType === 5) {
      renderAngularDimension(dim, dimGroup, scale, offsetX, offsetY, offsetZ);
    }
    // その他の寸法タイプはraw dataから可能な限り描画
    else {
      renderGenericDimension(dim, dimGroup, scale, offsetX, offsetY, offsetZ);
    }

    if (dimGroup.children.length > 0) {
      group.add(dimGroup);
    }
  }
}

/**
 * 線形寸法を描画
 */
function renderLinearDimension(dim, group, scale, offsetX, offsetY, offsetZ) {
  const raw = dim.raw;
  if (!raw) return;

  // dxf-parserから取得できる点
  // anchorPoint: 寸法線の定義点
  // middleOfText: テキスト中央位置
  // insertionPoint: ブロック挿入点
  // linearOrAngularPoint1, linearOrAngularPoint2: 測定点

  const color = dim.color;
  const material = new THREE.LineBasicMaterial({ color, linewidth: 1 });

  // 測定点を取得
  const p1 = raw.linearOrAngularPoint1 || raw.anchorPoint;
  const p2 = raw.linearOrAngularPoint2;

  if (!p1) return;

  // 寸法線の位置（通常はanchorPointかmiddleOfText付近）
  const dimLineY = raw.anchorPoint?.y || p1.y;

  // 寸法補助線1
  if (p1) {
    const ext1Vertices = new Float32Array([
      (p1.x + offsetX) * scale,
      (p1.y + offsetY) * scale,
      ((p1.z || 0) + offsetZ) * scale,
      (p1.x + offsetX) * scale,
      (dimLineY + offsetY) * scale,
      ((p1.z || 0) + offsetZ) * scale,
    ]);
    const ext1Geo = new THREE.BufferGeometry();
    ext1Geo.setAttribute('position', new THREE.BufferAttribute(ext1Vertices, 3));
    group.add(new THREE.Line(ext1Geo, material));
  }

  // 寸法補助線2
  if (p2) {
    const ext2Vertices = new Float32Array([
      (p2.x + offsetX) * scale,
      (p2.y + offsetY) * scale,
      ((p2.z || 0) + offsetZ) * scale,
      (p2.x + offsetX) * scale,
      (dimLineY + offsetY) * scale,
      ((p2.z || 0) + offsetZ) * scale,
    ]);
    const ext2Geo = new THREE.BufferGeometry();
    ext2Geo.setAttribute('position', new THREE.BufferAttribute(ext2Vertices, 3));
    group.add(new THREE.Line(ext2Geo, material));
  }

  // 寸法線
  if (p1 && p2) {
    const dimLineVertices = new Float32Array([
      (p1.x + offsetX) * scale,
      (dimLineY + offsetY) * scale,
      ((p1.z || 0) + offsetZ) * scale,
      (p2.x + offsetX) * scale,
      (dimLineY + offsetY) * scale,
      ((p2.z || 0) + offsetZ) * scale,
    ]);
    const dimLineGeo = new THREE.BufferGeometry();
    dimLineGeo.setAttribute('position', new THREE.BufferAttribute(dimLineVertices, 3));
    group.add(new THREE.Line(dimLineGeo, material));

    // 矢印を追加
    addArrowHead({
      group,
      position: { x: p1.x + offsetX, y: dimLineY + offsetY, z: (p1.z || 0) + offsetZ },
      direction: 1,
      scale,
      color,
    });
    addArrowHead({
      group,
      position: { x: p2.x + offsetX, y: dimLineY + offsetY, z: (p2.z || 0) + offsetZ },
      direction: -1,
      scale,
      color,
    });

    // 寸法テキストを追加
    const displayText = getDimensionDisplayText(dim);
    if (displayText) {
      // テキスト位置は寸法線の中央
      const textX = (p1.x + p2.x) / 2 + offsetX;
      const textY = dimLineY + offsetY + 100; // 寸法線の少し上
      const textZ = (p1.z || 0) + offsetZ;
      const textSprite = createDimensionTextSprite({
        text: displayText,
        position: { x: textX, y: textY, z: textZ },
        scale,
        color,
      });
      if (textSprite) {
        group.add(textSprite);
      }
    }
  }
}

/**
 * 半径寸法を描画
 */
function renderRadiusDimension(dim, group, scale, offsetX, offsetY, offsetZ) {
  const raw = dim.raw;
  if (!raw) return;

  const color = dim.color;
  const material = new THREE.LineBasicMaterial({ color, linewidth: 1 });

  const center = raw.anchorPoint;
  const textPos = raw.middleOfText;

  if (center && textPos) {
    const vertices = new Float32Array([
      (center.x + offsetX) * scale,
      (center.y + offsetY) * scale,
      ((center.z || 0) + offsetZ) * scale,
      (textPos.x + offsetX) * scale,
      (textPos.y + offsetY) * scale,
      ((textPos.z || 0) + offsetZ) * scale,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    group.add(new THREE.Line(geo, material));

    // 矢印
    const dx = textPos.x - center.x;
    const dir = dx !== 0 ? (dx > 0 ? 1 : -1) : 0;
    addArrowHead({
      group,
      position: { x: center.x + offsetX, y: center.y + offsetY, z: (center.z || 0) + offsetZ },
      direction: dir,
      scale,
      color,
    });

    // 寸法テキストを追加（「R」プレフィックス付き）
    const displayText = getDimensionDisplayText(dim);
    if (displayText) {
      const textX = textPos.x + offsetX;
      const textY = textPos.y + offsetY + 100;
      const textZ = (textPos.z || 0) + offsetZ;
      const textSprite = createDimensionTextSprite({
        text: 'R' + displayText,
        position: { x: textX, y: textY, z: textZ },
        scale,
        color,
      });
      if (textSprite) {
        group.add(textSprite);
      }
    }
  }
}

/**
 * 直径寸法を描画
 */
function renderDiameterDimension(dim, group, scale, offsetX, offsetY, offsetZ) {
  // 直径は半径と同様だが両端に矢印
  const raw = dim.raw;
  if (!raw) return;

  const color = dim.color;
  const material = new THREE.LineBasicMaterial({ color, linewidth: 1 });

  const p1 = raw.linearOrAngularPoint1;
  const p2 = raw.linearOrAngularPoint2 || raw.anchorPoint;

  if (p1 && p2) {
    const vertices = new Float32Array([
      (p1.x + offsetX) * scale,
      (p1.y + offsetY) * scale,
      ((p1.z || 0) + offsetZ) * scale,
      (p2.x + offsetX) * scale,
      (p2.y + offsetY) * scale,
      ((p2.z || 0) + offsetZ) * scale,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    group.add(new THREE.Line(geo, material));

    // 両端に矢印
    addArrowHead({
      group,
      position: { x: p1.x + offsetX, y: p1.y + offsetY, z: (p1.z || 0) + offsetZ },
      direction: 1,
      scale,
      color,
    });
    addArrowHead({
      group,
      position: { x: p2.x + offsetX, y: p2.y + offsetY, z: (p2.z || 0) + offsetZ },
      direction: -1,
      scale,
      color,
    });

    // 寸法テキストを追加（「φ」プレフィックス付き）
    const displayText = getDimensionDisplayText(dim);
    if (displayText) {
      const textX = (p1.x + p2.x) / 2 + offsetX;
      const textY = (p1.y + p2.y) / 2 + offsetY + 100;
      const textZ = ((p1.z || 0) + (p2.z || 0)) / 2 + offsetZ;
      const textSprite = createDimensionTextSprite({
        text: 'φ' + displayText,
        position: { x: textX, y: textY, z: textZ },
        scale,
        color,
      });
      if (textSprite) {
        group.add(textSprite);
      }
    }
  }
}

/**
 * 角度寸法を描画
 */
function renderAngularDimension(dim, group, scale, offsetX, offsetY, offsetZ) {
  const raw = dim.raw;
  if (!raw) return;

  const color = dim.color;
  const material = new THREE.LineBasicMaterial({ color, linewidth: 1 });

  // 角度寸法は円弧で表示
  const center = raw.anchorPoint;
  const p1 = raw.linearOrAngularPoint1;
  const p2 = raw.linearOrAngularPoint2;

  if (center && p1 && p2) {
    const angle1 = Math.atan2(p1.y - center.y, p1.x - center.x);
    const angle2 = Math.atan2(p2.y - center.y, p2.x - center.x);
    const radius = Math.sqrt(Math.pow(p1.x - center.x, 2) + Math.pow(p1.y - center.y, 2));

    const segments = 32;
    const startAngle = angle1;
    let endAngle = angle2;
    if (endAngle < startAngle) endAngle += Math.PI * 2;

    const points = [];
    for (let i = 0; i <= segments; i++) {
      const angle = startAngle + (i / segments) * (endAngle - startAngle);
      points.push(
        new THREE.Vector3(
          (center.x + Math.cos(angle) * radius + offsetX) * scale,
          (center.y + Math.sin(angle) * radius + offsetY) * scale,
          ((center.z || 0) + offsetZ) * scale,
        ),
      );
    }

    const geo = new THREE.BufferGeometry().setFromPoints(points);
    group.add(new THREE.Line(geo, material));

    // 寸法テキストを追加（角度寸法は「°」サフィックス付き）
    const displayText = getDimensionDisplayText(dim);
    if (displayText) {
      // 円弧の中央付近にテキストを配置
      const midAngle = (startAngle + endAngle) / 2;
      const textRadius = radius * 1.2; // 少し外側に
      const textX = center.x + Math.cos(midAngle) * textRadius + offsetX;
      const textY = center.y + Math.sin(midAngle) * textRadius + offsetY;
      const textZ = (center.z || 0) + offsetZ;
      const textSprite = createDimensionTextSprite({
        text: displayText + '°',
        position: { x: textX, y: textY, z: textZ },
        scale,
        color,
      });
      if (textSprite) {
        group.add(textSprite);
      }
    }
  }
}

/**
 * 汎用寸法を描画（raw dataから可能な限り）
 */
function renderGenericDimension(dim, group, scale, offsetX, offsetY, offsetZ) {
  const raw = dim.raw;
  if (!raw) return;

  const color = dim.color;
  const material = new THREE.LineBasicMaterial({ color, linewidth: 1 });

  // 利用可能な点を取得して線を描画
  const points = [];

  if (raw.anchorPoint) {
    points.push(raw.anchorPoint);
  }
  if (raw.middleOfText) {
    points.push(raw.middleOfText);
  }
  if (raw.linearOrAngularPoint1) {
    points.push(raw.linearOrAngularPoint1);
  }
  if (raw.linearOrAngularPoint2) {
    points.push(raw.linearOrAngularPoint2);
  }

  if (points.length >= 2) {
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      const vertices = new Float32Array([
        (p1.x + offsetX) * scale,
        (p1.y + offsetY) * scale,
        ((p1.z || 0) + offsetZ) * scale,
        (p2.x + offsetX) * scale,
        (p2.y + offsetY) * scale,
        ((p2.z || 0) + offsetZ) * scale,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      group.add(new THREE.Line(geo, material));
    }

    // 寸法テキストを追加
    const displayText = getDimensionDisplayText(dim);
    if (displayText) {
      // middleOfTextがあればそこに、なければ最初の点の近くに配置
      const textPoint = raw.middleOfText || points[0];
      const textX = textPoint.x + offsetX;
      const textY = textPoint.y + offsetY + 100;
      const textZ = (textPoint.z || 0) + offsetZ;
      const textSprite = createDimensionTextSprite({
        text: displayText,
        position: { x: textX, y: textY, z: textZ },
        scale,
        color,
      });
      if (textSprite) {
        group.add(textSprite);
      }
    }
  }
}

/**
 * @typedef {Object} ArrowHeadConfig
 * @property {THREE.Group} group - 追加先グループ
 * @property {{x: number, y: number, z: number}} position - 矢印の先端位置
 * @property {number} direction - 方向 (1 または -1)
 * @property {number} scale - スケール
 * @property {number} color - 矢印色 (0xRRGGBB形式)
 */

/**
 * 矢印ヘッドを追加
 * @param {ArrowHeadConfig} config - 矢印ヘッド設定
 */
function addArrowHead(config) {
  const { group, position, direction, scale, color } = config;
  const { x, y, z } = position;
  const arrowSize = 100 * scale; // 矢印のサイズ
  const arrowAngle = Math.PI / 6; // 30度

  const material = new THREE.LineBasicMaterial({ color, linewidth: 1 });

  // 矢印の2本の線
  const vertices = new Float32Array([
    x * scale,
    y * scale,
    z * scale,
    (x - direction * arrowSize * Math.cos(arrowAngle)) * scale,
    (y + arrowSize * Math.sin(arrowAngle)) * scale,
    z * scale,
    x * scale,
    y * scale,
    z * scale,
    (x - direction * arrowSize * Math.cos(arrowAngle)) * scale,
    (y - arrowSize * Math.sin(arrowAngle)) * scale,
    z * scale,
  ]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  group.add(new THREE.LineSegments(geo, material));
}

/**
 * @typedef {Object} DimensionTextSpriteConfig
 * @property {string} text - 表示テキスト
 * @property {{x: number, y: number, z: number}} position - 表示位置
 * @property {number} scale - スケール
 * @property {number} color - テキスト色 (0xRRGGBB形式)
 * @property {number} [rotation=0] - 回転角度（ラジアン）
 */

/**
 * 寸法テキストスプライトを作成
 * @param {DimensionTextSpriteConfig} config - 寸法テキストスプライト設定
 * @returns {THREE.Sprite} テキストスプライト
 */
function createDimensionTextSprite(config) {
  const { text, position, scale, color } = config;
  const { x, y, z } = position;
  const fontSize = 32;
  const canvasWidth = 256;
  const canvasHeight = 64;

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // 背景（半透明白）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // テキスト描画
  ctx.font = buildCanvasFont(fontSize, { weight: 'bold' });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // テキスト色を設定（colorは0xRRGGBB形式）
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

  ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(material);

  // スケール調整（寸法線のスケールに合わせる）
  const textScale = 300 * scale;
  sprite.scale.set(textScale, textScale * (canvasHeight / canvasWidth), 1);

  sprite.position.set(x * scale, y * scale, z * scale);

  sprite.userData = {
    type: 'DXF_DIMENSION_TEXT',
    sourceType: 'dxf',
    originalText: text,
  };

  return sprite;
}

/**
 * 寸法の表示テキストを取得
 * @param {Object} dim - 寸法データ
 * @returns {string} 表示テキスト
 */
function getDimensionDisplayText(dim) {
  // 明示的なテキストがあればそれを使用
  if (dim.text && dim.text.trim() !== '' && dim.text !== '<>') {
    // 特殊文字を変換して返す
    return convertDxfSpecialChars(dim.text);
  }

  // 実測値があれば数値として表示
  if (dim.actualMeasurement !== undefined && dim.actualMeasurement !== null) {
    // 小数点以下2桁で表示
    return dim.actualMeasurement.toFixed(2);
  }

  // rawデータからactualMeasurementを取得
  if (dim.raw && dim.raw.actualMeasurement !== undefined) {
    return dim.raw.actualMeasurement.toFixed(2);
  }

  return '';
}
