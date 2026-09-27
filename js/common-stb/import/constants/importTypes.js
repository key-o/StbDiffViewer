/**
 * @fileoverview インポーター共通型定義
 *
 * 各種インポーター（STB/IFC）が返す統一インターフェースを定義します。
 *
 * @module constants/importTypes
 */

/**
 * インポート元の種別
 * @readonly
 * @enum {string}
 */
export const SOURCE_TYPES = Object.freeze({
  STB: 'stb',
  IFC: 'ifc',
});

/**
 * インポート進捗のステージ名
 * @readonly
 * @enum {string}
 */
export const IMPORT_STAGES = Object.freeze({
  READING: 'reading',
  PARSING: 'parsing',
  EXTRACTING: 'extracting',
  CONVERTING: 'converting',
  LOADING: 'loading',
  VALIDATING: 'validating',
  DONE: 'done',
});

/**
 * @typedef {Object} ImportMetadata
 * @property {string} sourceType - インポート元種別 (SOURCE_TYPES)
 * @property {string|null} [ifcSchema] - IFCスキーマ名 (IFC読み込み時のみ)
 * @property {Object|null} [calData] - 計算データ
 */

/**
 * @typedef {Object} ImportResult
 * @property {XMLDocument} document - STB XML DOM Document
 * @property {ImportMetadata} metadata - インポートメタデータ
 */

/**
 * @typedef {Object} ImportProgress
 * @property {string} stage - 現在のステージ名 (IMPORT_STAGES)
 * @property {number} progress - 進捗率 (0-100)
 * @property {string} [message] - 表示用メッセージ
 */

/**
 * 空のImportMetadataを生成するヘルパー
 * @param {string} sourceType - SOURCE_TYPES のいずれか
 * @param {Object} [extra] - 追加プロパティ
 * @returns {ImportMetadata}
 */
export function createImportMetadata(sourceType, extra = {}) {
  return {
    sourceType,
    ifcSchema: null,
    calData: null,
    ...extra,
  };
}
