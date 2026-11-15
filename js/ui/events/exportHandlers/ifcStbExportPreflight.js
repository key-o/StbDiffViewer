/**
 * Fail-closed gate for IFC-origin STB export (Issue #721).
 * No subset/partial STB export path is provided here. Files with confirmed
 * invalid target properties or dropped classified IFC elements are blocked.
 * Acknowledging UNVERIFIED never turns it into PRESERVED or an XSD PASS.
 */
const LOSS_STATUSES = new Set([
  'UNSUPPORTED',
  'TARGET_UNREPRESENTABLE',
  'CONFLICT_OR_INVALID',
  'LOST_OR_CHANGED',
]);

export function assessIfcStbExport({ sourceType, diagnostics, schemaIssues } = {}) {
  if (sourceType !== 'ifc') return { decision: 'ALLOW', code: 'NON_IFC_SOURCE', details: [] };
  const errors = Array.isArray(schemaIssues)
    ? schemaIssues.filter((issue) => issue?.severity === 'error')
    : [{ message: 'STB schema validation result unavailable' }];
  if (errors.length > 0) {
    return {
      decision: 'BLOCK',
      code: 'STB_SCHEMA_ERRORS',
      details: errors.slice(0, 5).map((issue) => issue.message || 'STB schema error'),
      count: errors.length,
    };
  }
  if (!diagnostics || !Array.isArray(diagnostics.records)) {
    return {
      decision: 'BLOCK',
      code: 'IFC_DIAGNOSTICS_MISSING',
      details: ['元IFC部材の復元診断がないため、安全なSTB書出しを確認できません'],
    };
  }
  if (diagnostics.records.some((record) => !record || typeof record !== 'object')) {
    return {
      decision: 'BLOCK',
      code: 'IFC_DIAGNOSTICS_INCOMPLETE',
      details: ['IFC復元診断に不正なレコードがあります'],
    };
  }
  const missing = diagnostics.records.filter(
    (record) => record.code === 'NO_STB_ELEMENT_GENERATED',
  );
  const omitted = diagnostics.unconvertedClassifiedCount;
  if (!Number.isInteger(omitted) || omitted < 0 || omitted > 0 || missing.length > 0) {
    return {
      decision: 'BLOCK',
      code: 'IFC_ELEMENTS_NOT_CONVERTED',
      count: Math.max(Number.isInteger(omitted) ? omitted : 0, missing.length),
      details: missing
        .slice(0, 5)
        .map(
          (record) => `${record.ifcType ?? 'IFC'} #${record.expressID ?? '?'}（${record.code}）`,
        ),
    };
  }
  const definiteLoss = diagnostics.records.filter((record) => LOSS_STATUSES.has(record.status));
  if (definiteLoss.length > 0) {
    return {
      decision: 'BLOCK',
      code: 'KNOWN_RESTORATION_LOSS',
      count: definiteLoss.length,
      details: definiteLoss
        .slice(0, 5)
        .map(
          (record) =>
            `${record.ifcType ?? 'IFC'} #${record.expressID ?? '?'} ${record.field}: ${record.status}`,
        ),
    };
  }
  if (
    !Number.isSafeInteger(diagnostics.classifiedElementCount) ||
    diagnostics.classifiedElementCount < 0
  ) {
    return {
      decision: 'BLOCK',
      code: 'IFC_DIAGNOSTICS_INCOMPLETE',
      details: ['分類済みIFC部材数を確定できません'],
    };
  }
  if (diagnostics.classifiedElementCount === 0) {
    return {
      decision: 'BLOCK',
      code: 'NO_CLASSIFIED_STRUCTURAL_ELEMENTS',
      details: ['STBの構造部材に分類できたIFC要素がありません'],
    };
  }
  // Absence of an inventory is unknown, not proof that there are zero candidates.
  const candidateSummary =
    Number.isSafeInteger(diagnostics.unmappedCandidateCount) &&
    diagnostics.unmappedCandidateCount >= 0
      ? `${diagnostics.unmappedCandidateCount}件`
      : '未集計';
  const scanErrorSummary = Array.isArray(diagnostics.unmappedCandidateScanErrors)
    ? `${diagnostics.unmappedCandidateScanErrors.length}件`
    : '未集計';
  const inventorySummary = diagnostics.unenumeratedIfcTypesChecked === true ? '実施' : '未実施';
  return {
    decision: 'ACK_REQUIRED',
    code: 'IFC_RESTORATION_UNVERIFIED',
    details: [
      `分類${diagnostics.classifiedElementCount}件、未分類候補${candidateSummary}、候補列挙エラー${scanErrorSummary}、IFC全件監査${inventorySummary}`,
      '形状・配筋・属性の意味保存とXSDの完全性は未検証です',
    ],
  };
}
