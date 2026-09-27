/**
 * @fileoverview 線材の断面積・体積を構造種別ごとに算出する内部 calculator。
 */

import { calculateSectionArea } from '../core/SectionAreaCalculator.js';
import { calculatePrismaticVolume, calculatePrismoidalVolume } from '../core/VolumeIntegrator.js';
import { QuantityStatus } from '../core/QuantityStatus.js';

export function uniqueWarnings(...groups) {
  return [...new Set(groups.flat().filter(Boolean).map(String))];
}

export function emptyLinearQuantityValues(extra = {}) {
  return {
    lengthMm: null,
    sectionAreaMm2: null,
    grossVolumeMm3: null,
    netVolumeMm3: null,
    concreteVolumeMm3: null,
    structuralSteelVolumeMm3: null,
    grossEnvelopeVolumeMm3: null,
    structuralSteelAreaMm2: null,
    structuralSteelLengthMm: null,
    concreteAreaMm2: null,
    ...extra,
  };
}

function statusRank(status) {
  const rank = {
    [QuantityStatus.CALCULATED]: 0,
    [QuantityStatus.PARTIAL]: 1,
    [QuantityStatus.INSUFFICIENT_DATA]: 2,
    [QuantityStatus.UNSUPPORTED]: 3,
    [QuantityStatus.INVALID_GEOMETRY]: 4,
  };
  return rank[status] ?? 5;
}

export function combineQuantityStatuses(statuses, { allowUnavailableParts = false } = {}) {
  const filtered = statuses.filter(Boolean);
  if (filtered.length === 0) return QuantityStatus.INSUFFICIENT_DATA;
  if (filtered.every((status) => status === QuantityStatus.CALCULATED)) {
    return QuantityStatus.CALCULATED;
  }
  if (
    allowUnavailableParts &&
    filtered.some(
      (status) => status === QuantityStatus.CALCULATED || status === QuantityStatus.PARTIAL,
    )
  ) {
    return QuantityStatus.PARTIAL;
  }
  return filtered.reduce((worst, status) =>
    statusRank(status) > statusRank(worst) ? status : worst,
  );
}

export function normalizeStructureKind(element, section) {
  const explicit = String(element?.kind_structure || '')
    .trim()
    .toUpperCase();
  if (explicit) return explicit;

  const tag = String(section?.sectionType || '').toUpperCase();
  if (tag.includes('_SRC')) return 'SRC';
  if (tag.includes('_CFT')) return 'CFT';
  if (tag.includes('_RC')) return 'RC';
  if (tag.endsWith('_S') || tag.includes('SECBEAM_S') || tag.includes('SECCOLUMN_S')) return 'S';
  return '';
}

function mergeSteelParams(section, steelSections) {
  const referenced = section?.shapeName && steelSections?.get?.(section.shapeName);
  return {
    ...(section?.dimensions || {}),
    ...(section?.steelShape || {}),
    ...(referenced?.dimensions || {}),
    ...(referenced || {}),
  };
}

function resolveSteelArea(section, steelSections, explicitProfile = null) {
  const profile = explicitProfile || section?.steelProfile || null;
  if (profile?.section_type) {
    return calculateSectionArea(profile.section_type, {
      ...mergeSteelParams(section, steelSections),
      ...(profile.dimensions || {}),
    });
  }

  const referenced = section?.shapeName && steelSections?.get?.(section.shapeName);
  const type =
    section?.section_type ||
    referenced?.kind_struct ||
    referenced?.dimensions?.profile_hint ||
    section?.dimensions?.profile_hint;
  return calculateSectionArea(type, mergeSteelParams(section, steelSections));
}

function resolveConcreteArea(section) {
  const concrete = section?.concreteProfile;
  if (concrete) {
    return calculateSectionArea(
      concrete.profileType || section.section_type || 'RECTANGLE',
      concrete,
    );
  }
  return calculateSectionArea(
    section?.section_type || section?.dimensions?.profile_hint,
    section?.dimensions || {},
  );
}

function resolveCftEnvelopeArea(section) {
  const steelType = String(
    section?.steelProfile?.section_type ||
      section?.section_type ||
      section?.dimensions?.profile_hint ||
      '',
  ).toUpperCase();
  const dims = {
    ...(section?.steelProfile?.dimensions || {}),
    ...(section?.dimensions || {}),
    ...(section?.steelShape || {}),
  };

  if (steelType === 'PIPE') {
    const diameter = Number(dims.D ?? dims.diameter ?? dims.outerDiameter ?? dims.outer_diameter);
    return Number.isFinite(diameter) && diameter > 0 ? (Math.PI * diameter ** 2) / 4 : null;
  }

  if (steelType === 'BOX') {
    const depth = Number(dims.A ?? dims.height ?? dims.outer_height ?? dims.overallDepth);
    const width = Number(dims.B ?? dims.width ?? dims.outer_width ?? dims.overallWidth);
    return [depth, width].every((value) => Number.isFinite(value) && value > 0)
      ? depth * width
      : null;
  }

  return null;
}

function interpolateNumericDimensions(start, end, ratio) {
  const result = {};
  const keys = new Set([...Object.keys(start || {}), ...Object.keys(end || {})]);
  for (const key of keys) {
    const startNumber = Number(start?.[key]);
    const endNumber = Number(end?.[key]);
    if (Number.isFinite(startNumber) && Number.isFinite(endNumber)) {
      result[key] = startNumber + (endNumber - startNumber) * ratio;
    } else if (start?.[key] !== undefined && start?.[key] === end?.[key]) {
      result[key] = start[key];
    }
  }
  return result;
}

function resolveSteelShapeArea(shape, section, steelSections) {
  if (!shape) return null;
  if (shape.dimensions) {
    const type =
      shape.dimensions.profile_hint || shape.section_type || section?.section_type || 'RECTANGLE';
    return calculateSectionArea(type, shape.dimensions);
  }
  const steel = shape.shapeName && steelSections?.get?.(shape.shapeName);
  if (!steel) return null;
  const type = steel.kind_struct || steel.dimensions?.profile_hint || section?.section_type;
  return calculateSectionArea(type, { ...(steel.dimensions || {}), ...steel });
}

function calculateTaperedAreaVolume(section, steelSections, lengthMm) {
  const shapes = section?.shapes;
  if (!Array.isArray(shapes) || shapes.length !== 2) return null;

  const start =
    shapes.find((shape) => String(shape.pos || '').toUpperCase() === 'START') || shapes[0];
  const end = shapes.find((shape) => String(shape.pos || '').toUpperCase() === 'END') || shapes[1];

  if (start.dimensions && end.dimensions) {
    const type = section.section_type || 'RECTANGLE';
    const startArea = calculateSectionArea(type, start.dimensions);
    const midArea = calculateSectionArea(
      type,
      interpolateNumericDimensions(start.dimensions, end.dimensions, 0.5),
    );
    const endArea = calculateSectionArea(type, end.dimensions);
    if (![startArea.areaMm2, midArea.areaMm2, endArea.areaMm2].every(Number.isFinite)) {
      return null;
    }
    return {
      status: combineQuantityStatuses([startArea.status, midArea.status, endArea.status], {
        allowUnavailableParts: true,
      }),
      volumeMm3: calculatePrismoidalVolume(
        startArea.areaMm2,
        midArea.areaMm2,
        endArea.areaMm2,
        lengthMm,
      ),
      representativeAreaMm2: midArea.areaMm2,
      warnings: uniqueWarnings(startArea.warnings, midArea.warnings, endArea.warnings),
      method: 'PRISMOIDAL_LINEAR_DIMENSION_TAPER',
    };
  }

  const startSteel = start.shapeName && steelSections?.get?.(start.shapeName);
  const endSteel = end.shapeName && steelSections?.get?.(end.shapeName);
  if (!startSteel || !endSteel) return null;

  const startType = startSteel.kind_struct || startSteel.dimensions?.profile_hint;
  const endType = endSteel.kind_struct || endSteel.dimensions?.profile_hint;
  if (!startType || startType !== endType) return null;

  const startParams = { ...(startSteel.dimensions || {}), ...startSteel };
  const endParams = { ...(endSteel.dimensions || {}), ...endSteel };
  const startArea = calculateSectionArea(startType, startParams);
  const midArea = calculateSectionArea(
    startType,
    interpolateNumericDimensions(startParams, endParams, 0.5),
  );
  const endArea = calculateSectionArea(endType, endParams);
  if (![startArea.areaMm2, midArea.areaMm2, endArea.areaMm2].every(Number.isFinite)) {
    return null;
  }

  return {
    status: combineQuantityStatuses([startArea.status, midArea.status, endArea.status], {
      allowUnavailableParts: true,
    }),
    volumeMm3: calculatePrismoidalVolume(
      startArea.areaMm2,
      midArea.areaMm2,
      endArea.areaMm2,
      lengthMm,
    ),
    representativeAreaMm2: midArea.areaMm2,
    warnings: uniqueWarnings(startArea.warnings, midArea.warnings, endArea.warnings),
    method: 'PRISMOIDAL_STEEL_TAPER',
  };
}

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function explicitPair(first, second, totalLength) {
  const firstLength = positiveFinite(first);
  const secondLength = positiveFinite(second);
  if (firstLength === null || secondLength === null || firstLength + secondLength >= totalLength) {
    return null;
  }
  return [firstLength, totalLength - firstLength - secondLength, secondLength];
}

function getExplicitSwitchLengths(element, totalLength, shapes) {
  if (!Array.isArray(shapes) || shapes.length < 2) return null;

  if (shapes.length === 2) {
    const bottom = positiveFinite(element?.steel_switch_height_bottom);
    if (bottom === null || bottom >= totalLength) return null;
    return [bottom, totalLength - bottom];
  }

  if (shapes.length === 3) {
    return (
      explicitPair(
        element?.steel_switch_height_bottom,
        element?.steel_switch_height_top,
        totalLength,
      ) ||
      explicitPair(element?.haunch_start, element?.haunch_end, totalLength) ||
      explicitPair(element?.joint_start, element?.joint_end, totalLength)
    );
  }

  return null;
}

function calculatePiecewiseSteelVolume(section, element, steelSections, lengthMm) {
  const shapes = section?.shapes;
  if (!Array.isArray(shapes) || shapes.length < 2) return null;
  const lengths = getExplicitSwitchLengths(element, lengthMm, shapes);
  if (!lengths) return null;

  const positionOrder = { BOTTOM: 0, START: 0, CENTER: 1, TOP: 2, END: 2 };
  const ordered = [...shapes].sort(
    (a, b) =>
      (positionOrder[String(a.pos || '').toUpperCase()] ?? 1) -
      (positionOrder[String(b.pos || '').toUpperCase()] ?? 1),
  );

  let volumeMm3 = 0;
  let weightedArea = 0;
  const statuses = [];
  const warnings = [];

  for (let index = 0; index < ordered.length; index++) {
    const area = resolveSteelShapeArea(ordered[index], section, steelSections);
    if (!area || !Number.isFinite(area.areaMm2)) return null;
    volumeMm3 += calculatePrismaticVolume(area.areaMm2, lengths[index]);
    weightedArea += area.areaMm2 * lengths[index];
    statuses.push(area.status);
    warnings.push(...(area.warnings || []));
  }

  return {
    status: combineQuantityStatuses(statuses, { allowUnavailableParts: true }),
    volumeMm3,
    representativeAreaMm2: weightedArea / lengthMm,
    warnings: uniqueWarnings(warnings),
    method: 'PIECEWISE_CONSTANT_EXPLICIT_SWITCH',
  };
}

function hasNonUniformShapeStations(section) {
  const stations = section?.shapeStations;
  if (!Array.isArray(stations) || stations.length < 2) return false;

  const signatures = stations.map((station) => {
    const type = station?.section_type || section?.section_type || '';
    const dimensions = station?.dimensions || {};
    const numericEntries = Object.entries(dimensions)
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([key, value]) => [key, Number(value)])
      .sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify([type, numericEntries]);
  });
  return new Set(signatures).size > 1;
}

function isExplicitTaperSection(section) {
  if (
    String(section?.multiSectionType || '')
      .toUpperCase()
      .includes('TAPER')
  )
    return true;
  return Array.isArray(section?.shapes) && section.shapes.some((shape) => shape?.variant?.isTaper);
}

export function calculateSimpleLinearSectionVolume(
  section,
  element,
  steelSections,
  lengthMm,
  structureKind,
) {
  if (section?.mode === 'double' && section?.multiSectionType === 'ConcreteTaper') {
    const taper = calculateTaperedAreaVolume(section, steelSections, lengthMm);
    if (taper) return taper;
  }

  if (structureKind === 'RC' && hasNonUniformShapeStations(section)) {
    return {
      status: QuantityStatus.UNSUPPORTED,
      volumeMm3: null,
      representativeAreaMm2: null,
      warnings: ['Q1ではRCハンチ等の非一様shapeStations体積は未対応です'],
      method: null,
    };
  }

  if ((section?.mode === 'double' || section?.mode === 'multi') && structureKind === 'S') {
    const piecewise = calculatePiecewiseSteelVolume(section, element, steelSections, lengthMm);
    if (piecewise) return piecewise;

    if (section.mode === 'double' && isExplicitTaperSection(section)) {
      const taper = calculateTaperedAreaVolume(section, steelSections, lengthMm);
      if (taper) return taper;
    }

    return {
      status: QuantityStatus.INSUFFICIENT_DATA,
      volumeMm3: null,
      representativeAreaMm2: null,
      warnings: ['多断面の切替位置が明示されていないため体積を確定できません'],
      method: null,
    };
  }

  const area =
    structureKind === 'S' ? resolveSteelArea(section, steelSections) : resolveConcreteArea(section);
  if (!Number.isFinite(area?.areaMm2)) {
    return {
      status: area?.status || QuantityStatus.INSUFFICIENT_DATA,
      volumeMm3: null,
      representativeAreaMm2: null,
      warnings: area?.warnings || ['断面積を算出できません'],
      method: null,
    };
  }

  return {
    status: area.status,
    volumeMm3: calculatePrismaticVolume(area.areaMm2, lengthMm),
    representativeAreaMm2: area.areaMm2,
    warnings: area.warnings || [],
    method: 'PRISMATIC_PROFILE_EXTRUSION',
  };
}

function resolveSrcSteelLength(element, memberLengthMm) {
  const readCutback = (name) => {
    const raw = element?.[name];
    if (raw === null || raw === undefined || raw === '') return { value: 0 };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      return { error: `${name} は0以上の有限値である必要があります` };
    }
    return { value };
  };

  const bottom = readCutback('steel_cutback_bottom');
  if (bottom.error) return bottom;
  const top = readCutback('steel_cutback_top');
  if (top.error) return top;

  const lengthMm = memberLengthMm - bottom.value - top.value;
  if (!Number.isFinite(lengthMm) || lengthMm <= 0) {
    return { error: 'SRC内部鉄骨のカットバック後有効長が0以下です' };
  }
  return {
    lengthMm,
    hasCutback: bottom.value > 0 || top.value > 0,
  };
}

export function calculateCompositeLinearSectionVolume(
  section,
  element,
  steelSections,
  lengthMm,
  structureKind,
) {
  if (section?.mode && section.mode !== 'single') {
    return {
      status: QuantityStatus.UNSUPPORTED,
      values: emptyLinearQuantityValues({ lengthMm }),
      warnings: [`Q1では${structureKind}の多断面複合部材は未対応です`],
      method: null,
    };
  }

  if (hasNonUniformShapeStations(section)) {
    return {
      status: QuantityStatus.UNSUPPORTED,
      values: emptyLinearQuantityValues({ lengthMm }),
      warnings: [`Q1では${structureKind}の非一様shapeStations体積は未対応です`],
      method: null,
    };
  }

  if (structureKind === 'SRC') {
    const concrete = resolveConcreteArea(section);
    const steel = resolveSteelArea(section, steelSections, section?.steelProfile);
    if (!Number.isFinite(concrete?.areaMm2)) {
      return {
        status: concrete?.status || QuantityStatus.INSUFFICIENT_DATA,
        values: emptyLinearQuantityValues({ lengthMm }),
        warnings: uniqueWarnings(concrete?.warnings, steel?.warnings),
        method: null,
      };
    }

    const steelLength = resolveSrcSteelLength(element, lengthMm);
    if (steelLength.error) {
      return {
        status: QuantityStatus.INVALID_GEOMETRY,
        values: emptyLinearQuantityValues({ lengthMm }),
        warnings: uniqueWarnings(concrete?.warnings, steel?.warnings, [steelLength.error]),
        method: null,
      };
    }

    const grossVolumeMm3 = calculatePrismaticVolume(concrete.areaMm2, lengthMm);
    const structuralSteelVolumeMm3 = Number.isFinite(steel?.areaMm2)
      ? calculatePrismaticVolume(steel.areaMm2, steelLength.lengthMm)
      : null;
    const status = Number.isFinite(structuralSteelVolumeMm3)
      ? combineQuantityStatuses([concrete.status, steel.status], { allowUnavailableParts: true })
      : QuantityStatus.PARTIAL;

    return {
      status,
      values: emptyLinearQuantityValues({
        lengthMm,
        sectionAreaMm2: concrete.areaMm2,
        grossVolumeMm3,
        netVolumeMm3: grossVolumeMm3,
        concreteVolumeMm3: grossVolumeMm3,
        structuralSteelVolumeMm3,
        grossEnvelopeVolumeMm3: grossVolumeMm3,
        structuralSteelAreaMm2: Number.isFinite(steel?.areaMm2) ? steel.areaMm2 : null,
        structuralSteelLengthMm: Number.isFinite(structuralSteelVolumeMm3)
          ? steelLength.lengthMm
          : null,
        concreteAreaMm2: concrete.areaMm2,
      }),
      warnings: uniqueWarnings(
        concrete.warnings,
        steel?.warnings,
        structuralSteelVolumeMm3 === null ? ['SRC内部鉄骨の断面積を確定できません'] : [],
      ),
      method: steelLength.hasCutback
        ? 'SRC_ENVELOPE_AND_INTERNAL_STEEL_WITH_CUTBACK'
        : 'SRC_ENVELOPE_AND_INTERNAL_STEEL',
    };
  }

  const steel = resolveSteelArea(section, steelSections, section?.steelProfile);
  if (!Number.isFinite(steel?.areaMm2)) {
    return {
      status: steel?.status || QuantityStatus.INSUFFICIENT_DATA,
      values: emptyLinearQuantityValues({ lengthMm }),
      warnings: steel?.warnings || ['CFT鋼管の断面積を算出できません'],
      method: null,
    };
  }

  const envelopeAreaMm2 = resolveCftEnvelopeArea(section);
  if (!Number.isFinite(envelopeAreaMm2) || envelopeAreaMm2 <= steel.areaMm2) {
    return {
      status: QuantityStatus.INSUFFICIENT_DATA,
      values: emptyLinearQuantityValues({
        lengthMm,
        structuralSteelAreaMm2: steel.areaMm2,
      }),
      warnings: uniqueWarnings(steel.warnings, ['CFT外形面積または充填部面積を確定できません']),
      method: null,
    };
  }

  const structuralSteelVolumeMm3 = calculatePrismaticVolume(steel.areaMm2, lengthMm);
  const grossVolumeMm3 = calculatePrismaticVolume(envelopeAreaMm2, lengthMm);
  const concreteAreaMm2 = envelopeAreaMm2 - steel.areaMm2;
  const concreteVolumeMm3 = calculatePrismaticVolume(concreteAreaMm2, lengthMm);

  return {
    status: steel.status,
    values: emptyLinearQuantityValues({
      lengthMm,
      sectionAreaMm2: envelopeAreaMm2,
      grossVolumeMm3,
      netVolumeMm3: grossVolumeMm3,
      concreteVolumeMm3,
      structuralSteelVolumeMm3,
      grossEnvelopeVolumeMm3: grossVolumeMm3,
      structuralSteelAreaMm2: steel.areaMm2,
      structuralSteelLengthMm: lengthMm,
      concreteAreaMm2,
    }),
    warnings: steel.warnings || [],
    method: 'CFT_TUBE_AND_FILL',
  };
}
