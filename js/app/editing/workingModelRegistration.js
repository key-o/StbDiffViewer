/**
 * @fileoverview Register a validated Working Document snapshot as model A or B.
 *
 * No disk write takes place: the serializer produces an in-memory File consumed
 * by the existing file-backed loading/comparison path.
 */

import {
  isVersionLoaded,
  loadJsonSchemaForVersion,
} from '../../common-stb/import/parser/jsonSchemaLoader.js';
import { validateStbDocument } from '../../common-stb/validation/stbValidator.js';
import { validateJsonSchema } from '../../common-stb/validation/jsonSchemaParityValidator.js';

export function resolveWorkingSchemaVersion(document) {
  const version = document?.documentElement?.getAttribute?.('version') || '';
  // Registration is stricter than a best-effort import: never silently validate
  // an unknown ST-Bridge version against a different version's schema.
  if (version === '2.1.0' || version === '2.1.1' || version === '2.0.2') {
    return version;
  }
  throw new Error(`登録できないST-Bridgeバージョンです: ${version || '未設定'}`);
}

/**
 * Validate all issues, not only incremental errors relative to the edit baseline.
 * Incomplete documents must not be registered as model slots.
 */
export async function prepareValidatedWorkingSnapshot(
  document,
  {
    revision = 0,
    ensureSchema = async (version) =>
      isVersionLoaded(version) || (await loadJsonSchemaForVersion(version)),
    validate = validateStbDocument,
    validateSchemaParity = validateJsonSchema,
    serialize = (source) => new XMLSerializer().serializeToString(source),
  } = {},
) {
  if (!document || document.documentElement?.tagName !== 'ST_BRIDGE') {
    throw new Error('登録対象のWorking Documentがありません。');
  }

  const schemaVersion = resolveWorkingSchemaVersion(document);
  if (!(await ensureSchema(schemaVersion))) {
    throw new Error(`ST-Bridge ${schemaVersion} の検証スキーマを読み込めませんでした。`);
  }

  // The orchestrator logs and swallows parity-validator exceptions.
  // Model registration must reject rather than silently skip that validation.
  const schemaIssues = validateSchemaParity(document, { version: schemaVersion });
  if (!Array.isArray(schemaIssues)) {
    throw new Error('STBスキーマバリデーションの結果を取得できませんでした。');
  }
  const schemaErrors = schemaIssues.filter((issue) => issue.severity === 'error');
  if (schemaErrors.length > 0) {
    const error = new Error(
      `STBスキーマバリデーションで${schemaErrors.length}件のエラーが検出されました: ${schemaErrors[0].message}`,
    );
    error.validationIssues = schemaErrors;
    throw error;
  }

  const report = validate(document, {
    validateReferences: true,
    validateGeometry: true,
    // Strict parity validation already succeeded above. Do not run it twice.
    validateSchema: false,
    includeInfo: false,
  });
  const errors = report?.issues?.filter((issue) => issue.severity === 'error') || [];
  if (!report || report.valid !== true || errors.length > 0) {
    const detail = errors[0]?.message || '検証結果が不正です';
    const error = new Error(
      `STBバリデーションで${errors.length}件のエラーが検出されたため登録できません: ${detail}`,
    );
    error.validationIssues = errors;
    error.validationReport = report;
    throw error;
  }

  const xml = serialize(document);
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error('Working DocumentをXMLに変換できませんでした。');
  }
  const schemaWarnings = schemaIssues.filter((issue) => issue.severity === 'warning');
  const combinedReport = {
    ...report,
    issues: [...(report.issues || []), ...schemaIssues],
    statistics: {
      ...report.statistics,
      warningCount: (report.statistics?.warningCount || 0) + schemaWarnings.length,
    },
  };
  return {
    xml,
    filename: `working_model_rev${revision}.stb`,
    revision,
    schemaVersion,
    report: combinedReport,
  };
}

/**
 * Read a stable pair of File object identities before asynchronous preflight.
 * A selection change while processing invalidates the preflight result.
 */
export function captureModelInputSelection(documentLike = document) {
  const inputA = documentLike.getElementById('fileA');
  const inputB = documentLike.getElementById('fileB');
  if (!inputA || !inputB) {
    throw new Error('モデルA/Bのファイル入力が見つかりません。');
  }
  return { fileA: inputA.files?.[0] || null, fileB: inputB.files?.[0] || null };
}

export function hasModelInputSelectionChanged(before, after) {
  return !before || !after || before.fileA !== after.fileA || before.fileB !== after.fileB;
}

/**
 * Verify that the target is our newly assigned in-memory File and the opposite
 * slot still points to the File object that passed preflight.
 */
export function hasModelInputSelectionChangedAfterAssignment(before, after, side, assignedFile) {
  if (side !== 'A' && side !== 'B') {
    throw new RangeError('登録先はモデルA/Bのみです。');
  }
  if (!before || !after || !assignedFile) return true;
  const target = side === 'A' ? 'fileA' : 'fileB';
  const opposite = side === 'A' ? 'fileB' : 'fileA';
  return after[target] !== assignedFile || after[opposite] !== before[opposite];
}

/**
 * Returns the previous FileList for rollback. The File is kept only in memory.
 * @param {'A'|'B'} side
 */
export function assignWorkingSnapshotFile(
  side,
  snapshot,
  { documentLike = document, FileClass = File, DataTransferClass = DataTransfer } = {},
) {
  if (side !== 'A' && side !== 'B') throw new RangeError('登録先はモデルA/Bのみです。');
  const input = documentLike.getElementById(`file${side}`);
  if (!input) throw new Error(`モデル${side}のファイル入力が見つかりません。`);
  const previousFiles = [...(input.files || [])];
  const file = new FileClass([snapshot.xml], snapshot.filename, {
    type: 'application/xml',
  });
  const transfer = new DataTransferClass();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { input, previousFiles, file };
}

/** Recover only the input selection; the loader may already have reset the scene. */
export function restoreModelInputFiles(input, previousFiles, DataTransferClass = DataTransfer) {
  const transfer = new DataTransferClass();
  for (const file of previousFiles) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * After a destructive loader failure, restore the previous input and reopen
 * the in-memory Working session. Rebuilding the original source view is best
 * effort; the Working document and its Undo stack must be retained regardless.
 *
 * The loader can fail after clearing the scene, so a FileList-only rollback
 * is insufficient.
 */
export async function recoverWorkingRegistrationAfterLoadFailure({
  replacement,
  previousInputs = null,
  documentLike = globalThis.document,
  compare,
  workingState,
  getEditingState,
  restoreEditingState,
  restoreEditingUi,
  onWorkingRebound,
  restoreFiles = restoreModelInputFiles,
}) {
  if (!replacement || !workingState?.active) {
    return { attempted: false, sourceViewRestored: false, workingRestored: false };
  }

  const inputs = previousInputs
    ? ['A', 'B'].map((side) => ({
        input: documentLike?.getElementById(`file${side}`),
        files: previousInputs[`file${side}`] ? [previousInputs[`file${side}`]] : [],
      }))
    : [{ input: replacement.input, files: replacement.previousFiles }];
  let inputRestored = true;
  for (const { input, files } of inputs) {
    try {
      if (!input) throw new Error('Model input is missing');
      restoreFiles(input, files);
    } catch {
      inputRestored = false;
      // DataTransfer/FileList may be unavailable. Clear the candidate file rather
      // than leaving an uncommitted Working snapshot selected for a later load.
      try {
        input.value = '';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {
        // The edit session will still be restored independently of FileList.
      }
    }
  }

  const stillActive = getEditingState?.()?.workingDocument === workingState.workingDocument;
  if (stillActive) {
    return {
      attempted: true,
      inputRestored,
      sourceViewRestored: true,
      workingRestored: true,
    };
  }

  // Restore the former A/B source before restoring the Working edit overlay.
  // A failed second comparison must not discard the captured edit state.
  let sourceViewRestored = false;
  if (inputRestored && typeof compare === 'function') {
    try {
      sourceViewRestored = (await compare()) === true;
    } catch {
      sourceViewRestored = false;
    }
  }

  restoreEditingState(workingState);
  restoreEditingUi();
  if (sourceViewRestored) {
    try {
      onWorkingRebound?.(workingState);
    } catch {
      // Edit state and undo history are retained even if overlay refresh fails.
      sourceViewRestored = false;
    }
  }

  return { attempted: true, inputRestored, sourceViewRestored, workingRestored: true };
}
