/**
 * @fileoverview ST-Bridge バリデーション・修復システム エントリーポイント
 *
 * ST-Bridgeファイルのバリデーション、修復機能を提供します。
 *
 * 主な機能:
 * - validateStbDocument: ドキュメント全体のバリデーション
 * - StbRepairEngine: データ修復エンジン
 * - ValidationWorkflow: 完全なワークフロー管理
 */

// バリデーションエンジン
export {
  validateStbDocument,
  formatValidationReport,
  getRepairableIssues,
  getIssuesByCategory,
  getIssuesByElementType,
  logValidationSummary,
} from './stbValidator.js';

// バリデーション共通定数
export { SEVERITY, CATEGORY, SUGGESTION_TYPE } from './validationConstants.js';

// 修復エンジン
export {
  StbRepairEngine,
  formatRepairReport,
  autoRepairDocument,
  REPAIR_ACTION,
} from '../repair/stbRepairEngine.js';

// ワークフロー管理＆統合
export { ValidationManager, WORKFLOW_STEP } from './validationManager.js';
export {
  runCompleteWorkflow,
  generateIntegratedReport,
  quickRepair,
} from './validationWorkflow.js';

// 重要度設定検証
export {
  validateImportanceSettings,
  VALID_IMPORTANCE_LEVELS,
  IMPORTANCE_LEVEL_NAMES,
} from './importanceValidation.js';

// UI連携 (ValidationManager経由)
export {
  validateAndIntegrate,
  getElementValidation,
  getSectionValidation,
  getLastValidationResult,
  clearValidationData,
} from './validationManager.js';
export {
  generateValidationInfoHtml,
  generateValidationSummaryHtml,
  getValidationStyles,
} from './validationHtmlRenderer.js';

// JSON Schema + XSD parity スキーマ検証（メイン）
export { validateJsonSchema } from './jsonSchemaParityValidator.js';

// MVD必須属性バリデーション
export { validateMvdRequirements, initializeMvdData, isMvdDataLoaded } from './mvdValidator.js';

// XSDスキーマ検証（後方互換・テスト用）
export { validateXsdSchema } from './xsdSchemaValidator.js';

// ユーティリティ関数
export { quickValidate } from './stbValidator.js';

// processStbFile
export async function processStbFile(file, options = {}) {
  const { runCompleteWorkflow } = await import('./validationWorkflow.js');
  return runCompleteWorkflow(file, options);
}