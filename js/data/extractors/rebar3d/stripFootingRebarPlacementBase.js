/**
 * @fileoverview R13: RC布基礎（StbStripFooting + Continuous）のworld RebarPath生成。
 *
 * production-ready範囲:
 * - StbSecFoundation_RC_Continuous type=REVERSE_T / RIGHT_L / LEFT_L
 * - 等厚断面の MAIN_BASE TOP/BOTTOM + TRANSVERSE TOP/BOTTOM、または下端2系統
 * - 等厚完全かごに付随するHORIZONTAL
 * - MAIN_BASEのisVertical / length_vertical（幅Y方向の外周端）
 * - テーパー断面の下端2系統
 * - 対応RC基礎梁側面から上面profileを一意に解決できるテーパー完全かご
 * - 主筋切替(length/main_type)なし
 *
 * ST-Bridge仕様どおり、布基礎の配置は対応する基礎梁の始終端基準点を正本とする。
 * テーパー根元境界は、対応RC基礎梁の断面幅・horizontal_offsetとStbStripFooting.offsetから
 * 布基礎ローカルY上へ解決する。上端筋は仕様図のdepth_base/depth_tipを折線補間し、
 * depth_cover_topを部材ローカルZ方向に適用する。
 * HORIZONTALは等厚断面に限り、左右側面へN本ずつ部材X方向の線材として配置する。
 * MAIN_TIP・主筋切替・TRANSVERSEのisVerticalは引き続きfail-closedとする。
 *
 * @module data/extractors/rebar3d/stripFootingRebarPlacement
 */

import { createLine, createRebarPath } from './rebarPath.js';
import {
  parseFoundationBeamReferenceMap,
  parseStripFootingMembers,
  parseStripFootingSectionMap,
  readStripFootingNodeMap,
} from './stripFootingRebarSectionFacts.js';

const EPS = 1e-6;
const BOTTOM_ONLY = new Set(['MAIN_BASE_BOTTOM', 'TRANSVERSE_BOTTOM']);
const FULL_CAGE = new Set([
  'MAIN_BASE_TOP',
  'MAIN_BASE_BOTTOM',
  'TRANSVERSE_TOP',
  'TRANSVERSE_BOTTOM',
]);
const SUPPORTED_POSITIONS = new Set([...FULL_CAGE, 'HORIZONTAL']);

function sameSet(actual, expected) {
  return actual.size === expected.size && [...actual].every((value) => expected.has(value));
}

function makeCheck(member, status, code, message, extra = {}) {
  return {
    memberType: 'stripFooting',
    memberId: member.id,
    memberName: member.name,
    sectionId: member.sectionId,
    status,
    specialRequired: status !== 'READY',
    code,
    message,
    ...extra,
  };
}

function normalize2(dx, dy) {
  const length = Math.hypot(dx, dy);
  if (!(length > EPS)) return null;
  return { x: dx / length, y: dy / length, length };
}

function addScaled(point, direction, distance) {
  return {
    x: point.x + direction.x * distance,
    y: point.y + direction.y * distance,
    z: point.z,
  };
}

function evenlySpaced(count, min, max) {
  if (!(count > 0) || !Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  if (count === 1) return [(min + max) / 2];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, index) => min + step * index);
}

function centeredFixedPitchPositions(length, edgeInset, pitch) {
  const min = edgeInset;
  const max = length - edgeInset;
  if (!(pitch > 0) || !(max >= min)) return [];
  const span = max - min;
  const count = Math.max(1, Math.floor(span / pitch) + 1);
  const occupied = (count - 1) * pitch;
  const first = min + (span - occupied) / 2;
  return Array.from({ length: count }, (_, index) => first + index * pitch);
}

function footingLegSide(type) {
  if (type === 'RIGHT_L') return 'RIGHT';
  if (type === 'LEFT_L') return 'LEFT';
  if (type === 'REVERSE_T') return 'BOTH';
  return null;
}

function resolveBeamFaceRoot(member, reference, side) {
  if (!member || !reference || reference.status !== 'READY') {
    return { status: 'UNRESOLVED', reason: 'FOUNDATION_BEAM_REFERENCE_UNRESOLVED' };
  }
  if (reference.beamStructureKind !== 'RC') {
    return { status: 'UNRESOLVED', reason: 'FOUNDATION_BEAM_NOT_RC' };
  }

  const profile = reference.beamSectionProfile;
  if (!profile || profile.status !== 'READY') {
    return {
      status: 'UNRESOLVED',
      reason: profile?.reason || 'FOUNDATION_BEAM_SECTION_UNRESOLVED',
      beamSectionId: reference.beamSectionId || null,
    };
  }

  const startFace = profile[`start${side}Y`];
  const endFace = profile[`end${side}Y`];
  if (![startFace, endFace, member.offsetMm].every(Number.isFinite)) {
    return { status: 'UNRESOLVED', reason: 'FOUNDATION_BEAM_FACE_INVALID' };
  }

  const startRootY = startFace - member.offsetMm;
  const endRootY = endFace - member.offsetMm;
  if (Math.abs(startRootY - endRootY) > EPS) {
    return {
      status: 'UNRESOLVED',
      reason: 'FOUNDATION_BEAM_ROOT_FACE_VARIES_ALONG_MEMBER',
      side,
      startRootY,
      endRootY,
    };
  }

  return {
    status: 'READY',
    side,
    rootY: (startRootY + endRootY) / 2,
    beamSectionId: reference.beamSectionId,
    beamSectionProfileKind: profile.profileKind,
    beamSectionBasis: profile.basis,
    beamStartWidthMm: profile.startWidthMm,
    beamEndWidthMm: profile.endWidthMm,
    beamStartHorizontalOffsetMm: profile.startHorizontalOffsetMm,
    beamEndHorizontalOffsetMm: profile.endHorizontalOffsetMm,
  };
}

function resolveTaperSurfaceProfile(member, shape, reference) {
  if (!shape?.valid || !(shape.widthMm > 0)) {
    return { status: 'UNRESOLVED', reason: 'FOOTING_SHAPE_INVALID' };
  }
  const halfWidth = shape.widthMm / 2;

  if (shape.type === 'RIGHT_L' || shape.type === 'LEFT_L') {
    const side = shape.type === 'RIGHT_L' ? 'Right' : 'Left';
    const face = resolveBeamFaceRoot(member, reference, side);
    if (face.status !== 'READY') return face;

    const rootBoundaryY = face.rootY;
    const tipY = shape.type === 'RIGHT_L' ? -halfWidth : halfWidth;
    const inside = rootBoundaryY >= -halfWidth - EPS && rootBoundaryY <= halfWidth + EPS;
    const hasTaperRun =
      shape.type === 'RIGHT_L' ? rootBoundaryY > tipY + EPS : rootBoundaryY < tipY - EPS;
    if (!inside || !hasTaperRun) {
      return {
        status: 'UNRESOLVED',
        reason: 'ROOT_BOUNDARY_OUTSIDE_FOOTING_WIDTH',
        rootBoundaryY,
        halfWidth,
      };
    }

    return {
      status: 'READY',
      profileKind: 'ONE_SIDED',
      type: shape.type,
      halfWidth,
      rootBoundaryY,
      tipY,
      ...face,
    };
  }

  if (shape.type === 'REVERSE_T') {
    const right = resolveBeamFaceRoot(member, reference, 'Right');
    if (right.status !== 'READY') return { ...right, requiredSide: 'Right' };
    const left = resolveBeamFaceRoot(member, reference, 'Left');
    if (left.status !== 'READY') return { ...left, requiredSide: 'Left' };

    const rightRootY = right.rootY;
    const leftRootY = left.rootY;
    const valid =
      rightRootY > -halfWidth + EPS && leftRootY < halfWidth - EPS && rightRootY < leftRootY - EPS;
    if (!valid) {
      return {
        status: 'UNRESOLVED',
        reason: 'REVERSE_T_ROOT_BOUNDARIES_INVALID',
        halfWidth,
        rightRootY,
        leftRootY,
      };
    }

    return {
      status: 'READY',
      profileKind: 'REVERSE_T',
      type: shape.type,
      halfWidth,
      rightRootY,
      leftRootY,
      rightTipY: -halfWidth,
      leftTipY: halfWidth,
      beamSectionId: right.beamSectionId,
      beamSectionProfileKind: right.beamSectionProfileKind,
      beamSectionBasis: right.beamSectionBasis,
      beamStartWidthMm: right.beamStartWidthMm,
      beamEndWidthMm: right.beamEndWidthMm,
      beamStartHorizontalOffsetMm: right.beamStartHorizontalOffsetMm,
      beamEndHorizontalOffsetMm: right.beamEndHorizontalOffsetMm,
    };
  }

  return { status: 'UNRESOLVED', reason: 'TAPER_PROFILE_TYPE_UNSUPPORTED' };
}

function depthAtTaperY(shape, profile, transverseMm) {
  if (!profile || profile.status !== 'READY') return null;
  const y = Number(transverseMm);
  if (!Number.isFinite(y)) return null;
  const halfWidth = shape.widthMm / 2;
  if (y < -halfWidth - EPS || y > halfWidth + EPS) return null;

  if (shape.type === 'RIGHT_L') {
    const root = profile.rootBoundaryY;
    const tip = -halfWidth;
    if (y >= root - EPS) return shape.depthBaseMm;
    const ratio = (y - tip) / (root - tip);
    return shape.depthTipMm + ratio * (shape.depthBaseMm - shape.depthTipMm);
  }

  if (shape.type === 'LEFT_L') {
    const root = profile.rootBoundaryY;
    const tip = halfWidth;
    if (y <= root + EPS) return shape.depthBaseMm;
    const ratio = (y - root) / (tip - root);
    return shape.depthBaseMm + ratio * (shape.depthTipMm - shape.depthBaseMm);
  }

  if (shape.type === 'REVERSE_T') {
    const rightRoot = profile.rightRootY;
    const leftRoot = profile.leftRootY;
    if (y >= rightRoot - EPS && y <= leftRoot + EPS) return shape.depthBaseMm;
    if (y < rightRoot) {
      const ratio = (y + halfWidth) / (rightRoot + halfWidth);
      return shape.depthTipMm + ratio * (shape.depthBaseMm - shape.depthTipMm);
    }
    const ratio = (y - leftRoot) / (halfWidth - leftRoot);
    return shape.depthBaseMm + ratio * (shape.depthTipMm - shape.depthBaseMm);
  }

  return null;
}

function resolveOneSidedTaperReference(member, shape, reference) {
  const profile = resolveTaperSurfaceProfile(member, shape, reference);
  if (!profile || profile.status !== 'READY') return profile;
  const depthMm = depthAtTaperY(shape, profile, 0);
  if (!(depthMm > 0) || !Number.isFinite(depthMm)) {
    return { status: 'UNRESOLVED', reason: 'REFERENCE_DEPTH_INVALID' };
  }
  return {
    ...profile,
    status: 'READY',
    depthMm,
    basis: 'ONE_SIDED_TAPER_FROM_RC_FOUNDATION_BEAM_FACE_AT_WIDTH_CENTER',
    taperSurfaceProfile: profile,
  };
}

function resolveReferenceDepth(shape, member = null, reference = null) {
  if (!shape?.valid) return null;
  const { type, depthBaseMm, depthTipMm } = shape;
  if (![depthBaseMm, depthTipMm].every(Number.isFinite)) return null;

  const tapered = Math.abs(depthBaseMm - depthTipMm) > EPS;
  if (!tapered) {
    return {
      status: 'READY',
      depthMm: depthBaseMm,
      basis: 'UNIFORM_DEPTH_AT_WIDTH_CENTER',
      taperSurfaceProfile: null,
    };
  }

  const surface = resolveTaperSurfaceProfile(member, shape, reference);
  if (surface?.status === 'READY') {
    const depthMm = depthAtTaperY(shape, surface, 0);
    if (!(depthMm > 0) || !Number.isFinite(depthMm)) {
      return { status: 'UNRESOLVED', reason: 'REFERENCE_DEPTH_INVALID' };
    }
    if (type === 'REVERSE_T') {
      return {
        ...surface,
        status: 'READY',
        depthMm,
        basis: 'REVERSE_T_BASE_DEPTH_AT_WIDTH_CENTER',
        taperSurfaceProfile: surface,
      };
    }
    return {
      ...surface,
      status: 'READY',
      depthMm,
      basis: 'ONE_SIDED_TAPER_FROM_RC_FOUNDATION_BEAM_FACE_AT_WIDTH_CENTER',
      taperSurfaceProfile: surface,
    };
  }

  // 既存のREVERSE_T下端筋sliceは、幅中心が基礎梁直下でdepth_baseとなる契約を維持する。
  // 上端テーパー筋を扱う場合はsurface profileの解決を別途必須とする。
  if (type === 'REVERSE_T') {
    return {
      status: 'READY',
      depthMm: depthBaseMm,
      basis: 'REVERSE_T_BASE_DEPTH_AT_WIDTH_CENTER',
      taperSurfaceProfile: null,
      taperSurfaceReason: surface?.reason || 'UNRESOLVED',
    };
  }

  return surface || null;
}

function sectionDepthAtY(section, frame, transverseMm) {
  const tapered = Math.abs(section.shape.depthBaseMm - section.shape.depthTipMm) > EPS;
  if (!tapered) return section.shape.depthBaseMm;
  return depthAtTaperY(section.shape, frame.taperSurfaceProfile, transverseMm);
}

function barZAtY(section, frame, bar, transverseMm) {
  if (bar.pos.endsWith('_TOP')) {
    if (!Number.isFinite(section.coverTopMm)) return null;
    const depthMm = sectionDepthAtY(section, frame, transverseMm);
    if (!Number.isFinite(depthMm)) return null;
    return frame.bottomZ + depthMm - section.coverTopMm - bar.diaMm / 2;
  }
  if (!Number.isFinite(section.coverBottomMm)) return null;
  return frame.bottomZ + section.coverBottomMm + bar.diaMm / 2;
}

function taperBreakpoints(frame, minY, maxY) {
  const profile = frame.taperSurfaceProfile;
  if (!profile || profile.status !== 'READY') return [];
  const candidates =
    profile.profileKind === 'REVERSE_T'
      ? [profile.rightRootY, profile.leftRootY]
      : [profile.rootBoundaryY];
  return candidates
    .filter((value) => Number.isFinite(value) && value > minY + EPS && value < maxY - EPS)
    .sort((a, b) => a - b);
}

function verticalTargetZAtY(section, frame, bar, transverseMm, currentZ) {
  if (!bar.isVertical) return null;

  let targetZ = null;
  let basis = null;
  if (bar.lengthVerticalMm > 0) {
    targetZ = bar.pos.endsWith('_TOP')
      ? currentZ - bar.lengthVerticalMm
      : currentZ + bar.lengthVerticalMm;
    basis = 'STB_LENGTH_VERTICAL';
  } else {
    const counterpartPos = bar.pos.endsWith('_TOP') ? 'MAIN_BASE_BOTTOM' : 'MAIN_BASE_TOP';
    const counterpart = section.bars.find((entry) => entry.pos === counterpartPos);
    if (!counterpart) return null;
    targetZ = barZAtY(section, frame, counterpart, transverseMm);
    basis = 'OPPOSITE_FACE_MAIN_BAR';
  }

  const depthMm = sectionDepthAtY(section, frame, transverseMm);
  if (!Number.isFinite(depthMm) || !Number.isFinite(targetZ)) return null;
  const topAtY = frame.bottomZ + depthMm;
  if (!(targetZ > frame.bottomZ + EPS && targetZ < topAtY - EPS)) return null;
  if (Math.abs(targetZ - currentZ) <= EPS) return null;
  return { targetZ, basis };
}

function buildFrame(member, section, references) {
  const reference = references.get(member.referenceKey);
  if (reference?.status !== 'READY') return null;

  const startReference = reference.start;
  const endReference = reference.end;
  const direction = normalize2(
    endReference.x - startReference.x,
    endReference.y - startReference.y,
  );
  if (!direction) return null;
  if (Math.abs(startReference.z - endReference.z) > EPS) return null;

  const referenceDepth = resolveReferenceDepth(section.shape, member, reference);
  if (!referenceDepth || referenceDepth.status !== 'READY') return null;

  const left = { x: -direction.y, y: direction.x };
  const topZ = startReference.z + member.levelMm;
  const bottomZ = topZ - referenceDepth.depthMm;
  if (!(topZ > bottomZ)) return null;

  const rawStart = {
    x: startReference.x + left.x * member.offsetMm,
    y: startReference.y + left.y * member.offsetMm,
    z: topZ,
  };
  const rawEnd = {
    x: endReference.x + left.x * member.offsetMm,
    y: endReference.y + left.y * member.offsetMm,
    z: topZ,
  };
  const start = addScaled(rawStart, direction, -member.lengthExStartMm);
  const end = addScaled(rawEnd, direction, member.lengthExEndMm);
  const length = direction.length + member.lengthExStartMm + member.lengthExEndMm;
  if (!(length > EPS)) return null;

  return {
    start,
    end,
    direction,
    left,
    length,
    topZ,
    bottomZ,
    referenceDepthMm: referenceDepth.depthMm,
    referenceDepthBasis: referenceDepth.basis,
    taperSurfaceProfile: referenceDepth.taperSurfaceProfile ?? null,
    taperSurfaceReason: referenceDepth.taperSurfaceReason ?? null,
    rootBoundaryY: referenceDepth.rootBoundaryY ?? null,
    rightRootBoundaryY: referenceDepth.rightRootY ?? null,
    leftRootBoundaryY: referenceDepth.leftRootY ?? null,
    taperTipY: referenceDepth.tipY ?? null,
    beamSectionId: referenceDepth.beamSectionId ?? reference.beamSectionId ?? null,
    beamSectionProfileKind: referenceDepth.beamSectionProfileKind ?? null,
    beamSectionBasis: referenceDepth.beamSectionBasis ?? null,
    beamStartWidthMm: referenceDepth.beamStartWidthMm ?? null,
    beamEndWidthMm: referenceDepth.beamEndWidthMm ?? null,
    beamStartHorizontalOffsetMm: referenceDepth.beamStartHorizontalOffsetMm ?? null,
    beamEndHorizontalOffsetMm: referenceDepth.beamEndHorizontalOffsetMm ?? null,
    footingLegSide: footingLegSide(section.shape.type),
    foundationBeamElementType: reference.beamElementType,
    foundationBeamId: reference.beamId,
    foundationBeamStructureKind: reference.beamStructureKind,
    foundationBeamReferenceBasis: 'STB_FOUNDATION_BEAM_START_END_REFERENCE_POINTS',
  };
}

function worldAt(frame, axialMm, transverseMm, z) {
  return {
    x: frame.start.x + frame.direction.x * axialMm + frame.left.x * transverseMm,
    y: frame.start.y + frame.direction.y * axialMm + frame.left.y * transverseMm,
    z,
  };
}

function pathMetadata(member, section, frame, bar, extra = {}) {
  return {
    coordinateSpace: 'world',
    dia: bar.diaMm,
    designation: bar.designation,
    strength: bar.strength,
    memberType: 'stripFooting',
    memberId: member.id,
    memberName: member.name,
    sectionId: member.sectionId,
    position: bar.pos,
    source: 'STB_EXPLICIT_WITH_VIEWER_DISTRIBUTION',
    referencePointBasis: 'STB_STRIP_FOOTING_TOP_WIDTH_CENTER_FROM_FOUNDATION_BEAM',
    memberAxisBasis: 'FOUNDATION_BEAM_REFERENCE_START_TO_END_X_GLOBAL_Z_UP',
    foundationBeamElementType: frame.foundationBeamElementType,
    foundationBeamId: frame.foundationBeamId,
    foundationBeamStructureKind: frame.foundationBeamStructureKind,
    foundationBeamReferenceBasis: frame.foundationBeamReferenceBasis,
    foundationBeamSectionId: frame.beamSectionId,
    foundationBeamSectionProfileKind: frame.beamSectionProfileKind,
    foundationBeamSectionBasis: frame.beamSectionBasis,
    shapeType: section.shape.type,
    footingLegSide: frame.footingLegSide,
    referenceDepthMm: frame.referenceDepthMm,
    referenceDepthBasis: frame.referenceDepthBasis,
    rootBoundaryY: frame.rootBoundaryY,
    rightRootBoundaryY: frame.rightRootBoundaryY,
    leftRootBoundaryY: frame.leftRootBoundaryY,
    taperTipY: frame.taperTipY,
    taperSurfaceProfileKind: frame.taperSurfaceProfile?.profileKind || null,
    taperSurfaceBasis: frame.taperSurfaceProfile
      ? 'STB_PIECEWISE_LINEAR_DEPTH_WITH_LOCAL_Z_COVER'
      : null,
    isVertical: bar.isVertical,
    lengthVerticalMm: bar.lengthVerticalMm,
    layerOrderResolved: false,
    ...extra,
  };
}

function buildMainPaths(member, section, frame, bar) {
  const radius = bar.diaMm / 2;
  const sideInset = section.coverSideMm + radius;
  const halfWidth = section.shape.widthMm / 2;
  const minY = -halfWidth + sideInset;
  const maxY = halfWidth - sideInset;
  if (!(maxY >= minY)) return null;

  const positions = centeredFixedPitchPositions(frame.length, sideInset, bar.pitchMm);
  if (!positions.length) return null;

  const tapered = Math.abs(section.shape.depthBaseMm - section.shape.depthTipMm) > EPS;
  const isTop = bar.pos.endsWith('_TOP');
  const breakpoints = isTop && tapered ? taperBreakpoints(frame, minY, maxY) : [];
  const yPoints = [minY, ...breakpoints, maxY];

  const paths = positions.map((axialMm, barIndex) => {
    const primitives = [];
    for (let index = 0; index < yPoints.length - 1; index += 1) {
      const y0 = yPoints[index];
      const y1 = yPoints[index + 1];
      const z0 = barZAtY(section, frame, bar, y0);
      const z1 = barZAtY(section, frame, bar, y1);
      if (![z0, z1].every(Number.isFinite) || !(z0 > frame.bottomZ) || !(z1 > frame.bottomZ)) {
        return null;
      }
      primitives.push(createLine(worldAt(frame, axialMm, y0, z0), worldAt(frame, axialMm, y1, z1)));
    }
    if (!primitives.length) return null;

    let verticalTargetBasis = null;
    if (bar.isVertical) {
      const firstY = yPoints[0];
      const lastY = yPoints[yPoints.length - 1];
      const firstZ = barZAtY(section, frame, bar, firstY);
      const lastZ = barZAtY(section, frame, bar, lastY);
      const firstTarget = verticalTargetZAtY(section, frame, bar, firstY, firstZ);
      const lastTarget = verticalTargetZAtY(section, frame, bar, lastY, lastZ);
      if (!firstTarget || !lastTarget || firstTarget.basis !== lastTarget.basis) return null;
      verticalTargetBasis = firstTarget.basis;
      const firstPoint = worldAt(frame, axialMm, firstY, firstZ);
      const lastPoint = worldAt(frame, axialMm, lastY, lastZ);
      primitives.unshift(createLine({ ...firstPoint, z: firstTarget.targetZ }, firstPoint));
      primitives.push(createLine(lastPoint, { ...lastPoint, z: lastTarget.targetZ }));
    }

    return createRebarPath(
      primitives,
      pathMetadata(member, section, frame, bar, {
        barIndex,
        stbPitchMm: bar.pitchMm,
        barAxisBasis: 'LOCAL_Y_WIDTH',
        distributionAxisBasis: 'LOCAL_X_MEMBER_AXIS',
        longitudinalDistributionBasis: 'CENTERED_FIXED_PITCH_WITH_SIDE_COVER',
        endCoverBasis: 'DEPTH_COVER_SIDE',
        topCoverDirectionBasis: isTop && tapered ? 'LOCAL_Z_VERTICAL' : null,
        verticalTargetBasis,
      }),
    );
  });
  return paths.some((path) => !path) ? null : paths;
}

function buildTransversePaths(member, section, frame, bar) {
  const radius = bar.diaMm / 2;
  const sideInset = section.coverSideMm + radius;
  const halfWidth = section.shape.widthMm / 2;
  const minY = -halfWidth + sideInset;
  const maxY = halfWidth - sideInset;
  const startX = sideInset;
  const endX = frame.length - sideInset;
  if (!(maxY >= minY) || !(endX >= startX)) return null;

  const positions = evenlySpaced(bar.count, minY, maxY);
  if (positions.length !== bar.count) return null;

  const tapered = Math.abs(section.shape.depthBaseMm - section.shape.depthTipMm) > EPS;
  const isTop = bar.pos.endsWith('_TOP');
  const paths = positions.map((transverseMm, barIndex) => {
    const z = barZAtY(section, frame, bar, transverseMm);
    if (!Number.isFinite(z) || !(z > frame.bottomZ)) return null;
    return createRebarPath(
      [createLine(worldAt(frame, startX, transverseMm, z), worldAt(frame, endX, transverseMm, z))],
      pathMetadata(member, section, frame, bar, {
        barIndex,
        stbCount: bar.count,
        barAxisBasis: 'LOCAL_X_MEMBER_AXIS',
        distributionAxisBasis: 'LOCAL_Y_WIDTH',
        transverseDistributionBasis: 'EVENLY_SPACED_BY_N_WITH_SIDE_COVER',
        endCoverBasis: 'DEPTH_COVER_SIDE',
        topCoverDirectionBasis: isTop && tapered ? 'LOCAL_Z_VERTICAL' : null,
      }),
    );
  });
  return paths.some((path) => !path) ? null : paths;
}

function buildHorizontalPaths(member, section, frame, bar) {
  const radius = bar.diaMm / 2;
  const sideInset = section.coverSideMm + radius;
  const halfWidth = section.shape.widthMm / 2;
  const rightY = -halfWidth + sideInset;
  const leftY = halfWidth - sideInset;
  const startX = sideInset;
  const endX = frame.length - sideInset;
  if (!(leftY >= rightY) || !(endX >= startX)) return null;
  if (!Number.isFinite(section.coverTopMm) || !Number.isFinite(section.coverBottomMm)) return null;

  const minZ = frame.bottomZ + section.coverBottomMm + radius;
  const maxZ = frame.topZ - section.coverTopMm - radius;
  const levels = evenlySpaced(bar.count, minZ, maxZ);
  if (levels.length !== bar.count || levels.some((z) => !(z > frame.bottomZ && z < frame.topZ))) {
    return null;
  }

  const paths = [];
  const sides = [
    ['RIGHT', rightY],
    ['LEFT', leftY],
  ];
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const z = levels[levelIndex];
    for (const [horizontalSide, y] of sides) {
      paths.push(
        createRebarPath(
          [createLine(worldAt(frame, startX, y, z), worldAt(frame, endX, y, z))],
          pathMetadata(member, section, frame, bar, {
            barIndex: levelIndex,
            stbCount: bar.count,
            horizontalSide,
            barAxisBasis: 'LOCAL_X_MEMBER_AXIS',
            distributionAxisBasis: 'LOCAL_Z',
            verticalDistributionBasis: 'EVENLY_SPACED_BY_N_BETWEEN_TOP_BOTTOM_COVERS',
            sidePlacementBasis: 'BOTH_LOCAL_Y_SIDE_FACES_WITH_DEPTH_COVER_SIDE',
            endCoverBasis: 'DEPTH_COVER_SIDE',
          }),
        ),
      );
    }
  }
  return paths;
}

function validateFirstSlice(member, section, references) {
  if (!section) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_SECTION_UNRESOLVED',
      '参照するRC連続基礎断面が見つかりません',
    );
  }
  if (!section.shape?.valid) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_SHAPE_UNSUPPORTED',
      'RIGHT_L / LEFT_L / REVERSE_T の有効なRC連続基礎断面のみ3D配筋化します',
      { shapeType: section.shape?.type || null },
    );
  }
  if (!section.bars.length) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_REBAR_NOT_EXPLICIT',
      'StbSecBarFoundation_RC_Continuousが明示されていません',
    );
  }
  if (section.invalidBarCount > 0) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_BAR_DATA_INVALID',
      '径・本数・ピッチまたはisVertical/length_verticalの指定が不正です',
    );
  }
  if (section.duplicatePositions.length) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_DUPLICATE_BAR_POSITION',
      '同一posが複数記述されているため配筋を一意化できません',
      { duplicatePositions: section.duplicatePositions },
    );
  }

  const positions = new Set(section.bars.map((bar) => bar.pos));
  if ([...positions].some((pos) => !SUPPORTED_POSITIONS.has(pos))) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_BAR_SET_UNSUPPORTED',
      'MAIN_TIPを含む配筋はこのsliceでは推定しません',
      { positions: [...positions] },
    );
  }

  const hasHorizontal = positions.has('HORIZONTAL');
  const planPositions = new Set([...positions].filter((pos) => pos !== 'HORIZONTAL'));
  const bottomOnly = sameSet(planPositions, BOTTOM_ONLY);
  const fullCage = sameSet(planPositions, FULL_CAGE);
  const tapered = Math.abs(section.shape.depthBaseMm - section.shape.depthTipMm) > EPS;

  if (!bottomOnly && !fullCage) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_BAR_SET_UNSUPPORTED',
      '下端筋のみ、またはMAIN_BASE/TRANSVERSEの完全かご配筋以外は部分補間しません',
      { positions: [...positions] },
    );
  }
  if (hasHorizontal && !fullCage) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_HORIZONTAL_REQUIRES_FULL_CAGE',
      'HORIZONTALは上端・下端かぶり間へ配置するため、MAIN_BASE/TRANSVERSEの完全かご配筋に限り3D化します',
    );
  }
  if (hasHorizontal && tapered) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_TAPER_HORIZONTAL_UNRESOLVED',
      'テーパー断面のHORIZONTALは高さごとの有効側面位置を一意化できないため推定しません',
    );
  }

  if (section.bars.some((bar) => Number.isFinite(bar.lengthMm) || bar.mainType)) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_MAIN_SWITCH_UNSUPPORTED',
      'MAIN_TIP・length/main_typeによる主筋切替はこのsliceでは推定しません',
    );
  }

  const transverseVertical = section.bars.find(
    (bar) => bar.pos.startsWith('TRANSVERSE_') && bar.isVertical,
  );
  if (transverseVertical) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_TRANSVERSE_VERTICAL_UNSUPPORTED',
      'TRANSVERSEのisVerticalは連続方向端部での外周条件を一意化できないため推定しません',
      { position: transverseVertical.pos },
    );
  }

  const unresolvedMainVertical = section.bars.find((bar) => {
    if (!bar.pos.startsWith('MAIN_BASE_') || !bar.isVertical || bar.lengthVerticalMm > 0)
      return false;
    const counterpartPos = bar.pos.endsWith('_TOP') ? 'MAIN_BASE_BOTTOM' : 'MAIN_BASE_TOP';
    return !section.bars.some((entry) => entry.pos === counterpartPos);
  });
  if (unresolvedMainVertical) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_VERTICAL_TARGET_UNRESOLVED',
      'isVertical=trueでlength_vertical省略時は反対面の同方向筋まで伸ばすため、対応するMAIN_BASE筋が必要です',
      { position: unresolvedMainVertical.pos },
    );
  }

  const reference = references.get(member.referenceKey);
  if (reference?.status !== 'READY') {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_FOUNDATION_BEAM_REFERENCE_UNRESOLVED',
      '布基礎の配置基準となる基礎梁の始終端基準点を一意に解決できません',
      {
        referenceStatus: reference?.status || 'MISSING',
        referenceReason: reference?.reason || null,
        foundationBeamRefs:
          reference?.beamRefs ||
          (reference?.beamId
            ? [{ elementType: reference.beamElementType, id: reference.beamId }]
            : []),
      },
    );
  }

  if (
    tapered &&
    bottomOnly &&
    (section.shape.type === 'RIGHT_L' || section.shape.type === 'LEFT_L')
  ) {
    const oneSided = resolveReferenceDepth(section.shape, member, reference);
    if (!oneSided || oneSided.status !== 'READY') {
      return makeCheck(
        member,
        'SPECIAL_REQUIRED',
        'STRIP_FOOTING_ONE_SIDED_TAPER_REFERENCE_UNRESOLVED',
        'RIGHT_L / LEFT_Lテーパーの根元境界を対応RC基礎梁の断面幅・horizontal_offset・strip offsetから一意に解決できません',
        {
          shapeType: section.shape.type,
          depthBaseMm: section.shape.depthBaseMm,
          depthTipMm: section.shape.depthTipMm,
          referenceReason: oneSided?.reason || 'UNRESOLVED',
          foundationBeamSectionId: reference.beamSectionId || null,
          beamSectionProfileStatus: reference.beamSectionProfile?.status || 'MISSING',
        },
      );
    }
  }

  if (tapered && fullCage) {
    const taperSurface = resolveTaperSurfaceProfile(member, section.shape, reference);
    if (!taperSurface || taperSurface.status !== 'READY') {
      return makeCheck(
        member,
        'SPECIAL_REQUIRED',
        'STRIP_FOOTING_TAPER_TOP_SURFACE_UNRESOLVED',
        'テーパー上端筋の上面形状を対応RC基礎梁の側面位置から一意に解決できません',
        {
          shapeType: section.shape.type,
          depthBaseMm: section.shape.depthBaseMm,
          depthTipMm: section.shape.depthTipMm,
          referenceReason: taperSurface?.reason || 'UNRESOLVED',
          foundationBeamSectionId: reference.beamSectionId || null,
          beamSectionProfileStatus: reference.beamSectionProfile?.status || 'MISSING',
        },
      );
    }
  }

  const needsTop = fullCage || hasHorizontal;
  if (
    !Number.isFinite(section.coverBottomMm) ||
    !Number.isFinite(section.coverSideMm) ||
    (needsTop && !Number.isFinite(section.coverTopMm))
  ) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_COVER_UNRESOLVED',
      '必要な上・下・側面かぶりをST-Bridgeから解決できません',
    );
  }

  const maxBottomRadius = Math.max(
    ...section.bars.filter((bar) => bar.pos.endsWith('_BOTTOM')).map((bar) => bar.diaMm / 2),
  );
  const maxTopRadius = Math.max(
    0,
    ...section.bars.filter((bar) => bar.pos.endsWith('_TOP')).map((bar) => bar.diaMm / 2),
  );
  const requiredTipDepthMm = fullCage
    ? section.coverBottomMm + maxBottomRadius + section.coverTopMm + maxTopRadius
    : section.coverBottomMm + maxBottomRadius;
  if (tapered && !(section.shape.depthTipMm > requiredTipDepthMm)) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_TAPER_TIP_CLEARANCE_UNRESOLVED',
      fullCage
        ? '先端厚さ内に上端筋・下端筋のかぶりと半径を確保できません'
        : '先端厚さ内に下端筋のかぶりと半径を確保できません',
      {
        depthTipMm: section.shape.depthTipMm,
        requiredTipDepthMm,
        requiredBottomCenterDepthMm: section.coverBottomMm + maxBottomRadius,
        requiredTopCenterCoverMm: fullCage ? section.coverTopMm + maxTopRadius : null,
      },
    );
  }

  const frame = buildFrame(member, section, references);
  if (!frame) {
    return makeCheck(
      member,
      'SPECIAL_REQUIRED',
      'STRIP_FOOTING_MEMBER_GEOMETRY_UNRESOLVED',
      '基礎梁基準点・offset・level・余長から水平な布基礎配置を一意に構成できません',
    );
  }

  return makeCheck(member, 'READY', 'STRIP_FOOTING_REBAR_READY', '3D配筋化可能', {
    shapeType: section.shape.type,
    footingLegSide: frame.footingLegSide,
    foundationBeamElementType: frame.foundationBeamElementType,
    foundationBeamId: frame.foundationBeamId,
    foundationBeamStructureKind: frame.foundationBeamStructureKind,
    foundationBeamReferenceBasis: frame.foundationBeamReferenceBasis,
    foundationBeamSectionId: frame.beamSectionId,
    foundationBeamSectionProfileKind: frame.beamSectionProfileKind,
    foundationBeamSectionBasis: frame.beamSectionBasis,
    referenceDepthMm: frame.referenceDepthMm,
    referenceDepthBasis: frame.referenceDepthBasis,
    rootBoundaryY: frame.rootBoundaryY,
    rightRootBoundaryY: frame.rightRootBoundaryY,
    leftRootBoundaryY: frame.leftRootBoundaryY,
    taperTipY: frame.taperTipY,
    taperSurfaceProfileKind: frame.taperSurfaceProfile?.profileKind || null,
    taperSurfaceBasis: frame.taperSurfaceProfile
      ? 'STB_PIECEWISE_LINEAR_DEPTH_WITH_LOCAL_Z_COVER'
      : null,
    topCoverDirectionBasis: tapered && fullCage ? 'LOCAL_Z_VERTICAL' : null,
    horizontalDistributionBasis: hasHorizontal
      ? 'EVENLY_SPACED_BY_N_BETWEEN_TOP_BOTTOM_COVERS'
      : null,
    verticalDetailingResolved: section.bars.some((bar) => bar.isVertical),
    sectionProfile: tapered
      ? fullCage
        ? 'TAPER_FULL_CAGE'
        : 'TAPER_BOTTOM_ONLY'
      : 'UNIFORM_DEPTH',
    mainBarAxisBasis: 'LOCAL_Y_WIDTH',
    longitudinalDistributionBasis: 'CENTERED_FIXED_PITCH_WITH_SIDE_COVER',
    transverseBarAxisBasis: 'LOCAL_X_MEMBER_AXIS',
    transverseDistributionBasis: 'EVENLY_SPACED_BY_N_WITH_SIDE_COVER',
  });
}

function buildPaths(member, section, references) {
  const frame = buildFrame(member, section, references);
  if (!frame) return null;
  const paths = [];
  for (const bar of section.bars) {
    const built = bar.pos.startsWith('MAIN_BASE_')
      ? buildMainPaths(member, section, frame, bar)
      : bar.pos === 'HORIZONTAL'
        ? buildHorizontalPaths(member, section, frame, bar)
        : buildTransversePaths(member, section, frame, bar);
    if (!built) return null;
    paths.push(...built);
  }
  return paths;
}

export function buildStripFootingRebarRenderPlan(xmlDoc) {
  const sections = parseStripFootingSectionMap(xmlDoc);
  const nodes = readStripFootingNodeMap(xmlDoc);
  const references = parseFoundationBeamReferenceMap(xmlDoc, nodes);
  const members = parseStripFootingMembers(xmlDoc);
  const paths = [];
  const checks = [];

  for (const member of members) {
    const section = sections.get(member.sectionId);
    const check = validateFirstSlice(member, section, references);
    if (check.status !== 'READY') {
      checks.push(check);
      continue;
    }

    const memberPaths = buildPaths(member, section, references);
    if (!memberPaths) {
      checks.push(
        makeCheck(
          member,
          'SPECIAL_REQUIRED',
          'STRIP_FOOTING_REBAR_GEOMETRY_UNRESOLVED',
          'かぶり・径・pitch/NからRebarPathを構成できません',
        ),
      );
      continue;
    }

    paths.push(...memberPaths);
    checks.push(check);
  }

  return {
    paths,
    checks,
    readyCount: checks.filter((check) => check.status === 'READY').length,
    specialCount: checks.filter((check) => check.status !== 'READY').length,
  };
}

export const _stripFootingRebarPlacementInternals = {
  buildFrame,
  centeredFixedPitchPositions,
  evenlySpaced,
  footingLegSide,
  resolveReferenceDepth,
  resolveOneSidedTaperReference,
  resolveBeamFaceRoot,
  resolveTaperSurfaceProfile,
  depthAtTaperY,
  verticalTargetZAtY,
};
