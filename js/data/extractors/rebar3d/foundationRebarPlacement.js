/**
 * @fileoverview R13 first slice: RC独立基礎の明示配筋をworld RebarPathへ変換する。
 *
 * 対応:
 * - StbFooting
 * - StbSecFoundation_RC_Rect / StbSecFoundation_RC_Octagon / StbSecFoundation_RC_Triangle
 * - X/Y_TOP・BOTTOM、MAIN/TRANSVERSE_TOP・BOTTOM
 * - ThreeWay MAIN 3方向、OUTSIDE N=1単一外周
 * - HORIZONTAL（外周横筋）
 * - isVertical / length_vertical（ThreeWay OUTSIDEを除く）
 *
 * 正三角形ThreeWayのOUTSIDEは、仕様図で外周筋として明示される範囲のうち、N=1だけを
 * 側面かぶり位置の単一閉鎖外周筋として解決する。N>1は間隔・各ループ位置を一意化できないため
 * fail-closedを維持する。
 * 連続基礎および部分的な配筋組合せは推定せず SPECIAL_REQUIRED とする。
 * HORIZONTALはST-BridgeがNのみを保持するため、viewer上では上下面かぶり間へ等間隔配置し、
 * その配置basisをmetadataへ明示する。
 * X/Y筋の上下順はST-Bridgeでは指定されないため、同一faceの中心線レベルに置き、
 * fabrication上の内外順序は推定しない。
 *
 * @module data/extractors/rebar3d/foundationRebarPlacement
 */

import { createLine, createRebarPath } from './rebarPath.js';
import {
  numberAttr,
  parseFoundationSectionMap,
  readFoundationNodeMap,
} from './foundationRebarSectionFacts.js';
import {
  axisBounds,
  clipAxisLine,
  clipDirectedLine,
  evenlySpaced,
  evenlySpacedInterior,
  insetConvexPolygon,
  perpendicular2,
  planPolygon,
  projectionBounds,
  rotatePoint,
  triangleRunDirections,
  threeWayRunDirections,
} from './foundationRebarGeometry.js';
import {
  buildThreeWayOutsidePaths,
  validateThreeWayOutsideBars,
} from './foundationThreeWayOutsidePlacement.js';

const RECT_PLAN_BAR_POSITIONS = new Set(['X_TOP', 'Y_TOP', 'X_BOTTOM', 'Y_BOTTOM']);
const TRIANGLE_PLAN_BAR_POSITIONS = new Set([
  'MAIN_TOP',
  'MAIN_BOTTOM',
  'TRANSVERSE_TOP',
  'TRANSVERSE_BOTTOM',
]);
const THREE_WAY_PLAN_BAR_POSITIONS = new Set(['MAIN_TOP', 'MAIN_BOTTOM']);
const RECT_SUPPORTED_POSITIONS = new Set([...RECT_PLAN_BAR_POSITIONS, 'HORIZONTAL']);
const TRIANGLE_SUPPORTED_POSITIONS = new Set([...TRIANGLE_PLAN_BAR_POSITIONS, 'HORIZONTAL']);
const THREE_WAY_SUPPORTED_POSITIONS = new Set([
  'MAIN_TOP',
  'MAIN_BOTTOM',
  'OUTSIDE_TOP',
  'OUTSIDE_BOTTOM',
  'HORIZONTAL',
]);
const RECT_BOTTOM_ONLY = new Set(['X_BOTTOM', 'Y_BOTTOM']);
const RECT_FULL_CAGE = new Set(['X_TOP', 'Y_TOP', 'X_BOTTOM', 'Y_BOTTOM']);
const TRIANGLE_BOTTOM_ONLY = new Set(['MAIN_BOTTOM', 'TRANSVERSE_BOTTOM']);
const TRIANGLE_FULL_CAGE = new Set([
  'MAIN_TOP',
  'MAIN_BOTTOM',
  'TRANSVERSE_TOP',
  'TRANSVERSE_BOTTOM',
]);
const THREE_WAY_MAIN_BOTTOM_ONLY = new Set(['MAIN_BOTTOM']);
const THREE_WAY_MAIN_CAGE = new Set(['MAIN_TOP', 'MAIN_BOTTOM']);
const THREE_WAY_BOTTOM_ONLY = new Set(['MAIN_BOTTOM', 'OUTSIDE_BOTTOM']);
const THREE_WAY_FULL_CAGE = new Set(['MAIN_TOP', 'MAIN_BOTTOM', 'OUTSIDE_TOP', 'OUTSIDE_BOTTOM']);
const SUPPORTED_PLAN_SHAPES = new Set(['RECT', 'OCTAGON', 'TRIANGLE', 'EQUI_TRIANGLE']);

function sameSet(actual, expected) {
  return actual.size === expected.size && [...actual].every((value) => expected.has(value));
}

function makeCheck(footing, status, code, message, extra = {}) {
  return {
    memberType: 'footing',
    memberId: footing.id,
    memberName: footing.name,
    sectionId: footing.sectionId,
    status,
    specialRequired: status !== 'READY',
    code,
    message,
    ...extra,
  };
}

function barFamily(position) {
  for (const family of ['X', 'Y', 'MAIN', 'TRANSVERSE', 'OUTSIDE']) {
    if (position.startsWith(`${family}_`)) return family;
  }
  return null;
}

function verticalTargetZ(bar, section, bottomZ, topZ, barZ) {
  if (!bar.isVertical) return null;
  if (bar.lengthVerticalMm > 0) {
    return bar.pos.endsWith('_TOP') ? barZ - bar.lengthVerticalMm : barZ + bar.lengthVerticalMm;
  }

  // length_vertical省略時は仕様通り反対面の同方向筋まで伸ばす。
  // 反対面筋が無い下端筋のみ配筋では、端点位置を推定しない。
  const family = barFamily(bar.pos);
  if (!family) return null;
  const counterpartPos = `${family}_${bar.pos.endsWith('_TOP') ? 'BOTTOM' : 'TOP'}`;
  const counterpart = section.bars.find((entry) => entry.pos === counterpartPos);
  if (!counterpart) return null;

  if (bar.pos.endsWith('_TOP')) {
    if (!Number.isFinite(section.coverBottomMm)) return null;
    return bottomZ + section.coverBottomMm + counterpart.diaMm / 2;
  }
  if (!Number.isFinite(section.coverTopMm)) return null;
  return topZ - section.coverTopMm - counterpart.diaMm / 2;
}

function buildBarPath({
  footing,
  section,
  bar,
  crossCoordinate,
  bottomZ,
  topZ,
  center,
  angleRad,
  index,
}) {
  const inset = section.coverSideMm + bar.diaMm / 2;
  const insetPolygon = insetConvexPolygon(planPolygon(section.shape), inset);
  const runAxis = bar.pos.startsWith('X_') ? 'x' : 'y';
  const segment = insetPolygon ? clipAxisLine(insetPolygon, runAxis, crossCoordinate) : null;
  if (!segment) return null;

  const isTop = bar.pos.endsWith('_TOP');
  const barZ = isTop
    ? topZ - section.coverTopMm - bar.diaMm / 2
    : bottomZ + section.coverBottomMm + bar.diaMm / 2;
  if (!Number.isFinite(barZ) || !(barZ > bottomZ) || !(barZ < topZ)) return null;

  const localStart =
    runAxis === 'x'
      ? { x: segment.min, y: crossCoordinate, z: barZ }
      : { x: crossCoordinate, y: segment.min, z: barZ };
  const localEnd =
    runAxis === 'x'
      ? { x: segment.max, y: crossCoordinate, z: barZ }
      : { x: crossCoordinate, y: segment.max, z: barZ };
  const start = rotatePoint(localStart, center, angleRad);
  const end = rotatePoint(localEnd, center, angleRad);
  const primitives = [];

  const targetZ = verticalTargetZ(bar, section, bottomZ, topZ, barZ);
  if (bar.isVertical) {
    if (!Number.isFinite(targetZ) || targetZ <= bottomZ || targetZ >= topZ) return null;
    const startVertical = { ...start, z: targetZ };
    const endVertical = { ...end, z: targetZ };
    primitives.push(createLine(startVertical, start));
    primitives.push(createLine(start, end));
    primitives.push(createLine(end, endVertical));
  } else {
    primitives.push(createLine(start, end));
  }

  return createRebarPath(primitives, {
    coordinateSpace: 'world',
    dia: bar.diaMm,
    designation: bar.designation,
    strength: bar.strength,
    memberType: 'footing',
    memberId: footing.id,
    memberName: footing.name,
    sectionId: footing.sectionId,
    position: bar.pos,
    barIndex: index,
    isVertical: bar.isVertical,
    lengthVerticalMm: bar.lengthVerticalMm,
    source: 'STB_EXPLICIT',
    referencePointBasis: 'STB_FOOTING_CENTROID',
    rotationBasis: 'MATCH_EXISTING_FOOTING_GENERATOR',
    layerOrderResolved: false,
  });
}

function buildDirectedBarPath({
  footing,
  section,
  bar,
  runDirection,
  crossCoordinate,
  bottomZ,
  topZ,
  center,
  angleRad,
  index,
  directionBasis,
}) {
  const inset = section.coverSideMm + bar.diaMm / 2;
  const insetPolygon = insetConvexPolygon(planPolygon(section.shape), inset);
  const segment = insetPolygon
    ? clipDirectedLine(insetPolygon, runDirection, crossCoordinate)
    : null;
  if (!segment) return null;

  const isTop = bar.pos.endsWith('_TOP');
  const barZ = isTop
    ? topZ - section.coverTopMm - bar.diaMm / 2
    : bottomZ + section.coverBottomMm + bar.diaMm / 2;
  if (!Number.isFinite(barZ) || !(barZ > bottomZ) || !(barZ < topZ)) return null;

  const start = rotatePoint({ ...segment.start, z: barZ }, center, angleRad);
  const end = rotatePoint({ ...segment.end, z: barZ }, center, angleRad);
  const primitives = [];
  const targetZ = verticalTargetZ(bar, section, bottomZ, topZ, barZ);
  if (bar.isVertical) {
    if (!Number.isFinite(targetZ) || targetZ <= bottomZ || targetZ >= topZ) return null;
    primitives.push(createLine({ ...start, z: targetZ }, start));
    primitives.push(createLine(start, end));
    primitives.push(createLine(end, { ...end, z: targetZ }));
  } else {
    primitives.push(createLine(start, end));
  }

  return createRebarPath(primitives, {
    coordinateSpace: 'world',
    dia: bar.diaMm,
    designation: bar.designation,
    strength: bar.strength,
    memberType: 'footing',
    memberId: footing.id,
    memberName: footing.name,
    sectionId: footing.sectionId,
    position: bar.pos,
    barIndex: index,
    isVertical: bar.isVertical,
    lengthVerticalMm: bar.lengthVerticalMm,
    source: 'STB_EXPLICIT',
    referencePointBasis: 'STB_FOOTING_CENTROID',
    rotationBasis: 'MATCH_EXISTING_FOOTING_GENERATOR',
    layerOrderResolved: false,
    planDistributionBasis: 'INTERIOR_N_PLUS_ONE',
    planDistributionSource: 'STB_N_PLUS_SPEC_FIGURE',
    directionBasis,
  });
}

function buildTrianglePlanPaths({ footing, section, bottomZ, topZ, center, angleRad }) {
  const directions = triangleRunDirections(section.shape);
  if (!directions) return null;
  const paths = [];

  for (const bar of section.bars.filter((entry) => TRIANGLE_PLAN_BAR_POSITIONS.has(entry.pos))) {
    const runDirection = bar.pos.startsWith('MAIN_') ? directions.main : directions.transverse;
    const directionBasis = bar.pos.startsWith('MAIN_')
      ? 'PARALLEL_TO_TRIANGLE_DIAGONAL'
      : 'PERPENDICULAR_TO_TRIANGLE_DIAGONAL';
    const inset = section.coverSideMm + bar.diaMm / 2;
    const insetPolygon = insetConvexPolygon(planPolygon(section.shape), inset);
    if (!insetPolygon) return null;
    const crossDirection = perpendicular2(runDirection);
    const bounds = projectionBounds(insetPolygon, crossDirection);
    const coordinates = evenlySpacedInterior(bar.count, bounds.min, bounds.max);
    if (coordinates.length !== bar.count) return null;

    for (let index = 0; index < coordinates.length; index += 1) {
      const path = buildDirectedBarPath({
        footing,
        section,
        bar,
        runDirection,
        crossCoordinate: coordinates[index],
        bottomZ,
        topZ,
        center,
        angleRad,
        index,
        directionBasis,
      });
      if (!path) return null;
      paths.push(path);
    }
  }
  return paths;
}

function buildThreeWayMainPaths({ footing, section, bottomZ, topZ, center, angleRad }) {
  const directions = threeWayRunDirections(section.shape);
  if (!directions) return null;
  const paths = [];

  for (const bar of section.bars.filter((entry) => THREE_WAY_PLAN_BAR_POSITIONS.has(entry.pos))) {
    for (let directionIndex = 0; directionIndex < directions.length; directionIndex += 1) {
      const runDirection = directions[directionIndex];
      const inset = section.coverSideMm + bar.diaMm / 2;
      const insetPolygon = insetConvexPolygon(planPolygon(section.shape), inset);
      if (!insetPolygon) return null;
      const crossDirection = perpendicular2(runDirection);
      const bounds = projectionBounds(insetPolygon, crossDirection);
      const coordinates = evenlySpacedInterior(bar.count, bounds.min, bounds.max);
      if (coordinates.length !== bar.count) return null;

      for (let index = 0; index < coordinates.length; index += 1) {
        const path = buildDirectedBarPath({
          footing,
          section,
          bar,
          runDirection,
          crossCoordinate: coordinates[index],
          bottomZ,
          topZ,
          center,
          angleRad,
          index,
          directionBasis: 'THREE_WAY_MAIN_0_60_120_DEG',
        });
        if (!path) return null;
        path.metadata.directionIndex = directionIndex;
        path.metadata.directionCount = 3;
        paths.push(path);
      }
    }
  }
  return paths;
}

function buildHorizontalPaths({ footing, section, bar, bottomZ, topZ, center, angleRad }) {
  const inset = section.coverSideMm + bar.diaMm / 2;
  const insetPolygon = insetConvexPolygon(planPolygon(section.shape), inset);
  if (!insetPolygon || !Number.isFinite(section.coverTopMm)) return null;

  const minZ = bottomZ + section.coverBottomMm + bar.diaMm / 2;
  const maxZ = topZ - section.coverTopMm - bar.diaMm / 2;
  const levels = evenlySpaced(bar.count, minZ, maxZ);
  if (levels.length !== bar.count || levels.some((z) => !(z > bottomZ && z < topZ))) return null;

  return levels.map((z, index) => {
    const world = insetPolygon.map((point) => rotatePoint({ ...point, z }, center, angleRad));
    const primitives = world.map((point, vertexIndex) =>
      createLine(point, world[(vertexIndex + 1) % world.length]),
    );
    return createRebarPath(primitives, {
      coordinateSpace: 'world',
      dia: bar.diaMm,
      designation: bar.designation,
      strength: bar.strength,
      memberType: 'footing',
      memberId: footing.id,
      memberName: footing.name,
      sectionId: footing.sectionId,
      position: 'HORIZONTAL',
      barIndex: index,
      closedLoop: true,
      source: 'STB_EXPLICIT',
      referencePointBasis: 'STB_FOOTING_CENTROID',
      rotationBasis: 'MATCH_EXISTING_FOOTING_GENERATOR',
      verticalDistributionBasis: 'EVENLY_SPACED_BY_N',
      bendGeometryResolved: false,
    });
  });
}

function buildPathsForFooting(footing, section, node) {
  const bottomZ = node.z + footing.levelBottomMm;
  const topZ = bottomZ + section.shape.depthMm;
  const center = {
    x: node.x + footing.offsetXmm,
    y: node.y + footing.offsetYmm,
    z: 0,
  };
  const angleRad = (footing.rotateDeg * Math.PI) / 180;
  const paths = [];

  if (section.shape.type === 'TRIANGLE') {
    const trianglePaths = buildTrianglePlanPaths({
      footing,
      section,
      bottomZ,
      topZ,
      center,
      angleRad,
    });
    if (!trianglePaths) return null;
    paths.push(...trianglePaths);
  } else if (section.shape.type === 'EQUI_TRIANGLE') {
    const threeWayPaths = buildThreeWayMainPaths({
      footing,
      section,
      bottomZ,
      topZ,
      center,
      angleRad,
    });
    if (!threeWayPaths) return null;
    paths.push(...threeWayPaths);

    const outsidePaths = buildThreeWayOutsidePaths({
      footing,
      section,
      bottomZ,
      topZ,
      center,
      angleRad,
    });
    if (!outsidePaths) return null;
    paths.push(...outsidePaths);
  } else {
    for (const bar of section.bars.filter((entry) => RECT_PLAN_BAR_POSITIONS.has(entry.pos))) {
      const inset = section.coverSideMm + bar.diaMm / 2;
      const insetPolygon = insetConvexPolygon(planPolygon(section.shape), inset);
      if (!insetPolygon) return null;
      const crossAxis = bar.pos.startsWith('X_') ? 'y' : 'x';
      const bounds = axisBounds(insetPolygon, crossAxis);
      const coordinates = evenlySpaced(bar.count, bounds.min, bounds.max);
      if (coordinates.length !== bar.count) return null;
      for (let index = 0; index < coordinates.length; index += 1) {
        const path = buildBarPath({
          footing,
          section,
          bar,
          crossCoordinate: coordinates[index],
          bottomZ,
          topZ,
          center,
          angleRad,
          index,
        });
        if (!path) return null;
        paths.push(path);
      }
    }
  }

  const horizontal = section.bars.find((entry) => entry.pos === 'HORIZONTAL');
  if (horizontal) {
    const horizontalPaths = buildHorizontalPaths({
      footing,
      section,
      bar: horizontal,
      bottomZ,
      topZ,
      center,
      angleRad,
    });
    if (!horizontalPaths) return null;
    paths.push(...horizontalPaths);
  }
  return paths;
}

export function buildFoundationRebarRenderPlan(xmlDoc) {
  const plan = { paths: [], checks: [], readyCount: 0, specialCount: 0 };
  if (!xmlDoc) return plan;

  const nodes = readFoundationNodeMap(xmlDoc);
  const sections = parseFoundationSectionMap(xmlDoc);
  for (const element of Array.from(xmlDoc.getElementsByTagName('StbFooting') || [])) {
    const footing = {
      id: String(element.getAttribute('id') || ''),
      name: element.getAttribute('name') || '',
      nodeId: String(element.getAttribute('id_node') || ''),
      sectionId: String(element.getAttribute('id_section') || ''),
      offsetXmm: numberAttr(element, 'offset_X') || 0,
      offsetYmm: numberAttr(element, 'offset_Y') || 0,
      levelBottomMm: numberAttr(element, 'level_bottom') || 0,
      rotateDeg: numberAttr(element, 'rotate') || 0,
    };
    const section = sections.get(footing.sectionId);
    if (!section || !section.hasAnyBars) continue;

    if (!SUPPORTED_PLAN_SHAPES.has(section.shape.type)) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_SHAPE_UNSUPPORTED',
          'R13では矩形・八角形・直角三角形・正三角形の独立基礎のみ自動配置します。',
          { shapeType: section.shape.type },
        ),
      );
      plan.specialCount += 1;
      continue;
    }
    const expectedBarType =
      section.shape.type === 'TRIANGLE'
        ? 'TRIANGLE'
        : section.shape.type === 'EQUI_TRIANGLE'
          ? 'THREE_WAY'
          : 'RECT';
    if (section.hasUnsupportedBarType || section.barType !== expectedBarType) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_BAR_TYPE_UNSUPPORTED',
          `基礎形状${section.shape.type}に対応する${expectedBarType}配筋以外が指定されているため、自動配置しません。`,
          { barType: section.barType, expectedBarType },
        ),
      );
      plan.specialCount += 1;
      continue;
    }
    if (section.invalidBarCount > 0) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_BAR_DATA_INVALID',
          '径または本数を有効な基礎配筋として解決できない要素が含まれています。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }
    const positions = new Set(section.bars.map((bar) => bar.pos));
    if (positions.size !== section.bars.length) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_DUPLICATE_BAR_POSITION',
          'ST-Bridge仕様上1回のみの配筋位置が重複しているため、自動配置しません。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }
    const triangle = section.shape.type === 'TRIANGLE';
    const threeWay = section.shape.type === 'EQUI_TRIANGLE';
    const supportedPositions = triangle
      ? TRIANGLE_SUPPORTED_POSITIONS
      : threeWay
        ? THREE_WAY_SUPPORTED_POSITIONS
        : RECT_SUPPORTED_POSITIONS;
    if (![...positions].every((pos) => supportedPositions.has(pos))) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_BAR_POSITION_UNSUPPORTED',
          triangle
            ? '直角三角形基礎のMAIN/TRANSVERSE上端・下端・HORIZONTAL以外は自動配置しません。'
            : threeWay
              ? '正三角形基礎のMAIN/OUTSIDE上端・下端・HORIZONTAL以外は自動配置しません。'
              : '矩形・八角形基礎のX/Y上端・下端・HORIZONTAL以外は自動配置しません。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    if (threeWay) {
      const outsideValidation = validateThreeWayOutsideBars(section);
      if (outsideValidation.status !== 'READY') {
        plan.checks.push(
          makeCheck(
            footing,
            'SPECIAL_REQUIRED',
            outsideValidation.code,
            outsideValidation.message,
            {
              shapeType: section.shape.type,
              barType: section.barType,
              position: outsideValidation.position || null,
              count: outsideValidation.count ?? null,
            },
          ),
        );
        plan.specialCount += 1;
        continue;
      }
    }

    const planPositions = new Set([...positions].filter((pos) => pos !== 'HORIZONTAL'));
    const threeWayMainOnly =
      threeWay &&
      (sameSet(planPositions, THREE_WAY_MAIN_BOTTOM_ONLY) ||
        sameSet(planPositions, THREE_WAY_MAIN_CAGE));
    const threeWaySpecComplete =
      threeWay &&
      (sameSet(planPositions, THREE_WAY_BOTTOM_ONLY) ||
        sameSet(planPositions, THREE_WAY_FULL_CAGE));
    const bottomOnly = triangle ? TRIANGLE_BOTTOM_ONLY : RECT_BOTTOM_ONLY;
    const fullCage = triangle ? TRIANGLE_FULL_CAGE : RECT_FULL_CAGE;
    const validCombination = threeWay
      ? threeWayMainOnly || threeWaySpecComplete
      : sameSet(planPositions, bottomOnly) || sameSet(planPositions, fullCage);

    if (!validCombination) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_PARTIAL_CAGE_INVALID',
          threeWay
            ? '正三角形ThreeWayはMAINのみのproducer互換表示、または仕様書どおりMAIN+OUTSIDEの下端/上下完全組合せだけを3D化します。'
            : 'ST-Bridge仕様上の下端2方向または上下4方向の完全な組合せのみ3D化します。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    const needsTop =
      [...planPositions].some((pos) => pos.endsWith('_TOP')) || positions.has('HORIZONTAL');
    if (
      !Number.isFinite(section.coverBottomMm) ||
      !Number.isFinite(section.coverSideMm) ||
      (needsTop && !Number.isFinite(section.coverTopMm))
    ) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_COVER_MISSING',
          '必要な上/下/側面かぶりをST-Bridge断面または旧共通適用値から取得できません。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    const node = nodes.get(footing.nodeId);
    if (!node) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_NODE_MISSING',
          '基礎節点を取得できません。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    const paths = buildPathsForFooting(footing, section, node);
    if (!paths?.length) {
      plan.checks.push(
        makeCheck(
          footing,
          'SPECIAL_REQUIRED',
          'FOUNDATION_GEOMETRY_UNRESOLVED',
          'かぶり・本数・立上り/立下りから有効な鉄筋中心線を構築できません。',
        ),
      );
      plan.specialCount += 1;
      continue;
    }

    plan.paths.push(...paths);
    const threeWayOutsideExplicit =
      threeWay && (positions.has('OUTSIDE_TOP') || positions.has('OUTSIDE_BOTTOM'));
    const readyCode =
      threeWay && !threeWayOutsideExplicit
        ? 'FOUNDATION_REBAR_READY_SOURCE_PARTIAL'
        : 'FOUNDATION_REBAR_READY';
    const readyMessage =
      threeWay && !threeWayOutsideExplicit
        ? 'ThreeWayの明示MAIN配筋のみを3D化しました。仕様上のOUTSIDE配筋は入力に存在しないため補完していません。'
        : 'ST-Bridge明示配筋から3D化しました。';
    plan.checks.push(
      makeCheck(footing, 'READY', readyCode, readyMessage, {
        barPathCount: paths.length,
        shapeType: section.shape.type,
        horizontalDistributionBasis: positions.has('HORIZONTAL') ? 'EVENLY_SPACED_BY_N' : null,
        planDistributionBasis: triangle || threeWay ? 'INTERIOR_N_PLUS_ONE' : null,
        planDistributionSource: triangle || threeWay ? 'STB_N_PLUS_SPEC_FIGURE' : null,
        directionBasis: triangle
          ? 'MAIN_PARALLEL_DIAGONAL_TRANSVERSE_PERPENDICULAR'
          : threeWay
            ? 'THREE_WAY_MAIN_0_60_120_DEG'
            : null,
        outsidePlacementBasis: threeWayOutsideExplicit
          ? 'STB_THREEWAY_SINGLE_PERIMETER_AT_SIDE_COVER'
          : null,
        specContractComplete: threeWay ? threeWayOutsideExplicit : true,
        sourceCompleteness: threeWay
          ? threeWayOutsideExplicit
            ? 'COMPLETE_FOR_SUPPORTED_THREEWAY_N_EQ_1'
            : 'EXPLICIT_MAIN_ONLY'
          : 'COMPLETE_FOR_SUPPORTED_POSITIONS',
        warningCode:
          threeWay && !threeWayOutsideExplicit ? 'FOUNDATION_THREEWAY_OUTSIDE_OMITTED' : null,
        referencePointBasis: 'STB_FOOTING_CENTROID',
        rotationBasis: 'MATCH_EXISTING_FOOTING_GENERATOR',
      }),
    );
    plan.readyCount += 1;
  }
  return plan;
}

export const _foundationRebarPlacementInternals = Object.freeze({
  evenlySpaced,
  evenlySpacedInterior,
  rotatePoint,
  planPolygon,
  insetConvexPolygon,
  clipAxisLine,
  clipDirectedLine,
  triangleRunDirections,
  threeWayRunDirections,
  buildThreeWayMainPaths,
  buildHorizontalPaths,
  validateThreeWayOutsideBars,
  buildThreeWayOutsidePaths,
});
