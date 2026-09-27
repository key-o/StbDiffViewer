/**
 * @fileoverview R13 §6-3 / §6-4 の構造図優先を維持しつつ、2023標準図を採用するかを
 * FOUNDATION_BEAM_ANCHORAGE project detailing hierarchyから解決する。
 */

import { resolveFoundationBeamDetailingProperty } from './foundationBeamDetailingHierarchy.js';

export const FOUNDATION_INTERACTION_DETAIL_SOURCE_2023 = 'STANDARD_2023';

function validateStandard2023(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'foundation-interaction-detail-source-empty' };
  }
  const normalized = value.trim().toUpperCase();
  if (normalized !== FOUNDATION_INTERACTION_DETAIL_SOURCE_2023) {
    return {
      ok: false,
      reason: 'foundation-interaction-detail-source-unsupported',
      extra: { allowed: [FOUNDATION_INTERACTION_DETAIL_SOURCE_2023] },
    };
  }
  return { ok: true, value: normalized };
}

export function resolveFoundationBeamLowestColumnDetailSource2023(projectDetailing, target = {}) {
  return resolveFoundationBeamDetailingProperty(projectDetailing, target, {
    property: 'lowestColumnInteractionDetailSource',
    validate: validateStandard2023,
    missingReason: 'foundation-lowest-column-detail-source-not-specified',
  });
}

export function resolveFoundationBeamFoundationDetailSource2023(projectDetailing, target = {}) {
  return resolveFoundationBeamDetailingProperty(projectDetailing, target, {
    property: 'foundationInteractionDetailSource',
    validate: validateStandard2023,
    missingReason: 'foundation-interaction-detail-source-not-specified',
  });
}

export const _foundationBeamInteractionDetailSource2023Internals = Object.freeze({
  validateStandard2023,
});
