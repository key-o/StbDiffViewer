/**
 * RC取り合い限定診断の独立CSV。部材別体積の実測差ではなくplannerの概算値を出力する。
 * Working Documentの現行revisionで検証済みかは呼び出し元が判定する。
 */

const COLUMNS = Object.freeze([
  'model_side',
  'working_revision',
  'record_status',
  'element_type',
  'element_id',
  'join_rule',
  'estimated_reduction_m3',
  'before_concrete_volume_m3',
  'after_concrete_volume_m3',
  'actual_reduction_m3',
  'estimate_delta_m3',
  'quantity_service_check_status',
  'before_offsets_json',
  'target_offsets_json',
  'connections_json',
  'warning_reason',
  'supported_scope',
  'inter_member_overlap_verification',
]);

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let result = String(value);
  // Excelに直接開いた場合、STB由来の部材IDや警告文を式として実行させない。
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@]/u.test(value)) {
    result = `'${result}`;
  }
  return /[",\r\n]/u.test(result) ? `"${result.replaceAll('"', '""')}"` : result;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function volumeToM3(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? '' : value / 1e9;
}

function proposalRow(proposal, status, audit) {
  const reduction = Number(proposal?.estimatedReductionMm3);
  return {
    model_side: 'A',
    working_revision: audit.workingRevision,
    record_status: status,
    element_type: proposal?.elementType ?? '',
    element_id: proposal?.elementId ?? '',
    join_rule: proposal?.kind ?? '',
    // mm³ to m³. Planner approximation, NOT an actual QuantityService delta.
    estimated_reduction_m3: Number.isFinite(reduction) ? reduction / 1e9 : '',
    before_concrete_volume_m3:
      status === 'applied' ? volumeToM3(proposal.beforeConcreteVolumeMm3) : '',
    after_concrete_volume_m3:
      status === 'applied' ? volumeToM3(proposal.afterConcreteVolumeMm3) : '',
    actual_reduction_m3: status === 'applied' ? volumeToM3(proposal.actualReductionMm3) : '',
    estimate_delta_m3: status === 'applied' ? volumeToM3(proposal.estimateDeltaMm3) : '',
    quantity_service_check_status:
      status === 'applied' ? (proposal.quantityServiceCheckStatus ?? 'pending') : 'not_applicable',
    // 従来の診断データには変更前offsetが無いため、空欄で未記録と示す。
    before_offsets_json:
      proposal && Object.hasOwn(proposal, 'beforeOffsets')
        ? JSON.stringify(proposal.beforeOffsets)
        : '',
    target_offsets_json: JSON.stringify(proposal?.offsets ?? {}),
    connections_json: JSON.stringify(proposal?.connections ?? []),
    warning_reason: '',
    supported_scope: audit.supportedScope ?? '',
    inter_member_overlap_verification: 'not_verified',
  };
}

/**
 * Status: candidate = 現行未適用候補、applied = 直前に適用、warning = 推測編集せず保留。
 * warning件数は接合部の干渉ペア件数ではない。
 */
export function serializeJoinAuditCsv(audit) {
  if (!audit || !Number.isInteger(audit.workingRevision)) {
    throw new TypeError('有効なWorking診断結果が必要です。');
  }
  const rows = [
    ...asArray(audit.appliedProposals).map((proposal) => proposalRow(proposal, 'applied', audit)),
    ...asArray(audit.proposals).map((proposal) => proposalRow(proposal, 'candidate', audit)),
    ...asArray(audit.warnings).map((warning) => ({
      model_side: 'A',
      working_revision: audit.workingRevision,
      record_status: 'warning',
      warning_reason: String(warning),
      supported_scope: audit.supportedScope ?? '',
      inter_member_overlap_verification: 'not_verified',
    })),
  ];
  return `\uFEFF${[
    COLUMNS.join(','),
    ...rows.map((row) => COLUMNS.map((name) => csvCell(row[name])).join(',')),
  ].join('\r\n')}\r\n`;
}

export function buildJoinAuditCsvFilename(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const date = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  return (
    `quantity-rc-join-audit-A-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.csv`
  );
}
