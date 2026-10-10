/**
 * @fileoverview スラブ境界の通し筋Decision Trace。
 * 入力factsは読み取り専用。判定記録をproduction geometryへ戻さない。
 */

import { createTrace } from './rebarDecisionTrace.js';

export function buildSlabThroughDecisionTraces(paths, { modelSource = null } = {}) {
  const result = [];
  for (const [pathIndex, path] of (paths || []).entries()) {
    const metadata = path?.metadata || {};
    for (const side of ['start', 'end']) {
      const prefix = side === 'start' ? 'boundaryStart' : 'boundaryEnd';
      if (metadata[`${prefix}Mode`] !== 'THROUGH') continue;
      const otherSlabId = metadata[`${prefix}ThroughSlabId`] || null;
      const edgeKey = metadata[`${prefix}EdgeKey`] || null;
      const supportMemberId = metadata[`${prefix}SupportMemberId`] || null;
      const memberId = metadata.memberId || null;
      result.push(
        createTrace({
          decisionId: `SLAB:${memberId || '-'}:${pathIndex}:${side}:THROUGH:${edgeKey || '-'}`,
          subjectType: 'SLAB_BAR_BOUNDARY',
          subjectKey: `${memberId || '-'}:${pathIndex}:${side}`,
          disposition: 'THROUGH',
          appliedRuleIds: ['SLAB-SAME-REBAR-THROUGH-CANDIDATE'],
          sourceRef: memberId ? `StbSlab:${memberId}` : null,
          targetRef: otherSlabId ? `StbSlab:${otherSlabId}` : null,
          sources: [
            memberId ? `StbSlab:${memberId}` : null,
            otherSlabId ? `StbSlab:${otherSlabId}` : null,
            supportMemberId ? `SUPPORT_MEMBER:${supportMemberId}` : null,
          ],
          modelSource,
        }),
      );
    }
  }
  return Object.freeze(result);
}
