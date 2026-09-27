/**
 * @fileoverview Working Document の増分 validation gate。
 *
 * 編集前に存在していた error は baseline として保持し、Command 適用後に新規発生した
 * error だけを rollback 条件とする。Property edit は同期応答性を優先し、geometry 検証は
 * 既定で除外する。
 */

import { validateStbDocument } from '../../common-stb/validation/stbValidator.js';

const DEFAULT_VALIDATION_OPTIONS = Object.freeze({
  validateReferences: true,
  validateGeometry: false,
  validateSchema: true,
  includeInfo: false,
});

function normalizeMessage(message) {
  return String(message || '')
    .replace(/["'][^"']*["']/g, '"…"')
    .replace(/-?\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * validation issue を編集前後で比較可能な signature に正規化する。
 * 値そのものは signature から極力除き、同一箇所の既存 error が値変更だけで別 error と
 * 判定されることを避ける。
 * @param {Object} issue
 * @returns {string}
 */
export function createValidationIssueSignature(issue = {}) {
  const location =
    issue.idXPath ||
    issue.xpath ||
    [issue.elementType || '', issue.elementId || '', issue.attribute || ''].join(':');
  const discriminator = issue.code || issue.rule || normalizeMessage(issue.message);
  return [issue.category || '', location, issue.attribute || '', discriminator].join('|');
}

/** @param {Object|null} report @returns {Set<string>} */
export function collectValidationErrorSignatures(report) {
  return new Set(
    (report?.issues || [])
      .filter((issue) => issue?.severity === 'error')
      .map((issue) => createValidationIssueSignature(issue)),
  );
}

/**
 * baseline に無かった error を返す。
 * @param {Set<string>|{signatures:Set<string>}} baseline
 * @param {Object|null} report
 * @returns {Object[]}
 */
export function findNewValidationErrors(baseline, report) {
  const signatures = baseline instanceof Set ? baseline : baseline?.signatures;
  const baselineSignatures = signatures instanceof Set ? signatures : new Set();
  return (report?.issues || []).filter(
    (issue) =>
      issue?.severity === 'error' && !baselineSignatures.has(createValidationIssueSignature(issue)),
  );
}

function runValidation(document, options = {}) {
  const validate = options.validate || validateStbDocument;
  const validationOptions = {
    ...DEFAULT_VALIDATION_OPTIONS,
    ...(options.validationOptions || {}),
  };
  return validate(document, validationOptions);
}

/**
 * Command 適用前の error signature を採取する。
 * @param {Document} document
 * @param {{validate?:Function,validationOptions?:Object}} [options]
 * @returns {{signatures:Set<string>,report:Object}}
 */
export function captureWorkingValidationBaseline(document, options = {}) {
  const report = runValidation(document, options);
  return {
    signatures: collectValidationErrorSignatures(report),
    report,
  };
}

/**
 * EditingSession の validate callback を生成する。
 * callback は Command 適用後に呼ばれ、新規 error があれば例外を投げるため
 * EditingSession 側の reverse apply により rollback される。
 *
 * @param {Set<string>|{signatures:Set<string>}} baseline
 * @param {{validate?:Function,validationOptions?:Object}} [options]
 * @returns {Function}
 */
export function createIncrementalWorkingValidator(baseline, options = {}) {
  return ({ workingDocument }) => {
    const report = runValidation(workingDocument, options);
    const newErrors = findNewValidationErrors(baseline, report);
    if (newErrors.length === 0) return true;

    const first = newErrors[0];
    const suffix = newErrors.length > 1 ? ` ほか${newErrors.length - 1}件` : '';
    const error = new Error(
      `編集により新しいST-Bridge validation errorが発生しました: ${first.message || '詳細不明'}${suffix}`,
    );
    error.validationIssues = newErrors;
    throw error;
  };
}

export { DEFAULT_VALIDATION_OPTIONS };
