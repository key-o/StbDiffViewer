/**
 * @fileoverview Issue #325 / #320 Phase 6b-O2:
 * ST-Bridgeの開口・周辺配筋factsを小開口deflection classifier入力へ正規化する。
 *
 * production RebarPathは変更せず、取得不能/曖昧な情報はfail-closedでnull/UNRESOLVEDに残す。
 */

import { collectWallRebarFacts } from './wallRebarSectionFacts.js';
import { classifySmallOpeningRebarDeflectionCandidate } from './smallOpeningRebarDeflectionCandidate.js';
import { getRebarProjectDetailing } from '../../../config/rebarProjectDetailing.js';
import { createSmallOpeningRebarDeflectionAssignmentResolver } from '../../../config/smallOpeningRebarDeflectionProjectDetailing.js';

function numberAttr(element, name) {
  if (!element?.hasAttribute?.(name)) return null;
  const raw = element.getAttribute(name);
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function positiveUnique(values) {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const unique = [...new Set(numbers)];
  return unique.length === 1 ? unique[0] : null;
}

function unresolvedSpacings(labels) {
  return { firstMm: null, secondMm: null, labels };
}

function wallSpacings(section) {
  if (!section || section.specialCode) {
    return unresolvedSpacings(['VERTICAL', 'HORIZONTAL']);
  }
  const bars = section.bars || [];
  return {
    firstMm: positiveUnique(
      bars.filter((bar) => String(bar.pos || '').startsWith('VERTICAL')).map((bar) => bar.pitchMm),
    ),
    secondMm: positiveUnique(
      bars
        .filter((bar) => String(bar.pos || '').startsWith('HORIZONTAL'))
        .map((bar) => bar.pitchMm),
    ),
    labels: ['VERTICAL', 'HORIZONTAL'],
  };
}

const SLAB_BAR_PATTERNS = Object.freeze([
  {
    tags: ['StbSecBarSlab_RC_ConventionalStandard', 'StbSecBarSlab_RC_Standard'],
    allowedPositionSets: [
      [
        'SHORT_TOP_COLUMN',
        'SHORT_TOP_MID_END',
        'SHORT_TOP_MID_CENTER',
        'SHORT_BOTTOM_COLUMN',
        'SHORT_BOTTOM_MID_END',
        'SHORT_BOTTOM_MID_CENTER',
        'LONG_TOP_COLUMN',
        'LONG_TOP_MID_END',
        'LONG_TOP_MID_CENTER',
        'LONG_BOTTOM_COLUMN',
        'LONG_BOTTOM_MID_END',
        'LONG_BOTTOM_MID_CENTER',
      ],
    ],
  },
  {
    tags: ['StbSecBarSlab_RC_Conventional2Way'],
    expectedCount: 4,
    positionPattern: /^(SHORT|LONG)_(TOP|BOTTOM)_(END|CENTER)$/,
    requiredPositionGroups: [
      /^SHORT_(TOP|BOTTOM)_END$/,
      /^SHORT_(TOP|BOTTOM)_CENTER$/,
      /^LONG_(TOP|BOTTOM)_END$/,
      /^LONG_(TOP|BOTTOM)_CENTER$/,
    ],
  },
  {
    tags: ['StbSecBarSlab_RC_2Way'],
    allowedPositionSets: [['SHORT_TOP', 'SHORT_BOTTOM', 'LONG_TOP', 'LONG_BOTTOM']],
  },
  {
    tags: ['StbSecBarSlab_RC_Conventional1Way1', 'StbSecBarSlab_RC_1Way1'],
    allowedPositionSets: [['MAIN_TOP', 'MAIN_BOTTOM', 'TRANSVERSE_TOP', 'TRANSVERSE_BOTTOM']],
  },
  {
    tags: ['StbSecBarSlab_RC_Conventional1Way2', 'StbSecBarSlab_RC_1Way2'],
    allowedPositionSets: [
      [
        'MAIN_BASE_TOP',
        'MAIN_BASE_BOTTOM',
        'MAIN_TIP_TOP',
        'MAIN_TIP_BOTTOM',
        'TRANSVERSE_TOP',
        'TRANSVERSE_BOTTOM',
      ],
    ],
  },
]);
function slabDirection(pos) {
  const value = String(pos || '').toUpperCase();
  if (value.includes('SHORT') || value.includes('MAIN')) return 'FIRST';
  if (value.includes('LONG') || value.includes('TRANSVERSE')) return 'SECOND';
  return null;
}

function hasPositiveBarDesignation(element) {
  const raw = String(element?.getAttribute?.('D') || '').toUpperCase();
  for (const match of raw.matchAll(/[DR](\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return true;
  }
  return false;
}

function hasAllowedPositionSet(elements, pattern) {
  const positions = elements.map((element) =>
    String(element?.getAttribute?.('pos') || '')
      .trim()
      .toUpperCase(),
  );
  if (positions.some((position) => !position)) return false;
  if (new Set(positions).size !== positions.length) return false;

  if (Number.isInteger(pattern?.expectedCount) && positions.length !== pattern.expectedCount) {
    return false;
  }
  if (Number.isInteger(pattern?.minCount) && positions.length < pattern.minCount) return false;
  if (Number.isInteger(pattern?.maxCount) && positions.length > pattern.maxCount) return false;
  if (
    pattern?.positionPattern &&
    positions.some((position) => !pattern.positionPattern.test(position))
  ) {
    return false;
  }
  if (
    pattern?.requiredPositionGroups &&
    pattern.requiredPositionGroups.some(
      (requiredPattern) => !positions.some((position) => requiredPattern.test(position)),
    )
  ) {
    return false;
  }
  if (!pattern?.allowedPositionSets) return true;

  const actual = [...positions].sort();
  return pattern.allowedPositionSets.some((allowed) => {
    if (allowed.length !== actual.length) return false;
    const expected = [...allowed].sort();
    return expected.every((position, index) => position === actual[index]);
  });
}

function trussProductSpacing(product) {
  const arrangements = Array.from(
    product?.getElementsByTagName?.('StbSecBarArrangementSlab_RC_Truss') || [],
  );
  if (arrangements.length !== 1) {
    return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
  }

  const elements = Array.from(
    arrangements[0]?.getElementsByTagName?.('StbSecBarSlab_RC_Truss1Way') || [],
  );
  if (
    !hasAllowedPositionSet(elements, {
      minCount: 2,
      maxCount: 4,
      positionPattern: /^(MAIN|TRANSVERSE)_(TOP|BOTTOM)$/,
    })
  ) {
    return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
  }

  const groups = { FIRST: [], SECOND: [] };
  for (const element of elements) {
    const direction = slabDirection(element.getAttribute('pos'));
    const pitchMm = numberAttr(element, 'pitch');
    if (!direction || !(pitchMm > 0) || !hasPositiveBarDesignation(element)) {
      return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
    }
    groups[direction].push(pitchMm);
  }

  return {
    firstMm: positiveUnique(groups.FIRST),
    secondMm: positiveUnique(groups.SECOND),
    labels: ['PRIMARY_1', 'PRIMARY_2'],
  };
}

function trussSectionSpacings(sectionElement) {
  const products = Array.from(
    sectionElement?.getElementsByTagName?.('StbSecSlab_RC_TrussProduct') || [],
  );
  if (products.length === 0) return null;

  const productSpacings = products.map(trussProductSpacing);
  if (productSpacings.some((spacing) => !(spacing.firstMm > 0) || !(spacing.secondMm > 0))) {
    return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
  }

  const firstMm = positiveUnique(productSpacings.map((spacing) => spacing.firstMm));
  const secondMm = positiveUnique(productSpacings.map((spacing) => spacing.secondMm));
  if (!(firstMm > 0) || !(secondMm > 0)) {
    return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
  }

  return {
    firstMm,
    secondMm,
    labels: ['PRIMARY_1', 'PRIMARY_2'],
  };
}

function conventionalSectionSpacings(sectionElement) {
  const matchedPatterns = SLAB_BAR_PATTERNS.map((pattern) => ({
    ...pattern,
    elements: pattern.tags.flatMap((tag) =>
      Array.from(sectionElement.getElementsByTagName?.(tag) || []),
    ),
  })).filter((pattern) => pattern.elements.length > 0);

  if (matchedPatterns.length === 0) return null;
  if (matchedPatterns.length !== 1) {
    return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
  }

  const pattern = matchedPatterns[0];
  if (!hasAllowedPositionSet(pattern.elements, pattern)) {
    return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
  }

  const groups = { FIRST: [], SECOND: [] };
  for (const element of pattern.elements) {
    const direction = slabDirection(element.getAttribute('pos'));
    const pitchMm = numberAttr(element, 'pitch');
    if (!direction || !(pitchMm > 0) || !hasPositiveBarDesignation(element)) {
      return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
    }
    groups[direction].push(pitchMm);
  }

  return {
    firstMm: positiveUnique(groups.FIRST),
    secondMm: positiveUnique(groups.SECOND),
    labels: ['PRIMARY_1', 'PRIMARY_2'],
  };
}

function reconcileSlabSpacings(first, second) {
  if (!first) return second;
  if (!second) return first;
  if (
    !(first.firstMm > 0) ||
    !(first.secondMm > 0) ||
    !(second.firstMm > 0) ||
    !(second.secondMm > 0)
  ) {
    return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
  }

  const firstMm = positiveUnique([first.firstMm, second.firstMm]);
  const secondMm = positiveUnique([first.secondMm, second.secondMm]);
  if (!(firstMm > 0) || !(secondMm > 0)) {
    return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
  }
  return {
    firstMm,
    secondMm,
    labels: ['PRIMARY_1', 'PRIMARY_2'],
  };
}

function slabSpacingsFromSectionElement(sectionElement) {
  if (!sectionElement) return unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);

  const conventionalSpacings = conventionalSectionSpacings(sectionElement);
  const trussSpacings = trussSectionSpacings(sectionElement);
  const reconciled = reconcileSlabSpacings(conventionalSpacings, trussSpacings);
  return reconciled || unresolvedSpacings(['PRIMARY_1', 'PRIMARY_2']);
}

function openingSectionMap(xmlDoc) {
  const map = new Map();
  for (const element of Array.from(xmlDoc?.getElementsByTagName?.('StbSecOpen_RC') || [])) {
    const id = element.getAttribute('id');
    if (!id) continue;
    map.set(String(id), {
      id: String(id),
      widthMm: numberAttr(element, 'length_X'),
      heightMm: numberAttr(element, 'length_Y'),
    });
  }
  return map;
}

function mapById(xmlDoc, tagName) {
  const map = new Map();
  for (const element of Array.from(xmlDoc?.getElementsByTagName?.(tagName) || [])) {
    const id = element.getAttribute('id');
    if (id) map.set(String(id), element);
  }
  return map;
}

function legacyOpenIds(member) {
  const list = member?.getElementsByTagName?.('StbOpenIdList')?.[0];
  return Array.from(list?.getElementsByTagName?.('StbOpenId') || [])
    .map((element) => element.getAttribute('id'))
    .filter(Boolean)
    .map(String);
}

function openingKey(fact, modelSource = null) {
  const base = `${fact.memberType}:${fact.memberId || '-'}:${fact.openingId || '-'}`;
  return modelSource ? `${modelSource}:${base}` : base;
}

function lookupOption(container, key) {
  if (!container) return undefined;
  if (container instanceof Map) return container.get(key);
  if (Object.prototype.hasOwnProperty.call(container, key)) return container[key];
  return undefined;
}

function finiteGeometryValue(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function signedDeflectionGeometry(geometry = {}) {
  const bendOffsetMm = finiteGeometryValue(geometry?.bendOffsetMm);
  const bendRunMm = finiteGeometryValue(geometry?.bendRunMm);
  const shiftMm = finiteGeometryValue(geometry?.shiftMm);
  const hasBend = bendOffsetMm !== null || bendRunMm !== null;
  const hasShift = shiftMm !== null;
  const method = hasBend && hasShift ? 'AMBIGUOUS' : hasBend ? 'BEND' : hasShift ? 'SHIFT' : null;
  return Object.freeze({
    method,
    bendOffsetMm,
    bendRunMm,
    shiftMm,
  });
}

function normalizedFact({
  openingId,
  openingSectionId,
  openingElementName,
  memberType,
  memberId,
  memberSectionId,
  widthMm,
  heightMm,
  positionXMm,
  positionYMm,
  rotateDeg,
  spacings,
  sourceVersion,
}) {
  const maxMm =
    Number.isFinite(widthMm) && Number.isFinite(heightMm) && widthMm > 0 && heightMm > 0
      ? Math.max(widthMm, heightMm)
      : null;
  const spacingResolved = spacings?.firstMm > 0 && spacings?.secondMm > 0;
  return Object.freeze({
    openingId: openingId ? String(openingId) : null,
    openingSectionId: openingSectionId ? String(openingSectionId) : null,
    openingElementName: openingElementName || null,
    memberType,
    memberId: memberId ? String(memberId) : null,
    memberSectionId: memberSectionId ? String(memberSectionId) : null,
    openingWidthMm: widthMm,
    openingHeightMm: heightMm,
    openingMaxMm: maxMm,
    positionXMm: Number.isFinite(positionXMm) ? positionXMm : null,
    positionYMm: Number.isFinite(positionYMm) ? positionYMm : null,
    rotateDeg: Number.isFinite(rotateDeg) ? rotateDeg : null,
    spacingFirstMm: spacings?.firstMm ?? null,
    spacingSecondMm: spacings?.secondMm ?? null,
    spacingDirections: Object.freeze([...(spacings?.labels || [])]),
    openingWithinBothSpacings:
      maxMm !== null && spacingResolved
        ? maxMm <= spacings.firstMm && maxMm <= spacings.secondMm
        : null,
    sourceVersion,
  });
}

function collectWallFacts(xmlDoc, options) {
  const result = [];
  const wallFacts = collectWallRebarFacts(xmlDoc, options);
  for (const wall of wallFacts.walls || []) {
    const section = wallFacts.sections.get(String(wall.sectionId));
    const spacings = wallSpacings(section);
    for (const opening of wall.openings || []) {
      result.push(
        normalizedFact({
          openingId: opening.id,
          openingSectionId: opening.sectionId,
          openingElementName: opening.sourceVersion === '2.0.2' ? 'StbOpen' : 'StbOpenArrangement',
          memberType: 'WALL',
          memberId: wall.id,
          memberSectionId: wall.sectionId,
          widthMm: opening.widthMm,
          heightMm: opening.heightMm,
          positionXMm: opening.positionXMm,
          positionYMm: opening.positionYMm,
          rotateDeg: opening.rotateDeg,
          spacings,
          sourceVersion: opening.sourceVersion || null,
        }),
      );
    }
  }
  return result;
}

function collectModernSlabOpenings(xmlDoc) {
  const result = new Map();
  for (const opening of Array.from(xmlDoc?.getElementsByTagName?.('StbOpenArrangement') || [])) {
    if ((opening.getAttribute('kind_member') || '').toUpperCase() !== 'SLAB') continue;
    const memberId = opening.getAttribute('id_member');
    if (!memberId) continue;
    if (!result.has(String(memberId))) result.set(String(memberId), []);
    result.get(String(memberId)).push(opening);
  }
  return result;
}

function collectSlabFacts(xmlDoc) {
  const result = [];
  const openSections = openingSectionMap(xmlDoc);
  const slabs = mapById(xmlDoc, 'StbSlab');
  const slabSectionElements = mapById(xmlDoc, 'StbSecSlab_RC');
  const modernBySlab = collectModernSlabOpenings(xmlDoc);
  const legacyOpenings = mapById(xmlDoc, 'StbOpen');

  for (const [memberId, member] of slabs) {
    if ((member.getAttribute('kind_structure') || '').toUpperCase() !== 'RC') continue;

    const memberSectionId = member.getAttribute('id_section') || null;
    const sectionElement = memberSectionId
      ? slabSectionElements.get(String(memberSectionId))
      : null;
    const spacings = slabSpacingsFromSectionElement(sectionElement);
    const modern = modernBySlab.get(String(memberId)) || [];
    const legacy = legacyOpenIds(member)
      .map((openingId) => legacyOpenings.get(String(openingId)))
      .filter(Boolean);
    const openings = modern.length > 0 ? modern : legacy;
    const modernSource = modern.length > 0;

    for (const opening of openings) {
      const openingId = opening.getAttribute('id') || null;
      const openingSectionId = opening.getAttribute('id_section') || null;
      const openSection = openingSectionId ? openSections.get(String(openingSectionId)) : null;
      result.push(
        normalizedFact({
          openingId,
          openingSectionId,
          openingElementName: modernSource ? 'StbOpenArrangement' : 'StbOpen',
          memberType: 'SLAB',
          memberId,
          memberSectionId,
          widthMm: modernSource
            ? (openSection?.widthMm ?? null)
            : (numberAttr(opening, 'length_X') ?? openSection?.widthMm ?? null),
          heightMm: modernSource
            ? (openSection?.heightMm ?? null)
            : (numberAttr(opening, 'length_Y') ?? openSection?.heightMm ?? null),
          positionXMm: numberAttr(opening, 'position_X'),
          positionYMm: numberAttr(opening, 'position_Y'),
          rotateDeg: numberAttr(opening, 'rotate'),
          spacings,
          sourceVersion: modernSource ? '2.1' : '2.0.2',
        }),
      );
    }
  }
  return result;
}

export function collectSmallOpeningRebarSourceFacts(xmlDoc, options = {}) {
  if (!xmlDoc) return Object.freeze([]);
  return Object.freeze([...collectWallFacts(xmlDoc, options), ...collectSlabFacts(xmlDoc)]);
}

export function buildSmallOpeningRebarDeflectionEvaluations(xmlDoc, options = {}) {
  const facts = collectSmallOpeningRebarSourceFacts(xmlDoc, options);
  let projectAssignmentResolver = null;
  return Object.freeze(
    facts.map((fact) => {
      const modelSource = options.modelSource || null;
      const key = openingKey(fact, modelSource);
      const callerCoverStatus = lookupOption(options.smallOpeningCoverStatusByOpening, key);
      const callerGeometry = lookupOption(options.smallOpeningDeflectionGeometryByOpening, key);
      const callerOverridePresent = callerCoverStatus !== undefined || callerGeometry !== undefined;
      let projectAssignment = null;
      if (!callerOverridePresent && modelSource) {
        if (!projectAssignmentResolver) {
          const projectDetailing =
            options.projectDetailing === undefined
              ? getRebarProjectDetailing()
              : options.projectDetailing;
          projectAssignmentResolver =
            createSmallOpeningRebarDeflectionAssignmentResolver(projectDetailing);
        }
        projectAssignment = projectAssignmentResolver({
          modelSource,
          memberType: fact.memberType,
          memberId: fact.memberId,
          openingId: fact.openingId,
        });
      }

      let coverStatus = callerCoverStatus ?? 'UNRESOLVED';
      let geometry = callerGeometry || {};
      let detailingSource = callerOverridePresent ? 'CALLER_OVERRIDE' : null;
      let projectSourceRef = null;

      if (
        !callerOverridePresent &&
        projectAssignment?.active &&
        projectAssignment?.resolved &&
        projectAssignment?.assignment
      ) {
        const assignment = projectAssignment.assignment;
        coverStatus = assignment.coverStatus;
        geometry =
          assignment.method === 'BEND'
            ? {
                bendOffsetMm: assignment.bendOffsetMm,
                bendRunMm: assignment.bendRunMm,
              }
            : { shiftMm: assignment.shiftMm };
        detailingSource = 'PROJECT_DETAILING';
        projectSourceRef = projectAssignment.sourceRef;
      } else if (!callerOverridePresent && projectAssignment?.active) {
        detailingSource = 'PROJECT_DETAILING_UNRESOLVED';
        projectSourceRef = projectAssignment.sourceRef;
      }

      const deflectionGeometry = signedDeflectionGeometry(geometry);
      const evaluation = classifySmallOpeningRebarDeflectionCandidate({
        openingId: fact.openingId,
        memberType: fact.memberType === 'WALL' ? 'StbWall' : 'StbSlab',
        memberId: fact.memberId,
        openingWithinBothSpacings: fact.openingWithinBothSpacings,
        coverStatus,
        bendOffsetMm: deflectionGeometry.bendOffsetMm,
        bendRunMm: deflectionGeometry.bendRunMm,
        shiftMm: deflectionGeometry.shiftMm,
      });
      return Object.freeze({
        ...evaluation,
        openingElementName: fact.openingElementName,
        modelSource,
        sourceFact: fact,
        sourceKey: key,
        detailingSource,
        deflectionGeometry,
        projectSourceRef,
        projectSourceStatus: projectAssignment?.status || null,
        projectSourceReason: projectAssignment?.reason || null,
      });
    }),
  );
}
