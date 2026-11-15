/**
 * @fileoverview RC矩形スラブ外周とRC矩形直線梁の、STB頂点offsetで表現可能な取り合い。
 *
 * 梁芯がスラブ外周の直線一辺と一致し、その梁が辺全長を覆い、天端と断面が
 * 適合する場合だけ梁内面までスラブ境界を寄せる。梁が内部を横断する場合や
 * 部分支持・複雑形状はSTB頂点offsetで局所欠き込みを表現できないため保留する。
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

const roundOffset = (value) => Math.round(value * 1e6) / 1e6;

function slabVertices(slab, nodes) {
  const order = child(slab, 'StbNodeIdOrder');
  const ids = (order?.textContent || '').trim().split(/\s+/).filter(Boolean);
  if (ids.length < 3 || ids.length > 128 || new Set(ids).size !== ids.length) return null;
  const list = child(slab, 'StbSlabOffsetList');
  const offsets = new Map();
  for (const item of Array.from(list?.children || [])) {
    if (tag(item) !== 'StbSlabOffset') return null;
    const id = item.getAttribute('id_node');
    if (!ids.includes(id) || offsets.has(id)) return null;
    offsets.set(id, item);
  }
  return ids.map((id) => {
    const node = nodes.get(id);
    if (!node) return null;
    const offset = {};
    const point = {};
    for (const axis of ['X', 'Y', 'Z']) {
      const value = numberAttribute(offsets.get(id), `offset_${axis}`, 0);
      if (value === null) return null;
      offset[`offset_${axis}`] = value;
      point[axis.toLowerCase()] = node[axis.toLowerCase()] + value;
    }
    return { id, point, offset };
  });
}

function slabRectangle(vertices) {
  if (vertices?.length !== 4 || vertices.some((v) => !v)) return null;
  const z = vertices[0].point.z;
  if (!vertices.every((v) => near(v.point.z, z))) return null;
  const minX = Math.min(...vertices.map((v) => v.point.x));
  const maxX = Math.max(...vertices.map((v) => v.point.x));
  const minY = Math.min(...vertices.map((v) => v.point.y));
  const maxY = Math.max(...vertices.map((v) => v.point.y));
  if (maxX - minX <= TOLERANCE_MM || maxY - minY <= TOLERANCE_MM) return null;
  const corners = new Set();
  for (let i = 0; i < 4; i++) {
    const { point } = vertices[i];
    const { point: next } = vertices[(i + 1) % 4];
    if (!near(point.x, minX) && !near(point.x, maxX)) return null;
    if (!near(point.y, minY) && !near(point.y, maxY)) return null;
    if (near(point.x, next.x) === near(point.y, next.y)) return null;
    const key = `${near(point.x, minX) ? 'min' : 'max'}X-${near(point.y, minY) ? 'min' : 'max'}Y`;
    if (corners.has(key)) return null;
    corners.add(key);
  }
  return { minX, maxX, minY, maxY, z };
}

function thickness(document, slab) {
  const section = findById(document, 'StbSecSlab_RC', slab.getAttribute('id_section'));
  if (!section || section.getAttribute('isCanti') === 'true') return null;
  const figures = [
    ...descendants(section, 'StbSecFigureSlab_RC'),
    ...descendants(section, 'StbSecFigureSlab_RC_Conventional'),
  ];
  if (figures.length !== 1) return null;
  const shapes = [
    ...descendants(section, 'StbSecSlab_RC_Straight'),
    ...descendants(section, 'StbSecSlab_RC_ConventionalStraight'),
  ];
  if (shapes.length !== 1) return null;
  // 複数段のテーパー・ハンチが混在する断面は扱わない。
  if (
    descendants(section, 'StbSecSlab_RC_Taper').length ||
    descendants(section, 'StbSecSlab_RC_ConventionalTaper').length ||
    descendants(section, 'StbSecSlab_RC_Haunch').length ||
    descendants(section, 'StbSecSlab_RC_ConventionalHaunch').length
  )
    return null;
  const depth = numberAttribute(shapes[0], 'depth');
  return positive(depth) ? depth : null;
}

function slabHasOpenings(slab, referencedIds) {
  return (
    Boolean(
      child(slab, 'StbOpenIdList') ||
      slab.getAttribute('id_open') ||
      slab.getAttribute('id_opening'),
    ) || referencedIds.has(slab.getAttribute('id'))
  );
}

/** beamはmemberJoinOffsetPlannerの正規化済みRC直線梁。 */
function intersectsSlab(beam, rect, depth) {
  const half = beam.profile.width / 2;
  const beamBounds =
    beam.axis === 'x'
      ? {
          minX: Math.min(beam.start.x, beam.end.x),
          maxX: Math.max(beam.start.x, beam.end.x),
          minY: beam.start.y - half,
          maxY: beam.start.y + half,
        }
      : {
          minX: beam.start.x - half,
          maxX: beam.start.x + half,
          minY: Math.min(beam.start.y, beam.end.y),
          maxY: Math.max(beam.start.y, beam.end.y),
        };
  const overlapX = Math.min(rect.maxX, beamBounds.maxX) - Math.max(rect.minX, beamBounds.minX);
  const overlapY = Math.min(rect.maxY, beamBounds.maxY) - Math.max(rect.minY, beamBounds.minY);
  const overlapZ =
    Math.min(rect.z, beam.start.z) - Math.max(rect.z - depth, beam.start.z - beam.profile.depth);
  return overlapX > TOLERANCE_MM && overlapY > TOLERANCE_MM && overlapZ > TOLERANCE_MM;
}

function supportingEdge(beam, rect, depth) {
  if (!near(beam.start.z, rect.z) || depth > beam.profile.depth + TOLERANCE_MM) return null;
  const orth = beam.axis === 'x' ? 'y' : 'x';
  const along = beam.axis;
  const sides =
    orth === 'y'
      ? [
          { side: 'minY', location: rect.minY, sign: 1 },
          { side: 'maxY', location: rect.maxY, sign: -1 },
        ]
      : [
          { side: 'minX', location: rect.minX, sign: 1 },
          { side: 'maxX', location: rect.maxX, sign: -1 },
        ];
  const side = sides.find((item) => near(item.location, beam.start[orth]));
  if (!side) return null;
  const min = rect[`min${along.toUpperCase()}`];
  const max = rect[`max${along.toUpperCase()}`];
  const beamMin = Math.min(beam.start[along], beam.end[along]);
  const beamMax = Math.max(beam.start[along], beam.end[along]);
  if (beamMin > min + TOLERANCE_MM || beamMax < max - TOLERANCE_MM) return null;
  return {
    ...side,
    orth,
    inset: beam.profile.width / 2,
    beamId: beam.element.getAttribute('id'),
    beamType: beam.elementType,
  };
}

export function planSlabJoinOffsets(document, nodes, beamList, warnings) {
  const proposals = [];
  // DOM全開口をスラブごとに走査せず、明示診断時のコストを抑える。
  const openedSlabIds = new Set(
    ['StbOpen', 'StbOpenArrangement'].flatMap((name) =>
      descendants(document, name)
        .filter((item) => String(item.getAttribute('kind_member') || '').toUpperCase() === 'SLAB')
        .map((item) => item.getAttribute('id_member')),
    ),
  );
  for (const slab of descendants(document, 'StbSlab')) {
    if (slab.getAttribute('kind_structure') !== 'RC') continue;
    if (slab.getAttribute('isFoundation') === 'true') continue;
    if (!['', 'NORMAL'].includes(slab.getAttribute('kind_slab') || '')) continue;
    if (!near(numberAttribute(slab, 'rotate', 0) ?? NaN, 0)) continue;
    const slabId = slab.getAttribute('id');
    const vertices = slabVertices(slab, nodes);
    const rect = slabRectangle(vertices);
    const depth = thickness(document, slab);
    // 対象外の床形状も、梁が交差していれば警告するために可能な限りbboxを検査する。
    if (!vertices || vertices.some((v) => !v)) continue;
    const approximate = {
      minX: Math.min(...vertices.map((v) => v.point.x)),
      maxX: Math.max(...vertices.map((v) => v.point.x)),
      minY: Math.min(...vertices.map((v) => v.point.y)),
      maxY: Math.max(...vertices.map((v) => v.point.y)),
      z: vertices[0].point.z,
    };
    const intersects = beamList.filter((beam) => intersectsSlab(beam, approximate, depth || 150));
    if (!intersects.length) continue;
    if (!rect || !depth || slabHasOpenings(slab, openedSlabIds)) {
      warnings.push(
        `StbSlab:${slabId}: 非矩形・非一様断面・開口の可能性があるためRC梁取り合いを保留`,
      );
      continue;
    }
    const matches = intersects.map((beam) => supportingEdge(beam, rect, depth));
    if (matches.some((match) => !match)) {
      warnings.push(`StbSlab:${slabId}: 内部梁・部分支持・段差梁を含むため局所欠き込みを保留`);
      continue;
    }
    if (new Set(matches.map((match) => match.side)).size !== matches.length) {
      warnings.push(`StbSlab:${slabId}: 同じ外周辺にRC梁の複数候補があるため保留`);
      continue;
    }
    const next = { ...rect };
    for (const match of matches) next[match.side] += match.sign * match.inset;
    if (next.maxX - next.minX <= TOLERANCE_MM || next.maxY - next.minY <= TOLERANCE_MM) {
      warnings.push(`StbSlab:${slabId}: 梁内面へ控えると床面積が正にならないため保留`);
      continue;
    }
    const offsets = {};
    for (const vertex of vertices) {
      const x = near(vertex.point.x, rect.minX) ? next.minX : next.maxX;
      const y = near(vertex.point.y, rect.minY) ? next.minY : next.maxY;
      if (near(x, vertex.point.x) && near(y, vertex.point.y)) continue;
      offsets[vertex.id] = {
        offset_X: roundOffset(vertex.offset.offset_X + x - vertex.point.x),
        offset_Y: roundOffset(vertex.offset.offset_Y + y - vertex.point.y),
        offset_Z: vertex.offset.offset_Z,
      };
    }
    if (!Object.keys(offsets).length) continue;
    const beforeArea = (rect.maxX - rect.minX) * (rect.maxY - rect.minY);
    const afterArea = (next.maxX - next.minX) * (next.maxY - next.minY);
    proposals.push({
      kind: 'slab-beam-edge',
      elementType: 'StbSlab',
      elementId: slabId,
      offsets,
      connections: matches.map((match) => ({
        side: match.side,
        beamId: match.beamId,
        beamType: match.beamType,
        insetMm: match.inset,
      })),
      estimatedReductionMm3: (beforeArea - afterArea) * depth,
    });
  }
  return proposals;
}
