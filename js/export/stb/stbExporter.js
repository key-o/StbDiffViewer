/**
 * @fileoverview STBデータエクスポートモジュール（橋渡しファイル）
 *
 * 共通モジュール (common/stb/export) から StbDiffViewer 用インスタンスを生成し、
 * プロジェクト固有のバリデーション・ロガー・イベント通知を接続します。
 *
 * @module StbDiffViewer/export/stb/stbExporter
 */

import {
  validateElement,
  isSchemaLoaded,
} from '../../common-stb/import/parser/jsonSchemaLoader.js';
import { formatValidationReport } from '../../common-stb/validation/stbValidator.js';
import { formatRepairReport } from '../../common-stb/repair/stbRepairEngine.js';
import { createLogger } from '../../utils/logger.js';
import { eventBus, ExportEvents } from '../../data/events/index.js';
import {
  createStbExporter,
  formatXml,
  downloadStbFile,
  downloadTextFile,
} from '../../common-stb/export/stbExporter.js';

const log = createLogger('export:stb:stbExporter');
const exporter = createStbExporter({
  logger: {
    debug: (...args) => log.debug(...args),
    warn: (...args) => log.warn(...args),
    error: (...args) => log.error(...args),
  },
  validatorFunctions: {
    validateElement,
    isSchemaLoaded,
    formatValidationReport,
    formatRepairReport,
  },
});

function normalizeExportOptions(filenameOrOptions, options) {
  if (filenameOrOptions && typeof filenameOrOptions === 'object') {
    return filenameOrOptions;
  }
  if (typeof filenameOrOptions === 'string') {
    return { ...(options || {}), filename: filenameOrOptions };
  }
  return options || {};
}

/**
 * イベント発行ラッパー: エクスポート処理にSTARTED/COMPLETED/ERROR通知を付加する。
 * @param {string|undefined} fileName - 出力ファイル名
 * @param {() => Promise<any>} operation - エクスポート処理
 * @returns {Promise<any>} operationの戻り値
 */
async function runExportWithEvents(fileName, operation) {
  eventBus.emit(ExportEvents.STARTED, { type: 'stb', fileName });
  try {
    const result = await operation();
    eventBus.emit(ExportEvents.COMPLETED, { type: 'stb', fileName });
    return result;
  } catch (error) {
    eventBus.emit(ExportEvents.ERROR, { type: 'stb', fileName, error });
    throw error;
  }
}

async function exportStbDocument(doc, filenameOrOptions, options) {
  const exportOptions = normalizeExportOptions(filenameOrOptions, options);
  return runExportWithEvents(exportOptions.filename, () =>
    exporter.exportStbDocument(doc, exportOptions),
  );
}

async function exportValidatedStb(doc, filenameOrOptions, options) {
  const exportOptions = normalizeExportOptions(filenameOrOptions, options);
  return runExportWithEvents(exportOptions.filename, () =>
    exporter.exportValidatedStb(doc, exportOptions),
  );
}

export { exportStbDocument, exportValidatedStb, formatXml, downloadStbFile, downloadTextFile };

export const validateDocumentForExport = (doc) => exporter.validateDocumentForExport(doc);
export const generateModificationReport = (modifications) =>
  exporter.generateModificationReport(modifications);
