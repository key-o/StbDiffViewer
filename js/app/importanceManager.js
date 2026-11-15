/**
 * @fileoverview 重要度管理システム
 *
 * StbDiffCheckerの重要度判定機能をJavaScriptに移植した中核システム。
 * ST-Bridge要素の重要度設定、管理、検証を提供します。
 *
 * 定数は constants/importanceConstants.js、
 * パス正規化は data/importance/pathNormalizer.js、
 * CSV入出力は app/importance/csvSerializer.js、
 * 統計収集は app/importance/statisticsCollector.js、
 * MVDモード管理は app/importance/mvdModeManager.js、
 * 設定管理は app/importance/settingsManager.js、
 * 要素重要度評価は app/importance/comparisonConfig.js に分離。
 *
 * @module app/importanceManager
 */

import { IMPORTANCE_LEVELS } from '../constants/importanceLevels.js';
import {
  initializeXsdSchemas,
  getElementDefinition,
} from '../common-stb/import/parser/xsdSchemaParser.js';
import { createLogger } from '../utils/logger.js';

// 分離モジュールからインポート
import { MVD_MODES, STB_ELEMENT_TABS, TAB_PARENT_PATHS } from '../constants/importanceConstants.js';
import {
  normalizeImportancePath,
  shouldSkipImportancePath,
} from '../data/importance/pathNormalizer.js';
import {
  exportToCSV as csvExportToCSV,
  importFromCSV as csvImportFromCSV,
} from './importance/csvSerializer.js';
import { collectStatistics, resetFallbackStats } from './importance/statisticsCollector.js';

// 分離した内部モジュール
import {
  normalizeS4Level as _normalizeS4Level,
  getPriority as _getPriority,
  applyPatterns as _applyPatterns,
  ensurePathExistsInMvdSettings as _ensurePathExistsInMvdSettings,
  rebuildEffectiveImportanceSettings as _rebuildEffectiveImportanceSettings,
  getMvdImportanceLevel as _getMvdImportanceLevel,
  setMvdImportanceLevel as _setMvdImportanceLevel,
  initializeMvdSettings as _initializeMvdSettings,
  loadExternalConfig as _loadExternalConfig,
  getCurrentConfigId as _getCurrentConfigId,
  getCurrentConfigName as _getCurrentConfigName,
} from './importance/mvdModeManager.js';
import {
  loadDefaultSettings as _loadDefaultSettings,
  getImportanceLevel as _getImportanceLevel,
  setImportanceLevel as _setImportanceLevel,
  getAllImportanceSettings as _getAllImportanceSettings,
  notifySettingsChanged as _notifySettingsChanged,
  validateSettings as _validateSettings,
  resetToDefaults as _resetToDefaults,
} from './importance/settingsManager.js';
import {
  getElementImportance as _getElementImportance,
  exportToJSON as _exportToJSON,
  importFromJSON as _importFromJSON,
} from './importance/comparisonConfig.js';

const log = createLogger('app:importanceManager');

// STB_ELEMENT_TABSを再エクスポート（外部利用者の互換性維持）
export { STB_ELEMENT_TABS };

/**
 * 重要度管理システムのメインクラス
 */
class ImportanceManager {
  /** Keep generated settings of the displayed model intact during a provisional load. */
  beginReplacement() {
    const previous = { ...this };
    Object.assign(this, new ImportanceManager(), {
      currentConfigId: previous.currentConfigId,
      currentConfigName: previous.currentConfigName,
    });
    return { rollback: () => Object.assign(this, previous) };
  }

  constructor() {
    this.userImportanceSettings = new Map();
    this.mvdImportanceSettings = {
      [MVD_MODES.S2]: new Map(),
      [MVD_MODES.S4]: new Map(),
    };
    this.defaultMvdImportanceSettings = {
      [MVD_MODES.S2]: new Map(),
      [MVD_MODES.S4]: new Map(),
    };
    this.s2ParameterChecks = new Map();
    this.orderedElementPaths = [];
    this.elementPathsByTab = new Map();
    this.isInitialized = false;
    this.currentConfigId = MVD_MODES.COMBINED;
    this.currentConfigName = 'MVD 統合';
  }

  /**
   * 生成済みの重要度設定・パス情報をクリアする
   */
  resetGeneratedSettings() {
    this.userImportanceSettings.clear();
    this.mvdImportanceSettings = {
      [MVD_MODES.S2]: new Map(),
      [MVD_MODES.S4]: new Map(),
    };
    this.defaultMvdImportanceSettings = {
      [MVD_MODES.S2]: new Map(),
      [MVD_MODES.S4]: new Map(),
    };
    this.s2ParameterChecks.clear();
    this.orderedElementPaths = [];
    this.elementPathsByTab = new Map();
  }

  normalizePath(path) {
    const normalized = normalizeImportancePath(path);
    if (!normalized || shouldSkipImportancePath(normalized)) {
      return null;
    }
    return normalized;
  }

  /**
   * 既存パス群に合わせて、大小文字違いの重複パスを正規化する
   * @param {string} path
   * @returns {string|null}
   */
  resolveCanonicalPath(path) {
    const normalized = this.normalizePath(path);
    if (!normalized) return null;

    if (this.orderedElementPaths.includes(normalized)) {
      return normalized;
    }

    const lower = normalized.toLowerCase();
    const orderedMatch = this.orderedElementPaths.find((p) => p.toLowerCase() === lower);
    if (orderedMatch) {
      return orderedMatch;
    }

    for (const existingPath of this.mvdImportanceSettings[MVD_MODES.S2].keys()) {
      if (existingPath.toLowerCase() === lower) {
        return existingPath;
      }
    }
    for (const existingPath of this.mvdImportanceSettings[MVD_MODES.S4].keys()) {
      if (existingPath.toLowerCase() === lower) {
        return existingPath;
      }
    }

    return normalized;
  }

  /**
   * 重要度管理システムを初期化する
   * @param {string} _xsdContent - ST-Bridge XSDスキーマ内容
   * @returns {Promise<boolean>} 初期化成功フラグ
   */
  async initialize(_xsdContent = null, options = {}) {
    const { reset = false } = options;
    try {
      if (reset) {
        this.resetGeneratedSettings();
      }

      // XSD解析と設定生成を実行（デフォルト設定ロード含む）
      // ファイルからのXSDロードを試み、パラメータを補完します
      await this.parseXsdAndGenerateSettings(_xsdContent);

      this.isInitialized = true;
      this.notifySettingsChanged();

      return true;
    } catch (error) {
      log.error('重要度マネージャーの初期化に失敗しました:', error);
      return false;
    }
  }

  // --- MVDモード管理（mvdModeManager.jsに委譲） ---

  async initializeMvdSettings() {
    return _initializeMvdSettings(this);
  }

  normalizeS4Level(path, s2Level, s4Level) {
    return _normalizeS4Level(this, path, s2Level, s4Level);
  }

  getPriority(level) {
    return _getPriority(level);
  }

  applyPatterns(map, patterns, excludePaths) {
    return _applyPatterns(map, patterns, excludePaths);
  }

  ensurePathExistsInMvdSettings(path) {
    return _ensurePathExistsInMvdSettings(this, path);
  }

  rebuildEffectiveImportanceSettings() {
    return _rebuildEffectiveImportanceSettings(this);
  }

  getMvdImportanceLevel(elementPath, mvdMode) {
    return _getMvdImportanceLevel(this, elementPath, mvdMode);
  }

  setMvdImportanceLevel(elementPath, mvdMode, importanceLevel, options = {}) {
    return _setMvdImportanceLevel(this, elementPath, mvdMode, importanceLevel, options);
  }

  async loadExternalConfig(configId) {
    return _loadExternalConfig(this, configId);
  }

  getCurrentConfigId() {
    return _getCurrentConfigId(this);
  }

  getCurrentConfigName() {
    return _getCurrentConfigName(this);
  }

  // --- 設定管理（settingsManager.jsに委譲） ---

  async loadDefaultSettings() {
    return _loadDefaultSettings(this);
  }

  getImportanceLevel(elementPath) {
    return _getImportanceLevel(this, elementPath);
  }

  setImportanceLevel(elementPath, importanceLevel) {
    return _setImportanceLevel(this, elementPath, importanceLevel);
  }

  getAllImportanceSettings() {
    return _getAllImportanceSettings(this);
  }

  notifySettingsChanged() {
    return _notifySettingsChanged(this);
  }

  validateSettings() {
    return _validateSettings(this);
  }

  resetToDefaults() {
    return _resetToDefaults(this);
  }

  // --- 要素重要度評価・JSON入出力（comparisonConfig.jsに委譲） ---

  getElementImportance(element, elementType = null) {
    return _getElementImportance(this, element, elementType);
  }

  exportToJSON(mvdLevel = 'combined') {
    return _exportToJSON(this, mvdLevel);
  }

  importFromJSON(jsonContent) {
    return _importFromJSON(this, jsonContent);
  }

  // --- パスがXSDで必須かどうかを取得 ---

  /**
   * パスがXSDで必須かどうかを取得
   * @param {string} elementPath
   * @returns {{required: boolean, kind: 'attribute'|'element'|'unknown'}}
   */
  getSchemaRequirement(elementPath) {
    const normalizedPath = this.normalizePath(elementPath);
    if (!normalizedPath) {
      return { required: false, kind: 'unknown' };
    }

    const attrMarkerIndex = normalizedPath.lastIndexOf('/@');
    if (attrMarkerIndex < 0) {
      return { required: false, kind: 'element' };
    }

    const elementPathOnly = normalizedPath.slice(0, attrMarkerIndex);
    const attrName = normalizedPath.slice(attrMarkerIndex + 2);
    const elementName = elementPathOnly.split('/').filter(Boolean).pop();
    if (!elementName || !attrName) {
      return { required: false, kind: 'unknown' };
    }

    const elementDef = getElementDefinition(elementName);
    const attrDef = elementDef?.attributes?.get?.(attrName);
    if (!attrDef) {
      return { required: false, kind: 'attribute' };
    }

    return { required: !!attrDef.required, kind: 'attribute' };
  }

  // --- XSD解析・パス生成（初期化関連） ---

  /**
   * 要素階層からXPathパスを再帰的に生成する
   * @param {string} elementName - 要素名
   * @param {string} parentPath - 親要素のパス
   * @param {Object} elementDef - 要素定義 {name, attributes, children, documentation}
   * @param {Set<string>} [visitedPaths=new Set()] - 循環参照防止用の訪問済みパスセット
   * @param {number} [depth=0] - 現在の再帰深度
   * @returns {string[]} 生成されたXPathパスの配列
   */
  generatePathsFromHierarchy(
    elementName,
    parentPath,
    elementDef,
    visitedPaths = new Set(),
    depth = 0,
  ) {
    const paths = [];
    const normalizedParentPath =
      typeof parentPath === 'string' && parentPath.endsWith('/') && parentPath.length > 1
        ? parentPath.slice(0, -1)
        : parentPath;
    const parentEndsWithElementAtRoot =
      depth === 0 &&
      typeof normalizedParentPath === 'string' &&
      normalizedParentPath.toLowerCase().endsWith(`/${elementName.toLowerCase()}`);
    const currentPath = parentEndsWithElementAtRoot
      ? normalizedParentPath
      : `${normalizedParentPath}/${elementName}`;

    // 最大深度チェック（無限再帰防止）
    const MAX_DEPTH = 20;
    if (depth >= MAX_DEPTH) {
      log.warn(`[ImportanceManager] Max depth ${MAX_DEPTH} reached at: ${currentPath}`);
      return paths;
    }

    // 循環参照チェック：同じパスを2回訪問しない
    if (visitedPaths.has(currentPath)) {
      return paths;
    }
    visitedPaths.add(currentPath);

    // 0. 要素自体のパスを追加（重要！）
    paths.push(currentPath);

    // ref参照で解決された子要素はattributes/childrenが未設定の場合がある
    // その場合、getElementDefinitionで完全な定義を取得して補完する
    let resolvedDef = elementDef;
    if (!elementDef.attributes && !elementDef.children) {
      const fullDef = getElementDefinition(elementName);
      if (fullDef) {
        resolvedDef = fullDef;
      }
    }

    // 1. 属性パスを生成
    if (resolvedDef.attributes) {
      for (const [attrName] of resolvedDef.attributes) {
        paths.push(`${currentPath}/@${attrName}`);
      }
    }

    // 2. 子要素パスを再帰的に生成
    if (resolvedDef.children) {
      for (const [childName, childDef] of resolvedDef.children) {
        // 再帰呼び出しで子要素とその子孫のパスを取得
        const childPaths = this.generatePathsFromHierarchy(
          childName,
          currentPath,
          childDef,
          visitedPaths,
          depth + 1,
        );
        paths.push(...childPaths);
      }
    }

    return paths;
  }

  /**
   * XSDスキーマから要素パスを解析して重要度設定を生成する
   * @param {string} _xsdContent - XSDスキーマ内容
   */
  async parseXsdAndGenerateSettings(_xsdContent) {
    // デフォルト設定を先にロード
    await this.loadDefaultSettings();

    try {
      // XSDをロード
      const loaded = await initializeXsdSchemas();
      if (!loaded) {
        log.warn('XSDのロードに失敗しました。補完をスキップします。');
      } else {
        // 各タブについて、XSDから階層的にパスを生成
        for (const tab of STB_ELEMENT_TABS) {
          // xsdElemが定義されていればそれを使用、なければidを使用
          const elementId = tab.xsdElem || tab.id;
          const elementDef = getElementDefinition(elementId);

          if (elementDef) {
            if (!this.elementPathsByTab.has(tab.id)) {
              this.elementPathsByTab.set(tab.id, []);
            }
            const currentPaths = this.elementPathsByTab.get(tab.id);

            // TAB_PARENT_PATHSから正確な親パスを取得
            const parentPath = TAB_PARENT_PATHS[tab.id] || '//ST_BRIDGE/StbModel';

            // 階層から全パスを生成（循環参照防止のため新しいvisitedPathsセットを使用）
            const visitedPaths = new Set();
            const paths = this.generatePathsFromHierarchy(
              elementId,
              parentPath,
              elementDef,
              visitedPaths,
              0,
            );

            // 重複を排除してパスを追加
            const uniquePaths = [
              ...new Set(paths.map((p) => this.normalizePath(p)).filter(Boolean)),
            ];

            for (const path of uniquePaths) {
              // タブ別リストに追加（重複チェック）
              if (!currentPaths.includes(path)) {
                currentPaths.push(path);
              }
              // 全体リストに追加（重複チェック）
              if (!this.orderedElementPaths.includes(path)) {
                this.orderedElementPaths.push(path);
              }

              // 重要度設定がなければ追加
              if (!this.userImportanceSettings.has(path)) {
                // 属性はOPTIONAL、要素はREQUIRED
                const isAttribute = path.includes('/@');
                const level = isAttribute ? IMPORTANCE_LEVELS.OPTIONAL : IMPORTANCE_LEVELS.REQUIRED;
                this.userImportanceSettings.set(path, level);
              }
            }
          }
        }
      }
    } catch (error) {
      log.error('XSD解析と設定生成中にエラーが発生しました:', error);
    }

    await this.initializeMvdSettings();
  }

  // --- パス/タブユーティリティ ---

  /**
   * 指定されたタブIDの要素パスを生成する
   * @param {string} tabId - タブID
   * @returns {string[]} 要素パスの配列
   */
  generateElementPathsForTab(tabId) {
    const tab = STB_ELEMENT_TABS.find((item) => item.id === tabId);
    const baseElementName = tab?.xsdElem || tabId;

    // 基本的な要素パス生成ロジック
    // 実際のXSDパーサーとの統合時により詳細に実装
    const basePaths = [
      `//ST_BRIDGE/${baseElementName}`,
      `//ST_BRIDGE/${baseElementName}/@id`,
      `//ST_BRIDGE/${baseElementName}/@guid`,
      `//ST_BRIDGE/${baseElementName}/@name`,
    ];

    // 特定要素の追加属性
    const additionalPaths = this.getAdditionalPathsForElement(tabId);

    const normalizedPaths = [...basePaths, ...additionalPaths]
      .map((path) => this.normalizePath(path))
      .filter(Boolean);

    return [...new Set(normalizedPaths)];
  }

  /**
   * 要素タイプに応じた追加パスを取得する
   * @param {string} elementType - 要素タイプ
   * @returns {string[]} 追加パスの配列
   */
  getAdditionalPathsForElement(elementType) {
    const additionalPaths = {
      StbColumns: [
        '//ST_BRIDGE/StbColumns/StbColumn/@id_node_bottom',
        '//ST_BRIDGE/StbColumns/StbColumn/@id_node_top',
        '//ST_BRIDGE/StbColumns/StbColumn/@id_section',
        '//ST_BRIDGE/StbColumns/StbColumn/@rotate',
      ],
      StbGirders: [
        '//ST_BRIDGE/StbGirders/StbGirder/@id_node_start',
        '//ST_BRIDGE/StbGirders/StbGirder/@id_node_end',
        '//ST_BRIDGE/StbGirders/StbGirder/@id_section',
        '//ST_BRIDGE/StbGirders/StbGirder/@rotate',
      ],
      StbBeams: [
        '//ST_BRIDGE/StbBeams/StbBeam/@id_node_start',
        '//ST_BRIDGE/StbBeams/StbBeam/@id_node_end',
        '//ST_BRIDGE/StbBeams/StbBeam/@id_section',
        '//ST_BRIDGE/StbBeams/StbBeam/@rotate',
      ],
      StbNodes: [
        '//ST_BRIDGE/StbNodes/StbNode/@X',
        '//ST_BRIDGE/StbNodes/StbNode/@Y',
        '//ST_BRIDGE/StbNodes/StbNode/@Z',
      ],
    };

    return additionalPaths[elementType] || [];
  }

  /**
   * タブに対応するパス判定用セグメント一覧を生成する
   * @param {string} tabId - タブID
   * @returns {Set<string>} 判定用セグメント（小文字）
   */
  buildTabPathCandidates(tabId) {
    const tab = STB_ELEMENT_TABS.find((item) => item.id === tabId);
    const rawNames = new Set([tabId]);

    if (tab?.xsdElem) {
      rawNames.add(tab.xsdElem);
    }

    const candidates = new Set();
    rawNames.forEach((name) => {
      if (!name || typeof name !== 'string') return;

      const normalized = name.trim();
      if (!normalized) return;

      candidates.add(normalized.toLowerCase());

      if (normalized.endsWith('s') && normalized.length > 1) {
        candidates.add(normalized.slice(0, -1).toLowerCase());
      } else {
        candidates.add(`${normalized}s`.toLowerCase());
      }
    });

    return candidates;
  }

  /**
   * XPath文字列を要素セグメント配列に分解する
   * @param {string} path - XPath
   * @returns {string[]} 要素セグメント配列
   */
  extractPathElementSegments(path) {
    if (!path || typeof path !== 'string') {
      return [];
    }

    return path
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment && !segment.startsWith('@'))
      .map((segment) => segment.toLowerCase());
  }

  /**
   * XPathがタブ候補に一致するか判定する
   * @param {string} path - XPath
   * @param {Set<string>} candidates - 判定用セグメント
   * @returns {boolean} 一致する場合true
   */
  pathMatchesTab(path, candidates) {
    if (!candidates || candidates.size === 0) {
      return false;
    }

    const segments = this.extractPathElementSegments(path);

    // パスに /StbSections/ が含まれているかチェック
    const isInSectionsPath = path.includes('/StbSections/');

    return segments.some((segment) => {
      // 完全一致
      if (candidates.has(segment)) {
        return true;
      }

      // プレフィックス一致の場合、より厳密にチェック
      for (const candidate of candidates) {
        // StbSectionsパス内の要素は、セクション関連タブにのみマッチさせる
        if (isInSectionsPath) {
          // セクションタブ（StbSec*）の場合のみマッチ
          if (candidate.startsWith('stbsec') && segment.startsWith(`${candidate}_`)) {
            return true;
          }
          // セクションタブ以外では、完全一致のみ許可
          continue;
        }

        // StbSections外のパスでは、従来通りプレフィックスマッチを許可
        if (segment.startsWith(`${candidate}_`)) {
          return true;
        }
      }

      return false;
    });
  }

  /**
   * タブ別の要素パスを取得する
   * @param {string} tabId - タブID
   * @returns {string[]} 要素パスの配列
   */
  getElementPathsByTab(tabId) {
    const staticPaths = this.elementPathsByTab.get(tabId) || [];

    // TAB_PARENT_PATHSに定義された親パスを使用して、正確にフィルタリング
    const parentPath = TAB_PARENT_PATHS[tabId];
    const matchedPaths = new Set(staticPaths);

    if (parentPath) {
      // タブの要素名を取得
      const tab = STB_ELEMENT_TABS.find((t) => t.id === tabId);
      const tabElementName = tab?.xsdElem || tabId;

      // 実際のターゲットパス（親パス + タブ要素名）
      // parentPathが既にtabElementNameで終わっている場合は、重複を避ける
      let targetPrefix;
      if (parentPath.endsWith(`/${tabElementName}`)) {
        targetPrefix = parentPath;
      } else {
        targetPrefix = `${parentPath}/${tabElementName}`;
      }

      // ターゲットパス配下の要素のみを追加
      const allPaths = [...this.userImportanceSettings.keys()];
      for (const path of allPaths) {
        // targetPrefixで始まるか、targetPrefixと完全一致するパスのみ
        if (path === targetPrefix || path.startsWith(targetPrefix + '/')) {
          matchedPaths.add(path);
        }
      }
    } else {
      // フォールバック: 従来のマッチングロジック
      const candidates = this.buildTabPathCandidates(tabId);
      const allPaths = [...this.userImportanceSettings.keys()];
      for (const path of allPaths) {
        if (this.pathMatchesTab(path, candidates)) {
          matchedPaths.add(path);
        }
      }
    }

    const ordered = [];
    const seen = new Set();
    const pushOrdered = (path) => {
      if (matchedPaths.has(path) && !seen.has(path)) {
        ordered.push(path);
        seen.add(path);
      }
    };

    this.orderedElementPaths.forEach(pushOrdered);
    matchedPaths.forEach(pushOrdered);

    return ordered;
  }

  // --- CSV入出力（csvSerializer.jsに委譲） ---

  /**
   * 重要度設定をCSV形式でエクスポートする
   * @returns {string} CSV形式の文字列
   */
  exportToCSV() {
    return csvExportToCSV(
      this.orderedElementPaths,
      (path, mode) => this.getMvdImportanceLevel(path, mode),
      (path) => this.getImportanceLevel(path),
    );
  }

  /**
   * CSV形式の重要度設定をインポートする
   * @param {string} csvContent - CSV形式の文字列
   * @returns {boolean} インポート成功フラグ
   */
  importFromCSV(csvContent) {
    return csvImportFromCSV(
      csvContent,
      (path, mode, level, opts) => this.setMvdImportanceLevel(path, mode, level, opts),
      () => this.rebuildEffectiveImportanceSettings(),
      () => this.notifySettingsChanged(),
      log,
    );
  }

  // --- 統計（statisticsCollector.jsに委譲） ---

  /**
   * 統計情報を取得する
   * @returns {Object} 統計情報
   */
  getStatistics() {
    return collectStatistics(
      this.orderedElementPaths,
      this.userImportanceSettings,
      (path, mode) => this.getMvdImportanceLevel(path, mode),
      (path) => this.getSchemaRequirement(path),
    );
  }

  /**
   * フォールバック統計をリセット
   */
  resetFallbackStats() {
    resetFallbackStats();
  }
}

// シングルトンインスタンス
let importanceManagerInstance = null;

/**
 * ImportanceManagerのシングルトンインスタンスを取得する
 * @returns {ImportanceManager} インスタンス
 */
export function getImportanceManager() {
  if (!importanceManagerInstance) {
    importanceManagerInstance = new ImportanceManager();
  }
  return importanceManagerInstance;
}

/**
 * 重要度管理システムを初期化する
 * @param {string} xsdContent - XSDスキーマ内容（オプション）
 * @returns {Promise<ImportanceManager>} 初期化済みのインスタンス
 */
export async function initializeImportanceManager(xsdContent = null) {
  const manager = getImportanceManager();

  // XSDコンテンツが提供されていない場合、スキーマファイルを読み込む
  if (!xsdContent) {
    try {
      const response = await fetch('./schemas/ST-Bridge202.xsd');
      if (response.ok) {
        xsdContent = await response.text();
        log.info('XSDスキーマを読み込みました: schemas/ST-Bridge202.xsd');
      }
    } catch (error) {
      log.warn('XSDスキーマの読み込みに失敗しました:', error);
    }
  }

  await manager.initialize(xsdContent);
  return manager;
}

// デフォルトエクスポート
export default ImportanceManager;
