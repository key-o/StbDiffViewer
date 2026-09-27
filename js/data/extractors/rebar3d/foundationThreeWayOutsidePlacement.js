/**
 * @fileoverview RC独立基礎 ThreeWay の OUTSIDE_TOP / OUTSIDE_BOTTOM first slice。
 *
 * ST-Bridge 2.1 6.18.2.3 の仕様図では OUTSIDE は外周筋として示され、属性 N は必須だが、
 * N>1 の複数本について平面内の間隔・各ループ位置を決める追加寸法は定義されていない。
 * そのため、このモジュールは N=1 のときだけ、側面かぶり位置の単一閉鎖外周筋として解決する。
 * OUTSIDE の isVertical は折曲げ位置を一意化できないため推定しない。
 */

import { createLine, createRebarPath } from './rebarPath.js';
import { insetConvexPolygon, planPolygon, rotatePoint } from './foundationRebarGeometry.js';
import { validateThreeWayOutsideBars } from './foundationThreeWayOutsideContract.js';

export { validateThreeWayOutsideBars } from './foundationThreeWayOutsideContract.js';

export function buildThreeWayOutsidePaths({ footing, section, bottomZ, topZ, center, angleRad }) {
  const validation = validateThreeWayOutsideBars(section);
  if (validation.status !== 'READY') return null;
  const paths = [];

  for (const bar of validation.bars) {
    const inset = section.coverSideMm + bar.diaMm / 2;
    const insetPolygon = insetConvexPolygon(planPolygon(section.shape), inset);
    if (!insetPolygon) return null;

    const isTop = bar.pos === 'OUTSIDE_TOP';
    const barZ = isTop
      ? topZ - section.coverTopMm - bar.diaMm / 2
      : bottomZ + section.coverBottomMm + bar.diaMm / 2;
    if (!Number.isFinite(barZ) || !(barZ > bottomZ) || !(barZ < topZ)) return null;

    const world = insetPolygon.map((point) => rotatePoint({ ...point, z: barZ }, center, angleRad));
    const primitives = world.map((point, vertexIndex) =>
      createLine(point, world[(vertexIndex + 1) % world.length]),
    );
    if (!primitives.length) return null;

    paths.push(
      createRebarPath(primitives, {
        coordinateSpace: 'world',
        dia: bar.diaMm,
        designation: bar.designation,
        strength: bar.strength,
        memberType: 'footing',
        memberId: footing.id,
        memberName: footing.name,
        sectionId: footing.sectionId,
        position: bar.pos,
        barIndex: 0,
        stbCount: bar.count,
        closedLoop: true,
        source: 'STB_EXPLICIT',
        referencePointBasis: 'STB_FOOTING_CENTROID',
        rotationBasis: 'MATCH_EXISTING_FOOTING_GENERATOR',
        outsidePlacementBasis: 'STB_THREEWAY_SINGLE_PERIMETER_AT_SIDE_COVER',
        planDistributionBasis: 'SINGLE_EXPLICIT_OUTSIDE_LOOP_N_EQ_1',
        bendGeometryResolved: false,
        isVertical: false,
        lengthVerticalMm: null,
      }),
    );
  }

  return paths;
}
