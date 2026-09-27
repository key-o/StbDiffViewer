/**
 * @fileoverview R13 基礎梁定着タイプをproject detailingの段階指定から解決する。
 *
 * 日建連・JSCA「鉄筋コンクリート造配筋標準図」2023年版 §6 に合わせ、
 * 基礎大梁は A1/B1/B2/C1/C2、基礎小梁は A1/A2/B1/B2 を正規typeとする。
 *
 * projectDetailing.FOUNDATION_BEAM_ANCHORAGE の優先順位:
 * 1. member end
 * 2. member
 * 3. section
 * 4. common
 *
 * これはコンクリート強度の member > section > story > common と同様に、
 * より局所的な指定を優先する考え方である。ただし定着タイプは階属性ではないため、
 * 現段階では story level を設けない。
 */

const DETAILING_KEY = 'FOUNDATION_BEAM_ANCHORAGE';

export const FOUNDATION_GIRDER_ANCHORAGE_TYPES = Object.freeze(['A1', 'B1', 'B2', 'C1', 'C2']);
export const FOUNDATION_SMALL_BEAM_ANCHORAGE_TYPES = Object.freeze(['A1', 'A2', 'B1', 'B2']);

const GIRDER_TYPE_SET = new Set(FOUNDATION_GIRDER_ANCHORAGE_TYPES);
const BEAM_TYPE_SET = new Set(FOUNDATION_SMALL_BEAM_ANCHORAGE_TYPES);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeType(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim().toUpperCase();
}

function normalizeMemberKind(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase();
  if (normalized === 'STBGIRDER' || normalized === 'GIRDER') return 'GIRDER';
  if (normalized === 'STBBEAM' || normalized === 'BEAM') return 'BEAM';
  return null;
}

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    type: null,
    source: null,
    basis: null,
    blockers: [reason],
    ...extra,
  };
}

function invalid(reason, extra = {}) {
  return {
    status: 'INVALID',
    resolved: false,
    type: null,
    source: 'project-detailing',
    basis: null,
    blockers: [reason],
    ...extra,
  };
}

function ready(type, basis, location, memberKind, extra = {}) {
  return {
    status: 'READY',
    resolved: true,
    type,
    source: 'project-detailing',
    basis,
    location,
    memberKind,
    blockers: [],
    ...extra,
  };
}

function projectEntry(projectDetailing) {
  if (!isPlainObject(projectDetailing)) return { status: 'MISSING', value: null, location: null };

  if (hasOwn(projectDetailing, DETAILING_KEY)) {
    return isPlainObject(projectDetailing[DETAILING_KEY])
      ? { status: 'READY', value: projectDetailing[DETAILING_KEY], location: DETAILING_KEY }
      : { status: 'INVALID', value: null, location: DETAILING_KEY };
  }

  if (!hasOwn(projectDetailing, 'special')) {
    return { status: 'MISSING', value: null, location: null };
  }
  if (!isPlainObject(projectDetailing.special)) {
    return { status: 'INVALID_SPECIAL', value: null, location: 'special' };
  }
  if (!hasOwn(projectDetailing.special, DETAILING_KEY)) {
    return { status: 'MISSING', value: null, location: null };
  }
  return isPlainObject(projectDetailing.special[DETAILING_KEY])
    ? {
        status: 'READY',
        value: projectDetailing.special[DETAILING_KEY],
        location: `special.${DETAILING_KEY}`,
      }
    : {
        status: 'INVALID',
        value: null,
        location: `special.${DETAILING_KEY}`,
      };
}

function validateContainer(entry, key) {
  if (!hasOwn(entry, key)) return { status: 'MISSING', value: null };
  return isPlainObject(entry[key])
    ? { status: 'READY', value: entry[key] }
    : { status: 'INVALID', value: null };
}

function endEntry(memberEntry, side) {
  if (!isPlainObject(memberEntry)) return { status: 'MISSING', value: null, locationSuffix: null };

  if (hasOwn(memberEntry, 'ends')) {
    if (!isPlainObject(memberEntry.ends)) {
      return { status: 'INVALID_ENDS', value: null, locationSuffix: 'ends' };
    }
    if (hasOwn(memberEntry.ends, side)) {
      return isPlainObject(memberEntry.ends[side])
        ? { status: 'READY', value: memberEntry.ends[side], locationSuffix: `ends.${side}` }
        : { status: 'INVALID', value: null, locationSuffix: `ends.${side}` };
    }
  }

  // side直下は旧branchで使用していたため、object形に限り互換入力として受理する。
  if (hasOwn(memberEntry, side)) {
    return isPlainObject(memberEntry[side])
      ? { status: 'READY', value: memberEntry[side], locationSuffix: side }
      : { status: 'INVALID', value: null, locationSuffix: side };
  }

  return { status: 'MISSING', value: null, locationSuffix: null };
}

function typeSetForMemberKind(memberKind) {
  if (memberKind === 'GIRDER') return GIRDER_TYPE_SET;
  if (memberKind === 'BEAM') return BEAM_TYPE_SET;
  return null;
}

function validateTypeForKind(rawType, memberKind) {
  const type = normalizeType(rawType);
  if (!type) return { status: 'MISSING', type: null };
  const allowed = typeSetForMemberKind(memberKind);
  if (!allowed) return { status: 'INVALID_KIND', type: null };
  return allowed.has(type) ? { status: 'READY', type } : { status: 'INVALID_TYPE', type: null };
}

function candidateFromLayer(layer, { basis, location, memberKind }) {
  if (!layer) return { status: 'MISSING' };
  if (!isPlainObject(layer))
    return { status: 'INVALID', reason: 'foundation-anchorage-layer-invalid' };
  if (!hasOwn(layer, 'type')) return { status: 'MISSING' };

  const selected = validateTypeForKind(layer.type, memberKind);
  if (selected.status === 'INVALID_KIND') {
    return { status: 'INVALID', reason: 'foundation-anchorage-member-kind-invalid' };
  }
  if (selected.status === 'INVALID_TYPE') {
    return {
      status: 'INVALID',
      reason: 'foundation-anchorage-type-invalid-for-member-kind',
      rawType: layer.type ?? null,
    };
  }
  if (selected.status === 'MISSING') {
    return { status: 'INVALID', reason: 'foundation-anchorage-type-empty' };
  }
  return { status: 'READY', type: selected.type, basis, location };
}

/**
 * @param {Object} projectDetailing project-scoped detailing object
 * @param {Object} target
 * @param {string|number} target.elementId 基礎梁ID
 * @param {string|number} target.sectionId 参照断面ID
 * @param {'StbGirder'|'StbBeam'|'GIRDER'|'BEAM'} target.memberTag
 * @param {'start'|'end'} target.side
 */
export function resolveFoundationBeamAnchorageType(
  projectDetailing,
  { elementId, sectionId = null, memberTag = null, side } = {},
) {
  if (!['start', 'end'].includes(side)) {
    return invalid('foundation-anchorage-side-invalid', { side: side ?? null });
  }
  if (elementId === null || elementId === undefined || elementId === '') {
    return invalid('foundation-anchorage-element-id-missing');
  }

  const memberKind = normalizeMemberKind(memberTag);
  if (!memberKind) {
    return invalid('foundation-anchorage-member-kind-invalid', { memberTag: memberTag ?? null });
  }

  const root = projectEntry(projectDetailing);
  if (root.status === 'MISSING') {
    return unresolved('foundation-anchorage-project-setting-missing', { memberKind });
  }
  if (root.status === 'INVALID_SPECIAL') {
    return invalid('foundation-anchorage-project-special-invalid', { memberKind });
  }
  if (root.status === 'INVALID') {
    return invalid('foundation-anchorage-project-entry-invalid', {
      memberKind,
      location: root.location,
    });
  }

  const entry = root.value;
  const common = validateContainer(entry, 'common');
  if (common.status === 'INVALID') {
    return invalid('foundation-anchorage-common-invalid', { memberKind });
  }
  const sections = validateContainer(entry, 'sections');
  if (sections.status === 'INVALID') {
    return invalid('foundation-anchorage-sections-invalid', { memberKind });
  }
  const members = validateContainer(entry, 'members');
  if (members.status === 'INVALID') {
    return invalid('foundation-anchorage-members-invalid', { memberKind });
  }

  const sectionKey = sectionId === null || sectionId === undefined ? null : String(sectionId);
  const sectionEntry = sectionKey && sections.value ? sections.value[sectionKey] : null;
  if (sectionEntry !== null && sectionEntry !== undefined && !isPlainObject(sectionEntry)) {
    return invalid('foundation-anchorage-section-entry-invalid', {
      memberKind,
      sectionId: sectionKey,
    });
  }

  const memberKey = String(elementId);
  const memberEntry = members.value ? members.value[memberKey] : null;
  if (memberEntry !== null && memberEntry !== undefined && !isPlainObject(memberEntry)) {
    return invalid('foundation-anchorage-member-entry-invalid', {
      memberKind,
      elementId: memberKey,
    });
  }

  const end = endEntry(memberEntry, side);
  if (end.status === 'INVALID_ENDS') {
    return invalid('foundation-anchorage-member-ends-invalid', {
      memberKind,
      elementId: memberKey,
    });
  }
  if (end.status === 'INVALID') {
    return invalid('foundation-anchorage-member-end-entry-invalid', {
      memberKind,
      elementId: memberKey,
      side,
    });
  }

  const layers = [
    {
      value: end.value,
      basis: 'PROJECT_MEMBER_END',
      location: end.locationSuffix
        ? `${root.location}.members.${memberKey}.${end.locationSuffix}`
        : null,
    },
    {
      value: memberEntry,
      basis: 'PROJECT_MEMBER',
      location: `${root.location}.members.${memberKey}`,
    },
    {
      value: sectionEntry,
      basis: 'PROJECT_SECTION',
      location: sectionKey ? `${root.location}.sections.${sectionKey}` : null,
    },
    {
      value: common.value,
      basis: 'PROJECT_COMMON',
      location: `${root.location}.common`,
    },
  ];

  for (const layer of layers) {
    const selected = candidateFromLayer(layer.value, {
      basis: layer.basis,
      location: layer.location,
      memberKind,
    });
    if (selected.status === 'MISSING') continue;
    if (selected.status === 'INVALID') {
      return invalid(selected.reason, {
        memberKind,
        elementId: memberKey,
        sectionId: sectionKey,
        side,
        location: layer.location,
        rawType: selected.rawType ?? null,
      });
    }
    return ready(selected.type, selected.basis, selected.location, memberKind, {
      elementId: memberKey,
      sectionId: sectionKey,
      side,
    });
  }

  return unresolved('foundation-anchorage-type-not-specified', {
    source: 'project-detailing',
    memberKind,
    elementId: memberKey,
    sectionId: sectionKey,
    side,
    location: root.location,
  });
}

export const _foundationBeamAnchorageTypeResolverInternals = Object.freeze({
  projectEntry,
  normalizeType,
  normalizeMemberKind,
  validateTypeForKind,
  endEntry,
});
