/**
 * @fileoverview DXFテキストレンダラー
 *
 * TEXT/MTEXTエンティティの描画と特殊文字変換を担当します。
 */

import * as THREE from 'three';
import { createLogger } from '../utils/logger.js';
import { buildCanvasFont } from '../utils/typography.js';
import { transformCoordinates } from './dxfCoordinates.js';

const log = createLogger('DXFTextRenderer');

/**
 * テキストを描画
 * @param {Array} texts - テキストエンティティの配列
 * @param {THREE.Group} group - 追加先グループ
 * @param {Object} transformOptions - 座標変換オプション
 * @param {Array|null} visibleLayers - 表示レイヤーリスト
 */
export function renderTexts(texts, group, transformOptions, visibleLayers) {
  const { scale = 1 } = transformOptions;

  for (const text of texts) {
    if (visibleLayers && !visibleLayers.includes(text.layer)) continue;
    if (!text.text || text.text.trim() === '') continue;

    // デバッグ: 生のテキストデータを確認
    const rawBytes = [];
    for (let i = 0; i < text.text.length; i++) {
      rawBytes.push(text.text.charCodeAt(i).toString(16).padStart(4, '0'));
    }
    log.info('DXF TEXT raw:', {
      text: text.text,
      bytes: rawBytes.join(' '),
      layer: text.layer,
    });

    // 座標を変換
    const transformed = transformCoordinates(
      text.position.x,
      text.position.y,
      text.position.z || 0,
      transformOptions,
    );

    const sprite = createTextSprite({
      text: text.text,
      position: {
        x: transformed.x / scale, // createTextSpriteが内部でscaleを掛けるので戻す
        y: transformed.y / scale,
        z: transformed.z / scale,
      },
      scale,
      color: text.color,
      height: text.height,
      rotation: text.rotation,
    });

    if (sprite) {
      sprite.userData = {
        type: 'DXF_TEXT',
        layer: text.layer,
        sourceType: 'dxf',
        originalText: text.text,
        height: text.height,
        rotation: text.rotation,
      };
      group.add(sprite);
    }
  }
}

/**
 * DXF/AutoCADの特殊文字コードを標準文字に変換
 * @param {string} text - 変換元テキスト
 * @returns {string} 変換後テキスト
 */
export function convertDxfSpecialChars(text) {
  if (!text) return '';

  let result = text;

  // AutoCAD %%コード（大文字小文字両方に対応）
  const specialCodes = {
    '%%C': 'φ', // 直径記号
    '%%c': 'φ',
    '%%D': '°', // 度記号
    '%%d': '°',
    '%%P': '±', // プラスマイナス
    '%%p': '±',
    '%%U': '', // 下線開始（表示のみなので除去）
    '%%u': '',
    '%%O': '', // 上線開始（表示のみなので除去）
    '%%o': '',
    '%%%': '%', // パーセント記号
    '%%NNN': '', // 3桁数字は後で処理
  };

  // %%コードを置換
  for (const [code, replacement] of Object.entries(specialCodes)) {
    result = result.split(code).join(replacement);
  }

  // %%nnn 形式（ASCII文字コード）を置換
  result = result.replace(/%%(\d{3})/g, (match, code) => {
    const charCode = parseInt(code, 10);
    return String.fromCharCode(charCode);
  });

  // \U+XXXX 形式（Unicode）を置換
  result = result.replace(/\\U\+([0-9A-Fa-f]{4})/g, (match, hex) => {
    const codePoint = parseInt(hex, 16);
    return String.fromCodePoint(codePoint);
  });

  // \M+nXXXX 形式（AutoCAD多言語文字）を置換
  // 例: \M+1002F（日本語のスラッシュ的な文字）
  result = result.replace(/\\M\+[0-9]([0-9A-Fa-f]{4})/g, (match, hex) => {
    const codePoint = parseInt(hex, 16);
    return String.fromCodePoint(codePoint);
  });

  // MTEXT書式コードを除去
  result = result
    .replace(/\\A[012];/g, '') // 垂直揃え
    .replace(/\\f[^;]*;/gi, '') // フォント指定
    .replace(/\\H[0-9.]+;/gi, '') // 高さ指定
    .replace(/\\H[0-9.]+x;/gi, '') // 高さ係数
    .replace(/\\W[0-9.]+;/gi, '') // 幅係数
    .replace(/\\Q[0-9.]+;/gi, '') // 斜体角度
    .replace(/\\T[0-9.]+;/gi, '') // トラッキング
    .replace(/\\[CLOR]/gi, '') // 色、行揃え
    .replace(/\\S[^;]*;/gi, '') // スタックテキスト
    .replace(/\{|\}/g, '') // グループ括弧
    .replace(/\\~/g, ' ') // 改行なしスペース
    .replace(/\\\\/g, '\\') // エスケープされたバックスラッシュ
    .replace(/\\P/gi, '\n') // 段落区切り（改行）
    .replace(/\\N/gi, '\n'); // 改行

  // SHXフォント外字・特殊記号の変換
  // これらはbigfont.shx、extfont.shx等で使われる日本語CAD特有の文字
  // Unicode Private Use Area (E000-F8FF) や特殊記号をマッピング
  result = convertShxSpecialChars(result);

  // 残った制御文字やゴミを除去
  // 0x00-0x1F（制御文字）を除去（ただし改行・タブは残す）
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  return result.trim();
}

/**
 * SHXフォント外字・特殊記号を一般的な文字に変換
 * @param {string} text - 変換元テキスト
 * @returns {string} 変換後テキスト
 */
function convertShxSpecialChars(text) {
  let result = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = char.charCodeAt(0);

    // Unicode Private Use Area (E000-F8FF) - SHXフォント外字
    if (code >= 0xe000 && code <= 0xf8ff) {
      // よく使われる外字のマッピング（AutoCAD/Jw_cad等）
      const shxMapping = getShxCharMapping(code);
      if (shxMapping) {
        result += shxMapping;
      } else {
        // マッピングがない場合は除去または代替文字
        result += ''; // 除去
      }
    }
    // 罫線素片やBox Drawing文字（2500-257F）- 通常はそのまま
    else if (code >= 0x2500 && code <= 0x257f) {
      result += char;
    }
    // その他の特殊記号領域
    else if (code >= 0x25a0 && code <= 0x25ff) {
      // 幾何学的図形（◆◇○●等）
      // 建築記号として使われている可能性があるが、表示できる文字はそのまま
      result += char;
    }
    // 囲み文字（①②等 - 2460-24FF）
    else if (code >= 0x2460 && code <= 0x24ff) {
      result += char;
    }
    // CJK互換文字や特殊記号で表示できないもの
    else if (code >= 0xfe00 && code <= 0xfe0f) {
      // 異体字セレクタ - 除去
      continue;
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * SHX外字コードから一般的な文字へのマッピングを取得
 * @param {number} code - Unicodeコードポイント
 * @returns {string|null} マッピングされた文字、またはnull
 */
function getShxCharMapping(code) {
  // 日本語CADでよく使われるSHX外字のマッピング
  // これらは主にbigfont.shx、extfont2.shx等で定義される特殊記号
  const shxMappings = {
    // 建築記号
    0xe000: '─', // 横線
    0xe001: '│', // 縦線
    0xe002: '┌', // 角
    0xe003: '┐',
    0xe004: '└',
    0xe005: '┘',
    0xe006: '├',
    0xe007: '┤',
    0xe008: '┬',
    0xe009: '┴',
    0xe00a: '┼',

    // 構造記号（鉄骨等）
    0xe010: 'H', // H形鋼
    0xe011: 'C', // C形鋼
    0xe012: 'L', // アングル
    0xe013: '□', // 角パイプ
    0xe014: '○', // 丸パイプ

    // 寸法記号
    0xe020: 'φ', // 直径
    0xe021: 'R', // 半径
    0xe022: '°', // 度
    0xe023: '±', // プラスマイナス
    0xe024: '×', // 掛ける
    0xe025: '÷', // 割る

    // よく使われる日本語CAD記号
    0xe030: '通', // 通り芯
    0xe031: '芯',
    0xe032: '階',
    0xe033: 'F', // Floor
    0xe034: 'GL', // Ground Level
    0xe035: 'FL', // Floor Level
    0xe036: 'SL', // Slab Level
    0xe037: 'CH', // Ceiling Height

    // 矢印
    0xe040: '→',
    0xe041: '←',
    0xe042: '↑',
    0xe043: '↓',
    0xe044: '↗',
    0xe045: '↘',
    0xe046: '↖',
    0xe047: '↙',

    // 囲み数字の代替
    0xe050: '①',
    0xe051: '②',
    0xe052: '③',
    0xe053: '④',
    0xe054: '⑤',
    0xe055: '⑥',
    0xe056: '⑦',
    0xe057: '⑧',
    0xe058: '⑨',
    0xe059: '⑩',

    // 丸囲みアルファベット
    0xe060: 'Ⓐ',
    0xe061: 'Ⓑ',
    0xe062: 'Ⓒ',
    0xe063: 'Ⓓ',
    0xe064: 'Ⓔ',
    0xe065: 'Ⓕ',
    0xe066: 'Ⓖ',
    0xe067: 'Ⓗ',
    0xe068: 'Ⓘ',
    0xe069: 'Ⓙ',
    0xe06a: 'Ⓚ',
    0xe06b: 'Ⓛ',
    0xe06c: 'Ⓜ',
    0xe06d: 'Ⓝ',
    0xe06e: 'Ⓞ',
    0xe06f: 'Ⓟ',
    0xe070: 'Ⓠ',
    0xe071: 'Ⓡ',
    0xe072: 'Ⓢ',
    0xe073: 'Ⓣ',
    0xe074: 'Ⓤ',
    0xe075: 'Ⓥ',
    0xe076: 'Ⓦ',
    0xe077: 'Ⓧ',
    0xe078: 'Ⓨ',
    0xe079: 'Ⓩ',
  };

  return shxMappings[code] || null;
}

/**
 * @typedef {Object} TextSpriteConfig
 * @property {string} text - 表示テキスト
 * @property {{x: number, y: number, z: number}} position - 表示位置
 * @property {number} scale - スケール
 * @property {number} color - テキスト色 (0xRRGGBB形式)
 * @property {number} [height=1] - テキスト高さ
 * @property {number} [rotation=0] - 回転角度（度）
 */

/**
 * テキストスプライトを作成（TEXT/MTEXT用）
 * @param {TextSpriteConfig} config - テキストスプライト設定
 * @returns {THREE.Sprite} テキストスプライト
 */
export function createTextSprite(config) {
  const { text, position, scale, color, height = 1 } = config;
  const { x, y, z } = position;
  // 特殊文字を変換
  const convertedText = convertDxfSpecialChars(text);

  // テキストを複数行に分割（MTEXTの場合）
  const lines = convertedText.split(/\n/);
  const lineCount = lines.length;

  // キャンバスサイズを動的に計算
  const fontSize = 48;
  const padding = 10;
  const lineHeight = fontSize * 1.2;
  const canvasFont = buildCanvasFont(fontSize);

  // 最長行の幅を計算
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.font = canvasFont;

  let maxWidth = 0;
  for (const line of lines) {
    const width = tempCtx.measureText(line).width;
    if (width > maxWidth) maxWidth = width;
  }

  const canvasWidth = Math.max(256, Math.min(1024, maxWidth + padding * 2));
  const canvasHeight = Math.max(64, lineCount * lineHeight + padding * 2);

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // 背景（半透明白）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // テキスト描画
  ctx.font = canvasFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // テキスト色を設定（colorは0xRRGGBB形式）
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

  // 複数行テキストを描画
  const startY = (canvasHeight - (lineCount - 1) * lineHeight) / 2;
  for (let i = 0; i < lines.length; i++) {
    // 既にconvertDxfSpecialCharsで書式コード除去済み
    ctx.fillText(lines[i], canvasWidth / 2, startY + i * lineHeight);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(material);

  // スケール調整（DXFのテキスト高さに基づく）
  // height はDXF上のテキスト高さ（単位はモデル単位）
  const textScale = height * 10 * scale; // 適切なスケール係数
  const aspectRatio = canvasWidth / canvasHeight;
  sprite.scale.set(textScale * aspectRatio, textScale, 1);

  sprite.position.set(x * scale, y * scale, z * scale);

  return sprite;
}
