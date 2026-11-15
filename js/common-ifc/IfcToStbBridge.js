/**
 * @fileoverview IFC → STB DOM 変換ブリッジ
 *
 * ブラウザの File オブジェクトから IFC を読み込み、
 * STB XML DOM Document に変換して返す。
 * 既存の STB パーサー・比較・描画パイプラインにそのまま投入可能。
 *
 * @module IfcToStbBridge
 */

import { IfcToStbBrowserConverter } from './IfcToStbBrowserConverter.js';
import {
  SOURCE_TYPES,
  IMPORT_STAGES,
  createImportMetadata,
} from '../common-stb/import/constants/importTypes.js';

/** IFC変換パイプラインのステージ → 進捗率マッピング */
const STAGE_PROGRESS = {
  'IFCエンジンを初期化中...': { stage: IMPORT_STAGES.READING, progress: 10 },
  'IFCモデルを解析中...': { stage: IMPORT_STAGES.PARSING, progress: 30 },
  '階情報を抽出中...': { stage: IMPORT_STAGES.EXTRACTING, progress: 50 },
  '構造要素を分類中...': { stage: IMPORT_STAGES.EXTRACTING, progress: 60 },
  '断面を解析中...': { stage: IMPORT_STAGES.EXTRACTING, progress: 70 },
};

/**
 * IFC File を STB XML DOM Document に変換
 * @param {File} file - ブラウザの File オブジェクト
 * @param {Object} [options]
 * @param {function} [options.onProgress] - 進捗コールバック ({stage, progress, message}) => void
 * @returns {Promise<import('../common-stb/import/constants/importTypes.js').ImportResult>}
 */
export async function convertIfcToStbDocument(file, options = {}) {
  const { onProgress } = options;

  /** 内部進捗メッセージを統一形式に変換 */
  const wrappedProgress = onProgress
    ? (message) => {
        const mapped = STAGE_PROGRESS[message] || { stage: IMPORT_STAGES.CONVERTING, progress: 80 };
        onProgress({ ...mapped, message });
      }
    : undefined;

  if (onProgress)
    onProgress({
      stage: IMPORT_STAGES.READING,
      progress: 0,
      message: 'IFCファイルを読み込み中...',
    });
  const arrayBuffer = await file.arrayBuffer();

  const converter = new IfcToStbBrowserConverter({
    onProgress: wrappedProgress,
  });

  try {
    await converter.init();
    const { xml, schema, summary } = await converter.convert(arrayBuffer);

    if (onProgress)
      onProgress({ stage: IMPORT_STAGES.LOADING, progress: 90, message: 'XMLを構築中...' });
    const parser = new DOMParser();
    const document = parser.parseFromString(xml, 'application/xml');

    // パースエラーチェック
    const parseError = document.querySelector('parsererror');
    if (parseError) {
      throw new Error(`IFC→STB変換結果のXMLパースに失敗しました: ${parseError.textContent}`);
    }

    if (onProgress) onProgress({ stage: IMPORT_STAGES.DONE, progress: 100, message: '変換完了' });

    return {
      document,
      metadata: createImportMetadata(SOURCE_TYPES.IFC, {
        ifcSchema: schema || null,
        ifcDiagnostics: summary.restorationDiagnostics,
      }),
    };
  } finally {
    converter.close();
  }
}
