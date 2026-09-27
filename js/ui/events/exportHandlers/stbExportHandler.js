/**
 * @fileoverview STBエクスポートハンドラー
 *
 * STBファイルのエクスポート機能を処理します。
 * 元のSTBファイルが利用可能な場合、バージョン変換ルール（12種類）を適用します。
 * IFCソースの場合はDOMドキュメントのバージョン属性のみ更新します。
 *
 * @module ui/events/exportHandlers/stbExportHandler
 */

import { showSuccess, showError, showWarning } from '../../common/toast.js';
import editingSession from '../../../app/editing/editingSession.js';
import { getState } from '../../../data/state/globalState.js';
import {
  downloadStbFile,
  ensureStbExtension,
  requestStbSaveFileHandle,
} from '../../../common-stb/export/xmlFormatter.js';
import { createLogger } from '../../../utils/logger.js';
import {
  normalizeStbVersion as normalizeVersion,
  toStbVersionFilenameToken as versionToFilenameToken,
} from '../../../common-stb/version/stbVersion.js';

const log = createLogger('ui:events:exportHandlers:stbExportHandler');

/**
 * 正規表現用に文字列をエスケープ
 * @param {string} value - エスケープ対象
 * @returns {string} エスケープ済み文字列
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 既知の入力ファイル拡張子を取り除く
 * @param {string} filename - 元ファイル名
 * @returns {string} 拡張子を除いたファイル名
 */
function stripKnownSourceExtension(filename) {
  return String(filename || '').replace(/\.(stb|xml|ifc)$/i, '');
}

/**
 * STB出力のデフォルトファイル名を生成
 * @param {string|null|undefined} sourceName - 元ファイル名
 * @param {string} targetVersion - 出力STBバージョン
 * @returns {string} デフォルトファイル名
 */
export function buildDefaultStbExportFilename(sourceName, targetVersion) {
  const baseStem = stripKnownSourceExtension(sourceName || 'stb_export').trim() || 'stb_export';
  const token = versionToFilenameToken(targetVersion);
  if (!token) return `${baseStem}.stb`;

  const hasToken = new RegExp(`(^|[_-])${escapeRegExp(token)}([_-]|$)`, 'i').test(baseStem);
  return `${hasToken ? baseStem : `${baseStem}_${token}`}.stb`;
}

/**
 * バージョン変換の入力XMLを編集済みDOMから生成する。
 *
 * 元ファイルのテキストではなく現在のDOM（Working Document / documentA/B）を
 * シリアライズする点が重要。新規追加した部材や属性編集はDOMにのみ反映されており、
 * 元ファイルテキストを変換すると編集内容（追加要素など）が失われるため。
 *
 * @param {Document} sourceDoc - 出力対象の編集済みDOM
 * @returns {string} シリアライズされたXML文字列
 */
export function serializeDocForExport(sourceDoc) {
  return new XMLSerializer().serializeToString(sourceDoc);
}

/**
 * STB出力の対象DOMと元ファイル情報を解決する。
 *
 * Working Session 中の Model A は source documentA ではなく Working Document が編集正本となる。
 * `auto` でも active Working Document を最優先し、比較用 Model B を誤って出力しない。
 * Model B を明示した場合だけ B を選択する。
 *
 * @param {object} options
 * @param {'auto'|'A'|'B'|string} [options.targetModel='auto']
 * @param {Document|null} [options.documentA=null]
 * @param {Document|null} [options.documentB=null]
 * @param {File|object|null} [options.fileA=null]
 * @param {File|object|null} [options.fileB=null]
 * @param {Document|null} [options.workingDocumentA=null]
 * @returns {{sourceDoc:Document|null,sourceFile:File|object|null,sourceModel:'A'|'B'|null,usesWorkingDocument:boolean}}
 */
export function resolveStbExportSource(options = {}) {
  const {
    targetModel = 'auto',
    documentA = null,
    documentB = null,
    fileA = null,
    fileB = null,
    workingDocumentA = null,
  } = options;

  const effectiveDocumentA = workingDocumentA || documentA;
  const usesWorkingDocument = Boolean(workingDocumentA);

  if (targetModel === 'A') {
    return {
      sourceDoc: effectiveDocumentA,
      sourceFile: fileA,
      sourceModel: effectiveDocumentA ? 'A' : null,
      usesWorkingDocument,
    };
  }

  if (targetModel === 'B') {
    return {
      sourceDoc: documentB,
      sourceFile: fileB,
      sourceModel: documentB ? 'B' : null,
      usesWorkingDocument: false,
    };
  }

  if (workingDocumentA) {
    return {
      sourceDoc: workingDocumentA,
      sourceFile: fileA,
      sourceModel: 'A',
      usesWorkingDocument: true,
    };
  }

  if (documentB) {
    return {
      sourceDoc: documentB,
      sourceFile: fileB,
      sourceModel: 'B',
      usesWorkingDocument: false,
    };
  }

  return {
    sourceDoc: documentA,
    sourceFile: fileA,
    sourceModel: documentA ? 'A' : null,
    usesWorkingDocument: false,
  };
}

/**
 * Setup STB export button listener
 */
export function setupStbExportListener() {
  const exportStbBtn = document.getElementById('exportStbBtn');

  if (exportStbBtn) {
    exportStbBtn.addEventListener('click', handleStbExport);
  }
}

/**
 * Handle STB export button click
 */
async function handleStbExport() {
  const exportStbBtn = document.getElementById('exportStbBtn');
  const versionSelect = document.getElementById('stbExportVersion');
  const targetSelect = document.getElementById('stbExportTarget');
  const filenameInput = document.getElementById('stbExportFilename');

  try {
    if (exportStbBtn) {
      exportStbBtn.disabled = true;
      exportStbBtn.textContent = '⏳ 出力中...';
    }

    const targetVersion = versionSelect?.value || '2.1.0';
    const targetModel = targetSelect?.value || 'auto';

    const docA = getState('models.documentA');
    const docB = getState('models.documentB');
    const fileA = getState('files.originalFileA');
    const fileB = getState('files.originalFileB');
    const editingState = editingSession.getState?.();
    const workingDocumentA =
      editingState?.active === true ? editingSession.getWorkingDocument?.() || null : null;

    const { sourceDoc, sourceFile } = resolveStbExportSource({
      targetModel,
      documentA: docA,
      documentB: docB,
      fileA,
      fileB,
      workingDocumentA,
    });

    if (!sourceDoc) {
      showWarning('出力するモデルが読み込まれていません。');
      return;
    }

    let filename = filenameInput?.value?.trim();
    if (!filename) {
      filename = buildDefaultStbExportFilename(sourceFile?.name, targetVersion);
    }

    filename = ensureStbExtension(filename);

    const saveFileResult = await requestStbSaveFileHandle(filename);
    if (saveFileResult.status === 'canceled') {
      showWarning('STB出力をキャンセルしました。');
      return;
    }
    if (saveFileResult.status === 'error') {
      log.warn(
        '[STB Export] 保存ダイアログの初期化に失敗したため通常ダウンロードに切り替えます:',
        saveFileResult.error,
      );
    }

    const saveFileHandle = saveFileResult.handle;

    // 元のSTBファイルが利用可能な場合、バージョン変換ルールを適用
    const isStbSource = sourceFile && /\.(stb|xml)$/i.test(sourceFile.name);
    if (isStbSource) {
      const { convert, detectVersion } = await import('../../../common-stb/converter/index.js');
      // 元ファイルのテキストではなく編集済みDOMをシリアライズして変換する。
      // （新規追加した部材や属性編集は sourceDoc にのみ反映されており、
      //   元ファイルテキストを変換すると編集内容が失われるため）
      const xmlContent = serializeDocForExport(sourceDoc);
      const currentVersion = await detectVersion(xmlContent);

      if (currentVersion && normalizeVersion(currentVersion) !== normalizeVersion(targetVersion)) {
        const result = await convert(xmlContent, targetVersion);
        if (result.converted) {
          await downloadStbFile(result.xml, filename, { fileHandle: saveFileHandle });
          const warnCount = result.summary?.warnings || 0;
          const msg =
            warnCount > 0
              ? `変換して出力しました: ${filename} (警告: ${warnCount}件)`
              : `変換して出力しました: ${filename}`;
          showSuccess(msg);
          log.info('[STB Export] Converted and exported:', {
            sourceVersion: result.sourceVersion,
            targetVersion: result.targetVersion,
            filename,
            warnings: warnCount,
          });
          return;
        }
      }
    }

    // IFCソースまたは同バージョンの場合はDOM経由で出力
    const { validateJsonSchema } =
      await import('../../../common-stb/validation/jsonSchemaValidator.js');
    const schemaIssues = validateJsonSchema(sourceDoc, {
      version: normalizeVersion(targetVersion),
    });
    const schemaErrors = schemaIssues.filter((i) => i.severity === 'error');
    if (schemaErrors.length > 0) {
      log.warn(
        '[STB Export] スキーマ違反が検出されました:',
        schemaErrors.map((e) => e.message),
      );
      showWarning(`スキーマ違反 ${schemaErrors.length} 件が検出されました（出力は続行します）`);
    }

    const { exportStbDocument } = await import('../../../export/stb/stbExporter.js');
    await exportStbDocument(sourceDoc, { filename, targetVersion, fileHandle: saveFileHandle });
    showSuccess(`出力しました: ${filename}`);
  } catch (error) {
    log.error('STB出力エラー:', error);
    showError(`STB出力に失敗しました: ${error.message}`);
  } finally {
    if (exportStbBtn) {
      exportStbBtn.disabled = false;
      exportStbBtn.textContent = '📦 STBファイルを出力';
    }
  }
}
