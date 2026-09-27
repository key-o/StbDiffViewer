/**
 * @fileoverview ファイルタイプ設定
 *
 * 対応するファイル形式の定義を一元管理します。
 * このファイルがファイルタイプ設定の単一の情報源（Single Source of Truth）です。
 *
 * @module config/fileTypeConfig
 */

// ============================================================================
// ファイルタイプ定義
// ============================================================================

/**
 * ファイルタイプ定義
 * @type {Array<Object>}
 */
export const FILE_TYPE_DEFINITIONS = [
  {
    id: 'stb',
    name: { ja: 'ST-Bridge', en: 'ST-Bridge' },
    description: {
      ja: '建築構造設計データ交換形式',
      en: 'Building structural design data exchange format',
    },
    extensions: ['.stb', '.xml'],
    mimeTypes: ['application/xml', 'text/xml'],
    magicBytes: [
      { offset: 0, bytes: [0x3c, 0x3f, 0x78, 0x6d, 0x6c] }, // "<?xml"
    ],
    encoding: ['UTF-8', 'Shift_JIS'],
    loader: 'StbXmlLoader',
    validator: 'validateStbStructure',
    priority: 10,
    icon: '📐',
    enabled: true,
  },
  {
    id: 'ifc',
    name: { ja: 'IFC', en: 'IFC' },
    description: {
      ja: '建築・建設業界標準データ交換形式',
      en: 'Industry Foundation Classes for BIM data exchange',
    },
    extensions: ['.ifc'],
    mimeTypes: ['application/x-step', 'application/octet-stream'],
    magicBytes: [],
    encoding: ['ASCII', 'UTF-8'],
    loader: 'IfcLoader',
    validator: 'validateIfcStructure',
    priority: 15,
    icon: '🏗️',
    enabled: true,
  },
  {
    id: 'dxf',
    name: { ja: 'DXF (AutoCAD)', en: 'DXF (AutoCAD)' },
    description: { ja: 'AutoCAD図面交換形式', en: 'AutoCAD Drawing Exchange Format' },
    extensions: ['.dxf'],
    mimeTypes: ['application/dxf', 'image/vnd.dxf'],
    magicBytes: [], // DXFはテキストベースでマジックバイト不定
    encoding: ['ASCII', 'UTF-8'],
    loader: 'DxfLoader',
    validator: 'validateDxfStructure',
    priority: 20,
    icon: '📏',
    enabled: false, // 将来実装予定
  },
];

// ============================================================================
// バリデーションルール
// ============================================================================

/**
 * ファイルバリデーションルール
 * @type {Object}
 */
const FILE_VALIDATION_RULES = {
  maxFileSize: 100 * 1024 * 1024, // 100MB
  allowedCategories: ['stb', 'ifc'],
  requireValidation: true,
  showWarningOnUnknownType: true,
};

// ============================================================================
// ヘルパー関数
// ============================================================================

/**
 * 有効なファイルタイプを取得
 * @returns {Array<Object>} 有効なファイルタイプの配列
 */
export function getEnabledFileTypes() {
  return FILE_TYPE_DEFINITIONS.filter((ft) => ft.enabled);
}

/**
 * 有効な拡張子リストを取得
 * @returns {string[]} 拡張子の配列（例: ['.stb', '.xml']）
 */
function getEnabledExtensions() {
  return getEnabledFileTypes().flatMap((ft) => ft.extensions);
}

/**
 * accept属性用の文字列を取得
 * @returns {string} accept属性値（例: '.stb,.xml'）
 */
export function getAcceptAttribute() {
  return getEnabledExtensions().join(',');
}

/**
 * ファイル拡張子からファイルタイプを取得
 * @param {string} filename - ファイル名
 * @returns {Object|null} ファイルタイプ定義、または見つからない場合はnull
 */
export function getFileTypeByExtension(filename) {
  if (!filename) return null;

  const ext = '.' + filename.split('.').pop().toLowerCase();

  for (const ft of FILE_TYPE_DEFINITIONS) {
    if (ft.extensions.includes(ext)) {
      return ft;
    }
  }

  return null;
}

/**
 * ファイルタイプIDからファイルタイプを取得
 * @param {string} typeId - ファイルタイプID
 * @returns {Object|null} ファイルタイプ定義
 */
export function getFileTypeById(typeId) {
  return FILE_TYPE_DEFINITIONS.find((ft) => ft.id === typeId) || null;
}

/**
 * ファイルが有効なタイプか検証
 * @param {File} file - ファイル
 * @returns {Object} 検証結果 { isValid, fileType, errors }
 */
export function validateFileType(file) {
  if (!file) {
    return { isValid: false, fileType: null, errors: ['ファイルが選択されていません'] };
  }

  // サイズチェック
  if (file.size > FILE_VALIDATION_RULES.maxFileSize) {
    const maxSizeMB = FILE_VALIDATION_RULES.maxFileSize / (1024 * 1024);
    return {
      isValid: false,
      fileType: null,
      errors: [`ファイルサイズが${maxSizeMB}MBを超えています`],
    };
  }

  // ファイルタイプ検出
  const fileType = getFileTypeByExtension(file.name);

  if (!fileType) {
    return {
      isValid: false,
      fileType: null,
      errors: ['未対応のファイル形式です'],
    };
  }

  // 有効なタイプかチェック
  if (!fileType.enabled) {
    return {
      isValid: false,
      fileType,
      errors: [`${fileType.name.ja}形式は現在サポートされていません`],
    };
  }

  return {
    isValid: true,
    fileType,
    errors: [],
  };
}

// ============================================================================
// デフォルトエクスポート
// ============================================================================

export default {
  FILE_TYPE_DEFINITIONS,
  FILE_VALIDATION_RULES,
  getEnabledFileTypes,
  getEnabledExtensions,
  getAcceptAttribute,
  getFileTypeByExtension,
  getFileTypeById,
  validateFileType,
};
