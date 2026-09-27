/**
 * @fileoverview RC場所打ち杭の3D配筋メッシュ生成。
 *
 * ST-Bridge 2.0.2 の杭断面配筋（第1周主筋、帯筋、スパイラル、
 * TOP/CENTER/BOTTOM の配筋長さ・重ね継手長さ）を、StbPile の実長さと
 * 拡頭/拡底形状へ載せる。杭固有の未定義寸法は推定しない。
 */

import * as THREE from 'three';
import { calculateColumnPlacement } from '../core/GeometryCalculator.js';
import {
  HOOP_RENDER_OPTIONS,
  REBAR_RENDER_OPTIONS,
} from '../../../constants/rebarPlacementRules.js';
import { createLogger } from '../../../utils/logger.js';

const log = createLogger('viewer:pileRebar');
const Z_AXIS = new THREE.Vector3(0, 0, 1);

let unitBarGeometry = null;
let sharedMainMaterial = null;
let sharedBandMaterial = null;
const torusGeometries = new Map();

function getUnitBarGeometry() {
  if (!unitBarGeometry) {
    unitBarGeometry = new THREE.CylinderGeometry(
      0.5,
      0.5,
      1,
      REBAR_RENDER_OPTIONS.radialSegments,
      1,
      false,
    );
    unitBarGeometry.rotateX(Math.PI / 2);
  }
  return unitBarGeometry;
}

function getMainMaterial() {
  if (!sharedMainMaterial) {
    sharedMainMaterial = new THREE.MeshLambertMaterial({ color: REBAR_RENDER_OPTIONS.colorHex });
  }
  return sharedMainMaterial;
}

function getBandMaterial() {
  if (!sharedBandMaterial) {
    sharedBandMaterial = new THREE.MeshLambertMaterial({ color: HOOP_RENDER_OPTIONS.colorHex });
  }
  return sharedBandMaterial;
}

function getTorusGeometry(radius, diaMm) {
  const roundedRadius = Math.round(radius * 1000) / 1000;
  const key = `${roundedRadius}|${diaMm}`;
  if (!torusGeometries.has(key)) {
    torusGeometries.set(
      key,
      new THREE.TorusGeometry(
        roundedRadius,
        diaMm / 2,
        HOOP_RENDER_OPTIONS.radialSegments,
        HOOP_RENDER_OPTIONS.tubularSegments,
      ),
    );
  }
  return torusGeometries.get(key);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolvePilePlacement(pile, nodes) {
  const rollAngle = ((finite(pile.rotate) || 0) * Math.PI) / 180;

  if (pile.pileFormat === '1node') {
    const node = nodes?.get(String(pile.id_node));
    const length = finite(pile.length_all);
    if (!node || !(length > 0)) return null;

    const top = {
      x: node.x + (finite(pile.offset_X) || 0),
      y: node.y + (finite(pile.offset_Y) || 0),
      z: node.z + (finite(pile.level_top) || 0),
    };
    const bottom = { x: top.x, y: top.y, z: top.z - length };
    return calculateColumnPlacement(bottom, top, { rollAngle });
  }

  const bottom = nodes?.get(String(pile.id_node_bottom));
  const top = nodes?.get(String(pile.id_node_top));
  if (!bottom || !top) return null;
  return calculateColumnPlacement(bottom, top, {
    bottomOffset: {
      x: finite(pile.offset_bottom_X) || 0,
      y: finite(pile.offset_bottom_Y) || 0,
      z: finite(pile.offset_bottom_Z) || 0,
    },
    topOffset: {
      x: finite(pile.offset_top_X) || 0,
      y: finite(pile.offset_top_Y) || 0,
      z: finite(pile.offset_top_Z) || 0,
    },
    rollAngle,
  });
}

function memberMatrix(placement) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(placement.center.x, placement.center.y, placement.center.z),
    new THREE.Quaternion(
      placement.rotation.x,
      placement.rotation.y,
      placement.rotation.z,
      placement.rotation.w,
    ),
    new THREE.Vector3(1, 1, 1),
  );
}

function taperLength(largeDiameter, smallDiameter, angleDeg) {
  const large = finite(largeDiameter);
  const small = finite(smallDiameter);
  const angle = finite(angleDeg);
  if (!(large > small) || !(angle > 0 && angle < 90)) return 0;
  return (large - small) / 2 / Math.tan((angle * Math.PI) / 180);
}

function geometryFacts(spec, pile, length) {
  const geometry = spec.geometry || {};
  const axial = finite(geometry.D_axial) || finite(geometry.D) || 0;
  const top = finite(geometry.D_extended_top) || axial;
  const foot = finite(geometry.D_extended_foot) || axial;

  const nominalTopTaper = taperLength(top, axial, geometry.angle_extended_top_taper);
  const suppliedHeadLength = finite(pile.length_head);
  const topTotal = geometry.type.includes('ExtendedTop')
    ? Math.min(length, Math.max(0, suppliedHeadLength ?? nominalTopTaper))
    : 0;
  const topTaper = Math.min(topTotal, nominalTopTaper || topTotal);
  const topStraightEnd = Math.max(0, topTotal - topTaper);

  const footStraight = geometry.type.includes('Foot')
    ? Math.min(length, Math.max(0, finite(geometry.length_extended_foot) || 0))
    : 0;
  const nominalFootTaper = taperLength(foot, axial, geometry.angle_extended_foot_taper);
  const footTaper = Math.min(Math.max(0, length - topTotal - footStraight), nominalFootTaper);
  const footStraightStart = Math.max(topTotal, length - footStraight);
  const footTaperStart = Math.max(topTotal, footStraightStart - footTaper);

  return {
    axialDiameter: axial,
    topDiameter: top,
    footDiameter: foot,
    topTotal,
    topStraightEnd,
    footTaperStart,
    footStraightStart,
  };
}

function surfaceDiameterAtDepth(facts, depth) {
  const d = Math.max(0, depth);
  if (facts.topTotal > 0 && d < facts.topTotal) {
    if (d <= facts.topStraightEnd || facts.topTotal === facts.topStraightEnd) {
      return facts.topDiameter;
    }
    const t = (d - facts.topStraightEnd) / (facts.topTotal - facts.topStraightEnd);
    return facts.topDiameter + (facts.axialDiameter - facts.topDiameter) * t;
  }

  if (d > facts.footTaperStart) {
    if (d >= facts.footStraightStart || facts.footStraightStart === facts.footTaperStart) {
      return facts.footDiameter;
    }
    const t = (d - facts.footTaperStart) / (facts.footStraightStart - facts.footTaperStart);
    return facts.axialDiameter + (facts.footDiameter - facts.axialDiameter) * t;
  }
  return facts.axialDiameter;
}

function coverAtDepth(spec, facts, depth) {
  if (facts.topTotal > 0 && depth < facts.topTotal) return spec.coverTopMm;
  return spec.coverMm;
}

function zoneDepths(spec, length) {
  if (spec.mode === 'SAME') {
    return [{ zone: spec.zones[0], start: 0, end: length, index: 0 }];
  }

  const entries = [];
  let cursor = 0;
  for (let index = 0; index < spec.zones.length; index++) {
    const zone = spec.zones[index];
    const zoneLength = finite(zone.lengthBarMm);
    if (!(zoneLength > 0)) return [];
    const start = cursor;
    const end = Math.min(length, cursor + zoneLength);
    if (end > start) entries.push({ zone, start, end, index });
    cursor += zoneLength;
    if (cursor >= length) break;
  }
  return entries;
}

function breakDepths(facts, start, end) {
  const values = [start, end];
  for (const value of [
    facts.topStraightEnd,
    facts.topTotal,
    facts.footTaperStart,
    facts.footStraightStart,
  ]) {
    if (value > start && value < end) values.push(value);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function mainRadiusAtDepth(spec, facts, zone, depth) {
  const diameter = surfaceDiameterAtDepth(facts, depth);
  const cover = coverAtDepth(spec, facts, depth);
  const radius = diameter / 2 - cover - zone.band.outerMm - zone.main1.outerMm / 2;
  return radius > 0 ? radius : null;
}

function bandRadiusAtDepth(spec, facts, zone, depth) {
  const diameter = surfaceDiameterAtDepth(facts, depth);
  const cover = coverAtDepth(spec, facts, depth);
  const radius = diameter / 2 - cover - zone.band.outerMm / 2;
  return radius > 0 ? radius : null;
}

function localPoint(radius, angle, depth, length) {
  return new THREE.Vector3(radius * Math.cos(angle), radius * Math.sin(angle), length / 2 - depth);
}

function pushCylinderMatrix(matricesByDia, dia, p0, p1, memberTransform) {
  const direction = p1.clone().sub(p0);
  const segmentLength = direction.length();
  if (!(segmentLength > 1e-6)) return false;
  direction.multiplyScalar(1 / segmentLength);
  const quaternion = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, direction);
  const local = new THREE.Matrix4().compose(
    p0.clone().add(p1).multiplyScalar(0.5),
    quaternion,
    new THREE.Vector3(dia, dia, segmentLength),
  );
  const world = new THREE.Matrix4().multiplyMatrices(memberTransform, local);
  const list = matricesByDia.get(dia);
  if (list) list.push(world);
  else matricesByDia.set(dia, [world]);
  return true;
}

function createInstancedMesh(geometry, material, matrices, userData) {
  const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
  matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.raycast = () => {};
  mesh.userData = { isRebar: true, ...userData };
  return mesh;
}

function buildMainMeshes(matricesByDia, options) {
  return [...matricesByDia].map(([dia, matrices]) =>
    createInstancedMesh(getUnitBarGeometry(), options.material || getMainMaterial(), matrices, {
      rebarKind: 'pileMain',
      barDiameterMm: dia,
      modelSource: options.modelSource || null,
      sourceRule: 'ST-Bridge pile reinforcement',
    }),
  );
}

/**
 * RC場所打ち杭の第1周主筋を生成する。
 * 2段目・芯筋はST-Bridgeに半径位置が無いため、この関数では生成しない。
 */
export function createPileMainRebarMeshes(pileElements, nodes, sectionMap, options = {}) {
  if (!pileElements?.length || !nodes?.size || !sectionMap?.size) return [];

  const matricesByDia = new Map();
  let segmentCount = 0;
  const maxSegments = REBAR_RENDER_OPTIONS.maxBarsPerModel * 6;
  const warned = new Set();

  for (const pile of pileElements) {
    if (String(pile.kind_structure || 'RC').toUpperCase() !== 'RC') continue;
    const spec = sectionMap.get(String(pile.id_section));
    if (!spec) continue;
    const placement = resolvePilePlacement(pile, nodes);
    if (!placement || !(placement.length > 0)) continue;
    const zones = zoneDepths(spec, placement.length);
    if (!zones.length) {
      log.warn(
        `[Render] 杭${pile.id}: TOP/CENTER/BOTTOM の length_bar が不足しているため主筋を配置しません`,
      );
      continue;
    }

    if (spec.unresolved?.length && !warned.has(spec.sectionId)) {
      warned.add(spec.sectionId);
      for (const item of spec.unresolved)
        log.warn(`[Render] 杭断面${spec.sectionId}: ${item.message}`);
    }

    const facts = geometryFacts(spec, pile, placement.length);
    const transform = memberMatrix(placement);

    for (const { zone, start, end, index } of zones) {
      const lap = index < zones.length - 1 ? Math.max(0, finite(zone.lapLengthMm) || 0) : 0;
      const barEnd = Math.min(placement.length, end + lap);
      const depths = breakDepths(facts, start, barEnd);
      const count = zone.main1.count;
      for (let barIndex = 0; barIndex < count; barIndex++) {
        const angle = (2 * Math.PI * barIndex) / count;
        for (let i = 0; i < depths.length - 1; i++) {
          const d0 = depths[i];
          const d1 = depths[i + 1];
          const r0 = mainRadiusAtDepth(spec, facts, zone, d0);
          const r1 = mainRadiusAtDepth(spec, facts, zone, d1);
          if (!(r0 > 0 && r1 > 0)) continue;
          if (
            pushCylinderMatrix(
              matricesByDia,
              zone.main1.diaMm,
              localPoint(r0, angle, d0, placement.length),
              localPoint(r1, angle, d1, placement.length),
              transform,
            )
          ) {
            segmentCount++;
          }
          if (segmentCount >= maxSegments) break;
        }
        if (segmentCount >= maxSegments) break;
      }
      if (segmentCount >= maxSegments) break;
    }
    if (segmentCount >= maxSegments) break;
  }

  if (segmentCount >= maxSegments) {
    log.warn(`[Render] 杭主筋の線分数が上限（${maxSegments}）に達したため打ち切りました`);
  }
  const meshes = buildMainMeshes(matricesByDia, options);
  if (meshes.length)
    log.info(`[Render] 杭主筋を生成しました: ${segmentCount}線分 / ${meshes.length}メッシュ`);
  return meshes;
}

function spreadRingDepths(start, end, pitch) {
  const length = end - start;
  if (!(length > 0 && pitch > 0)) return [];
  const count = Math.max(1, Math.floor(length / pitch));
  const spread = (count - 1) * pitch;
  const first = start + (length - spread) / 2;
  return Array.from({ length: count }, (_, index) => first + index * pitch);
}

function buildRingMeshes(circleGroups, options) {
  const meshes = [];
  for (const entry of circleGroups.values()) {
    meshes.push(
      createInstancedMesh(entry.geometry, options.material || getBandMaterial(), entry.matrices, {
        rebarKind: 'pileBand',
        barDiameterMm: entry.dia,
        modelSource: options.modelSource || null,
        placementEstimated: true,
        placementNote: 'ST-Bridgeは帯筋の先頭位相を規定しないため、区間内で中央割付',
      }),
    );
  }
  return meshes;
}

function addRing(circleGroups, transform, radius, dia, depth, length) {
  const local = new THREE.Matrix4().makeTranslation(0, 0, length / 2 - depth);
  const world = new THREE.Matrix4().multiplyMatrices(transform, local);
  const key = `${Math.round(radius * 1000) / 1000}|${dia}`;
  const existing = circleGroups.get(key);
  if (existing) {
    existing.matrices.push(world);
  } else {
    circleGroups.set(key, {
      dia,
      geometry: getTorusGeometry(radius, dia),
      matrices: [world],
    });
  }
}

function createSpiralMesh({
  spec,
  facts,
  zone,
  start,
  end,
  placement,
  transform,
  phaseStart,
  options,
}) {
  const pitch = zone.band.pitchMm;
  const turns = (end - start) / pitch;
  if (!(turns > 0)) return null;
  const tubularSegments = Math.min(4000, Math.max(24, Math.ceil(turns * 12)));

  class SpiralCurve extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      const depth = start + (end - start) * t;
      const radius = bandRadiusAtDepth(spec, facts, zone, depth);
      if (!(radius > 0)) return target.set(0, 0, 0).applyMatrix4(transform);
      const angle = phaseStart + (2 * Math.PI * (depth - start)) / pitch;
      return target
        .copy(localPoint(radius, angle, depth, placement.length))
        .applyMatrix4(transform);
    }
  }

  const geometry = new THREE.TubeGeometry(
    new SpiralCurve(),
    tubularSegments,
    zone.band.diaMm / 2,
    HOOP_RENDER_OPTIONS.radialSegments,
    false,
  );
  const mesh = new THREE.Mesh(geometry, options.material || getBandMaterial());
  mesh.raycast = () => {};
  mesh.userData = {
    isRebar: true,
    rebarKind: 'pileSpiral',
    barDiameterMm: zone.band.diaMm,
    pitchMm: pitch,
    modelSource: options.modelSource || null,
    placementEstimated: true,
    placementNote:
      'ST-Bridgeはスパイラルの始端位相・末端定着形状を規定しないため、位相のみ表示規約で設定',
  };
  mesh.dispose = () => geometry.dispose();
  return { mesh, phaseEnd: phaseStart + 2 * Math.PI * turns };
}

/**
 * RC場所打ち杭の帯筋/スパイラルを生成する。
 */
export function createPileBandMeshes(pileElements, nodes, sectionMap, options = {}) {
  if (!pileElements?.length || !nodes?.size || !sectionMap?.size) return [];

  const circles = new Map();
  const spirals = [];
  let ringCount = 0;
  let spiralCount = 0;
  const maxLoops = HOOP_RENDER_OPTIONS.maxBarsPerModel;

  for (const pile of pileElements) {
    if (String(pile.kind_structure || 'RC').toUpperCase() !== 'RC') continue;
    const spec = sectionMap.get(String(pile.id_section));
    if (!spec) continue;
    const placement = resolvePilePlacement(pile, nodes);
    if (!placement || !(placement.length > 0)) continue;
    const zones = zoneDepths(spec, placement.length);
    if (!zones.length) {
      log.warn(
        `[Render] 杭${pile.id}: TOP/CENTER/BOTTOM の length_bar が不足しているため帯筋を配置しません`,
      );
      continue;
    }

    const facts = geometryFacts(spec, pile, placement.length);
    const transform = memberMatrix(placement);
    let spiralPhase = 0;

    for (const { zone, start, end } of zones) {
      if (!(zone.band?.pitchMm > 0)) continue;
      if (spec.isSpiral) {
        const built = createSpiralMesh({
          spec,
          facts,
          zone,
          start,
          end,
          placement,
          transform,
          phaseStart: spiralPhase,
          options,
        });
        if (built) {
          spirals.push(built.mesh);
          spiralPhase = built.phaseEnd;
          spiralCount++;
        }
        continue;
      }

      for (const depth of spreadRingDepths(start, end, zone.band.pitchMm)) {
        const radius = bandRadiusAtDepth(spec, facts, zone, depth);
        if (!(radius > 0)) continue;
        addRing(circles, transform, radius, zone.band.diaMm, depth, placement.length);
        ringCount++;
        if (ringCount >= maxLoops) break;
      }
      if (ringCount >= maxLoops) break;
    }
    if (ringCount >= maxLoops) break;
  }

  if (ringCount >= maxLoops) {
    log.warn(`[Render] 杭帯筋の本数が上限（${maxLoops}）に達したため打ち切りました`);
  }
  const meshes = [...buildRingMeshes(circles, options), ...spirals];
  if (meshes.length) {
    log.info(
      `[Render] 杭帯筋を生成しました: 円形帯筋${ringCount}組 / スパイラル${spiralCount}区間`,
    );
  }
  return meshes;
}
