/**
 * @fileoverview R13 基礎大梁定着pathの平面内far-sideかぶりをfail-closedで確認する。
 *
 * FoundationColumn FDのRC柱断面に明示されたかぶりを参照する。矩形断面はbeam方向と
 * FoundationColumn局所軸の対応をここで推定せず、4面の明示値の最大値を保守的に採用する。
 * 1面でも未指定ならSTB ApplyConditionsへはまだfallbackせずUNRESOLVEDとする。
 */

import { findElementById } from '../columnSupportUtils.js';

const EPS_MM = 1e-6;
const SOURCE = 'R13-foundation-beam-anchorage-plan-cover';
const RECT_COVER_ATTRIBUTES = Object.freeze([
  'depth_cover_start_X',
  'depth_cover_end_X',
  'depth_cover_start_Y',
  'depth_cover_end_Y',
]);

function result(status, reason, extra = {}) {
  return {
    status,
    resolved: status === 'READY' || status === 'BLOCKED',
    satisfied: status === 'READY' ? true : status === 'BLOCKED' ? false : null,
    planCoverReady: status === 'READY',
    productionReady: false,
    reason: reason || null,
    blockers: reason ? [reason] : [],
    productionBlockers:
      status === 'READY'
        ? ['foundation-anchorage-member-identity-world-continuity-unresolved']
        : [],
    source: SOURCE,
    ...extra,
  };
}

function unresolved(reason, extra = {}) {
  return result('UNRESOLVED', reason, extra);
}

function blocked(reason, extra = {}) {
  return result('BLOCKED', reason, extra);
}

function invalid(reason, extra = {}) {
  return result('INVALID', reason, extra);
}

function ready(extra = {}) {
  return result('READY', null, extra);
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function allElements(root) {
  const values = [];
  const visit = (node) => {
    for (const child of Array.from(node?.childNodes || [])) {
      if (child?.nodeType !== 1) continue;
      values.push(child);
      visit(child);
    }
  };
  visit(root);
  return values;
}

function explicitAttributeValues(section, attribute) {
  return [section, ...allElements(section)]
    .map((element) => finiteNonNegative(element?.getAttribute?.(attribute)))
    .filter((value) => value !== null);
}

function resolveFoundationColumnCover(scanTag, endFact, index = null) {
  const sectionId = endFact?.foundationColumn?.sectionFdId;
  if (!sectionId) return unresolved('foundation-anchorage-fd-section-id-missing');
  const section = findElementById(scanTag, 'StbSecColumn_RC', sectionId, index);
  if (!section) {
    return unresolved('foundation-anchorage-fd-section-not-found', { sectionId });
  }

  const descendants = allElements(section);
  const isCircle = descendants.some(
    (element) => (element.localName || element.tagName) === 'StbSecColumnCircle',
  );
  if (isCircle) {
    const values = explicitAttributeValues(section, 'depth_cover');
    if (!values.length) {
      return unresolved('foundation-anchorage-fd-circle-cover-unresolved', { sectionId });
    }
    return ready({
      sectionId,
      sectionShape: 'CIRCLE',
      coverMm: Math.max(...values),
      coverBySide: null,
      basis: 'STB_EXPLICIT_MAX_CIRCLE_COVER',
    });
  }

  const coverBySide = {};
  for (const attribute of RECT_COVER_ATTRIBUTES) {
    const values = explicitAttributeValues(section, attribute);
    if (!values.length) {
      return unresolved('foundation-anchorage-fd-rect-cover-unresolved', {
        sectionId,
        missingAttribute: attribute,
      });
    }
    coverBySide[attribute] = Math.max(...values);
  }
  return ready({
    sectionId,
    sectionShape: 'RECTANGLE',
    coverMm: Math.max(...Object.values(coverBySide)),
    coverBySide,
    basis: 'STB_EXPLICIT_MAX_RECT_SIDE_COVER',
  });
}

/**
 * candidateが使用する最小投影位置からFoundationColumn far faceまでの残りを、
 * 明示かぶり以上確保できるか確認する。
 */
export function resolveFoundationBeamAnchoragePlanCover2023({
  scanTag,
  endFact,
  candidate,
  index = null,
} = {}) {
  if (typeof scanTag !== 'function')
    return invalid('foundation-anchorage-plan-cover-scan-tag-missing');
  if (!endFact?.resolved || !endFact?.foundationColumn) {
    return unresolved('foundation-anchorage-plan-cover-foundation-column-unresolved');
  }
  if (candidate?.geometryReady !== true || !candidate.path) {
    return unresolved(candidate?.reason || 'foundation-anchorage-plan-cover-candidate-unresolved');
  }

  const requiredProjectionMm = Number(candidate.requiredProjectionMm);
  const availableProjectionMm = Number(candidate.availableProjectionMm);
  if (!(requiredProjectionMm > 0) || !(availableProjectionMm >= 0)) {
    return unresolved('foundation-anchorage-plan-cover-projection-unresolved', {
      requiredProjectionMm: Number.isFinite(requiredProjectionMm) ? requiredProjectionMm : null,
      availableProjectionMm: Number.isFinite(availableProjectionMm) ? availableProjectionMm : null,
    });
  }

  const cover = resolveFoundationColumnCover(scanTag, endFact, index);
  if (cover?.status !== 'READY') return cover;
  const farFaceClearMm = availableProjectionMm - requiredProjectionMm;
  const marginAfterCoverMm = farFaceClearMm - cover.coverMm;
  const satisfied = marginAfterCoverMm >= -EPS_MM;
  const common = {
    foundationColumnId: endFact.foundationColumn.id || null,
    sectionId: cover.sectionId,
    requiredProjectionMm,
    availableProjectionMm,
    farFaceClearMm,
    requiredCoverMm: cover.coverMm,
    marginAfterCoverMm,
    coverResolution: cover,
  };
  return satisfied
    ? ready(common)
    : blocked('foundation-anchorage-far-face-cover-insufficient', common);
}

export const _foundationBeamAnchoragePlanCover2023Internals = Object.freeze({
  explicitAttributeValues,
  resolveFoundationColumnCover,
  allElements,
});
