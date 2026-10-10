/**
 * @fileoverview DXFフォーマット書き込みモジュール（R12形式対応）
 *
 * DXFファイル形式の各セクション（HEADER, TABLES, BLOCKS, ENTITIES）を
 * 生成する機能を提供します。
 * AutoCAD R12形式（AC1009）で出力し、AutoCAD/JWCADとの互換性を確保します。
 */

import { ELEMENT_TYPE_COLORS } from './DxfProviders.js';
import { downloadBlob } from '../../../utils/downloadHelper.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('export:dxf:stb-to-dxf:DxfFormatWriter');

// ========================================
// ハンドル生成システム
// ========================================

/**
 * ハンドルカウンタをリセット（将来の拡張用）
 */
function resetHandles() {
  // 現在未使用（DXF R12形式ではハンドル不要）
}

// ========================================
// DXFフォーマットユーティリティ
// ========================================

/**
 * グループコードを3桁右寄せでフォーマット
 * @param {number|string} code - グループコード
 * @returns {string} フォーマット済みグループコード
 */
function formatCode(code) {
  return String(code).padStart(3, ' ');
}

/**
 * AutoCAD R12 (AC1009)用に文字列をASCII/CIF互換表現へ変換する。
 *
 * AutoCAD 2004以前のDXFはUTF-8文字列をサポートしないため、
 * 非ASCII文字は \\U+XXXX 制御シーケンスへ変換する。
 * @param {string} value
 * @returns {string}
 */
function encodeR12String(value) {
  const source = String(value);
  let encoded = '';

  for (let index = 0; index < source.length; index++) {
    const codeUnit = source.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      encoded += source[index];
    } else {
      encoded += `\\U+${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }

  return encoded;
}

/**
 * R12 ASCII文字列中の \\U+XXXX を元のUnicode文字列へ戻す。
 * Jw_cad向けShift-JIS書き出し時のみ利用する。
 * @param {string} content
 * @returns {string}
 */
export function decodeR12UnicodeEscapes(content) {
  return String(content).replace(/\\U\+([0-9A-Fa-f]{4})/g, (_match, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

export const DXF_OUTPUT_PROFILES = Object.freeze({
  AUTOCAD_R12: 'autocad-r12',
  JWCAD_R12: 'jwcad-r12',
});

export function normalizeDxfOutputProfile(profile) {
  return profile === DXF_OUTPUT_PROFILES.JWCAD_R12
    ? DXF_OUTPUT_PROFILES.JWCAD_R12
    : DXF_OUTPUT_PROFILES.AUTOCAD_R12;
}

/**
 * DXFのグループコードと値のペアを生成
 * @param {number|string} code - グループコード
 * @param {string|number} value - 値
 * @returns {string} フォーマット済みペア
 */
function dxfPair(code, value) {
  const encodedValue = typeof value === 'string' ? encodeR12String(value) : value;
  return `${formatCode(code)}\n${encodedValue}`;
}

/**
 * 複数のグループコード/値ペアを配列に追加
 * @param {Array} arr - 追加先配列
 * @param  {...Array} pairs - [code, value] ペアの配列
 */
function addPairs(arr, ...pairs) {
  for (const [code, value] of pairs) {
    arr.push(dxfPair(code, value));
  }
}

// ========================================
// HEADERセクション
// ========================================

/**
 * DXF HEADERセクションを生成（R12形式）
 * @param {Object} bounds - モデルのバウンド {min: {x, y}, max: {x, y}}
 * @returns {string} DXFヘッダー文字列
 */
export function generateHeader(bounds) {
  const extMin = bounds.min;
  const extMax = bounds.max;
  const lines = [];

  addPairs(
    lines,
    [0, 'SECTION'],
    [2, 'HEADER'],
    // バージョン - R12形式
    [9, '$ACADVER'],
    [1, 'AC1009'],
    // 挿入基準点
    [9, '$INSBASE'],
    [10, '0.0'],
    [20, '0.0'],
    [30, '0.0'],
    // 図面範囲
    [9, '$EXTMIN'],
    [10, extMin.x.toFixed(6)],
    [20, extMin.y.toFixed(6)],
    [30, '0.0'],
    [9, '$EXTMAX'],
    [10, extMax.x.toFixed(6)],
    [20, extMax.y.toFixed(6)],
    [30, '0.0'],
    // 描画制限
    [9, '$LIMMIN'],
    [10, extMin.x.toFixed(6)],
    [20, extMin.y.toFixed(6)],
    [9, '$LIMMAX'],
    [10, extMax.x.toFixed(6)],
    [20, extMax.y.toFixed(6)],
    // 線種スケール
    [9, '$LTSCALE'],
    [40, '1.0'],
    // R12/AC1009には$INSUNITSを無理に追加せず、group code 999コメントで
    // SDV出力が内部mmであることをread-back adapterへ明示する。
    [999, 'SDV_UNITS=mm'],
    [999, 'SDV_GENERATOR=StbDiffViewer'],
    // セクション終了
    [0, 'ENDSEC'],
  );

  return lines.join('\n');
}

// ========================================
// TABLESセクション
// ========================================

/**
 * VPORTテーブルを生成
 * @param {Object} bounds - モデルのバウンド
 * @returns {string} VPORTテーブル文字列
 */
function generateVportTable(bounds) {
  const lines = [];
  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const centerY = (bounds.min.y + bounds.max.y) / 2;
  const viewHeight = bounds.max.y - bounds.min.y;

  addPairs(
    lines,
    [0, 'TABLE'],
    [2, 'VPORT'],
    [70, 1],
    // アクティブビューポート
    [0, 'VPORT'],
    [2, '*ACTIVE'],
    [70, 0],
    // 左下コーナー
    [10, '0.0'],
    [20, '0.0'],
    // 右上コーナー
    [11, '1.0'],
    [21, '1.0'],
    // ビュー中心
    [12, centerX.toFixed(6)],
    [22, centerY.toFixed(6)],
    // スナップ基点
    [13, '0.0'],
    [23, '0.0'],
    // スナップ間隔
    [14, '10.0'],
    [24, '10.0'],
    // グリッド間隔
    [15, '10.0'],
    [25, '10.0'],
    // 視線方向
    [16, '0.0'],
    [26, '0.0'],
    [36, '1.0'],
    // ターゲット点
    [17, '0.0'],
    [27, '0.0'],
    [37, '0.0'],
    // ビュー高さ
    [40, Math.max(viewHeight, 1000).toFixed(6)],
    // アスペクト比
    [41, '1.0'],
    // レンズ長
    [42, '50.0'],
    // 前後クリップ
    [43, '0.0'],
    [44, '0.0'],
    // スナップ回転
    [50, '0.0'],
    [51, '0.0'],
    // フラグ
    [71, 0],
    [72, 100],
    [73, 1],
    [74, 3],
    [75, 0],
    [76, 0],
    [77, 0],
    [78, 0],
    [0, 'ENDTAB'],
  );

  return lines.join('\n');
}

/**
 * LTYPEテーブルを生成
 * @returns {string} LTYPEテーブル文字列
 */
function generateLtypeTable(lineTypes = []) {
  const definitions = [];
  const names = new Set(['CONTINUOUS']);
  for (const lineType of lineTypes || []) {
    const name = String(lineType?.name || '').trim();
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new TypeError('DXF線種名が不正です。');
    if (names.has(name)) throw new Error(`DXF線種名が重複しています: ${name}`);
    if (
      !Array.isArray(lineType.pattern) ||
      lineType.pattern.length === 0 ||
      !lineType.pattern.every((value) => Number.isFinite(value) && value !== 0)
    )
      throw new TypeError(`DXF線種patternが不正です: ${name}`);
    names.add(name);
    definitions.push({
      name,
      description: String(lineType.description || name),
      pattern: [...lineType.pattern],
    });
  }

  const lines = [];
  addPairs(
    lines,
    [0, 'TABLE'],
    [2, 'LTYPE'],
    [70, definitions.length + 1],
    [0, 'LTYPE'],
    [2, 'CONTINUOUS'],
    [70, 0],
    [3, 'Solid line'],
    [72, 65],
    [73, 0],
    [40, '0.0'],
  );

  for (const definition of definitions) {
    addPairs(
      lines,
      [0, 'LTYPE'],
      [2, definition.name],
      [70, 0],
      [3, definition.description],
      [72, 65],
      [73, definition.pattern.length],
      [40, definition.pattern.reduce((sum, value) => sum + Math.abs(value), 0).toFixed(6)],
    );
    for (const segment of definition.pattern) {
      // AC1009 (AutoCAD R12) の単純線種では、各ダッシュ要素は group code 49 のみで表す。
      // group code 74 はAutoCAD 2026でR12 LTYPE tableの不正入力として拒否されるため出力しない。
      addPairs(lines, [49, segment.toFixed(6)]);
    }
  }

  addPairs(lines, [0, 'ENDTAB']);
  return lines.join('\n');
}

/**
 * LAYERテーブルを生成（R12形式 - ハンドルなし）
 * @param {Array<string>} layers - レイヤー名の配列
 * @returns {string} LAYERテーブル文字列
 */
function generateLayerTable(layers) {
  const lines = [];

  addPairs(lines, [0, 'TABLE'], [2, 'LAYER'], [70, layers.length]);

  for (const layerName of layers) {
    const colorIndex = ELEMENT_TYPE_COLORS[layerName] || 7;
    addPairs(lines, [0, 'LAYER'], [2, layerName], [70, 0], [62, colorIndex], [6, 'CONTINUOUS']);
  }

  addPairs(lines, [0, 'ENDTAB']);

  return lines.join('\n');
}

/**
 * STYLEテーブルを生成（R12形式 - ハンドルなし）
 * @returns {string} STYLEテーブル文字列
 */
function generateStyleTable({ fontFile = 'txt', bigFontFile = '' } = {}) {
  const lines = [];

  addPairs(
    lines,
    [0, 'TABLE'],
    [2, 'STYLE'],
    [70, 1],
    [0, 'STYLE'],
    [2, 'STANDARD'],
    [70, 0],
    [40, '0.0'],
    [41, '1.0'],
    [50, '0.0'],
    [71, 0],
    [42, '200.0'],
    [3, fontFile],
    [4, bigFontFile],
    [0, 'ENDTAB'],
  );

  return lines.join('\n');
}

/**
 * DXF TABLESセクションを生成
 * @param {Array<string>} layers - レイヤー名の配列
 * @param {boolean} _hasText - テキストを含むかどうか（未使用、後方互換性のため保持）
 * @param {Object} bounds - モデルのバウンド
 * @returns {string} DXFテーブル文字列
 */
export function generateTables(
  layers,
  _hasText = false,
  bounds = null,
  lineTypes = [],
  textStyle = {},
) {
  const effectiveBounds = bounds || { min: { x: 0, y: 0 }, max: { x: 10000, y: 10000 } };
  const lines = [];

  addPairs(lines, [0, 'SECTION'], [2, 'TABLES']);

  // VPORTテーブル
  lines.push(generateVportTable(effectiveBounds));

  // LTYPEテーブル
  lines.push(generateLtypeTable(lineTypes));

  // LAYERテーブル
  lines.push(generateLayerTable(layers));

  // STYLEテーブル（常に含める）
  lines.push(generateStyleTable(textStyle));

  addPairs(lines, [0, 'ENDSEC']);

  return lines.join('\n');
}

// ========================================
// BLOCKSセクション
// ========================================

/**
 * DXF BLOCKSセクションを生成
 * @returns {string} DXFブロック文字列
 */
export function generateBlocks() {
  const lines = [];
  addPairs(lines, [0, 'SECTION'], [2, 'BLOCKS'], [0, 'ENDSEC']);
  return lines.join('\n');
}

// ========================================
// ENTITIESセクション
// ========================================

/**
 * DXF LINE エンティティを生成（R12形式 - ハンドル・線種なし）
 * @param {Object} line - 線分情報 {start: {x, y}, end: {x, y}, layer: string}
 * @returns {string} DXF LINEエンティティ文字列
 */
export function generateLine(line) {
  const lines = [];
  addPairs(lines, [0, 'LINE'], [8, line.layer]);
  if (line.lineType && line.lineType !== 'CONTINUOUS') addPairs(lines, [6, line.lineType]);
  addPairs(
    lines,
    [10, line.start.x.toFixed(6)],
    [20, line.start.y.toFixed(6)],
    [30, '0.0'],
    [11, line.end.x.toFixed(6)],
    [21, line.end.y.toFixed(6)],
    [31, '0.0'],
  );
  return lines.join('\n');
}

/**
 * DXF TEXT エンティティを生成（R12形式 - ハンドル・線種なし）
 * @param {Object} text - テキスト情報 {position: {x, y}, text: string, layer: string, height: number}
 * @returns {string} DXF TEXTエンティティ文字列
 */
export function generateText(text) {
  const lines = [];
  const height = Number.isFinite(text.height) && text.height > 0 ? text.height : 200;
  addPairs(
    lines,
    [0, 'TEXT'],
    [8, text.layer],
    [10, text.position.x.toFixed(6)],
    [20, text.position.y.toFixed(6)],
    [30, '0.0'],
    [40, height.toFixed(6)],
    [1, text.text],
    [7, 'STANDARD'],
  );

  if (Number.isFinite(text.rotation) && Math.abs(text.rotation) > 1e-12) {
    addPairs(lines, [50, text.rotation.toFixed(6)]);
  }
  const obliqueDeg = text.obliqueDeg == null ? 0 : Number(text.obliqueDeg);
  if (!Number.isFinite(obliqueDeg)) throw new RangeError('DXF TEXTの斜体角が不正です。');
  if (Math.abs(obliqueDeg) > 1e-12) addPairs(lines, [51, obliqueDeg.toFixed(6)]);
  if (
    Number.isFinite(text.widthFactor) &&
    text.widthFactor > 0 &&
    Math.abs(text.widthFactor - 1) > 1e-12
  ) {
    addPairs(lines, [41, text.widthFactor.toFixed(6)]);
  }
  const generationFlags = Number(text.generationFlags || 0);
  if (!Number.isInteger(generationFlags) || generationFlags < 0 || (generationFlags & ~6) !== 0)
    throw new RangeError('DXF TEXTの文字生成フラグが不正です。');
  if (generationFlags !== 0) addPairs(lines, [71, generationFlags]);

  if (text.anchor != null || text.verticalAlign != null) {
    const horizontal = { left: 0, start: 0, center: 1, middle: 1, right: 2, end: 2 }[
      text.anchor || 'left'
    ];
    const vertical = { baseline: 0, bottom: 1, middle: 2, center: 2, top: 3 }[
      text.verticalAlign || 'baseline'
    ];
    if (horizontal == null || vertical == null)
      throw new RangeError('DXF TEXTの文字揃え指定が不正です。');
    addPairs(
      lines,
      [72, horizontal],
      [73, vertical],
      [11, text.position.x.toFixed(6)],
      [21, text.position.y.toFixed(6)],
      [31, '0.0'],
    );
  }
  return lines.join('\n');
}

/**
 * DXF CIRCLE エンティティを生成（R12形式）
 * @param {Object} circle - 円情報 {center: {x, y}, radius: number, layer: string}
 * @returns {string} DXF CIRCLEエンティティ文字列
 */
export function generateCircle(circle) {
  const lines = [];
  addPairs(lines, [0, 'CIRCLE'], [8, circle.layer]);
  if (circle.lineType && circle.lineType !== 'CONTINUOUS') addPairs(lines, [6, circle.lineType]);
  addPairs(
    lines,
    [10, circle.center.x.toFixed(6)],
    [20, circle.center.y.toFixed(6)],
    [30, '0.0'],
    [40, circle.radius.toFixed(6)],
  );
  return lines.join('\n');
}

/**
 * DXF ARC エンティティを生成（R12形式）。
 * DXF ARCは開始角→終了角を反時計回りで表す。
 * @param {Object} arc - {center:{x,y},radius,startAngle,endAngle,layer}
 * @returns {string}
 */
export function generateArc(arc) {
  const lines = [];
  addPairs(lines, [0, 'ARC'], [8, arc.layer]);
  if (arc.lineType && arc.lineType !== 'CONTINUOUS') addPairs(lines, [6, arc.lineType]);
  addPairs(
    lines,
    [10, arc.center.x.toFixed(6)],
    [20, arc.center.y.toFixed(6)],
    [30, '0.0'],
    [40, arc.radius.toFixed(6)],
    [50, arc.startAngle.toFixed(6)],
    [51, arc.endAngle.toFixed(6)],
  );
  return lines.join('\n');
}

/**
 * DXF ENTITIESセクションを生成
 * @param {Array} lines2D - 2D線分の配列
 * @param {Array} texts2D - 2Dテキストの配列（オプション）
 * @param {Array} circles2D - 2D円の配列（オプション）
 * @returns {string} DXFエンティティ文字列
 */
export function generateEntities(lines2D, texts2D = [], circles2D = []) {
  const entityStrings = [];

  addPairs(entityStrings, [0, 'SECTION'], [2, 'ENTITIES']);

  // 線分を出力
  for (const line of lines2D) {
    entityStrings.push(generateLine(line));
  }

  // 円を出力
  for (const circle of circles2D) {
    entityStrings.push(generateCircle(circle));
  }

  // テキスト（ラベル）を出力
  for (const text of texts2D) {
    entityStrings.push(generateText(text));
  }

  addPairs(entityStrings, [0, 'ENDSEC']);
  return entityStrings.join('\n');
}

// ========================================
// メイン生成関数
// ========================================

/**
 * DXFコンテンツ全体を生成
 * @param {Object} bounds - モデルのバウンド
 * @param {Array<string>} layers - レイヤー一覧
 * @param {Array} lines2D - 2D線分の配列
 * @param {Array} texts2D - 2Dテキストの配列
 * @param {Array} circles2D - 2D円の配列（オプション）
 * @returns {string} 完全なDXFファイル内容
 */
export function generateDxfContent(
  bounds,
  layers,
  lines2D,
  texts2D = [],
  circles2D = [],
  options = {},
) {
  // ハンドルをリセット
  resetHandles();

  const sections = [
    generateHeader(bounds),
    generateTables(layers, texts2D.length > 0, bounds, [], options.textStyle),
    generateBlocks(),
    generateEntities(lines2D, texts2D, circles2D),
    dxfPair(0, 'EOF'),
  ];

  return sections.join('\n');
}

// ========================================
// ダウンロード機能
// ========================================

/**
 * DXF出力名を正規化する。UI入力に拡張子が含まれていても二重付与しない。
 * @param {string} filename - 入力ファイル名
 * @returns {string} .dxf付きファイル名
 */
export function normalizeDxfFilename(filename) {
  const value = String(filename ?? '').trim() || 'stb_export';
  return /\.dxf$/i.test(value) ? value : `${value}.dxf`;
}

/**
 * DXF文字列から保存用Blobを作成する。
 * AutoCAD R12はASCII + \\U+XXXX、Jw_cad R12はShift-JIS実バイトを使用する。
 * @param {string} content
 * @param {{profile?: string}} [options]
 * @returns {Promise<Blob>}
 */
export async function createDxfBlob(content, options = {}) {
  const profile = normalizeDxfOutputProfile(options.profile);
  if (profile !== DXF_OUTPUT_PROFILES.JWCAD_R12) {
    return new Blob([content], { type: 'application/dxf;charset=us-ascii' });
  }

  const { default: Encoding } = await import('encoding-japanese');
  // 欠損値のem dashはShift-JISにないため、同形のJIS横棒へ置換する。
  const unicodeContent = decodeR12UnicodeEscapes(content).replace(/\u2014/g, '\u2015');
  const unicodeArray = Encoding.stringToCode(unicodeContent);
  const sjisArray = Encoding.convert(unicodeArray, {
    to: 'SJIS',
    from: 'UNICODE',
    type: 'array',
  });
  return new Blob([new Uint8Array(sjisArray)], { type: 'application/dxf;charset=shift-jis' });
}

/**
 * DXFファイルをダウンロード
 * @param {string} content - DXFファイル内容
 * @param {string} filename - ファイル名（.dxf有無どちらも可）
 * @param {FileSystemDirectoryHandle} [directoryHandle] - 保存先フォルダ
 * @param {{profile?: string}} [options] - 出力互換プロファイル
 * @returns {Promise<boolean>} 保存成功フラグ
 */
export async function downloadDxf(content, filename, directoryHandle = null, options = {}) {
  const outputFilename = normalizeDxfFilename(filename);
  const blob = await createDxfBlob(content, options);

  // File System Access APIを使った保存
  if (directoryHandle) {
    try {
      const fileHandle = await directoryHandle.getFileHandle(outputFilename, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (error) {
      log.error('[DxfFormatWriter] File System Access APIでの保存エラー:', error);
      // フォールバック: 通常のダウンロード
    }
  }

  downloadBlob(blob, outputFilename);
  return true;
}
