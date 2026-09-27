/**
 * @fileoverview RC壁配筋を壁ローカル平面からworld RebarPathへ変換する。
 *
 * ST-Bridge壁部材座標系: X=1点目→2点目、Y=鉛直上、Z=右手系。
 * 開口は第1基準点を原点とした壁ローカルX/Yで扱い、主筋を開口で切り欠き、
 * StbSecBarOpen_RC_Wall / StbSecBarWall_RC_Open を開口周囲へ展開する。
 *
 * @module data/extractors/rebar3d/wallRebarGeometry
 */

import { createLine, createRebarPath } from './rebarPath.js';

const EPS = 1e-7;
const OPENING_DIAGONAL_CORNER_OFFSET_MM = 50;

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(v, k) {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
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
function magnitude(v) {
  return Math.hypot(v.x, v.y, v.z);
}
function normalize(v) {
  const length = magnitude(v);
  return length > EPS ? scale(v, 1 / length) : null;
}

function add2(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}
function sub2(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}
function scale2(v, k) {
  return { x: v.x * k, y: v.y * k };
}
function dot2(a, b) {
  return a.x * b.x + a.y * b.y;
}
function cross2(a, b) {
  return a.x * b.y - a.y * b.x;
}
function magnitude2(v) {
  return Math.hypot(v.x, v.y);
}
function normalize2(v) {
  const length = magnitude2(v);
  return length > EPS ? scale2(v, 1 / length) : null;
}
function midpoint2(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function buildWallFrame(referencePoints, toleranceMm = 1e-3) {
  if (!Array.isArray(referencePoints) || referencePoints.length < 3) return null;
  const origin = referencePoints[0];
  const firstRun = sub(referencePoints[1], origin);
  const horizontal = { x: firstRun.x, y: firstRun.y, z: 0 };
  const xAxis = normalize(horizontal);
  const yAxis = { x: 0, y: 0, z: 1 };
  const zAxis = xAxis ? normalize(cross(xAxis, yAxis)) : null;
  if (!xAxis || !zAxis) return null;

  const profile = referencePoints.map((point) => {
    const delta = sub(point, origin);
    return {
      x: dot(delta, xAxis),
      y: dot(delta, yAxis),
      z: dot(delta, zAxis),
    };
  });
  if (profile.some((point) => Math.abs(point.z) > toleranceMm)) return null;

  return {
    origin: { ...origin },
    xAxis,
    yAxis,
    zAxis,
    profile: profile.map(({ x, y }) => ({ x, y })),
  };
}

function localToWorld(frame, point) {
  return add(
    add(add(frame.origin, scale(frame.xAxis, point.x)), scale(frame.yAxis, point.y)),
    scale(frame.zAxis, point.z || 0),
  );
}

function bounds(profile) {
  return {
    minX: Math.min(...profile.map((point) => point.x)),
    maxX: Math.max(...profile.map((point) => point.x)),
    minY: Math.min(...profile.map((point) => point.y)),
    maxY: Math.max(...profile.map((point) => point.y)),
  };
}

function scanlineIntervals(profile, axis, value) {
  const values = [];
  const primary = axis === 'VERTICAL' ? 'x' : 'y';
  const secondary = axis === 'VERTICAL' ? 'y' : 'x';

  for (let index = 0; index < profile.length; index += 1) {
    const a = profile[index];
    const b = profile[(index + 1) % profile.length];
    const av = a[primary];
    const bv = b[primary];
    if (Math.abs(av - bv) <= EPS) continue;
    // vertex二重計数を避けるhalf-open rule。
    if (!((av <= value && value < bv) || (bv <= value && value < av))) continue;
    const t = (value - av) / (bv - av);
    values.push(a[secondary] + (b[secondary] - a[secondary]) * t);
  }

  values.sort((a, b) => a - b);
  const intervals = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    if (values[index + 1] - values[index] > EPS) {
      intervals.push([values[index], values[index + 1]]);
    }
  }
  return intervals;
}

function subtractIntervals(baseIntervals, cutterIntervals) {
  let result = baseIntervals.map(([start, end]) => [start, end]);
  const cutters = cutterIntervals
    .map(([start, end]) => [Math.min(start, end), Math.max(start, end)])
    .filter(([start, end]) => end - start > EPS)
    .sort((a, b) => a[0] - b[0]);

  for (const [cutStart, cutEnd] of cutters) {
    const next = [];
    for (const [start, end] of result) {
      if (cutEnd <= start + EPS || cutStart >= end - EPS) {
        next.push([start, end]);
        continue;
      }
      if (cutStart > start + EPS) next.push([start, Math.min(cutStart, end)]);
      if (cutEnd < end - EPS) next.push([Math.max(cutEnd, start), end]);
    }
    result = next;
  }
  return result.filter(([start, end]) => end - start > EPS);
}

function pitchPositions(min, max, pitchMm) {
  const span = max - min;
  if (!(span > EPS) || !(pitchMm > 0)) return [];
  // STBは最初の1本の位置を持たない。表示上は両端余白を概ねpitch/2として、
  // 指定pitchを変えずに中央寄せする。端部定着は別detailで扱う。
  const count = Math.max(1, Math.floor(span / pitchMm));
  const used = (count - 1) * pitchMm;
  const start = min + (span - used) / 2;
  return Array.from({ length: count }, (_, index) => start + index * pitchMm).filter(
    (value) => value > min + EPS && value < max - EPS,
  );
}

function barDiameter(bar, index) {
  const values = bar?.diametersMm || [];
  return values.length ? values[index % values.length] : NaN;
}

function barDesignation(bar, index) {
  const values = bar?.designations || [];
  return values.length ? values[index % values.length] : null;
}

function maxDiameter(bar) {
  return Math.max(...(bar?.diametersMm || [0]));
}

function sideToLocalSign(side, typeOutside) {
  if (side === 'PLUS') return 1;
  if (side === 'MINUS') return -1;
  if (side === 'OUTSIDE') return typeOutside === 'TYPE_PLUS' ? 1 : -1;
  if (side === 'INSIDE') return typeOutside === 'TYPE_PLUS' ? -1 : 1;
  return 0;
}

function faceDepthMm({
  thicknessMm,
  coverMm,
  diaMm,
  sign,
  orientation,
  outerBarDirection,
  outerDirectionMaxDiaMm,
}) {
  const innerOfCross = orientation !== outerBarDirection;
  const fromSurface =
    coverMm + diaMm / 2 + (innerOfCross ? Math.max(0, outerDirectionMaxDiaMm) : 0);
  return sign * (thicknessMm / 2 - fromSurface);
}

function openingProfileGeometry(opening) {
  const width = Number(opening?.widthMm);
  const height = Number(opening?.heightMm);
  const x = Number(opening?.positionXMm);
  const y = Number(opening?.positionYMm);
  const angle = (Number(opening?.rotateDeg) * Math.PI) / 180;
  if (![width, height, x, y, angle].every(Number.isFinite) || !(width > 0) || !(height > 0)) {
    return null;
  }
  const ux = { x: Math.cos(angle), y: Math.sin(angle) };
  const uy = { x: -Math.sin(angle), y: Math.cos(angle) };
  const p0 = { x, y };
  const p1 = add2(p0, scale2(ux, width));
  const p2 = add2(p1, scale2(uy, height));
  const p3 = add2(p0, scale2(uy, height));
  return { opening, ux, uy, width, height, profile: [p0, p1, p2, p3] };
}

function appendDirectionPaths({
  paths,
  frame,
  profile,
  holeProfiles,
  bar,
  direction,
  zForIndex,
  memberId,
  sectionId,
  pattern,
  face,
}) {
  const { minX, maxX, minY, maxY } = bounds(profile);
  const positions =
    direction === 'VERTICAL'
      ? pitchPositions(minX, maxX, bar.pitchMm)
      : pitchPositions(minY, maxY, bar.pitchMm);

  positions.forEach((position, barIndex) => {
    const diaMm = barDiameter(bar, barIndex);
    if (!(diaMm > 0)) return;
    const wallIntervals = scanlineIntervals(profile, direction, position);
    const holeIntervals = holeProfiles.flatMap((hole) =>
      scanlineIntervals(hole, direction, position),
    );
    const intervals = subtractIntervals(wallIntervals, holeIntervals);
    intervals.forEach(([start, end], segmentIndex) => {
      const z = zForIndex(barIndex, diaMm);
      const localStart =
        direction === 'VERTICAL' ? { x: position, y: start, z } : { x: start, y: position, z };
      const localEnd =
        direction === 'VERTICAL' ? { x: position, y: end, z } : { x: end, y: position, z };
      paths.push(
        createRebarPath(
          [createLine(localToWorld(frame, localStart), localToWorld(frame, localEnd))],
          {
            coordinateSpace: 'world',
            dia: diaMm,
            diaName: barDesignation(bar, barIndex),
            memberType: 'wall',
            memberId: String(memberId),
            sectionId: String(sectionId),
            pattern,
            position: bar.pos,
            direction,
            face,
            pitchMm: bar.pitchMm,
            strength: bar.strength,
            role: 'wallMain',
            identityKey: `wall:${memberId}:${direction}:${face}:${barIndex}:${segmentIndex}:${diaMm}`,
          },
        ),
      );
    });
  });
}

function findBar(section, pos) {
  return section.bars.find((bar) => bar.pos === pos) || null;
}

function addSingle({ paths, frame, section, memberId, holeProfiles }) {
  for (const direction of ['VERTICAL', 'HORIZONTAL']) {
    const bar = findBar(section, direction);
    if (!bar) continue;
    appendDirectionPaths({
      paths,
      frame,
      profile: frame.profile,
      holeProfiles,
      bar,
      direction,
      zForIndex: () => 0,
      memberId,
      sectionId: section.id,
      pattern: section.pattern,
      face: 'CENTER',
    });
  }
}

function addZigzag({ paths, frame, section, memberId, typeOutside, holeProfiles }) {
  for (const direction of ['VERTICAL', 'HORIZONTAL']) {
    const bar = findBar(section, direction);
    if (!bar) continue;
    appendDirectionPaths({
      paths,
      frame,
      profile: frame.profile,
      holeProfiles,
      bar,
      direction,
      zForIndex: (index, diaMm) => {
        const sign = index % 2 === 0 ? 1 : -1;
        const outsideSign = typeOutside === 'TYPE_PLUS' ? 1 : -1;
        const cover =
          typeOutside && sign === outsideSign
            ? section.covers.outsideMm
            : typeOutside
              ? section.covers.insideMm
              : section.covers.outsideMm;
        return sign * (section.shape.thicknessMm / 2 - cover - diaMm / 2);
      },
      memberId,
      sectionId: section.id,
      pattern: section.pattern,
      face: 'ZIGZAG',
    });
  }
}

function addDoubleNet({ paths, frame, section, memberId, typeOutside, holeProfiles }) {
  const vertical = findBar(section, 'VERTICAL');
  const horizontal = findBar(section, 'HORIZONTAL');
  const outerDirection = section.outerBarDirection === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
  const outerBar = outerDirection === 'VERTICAL' ? vertical : horizontal;
  const outerMax = maxDiameter(outerBar);

  for (const [direction, bar] of [
    ['VERTICAL', vertical],
    ['HORIZONTAL', horizontal],
  ]) {
    if (!bar) continue;
    for (const side of ['PLUS', 'MINUS']) {
      const sign = sideToLocalSign(side);
      const outsideSign = typeOutside === 'TYPE_PLUS' ? 1 : -1;
      const cover =
        typeOutside && sign === outsideSign
          ? section.covers.outsideMm
          : typeOutside
            ? section.covers.insideMm
            : section.covers.outsideMm;
      appendDirectionPaths({
        paths,
        frame,
        profile: frame.profile,
        holeProfiles,
        bar,
        direction,
        zForIndex: (_index, diaMm) =>
          faceDepthMm({
            thicknessMm: section.shape.thicknessMm,
            coverMm: cover,
            diaMm,
            sign,
            orientation: direction,
            outerBarDirection: outerDirection,
            outerDirectionMaxDiaMm: outerMax,
          }),
        memberId,
        sectionId: section.id,
        pattern: section.pattern,
        face: side,
      });
    }
  }
}

function addInsideOutside({ paths, frame, section, memberId, typeOutside, holeProfiles }) {
  const outerDirection = section.outerBarDirection === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
  const barsBySide = {
    OUTSIDE: {
      VERTICAL: findBar(section, 'VERTICAL_OUTSIDE'),
      HORIZONTAL: findBar(section, 'HORIZONTAL_OUTSIDE'),
    },
    INSIDE: {
      VERTICAL: findBar(section, 'VERTICAL_INSIDE'),
      HORIZONTAL: findBar(section, 'HORIZONTAL_INSIDE'),
    },
  };

  for (const side of ['OUTSIDE', 'INSIDE']) {
    const sign = sideToLocalSign(side, typeOutside);
    const cover = side === 'OUTSIDE' ? section.covers.outsideMm : section.covers.insideMm;
    const outerDirectionBar = barsBySide[side][outerDirection];
    const outerMax = maxDiameter(outerDirectionBar);
    for (const direction of ['VERTICAL', 'HORIZONTAL']) {
      const bar = barsBySide[side][direction];
      if (!bar) continue;
      appendDirectionPaths({
        paths,
        frame,
        profile: frame.profile,
        holeProfiles,
        bar,
        direction,
        zForIndex: (_index, diaMm) =>
          faceDepthMm({
            thicknessMm: section.shape.thicknessMm,
            coverMm: cover,
            diaMm,
            sign,
            orientation: direction,
            outerBarDirection: outerDirection,
            outerDirectionMaxDiaMm: outerMax,
          }),
        memberId,
        sectionId: section.id,
        pattern: section.pattern,
        face: side,
      });
    }
  }
}

function pointOnSegment(point, a, b, tolerance = 1e-6) {
  const ab = sub2(b, a);
  const ap = sub2(point, a);
  const length = magnitude2(ab);
  if (!(length > EPS)) return magnitude2(ap) <= tolerance;
  if (Math.abs(cross2(ab, ap)) > tolerance * length) return false;
  const projection = dot2(ap, ab);
  return projection >= -tolerance && projection <= dot2(ab, ab) + tolerance;
}

function pointInPolygon(point, profile) {
  let inside = false;
  for (let i = 0, j = profile.length - 1; i < profile.length; j = i, i += 1) {
    const a = profile[j];
    const b = profile[i];
    if (pointOnSegment(point, a, b)) return true;
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function segmentIntersectionParameter(start, end, a, b) {
  const r = sub2(end, start);
  const s = sub2(b, a);
  const denominator = cross2(r, s);
  if (Math.abs(denominator) <= EPS) return null;
  const delta = sub2(a, start);
  const t = cross2(delta, s) / denominator;
  const u = cross2(delta, r) / denominator;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return Math.max(0, Math.min(1, t));
}

function uniqueSorted(values, tolerance = 1e-8) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    if (result.length === 0 || Math.abs(value - result[result.length - 1]) > tolerance) {
      result.push(value);
    }
  }
  return result;
}

function clipSegmentToMaterial(start, end, wallProfile, holeProfiles) {
  const tValues = [0, 1];
  const polygons = [wallProfile, ...holeProfiles];
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const t = segmentIntersectionParameter(
        start,
        end,
        polygon[index],
        polygon[(index + 1) % polygon.length],
      );
      if (t != null) tValues.push(t);
    }
  }

  const sorted = uniqueSorted(tValues);
  const direction = sub2(end, start);
  const segments = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const t0 = sorted[index];
    const t1 = sorted[index + 1];
    if (t1 - t0 <= EPS) continue;
    const mid = add2(start, scale2(direction, (t0 + t1) / 2));
    if (!pointInPolygon(mid, wallProfile)) continue;
    if (holeProfiles.some((profile) => pointInPolygon(mid, profile))) continue;
    segments.push([add2(start, scale2(direction, t0)), add2(start, scale2(direction, t1))]);
  }
  return segments;
}

function openingFace(section, index) {
  if (section.pattern === 'SINGLE') return 'CENTER';
  if (section.pattern === 'INSIDE_OUTSIDE') return index % 2 === 0 ? 'OUTSIDE' : 'INSIDE';
  return index % 2 === 0 ? 'PLUS' : 'MINUS';
}

function openingFaceGroupIndex(section, index) {
  return section.pattern === 'SINGLE' ? index : Math.floor(index / 2);
}

function openingFaceDepth(section, typeOutside, face, diaMm) {
  const sign = sideToLocalSign(face, typeOutside);
  if (face === 'CENTER' || sign === 0) return 0;
  let cover = section.covers.outsideMm;
  if (face === 'OUTSIDE') cover = section.covers.outsideMm;
  else if (face === 'INSIDE') cover = section.covers.insideMm;
  else if (typeOutside) {
    const outsideSign = typeOutside === 'TYPE_PLUS' ? 1 : -1;
    cover = sign === outsideSign ? section.covers.outsideMm : section.covers.insideMm;
  }
  return sign * (section.shape.thicknessMm / 2 - cover - diaMm / 2);
}

function openingBarLength(bar, openingGeometry) {
  if (bar.lengthMm > 0) return { value: bar.lengthMm, source: 'EXPLICIT' };
  // ST-Bridgeではlengthを省略できる。施工長を推定せず、表示用の最小長として
  // V/Hは対応する開口辺長、斜め筋は短辺長を採用する。
  if (bar.pos === 'VERTICAL') return { value: openingGeometry.height, source: 'OPENING_EDGE' };
  if (bar.pos === 'HORIZONTAL') return { value: openingGeometry.width, source: 'OPENING_EDGE' };
  return { value: Math.min(openingGeometry.width, openingGeometry.height), source: 'OPENING_EDGE' };
}

function openingPathMetadata({
  memberId,
  section,
  opening,
  bar,
  diaMm,
  diaName,
  face,
  index,
  location,
  segmentIndex,
  lengthInfo,
}) {
  return {
    coordinateSpace: 'world',
    dia: diaMm,
    diaName,
    memberType: 'wall',
    memberId: String(memberId),
    sectionId: String(section.id),
    pattern: section.pattern,
    position: bar.pos,
    face,
    strength: bar.strength,
    role: 'wallOpening',
    openingId: String(opening.id || ''),
    openingSectionId: String(opening.sectionId || ''),
    openingBarSource: opening.barSource,
    openingLocation: location,
    openingBarIndex: index,
    openingBarCount: bar.count,
    openingLengthMm: lengthInfo.value,
    openingLengthSource: lengthInfo.source,
    identityKey: `wall:${memberId}:opening:${opening.id}:${bar.pos}:${location}:${face}:${index}:${segmentIndex}:${diaMm}`,
  };
}

function appendOpeningLine({ paths, frame, wallProfile, holeProfiles, start, end, z, metadata }) {
  const clipped = clipSegmentToMaterial(start, end, wallProfile, holeProfiles);
  clipped.forEach(([segmentStart, segmentEnd], segmentIndex) => {
    if (magnitude2(sub2(segmentEnd, segmentStart)) <= EPS) return;
    paths.push(
      createRebarPath(
        [
          createLine(
            localToWorld(frame, { ...segmentStart, z }),
            localToWorld(frame, { ...segmentEnd, z }),
          ),
        ],
        { ...metadata(segmentIndex) },
      ),
    );
  });
}

function addOpeningEdgeBars({
  paths,
  frame,
  section,
  memberId,
  typeOutside,
  openingGeometry,
  holeProfiles,
  bar,
}) {
  const [p0, p1, p2, p3] = openingGeometry.profile;
  const edgeDefinitions =
    bar.pos === 'VERTICAL'
      ? [
          {
            location: 'LEFT',
            start: p0,
            end: p3,
            tangent: openingGeometry.uy,
            outward: scale2(openingGeometry.ux, -1),
          },
          {
            location: 'RIGHT',
            start: p1,
            end: p2,
            tangent: openingGeometry.uy,
            outward: openingGeometry.ux,
          },
        ]
      : [
          {
            location: 'BOTTOM',
            start: p0,
            end: p1,
            tangent: openingGeometry.ux,
            outward: scale2(openingGeometry.uy, -1),
          },
          {
            location: 'TOP',
            start: p3,
            end: p2,
            tangent: openingGeometry.ux,
            outward: openingGeometry.uy,
          },
        ];

  for (const edge of edgeDefinitions) {
    for (let index = 0; index < bar.count; index += 1) {
      const diaMm = barDiameter(bar, index);
      if (!(diaMm > 0)) continue;
      const face = openingFace(section, index);
      const sameFaceIndex = openingFaceGroupIndex(section, index);
      // Nは「1辺あたりの合計本数」。面内ピッチ情報は無いため、同一面に2本目以降が
      // 必要な場合のみ鉄筋径ぶん外側へずらす表示規則とする。
      const edgeOffset = diaMm / 2 + sameFaceIndex * diaMm;
      const center = add2(midpoint2(edge.start, edge.end), scale2(edge.outward, edgeOffset));
      const lengthInfo = openingBarLength(bar, openingGeometry);
      const half = lengthInfo.value / 2;
      const start = add2(center, scale2(edge.tangent, -half));
      const end = add2(center, scale2(edge.tangent, half));
      const z = openingFaceDepth(section, typeOutside, face, diaMm);
      appendOpeningLine({
        paths,
        frame,
        wallProfile: frame.profile,
        holeProfiles,
        start,
        end,
        z,
        metadata: (segmentIndex) =>
          openingPathMetadata({
            memberId,
            section,
            opening: openingGeometry.opening,
            bar,
            diaMm,
            diaName: barDesignation(bar, index),
            face,
            index,
            location: edge.location,
            segmentIndex,
            lengthInfo,
          }),
      });
    }
  }
}

function addOpeningDiagonalBars({
  paths,
  frame,
  section,
  memberId,
  typeOutside,
  openingGeometry,
  holeProfiles,
  bar,
}) {
  const [p0, p1, p2, p3] = openingGeometry.profile;
  const ux = openingGeometry.ux;
  const uy = openingGeometry.uy;
  // 斜め開口補強筋は、開口隅から外側へ50mm離した位置を通る45°筋とする。
  // 「外側」は各隅角の二等分線方向、筋方向はその直交方向なので、
  // 開口内部を横断せず、隅角の上下/左右のコンクリート領域を直線で結ぶ。
  const corners = [
    {
      location: 'BOTTOM_LEFT',
      point: p0,
      outward: normalize2(add2(scale2(ux, -1), scale2(uy, -1))),
      direction: normalize2(add2(ux, scale2(uy, -1))),
    },
    {
      location: 'BOTTOM_RIGHT',
      point: p1,
      outward: normalize2(add2(ux, scale2(uy, -1))),
      direction: normalize2(add2(ux, uy)),
    },
    {
      location: 'TOP_RIGHT',
      point: p2,
      outward: normalize2(add2(ux, uy)),
      direction: normalize2(add2(ux, scale2(uy, -1))),
    },
    {
      location: 'TOP_LEFT',
      point: p3,
      outward: normalize2(add2(scale2(ux, -1), uy)),
      direction: normalize2(add2(ux, uy)),
    },
  ];

  for (const corner of corners) {
    if (!corner.direction || !corner.outward) continue;
    for (let index = 0; index < bar.count; index += 1) {
      const diaMm = barDiameter(bar, index);
      if (!(diaMm > 0)) continue;
      const face = openingFace(section, index);
      const sameFaceIndex = openingFaceGroupIndex(section, index);
      // Nは1隅あたりの合計本数。表裏の1組目は隅角から50mm、
      // 同一面に2本目以降がある場合は鉄筋径ぶんさらに外側へ送る。
      const cornerOffset = OPENING_DIAGONAL_CORNER_OFFSET_MM + sameFaceIndex * diaMm;
      const center = add2(corner.point, scale2(corner.outward, cornerOffset));
      const lengthInfo = openingBarLength(bar, openingGeometry);
      const half = lengthInfo.value / 2;
      const start = add2(center, scale2(corner.direction, -half));
      const end = add2(center, scale2(corner.direction, half));
      const z = openingFaceDepth(section, typeOutside, face, diaMm);
      appendOpeningLine({
        paths,
        frame,
        wallProfile: frame.profile,
        holeProfiles,
        start,
        end,
        z,
        metadata: (segmentIndex) =>
          openingPathMetadata({
            memberId,
            section,
            opening: openingGeometry.opening,
            bar,
            diaMm,
            diaName: barDesignation(bar, index),
            face,
            index,
            location: corner.location,
            segmentIndex,
            lengthInfo,
          }),
      });
    }
  }
}

function addOpeningRebars({ paths, frame, section, memberId, typeOutside, openingGeometries }) {
  const holeProfiles = openingGeometries.map((opening) => opening.profile);
  for (const openingGeometry of openingGeometries) {
    for (const bar of openingGeometry.opening.bars || []) {
      if (bar.pos === 'VERTICAL' || bar.pos === 'HORIZONTAL') {
        addOpeningEdgeBars({
          paths,
          frame,
          section,
          memberId,
          typeOutside,
          openingGeometry,
          holeProfiles,
          bar,
        });
      } else if (bar.pos === 'DIAGONAL') {
        addOpeningDiagonalBars({
          paths,
          frame,
          section,
          memberId,
          typeOutside,
          openingGeometry,
          holeProfiles,
          bar,
        });
      }
    }
  }
}

/** wall section + wall frameからworld RebarPath[]を作る。 */
export function buildWallRebarPaths({
  frame,
  section,
  memberId,
  typeOutside = null,
  openings = [],
}) {
  if (!frame || !section || section.shape?.type !== 'STRAIGHT') return [];
  const openingGeometries = openings.map(openingProfileGeometry).filter(Boolean);
  const holeProfiles = openingGeometries.map((opening) => opening.profile);
  const paths = [];
  if (section.pattern === 'SINGLE') addSingle({ paths, frame, section, memberId, holeProfiles });
  else if (section.pattern === 'ZIGZAG')
    addZigzag({ paths, frame, section, memberId, typeOutside, holeProfiles });
  else if (section.pattern === 'DOUBLE_NET')
    addDoubleNet({ paths, frame, section, memberId, typeOutside, holeProfiles });
  else if (section.pattern === 'INSIDE_OUTSIDE') {
    addInsideOutside({ paths, frame, section, memberId, typeOutside, holeProfiles });
  }

  addOpeningRebars({
    paths,
    frame,
    section,
    memberId,
    typeOutside,
    openingGeometries,
  });
  return paths;
}

export const __testOnly = {
  pitchPositions,
  scanlineIntervals,
  subtractIntervals,
  sideToLocalSign,
  openingProfileGeometry,
  clipSegmentToMaterial,
};
