/**
 * @fileoverview R13 基礎梁のproject detailingを common < section < member < member-end
 * の共通階層として解決する。
 *
 * コンクリート強度の段階指定と同様に、より局所的な指定を優先する。個々の設定項目
 * （標準図type、普通/軽量、浮上り条件など）の値解釈は呼出側に任せ、このmoduleは
 * container shape・優先順位・provenanceだけを担当する。
 */

const DETAILING_KEY = 'FOUNDATION_BEAM_ANCHORAGE';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function invalid(reason, extra = {}) {
  return {
    status: 'INVALID',
    resolved: false,
    value: null,
    source: 'project-detailing',
    basis: null,
    blockers: [reason],
    ...extra,
  };
}

function unresolved(reason, extra = {}) {
  return {
    status: 'UNRESOLVED',
    resolved: false,
    value: null,
    source: null,
    basis: null,
    blockers: [reason],
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

function container(entry, key) {
  if (!hasOwn(entry, key)) return { status: 'MISSING', value: null };
  return isPlainObject(entry[key])
    ? { status: 'READY', value: entry[key] }
    : { status: 'INVALID', value: null };
}

function endpointEntry(memberEntry, side) {
  if (!isPlainObject(memberEntry)) return { status: 'MISSING', value: null, suffix: null };

  if (hasOwn(memberEntry, 'ends')) {
    if (!isPlainObject(memberEntry.ends)) {
      return { status: 'INVALID_ENDS', value: null, suffix: 'ends' };
    }
    if (hasOwn(memberEntry.ends, side)) {
      return isPlainObject(memberEntry.ends[side])
        ? { status: 'READY', value: memberEntry.ends[side], suffix: `ends.${side}` }
        : { status: 'INVALID', value: null, suffix: `ends.${side}` };
    }
  }

  // 初期R13 branchで使用した side 直下objectは互換入力として保持する。
  if (hasOwn(memberEntry, side)) {
    return isPlainObject(memberEntry[side])
      ? { status: 'READY', value: memberEntry[side], suffix: side }
      : { status: 'INVALID', value: null, suffix: side };
  }

  return { status: 'MISSING', value: null, suffix: null };
}

/**
 * 基礎梁project detailingの階層を検証して、局所 -> 全体順のlayer配列を返す。
 */
export function resolveFoundationBeamDetailingLayers(
  projectDetailing,
  { elementId, sectionId = null, side } = {},
) {
  if (!['start', 'end'].includes(side)) {
    return invalid('foundation-detailing-side-invalid', { side: side ?? null });
  }
  if (elementId === null || elementId === undefined || elementId === '') {
    return invalid('foundation-detailing-element-id-missing');
  }

  const root = projectEntry(projectDetailing);
  if (root.status === 'MISSING') {
    return unresolved('foundation-detailing-project-setting-missing');
  }
  if (root.status === 'INVALID_SPECIAL') {
    return invalid('foundation-detailing-project-special-invalid');
  }
  if (root.status === 'INVALID') {
    return invalid('foundation-detailing-project-entry-invalid', { location: root.location });
  }

  const common = container(root.value, 'common');
  if (common.status === 'INVALID') return invalid('foundation-detailing-common-invalid');
  const sections = container(root.value, 'sections');
  if (sections.status === 'INVALID') return invalid('foundation-detailing-sections-invalid');
  const members = container(root.value, 'members');
  if (members.status === 'INVALID') return invalid('foundation-detailing-members-invalid');

  const sectionKey = sectionId === null || sectionId === undefined ? null : String(sectionId);
  const sectionEntry = sectionKey && sections.value ? sections.value[sectionKey] : null;
  if (sectionEntry !== null && sectionEntry !== undefined && !isPlainObject(sectionEntry)) {
    return invalid('foundation-detailing-section-entry-invalid', { sectionId: sectionKey });
  }

  const memberKey = String(elementId);
  const memberEntry = members.value ? members.value[memberKey] : null;
  if (memberEntry !== null && memberEntry !== undefined && !isPlainObject(memberEntry)) {
    return invalid('foundation-detailing-member-entry-invalid', { elementId: memberKey });
  }

  const endpoint = endpointEntry(memberEntry, side);
  if (endpoint.status === 'INVALID_ENDS') {
    return invalid('foundation-detailing-member-ends-invalid', { elementId: memberKey });
  }
  if (endpoint.status === 'INVALID') {
    return invalid('foundation-detailing-member-end-entry-invalid', {
      elementId: memberKey,
      side,
    });
  }

  return {
    status: 'READY',
    resolved: true,
    value: null,
    source: 'project-detailing',
    basis: null,
    blockers: [],
    rootLocation: root.location,
    elementId: memberKey,
    sectionId: sectionKey,
    side,
    layers: [
      {
        value: endpoint.value,
        basis: 'PROJECT_MEMBER_END',
        location: endpoint.suffix
          ? `${root.location}.members.${memberKey}.${endpoint.suffix}`
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
    ],
  };
}

/**
 * 同一階層から1つのpropertyを解決する。局所layerにpropertyが存在するが不正な場合、
 * 下位layerへfallbackしない。
 *
 * @param {Object} projectDetailing
 * @param {Object} target
 * @param {Object} options
 * @param {string} options.property
 * @param {function(any):{ok:boolean,value?:any,reason?:string,extra?:Object}} options.validate
 * @param {string} options.missingReason
 */
export function resolveFoundationBeamDetailingProperty(
  projectDetailing,
  target,
  { property, validate, missingReason },
) {
  const hierarchy = resolveFoundationBeamDetailingLayers(projectDetailing, target);
  if (!hierarchy.resolved) return hierarchy;

  for (const layer of hierarchy.layers) {
    if (!layer.value || !hasOwn(layer.value, property)) continue;
    const checked = validate(layer.value[property]);
    if (!checked?.ok) {
      return invalid(checked?.reason || 'foundation-detailing-property-invalid', {
        elementId: hierarchy.elementId,
        sectionId: hierarchy.sectionId,
        side: hierarchy.side,
        location: layer.location,
        property,
        rawValue: layer.value[property] ?? null,
        ...(checked?.extra || {}),
      });
    }
    return {
      status: 'READY',
      resolved: true,
      value: checked.value,
      source: 'project-detailing',
      basis: layer.basis,
      location: layer.location,
      blockers: [],
      elementId: hierarchy.elementId,
      sectionId: hierarchy.sectionId,
      side: hierarchy.side,
      property,
      ...(checked?.extra || {}),
    };
  }

  return unresolved(missingReason, {
    source: 'project-detailing',
    elementId: hierarchy.elementId,
    sectionId: hierarchy.sectionId,
    side: hierarchy.side,
    location: hierarchy.rootLocation,
    property,
  });
}

export const _foundationBeamDetailingHierarchyInternals = Object.freeze({
  isPlainObject,
  hasOwn,
  projectEntry,
  container,
  endpointEntry,
});
