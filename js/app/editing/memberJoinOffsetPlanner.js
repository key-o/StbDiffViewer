/**
 * @fileoverview RC部材の単純な取り合いをSTB offset編集案に変換する。
 *
 * 梁・柱の単純なRC取り合いを検出し、壁の調整計画はrcWallJoinPlannerへ委譲する。
 * 未対応の接合を推測して短縮しない。原本は一切変更せず、候補を返す。
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
import { planWallJoinOffsets } from './rcWallJoinPlanner.js';
import { planSlabJoinOffsets } from './rcSlabJoinPlanner.js';

function readNodes(document) {
  const nodes = new Map();
  for (const item of descendants(document, 'StbNode')) {
    const id = item.getAttribute('id');
    const x = numberAttribute(item, 'X');
    const y = numberAttribute(item, 'Y');
    const z = numberAttribute(item, 'Z');
    if (id && [x, y, z].every(Number.isFinite)) nodes.set(id, { x, y, z });
  }
  return nodes;
}

function effectiveNode(element, nodes, nodeId, offsetPrefix) {
  const node = nodes.get(String(nodeId));
  if (!node) return null;
  const point = {};
  for (const axis of ['X', 'Y', 'Z']) {
    const value = numberAttribute(element, `${offsetPrefix}_${axis}`, 0);
    if (value === null) return null;
    point[axis.toLowerCase()] = node[axis.toLowerCase()] + value;
  }
  return point;
}

/** 中間節点が始終端を結ぶ直線上（平面位置）にある場合だけ、直線梁として扱う。 */
function viaNodesAreCollinear(beam, nodes) {
  const via = child(beam, 'StbBeamViaNode') || child(beam, 'StbGirderViaNode');
  if (!via) return true;
  const start = effectiveNode(beam, nodes, beam.getAttribute('id_node_start'), 'offset_start');
  const end = effectiveNode(beam, nodes, beam.getAttribute('id_node_end'), 'offset_end');
  if (!start || !end) return false;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length <= TOLERANCE_MM) return false;
  return descendants(via, 'StbMemberOffsetList').every((item) => {
    const base = nodes.get(String(item.getAttribute('id_node')));
    const ox = numberAttribute(item, 'offset_X', 0);
    const oy = numberAttribute(item, 'offset_Y', 0);
    if (!base || ox === null || oy === null) return false;
    const px = base.x + ox - start.x;
    const py = base.y + oy - start.y;
    const t = (px * dx + py * dy) / (length * length);
    return Math.abs(px * dy - py * dx) / length <= TOLERANCE_MM && t > 0 && t < 1;
  });
}

function beamProfile(document, beam, nodes) {
  if (beam.getAttribute('kind_structure') !== 'RC' || !viaNodesAreCollinear(beam, nodes))
    return null;
  if (!near(numberAttribute(beam, 'rotate', 0) ?? NaN, 0)) return null;
  const sectionId = beam.getAttribute('id_section');
  const section =
    findById(document, 'StbSecBeam_RC', sectionId) ||
    findById(document, 'StbSecGirder_RC', sectionId);
  if (!section) return null;
  const figures = descendants(section, 'StbSecFigureBeam_RC');
  // 多段・テーパーは端部の断面寸法を一意に確定できない。
  if (figures.length !== 1) return null;
  const shape =
    child(figures[0], 'StbSecBeamStraight') || child(figures[0], 'StbSecBeam_RC_Straight');
  if (!shape) return null;
  const width = numberAttribute(shape, 'width');
  const depth = numberAttribute(shape, 'depth');
  if (!positive(width) || !positive(depth)) return null;
  if (
    !near(numberAttribute(shape, 'horizontal_offset', 0) ?? NaN, 0) ||
    !near(numberAttribute(shape, 'vertical_offset', 0) ?? NaN, 0)
  )
    return null;
  return { width, depth };
}

function beams(document, nodes) {
  return [...descendants(document, 'StbGirder'), ...descendants(document, 'StbBeam')].flatMap(
    (element) => {
      const profile = beamProfile(document, element, nodes);
      if (!profile) return [];
      const start = effectiveNode(
        element,
        nodes,
        element.getAttribute('id_node_start'),
        'offset_start',
      );
      const end = effectiveNode(element, nodes, element.getAttribute('id_node_end'), 'offset_end');
      const baseStart = nodes.get(element.getAttribute('id_node_start'));
      const baseEnd = nodes.get(element.getAttribute('id_node_end'));
      if (!start || !end || !baseStart || !baseEnd || !near(start.z, end.z)) return [];
      const axis =
        near(start.y, end.y) && !near(start.x, end.x)
          ? 'x'
          : near(start.x, end.x) && !near(start.y, end.y)
            ? 'y'
            : null;
      if (!axis) return [];
      const length = Math.abs(end[axis] - start[axis]);
      if (length <= TOLERANCE_MM) return [];
      return [
        {
          element,
          elementType: tag(element),
          profile,
          start,
          end,
          baseStart,
          baseEnd,
          axis,
          length,
        },
      ];
    },
  );
}

function columns(document, nodes) {
  return descendants(document, 'StbColumn').flatMap((element) => {
    if (element.getAttribute('kind_structure') !== 'RC' || child(element, 'StbColumnViaNode'))
      return [];
    // 回転した柱・軸偏心のある断面では、見付幅/2を柱面距離として使えない。
    if (!near(numberAttribute(element, 'rotate', 0) ?? NaN, 0)) return [];
    const bottom = effectiveNode(
      element,
      nodes,
      element.getAttribute('id_node_bottom'),
      'offset_bottom',
    );
    const top = effectiveNode(element, nodes, element.getAttribute('id_node_top'), 'offset_top');
    if (!bottom || !top || !near(bottom.x, top.x) || !near(bottom.y, top.y)) return [];
    const section = findById(document, 'StbSecColumn_RC', element.getAttribute('id_section'));
    // 多段・複合形状の柱では断面見付面を一意に確定できないため保留する。
    const figures = section ? descendants(section, 'StbSecFigureColumn_RC') : [];
    if (figures.length !== 1) return [];
    const shapes = Array.from(figures[0].children || []);
    if (
      shapes.length !== 1 ||
      !['StbSecColumnRect', 'StbSecColumn_RC_Rect'].includes(tag(shapes[0]))
    )
      return [];
    const shape = shapes[0];
    const widthX = numberAttribute(shape, 'width_X');
    const widthY = numberAttribute(shape, 'width_Y');
    if (!positive(widthX) || !positive(widthY)) return [];
    if (
      !near(numberAttribute(shape, 'offset_X', 0) ?? NaN, 0) ||
      !near(numberAttribute(shape, 'offset_Y', 0) ?? NaN, 0)
    )
      return [];
    return [
      {
        element,
        x: top.x,
        y: top.y,
        minZ: Math.min(bottom.z, top.z),
        maxZ: Math.max(bottom.z, top.z),
        widthX,
        widthY,
      },
    ];
  });
}

function trimBeamToColumn(beam, column, side) {
  const { axis } = beam;
  const perp = axis === 'x' ? 'y' : 'x';
  const endpoint = side === 'start' ? beam.baseStart : beam.baseEnd;
  const effective = side === 'start' ? beam.start : beam.end;
  const other = side === 'start' ? beam.baseEnd : beam.baseStart;
  const along = axis === 'x' ? column.widthX : column.widthY;
  const across = axis === 'x' ? column.widthY : column.widthX;
  // 梁・柱とも節点offsetで偏心している実モデルを扱うため、有効座標で柱の見付内か判定する。
  const alongGap = column[axis] - endpoint[axis];
  const acrossGap = column[perp] - effective[perp];
  if (
    Math.abs(alongGap) > along / 2 + TOLERANCE_MM ||
    Math.abs(acrossGap) > across / 2 - TOLERANCE_MM ||
    column.minZ > effective.z - beam.profile.depth + TOLERANCE_MM ||
    column.maxZ < effective.z - TOLERANCE_MM
  )
    return null;
  const sign = Math.sign(other[axis] - endpoint[axis]);
  const required = along / 2 + sign * alongGap;
  if (!sign || required <= 0 || required >= beam.length - TOLERANCE_MM) return null;
  return {
    axis,
    sign,
    required,
    columnId: column.element.getAttribute('id'),
    zRange: [column.minZ, column.maxZ],
  };
}

/**
 * 直交する小梁の軸端が大梁芯へ接続するとき、大梁側面まで小梁を短縮する。
 * 大梁の端部近傍・異なる上端高さ・平行梁・交差するだけの梁は扱わない。
 */
function trimSecondaryBeamToGirder(beam, girder, side) {
  if (
    beam.elementType !== 'StbBeam' ||
    girder.elementType !== 'StbGirder' ||
    beam.axis === girder.axis
  )
    return null;

  const endpoint = side === 'start' ? beam.baseStart : beam.baseEnd;
  const other = side === 'start' ? beam.baseEnd : beam.baseStart;
  const effective = side === 'start' ? beam.start : beam.end;
  // 天端が異なる段差接合は単純矩形として扱わない。
  if (!near(effective.z, girder.start.z)) return null;
  // 未調整の小梁節点が大梁芯に接続されていることが必須。
  // 大梁にレベルoffsetがある場合は、節点高さ（offset前）でも一致を認める。
  // 座標上で交差しているだけの中間交差は自動短縮しない。
  if (
    !(near(endpoint.z, girder.start.z) || near(endpoint.z, girder.baseStart.z)) ||
    !near(endpoint[beam.axis], girder.start[beam.axis])
  )
    return null;

  // 大梁端部付近で小梁幅が外へはみ出す接合は単純矩形として扱わない。
  const position = effective[girder.axis];
  const min = Math.min(girder.start[girder.axis], girder.end[girder.axis]);
  const max = Math.max(girder.start[girder.axis], girder.end[girder.axis]);
  const margin = beam.profile.width / 2;
  if (position <= min + margin + TOLERANCE_MM || position >= max - margin - TOLERANCE_MM)
    return null;

  const sign = Math.sign(other[beam.axis] - endpoint[beam.axis]);
  const required = girder.profile.width / 2;
  if (!sign || required <= 0 || required >= beam.length - TOLERANCE_MM) return null;
  return {
    axis: beam.axis,
    sign,
    required,
    girderId: girder.element.getAttribute('id'),
    connectionType: 'girder',
  };
}

function stackedColumns(matches) {
  const ranges = matches.map((match) => match.zRange).sort((a, b) => a[0] - b[0]);
  return ranges.every((range, i) => i === 0 || range[0] >= ranges[i - 1][1] - TOLERANCE_MM);
}

function proposeBeamOffsets(beamList, columnList, warnings) {
  const girderList = beamList.filter((beam) => beam.elementType === 'StbGirder');
  const proposals = [];
  for (const beam of beamList) {
    const offsets = {};
    let reductionMm3 = 0;
    const connections = [];
    for (const side of ['start', 'end']) {
      const columnMatches = columnList
        .map((column) => trimBeamToColumn(beam, column, side))
        .filter(Boolean)
        .map((match) => ({ ...match, connectionType: 'column' }));
      const girderMatches =
        beam.elementType === 'StbBeam'
          ? girderList
              .map((girder) => trimSecondaryBeamToGirder(beam, girder, side))
              .filter(Boolean)
          : [];
      let matches = [...columnMatches, ...girderMatches];
      // 中間階では梁節点に上下の柱が同位置で接続する。重複せず積み重なる柱だけ外側の柱面まで控える。
      if (matches.length > 1 && girderMatches.length === 0 && stackedColumns(columnMatches)) {
        matches = [columnMatches.reduce((a, b) => (b.required > a.required ? b : a))];
      }
      if (matches.length > 1) {
        warnings.push(
          `${beam.elementType}:${beam.element.getAttribute('id')} ${side}: 柱・大梁の接続候補が複数該当するため未処理`,
        );
        continue;
      }
      if (matches.length !== 1) continue;
      const match = matches[0];
      const key = `offset_${side}_${match.axis.toUpperCase()}`;
      const old = numberAttribute(beam.element, key, 0);
      if (old === null) {
        warnings.push(
          `${beam.elementType}:${beam.element.getAttribute('id')} ${key}: 不正な既存offset`,
        );
        continue;
      }
      const base = side === 'start' ? beam.baseStart : beam.baseEnd;
      const effective = side === 'start' ? beam.start : beam.end;
      const currentCut = match.sign * (effective[match.axis] - base[match.axis]);
      const delta = match.required - currentCut;
      if (delta <= TOLERANCE_MM) continue;
      const remaining =
        beam.length - reductionMm3 / (beam.profile.width * beam.profile.depth) - delta;
      if (remaining <= TOLERANCE_MM) {
        warnings.push(
          `${beam.elementType}:${beam.element.getAttribute('id')}: 短縮後の長さが正にならないため未処理`,
        );
        continue;
      }
      offsets[key] = String(Math.round((old + match.sign * delta) * 1e6) / 1e6);
      reductionMm3 += delta * beam.profile.width * beam.profile.depth;
      connections.push({
        side,
        ...(match.columnId ? { columnId: match.columnId } : {}),
        ...(match.girderId ? { girderId: match.girderId } : {}),
        connectionType: match.connectionType,
        cutbackMm: delta,
      });
    }
    if (Object.keys(offsets).length > 0) {
      const hasGirder = connections.some((connection) => connection.girderId);
      const hasColumn = connections.some((connection) => connection.columnId);
      const kind = hasGirder ? (hasColumn ? 'beam-mixed' : 'beam-girder') : 'beam-column';
      proposals.push({
        kind,
        elementType: beam.elementType,
        elementId: beam.element.getAttribute('id'),
        offsets,
        connections,
        estimatedReductionMm3: reductionMm3,
      });
    }
  }
  return proposals;
}

/** 編集対象Working Document用のdry-run。proposalは後段のCommandに渡す。 */
export function planMemberJoinOffsets(document) {
  if (!document?.documentElement || tag(document.documentElement) !== 'ST_BRIDGE') {
    throw new TypeError('ST-Bridge Working Documentが必要です。');
  }
  const nodes = readNodes(document);
  const beamList = beams(document, nodes);
  const warnings = [];
  const columnList = columns(document, nodes);
  const proposals = [
    ...proposeBeamOffsets(beamList, columnList, warnings),
    ...planWallJoinOffsets(document, nodes, beamList, columnList, warnings),
    ...planSlabJoinOffsets(document, nodes, beamList, warnings),
  ];
  return {
    proposals,
    warnings,
    estimatedReductionMm3: proposals.reduce(
      (sum, proposal) => sum + proposal.estimatedReductionMm3,
      0,
    ),
    supportedScope:
      'RC柱×梁、RC大梁×小梁、RC壁×梁、RC柱×RC壁端部、矩形RC床外周×RC直線梁（全長支持・天端一致に限定）',
  };
}
