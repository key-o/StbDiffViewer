/**
 * @fileoverview 配筋Decision Traceの共通レコードと数値メトリクス。
 * 入力factsは読み取り専用。判定記録をproduction geometryへ戻さない。
 */

import { rebarRuleTraceMetadata } from './rebarDetailingRuleRegistry.js';

export function finiteOrNull(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function compactMetrics(values = {}) {
  const metrics = {};
  for (const [key, value] of Object.entries(values)) {
    const finite = finiteOrNull(value);
    if (finite !== null) metrics[key] = finite;
  }
  return metrics;
}

export function createTrace({
  decisionId,
  subjectType,
  subjectKey,
  disposition,
  appliedRuleIds,
  metrics = {},
  unresolvedReason = null,
  sourceRef = null,
  targetRef = null,
  sources = [],
  rejectedAlternatives = [],
  modelSource = null,
  authoring = null,
}) {
  const appliedRules = appliedRuleIds.map(rebarRuleTraceMetadata);
  return Object.freeze({
    decisionId,
    subjectType,
    subjectKey,
    ...(modelSource ? { modelSource } : {}),
    ...(authoring ? { authoring } : {}),
    status: unresolvedReason ? 'UNRESOLVED' : 'RESOLVED',
    disposition,
    sourceRef,
    targetRef,
    appliedRules,
    rejectedAlternatives: Object.freeze(rejectedAlternatives.slice()),
    metrics: Object.freeze(compactMetrics(metrics)),
    unresolvedReason,
    provenance: Object.freeze({
      kind: 'SDV_GENERATED',
      sources: Object.freeze(sources.filter(Boolean).map(String)),
      rules: Object.freeze(appliedRules.map((rule) => rule.ruleId)),
      assumptions: Object.freeze([]),
    }),
    confidence: 'RULE_BASED',
    warnings: Object.freeze(unresolvedReason ? [unresolvedReason] : []),
  });
}
