/**
 * Issue #510: wall-local rectangular openings; separate internal loops or one boundary notch.
 * Model-mm axis elevation; no camera state and no silent hole omission.
 * Perimeter openings become notches. Interior openings become inner loops.
 * SVG/DXF wall filling must be disabled for the two-loop representation.
 */
const EPS = 1e-6;
const unsupported = (reason) => ({ status: 'unsupported', reason });
const close = (a, b) => Math.abs(a - b) <= EPS;
const positive = (v) => Number.isFinite(v) && v > EPS;

function numberAttr(node, attr) {
  const value = node?.getAttribute(attr);
  return value == null || value.trim() === '' ? NaN : Number(value);
}

function rectContour(r) {
  return [
    [r.left, r.bottom],
    [r.right, r.bottom],
    [r.right, r.top],
    [r.left, r.top],
  ];
}

function subtractBoundaryOpening(wall, hole) {
  const b = close(hole.bottom, wall.bottom);
  const t = close(hole.top, wall.top);
  const l = close(hole.left, wall.left);
  const r = close(hole.right, wall.right);
  if ([b, t, l, r].filter(Boolean).length !== 1) return null;
  const { left: L, right: R, bottom: B, top: T } = wall;
  const { left: x1, right: x2, bottom: y1, top: y2 } = hole;
  if (b)
    return [
      [L, B],
      [x1, B],
      [x1, y2],
      [x2, y2],
      [x2, B],
      [R, B],
      [R, T],
      [L, T],
    ];
  if (t)
    return [
      [L, B],
      [R, B],
      [R, T],
      [x2, T],
      [x2, y1],
      [x1, y1],
      [x1, T],
      [L, T],
    ];
  if (l)
    return [
      [L, B],
      [R, B],
      [R, T],
      [L, T],
      [L, y2],
      [x2, y2],
      [x2, y1],
      [L, y1],
    ];
  return [
    [L, B],
    [R, B],
    [R, y1],
    [x1, y1],
    [x1, y2],
    [R, y2],
    [R, T],
    [L, T],
  ];
}

/**
 * Cut several strictly disjoint rectangular notches from the perimeter.
 * Keep the original counter-clockwise winding and emit only one connected
 * external loop. True inner windows are emitted as separate loops elsewhere.
 */
function subtractDisjointBoundaryOpenings(wall, boundaryHoles) {
  const { left: L, right: R, bottom: B, top: T } = wall;
  const points = [[L, B]];
  const add = (point) => {
    const previous = points[points.length - 1];
    if (!close(previous[0], point[0]) || !close(previous[1], point[1])) points.push(point);
  };
  const onBottom = boundaryHoles.filter((h) => close(h.bottom, B)).sort((a, b) => a.left - b.left);
  for (const h of onBottom) {
    add([h.left, B]);
    add([h.left, h.top]);
    add([h.right, h.top]);
    add([h.right, B]);
  }
  add([R, B]);
  const onRight = boundaryHoles
    .filter((h) => close(h.right, R))
    .sort((a, b) => a.bottom - b.bottom);
  for (const h of onRight) {
    add([R, h.bottom]);
    add([h.left, h.bottom]);
    add([h.left, h.top]);
    add([R, h.top]);
  }
  add([R, T]);
  const onTop = boundaryHoles.filter((h) => close(h.top, T)).sort((a, b) => b.right - a.right);
  for (const h of onTop) {
    add([h.right, T]);
    add([h.right, h.bottom]);
    add([h.left, h.bottom]);
    add([h.left, T]);
  }
  add([L, T]);
  const onLeft = boundaryHoles.filter((h) => close(h.left, L)).sort((a, b) => b.top - a.top);
  for (const h of onLeft) {
    add([L, h.top]);
    add([h.right, h.top]);
    add([h.right, h.bottom]);
    add([L, h.bottom]);
  }
  return points;
}

/**
 * The STB wall's first/second ordered, offset-adjusted nodes establish the
 * wall-local X axis. Opening position_X/Y is relative to the first node.
 */
export function resolveWallElevationContours({
  document,
  wall,
  points3d,
  axisDirection,
  wallBounds,
} = {}) {
  if (!['X', 'Y'].includes(axisDirection)) throw new TypeError('通り芯方向が不正です。');
  const horizontal = axisDirection === 'X' ? 'y' : 'x';
  const original = rectContour(wallBounds);
  const references = Array.from(wall.getElementsByTagNameNS('*', 'StbOpenId'));
  const arrangements = Array.from(
    document.getElementsByTagNameNS('*', 'StbOpenArrangement'),
  ).filter(
    (item) =>
      item.getAttribute('id_member') === wall.getAttribute('id') &&
      (!item.getAttribute('kind_member') ||
        item.getAttribute('kind_member').toUpperCase() === 'WALL'),
  );
  if (!references.length && !arrangements.length)
    return { status: 'outlines', contours: [original], openingCount: 0 };
  const matches = arrangements.slice();
  for (const ref of references) {
    const id = ref.getAttribute('id');
    const candidates = Array.from(document.getElementsByTagNameNS('*', 'StbOpen')).filter(
      (item) => item.getAttribute('id') === id,
    );
    if (!id || candidates.length !== 1)
      return unsupported('STB開口参照が存在しないか重複しています。');
    if (!matches.some((item) => item.getAttribute('id') === id)) matches.push(candidates[0]);
  }
  if (matches.length === 0) return unsupported('壁開口を特定できません。');
  const holes = [];
  for (const opening of matches) {
    const positionX = numberAttr(opening, 'position_X');
    const positionY = numberAttr(opening, 'position_Y');
    const rotate = opening.getAttribute('rotate') == null ? 0 : numberAttr(opening, 'rotate');
    if (![positionX, positionY, rotate].every(Number.isFinite))
      return unsupported('壁開口の位置・回転に不正値があります。');
    const sectionId = opening.getAttribute('id_section');
    const sectionMatches = Array.from(document.getElementsByTagNameNS('*', 'StbSecOpen_RC')).filter(
      (item) => sectionId && item.getAttribute('id') === sectionId,
    );
    if (sectionMatches.length > 1) return unsupported('開口断面IDが重複しています。');
    const section = sectionMatches[0] || null;
    const width = Number.isFinite(numberAttr(opening, 'length_X'))
      ? numberAttr(opening, 'length_X')
      : numberAttr(section, 'length_X');
    const height = Number.isFinite(numberAttr(opening, 'length_Y'))
      ? numberAttr(opening, 'length_Y')
      : numberAttr(section, 'length_Y');
    if (!positive(width) || !positive(height))
      return unsupported('開口の幅・高さが定義されていません。');

    const first = points3d[0];
    const second = points3d[1];
    const horizontalDelta = second[horizontal] - first[horizontal];
    if (Math.abs(horizontalDelta) <= EPS || Math.abs(second.z - first.z) > EPS)
      return unsupported('第1・第2基準点から壁ローカルX軸を確定できません。');
    const sign = Math.sign(horizontalDelta);
    const radians = (rotate * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const corners = [
      [0, 0],
      [width, 0],
      [width, height],
      [0, height],
    ].map(([x, y]) => [
      first[horizontal] + sign * (positionX + x * cos - y * sin),
      first.z + positionY + x * sin + y * cos,
    ]);
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const hole = {
      left: Math.min(...xs),
      right: Math.max(...xs),
      bottom: Math.min(...ys),
      top: Math.max(...ys),
    };
    if (!positive(hole.right - hole.left) || !positive(hole.top - hole.bottom))
      return unsupported('開口形状が矩形になりません。');
    if (
      hole.left < wallBounds.left - EPS ||
      hole.right > wallBounds.right + EPS ||
      hole.bottom < wallBounds.bottom - EPS ||
      hole.top > wallBounds.top + EPS
    )
      return unsupported('開口が壁外周をはみ出しています。');
    const aligned = corners.every(
      ([x, y]) =>
        (close(x, hole.left) || close(x, hole.right)) &&
        (close(y, hole.bottom) || close(y, hole.top)),
    );
    if (!aligned) return unsupported('回転開口の非矩形輪郭は未対応です。');
    const touches = [
      close(hole.left, wallBounds.left),
      close(hole.right, wallBounds.right),
      close(hole.bottom, wallBounds.bottom),
      close(hole.top, wallBounds.top),
    ].filter(Boolean).length;
    holes.push({ hole, touches });
  }

  if (holes.length > 1) {
    if (holes.some((entry) => entry.touches > 1))
      return unsupported('2辺以上に接する開口は未対応です。');
    // All openings must be strictly disjoint before composing either holes or
    // boundary notches. Touching edges also require a true polygon union.
    for (let i = 0; i < holes.length; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        const a = holes[i].hole;
        const b = holes[j].hole;
        if (
          a.left <= b.right + EPS &&
          b.left <= a.right + EPS &&
          a.bottom <= b.top + EPS &&
          b.bottom <= a.top + EPS
        )
          return unsupported('複数開口が接触または重複しているため輪郭を確定できません。');
      }
    }
    const boundary = holes.filter((entry) => entry.touches === 1).map((entry) => entry.hole);
    const internal = holes.filter((entry) => entry.touches === 0).map((entry) => entry.hole);
    return {
      status: 'outlines',
      contours: [
        boundary.length ? subtractDisjointBoundaryOpenings(wallBounds, boundary) : original,
        ...internal.map(rectContour),
      ],
      openingCount: holes.length,
    };
  }

  const { hole, touches } = holes[0];
  if (touches === 0)
    return { status: 'outlines', contours: [original, rectContour(hole)], openingCount: 1 };
  const notch = subtractBoundaryOpening(wallBounds, hole);
  if (!notch) return unsupported('複数辺に接する開口の輪郭は未対応です。');
  return { status: 'outlines', contours: [notch], openingCount: 1 };
}
