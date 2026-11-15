/**
 * @fileoverview RC取り合いで変更した部材の概算控除量とQuantityService実控除量を照合する。
 *
 * 派生quantity storeだけを参照し、STB/XMLの再parseや同期的な数量再計算を行わない。
 * これは部材単位のコンクリート量の差分であり、建物全体の3D solid unionではない。
 */

const VOLUME_KEY = 'concreteVolumeMm3';
const ABSOLUTE_TOLERANCE_MM3 = 10;

function calculatedConcreteVolume(store, elementType, elementId) {
  const result = store?.get?.(elementType, elementId);
  const raw = result?.values?.[VOLUME_KEY];
  if (result?.status !== 'CALCULATED' || raw === null || raw === undefined || raw === '') {
    return null;
  }
  const volume = Number(raw);
  return Number.isFinite(volume) && volume >= 0 ? volume : null;
}

/**
 * 適用直前に参照できる現行revisionの派生数量のみ記録する。存在しなければnullとする。
 * 入力proposalを変更しない。
 */
export function captureJoinQuantityBaselines(proposals, store) {
  return (proposals || []).map((proposal) => ({
    ...proposal,
    beforeConcreteVolumeMm3: calculatedConcreteVolume(
      store,
      proposal.elementType,
      proposal.elementId,
    ),
  }));
}

/**
 * afterStoreは同一session/revisionの再計算が完了したものだけを呼び出し側が渡す。
 * 一致・不一致は部材数量差だけに関する判定であり、部材間重複の解消は保証しない。
 */
export function reconcileJoinQuantityAudit(audit, afterStore) {
  if (!audit || !Array.isArray(audit.appliedProposals) || !afterStore?.get) return null;

  const counts = { matched: 0, mismatch: 0, unavailable: 0 };
  const appliedProposals = audit.appliedProposals.map((proposal) => {
    const before = proposal.beforeConcreteVolumeMm3;
    const after = calculatedConcreteVolume(afterStore, proposal.elementType, proposal.elementId);
    const estimated = Number(proposal.estimatedReductionMm3);
    if (
      before === null ||
      before === undefined ||
      !Number.isFinite(before) ||
      before < 0 ||
      after === null ||
      !Number.isFinite(estimated)
    ) {
      counts.unavailable++;
      return {
        ...proposal,
        afterConcreteVolumeMm3: after,
        actualReductionMm3: null,
        estimateDeltaMm3: null,
        quantityServiceCheckStatus: 'unavailable',
      };
    }

    const actual = before - after;
    const delta = actual - estimated;
    // QuantityServiceの積算丸めを許容するが、mm³単位の実質的な差を見逃さない。
    const tolerance = Math.max(ABSOLUTE_TOLERANCE_MM3, Math.abs(estimated) * 1e-9);
    const status = Math.abs(delta) <= tolerance ? 'matched' : 'mismatch';
    counts[status]++;
    return {
      ...proposal,
      afterConcreteVolumeMm3: after,
      actualReductionMm3: actual,
      estimateDeltaMm3: delta,
      quantityServiceCheckStatus: status,
    };
  });

  return {
    ...audit,
    appliedProposals,
    quantityReconciliation: { ...counts, total: appliedProposals.length },
  };
}

/** 数量更新自体が失敗した場合の明示状態。過去の成功結果を引き継がない。 */
export function failJoinQuantityReconciliation(audit) {
  if (!audit || !Array.isArray(audit.appliedProposals)) return null;
  const appliedProposals = audit.appliedProposals.map((proposal) => ({
    ...proposal,
    afterConcreteVolumeMm3: null,
    actualReductionMm3: null,
    estimateDeltaMm3: null,
    quantityServiceCheckStatus: 'calculation_failed',
  }));
  return {
    ...audit,
    appliedProposals,
    quantityReconciliation: {
      matched: 0,
      mismatch: 0,
      unavailable: appliedProposals.length,
      total: appliedProposals.length,
      failed: true,
    },
  };
}
