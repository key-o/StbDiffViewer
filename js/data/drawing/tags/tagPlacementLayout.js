/**
 * @fileoverview 部材タグの初期配置を表示座標系で解くpure geometry。
 *
 * 座標単位は呼出し側が決める。CSS pxだけでなくpaper-mm display座標にも同じ規則を適用する。
 * 値取得・DOM・保存・選択状態は扱わない。
 */

const DEFAULT_TAG_SIDE_BY_ELEMENT_TYPE = Object.freeze({
  Column: 'top-right',
  Post: 'top-right',
  Girder: 'line-above',
  Beam: 'line-above',
  Brace: 'line-above',
  Wall: 'line-below',
  Slab: 'center',
});

const TAG_GAP_RATIO = 0.3;

export function defaultTagSide(elementType) {
  return DEFAULT_TAG_SIDE_BY_ELEMENT_TYPE[elementType] || 'center';
}

/** 文字幅の概算(全角1em、半角0.6em)。描画前のレイアウト見積りにだけ使う。 */
export function estimateTagTextWidth(text, fontSize) {
  let width = 0;
  for (const char of String(text ?? '')) width += char.charCodeAt(0) > 0xff ? 1 : 0.6;
  return width * fontSize;
}

function emptyExtent() {
  return { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
}

function include(extent, x, y) {
  extent.left = Math.min(extent.left, x);
  extent.right = Math.max(extent.right, x);
  extent.top = Math.min(extent.top, y);
  extent.bottom = Math.max(extent.bottom, y);
}

/**
 * タグ原点を基準にした描画範囲の概算。
 * @returns {{left:number,right:number,top:number,bottom:number}}
 */
export function estimateTagExtent(
  plan,
  { fontSize = 12, paperMmToDisplay = null, paperMmToCss = null } = {},
) {
  const extent = emptyExtent();
  const isPaper = plan.units === 'paper-mm';
  const familyScale = plan.schemaVersion === 2 ? plan.paperScale : 1;
  const paperScale =
    Number.isFinite(paperMmToDisplay) && paperMmToDisplay > 0
      ? paperMmToDisplay
      : Number.isFinite(paperMmToCss) && paperMmToCss > 0
        ? paperMmToCss
        : 1;
  const scale = isPaper ? paperScale * familyScale : 1;
  for (const item of plan.items || []) {
    if (item.kind === 'frame') {
      const [x, y, width, height] = item.rect;
      include(extent, x * scale, y * scale);
      include(extent, (x + width) * scale, (y + height) * scale);
    } else if (item.kind === 'line') {
      for (const [x, y] of item.points) include(extent, x * scale, y * scale);
    } else if (item.kind === 'circled-value' || item.kind === 'circle') {
      const [x, y] = item.point;
      const radius = (item.radius || 0) * scale;
      include(extent, x * scale - radius, y * scale - radius);
      include(extent, x * scale + radius, y * scale + radius);
    } else if (item.point) {
      const size = isPaper ? (item.fontSize ?? 2.8) * scale : fontSize;
      const [x, y] = item.point;
      const half = estimateTagTextWidth(item.text, size) / 2;
      include(extent, x * scale - half, y * scale - size / 2);
      include(extent, x * scale + half, y * scale + size / 2);
    }
  }
  if (!Number.isFinite(extent.left)) return { left: 0, right: 0, top: 0, bottom: 0 };
  return extent;
}

/**
 * 線分部材（外形点群）の中心線: 主軸方向・中心・半幅を表示座標で求める。
 * @param {Array<[number, number]>} points
 */
export function describeLineMember(points) {
  const count = points.length;
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('部材点群が必要です。');
  let meanX = 0;
  let meanY = 0;
  for (const [x, y] of points) {
    meanX += x / count;
    meanY += y / count;
  }
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of points) {
    sxx += (x - meanX) ** 2;
    syy += (y - meanY) ** 2;
    sxy += (x - meanX) * (y - meanY);
  }
  const trace = sxx + syy;
  const root = Math.hypot(sxx - syy, 2 * sxy);
  const major = (trace + root) / 2;
  const minor = (trace - root) / 2;
  let dirX = 1;
  let dirY = 0;
  if (root > 1e-12 && major > minor * 1.2) {
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    dirX = Math.cos(angle);
    dirY = Math.sin(angle);
  }
  if (dirX < -1e-9 || (Math.abs(dirX) <= 1e-9 && dirY < 0)) {
    dirX = -dirX;
    dirY = -dirY;
  }
  const normal = [dirY, -dirX];
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let minAcross = Infinity;
  let maxAcross = -Infinity;
  for (const [x, y] of points) {
    const along = x * dirX + y * dirY;
    const across = x * normal[0] + y * normal[1];
    minAlong = Math.min(minAlong, along);
    maxAlong = Math.max(maxAlong, along);
    minAcross = Math.min(minAcross, across);
    maxAcross = Math.max(maxAcross, across);
  }
  const midAlong = (minAlong + maxAlong) / 2;
  const midAcross = (minAcross + maxAcross) / 2;
  return {
    center: [midAlong * dirX + midAcross * normal[0], midAlong * dirY + midAcross * normal[1]],
    direction: [dirX, dirY],
    normal,
    halfWidth: (maxAcross - minAcross) / 2,
  };
}

/**
 * 初期タグ原点。Y正方向を画面下とするdisplay座標で計算する。
 */
export function computeDefaultTagOriginDisplay({
  elementType,
  centerDisplay,
  points,
  bbox,
  extent,
  fontSize,
}) {
  const [modelCenterX, modelCenterY] = centerDisplay;
  if (!Number.isFinite(fontSize) || fontSize <= 0) return [modelCenterX, modelCenterY];
  const gap = fontSize * TAG_GAP_RATIO;
  const side = defaultTagSide(elementType);
  if (side === 'top-right') return [bbox.maxX + gap - extent.left, bbox.minY - gap - extent.bottom];
  if (side === 'line-above' || side === 'line-below') {
    const line = describeLineMember(points);
    const sign = side === 'line-above' ? 1 : -1;
    const normal = [line.normal[0] * sign, line.normal[1] * sign];
    const halfW = (extent.right - extent.left) / 2;
    const halfH = (extent.bottom - extent.top) / 2;
    const reach = line.halfWidth + gap + Math.abs(normal[0]) * halfW + Math.abs(normal[1]) * halfH;
    return [
      line.center[0] + normal[0] * reach - (extent.left + extent.right) / 2,
      line.center[1] + normal[1] * reach - (extent.top + extent.bottom) / 2,
    ];
  }
  return [modelCenterX, modelCenterY];
}

// 既存viewer API互換。
export function computeDefaultTagOriginCss(input) {
  return computeDefaultTagOriginDisplay({
    elementType: input.elementType,
    centerDisplay: input.centerCss,
    points: input.points,
    bbox: input.bbox,
    extent: input.extent,
    fontSize: input.fontSize,
  });
}
