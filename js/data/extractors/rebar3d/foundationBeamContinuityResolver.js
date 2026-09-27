/**
 * @fileoverview 日建連2023標準図 §6-2 の基礎小梁type整合確認に使う「連続する/しない」を、
 * FOUNDATION_BEAM_ANCHORAGE の common < section < member < member-end 階層から解決する。
 *
 * ST-Bridgeには標準図上の「基礎小梁が連続する場合」を直接表す属性がないため、
 * project detailingの明示値だけを採用する。topology由来の端部連続性は別factsで検証する。
 */

import { resolveFoundationBeamDetailingProperty } from './foundationBeamDetailingHierarchy.js';

function validateContinuous(rawValue) {
  if (typeof rawValue !== 'boolean') {
    return { ok: false, reason: 'foundation-continuity-invalid' };
  }
  return { ok: true, value: rawValue };
}

/**
 * @param {Object} projectDetailing
 * @param {{elementId:string|number,sectionId?:string|number|null,side:'start'|'end'}} target
 */
export function resolveFoundationBeamContinuity(projectDetailing, target = {}) {
  const result = resolveFoundationBeamDetailingProperty(projectDetailing, target, {
    property: 'continuous',
    validate: validateContinuous,
    missingReason: 'foundation-continuity-not-specified',
  });
  return {
    ...result,
    continuous: result.resolved ? result.value : null,
  };
}

export const _foundationBeamContinuityResolverInternals = Object.freeze({ validateContinuous });
