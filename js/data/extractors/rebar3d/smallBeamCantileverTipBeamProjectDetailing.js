/**
 * @fileoverview R12-AI 図9-4先端小梁取合いのproject explicit detailing契約。
 *
 * 図9-4はC形筋を「先端小梁あばら筋と同径・同間隔」とするがgradeと断面内配置面は
 * 一意に規定しない。productionへ進む前にこの2点だけをprojectDetailingで明示確認する。
 * 図9-4-2の主筋は先端小梁主筋そのものを既存identityから後段で解決し、
 * 片持ち梁主筋とのpairingを要求しない。
 */

import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';

const SMALL_BEAM_CANTILEVER_TIP_BEAM_DETAILING_TYPE = 'SMALL_BEAM_CANTILEVER_TIP_BEAM';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function crossSectionDetail(value) {
  if (!isPlainObject(value)) return null;
  return {
    mode: text(value.mode),
    spineUMm: finiteOrNull(value.spineUMm),
    topVMm: finiteOrNull(value.topVMm),
    bottomVMm: finiteOrNull(value.bottomVMm),
    openDirection: text(value.openDirection),
    verified: value.verified === true,
  };
}

export function resolveSmallBeamCantileverTipBeamCBarCrossSection(value) {
  const detail = crossSectionDetail(value);
  if (!detail) {
    return {
      resolved: false,
      geometryReady: false,
      reason: 'cantilever-tip-beam-c-bar-cross-section-explicit-detail-required',
      value: null,
    };
  }
  if (detail.mode !== 'EXPLICIT_MEMBER_LOCAL' || detail.verified !== true) {
    return {
      resolved: false,
      geometryReady: false,
      reason: 'cantilever-tip-beam-c-bar-cross-section-verification-required',
      value: detail,
    };
  }
  if (![detail.spineUMm, detail.topVMm, detail.bottomVMm].every(Number.isFinite)) {
    return {
      resolved: false,
      geometryReady: false,
      reason: 'cantilever-tip-beam-c-bar-cross-section-coordinate-unresolved',
      value: detail,
    };
  }
  if (!(detail.topVMm > detail.bottomVMm)) {
    return {
      resolved: false,
      geometryReady: false,
      reason: 'cantilever-tip-beam-c-bar-cross-section-vertical-order-invalid',
      value: detail,
    };
  }
  if (!['POSITIVE_U', 'NEGATIVE_U'].includes(detail.openDirection)) {
    return {
      resolved: false,
      geometryReady: false,
      reason: 'cantilever-tip-beam-c-bar-open-direction-unresolved',
      value: detail,
    };
  }
  return {
    resolved: true,
    geometryReady: true,
    reason: null,
    value: detail,
  };
}

function unresolved(reason, extra = {}) {
  return {
    resolved: false,
    detailingReady: false,
    productionReady: false,
    status: 'UNRESOLVED',
    reason,
    source: null,
    assignment: null,
    blockers: [reason],
    ...extra,
  };
}

function projectEntry(projectDetailing) {
  if (!isPlainObject(projectDetailing)) return null;
  if (
    Object.prototype.hasOwnProperty.call(
      projectDetailing,
      SMALL_BEAM_CANTILEVER_TIP_BEAM_DETAILING_TYPE,
    )
  ) {
    return projectDetailing[SMALL_BEAM_CANTILEVER_TIP_BEAM_DETAILING_TYPE];
  }
  if (
    isPlainObject(projectDetailing.special) &&
    Object.prototype.hasOwnProperty.call(
      projectDetailing.special,
      SMALL_BEAM_CANTILEVER_TIP_BEAM_DETAILING_TYPE,
    )
  ) {
    return projectDetailing.special[SMALL_BEAM_CANTILEVER_TIP_BEAM_DETAILING_TYPE];
  }
  return null;
}

function isDeferredReason(reason) {
  return [
    'cantilever-tip-beam-explicit-detail-required',
    'cantilever-tip-beam-production-not-enabled',
    'cantilever-tip-beam-assignment-missing',
  ].includes(reason);
}

export function resolveSmallBeamCantileverTipBeamDetailing({ fact, projectDetailing } = {}) {
  if (!fact?.resolved) {
    return unresolved(fact?.reason || 'cantilever-tip-beam-fact-unresolved');
  }
  if (!['FIGURE_9_4_1', 'FIGURE_9_4_2'].includes(fact.figureCase)) {
    return unresolved('cantilever-tip-beam-figure-case-unresolved');
  }

  const source = projectDetailing === undefined ? getRebarProjectDetailing() : projectDetailing;
  const entry = projectEntry(source);
  if (entry === null || entry === undefined) {
    return unresolved('cantilever-tip-beam-explicit-detail-required', {
      source: 'figure-9-4-requirement-only',
    });
  }
  if (!isPlainObject(entry)) {
    return unresolved('cantilever-tip-beam-project-detailing-entry-invalid');
  }
  if (entry.productionEnabled !== true) {
    return unresolved('cantilever-tip-beam-production-not-enabled');
  }
  if (entry.productionMode !== 'EXPLICIT') {
    return unresolved('cantilever-tip-beam-explicit-production-mode-required');
  }
  if (!Array.isArray(entry.assignments)) {
    return unresolved('cantilever-tip-beam-assignments-required');
  }

  const memberId = String(fact.elementId);
  const tipBeamId = String(fact.tipBeamId);
  const matches = entry.assignments.filter(
    (assignment) =>
      isPlainObject(assignment) &&
      String(assignment.memberId) === memberId &&
      String(assignment.tipBeamId) === tipBeamId,
  );
  if (matches.length !== 1) {
    return unresolved(
      matches.length === 0
        ? 'cantilever-tip-beam-assignment-missing'
        : 'cantilever-tip-beam-assignment-ambiguous',
      { assignmentCount: matches.length },
    );
  }

  const raw = matches[0];
  if (raw.figureCase !== fact.figureCase) {
    return unresolved('cantilever-tip-beam-figure-case-mismatch', {
      expectedFigureCase: fact.figureCase,
      assignedFigureCase: raw.figureCase || null,
    });
  }

  const rawGrade = text(raw.cBarGrade);
  const normalizedGrade = REBAR_STANDARD_RULES.normalizeGrade(rawGrade);
  if (!rawGrade || !normalizedGrade || raw.cBarGradeVerified !== true) {
    return unresolved('cantilever-tip-beam-c-bar-verified-grade-required');
  }
  if (raw.cBarPlacementMode !== 'STANDARD_FIGURE_9_4' || raw.cBarPlacementVerified !== true) {
    return unresolved('cantilever-tip-beam-c-bar-standard-placement-verification-required');
  }

  const cBarCrossSection = resolveSmallBeamCantileverTipBeamCBarCrossSection(raw.cBarCrossSection);

  return {
    resolved: true,
    detailingReady: true,
    productionReady: false,
    status: 'EXPLICIT_DETAIL_READY',
    reason: null,
    source: 'project-detailing',
    assignment: {
      memberId,
      tipBeamId,
      figureCase: fact.figureCase,
      cBarGrade: rawGrade,
      cBarNormalizedGrade: normalizedGrade,
      cBarGradeVerified: true,
      cBarPlacementMode: 'STANDARD_FIGURE_9_4',
      cBarPlacementVerified: true,
      cBarCrossSection: cBarCrossSection.value,
      cBarCrossSectionReady: cBarCrossSection.resolved,
      cBarCrossSectionReason: cBarCrossSection.reason,
      note: text(raw.note),
    },
    blockers: [
      'cantilever-tip-beam-production-path-not-yet-connected',
      ...(cBarCrossSection.resolved ? [] : [cBarCrossSection.reason]),
    ],
  };
}

export function attachSmallBeamCantileverTipBeamDetailing(facts, options = {}) {
  if (!facts?.beam) {
    return {
      ...(facts || {}),
      detailingUnresolved: [],
      detailingDeferred: [],
    };
  }

  const detailingUnresolved = [];
  const detailingDeferred = [];
  for (const [elementId, fact] of facts.beam) {
    if (!fact?.resolved) continue;
    fact.tipBeamDetailing = resolveSmallBeamCantileverTipBeamDetailing({
      fact,
      projectDetailing: options.projectDetailing,
    });
    if (!fact.tipBeamDetailing.resolved) {
      const row = {
        elementId: String(elementId),
        tipBeamId: fact.tipBeamId || null,
        figureCase: fact.figureCase || null,
        reason: fact.tipBeamDetailing.reason,
      };
      (isDeferredReason(row.reason) ? detailingDeferred : detailingUnresolved).push(row);
    }
  }

  return {
    ...facts,
    detailingUnresolved,
    detailingDeferred,
  };
}
