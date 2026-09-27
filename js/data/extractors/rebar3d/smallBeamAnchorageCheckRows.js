/**
 * @fileoverview R12 小梁定着requirement factsを既存チェック一覧へ変換する。
 *
 * R12-N/O/Pで上端筋のLb/B/2投影、90°余長、L2全長をbar-level部分判定する。
 * 下端L3/L3h・折曲げ方向・RebarPathは未判定のまま保持する。
 */

const SIDE_LABELS = Object.freeze({ start: '始端', end: '終端' });
const CATEGORY = '梁定着';
const FOUNDATION_OUT_OF_SCOPE_REASON = 'foundation-small-beam-out-of-r12-scope';

function sectionNameFor(elementId, supportFacts) {
  return supportFacts?.beam?.get?.(String(elementId))?.sectionName || null;
}

function supportGeometryNote(end) {
  const geometry = end?.supportGeometry;
  if (!geometry) return '';
  if (!geometry.resolved) {
    return ` 実支持面geometry未解決（${geometry.reason || 'unknown'}）。`;
  }

  return (
    ` 実支持面geometry: 斜交角${geometry.skewAngleDeg.toFixed(1)}°、` +
    `支持梁内の軸方向のみこみ${Math.round(geometry.effectiveEmbedmentMm)}mm。`
  );
}

function projectionAvailabilityNote(group) {
  const availability = group?.projectionAvailability;
  if (!availability) return ' 投影確保長さは未生成。';
  if (!availability.resolved) {
    return ` 投影確保長さ未解決（${availability.reason || 'unknown'}）。`;
  }

  const worst = availability.worstBar;
  const parts = [` 投影確保長さ=${Math.round(availability.availableMm)}mm`, '（bar-level最小値）'];
  if (Number.isFinite(worst?.barOffsetMm))
    parts.push(`、最不利u=${Math.round(worst.barOffsetMm)}mm`);
  if (Number.isFinite(worst?.supportCoverMm)) {
    parts.push(`、支持梁側かぶり=${Math.round(worst.supportCoverMm)}mm`);
  }
  if (Number.isFinite(worst?.bendStartFromNearMm)) {
    parts.push(`、90°折曲げ開始=${Math.round(worst.bendStartFromNearMm)}mm`);
  }
  parts.push('。');
  return parts.join('');
}

function tailAvailabilityNote(group) {
  const availability = group?.tailAvailability;
  if (!availability) return ' 鉛直余長の確保長さは未生成。';
  if (!availability.resolved) {
    return ` 鉛直余長の確保長さ未解決（${availability.reason || 'unknown'}）。`;
  }

  const worst = availability.worstBar;
  const parts = [
    ` 鉛直余長の確保長さ=${Math.round(availability.availableMm)}mm`,
    '（bar-level最小値）',
  ];
  if (Number.isFinite(worst?.centerFromTopMm)) {
    parts.push(`、最不利上端から芯=${Math.round(worst.centerFromTopMm)}mm`);
  }
  if (Number.isFinite(worst?.supportDepthMm)) {
    parts.push(`、支持梁せい=${Math.round(worst.supportDepthMm)}mm`);
  }
  parts.push('。');
  return parts.join('');
}

function totalLengthAvailabilityNote(group) {
  const availability = group?.totalLengthAvailability;
  if (!availability) return ' L2実中心線長は未生成。';
  if (!availability.resolved) {
    return ` L2実中心線長未解決（${availability.reason || 'unknown'}）。`;
  }

  const worst = availability.worstBar;
  const parts = [` L2実中心線長=${Math.round(availability.availableMm)}mm`, '（bar-level最小値）'];
  if (Number.isFinite(worst?.horizontalLineMm)) {
    parts.push(`、Line=${Math.round(worst.horizontalLineMm)}mm`);
  }
  if (Number.isFinite(worst?.arcLengthMm)) {
    parts.push(`、Arc=${Math.round(worst.arcLengthMm)}mm`);
  }
  if (Number.isFinite(worst?.availableTailMm)) {
    parts.push(`、tail最大=${Math.round(worst.availableTailMm)}mm`);
  }
  parts.push('。');
  return parts.join('');
}

function baseRow(beamFacts, supportFacts, overrides = {}) {
  return {
    category: CATEGORY,
    kind: beamFacts.isFoundation ? '基礎小梁（R12対象外）' : '小梁（要件）',
    elementId: beamFacts.elementId,
    elementName: beamFacts.elementName,
    sectionName: sectionNameFor(beamFacts.elementId, supportFacts),
    position: '-',
    role: null,
    diaMm: null,
    grade: null,
    fc: null,
    count: 0,
    requiredMm: null,
    availableMm: null,
    exact: false,
    ok: null,
    generationStatus: 'UNRESOLVED',
    requirementOnly: true,
    partialCheck: false,
    ...overrides,
  };
}

function uniqueReasons(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

/** R12-Vのgate状態を、特殊納まりと同じ一覧列契約へ変換する。 */
function vertical90ProductionGateRowFields(group) {
  const gate = group?.vertical90ProductionGate;
  if (!gate || group?.anchorageMode?.mode !== 'VERTICAL_90') return {};

  const barGates = Array.isArray(gate.barGates) ? gate.barGates : [];
  const failedBarGates = Array.isArray(gate.failedBarGates) ? gate.failedBarGates : [];
  const blockers = uniqueReasons([
    gate.reason,
    ...failedBarGates.map((barGate) => barGate?.reason),
    ...barGates
      .filter((barGate) => barGate?.resolved !== true || barGate?.productionReady !== true)
      .map((barGate) => barGate?.reason),
  ]);
  const productionGateStatus =
    gate.productionGateReady === true
      ? 'READY'
      : gate.generationStatus === 'NOT_APPLICABLE'
        ? 'NOT_REQUIRED'
        : 'UNRESOLVED';

  return {
    generationStatus: gate.generationStatus || 'UNRESOLVED',
    productionPathCandidate: gate.productionPathCandidate === true,
    productionConsumer: gate.productionConsumer || null,
    specialDetailingRequired: true,
    specialDetailingType: 'SMALL_BEAM_VERTICAL_90',
    specialDetailingStatus: productionGateStatus,
    productionGateStatus,
    productionGateReady: gate.productionGateReady === true,
    productionGateEvaluated: true,
    productionGateSource: gate.source || null,
    productionGateMode: group.anchorageMode.mode,
    productionGateBlockers: blockers,
  };
}

function resolvedRequirementRow(beamFacts, supportFacts, end, group, overrides) {
  return baseRow(beamFacts, supportFacts, {
    kind: '小梁（要件）',
    position: `${SIDE_LABELS[end.side] || end.side} ${overrides.requirementLabel}`,
    role: group.role,
    diaMm: group.diaMm,
    grade: group.grade,
    fc: end.supportContext?.fc ?? null,
    count: group.count,
    requiredMm: overrides.requiredMm,
    availableMm: overrides.availableMm ?? null,
    exact: Number.isFinite(overrides.requiredMm),
    ok: overrides.ok ?? null,
    partialCheck: overrides.partialCheck === true,
    requirementKind: overrides.requirementKind,
    supportGeometryResolved: end.supportGeometry?.resolved === true,
    effectiveEmbedmentMm: end.supportGeometry?.effectiveEmbedmentMm ?? null,
    unresolvedReason: overrides.unresolvedReason || null,
    note: `${overrides.note}${supportGeometryNote(end)}`,
    ...vertical90ProductionGateRowFields(group),
  });
}

function unresolvedRequirementRow(beamFacts, supportFacts, end, group) {
  const reason =
    group.requirement?.reason || end.supportContext?.reason || 'anchorage-requirement-unresolved';
  return baseRow(beamFacts, supportFacts, {
    kind: '小梁（要件）',
    position: `${SIDE_LABELS[end.side] || end.side} 要件未解決`,
    role: group.role,
    diaMm: group.diaMm,
    grade: group.grade,
    fc: end.supportContext?.fc ?? null,
    count: group.count,
    requirementKind: group.requirement?.kind || null,
    supportGeometryResolved: end.supportGeometry?.resolved === true,
    effectiveEmbedmentMm: end.supportGeometry?.effectiveEmbedmentMm ?? null,
    unresolvedReason: reason,
    note: `必要長さ要件を解決できないため未生成・未判定（${reason}）。` + supportGeometryNote(end),
    ...vertical90ProductionGateRowFields(group),
  });
}

function topRows(beamFacts, supportFacts, end, group) {
  const requirement = group.requirement || {};
  if (!requirement.ok) return [unresolvedRequirementRow(beamFacts, supportFacts, end, group)];

  const availability = group.projectionAvailability;
  const projectionResolved = availability?.resolved === true;
  const projectionNote = projectionAvailabilityNote(group);
  const tailAvailability = group.tailAvailability;
  const tailResolved = tailAvailability?.resolved === true;
  const tailNote = tailAvailabilityNote(group);
  const totalLengthAvailability = group.totalLengthAvailability;
  const totalLengthResolved = totalLengthAvailability?.resolved === true;
  const totalLengthNote = totalLengthAvailabilityNote(group);

  return [
    resolvedRequirementRow(beamFacts, supportFacts, end, group, {
      requirementKind: 'L2',
      requirementLabel: '上端筋 L2全長',
      requiredMm: requirement.l2RequiredMm,
      availableMm: totalLengthResolved ? totalLengthAvailability.availableMm : null,
      ok: totalLengthResolved ? totalLengthAvailability.ok : null,
      partialCheck: totalLengthResolved,
      unresolvedReason: totalLengthResolved ? null : totalLengthAvailability?.reason || null,
      note:
        `L2=${requirement.l2Factor ?? '-'}d の必要全長。` +
        totalLengthNote +
        ' ここでのOK/NGはL2全長だけの部分判定で、投影・余長・定着全体の判定ではない。',
    }),
    resolvedRequirementRow(beamFacts, supportFacts, end, group, {
      requirementKind: 'LB_PROJECTION',
      requirementLabel: '上端筋 Lb/B/2投影',
      requiredMm: requirement.projectionRequiredMm,
      availableMm: projectionResolved ? availability.availableMm : null,
      ok: projectionResolved ? availability.ok : null,
      partialCheck: projectionResolved,
      unresolvedReason: projectionResolved ? null : availability?.reason || null,
      note:
        `投影必要長さ=max(Lb=${Math.round(requirement.lbByTableMm ?? 0)}mm, ` +
        `B/2=${Math.round(requirement.minBySupportMm ?? 0)}mm)。` +
        projectionNote +
        ' ここでのOK/NGは投影長さだけの部分判定で、定着全体の判定ではない。',
    }),
    resolvedRequirementRow(beamFacts, supportFacts, end, group, {
      requirementKind: 'HOOK_TAIL_90',
      requirementLabel: '上端筋 90°余長',
      requiredMm: requirement.tailRequiredMm,
      availableMm: tailResolved ? tailAvailability.availableMm : null,
      ok: tailResolved ? tailAvailability.ok : null,
      partialCheck: tailResolved,
      unresolvedReason: tailResolved ? null : tailAvailability?.reason || null,
      note:
        `90°折曲げ余長=${requirement.tailFactor ?? '-'}d。` +
        tailNote +
        ' ここでのOK/NGは鉛直余長だけの部分判定で、L2全長・定着全体の判定ではない。',
    }),
  ];
}

function bottomRows(beamFacts, supportFacts, end, group) {
  const requirement = group.requirement || {};
  if (!requirement.ok || !Array.isArray(requirement.alternatives)) {
    return [unresolvedRequirementRow(beamFacts, supportFacts, end, group)];
  }

  return requirement.alternatives.map((alternative) =>
    resolvedRequirementRow(beamFacts, supportFacts, end, group, {
      requirementKind: alternative.lengthKind || alternative.kind || null,
      requirementLabel: `下端筋 ${alternative.lengthKind || alternative.kind || '定着'}`,
      requiredMm: alternative.requiredMm,
      note:
        `${alternative.lengthKind || alternative.kind || '定着'}=${alternative.factor ?? '-'}d。` +
        ' L3/L3hは現段階では選択せず代替案として併記。 確保長さ・定着modeは未判定。',
    }),
  );
}

function foundationRow(beamFacts, supportFacts) {
  return baseRow(beamFacts, supportFacts, {
    kind: '基礎小梁（R12対象外）',
    unresolvedReason: FOUNDATION_OUT_OF_SCOPE_REASON,
    note: '基礎小梁は日建連 §6-2 の対象。R12一般小梁（§9）のL2/Lb/L3/L3h要件を生成しない。',
  });
}

/**
 * R12 requirement factsを既存の定着チェック一覧へ表示する行に変換する。
 *
 * @param {{beam:Map<string,Object>, unresolved:Array<Object>}} requirementFacts
 * @param {{beam?:Map<string,Object>}} [supportFacts]
 * @returns {Array<Object>}
 */
export function buildSmallBeamAnchorageCheckRows(requirementFacts, supportFacts = null) {
  const rows = [];
  const represented = new Set();

  for (const [elementId, beamFacts] of requirementFacts?.beam || []) {
    represented.add(String(elementId));

    if (beamFacts.isFoundation || beamFacts.reason === FOUNDATION_OUT_OF_SCOPE_REASON) {
      rows.push(foundationRow(beamFacts, supportFacts));
      continue;
    }

    for (const end of beamFacts.ends || []) {
      if (end.status === 'FREE_END') continue;
      for (const group of end.requirements || []) {
        rows.push(
          ...(group.role === 'top'
            ? topRows(beamFacts, supportFacts, end, group)
            : bottomRows(beamFacts, supportFacts, end, group)),
        );
      }
    }
  }

  for (const unresolved of requirementFacts?.unresolved || []) {
    if (represented.has(String(unresolved.elementId))) continue;
    rows.push({
      category: CATEGORY,
      kind: '小梁（要件）',
      elementId: unresolved.elementId || null,
      elementName: unresolved.elementName || null,
      sectionName: null,
      position: unresolved.side
        ? `${SIDE_LABELS[unresolved.side] || unresolved.side} 要件未解決`
        : '-',
      role: unresolved.role || null,
      diaMm: unresolved.diaMm ?? null,
      grade: unresolved.grade || null,
      fc: null,
      count: 0,
      requiredMm: null,
      availableMm: null,
      exact: false,
      ok: null,
      generationStatus: 'UNRESOLVED',
      requirementOnly: true,
      partialCheck: false,
      unresolvedReason: unresolved.reason || 'anchorage-requirement-unresolved',
      note: `必要長さ要件を生成できないため未生成・未判定（${unresolved.reason || 'anchorage-requirement-unresolved'}）。`,
    });
  }

  return rows;
}
