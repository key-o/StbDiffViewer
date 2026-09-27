/**
 * @fileoverview R12 小梁端bar factsと支持大梁断面を結び、geometry生成前の定着requirementを構築する。
 */

import { createTagScanner, findElementById } from '../columnSupportUtils.js';
import {
  resolveSmallBeamBottomAnchorageRequirement,
  resolveSmallBeamTopAnchorageRequirement,
} from './smallBeamAnchorageRequirement.js';
import { resolveSmallBeamBarAvailableProjection } from './smallBeamAvailableProjection.js';
import { resolveSmallBeamGirderSupportContext } from './smallBeamSupportGirderContext.js';
import { resolveSmallBeamTopTailAvailability } from './smallBeamTailAvailability.js';
import { resolveSmallBeamTopTotalAnchorageLength } from './smallBeamTotalAnchorageLength.js';
import { resolveSmallBeamSupportFaceGeometry } from './smallBeamSupportFaceGeometry.js';
import { buildSmallBeamSupportFacts } from './smallBeamSupportFacts.js';
import { buildRebarModelIndex } from './rebarModelIndex.js';

export { resolveSmallBeamGirderSupportContext } from './smallBeamSupportGirderContext.js';
export { resolveSmallBeamSupportFaceGeometry } from './smallBeamSupportFaceGeometry.js';
export { resolveSmallBeamBarAvailableProjection } from './smallBeamAvailableProjection.js';
export { resolveSmallBeamTopTailAvailability } from './smallBeamTailAvailability.js';
export { resolveSmallBeamTopTotalAnchorageLength } from './smallBeamTotalAnchorageLength.js';

const FOUNDATION_OUT_OF_SCOPE_REASON = 'foundation-small-beam-out-of-r12-scope';
const PROJECTION_TOLERANCE_MM = 1e-6;

function endSegment(layout, side) {
  const segments = layout?.segments || [];
  if (segments.length === 0) return null;
  return side === 'end' ? segments[segments.length - 1] : segments[0];
}

function groupMainBars(segment) {
  const groups = new Map();
  for (const bar of segment?.bars || []) {
    if (bar.role !== 'top' && bar.role !== 'bottom') continue;
    const diaMm = Number(bar.dia);
    const grade = bar.grade || null;
    const key = `${bar.role}|${diaMm}|${grade || ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.bars.push(bar);
    } else {
      groups.set(key, { role: bar.role, diaMm, grade, count: 1, bars: [bar] });
    }
  }
  return [...groups.values()];
}

function readBooleanAttribute(element, name) {
  const value = String(element?.getAttribute?.(name) ?? '')
    .trim()
    .toLowerCase();
  return value === 'true' || value === '1';
}

function isFoundationSmallBeam(scanTag, elementId, beamFacts, index = null) {
  if (beamFacts?.isFoundation === true) return true;
  const beamElement = findElementById(scanTag, 'StbBeam', String(elementId), index);
  return readBooleanAttribute(beamElement, 'isFoundation');
}

function buildFoundationOutOfScopeFacts(elementId, beamFacts) {
  const ends = (beamFacts.ends || []).map((supportEnd) => ({
    side: supportEnd.side,
    support: supportEnd,
    supportContext: null,
    supportGeometry: null,
    status: 'UNRESOLVED',
    reason: FOUNDATION_OUT_OF_SCOPE_REASON,
    requirements: [],
  }));

  return {
    elementId,
    elementName: beamFacts.elementName,
    sectionId: beamFacts.sectionId,
    isCanti: beamFacts.isCanti === true,
    isFoundation: true,
    ends,
    resolved: false,
    supportGeometryResolved: false,
    reason: FOUNDATION_OUT_OF_SCOPE_REASON,
    source: 'R12-small-beam-anchorage-requirement-facts',
  };
}

function buildGroupRequirement(group, beamFacts, supportEnd, supportContext) {
  if (group.role === 'top') {
    const requirement = resolveSmallBeamTopAnchorageRequirement({
      cantilever: beamFacts.isCanti === true,
      supportType: supportEnd.supportType,
      barDiaMm: group.diaMm,
      supportWidthMm: supportContext.supportWidthMm,
      fc: supportContext.fc,
      grade: group.grade,
    });
    return { ...group, requirement };
  }

  const straight = resolveSmallBeamBottomAnchorageRequirement({
    cantilever: beamFacts.isCanti === true,
    supportType: supportEnd.supportType,
    hooked: false,
    barDiaMm: group.diaMm,
  });
  const hooked = resolveSmallBeamBottomAnchorageRequirement({
    cantilever: beamFacts.isCanti === true,
    supportType: supportEnd.supportType,
    hooked: true,
    barDiaMm: group.diaMm,
  });
  return {
    ...group,
    requirement: {
      ok: straight.ok || hooked.ok,
      specialRequired: !(straight.ok || hooked.ok),
      kind: 'BOTTOM_ALTERNATIVES',
      reason: straight.ok || hooked.ok ? null : straight.reason || hooked.reason,
      alternatives: [straight, hooked],
    },
  };
}

function unresolvedTail(reason, extra = {}) {
  return {
    resolved: false,
    availableMm: null,
    requiredMm: null,
    ok: null,
    reason,
    barFacts: [],
    worstBar: null,
    source: 'R12-small-beam-group-tail-availability',
    ...extra,
  };
}

function unresolvedProjection(reason, extra = {}) {
  return {
    resolved: false,
    availableMm: null,
    requiredMm: null,
    ok: null,
    reason,
    barFacts: [],
    worstBar: null,
    source: 'R12-small-beam-group-available-projection',
    ...extra,
  };
}

function unresolvedTotalLength(reason, extra = {}) {
  return {
    resolved: false,
    availableMm: null,
    requiredMm: null,
    ok: null,
    reason,
    barFacts: [],
    worstBar: null,
    source: 'R12-small-beam-group-total-length-availability',
    ...extra,
  };
}

/**
 * 同一 role/dia/grade の主筋群についてbar-level投影を解き、最小値をgroupの確保長さとする。
 * requirement自体にはavailableMmを書き戻さず、必要長さと確保長さの契約を分離する。
 */
function resolveGroupProjectionAvailability({
  group,
  requirement,
  scanTag,
  beamEl,
  supportEnd,
  supportContext,
  index = null,
}) {
  if (group.role !== 'top') return null;
  if (!requirement?.ok) {
    return unresolvedProjection(requirement?.reason || 'top-anchorage-requirement-unresolved');
  }

  const bars = Array.isArray(group.bars) ? group.bars : [];
  if (bars.length === 0) return unresolvedProjection('small-beam-group-bars-missing');

  const barFacts = bars.map((bar) =>
    resolveSmallBeamBarAvailableProjection({
      scanTag,
      beamEl,
      supportEnd,
      supportContext,
      bar,
      index,
    }),
  );
  const unresolvedBar = barFacts.find((fact) => !fact.resolved);
  if (unresolvedBar) {
    return unresolvedProjection(unresolvedBar.reason || 'small-beam-bar-projection-unresolved', {
      barFacts,
    });
  }

  const worstBar = barFacts.reduce(
    (worst, fact) =>
      !worst || fact.availableProjectionMm < worst.availableProjectionMm ? fact : worst,
    null,
  );
  const availableMm = worstBar?.availableProjectionMm;
  const requiredMm = Number(requirement.projectionRequiredMm);
  const ok =
    Number.isFinite(availableMm) && Number.isFinite(requiredMm)
      ? availableMm + PROJECTION_TOLERANCE_MM >= requiredMm
      : null;

  if (!Number.isFinite(availableMm)) {
    return unresolvedProjection('small-beam-group-projection-nonfinite', { barFacts, worstBar });
  }

  return {
    resolved: true,
    availableMm,
    requiredMm: Number.isFinite(requiredMm) ? requiredMm : null,
    ok,
    reason: null,
    barFacts,
    worstBar,
    source: 'R12-small-beam-group-available-projection',
  };
}

function resolveGroupTailAvailability({
  group,
  requirement,
  scanTag,
  beamEl,
  supportGirderEl,
  supportEnd,
  supportContext,
  index = null,
}) {
  if (group.role !== 'top') return null;
  if (!requirement?.ok) {
    return unresolvedTail(requirement?.reason || 'top-anchorage-requirement-unresolved');
  }

  const bars = Array.isArray(group.bars) ? group.bars : [];
  if (bars.length === 0) return unresolvedTail('small-beam-group-bars-missing');

  const barFacts = bars.map((bar) =>
    resolveSmallBeamTopTailAvailability({
      scanTag,
      beamEl,
      supportGirderEl,
      supportEnd,
      supportContext,
      bar,
      index,
    }),
  );
  const unresolvedBar = barFacts.find((fact) => !fact.resolved);
  if (unresolvedBar) {
    return unresolvedTail(unresolvedBar.reason || 'small-beam-tail-availability-unresolved', {
      barFacts,
    });
  }

  const worstBar = barFacts.reduce(
    (worst, fact) => (!worst || fact.availableTailMm < worst.availableTailMm ? fact : worst),
    null,
  );
  const availableMm = worstBar?.availableTailMm;
  const requiredMm = Number(requirement.tailRequiredMm);
  const ok =
    Number.isFinite(availableMm) && Number.isFinite(requiredMm)
      ? availableMm + PROJECTION_TOLERANCE_MM >= requiredMm
      : null;

  if (!Number.isFinite(availableMm)) {
    return unresolvedTail('small-beam-group-tail-nonfinite', { barFacts, worstBar });
  }

  return {
    resolved: true,
    availableMm,
    requiredMm: Number.isFinite(requiredMm) ? requiredMm : null,
    ok,
    reason: null,
    barFacts,
    worstBar,
    source: 'R12-small-beam-group-tail-availability',
  };
}

function resolveGroupTotalLengthAvailability({ group, requirement }) {
  if (group.role !== 'top') return null;
  if (!requirement?.ok) {
    return unresolvedTotalLength(requirement?.reason || 'top-anchorage-requirement-unresolved');
  }

  const projectionFacts = group.projectionAvailability?.barFacts;
  const tailFacts = group.tailAvailability?.barFacts;
  const bars = Array.isArray(group.bars) ? group.bars : [];
  if (!Array.isArray(projectionFacts) || !Array.isArray(tailFacts) || bars.length === 0) {
    return unresolvedTotalLength('small-beam-total-length-source-facts-missing');
  }
  if (projectionFacts.length !== bars.length || tailFacts.length !== bars.length) {
    return unresolvedTotalLength('small-beam-total-length-source-count-mismatch', {
      projectionCount: projectionFacts.length,
      tailCount: tailFacts.length,
      barCount: bars.length,
    });
  }

  const barFacts = bars.map((bar, index) => ({
    ...resolveSmallBeamTopTotalAnchorageLength({
      projectionFact: projectionFacts[index],
      tailFact: tailFacts[index],
      requirement,
    }),
    barIndex: index,
    barLayer: bar?.layer ?? null,
  }));
  const unresolvedBar = barFacts.find((fact) => !fact.resolved);
  if (unresolvedBar) {
    return unresolvedTotalLength(unresolvedBar.reason || 'small-beam-total-length-unresolved', {
      barFacts,
    });
  }

  const worstBar = barFacts.reduce(
    (worst, fact) => (!worst || fact.availableTotalMm < worst.availableTotalMm ? fact : worst),
    null,
  );
  const availableMm = worstBar?.availableTotalMm;
  const requiredMm = Number(requirement.l2RequiredMm);
  const ok =
    Number.isFinite(availableMm) && Number.isFinite(requiredMm)
      ? availableMm + PROJECTION_TOLERANCE_MM >= requiredMm
      : null;

  if (!Number.isFinite(availableMm)) {
    return unresolvedTotalLength('small-beam-group-total-length-nonfinite', {
      barFacts,
      worstBar,
    });
  }

  return {
    resolved: true,
    availableMm,
    requiredMm: Number.isFinite(requiredMm) ? requiredMm : null,
    ok,
    reason: null,
    barFacts,
    worstBar,
    source: 'R12-small-beam-group-total-length-availability',
  };
}

/**
 * 小梁ごとの端部定着requirement factsを構築する。
 * 実支持面geometryとR12-N投影可能長さはfactsとして保持するが、
 * 折曲げ方向・定着mode・RebarPathは生成しない。
 */
export function buildSmallBeamAnchorageRequirementFacts(
  xmlDoc,
  beamLayoutMaps,
  supportFacts = null,
  sharedScanTag = null,
  options = {},
) {
  const beam = new Map();
  const unresolved = [];
  const projectionUnresolved = [];
  const tailUnresolved = [];
  const totalLengthUnresolved = [];
  if (!xmlDoc || !beamLayoutMaps?.beam) {
    return { beam, unresolved, projectionUnresolved, tailUnresolved, totalLengthUnresolved };
  }

  const scanTag = sharedScanTag || createTagScanner(xmlDoc);
  const modelIndex =
    options.modelIndex || options.index || buildRebarModelIndex(xmlDoc, { scanTag });
  const supports = supportFacts || buildSmallBeamSupportFacts(xmlDoc, scanTag, modelIndex);

  for (const [elementId, beamFacts] of supports.beam || []) {
    const isFoundation = isFoundationSmallBeam(scanTag, elementId, beamFacts, modelIndex);
    if (isFoundation) {
      beam.set(elementId, buildFoundationOutOfScopeFacts(elementId, beamFacts));
      unresolved.push({
        elementId,
        elementName: beamFacts.elementName,
        side: null,
        reason: FOUNDATION_OUT_OF_SCOPE_REASON,
      });
      continue;
    }

    const layout = beamLayoutMaps.beam.get(String(beamFacts.sectionId));
    if (!layout) {
      unresolved.push({ elementId, reason: 'small-beam-layout-not-found' });
      continue;
    }

    const beamEl = findElementById(scanTag, 'StbBeam', String(elementId), modelIndex);
    const endFacts = [];
    for (const supportEnd of beamFacts.ends || []) {
      if (supportEnd.supportType === 'FREE_END') {
        endFacts.push({
          side: supportEnd.side,
          support: supportEnd,
          supportContext: null,
          supportGeometry: null,
          status: 'FREE_END',
          requirements: [],
        });
        continue;
      }

      const segment = endSegment(layout, supportEnd.side);
      const groups = groupMainBars(segment);
      const supportContext = resolveSmallBeamGirderSupportContext(scanTag, supportEnd, {
        coverMm: options.coverMm,
        index: modelIndex,
      });
      const supportGirderEl = supportEnd.supportId
        ? findElementById(scanTag, 'StbGirder', String(supportEnd.supportId), modelIndex)
        : null;
      const supportGeometry = resolveSmallBeamSupportFaceGeometry(
        scanTag,
        beamEl,
        supportEnd,
        supportContext,
        { index: modelIndex },
      );
      const requirements = groups.map((group) => {
        const item = buildGroupRequirement(group, beamFacts, supportEnd, supportContext);
        if (item.role === 'top') {
          item.projectionAvailability = resolveGroupProjectionAvailability({
            group: item,
            requirement: item.requirement,
            scanTag,
            beamEl,
            supportEnd,
            supportContext,
            index: modelIndex,
          });
          if (item.requirement.ok && item.projectionAvailability?.resolved === false) {
            projectionUnresolved.push({
              elementId,
              elementName: beamFacts.elementName,
              side: supportEnd.side,
              role: item.role,
              diaMm: item.diaMm,
              grade: item.grade,
              reason: item.projectionAvailability.reason,
            });
          }
          item.tailAvailability = resolveGroupTailAvailability({
            group: item,
            requirement: item.requirement,
            scanTag,
            beamEl,
            supportGirderEl,
            supportEnd,
            supportContext,
            index: modelIndex,
          });
          if (item.requirement.ok && item.tailAvailability?.resolved === false) {
            tailUnresolved.push({
              elementId,
              elementName: beamFacts.elementName,
              side: supportEnd.side,
              role: item.role,
              diaMm: item.diaMm,
              grade: item.grade,
              reason: item.tailAvailability.reason,
            });
          }
          item.totalLengthAvailability = resolveGroupTotalLengthAvailability({
            group: item,
            requirement: item.requirement,
          });
          if (item.requirement.ok && item.totalLengthAvailability?.resolved === false) {
            totalLengthUnresolved.push({
              elementId,
              elementName: beamFacts.elementName,
              side: supportEnd.side,
              role: item.role,
              diaMm: item.diaMm,
              grade: item.grade,
              reason: item.totalLengthAvailability.reason,
            });
          }
        }
        return item;
      });
      const resolved = requirements.every((item) => item.requirement.ok);
      const status = resolved ? 'RESOLVED' : 'UNRESOLVED';

      endFacts.push({
        side: supportEnd.side,
        support: supportEnd,
        supportContext,
        supportGeometry,
        status,
        requirements,
      });

      for (const item of requirements) {
        if (!item.requirement.ok) {
          unresolved.push({
            elementId,
            elementName: beamFacts.elementName,
            side: supportEnd.side,
            role: item.role,
            diaMm: item.diaMm,
            grade: item.grade,
            reason:
              item.requirement.reason ||
              supportContext.reason ||
              'anchorage-requirement-unresolved',
          });
        }
      }
    }

    beam.set(elementId, {
      elementId,
      elementName: beamFacts.elementName,
      sectionId: beamFacts.sectionId,
      isCanti: beamFacts.isCanti === true,
      isFoundation: false,
      ends: endFacts,
      resolved: endFacts.every((end) => end.status === 'RESOLVED' || end.status === 'FREE_END'),
      supportGeometryResolved: endFacts.every(
        (end) => end.status === 'FREE_END' || end.supportGeometry?.resolved === true,
      ),
      source: 'R12-small-beam-anchorage-requirement-facts',
    });
  }

  return { beam, unresolved, projectionUnresolved, tailUnresolved, totalLengthUnresolved };
}
