/**
 * @fileoverview STBデータエクスポートモジュール（統合版）
 *
 * 編集されたSTBデータをXMLファイルとしてエクスポートする機能を提供します。
 * 依存関係は createStbExporter() の生成時に固定し、モジュールスコープの可変DIを持ちません。
 *
 * @module common/stb/export/stbExporter
 */

import { formatXml, downloadStbFile, downloadTextFile } from './xmlFormatter.js';
import { normalizeStbVersion, isStb21x } from '../version/stbVersion.js';
import { createLogger } from '../../utils/logger.js';

const _log = createLogger('common-stb:export:stbExporter');

/** @typedef {{debug: (...args: any[]) => void, warn: (...args: any[]) => void, error: (...args: any[]) => void}} ExportLogger */
/** @typedef {{valid: boolean, errors?: Array<any>, message?: string, elementId?: string, elementType?: string}} ValidationResult */
/** @typedef {{validateElement: (elementType: string, attributes: Object) => ValidationResult, isSchemaLoaded: () => boolean, formatValidationReport: (report: any) => string, formatRepairReport: (report: any) => string}} ValidatorFunctions */
/** @typedef {{filename?: string, targetVersion?: string|null, fileHandle?: FileSystemFileHandle|null}} ExportStbDocumentOptions */
/** @typedef {{filename?: string, validationReport?: Object|null, repairReport?: Object|null, includeReport?: boolean, fileHandle?: FileSystemFileHandle|null}} ExportValidatedStbOptions */

/** @type {ExportLogger} */
const defaultLogger = Object.freeze({
  debug: (...args) => _log.debug(...args),
  warn: (...args) => _log.warn(...args),
  error: (...args) => _log.error(...args),
});

/** @type {ValidatorFunctions} */
const defaultValidatorFunctions = Object.freeze({
  validateElement: (_elementType, _attributes) => ({ valid: true }),
  isSchemaLoaded: () => false,
  formatValidationReport: (report) => JSON.stringify(report, null, 2),
  formatRepairReport: (report) => JSON.stringify(report, null, 2),
});

/**
 * STB exporter の独立インスタンスを生成する。
 * logger / validatorFunctions は生成時に閉じ込められ、他インスタンスへ影響しない。
 *
 * @param {{logger?: Partial<ExportLogger>, validatorFunctions?: Partial<ValidatorFunctions>}} [dependencies]
 * @returns {{
 *   exportStbDocument: (doc: Document, options?: ExportStbDocumentOptions) => Promise<true>,
 *   validateDocumentForExport: (doc: Document) => Object,
 *   generateModificationReport: (modifications: Array<Object>) => string,
 *   exportValidatedStb: (doc: Document, options?: ExportValidatedStbOptions) => Promise<true>
 * }}
 */
export function createStbExporter({
  logger: customLogger = {},
  validatorFunctions: customValidators = {},
} = {}) {
  const logger = Object.freeze({ ...defaultLogger, ...customLogger });
  const validatorFunctions = Object.freeze({
    ...defaultValidatorFunctions,
    ...customValidators,
  });

  async function exportStbDocument(doc, options = {}) {
    try {
      const { filename = 'export.stb', targetVersion = null, fileHandle = null } = options;
      const exportDoc = /** @type {Document} */ (doc.cloneNode(true));

      if (targetVersion) applyVersionOverrides(exportDoc, targetVersion);

      const serializer = new XMLSerializer();
      const xmlString = serializer.serializeToString(exportDoc);
      const formattedXml = formatXml(xmlString);

      await downloadStbFile(formattedXml, filename, { fileHandle });
      return true;
    } catch (error) {
      logger.error('Error exporting STB document:', error);
      throw error;
    }
  }

  function validateDocumentForExport(doc) {
    if (!validatorFunctions.isSchemaLoaded()) {
      return {
        valid: true,
        message: 'XSDスキーマが読み込まれていないため、バリデーションをスキップしました',
      };
    }

    const issues = [];
    const stbElements = doc.querySelectorAll('[id]');
    stbElements.forEach((element) => {
      const tagName = element.tagName;
      if (!tagName.startsWith('Stb')) return;

      const id = element.getAttribute('id');
      const attributes = {};
      for (const attr of Array.from(element.attributes)) {
        attributes[attr.name] = attr.value;
      }

      const validation = validatorFunctions.validateElement(tagName, attributes);
      if (!validation.valid) {
        issues.push({
          elementType: tagName,
          elementId: id,
          errors: validation.errors,
        });
      }
    });

    return {
      valid: issues.length === 0,
      issues,
      message:
        issues.length === 0
          ? '全ての要素がXSDスキーマに適合しています'
          : `${issues.length}個の要素にバリデーションエラーがあります`,
    };
  }

  function generateIntegratedExportReport(validationReport, repairReport) {
    let report = '';
    report += '='.repeat(60) + '\n';
    report += 'ST-Bridge エクスポートレポート\n';
    report += '='.repeat(60) + '\n';
    report += `生成日時: ${new Date().toLocaleString('ja-JP')}\n\n`;

    if (validationReport) {
      report += `${validatorFunctions.formatValidationReport(validationReport)}\n\n`;
    }
    if (repairReport) {
      report += `${validatorFunctions.formatRepairReport(repairReport)}\n\n`;
    }
    return report;
  }

  async function exportValidatedStb(doc, options = {}) {
    try {
      const {
        filename = 'validated.stb',
        validationReport = null,
        repairReport = null,
        includeReport = false,
        fileHandle = null,
      } = options;

      const serializer = new XMLSerializer();
      const xmlString = serializer.serializeToString(doc);
      const formattedXml = formatXml(xmlString);
      await downloadStbFile(formattedXml, filename, { fileHandle });

      if (includeReport && (validationReport || repairReport)) {
        const reportContent = generateIntegratedExportReport(validationReport, repairReport);
        const reportFilename = filename.replace(/\.stb$/i, '_report.txt');
        downloadTextFile(reportContent, reportFilename);
      }

      logger.debug(`Validated STB file exported successfully as ${filename}`);
      return true;
    } catch (error) {
      logger.error('Error exporting validated STB file:', error);
      throw error;
    }
  }

  return Object.freeze({
    exportStbDocument,
    validateDocumentForExport,
    generateModificationReport,
    exportValidatedStb,
  });
}

function applyVersionOverrides(doc, targetVersion) {
  const normalized = normalizeStbVersion(targetVersion);
  if (!normalized) return;

  const root = doc.documentElement;
  if (root) root.setAttribute('version', normalized);

  const stbCommon = doc.getElementsByTagName('StbCommon')[0];
  if (!stbCommon) return;

  if (isStb21x(normalized)) {
    if (!stbCommon.getAttribute('app_version')) {
      stbCommon.setAttribute('app_version', '1.0.0');
    }
    if (!stbCommon.getAttribute('project_name')) {
      stbCommon.setAttribute('project_name', 'Untitled Project');
    }
  } else if (normalized === '2.0.2') {
    stbCommon.removeAttribute('app_version');
    stbCommon.removeAttribute('project_name');
    stbCommon.removeAttribute('convert_app_version');
  }
}

export function generateModificationReport(modifications) {
  if (modifications.length === 0) return '修正はありませんでした。';

  let report = 'STB修正レポート\n';
  report += `生成日時: ${new Date().toLocaleString('ja-JP')}\n`;
  report += `修正数: ${modifications.length}件\n\n`;

  modifications.forEach((mod, index) => {
    report += `${index + 1}. ${mod.elementType} (ID: ${mod.id})\n`;
    if (mod.op === 'add') {
      report += '   操作: 新規追加\n\n';
    } else {
      report += `   属性: ${mod.attribute}\n`;
      report += `   変更前の値: ${mod.oldValue}\n`;
      report += `   新しい値: ${mod.newValue}\n\n`;
    }
  });

  return report;
}

const defaultExporter = createStbExporter();

export const exportStbDocument = (...args) => defaultExporter.exportStbDocument(...args);
export const validateDocumentForExport = (...args) =>
  defaultExporter.validateDocumentForExport(...args);
export const exportValidatedStb = (...args) => defaultExporter.exportValidatedStb(...args);

export { formatXml, downloadStbFile, downloadTextFile };
