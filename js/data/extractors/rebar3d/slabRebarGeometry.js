/**
 * @fileoverview RCスラブ配筋の矩形ローカル座標・配置区間・3D中心線生成。
 *
 * @module data/extractors/rebar3d/slabRebarGeometry
 */

import { REBAR_STANDARD_RULES } from '../../../constants/rebarStandardRules.js';
import { createLine, createRebarPath } from './rebarPath.js';
import { numberAttr } from './slabRebarSectionFacts.js';

const EPS = 1e-7;
const RECT_TOLERANCE_MM = 2;
const ANGLE_TOLERANCE_DEG = 1;

const SUPPORTED_NODE_KINDS = new Set(['ON_GRID', 'ON_GIRDER', 'ON_BEAM', 'ON_COLUMN', 'ON_POST']);
const FREE_NODE_KINDS = new Set(['OTHER', 'ON_CANTI']);

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(v, factor) {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}
function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function length(v) {
  return Math.hypot(v.x, v.y, v.z);
}
function normalize(v) {
  const size = length(v);
  return size > EPS ? scale(v, 1 / size) : null;
}
function distance(a, b) {
  return length(subtract(a, b));
}

function appliedVertices(nodeIds, nodes, offsets) {
  return nodeIds.map((id) => {
    const node = nodes.get(String(id));
    if (!node) return null;
    const offset = offsets.get(String(id)) || { x: 0, y: 0, z: 0 };
    return {
      id: String(id),
      kind: node.kind,
      point: { x: node.x + offset.x, y: node.y + offset.y, z: node.z + offset.z },
    };
  });
}

function buildRectFrame(vertices) {
  if (vertices.length !== 4 || vertices.some((entry) => !entry)) return null;
  const p1 = vertices[0].point;
  const p2 = vertices[1].point;
  const p3 = vertices[2].point;
  const p4 = vertices[3].point;
  const xAxis = normalize(subtract(p2, p1));
  if (!xAxis) return null;
  let normal = normalize(cross(subtract(p2, p1), subtract(p4, p1)));
  if (!normal) return null;
  if (normal.z < 0) normal = scale(normal, -1);
  const yAxis = normalize(cross(normal, xAxis));
  if (!yAxis) return null;

  const local = [p1, p2, p3, p4].map((point) => {
    const rel = subtract(point, p1);
    return { x: dot(rel, xAxis), y: dot(rel, yAxis), plane: dot(rel, normal) };
  });
  const width = local[1].x;
  const height = local[3].y;
  if (!(width > EPS && height > EPS)) return null;
  const rectangular =
    Math.abs(local[0].x) <= RECT_TOLERANCE_MM &&
    Math.abs(local[0].y) <= RECT_TOLERANCE_MM &&
    Math.abs(local[1].y) <= RECT_TOLERANCE_MM &&
    Math.abs(local[2].x - width) <= RECT_TOLERANCE_MM &&
    Math.abs(local[2].y - height) <= RECT_TOLERANCE_MM &&
    Math.abs(local[3].x) <= RECT_TOLERANCE_MM &&
    local.every((value) => Math.abs(value.plane) <= RECT_TOLERANCE_MM);
  if (!rectangular) return null;

  return {
    origin: p1,
    xAxis,
    yAxis,
    normal,
    width,
    height,
    shortAxis: width <= height ? 'x' : 'y',
    shortSpanMm: Math.min(width, height),
    longSpanMm: Math.max(width, height),
  };
}

function localToWorld(frame, x, y, normalOffset = 0) {
  return add(
    add(add(frame.origin, scale(frame.xAxis, x)), scale(frame.yAxis, y)),
    scale(frame.normal, normalOffset),
  );
}

function axisAngleDegrees(frame, axis) {
  const vector = axis === 'x' ? frame.xAxis : frame.yAxis;
  const x = dot(vector, frame.xAxis);
  const y = dot(vector, frame.yAxis);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function normalizeAngleDegrees(value) {
  const angle = value % 180;
  return angle < 0 ? angle + 180 : angle;
}

function angularDistance180(a, b) {
  const aa = normalizeAngleDegrees(a);
  const bb = normalizeAngleDegrees(b);
  const raw = Math.abs(aa - bb);
  return Math.min(raw, 180 - raw);
}

function resolveMainAxis(slabEl, frame) {
  const explicit = numberAttr(slabEl, 'angle_main_bar_direction');
  if (Number.isFinite(explicit)) {
    const xDiff = angularDistance180(explicit, 0);
    const yDiff = angularDistance180(explicit, 90);
    if (xDiff <= ANGLE_TOLERANCE_DEG) return 'x';
    if (yDiff <= ANGLE_TOLERANCE_DEG) return 'y';
    return null;
  }
  if (Math.abs(frame.width - frame.height) <= RECT_TOLERANCE_MM) return null;
  return frame.shortAxis;
}

function supportedEdge(vertices, edgeIndex) {
  const a = vertices[edgeIndex];
  const b = vertices[(edgeIndex + 1) % vertices.length];
  return SUPPORTED_NODE_KINDS.has(a.kind) && SUPPORTED_NODE_KINDS.has(b.kind);
}

function freeEdge(vertices, edgeIndex) {
  const a = vertices[edgeIndex];
  const b = vertices[(edgeIndex + 1) % vertices.length];
  return FREE_NODE_KINDS.has(a.kind) && FREE_NODE_KINDS.has(b.kind);
}

function inferCantileverRootTip(vertices, mainAxis) {
  const candidates = [];
  for (let i = 0; i < 4; i += 1) {
    if (!freeEdge(vertices, i)) continue;
    const opposite = (i + 2) % 4;
    if (!supportedEdge(vertices, opposite)) continue;
    candidates.push({ freeEdge: i, rootEdge: opposite });
  }
  if (candidates.length !== 1) return null;
  const { freeEdge: freeIndex, rootEdge: rootIndex } = candidates[0];
  const edgeAxis = (index) => (index % 2 === 0 ? 'x' : 'y');
  const runAxis = edgeAxis(freeIndex) === 'x' ? 'y' : 'x';
  if (runAxis !== mainAxis) return null;

  // rectangular local node order: edge0 y=0, edge1 x=width, edge2 y=height, edge3 x=0
  const rootCoord =
    rootIndex === 0
      ? 0
      : rootIndex === 2
        ? mainAxis === 'x'
          ? null
          : 'MAX'
        : rootIndex === 3
          ? 0
          : 'MAX';
  if (rootCoord === null) return null;
  const rootAtMin = rootCoord === 0;
  return { rootAtMin, freeEdgeIndex: freeIndex, rootEdgeIndex: rootIndex };
}

function hasSlabOpening(xmlDoc, slabId, slabEl) {
  if (slabEl.getElementsByTagName('StbOpenId')?.length) return true;
  for (const arrangement of Array.from(
    xmlDoc?.getElementsByTagName?.('StbOpenArrangement') || [],
  )) {
    if (
      arrangement.getAttribute('kind_member') === 'SLAB' &&
      String(arrangement.getAttribute('id_member')) === String(slabId)
    ) {
      return true;
    }
  }
  return false;
}

function classifyPosition(pattern, pos) {
  const tokens = String(pos || '').split('_');
  const face = tokens.includes('TOP') ? 'TOP' : tokens.includes('BOTTOM') ? 'BOTTOM' : null;
  if (!face) return null;

  if (pattern === 'STANDARD') {
    const direction = tokens[0] === 'SHORT' ? 'SHORT' : tokens[0] === 'LONG' ? 'LONG' : null;
    if (!direction) return null;
    const zone = tokens.includes('COLUMN')
      ? 'COLUMN'
      : tokens.includes('END')
        ? 'MID_END'
        : tokens.includes('CENTER')
          ? 'MID_CENTER'
          : null;
    return zone ? { direction, face, zone } : null;
  }
  if (pattern === '2WAY') {
    const direction = tokens[0] === 'SHORT' ? 'SHORT' : tokens[0] === 'LONG' ? 'LONG' : null;
    const zone = tokens.includes('END') ? 'END' : tokens.includes('CENTER') ? 'CENTER' : null;
    return direction && zone ? { direction, face, zone } : null;
  }
  if (pattern === '1WAY1') {
    const direction =
      tokens[0] === 'MAIN' ? 'MAIN' : tokens[0] === 'TRANSVERSE' ? 'TRANSVERSE' : null;
    return direction ? { direction, face, zone: 'FULL' } : null;
  }
  if (pattern === '1WAY2') {
    const direction =
      tokens[0] === 'MAIN' ? 'MAIN' : tokens[0] === 'TRANSVERSE' ? 'TRANSVERSE' : null;
    const zone =
      direction === 'TRANSVERSE'
        ? 'FULL'
        : tokens.includes('BASE')
          ? 'BASE'
          : tokens.includes('TIP')
            ? 'TIP'
            : null;
    return direction && zone ? { direction, face, zone } : null;
  }
  return null;
}

function primaryDirectionForLayer(pattern, frame, mainAxis) {
  if (pattern === '1WAY1' || pattern === '1WAY2') return mainAxis;
  return frame.shortAxis;
}

function maxPrimaryDiameter(section, frame, mainAxis) {
  const primaryAxis = primaryDirectionForLayer(section.pattern, frame, mainAxis);
  let max = 0;
  for (const bar of section.bars) {
    const info = classifyPosition(section.pattern, bar.pos);
    if (!info) continue;
    const axis = resolveBarAxis(info.direction, frame, mainAxis);
    if (axis !== primaryAxis) continue;
    for (const dia of bar.diametersMm) max = Math.max(max, dia);
  }
  return max;
}

function resolveBarAxis(direction, frame, mainAxis) {
  if (direction === 'SHORT') return frame.shortAxis;
  if (direction === 'LONG') return frame.shortAxis === 'x' ? 'y' : 'x';
  if (direction === 'MAIN') return mainAxis;
  if (direction === 'TRANSVERSE') return mainAxis === 'x' ? 'y' : 'x';
  return null;
}

function getAxisLength(frame, axis) {
  return axis === 'x' ? frame.width : frame.height;
}

function intervalsForBar(section, info, frame, bar, mainAxis, cantilever) {
  const runAxis = resolveBarAxis(info.direction, frame, mainAxis);
  if (!runAxis) return null;
  const crossAxis = runAxis === 'x' ? 'y' : 'x';
  const runLength = getAxisLength(frame, runAxis);
  const crossLength = getAxisLength(frame, crossAxis);
  const cutRule = REBAR_STANDARD_RULES.defaults.slab?.cutoff || {};
  const quarterBase = frame.shortSpanMm * (cutRule.supportZoneByShortSpanRatio ?? 0.25);
  const extensionDiaFactor = cutRule.extensionDiaFactor ?? 15;
  const diaForCutoff = Math.max(...bar.diametersMm);
  const extension = extensionDiaFactor * diaForCutoff;
  const endLimit = Math.min(runLength / 2, quarterBase + extension);
  const centerStart = Math.max(0, quarterBase - extension);
  const centerEnd = Math.min(runLength, runLength - quarterBase + extension);

  if (section.pattern === 'STANDARD') {
    if (info.zone === 'COLUMN') {
      return {
        runAxis,
        runIntervals: [[0, runLength]],
        crossIntervals: [
          [0, crossLength / 4],
          [(crossLength * 3) / 4, crossLength],
        ],
      };
    }
    const crossIntervals = [[crossLength / 4, (crossLength * 3) / 4]];
    if (info.zone === 'MID_END') {
      return {
        runAxis,
        runIntervals: [
          [0, endLimit],
          [runLength - endLimit, runLength],
        ],
        crossIntervals,
      };
    }
    if (info.zone === 'MID_CENTER') {
      return { runAxis, runIntervals: [[centerStart, centerEnd]], crossIntervals };
    }
  }

  if (section.pattern === '2WAY') {
    if (info.zone === 'END') {
      return {
        runAxis,
        runIntervals: [
          [0, endLimit],
          [runLength - endLimit, runLength],
        ],
        crossIntervals: [[0, crossLength]],
      };
    }
    if (info.zone === 'CENTER') {
      return {
        runAxis,
        runIntervals: [[centerStart, centerEnd]],
        crossIntervals: [[0, crossLength]],
      };
    }
  }

  if (section.pattern === '1WAY1') {
    return {
      runAxis,
      runIntervals: [[0, runLength]],
      crossIntervals: [[0, crossLength]],
    };
  }

  if (section.pattern === '1WAY2') {
    if (info.direction === 'TRANSVERSE') {
      return {
        runAxis,
        runIntervals: [[0, runLength]],
        crossIntervals: [[0, crossLength]],
      };
    }
    if (!cantilever) return null;
    const half = runLength / 2;
    const rootAtMin = cantilever.rootAtMin;
    const isBase = info.zone === 'BASE';
    const wantMinHalf = isBase ? rootAtMin : !rootAtMin;
    return {
      runAxis,
      runIntervals: [wantMinHalf ? [0, half] : [half, runLength]],
      crossIntervals: [[0, crossLength]],
    };
  }

  return null;
}

function barCoordinates(interval, pitchMm, maxFromBoundaryMm) {
  const [start, end] = interval;
  const width = end - start;
  if (!(width > EPS) || !(pitchMm > 0)) return [];
  const inset = Math.min(maxFromBoundaryMm, pitchMm / 2, width / 2);
  const values = [];
  for (let value = start + inset; value <= end - inset + EPS; value += pitchMm) {
    values.push(Math.min(value, end - inset));
    if (values.length > 10000) break;
  }
  if (values.length === 0) values.push((start + end) / 2);
  return values;
}

function identityNumber(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function slabBarIdentity({ slab, bar, info, runAxis, crossCoord, diaMm, runStart, runEnd }) {
  const memberId = String(slab?.id || '').trim();
  const position = String(bar?.pos || '').trim();
  const direction = String(info?.direction || '').trim();
  const face = String(info?.face || '').trim();
  const zone = String(info?.zone || '').trim();
  const axis = String(runAxis || '').trim();
  const dia = identityNumber(diaMm);
  const pitch = identityNumber(bar?.pitchMm);
  const cross = identityNumber(crossCoord);
  const start = identityNumber(runStart);
  const end = identityNumber(runEnd);
  if (
    !memberId ||
    !position ||
    !direction ||
    !face ||
    !zone ||
    !axis ||
    dia === null ||
    pitch === null ||
    cross === null ||
    start === null ||
    end === null
  ) {
    return null;
  }
  const strength = String(bar?.strength || '-').trim() || '-';
  return [
    'SLAB',
    memberId,
    position,
    direction,
    face,
    zone,
    `D${dia}`,
    `P${pitch}`,
    `G${strength}`,
    `A${axis}`,
    `C${cross}`,
    `R${start}:${end}`,
  ].join('|');
}

function rootToTipRatio(localCoord, runLength, cantilever) {
  if (!cantilever) return 0;
  return cantilever.rootAtMin ? localCoord / runLength : (runLength - localCoord) / runLength;
}

function shapeAt(section, runCoord, runLength, cantilever) {
  const shape = section.shape;
  if (shape.type === 'STRAIGHT') return { depthMm: shape.depthMm, topDropMm: 0 };
  if (!cantilever) return null;
  const ratio = Math.min(1, Math.max(0, rootToTipRatio(runCoord, runLength, cantilever)));
  if (shape.type === 'TAPER') {
    return {
      depthMm: shape.baseDepthMm + (shape.tipDepthMm - shape.baseDepthMm) * ratio,
      topDropMm: shape.tipOffsetMm * ratio,
    };
  }
  if (shape.type === 'HAUNCH') {
    const distanceFromRoot = ratio * runLength;
    const haunchRatio = Math.min(1, distanceFromRoot / shape.haunchLengthMm);
    return {
      depthMm: shape.baseDepthMm + (shape.tipDepthMm - shape.baseDepthMm) * haunchRatio,
      topDropMm: shape.tipOffsetMm * haunchRatio,
    };
  }
  return null;
}

function verticalOffset({ section, info, diaMm, isSecondary, shapeState }) {
  const coverMm = info.face === 'TOP' ? section.coverTopMm : section.coverBottomMm;
  if (!(Number.isFinite(coverMm) && coverMm >= 0) || !shapeState) return null;
  const layer = isSecondary ? section.primaryMaxDiaMm : 0;
  if (info.face === 'TOP') {
    return -(shapeState.topDropMm + coverMm + diaMm / 2 + layer);
  }
  return -(shapeState.topDropMm + shapeState.depthMm - coverMm - diaMm / 2 - layer);
}

function appendPathsForBar(plan, slab, section, info, frame, bar, mainAxis, cantilever) {
  const intervals = intervalsForBar(section, info, frame, bar, mainAxis, cantilever);
  if (!intervals) return false;
  const runAxis = intervals.runAxis;
  const runLength = getAxisLength(frame, runAxis);
  const maxFromSupport = REBAR_STANDARD_RULES.defaults.slab?.firstBarFromSupportMaxMm ?? 100;
  const isSecondary = runAxis !== section.primaryAxis;
  let barSequenceIndex = 0;

  for (const crossInterval of intervals.crossIntervals) {
    const coords = barCoordinates(crossInterval, bar.pitchMm, maxFromSupport);
    for (const crossCoord of coords) {
      const diaMm = bar.diametersMm[barSequenceIndex % bar.diametersMm.length];
      barSequenceIndex += 1;
      for (const [runStart, runEnd] of intervals.runIntervals) {
        if (!(runEnd - runStart > EPS)) continue;
        const shapeStart = shapeAt(section, runStart, runLength, cantilever);
        const shapeEnd = shapeAt(section, runEnd, runLength, cantilever);
        const offsetStart = verticalOffset({
          section,
          info,
          diaMm,
          isSecondary,
          shapeState: shapeStart,
        });
        const offsetEnd = verticalOffset({
          section,
          info,
          diaMm,
          isSecondary,
          shapeState: shapeEnd,
        });
        if (!Number.isFinite(offsetStart) || !Number.isFinite(offsetEnd)) return false;

        const start =
          runAxis === 'x'
            ? localToWorld(frame, runStart, crossCoord, offsetStart)
            : localToWorld(frame, crossCoord, runStart, offsetStart);
        const end =
          runAxis === 'x'
            ? localToWorld(frame, runEnd, crossCoord, offsetEnd)
            : localToWorld(frame, crossCoord, runEnd, offsetEnd);
        if (!(distance(start, end) > EPS)) continue;

        const identityKey = slabBarIdentity({
          slab,
          bar,
          info,
          runAxis,
          crossCoord,
          diaMm,
          runStart,
          runEnd,
        });
        if (!identityKey) return false;

        plan.paths.push(
          createRebarPath([createLine(start, end)], {
            coordinateSpace: 'world',
            identityKey,
            dia: diaMm,
            memberType: 'slab',
            memberId: slab.id,
            sectionId: section.id,
            pattern: section.pattern,
            position: bar.pos,
            direction: info.direction,
            face: info.face,
            zone: info.zone,
            pitchMm: bar.pitchMm,
            strength: bar.strength,
            runAxis,
            crossCoordMm: crossCoord,
            runStartMm: runStart,
            runEndMm: runEnd,
            standardId: REBAR_STANDARD_RULES.standardId,
          }),
        );
      }
    }
  }
  return true;
}

export {
  appliedVertices,
  buildRectFrame,
  axisAngleDegrees,
  resolveMainAxis,
  inferCantileverRootTip,
  hasSlabOpening,
  classifyPosition,
  primaryDirectionForLayer,
  maxPrimaryDiameter,
  intervalsForBar,
  appendPathsForBar,
  slabBarIdentity,
};
