/**
 * @fileoverview 日建連2023標準図 §6-1 の基礎大梁type整合確認に使う「基礎に浮上りが生じるか」を、
 * FOUNDATION_BEAM_ANCHORAGE の common < section < member < member-end 階層から解決する。
 *
 * 浮上り有無はST-Bridgeの基礎梁属性から直接は得られないため、project detailingの明示値だけを採用する。
 */

import { resolveFoundationBeamDetailingProperty } from './foundationBeamDetailingHierarchy.js';

function validateUplift(rawValue) {
  if (typeof rawValue !== 'boolean') {
    return { ok: false, reason: 'foundation-uplift-invalid' };
  }
  return { ok: true, value: rawValue };
}

/**
 * @param {Object} projectDetailing
 * @param {{elementId:string|number,sectionId?:string|number|null,side:'start'|'end'}} target
 */
export function resolveFoundationBeamUplift(projectDetailing, target = {}) {
  const result = resolveFoundationBeamDetailingProperty(projectDetailing, target, {
    property: 'uplift',
    validate: validateUplift,
    missingReason: 'foundation-uplift-not-specified',
  });
  return {
    ...result,
    uplift: result.resolved ? result.value : null,
  };
}

export const _foundationBeamUpliftResolverInternals = Object.freeze({ validateUplift });
