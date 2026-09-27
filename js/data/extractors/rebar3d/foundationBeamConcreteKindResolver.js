/**
 * @fileoverview 日建連2023標準図の定着長補正に必要な普通/軽量コンクリート区分を、
 * FOUNDATION_BEAM_ANCHORAGE の common < section < member < member-end 階層から解決する。
 *
 * ST-Bridge の strength_concrete はFc値を持つが普通/軽量の区分を持たないため、ここは
 * project detailing の明示値だけを採用し、未指定時は推定しない。
 */

import { resolveFoundationBeamDetailingProperty } from './foundationBeamDetailingHierarchy.js';

export const FOUNDATION_CONCRETE_KINDS = Object.freeze(['NORMAL', 'LIGHTWEIGHT']);
const KIND_SET = new Set(FOUNDATION_CONCRETE_KINDS);

function validateConcreteKind(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return { ok: false, reason: 'foundation-concrete-kind-empty' };
  }
  const value = rawValue.trim().toUpperCase();
  if (!KIND_SET.has(value)) {
    return {
      ok: false,
      reason: 'foundation-concrete-kind-invalid',
      extra: { allowed: [...FOUNDATION_CONCRETE_KINDS] },
    };
  }
  return { ok: true, value };
}

/**
 * @param {Object} projectDetailing
 * @param {{elementId:string|number,sectionId?:string|number|null,side:'start'|'end'}} target
 */
export function resolveFoundationBeamConcreteKind(projectDetailing, target = {}) {
  const result = resolveFoundationBeamDetailingProperty(projectDetailing, target, {
    property: 'concreteKind',
    validate: validateConcreteKind,
    missingReason: 'foundation-concrete-kind-not-specified',
  });
  if (!result.resolved) {
    return {
      ...result,
      concreteKind: null,
      lightweight: null,
    };
  }
  return {
    ...result,
    concreteKind: result.value,
    lightweight: result.value === 'LIGHTWEIGHT',
  };
}

export const _foundationBeamConcreteKindResolverInternals = Object.freeze({
  validateConcreteKind,
});
