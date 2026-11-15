/**
 * @fileoverview RC壁×柱・壁×梁の取り合いを壁ごとの1件のoffset編集案へ統合する。
 * 壁の体積控除は変更前後の多角形面積差×壁厚で計算する。
 */

import {
  TOLERANCE_MM,
  tag,
  descendants,
  child,
  findById,
  numberAttribute,
  positive,
  near,
} from './memberJoinGeometry.js';

function wallVertices(wall, nodes) {
  const order = child(wall, 'StbNodeIdOrder');
  const nodeIds = order?.textContent?.trim().split(/\s+/).filter(Boolean) || [];
  if (nodeIds.length !== 4 || new Set(nodeIds).size !== 4) return null;
  const list = child(wall, 'StbWallOffsetList');
  const offsets = new Map(
    Array.from(list?.children || [])
      .filter((item) => tag(item) === 'StbWallOffset')
      .map((item) => [item.getAttribute('id_node'), item]),
  );
  return nodeIds.map((id) => {
    const node = nodes.get(id);
    if (!node) return null;
    const item = offsets.get(id);
    const offset = {};
    const point = {};
    for (const axis of ['X', 'Y', 'Z']) {
      const value = numberAttribute(item, `offset_${axis}`, 0);
      if (value === null) return null;
      offset[`offset_${axis}`] = value;
      point[axis.toLowerCase()] = node[axis.toLowerCase()] + value;
    }
    return { id, point, offset };
  });
}

function straightWallThickness(document, wall) {
  const section = findById(document, 'StbSecWall_RC', wall.getAttribute('id_section'));
  const figures = section ? descendants(section, 'StbSecFigureWall_RC') : [];
  if (figures.length !== 1) return null;
  const shapes = Array.from(figures[0].children || []).filter((item) =>
    tag(item).startsWith('StbSecWall_RC_'),
  );
  if (shapes.length !== 1 || tag(shapes[0]) !== 'StbSecWall_RC_Straight') return null;
  return numberAttribute(shapes[0], 't');
}

/** STB 2.0.xの開口参照とSTB 2.1.xのStbOpenArrangementを共通判定する。 */
function hasWallOpenings(document, wall) {
  const wallId = wall.getAttribute('id');
  if (
    child(wall, 'StbOpenIdList') ||
    wall.getAttribute('id_open') ||
    wall.getAttribute('id_opening')
  )
    return true;
  return ['StbOpen', 'StbOpenArrangement'].some((openingTag) =>
    descendants(document, openingTag).some(
      (opening) =>
        opening.getAttribute('id_member') === wallId &&
        String(opening.getAttribute('kind_member') || '').toUpperCase() === 'WALL',
    ),
  );
}

function proposeWallTopOffsets(document, nodes, beamList, warnings) {
  const proposals = [];
  for (const wall of descendants(document, 'StbWall')) {
    if (wall.getAttribute('kind_structure') !== 'RC') continue;
    if (!near(numberAttribute(wall, 'rotate', 0) ?? NaN, 0)) continue;
    // 開口は壁第1基準点を原点とするため、開口参照を含む壁は安全側で保留する。
    if (hasWallOpenings(document, wall)) {
      warnings.push(`StbWall:${wall.getAttribute('id')}: 開口を伴うため取り合い調整を保留`);
      continue;
    }
    const thickness = straightWallThickness(document, wall);
    const vertices = wallVertices(wall, nodes);
    if (!positive(thickness) || !vertices || vertices.some((vertex) => !vertex)) continue;
    const sorted = [...vertices].sort((a, b) => b.point.z - a.point.z);
    const top = sorted.slice(0, 2);
    const bottom = sorted.slice(2);
    // 壁第1節点が上端の場合、オフセットは開口座標系の原点も動かすため対象外。
    if (top.some((vertex) => vertex.id === vertices[0].id)) continue;
    if (
      !near(top[0].point.z, top[1].point.z) ||
      !near(bottom[0].point.z, bottom[1].point.z) ||
      top[0].point.z - bottom[0].point.z <= TOLERANCE_MM
    )
      continue;
    const axis =
      near(top[0].point.y, top[1].point.y) && !near(top[0].point.x, top[1].point.x)
        ? 'x'
        : near(top[0].point.x, top[1].point.x) && !near(top[0].point.y, top[1].point.y)
          ? 'y'
          : null;
    if (
      !axis ||
      !vertices.every((v) =>
        near(v.point[axis === 'x' ? 'y' : 'x'], top[0].point[axis === 'x' ? 'y' : 'x']),
      )
    )
      continue;
    const orth = axis === 'x' ? 'y' : 'x';
    const wallStart = Math.min(...top.map((v) => v.point[axis]));
    const wallEnd = Math.max(...top.map((v) => v.point[axis]));
    // 台形・ねじれなどは矩形の面積差分計算に適さないので自動変更しない。
    if (
      !near(Math.min(...bottom.map((v) => v.point[axis])), wallStart) ||
      !near(Math.max(...bottom.map((v) => v.point[axis])), wallEnd)
    )
      continue;
    const candidates = beamList.filter(
      (beam) =>
        beam.axis === axis &&
        Math.abs(beam.start[orth] - top[0].point[orth]) <=
          (beam.profile.width - thickness) / 2 + TOLERANCE_MM &&
        near(beam.start.z, top[0].point.z) &&
        Math.min(beam.baseStart[axis], beam.baseEnd[axis]) <= wallStart + TOLERANCE_MM &&
        Math.max(beam.baseStart[axis], beam.baseEnd[axis]) >= wallEnd - TOLERANCE_MM &&
        top[0].point.z - beam.profile.depth > bottom[0].point.z + TOLERANCE_MM,
    );
    if (candidates.length > 1) {
      warnings.push(`StbWall:${wall.getAttribute('id')}: 上端の梁が複数該当するため未処理`);
      continue;
    }
    if (candidates.length !== 1) continue;
    const beam = candidates[0];
    const targetZ = beam.start.z - beam.profile.depth;
    const offsets = {};
    for (const vertex of top) {
      if (vertex.point.z - targetZ <= TOLERANCE_MM) continue;
      offsets[vertex.id] = {
        ...vertex.offset,
        offset_Z: Math.round((vertex.offset.offset_Z - (vertex.point.z - targetZ)) * 1e6) / 1e6,
      };
    }
    if (Object.keys(offsets).length > 0) {
      proposals.push({
        kind: 'wall-beam-top',
        elementType: 'StbWall',
        elementId: wall.getAttribute('id'),
        offsets,
        beamId: beam.element.getAttribute('id'),
        beamType: beam.elementType,
        estimatedReductionMm3: (wallEnd - wallStart) * (top[0].point.z - targetZ) * thickness,
      });
    }
  }
  return proposals;
}

// 柱による壁端部の控除案。STB wall offsetは共有節点を変えない。
function proposeWallColumnOffsets(document, nodes, columnList, warnings) {
  const proposals = [];
  for (const wall of descendants(document, 'StbWall')) {
    if (wall.getAttribute('kind_structure') !== 'RC') continue;
    if (!near(numberAttribute(wall, 'rotate', 0) ?? NaN, 0)) continue;
    const wallId = wall.getAttribute('id');
    if (hasWallOpenings(document, wall)) continue;

    const thickness = straightWallThickness(document, wall);
    const vertices = wallVertices(wall, nodes);
    if (!positive(thickness) || !vertices || vertices.some((vertex) => !vertex)) continue;
    const ordered = [...vertices].sort((a, b) => b.point.z - a.point.z);
    const top = ordered.slice(0, 2);
    const bottom = ordered.slice(2);
    if (
      !near(top[0].point.z, top[1].point.z) ||
      !near(bottom[0].point.z, bottom[1].point.z) ||
      top[0].point.z - bottom[0].point.z <= TOLERANCE_MM
    )
      continue;
    const axis =
      near(top[0].point.y, top[1].point.y) && !near(top[0].point.x, top[1].point.x)
        ? 'x'
        : near(top[0].point.x, top[1].point.x) && !near(top[0].point.y, top[1].point.y)
          ? 'y'
          : null;
    if (!axis) continue;
    const orth = axis === 'x' ? 'y' : 'x';
    if (!vertices.every((v) => near(v.point[orth], vertices[0].point[orth]))) continue;

    const min = Math.min(top[0].point[axis], top[1].point[axis]);
    const max = Math.max(top[0].point[axis], top[1].point[axis]);
    if (
      !near(Math.min(...bottom.map((v) => v.point[axis])), min) ||
      !near(Math.max(...bottom.map((v) => v.point[axis])), max) ||
      max - min <= TOLERANCE_MM
    )
      continue;
    // 節点順が交差している矩形は見た目だけの外接矩形で補正しない。
    const orderedArea =
      Math.abs(
        vertices.reduce((sum, vertex, index) => {
          const next = vertices[(index + 1) % vertices.length];
          return sum + vertex.point[axis] * next.point.z - next.point[axis] * vertex.point.z;
        }, 0),
      ) / 2;
    const rectangularArea = (max - min) * (top[0].point.z - bottom[0].point.z);
    if (Math.abs(orderedArea - rectangularArea) > Math.max(1, rectangularArea * 1e-9)) continue;

    const offsets = {};
    const connections = [];
    let remaining = max - min;
    for (const side of ['start', 'end']) {
      const isStart = side === 'start';
      const edge = vertices.filter((vertex) => near(vertex.point[axis], isStart ? min : max));
      if (edge.length !== 2) continue;
      const base = edge.map((vertex) => nodes.get(vertex.id));
      if (base.some((point) => !point) || !near(base[0][axis], base[1][axis])) continue;

      const matches = columnList.filter((column) => {
        const axisWidth = axis === 'x' ? column.widthX : column.widthY;
        const orthWidth = axis === 'x' ? column.widthY : column.widthX;
        return (
          near(base[0][axis], column[axis]) &&
          near(vertices[0].point[orth], column[orth]) &&
          orthWidth >= thickness - TOLERANCE_MM &&
          column.minZ <= bottom[0].point.z + TOLERANCE_MM &&
          column.maxZ >= top[0].point.z - TOLERANCE_MM &&
          axisWidth > 2 * TOLERANCE_MM
        );
      });
      if (matches.length > 1) {
        warnings.push(`StbWall:${wallId} ${side}: 柱が複数該当するため未処理`);
        continue;
      }
      if (matches.length !== 1) continue;

      const column = matches[0];
      const axisWidth = axis === 'x' ? column.widthX : column.widthY;
      const sign = isStart ? 1 : -1;
      const currentCut = sign * (edge[0].point[axis] - base[0][axis]);
      const delta = axisWidth / 2 - currentCut;
      if (delta <= TOLERANCE_MM) continue;
      if (delta >= remaining - TOLERANCE_MM) {
        warnings.push(`StbWall:${wallId} ${side}: 柱面まで短縮すると壁長が不足するため未処理`);
        continue;
      }
      remaining -= delta;
      for (const vertex of edge) {
        offsets[vertex.id] = {
          ...vertex.offset,
          [`offset_${axis.toUpperCase()}`]:
            Math.round((vertex.offset[`offset_${axis.toUpperCase()}`] + sign * delta) * 1e6) / 1e6,
        };
      }
      connections.push({ side, columnId: column.element.getAttribute('id'), cutbackMm: delta });
    }
    if (connections.length > 0) {
      proposals.push({
        kind: 'wall-column-side',
        elementType: 'StbWall',
        elementId: wallId,
        offsets,
        connections,
      });
    }
  }
  return proposals;
}

// 同一壁の上端・左右端をまとめて、一度だけ面積差分を求める。
// 別々に数量控除すると角部で二重控除されるため、必ず1 Command/壁とする。
function mergeWallOffsets(document, nodes, beamList, wallProposals, warnings) {
  const grouped = new Map();
  for (const proposal of wallProposals) {
    const id = String(proposal.elementId);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(proposal);
  }
  const result = [];
  for (const [id, items] of grouped) {
    const wall = findById(document, 'StbWall', id);
    const vertices = wallVertices(wall, nodes);
    if (!vertices || vertices.some((vertex) => !vertex)) continue;
    const section = findById(document, 'StbSecWall_RC', wall.getAttribute('id_section'));
    const shape = section && descendants(section, 'StbSecWall_RC_Straight')[0];
    const thickness = numberAttribute(shape, 't');
    if (!positive(thickness)) continue;
    // 梁の元節点ではなく、現在の有効梁端部で壁の調整後全幅を覆うことを確認。
    // 柱端部の短縮案を先に反映した幅を基準にし、梁が足りない壁の一括上端控除を止める。
    const beamTop = items.find((item) => item.kind === 'wall-beam-top');
    let applicableItems = items;
    if (beamTop) {
      const beam = beamList.find(
        (value) =>
          value.elementType === beamTop.beamType &&
          value.element.getAttribute('id') === beamTop.beamId,
      );
      const axis = beam?.axis;
      const columnProposal = items.find((item) => item.kind === 'wall-column-side');
      const axisKey = axis ? `offset_${axis.toUpperCase()}` : null;
      const positions = axisKey
        ? vertices.map(
            (vertex) =>
              nodes.get(vertex.id)[axis] +
              (columnProposal?.offsets[vertex.id]?.[axisKey] ?? vertex.offset[axisKey]),
          )
        : [];
      const beamMin = beam && Math.min(beam.start[axis], beam.end[axis]);
      const beamMax = beam && Math.max(beam.start[axis], beam.end[axis]);
      if (
        !beam ||
        Math.min(...positions) < beamMin - TOLERANCE_MM ||
        Math.max(...positions) > beamMax + TOLERANCE_MM
      ) {
        warnings.push(`StbWall:${id}: 梁の有効範囲が壁上端を覆わないため上端調整を保留`);
        applicableItems = items.filter((item) => item !== beamTop);
      }
    }
    if (applicableItems.length === 0) continue;
    const changed = new Map(vertices.map((vertex) => [vertex.id, { ...vertex.offset }]));
    const touched = new Map();
    let conflicting = false;
    for (const item of applicableItems) {
      for (const [nodeId, values] of Object.entries(item.offsets)) {
        const vertex = vertices.find((value) => value.id === nodeId);
        if (!vertex) {
          conflicting = true;
          break;
        }
        for (const axis of ['X', 'Y', 'Z']) {
          const key = `offset_${axis}`;
          if (!near(values[key], vertex.offset[key])) {
            const identity = `${nodeId}:${axis}`;
            if (touched.has(identity) && !near(touched.get(identity), values[key])) {
              conflicting = true;
              break;
            }
            touched.set(identity, values[key]);
            changed.get(nodeId)[key] = values[key];
          }
        }
      }
    }
    if (conflicting) {
      warnings.push(`StbWall:${id}: 同一節点の取り合い案が競合したため未処理`);
      continue;
    }
    const plan = [...vertices].sort((a, b) => b.point.z - a.point.z);
    const axis =
      near(plan[0].point.y, plan[1].point.y) && !near(plan[0].point.x, plan[1].point.x) ? 'x' : 'y';
    const area = (useNew) => {
      const points = vertices.map((vertex) => ({
        p:
          nodes.get(vertex.id)[axis] +
          (useNew ? changed.get(vertex.id) : vertex.offset)[`offset_${axis.toUpperCase()}`],
        z: nodes.get(vertex.id).z + (useNew ? changed.get(vertex.id) : vertex.offset).offset_Z,
      }));
      return (
        Math.abs(
          points.reduce((total, point, index) => {
            const next = points[(index + 1) % points.length];
            return total + point.p * next.z - next.p * point.z;
          }, 0),
        ) / 2
      );
    };
    const beforeArea = area(false);
    const afterArea = area(true);
    if (afterArea <= TOLERANCE_MM || beforeArea - afterArea <= TOLERANCE_MM) {
      warnings.push(`StbWall:${id}: 控除後の壁面積が不正なため未処理`);
      continue;
    }
    const offsets = Object.fromEntries(
      [...changed].filter(([nodeId, values]) => {
        const before = vertices.find((vertex) => vertex.id === nodeId).offset;
        return ['X', 'Y', 'Z'].some(
          (axis) => !near(values[`offset_${axis}`], before[`offset_${axis}`]),
        );
      }),
    );
    result.push({
      kind: applicableItems.length > 1 ? 'wall-mixed' : applicableItems[0].kind,
      elementType: 'StbWall',
      elementId: id,
      offsets,
      connections: applicableItems.flatMap((item) => item.connections || []),
      beamId: applicableItems.find((item) => item.beamId)?.beamId || null,
      estimatedReductionMm3: (beforeArea - afterArea) * thickness,
    });
  }
  return result;
}

/** 壁端部・上端の候補を統合し、同じ壁の二重体積控除を回避する。 */
export function planWallJoinOffsets(document, nodes, beamList, columnList, warnings) {
  const proposals = [
    ...proposeWallTopOffsets(document, nodes, beamList, warnings),
    ...proposeWallColumnOffsets(document, nodes, columnList, warnings),
  ];
  return mergeWallOffsets(document, nodes, beamList, proposals, warnings);
}
