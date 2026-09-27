/**
 * @fileoverview STB線材要素の派生数量calculator。
 * 対象: Column / Post / Girder / Beam / Brace / FoundationColumn
 */

import { createQuantityResult, createUnavailableQuantityResult } from '../core/QuantityResult.js';
import { QuantityStatus } from '../core/QuantityStatus.js';
import { calculateSectionArea } from '../core/SectionAreaCalculator.js';
import { resolveLinearMemberLength } from '../resolvers/LinearMemberLengthResolver.js';
import {
  calculateCompositeLinearSectionVolume,
  calculateSimpleLinearSectionVolume,
  combineQuantityStatuses,
  emptyLinearQuantityValues,
  normalizeStructureKind,
  uniqueWarnings,
} from './LinearSectionVolumeCalculator.js';

const CALCULATOR_VERSION = 1;
const COMPOSITE_TYPES = new Set(['SRC', 'CFT']);
const REGULAR_THICKNESS_ADD_KEYS = Object.freeze([
  'thickness_add_start_X',
  'thickness_add_end_X',
  'thickness_add_start_Y',
  'thickness_add_end_Y',
  'thickness_add_top',
  'thickness_add_bottom',
  'thickness_add_right',
  'thickness_add_left',
]);

function dependencyForSection(section) {
  return section?.id ? `${section.sectionType || 'StbSection'}:${section.id}` : null;
}

function steelDependencies(section, steelSections) {
  const names = [section?.shapeName];
  if (Array.isArray(section?.shapes)) {
    names.push(...section.shapes.map((shape) => shape?.shapeName));
  }
  return [
    ...new Set(
      names
        .filter((name) => name && steelSections?.has?.(name))
        .map((name) => `StbSecSteel:${name}`),
    ),
  ];
}

function resultBasis(method) {
  return {
    method,
    calculator: 'LinearMemberQuantityCalculator',
    calculatorVersion: CALCULATOR_VERSION,
    unitSystem: 'STB_MM',
  };
}

function inspectThicknessAdds(element, keys) {
  const nonZero = [];
  const invalid = [];
  for (const key of keys) {
    const raw = element?.[key];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      invalid.push(key);
    } else if (value !== 0) {
      nonZero.push(key);
    }
  }
  return { nonZero, invalid };
}

function normalizeSrcCutbackAliases(element) {
  const normalized = { ...element };
  const pairs = [
    ['steel_cutback_bottom', 'steel_cutback_start'],
    ['steel_cutback_top', 'steel_cutback_end'],
  ];

  for (const [primary, alias] of pairs) {
    const primaryRaw = element?.[primary];
    const aliasRaw = element?.[alias];
    const hasPrimary = primaryRaw !== null && primaryRaw !== undefined && primaryRaw !== '';
    const hasAlias = aliasRaw !== null && aliasRaw !== undefined && aliasRaw !== '';

    if (hasPrimary && hasAlias) {
      const primaryValue = Number(primaryRaw);
      const aliasValue = Number(aliasRaw);
      if (
        Number.isFinite(primaryValue) &&
        Number.isFinite(aliasValue) &&
        Math.abs(primaryValue - aliasValue) > 1e-9
      ) {
        return {
          error: `${primary} と ${alias} が矛盾しています`,
          element: normalized,
        };
      }
    } else if (!hasPrimary && hasAlias) {
      normalized[primary] = aliasRaw;
    }
  }

  return { element: normalized, error: null };
}

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function oneSidedSwitchDistance(startValue, endValue, totalLength) {
  const start = positiveFinite(startValue);
  const end = positiveFinite(endValue);
  if (start !== null && end === null && start < totalLength) return start;
  if (start === null && end !== null && end < totalLength) return totalLength - end;
  return null;
}

function normalizeTwoShapeSwitchElement(element, section, totalLength) {
  if (!Array.isArray(section?.shapes) || section.shapes.length !== 2) return element;
  if (Array.isArray(element?.quantitySteelSwitches) && element.quantitySteelSwitches.length > 0) {
    return element;
  }

  const bottom = positiveFinite(element?.steel_switch_height_bottom);
  if (bottom !== null && bottom < totalLength) return element;

  const top = positiveFinite(element?.steel_switch_height_top);
  if (top !== null && top < totalLength) {
    return { ...element, steel_switch_height_bottom: totalLength - top };
  }

  const haunchDistance = oneSidedSwitchDistance(
    element?.haunch_start,
    element?.haunch_end,
    totalLength,
  );
  if (haunchDistance !== null) {
    return { ...element, steel_switch_height_bottom: haunchDistance };
  }

  const jointDistance = oneSidedSwitchDistance(
    element?.joint_start,
    element?.joint_end,
    totalLength,
  );
  if (jointDistance !== null) {
    return { ...element, steel_switch_height_bottom: jointDistance };
  }

  return element;
}

function orderedSteelShapes(section) {
  const positionOrder = { BOTTOM: 0, START: 0, CENTER: 1, TOP: 2, END: 2 };
  return [...(section?.shapes || [])].sort(
    (a, b) =>
      (positionOrder[String(a?.pos || '').toUpperCase()] ?? 1) -
      (positionOrder[String(b?.pos || '').toUpperCase()] ?? 1),
  );
}

function resolveSteelShapeArea(shape, section, steelSections) {
  if (!shape) {
    return {
      status: QuantityStatus.INSUFFICIENT_DATA,
      areaMm2: null,
      warnings: ['S躯体切替位置に対応する断面形状がありません'],
    };
  }

  if (shape.dimensions) {
    const type =
      shape.dimensions.profile_hint || shape.section_type || section?.section_type || 'RECTANGLE';
    return calculateSectionArea(type, shape.dimensions);
  }

  const steel = shape.shapeName && steelSections?.get?.(shape.shapeName);
  if (!steel) {
    return {
      status: QuantityStatus.INSUFFICIENT_DATA,
      areaMm2: null,
      warnings: [`鉄骨断面を解決できません: ${shape.shapeName || '(missing)'}`],
    };
  }
  const type = steel.kind_struct || steel.dimensions?.profile_hint || section?.section_type;
  return calculateSectionArea(type, { ...(steel.dimensions || {}), ...steel });
}

function resolveStbSteelSwitchLengths(element, totalLength, shapeCount) {
  const switches = element?.quantitySteelSwitches;
  if (!Array.isArray(switches) || switches.length === 0) return null;
  if (!Number.isInteger(shapeCount) || shapeCount < 2) {
    return {
      status: QuantityStatus.INVALID_GEOMETRY,
      lengths: null,
      warnings: ['S躯体切替位置がありますが多断面形状を解決できません'],
    };
  }

  const byOrder = new Map();
  for (const item of switches) {
    const order = Number(item?.order);
    const distance = Number(item?.distance);
    if (!Number.isInteger(order) || order <= 0 || !Number.isFinite(distance)) {
      return {
        status: QuantityStatus.INVALID_GEOMETRY,
        lengths: null,
        warnings: ['Stb*SteelSwitch の order/distance は有限な正規値である必要があります'],
      };
    }
    if (order > shapeCount) {
      return {
        status: QuantityStatus.INVALID_GEOMETRY,
        lengths: null,
        warnings: [`Stb*SteelSwitch の order=${order} が断面数=${shapeCount} を超えています`],
      };
    }
    if (byOrder.has(order)) {
      return {
        status: QuantityStatus.INVALID_GEOMETRY,
        lengths: null,
        warnings: [`Stb*SteelSwitch の order=${order} が重複しています`],
      };
    }
    byOrder.set(order, distance);
  }

  const boundaries = [];
  for (let order = 1; order < shapeCount; order++) {
    if (!byOrder.has(order)) {
      return {
        status: QuantityStatus.INSUFFICIENT_DATA,
        lengths: null,
        warnings: [`Stb*SteelSwitch の order=${order} が不足しています`],
      };
    }
    boundaries.push(byOrder.get(order));
  }

  if (byOrder.has(shapeCount)) {
    const finalDistance = byOrder.get(shapeCount);
    if (Math.abs(finalDistance - totalLength) > 1e-6) {
      return {
        status: QuantityStatus.INVALID_GEOMETRY,
        lengths: null,
        warnings: [
          `Stb*SteelSwitch の最終 distance=${finalDistance} が部材長=${totalLength} と一致しません`,
        ],
      };
    }
  }

  let previous = 0;
  const lengths = [];
  for (const distance of boundaries) {
    if (!(distance > previous && distance < totalLength)) {
      return {
        status: QuantityStatus.INVALID_GEOMETRY,
        lengths: null,
        warnings: [
          'Stb*SteelSwitch の distance は始端から単調増加し部材長未満である必要があります',
        ],
      };
    }
    lengths.push(distance - previous);
    previous = distance;
  }
  const finalLength = totalLength - previous;
  if (!(finalLength > 0)) {
    return {
      status: QuantityStatus.INVALID_GEOMETRY,
      lengths: null,
      warnings: ['Stb*SteelSwitch 適用後の最終区間長が0以下です'],
    };
  }
  lengths.push(finalLength);

  return {
    status: QuantityStatus.CALCULATED,
    lengths,
    warnings: [],
  };
}

function calculateStbSteelSwitchVolume(section, element, steelSections, lengthMm) {
  const ordered = orderedSteelShapes(section);
  const switchResult = resolveStbSteelSwitchLengths(element, lengthMm, ordered.length);
  if (!switchResult) return null;
  if (!switchResult.lengths) {
    return {
      status: switchResult.status,
      volumeMm3: null,
      representativeAreaMm2: null,
      warnings: switchResult.warnings,
      method: null,
    };
  }

  let volumeMm3 = 0;
  let weightedArea = 0;
  const statuses = [];
  const warnings = [...switchResult.warnings];

  for (let index = 0; index < ordered.length; index++) {
    const area = resolveSteelShapeArea(ordered[index], section, steelSections);
    if (!Number.isFinite(area?.areaMm2)) {
      return {
        status: area?.status || QuantityStatus.INSUFFICIENT_DATA,
        volumeMm3: null,
        representativeAreaMm2: null,
        warnings: uniqueWarnings(warnings, area?.warnings),
        method: null,
      };
    }
    const segmentLength = switchResult.lengths[index];
    volumeMm3 += area.areaMm2 * segmentLength;
    weightedArea += area.areaMm2 * segmentLength;
    statuses.push(area.status);
    warnings.push(...(area.warnings || []));
  }

  return {
    status: combineQuantityStatuses(statuses, { allowUnavailableParts: true }),
    volumeMm3,
    representativeAreaMm2: weightedArea / lengthMm,
    warnings: uniqueWarnings(warnings),
    method: 'PIECEWISE_CONSTANT_STB_STEEL_SWITCH',
  };
}

export function calculateLinearMemberQuantity(context) {
  const {
    elementType,
    element,
    nodes,
    section,
    steelSections = new Map(),
    revision = null,
  } = context || {};
  const identity = {
    elementType,
    elementId: element?.id,
    guid: element?.guid || null,
  };

  if (!elementType || !element?.id) {
    throw new TypeError('elementType and element.id are required');
  }
  if (!section) {
    return createUnavailableQuantityResult({
      identity,
      status: QuantityStatus.INSUFFICIENT_DATA,
      values: emptyLinearQuantityValues(),
      basis: resultBasis(null),
      warnings: ['参照断面を解決できません'],
      revision,
    });
  }

  const length = resolveLinearMemberLength(elementType, element, nodes);
  const sectionDependency = dependencyForSection(section);
  const dependencies = [
    ...(length.dependencies || []),
    ...(sectionDependency ? [sectionDependency] : []),
    ...steelDependencies(section, steelSections),
  ];
  if (!Number.isFinite(length.lengthMm)) {
    return createUnavailableQuantityResult({
      identity,
      status: length.status,
      values: emptyLinearQuantityValues(),
      basis: resultBasis(null),
      dependencies,
      warnings: length.warnings,
      revision,
    });
  }

  const structureKind = normalizeStructureKind(element, section);
  if (!['RC', 'S', 'SRC', 'CFT'].includes(structureKind)) {
    return createUnavailableQuantityResult({
      identity,
      status: QuantityStatus.UNSUPPORTED,
      values: emptyLinearQuantityValues({ lengthMm: length.lengthMm }),
      basis: resultBasis(null),
      dependencies,
      warnings: [`未対応の構造種別です: ${structureKind || '(unknown)'}`],
      revision,
    });
  }

  if (structureKind === 'RC' || structureKind === 'SRC') {
    const thicknessAdds = inspectThicknessAdds(element, REGULAR_THICKNESS_ADD_KEYS);
    if (thicknessAdds.invalid.length > 0) {
      return createUnavailableQuantityResult({
        identity,
        status: QuantityStatus.INVALID_GEOMETRY,
        values: emptyLinearQuantityValues({ lengthMm: length.lengthMm }),
        basis: resultBasis(null),
        dependencies,
        warnings: [
          `ふかし厚さは0以上の有限値である必要があります: ${thicknessAdds.invalid.join(', ')}`,
        ],
        revision,
      });
    }
    if (thicknessAdds.nonZero.length > 0) {
      return createUnavailableQuantityResult({
        identity,
        status: QuantityStatus.UNSUPPORTED,
        values: emptyLinearQuantityValues({ lengthMm: length.lengthMm }),
        basis: resultBasis(null),
        dependencies,
        warnings: [
          `Q1では柱・梁のふかし厚さを体積へ反映できません: ${thicknessAdds.nonZero.join(', ')}`,
        ],
        revision,
      });
    }
  }

  if (structureKind === 'S') {
    const explicitSwitch = calculateStbSteelSwitchVolume(
      section,
      element,
      steelSections,
      length.lengthMm,
    );
    if (explicitSwitch) {
      if (!Number.isFinite(explicitSwitch.volumeMm3)) {
        return createUnavailableQuantityResult({
          identity,
          status: explicitSwitch.status,
          values: emptyLinearQuantityValues({ lengthMm: length.lengthMm }),
          basis: resultBasis(explicitSwitch.method),
          dependencies,
          warnings: uniqueWarnings(length.warnings, explicitSwitch.warnings),
          revision,
        });
      }
      return createQuantityResult({
        identity,
        status: explicitSwitch.status,
        values: emptyLinearQuantityValues({
          lengthMm: length.lengthMm,
          sectionAreaMm2: explicitSwitch.representativeAreaMm2,
          grossVolumeMm3: explicitSwitch.volumeMm3,
          netVolumeMm3: explicitSwitch.volumeMm3,
          structuralSteelVolumeMm3: explicitSwitch.volumeMm3,
          structuralSteelAreaMm2: explicitSwitch.representativeAreaMm2,
          structuralSteelLengthMm: length.lengthMm,
        }),
        basis: resultBasis(explicitSwitch.method),
        dependencies,
        warnings: uniqueWarnings(length.warnings, explicitSwitch.warnings),
        revision,
      });
    }
  }

  if (COMPOSITE_TYPES.has(structureKind)) {
    const normalizedCutback =
      structureKind === 'SRC' ? normalizeSrcCutbackAliases(element) : { element, error: null };
    if (normalizedCutback.error) {
      return createUnavailableQuantityResult({
        identity,
        status: QuantityStatus.INVALID_GEOMETRY,
        values: emptyLinearQuantityValues({ lengthMm: length.lengthMm }),
        basis: resultBasis(null),
        dependencies,
        warnings: [normalizedCutback.error],
        revision,
      });
    }
    const composite = calculateCompositeLinearSectionVolume(
      section,
      normalizedCutback.element,
      steelSections,
      length.lengthMm,
      structureKind,
    );
    return createQuantityResult({
      identity,
      status: composite.status,
      values: composite.values,
      basis: resultBasis(composite.method),
      dependencies,
      warnings: uniqueWarnings(length.warnings, composite.warnings),
      revision,
    });
  }

  const normalizedElement =
    structureKind === 'S'
      ? normalizeTwoShapeSwitchElement(element, section, length.lengthMm)
      : element;
  const simple = calculateSimpleLinearSectionVolume(
    section,
    normalizedElement,
    steelSections,
    length.lengthMm,
    structureKind,
  );
  if (!Number.isFinite(simple.volumeMm3)) {
    return createUnavailableQuantityResult({
      identity,
      status: simple.status,
      values: emptyLinearQuantityValues({ lengthMm: length.lengthMm }),
      basis: resultBasis(simple.method),
      dependencies,
      warnings: uniqueWarnings(length.warnings, simple.warnings),
      revision,
    });
  }

  const values = {
    lengthMm: length.lengthMm,
    sectionAreaMm2: simple.representativeAreaMm2,
    grossVolumeMm3: simple.volumeMm3,
    netVolumeMm3: simple.volumeMm3,
  };
  if (structureKind === 'RC') {
    values.concreteVolumeMm3 = simple.volumeMm3;
    values.concreteAreaMm2 = simple.representativeAreaMm2;
  } else {
    values.structuralSteelVolumeMm3 = simple.volumeMm3;
    values.structuralSteelAreaMm2 = simple.representativeAreaMm2;
    values.structuralSteelLengthMm = length.lengthMm;
  }

  return createQuantityResult({
    identity,
    status: simple.status,
    values: emptyLinearQuantityValues(values),
    basis: resultBasis(simple.method),
    dependencies,
    warnings: uniqueWarnings(length.warnings, simple.warnings),
    revision,
  });
}

function nonZeroFoundationThicknessAddKeys(element) {
  return [
    'thickness_add_FD_start_X',
    'thickness_add_FD_end_X',
    'thickness_add_FD_start_Y',
    'thickness_add_FD_end_Y',
    'thickness_add_WR_start_X',
    'thickness_add_WR_end_X',
    'thickness_add_WR_start_Y',
    'thickness_add_WR_end_Y',
  ].filter((key) => {
    const value = Number(element?.[key] || 0);
    return Number.isFinite(value) && value !== 0;
  });
}

export function calculateFoundationColumnQuantity(context) {
  const {
    elementType = 'StbFoundationColumn',
    element,
    sectionFD,
    sectionWR,
    steelSections = new Map(),
    revision = null,
  } = context || {};
  const identity = { elementType, elementId: element?.id, guid: element?.guid || null };
  if (!element?.id) throw new TypeError('element.id is required');

  const unsupportedThicknessAdds = nonZeroFoundationThicknessAddKeys(element);
  if (unsupportedThicknessAdds.length > 0) {
    return createUnavailableQuantityResult({
      identity,
      status: QuantityStatus.UNSUPPORTED,
      values: emptyLinearQuantityValues({
        lengthMm: Number(element.length_FD || 0) + Number(element.length_WR || 0),
      }),
      basis: resultBasis(null),
      dependencies: [dependencyForSection(sectionFD), dependencyForSection(sectionWR)].filter(
        Boolean,
      ),
      warnings: [
        `Q1ではFoundationColumnの断面付加厚を体積へ反映できません: ${unsupportedThicknessAdds.join(', ')}`,
      ],
      revision,
    });
  }

  const lengthFD = Number(element.length_FD);
  const lengthWR = Number(element.length_WR || 0);
  if (!Number.isFinite(lengthFD) || lengthFD <= 0 || !Number.isFinite(lengthWR) || lengthWR < 0) {
    return createUnavailableQuantityResult({
      identity,
      status: QuantityStatus.INVALID_GEOMETRY,
      values: emptyLinearQuantityValues(),
      basis: resultBasis(null),
      warnings: ['FoundationColumn の length_FD/length_WR が不正です'],
      revision,
    });
  }

  const parts = [];
  if (sectionFD) parts.push({ label: 'FD', section: sectionFD, lengthMm: lengthFD });
  if (lengthWR > 0 && sectionWR) {
    parts.push({ label: 'WR', section: sectionWR, lengthMm: lengthWR });
  }
  if (parts.length === 0 || (lengthWR > 0 && !sectionWR)) {
    return createUnavailableQuantityResult({
      identity,
      status: QuantityStatus.INSUFFICIENT_DATA,
      values: emptyLinearQuantityValues({ lengthMm: lengthFD + lengthWR }),
      basis: resultBasis(null),
      dependencies: [dependencyForSection(sectionFD), dependencyForSection(sectionWR)].filter(
        Boolean,
      ),
      warnings: ['FoundationColumn の参照断面を解決できません'],
      revision,
    });
  }

  let grossVolumeMm3 = 0;
  let concreteVolumeMm3 = 0;
  let structuralSteelVolumeMm3 = 0;
  let weightedArea = 0;
  const statuses = [];
  const warnings = [];
  const dependencies = [];

  for (const part of parts) {
    const structureKind = normalizeStructureKind(element, part.section) || 'RC';
    const calculation = COMPOSITE_TYPES.has(structureKind)
      ? calculateCompositeLinearSectionVolume(
          part.section,
          element,
          steelSections,
          part.lengthMm,
          structureKind,
        )
      : calculateSimpleLinearSectionVolume(
          part.section,
          element,
          steelSections,
          part.lengthMm,
          structureKind,
        );

    const compositeValues = calculation.values || null;
    const volumeMm3 = compositeValues?.grossVolumeMm3 ?? calculation.volumeMm3;
    if (!Number.isFinite(volumeMm3)) {
      return createUnavailableQuantityResult({
        identity,
        status: calculation.status || QuantityStatus.INSUFFICIENT_DATA,
        values: emptyLinearQuantityValues({ lengthMm: lengthFD + lengthWR }),
        basis: resultBasis(null),
        dependencies: [dependencyForSection(sectionFD), dependencyForSection(sectionWR)].filter(
          Boolean,
        ),
        warnings: uniqueWarnings(warnings, calculation.warnings, [
          `${part.label}部分の体積を確定できません`,
        ]),
        revision,
      });
    }

    grossVolumeMm3 += volumeMm3;
    concreteVolumeMm3 +=
      Number(compositeValues?.concreteVolumeMm3 ?? (structureKind === 'RC' ? volumeMm3 : 0)) || 0;
    structuralSteelVolumeMm3 +=
      Number(
        compositeValues?.structuralSteelVolumeMm3 ?? (structureKind === 'S' ? volumeMm3 : 0),
      ) || 0;
    const areaMm2 = compositeValues?.sectionAreaMm2 ?? calculation.representativeAreaMm2;
    if (Number.isFinite(areaMm2)) weightedArea += areaMm2 * part.lengthMm;
    statuses.push(calculation.status);
    warnings.push(...(calculation.warnings || []));
    const dependency = dependencyForSection(part.section);
    if (dependency) dependencies.push(dependency);
  }

  const totalLengthMm = lengthFD + lengthWR;
  return createQuantityResult({
    identity,
    status: combineQuantityStatuses(statuses, { allowUnavailableParts: true }),
    values: emptyLinearQuantityValues({
      lengthMm: totalLengthMm,
      sectionAreaMm2: totalLengthMm > 0 ? weightedArea / totalLengthMm : null,
      grossVolumeMm3,
      netVolumeMm3: grossVolumeMm3,
      concreteVolumeMm3: concreteVolumeMm3 || null,
      structuralSteelVolumeMm3: structuralSteelVolumeMm3 || null,
      grossEnvelopeVolumeMm3: grossVolumeMm3,
    }),
    basis: resultBasis('FOUNDATION_COLUMN_PART_SUM'),
    dependencies: [...new Set(dependencies)],
    warnings: uniqueWarnings(warnings),
    revision,
  });
}

export { CALCULATOR_VERSION as LINEAR_MEMBER_QUANTITY_CALCULATOR_VERSION };
