/**
 * @fileoverview 重要度設定ローダー
 */

import { IMPORTANCE_LEVELS } from '../constants/importanceLevels.js';
import { resolveRuntimeAssetUrl } from './runtimeAssetUrl.js';

// R3: config/ は最下層のため utils/logger を import せず console を直接使用する

/**
 * 利用可能な設定ファイル一覧
 * mvd-s2.json / mvd-s4.json は新フォーマット（要素名→属性リスト）
 */
export const AVAILABLE_CONFIGS = [
  {
    id: 'mvd-combined',
    name: 'MVD 統合',
    path: () =>
      resolveRuntimeAssetUrl(
        'config/importance-mvd-combined.json',
        '../../config/importance-mvd-combined.json',
        import.meta.url,
      ),
    description: 'S2/S4 の統合設定',
  },
  {
    id: 's2',
    name: 'MVD S2 (必須)',
    path: () =>
      resolveRuntimeAssetUrl('config/mvd-s2.json', '../../config/mvd-s2.json', import.meta.url),
    description: 'MVD S2 - 通り芯上での配置・大体の部材サイズ確認',
  },
  {
    id: 's4',
    name: 'MVD S4 (任意)',
    path: () =>
      resolveRuntimeAssetUrl('config/mvd-s4.json', '../../config/mvd-s4.json', import.meta.url),
    description: 'MVD S4 - 入力可能な決定項目',
  },
];

/**
 * 外部JSONファイルから重要度設定を読み込む
 *
 * 新フォーマット（version: "1.0"）:
 *   { elements: { StbColumn: { required: ["id", "guid", ...] } } }
 *   → settings に XPath 形式へ変換して返す
 *
 * 旧フォーマット:
 *   { settings: { "//ST_BRIDGE/.../@attr": "required" } }
 *   → そのまま返す
 *
 * @param {string} configPath - 設定ファイルのパス
 * @returns {Promise<Object>} 設定オブジェクト
 */
export async function loadImportanceConfig(configPath) {
  try {
    const response = await fetch(configPath);
    if (!response.ok) {
      throw new Error(`設定ファイルの読み込みに失敗: ${response.status}`);
    }
    const config = await response.json();

    // 新フォーマット判定
    if (config.version === '1.0' && config.elements) {
      return loadNewFormatConfig(config);
    }

    // 旧フォーマット（後方互換）
    return loadLegacyFormatConfig(config);
  } catch (error) {
    console.error('[ImportanceConfigLoader] 設定ファイルの読み込みエラー:', error);
    throw error;
  }
}

/**
 * 新フォーマット設定を読み込む
 * elements: { StbColumn: { required: ["id", "guid"] } } → settings Map
 * @param {Object} config
 * @returns {Object}
 */
function loadNewFormatConfig(config) {
  // elements から XPath 形式の settings を生成
  // キー: "//ST_BRIDGE/{ElementName}/@{attrName}"
  // 値: IMPORTANCE_LEVELS.REQUIRED
  const settings = {};
  for (const [elementName, elementDef] of Object.entries(config.elements || {})) {
    const targetAttrs = [...(elementDef.required || []), ...(elementDef.conditional || [])];
    for (const attrName of targetAttrs) {
      const path = `//ST_BRIDGE/${elementName}/@${attrName}`;
      settings[path] = IMPORTANCE_LEVELS.REQUIRED;
    }
  }

  return {
    name: config.description || `MVD ${config.mvdLevel?.toUpperCase() || ''}`,
    description: config.description || '',
    defaultLevel: IMPORTANCE_LEVELS.OPTIONAL,
    patterns: [],
    settings,
    parameterChecks: {},
    // 新フォーマット固有のデータも保持（将来の拡張用）
    elements: config.elements,
    mvdLevel: config.mvdLevel,
    schemaVersion: config.schemaVersion,
  };
}

/**
 * 旧フォーマット設定を読み込む（後方互換）
 * @param {Object} config
 * @returns {Object}
 */
function loadLegacyFormatConfig(config) {
  const normalizedSettings = {};
  for (const [path, level] of Object.entries(config.settings || {})) {
    normalizedSettings[path] = normalizeImportanceLevel(level);
  }

  const normalizedPatterns = [];
  if (config.patterns) {
    for (const [pattern, level] of Object.entries(config.patterns)) {
      normalizedPatterns.push({
        contains: pattern,
        level: normalizeImportanceLevel(level),
      });
    }
  }

  const normalizedParameterChecks = {};
  if (config.parameterChecks && typeof config.parameterChecks === 'object') {
    for (const [path, options] of Object.entries(config.parameterChecks)) {
      normalizedParameterChecks[path] = normalizeParameterCheckOptions(options);
    }
  }

  return {
    name: config.name || 'カスタム設定',
    description: config.description || '',
    defaultLevel: normalizeImportanceLevel(config.defaultLevel || 'optional'),
    patterns: normalizedPatterns,
    settings: normalizedSettings,
    parameterChecks: normalizedParameterChecks,
  };
}

/**
 * 重要度レベル文字列を正規化
 * @param {string} level - 重要度レベル文字列
 * @returns {string} 正規化された重要度レベル
 */
function normalizeImportanceLevel(level) {
  if (typeof level !== 'string') {
    return IMPORTANCE_LEVELS.OPTIONAL;
  }

  const levelMap = {
    required: IMPORTANCE_LEVELS.REQUIRED,
    optional: IMPORTANCE_LEVELS.OPTIONAL,
    unnecessary: IMPORTANCE_LEVELS.UNNECESSARY,
    notapplicable: IMPORTANCE_LEVELS.NOT_APPLICABLE,
    not_applicable: IMPORTANCE_LEVELS.NOT_APPLICABLE,
  };
  return levelMap[level.toLowerCase()] || IMPORTANCE_LEVELS.OPTIONAL;
}

/**
 * S2パラメータチェック設定を正規化
 * @param {boolean|Object} options
 * @returns {{checkRequired: boolean, checkValue: boolean}}
 */
function normalizeParameterCheckOptions(options) {
  if (options === false) {
    return { checkRequired: false, checkValue: false };
  }

  if (!options || typeof options !== 'object') {
    return { checkRequired: true, checkValue: true };
  }

  return {
    checkRequired: options.checkRequired !== false,
    checkValue: options.checkValue !== false,
  };
}

/**
 * 設定IDから設定ファイルを読み込む
 * @param {string} configId - 設定ID（'mvd-combined', 's2', 's4'など）
 * @returns {Promise<Object>} 設定オブジェクト
 */
export async function loadConfigById(configId) {
  const configInfo = AVAILABLE_CONFIGS.find((c) => c.id === configId);
  if (!configInfo) {
    throw new Error(`不明な設定ID: ${configId}`);
  }

  const configPath = typeof configInfo.path === 'function' ? configInfo.path() : configInfo.path;
  const config = await loadImportanceConfig(configPath);

  return config;
}

/**
 * デフォルト設定（MVD統合）を読み込む
 * @returns {Promise<Object>} 設定オブジェクト
 */
export async function loadDefaultConfig() {
  return loadConfigById('mvd-combined');
}
