/** Guard async multi-view rebind publication/ZIP export against stale UI approvals. */
const SNAPSHOT_KEYS = Object.freeze([
  'staged',
  'stagePlan',
  'stagePlanStatus',
  'sourceFile',
  'project',
  'serializedProject',
  'drawing',
  'modelDocument',
  'activeDrawingDocumentId',
  'selectedViewKey',
  'workspaceSignature',
]);

export function drawingProjectSlotApprovalsFingerprint(approvals) {
  if (!(approvals instanceof Map)) throw new TypeError('STB改訂対応の承認Mapがありません。');
  return JSON.stringify(
    [...approvals.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

/**
 * Fingerprint unsaved drawing workspace edits independently of persisted DrawingProject.
 * The stage lease compares this value even when a review/placement is mutated in place.
 */
export function drawingProjectSlotWorkspaceFingerprint({
  memberReviews = [],
  drawingMemos = [],
  tagPlacements = [],
  tagFamilyState = null,
  drawingMemoIdentity = null,
} = {}) {
  if (![memberReviews, drawingMemos, tagPlacements].every(Array.isArray))
    throw new TypeError('作図workspaceのレビュー・メモ・タグ配置が不正です。');
  const fingerprint = JSON.stringify([
    memberReviews,
    drawingMemos,
    tagPlacements,
    tagFamilyState,
    drawingMemoIdentity,
  ]);
  if (typeof fingerprint !== 'string') throw new TypeError('作図workspaceの状態を検証できません。');
  return fingerprint;
}

/**
 * Snapshot all mutable inputs that can change while a SHA-256 / ZIP operation awaits.
 * readCurrent must be synchronous; no DOM or active-model mutations are performed.
 */
export function captureDrawingProjectSlotStageLease(
  readCurrent,
  { allowProvisionalModelDocument = false } = {},
) {
  if (typeof readCurrent !== 'function')
    throw new TypeError('STB改訂stageの確認関数がありません。');
  if (typeof allowProvisionalModelDocument !== 'boolean')
    throw new TypeError('モデル公開中のstage確認設定が不正です。');
  // Only the model loader's verified candidate handoff may opt into
  // disregarding models.documentA during its provisional replacement.
  // All other UI/project/approval/file fields remain identity-checked.
  const keys = allowProvisionalModelDocument
    ? SNAPSHOT_KEYS.filter((key) => key !== 'modelDocument')
    : SNAPSHOT_KEYS;
  const capture = () => {
    const current = readCurrent();
    if (!current || typeof current !== 'object')
      throw new TypeError('STB改訂stageの状態が不正です。');
    return {
      values: keys.map((key) => current[key]),
      approvals: drawingProjectSlotApprovalsFingerprint(current.approvals),
    };
  };
  const original = capture();
  return () => {
    const latest = capture();
    return (
      original.approvals === latest.approvals &&
      original.values.every((value, index) => value === latest.values[index])
    );
  };
}
