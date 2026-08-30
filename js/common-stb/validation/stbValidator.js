/**
 * @fileoverview ST-Bridge包括的バリデーションエンジン（オーケストレータ）
 *
 * ST-Bridgeファイル全体を検証し、問題を検出・レポートします。
 * 各検証カテゴリの実装は validators/ 配下と validationReport.js に分割されており、
 * 本ファイルは検証フローの統合と公開APIの集約を担当します。
 *
 * 検証項目:
 * - 構造検証: 必須要素の存在、要素間参照の整合性
 * - データ検証: 座標値・寸法値の範囲、重複ID
 * - 幾何学的検証: 要素の妥当性チェック
 */

import { buildNodeMap, parseStories, parseAxes } from '../import/parser/stbXmlParser.js';
import { createLogger } from '../../utils/logger.js';
import { isSchemaLoaded, getActiveVersion } from '../import/parser/jsonSchemaLoader.js';
import { validateJsonSchema } from './jsonSchemaParityValidator.js';
import { validateMvdRequirements, initializeMvdData } from './mvdValidator.js';
import { SEVERITY, CATEGORY } from './validationConstants.js';
import {
  validateStructure,
  validateNodes,
  validateStories,
  validateAxes,
} from './validators/structureValidators.js';
import { validateElements } from './validators/elementValidators.js';
import {
  validateReferenceIntegrity,
  validateStructureKindConsistency,
} from './validators/referenceValidators.js';
import { validateGeometricConstraints } from './validators/geometryValidators.js';

// レポート整形・抽出ユーティリティは公開APIとして再export
export {
  formatValidationReport,
  getRepairableIssues,
  getIssuesByCategory,
  getIssuesByElementType,
  logValidationSummary,
} from './validationReport.js';

// モジュールロード時にバックグラウンドで MVD データのプリロードを開始
void initializeMvdData();

const logger = createLogger('validation:validator');

/**
 * バリデーション問題
 * @typedef {Object} ValidationIssue
 * @property {string} severity - 重要度 (error, warning, info)
 * @property {string} category - カテゴリ
 * @property {string} message - メッセージ
 * @property {string} elementType - 要素タイプ
 * @property {string} elementId - 要素ID
 * @property {string} attribute - 属性名（該当する場合）
 * @property {*} value - 現在の値
 * @property {*} expected - 期待される値
 * @property {string} xpath - 対象要素/属性の絶対XPath
 * @property {string} idXPath - id属性を持つ要素を起点にしたXPath
 * @property {boolean} repairable - 修復可能かどうか
 * @property {string} repairSuggestion - 修復提案
 */

/**
 * バリデーション結果
 * @typedef {Object} ValidationReport
 * @property {boolean} valid - 全体的な妥当性
 * @property {ValidationIssue[]} issues - 検出された問題
 * @property {Object} statistics - 統計情報
 * @property {Date} timestamp - 検証日時
 */

/**
 * ST-Bridgeドキュメント全体をバリデーション
 *
 * @param {Document} xmlDoc - パース済みXMLドキュメント
 * @param {Object} options - オプション
 * @param {boolean} options.validateReferences - 参照整合性チェックを実行
 * @param {boolean} options.validateGeometry - 幾何学検証を実行
 * @param {boolean} options.includeInfo - 情報レベルの問題を含める
 * @returns {ValidationReport} バリデーション結果
 */
export function validateStbDocument(xmlDoc, options = {}) {
  const {
    validateReferences = true,
    validateGeometry = true,
    validateSchema = true,
    includeInfo = false,
    mvdLevel = null,
  } = options;

  const issues = [];
  const statistics = {
    totalElements: 0,
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    elementCounts: {},
    repairableCount: 0,
  };

  const timestamp = new Date();

  if (!xmlDoc) {
    issues.push({
      severity: SEVERITY.ERROR,
      category: CATEGORY.STRUCTURE,
      message: 'XMLドキュメントがnullまたはundefinedです',
      elementType: 'Document',
      elementId: '',
      repairable: false,
    });
    return createReport(false, issues, statistics, timestamp);
  }

  // 0. JSON Schema + XSD parity 検証（オプション、スキーマ読込済みの場合のみ）
  if (validateSchema && isSchemaLoaded()) {
    try {
      const version = detectStbVersion(xmlDoc);
      const schemaIssues = validateJsonSchema(xmlDoc, { version });
      issues.push(...schemaIssues);
    } catch (e) {
      logger.warn(`JSON Schema/XSD parity検証中にエラーが発生: ${e.message}`);
    }
  }

  // 1. 構造検証
  validateStructure(xmlDoc, issues);

  // 2. ノード検証
  const nodeMap = buildNodeMap(xmlDoc);
  validateNodes(xmlDoc, nodeMap, issues, statistics);

  // 3. 階情報検証
  const stories = parseStories(xmlDoc);
  validateStories(stories, issues);

  // 4. 軸情報検証
  const axesData = parseAxes(xmlDoc);
  validateAxes(axesData, issues);

  // 5. 要素検証
  validateElements(xmlDoc, nodeMap, issues, statistics);

  // 6. 参照整合性検証
  if (validateReferences) {
    validateReferenceIntegrity(xmlDoc, nodeMap, issues, statistics);
  }

  // 7. IDM整合性検証（kind_structure と断面タグ種別の一致チェック）
  validateStructureKindConsistency(xmlDoc, issues);

  // 8. 幾何学検証
  if (validateGeometry) {
    validateGeometricConstraints(xmlDoc, nodeMap, issues);
  }

  // 9. MVD必須属性バリデーション
  if (mvdLevel === 's2' || mvdLevel === 's4') {
    try {
      const mvdIssues = validateMvdRequirements(xmlDoc, mvdLevel);
      issues.push(...mvdIssues);
    } catch (e) {
      logger.warn(`MVDバリデーション中にエラーが発生: ${e.message}`);
    }
  }

  // 統計情報の更新
  updateStatistics(issues, statistics);

  // 情報レベルの除外（オプション）
  const filteredIssues = includeInfo
    ? issues
    : issues.filter((issue) => issue.severity !== SEVERITY.INFO);

  const valid = !filteredIssues.some((issue) => issue.severity === SEVERITY.ERROR);

  return createReport(valid, filteredIssues, statistics, timestamp);
}

/**
 * 統計情報の更新
 */
function updateStatistics(issues, statistics) {
  for (const issue of issues) {
    switch (issue.severity) {
      case SEVERITY.ERROR:
        statistics.errorCount++;
        break;
      case SEVERITY.WARNING:
        statistics.warningCount++;
        break;
      case SEVERITY.INFO:
        statistics.infoCount++;
        break;
    }

    if (issue.repairable) {
      statistics.repairableCount++;
    }
  }
}

/**
 * バリデーションレポートの作成
 */
function createReport(valid, issues, statistics, timestamp) {
  return {
    valid,
    issues,
    statistics,
    timestamp,
  };
}

/**
 * 簡易バリデーション (デフォルトオプション付き)
 * @param {Document} xmlDoc
 * @param {Object} options
 * @returns {Object}
 */
export function quickValidate(xmlDoc, options = {}) {
  return validateStbDocument(xmlDoc, {
    validateReferences: true,
    validateGeometry: true,
    ...options,
  });
}

/**
 * XMLドキュメントからSTBバージョンを検出
 * @param {Document} xmlDoc - XMLドキュメント
 * @returns {string} バージョン文字列（デフォルト: アクティブバージョンまたは '2.0.2'）
 */
function detectStbVersion(xmlDoc) {
  const root = xmlDoc.documentElement;
  if (!root) return getActiveVersion() || '2.0.2';

  const version = root.getAttribute('version');
  if (version) {
    // JSON Schema バリデーション用に 2.1.1 を優先判定
    if (version.startsWith('2.1.1')) return '2.1.1';
    if (version.startsWith('2.1')) return '2.1.0';
    if (version.startsWith('2.0')) return '2.0.2';
  }

  return getActiveVersion() || '2.0.2';
}
