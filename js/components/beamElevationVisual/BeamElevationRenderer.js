/**
 * @fileoverview 梁立面図（貫通孔配置可能範囲）SVGレンダラー
 *
 * beamElevation 抽出データ（DOM検索・状態アクセスを含まないプレーンオブジェクト）
 * から、連続梁の柱・梁・主筋・カットオフ・柱内定着・貫通孔配置可能範囲を
 * 描いた立面SVGを生成する。純粋なSVG構築のみを行い、globalStateには依存しない。
 *
 * @module components/beamElevationVisual/BeamElevationRenderer
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 描画色 */
const COLORS = {
  column: '#dee2e6',
  columnStroke: '#495057',
  beamStroke: '#212529',
  topBar: '#c92a2a',
  bottomBar: '#1864ab',
  secondLayer: '#e8590c',
  stirrup: '#868e96',
  webBar: '#7048e8',
  slab: 'rgba(134, 142, 150, 0.25)',
  openingZone: 'rgba(43, 138, 62, 0.12)',
  openingZoneStroke: '#2b8a3e',
  forbiddenZone: 'rgba(201, 42, 42, 0.08)',
  dimension: '#495057',
  axis: '#1098ad',
  text: '#212529',
  ng: '#c92a2a',
};

const FONT = 'sans-serif';

/**
 * 文字サイズ [px]。アプリのCSSトークン（variables.css）と同じ値を使い、
 * 他のウィンドウと見た目の大きさを揃える。
 * SVGは等倍（1SVG単位=1CSSピクセル）で表示する前提。
 */
const FONT_SIZES = {
  /** --font-size-base 16px: 図面タイトル */
  title: 16,
  /** --font-size-sm 14px: 情報行・強調ラベル */
  body: 14,
  /** --font-size-xs 12px: 寸法値・凡例・部材ラベル */
  small: 12,
};

/** 注記が収まるように確保する梁の最小描画高さ [px] */
const MIN_BEAM_DEPTH_PX = 150;

/** 情報ブロック・寸法段の行送り [px] */
const TITLE_Y = 26;
const INFO_LINE_HEIGHT = 20;
const LEGEND_TOP = 26;
const LEGEND_LINE_HEIGHT = 20;
const DIM_ROW_HEIGHT = 30;
/** 通り芯記号（丸）の半径 [px] */
const AXIS_MARK_RADIUS = 14;

/**
 * 配筋表の構成。
 * 列は 始端 / 中央 / 終端（横並び）、行は 上端筋 / 下端筋 / あばら筋（縦並び）。
 */
const BAR_TABLE_POSITIONS = [
  { label: '始端', key: 'start' },
  { label: '中央', key: 'center' },
  { label: '終端', key: 'end' },
];
const BAR_TABLE_ROWS = [
  { label: '上端筋', side: 'top' },
  { label: '下端筋', side: 'bottom' },
  { label: 'あばら筋', side: 'stirrup', merged: true },
];
const BAR_TABLE_ROW_HEIGHT = 19;
/** 表全体の行数（見出し行 + データ行） */
const BAR_TABLE_TOTAL_ROWS = BAR_TABLE_ROWS.length + 1;

/** 凡例項目 */
const LEGEND_ITEMS = [
  { colorKey: 'topBar', label: '上端筋' },
  { colorKey: 'secondLayer', label: '2段筋（カットオフ）' },
  { colorKey: 'bottomBar', label: '下端筋' },
  { colorKey: 'webBar', label: '腹筋' },
  { colorKey: 'openingZoneStroke', label: '貫通孔配置可能範囲' },
];

/**
 * SVG要素を生成
 * @param {string} name - タグ名
 * @param {Object} attrs - 属性
 * @param {string} [textContent] - テキスト内容
 * @returns {SVGElement}
 */
function svgEl(name, attrs = {}, textContent = null) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) el.setAttribute(key, String(value));
  }
  if (textContent !== null) el.textContent = textContent;
  return el;
}

/**
 * テキスト要素を追加
 * @param {SVGElement} parent - 親要素
 * @param {number} x - X座標
 * @param {number} y - Y座標
 * @param {string} text - 文字列
 * @param {Object} [opts] - {size, anchor, fill, weight}
 * @returns {SVGElement}
 */
function addText(parent, x, y, text, opts = {}) {
  const el = svgEl(
    'text',
    {
      x,
      y,
      'font-family': FONT,
      'font-size': opts.size || FONT_SIZES.small,
      'text-anchor': opts.anchor || 'start',
      fill: opts.fill || COLORS.text,
      'font-weight': opts.weight || 'normal',
    },
    text,
  );
  parent.appendChild(el);
  return el;
}

/**
 * 直線を追加
 * @param {SVGElement} parent - 親要素
 * @param {number} x1 - 始点X
 * @param {number} y1 - 始点Y
 * @param {number} x2 - 終点X
 * @param {number} y2 - 終点Y
 * @param {Object} [opts] - {stroke, width, dash}
 * @returns {SVGElement}
 */
function addLine(parent, x1, y1, x2, y2, opts = {}) {
  const el = svgEl('line', {
    x1,
    y1,
    x2,
    y2,
    stroke: opts.stroke || COLORS.beamStroke,
    'stroke-width': opts.width || 1,
    'stroke-dasharray': opts.dash || null,
  });
  parent.appendChild(el);
  return el;
}

/**
 * 折れ線（定着フック等）を追加
 * @param {SVGElement} parent - 親要素
 * @param {Array<[number, number]>} points - 点列
 * @param {Object} [opts] - {stroke, width}
 * @returns {SVGElement}
 */
function addPolyline(parent, points, opts = {}) {
  const el = svgEl('polyline', {
    points: points.map(([x, y]) => `${x},${y}`).join(' '),
    fill: 'none',
    stroke: opts.stroke || COLORS.beamStroke,
    'stroke-width': opts.width || 1.4,
  });
  parent.appendChild(el);
  return el;
}

/**
 * 矩形を追加
 * @param {SVGElement} parent - 親要素
 * @param {number} x - X座標
 * @param {number} y - Y座標
 * @param {number} w - 幅
 * @param {number} h - 高さ
 * @param {Object} [opts] - {fill, stroke, width, dash}
 * @returns {SVGElement}
 */
function addRect(parent, x, y, w, h, opts = {}) {
  const el = svgEl('rect', {
    x,
    y,
    width: w,
    height: h,
    fill: opts.fill || 'none',
    stroke: opts.stroke || null,
    'stroke-width': opts.width || null,
    'stroke-dasharray': opts.dash || null,
  });
  parent.appendChild(el);
  return el;
}

/**
 * 寸法線（両端ティック付き）とラベルを追加
 * @param {SVGElement} parent - 親要素
 * @param {number} x1 - 始点X
 * @param {number} x2 - 終点X
 * @param {number} y - 寸法線Y
 * @param {string} label - ラベル
 * @param {Object} [opts] - {size, above, fill}
 */
function addDimension(parent, x1, x2, y, label, opts = {}) {
  const tick = 4;
  addLine(parent, x1, y, x2, y, { stroke: opts.fill || COLORS.dimension, width: 0.8 });
  for (const x of [x1, x2]) {
    addLine(parent, x - tick, y + tick, x + tick, y - tick, {
      stroke: opts.fill || COLORS.dimension,
      width: 0.8,
    });
    addLine(parent, x, y - 5, x, y + 5, { stroke: opts.fill || COLORS.dimension, width: 0.6 });
  }
  if (label) {
    const size = opts.size || FONT_SIZES.small;
    addText(parent, (x1 + x2) / 2, y + (opts.above ? -6 : size + 4), label, {
      size,
      anchor: 'middle',
      fill: opts.fill || COLORS.dimension,
    });
  }
}

/**
 * mm値を丸めて表示用文字列へ
 * @param {number} value - mm値
 * @returns {string}
 */
function fmt(value) {
  return `${Math.round(value)}`;
}

/**
 * 梁立面図SVGを生成する
 * @param {Object} data - extractBeamElevationData の戻り値（error なし）
 * @param {Object} [options] - {drawWidth, layouts: スパンごとの配筋レイアウト}
 * @returns {{svg: SVGSVGElement, width: number, height: number}}
 */
export function renderBeamElevationSvg(data, options = {}) {
  const { supports, beam } = data;
  const layouts = options.layouts || [];

  const marginL = 90;
  const marginR = 90;
  const drawWidth = Math.max(options.drawWidth || 900, 320);

  // 単一スパンにフォーカスする場合は、そのスパンの範囲だけを拡大して描く
  const focusIndex = Number.isInteger(options.focusSpanIndex) ? options.focusSpanIndex : null;
  const focusSpan = focusIndex !== null ? data.spans[focusIndex] : null;
  const view = focusSpan
    ? buildFocusView(data, focusSpan)
    : { startMm: 0, endMm: data.totalLength, spans: data.spans, supports };
  const spans = view.spans;
  const visibleSupports = view.supports;
  const viewLength = Math.max(view.endMm - view.startMm, 1);

  const scale = drawWidth / viewLength;
  const mmToX = (mm) => marginL + (mm - view.startMm) * scale;
  // 縦方向は梁のレベル差（段差梁）を含む範囲で決める
  const viewLevelTop = Math.max(
    ...spans.map((span) => Math.max(span.topLevelStart, span.topLevelEnd)),
  );
  const viewLevelBottom = Math.min(
    ...spans.map((span) => Math.min(span.topLevelStart, span.topLevelEnd) - span.section.depth),
  );
  const levelRangeMm = Math.max(viewLevelTop - viewLevelBottom, 1);
  const viewMaxDepth = Math.max(...spans.map((span) => span.section.depth));
  // 注記が収まる高さを下限とする（下回る場合は縦方向のみ拡大表示）
  const depthPx = Math.max(levelRangeMm * scale, MIN_BEAM_DEPTH_PX);
  const depthScale = depthPx / levelRangeMm;
  const isDepthExaggerated = depthPx > levelRangeMm * scale + 0.5;

  const infoLines = buildInfoLines(data, { isDepthExaggerated, focusSpan });
  const infoBlockBottom = Math.max(
    TITLE_Y + FONT_SIZES.body + infoLines.length * INFO_LINE_HEIGHT,
    LEGEND_TOP + LEGEND_ITEMS.length * LEGEND_LINE_HEIGHT,
  );

  // 梁上部にはカットオフ寸法・孔径ラベル・通り芯記号を置く
  const axisMarkY = infoBlockBottom + AXIS_MARK_RADIUS + 8;
  const beamTop = axisMarkY + AXIS_MARK_RADIUS + 56;
  const beamBottom = beamTop + depthPx;
  /** 絶対レベル[mm] → Y座標[px]（梁のレベル差を図に反映する） */
  const levelToY = (levelMm) => beamTop + (viewLevelTop - levelMm) * depthScale;
  const columnOverhang = Math.min(depthPx * 0.75, 90);
  // 柱符号ラベルの下から寸法段を始める（寸法と柱ラベルの重なりを避ける）
  const dimBaseY = beamBottom + columnOverhang + 34;
  const barTableTop = dimBaseY + 5 * DIM_ROW_HEIGHT + 14;
  const totalWidth = marginL + drawWidth + marginR;
  const totalHeight = barTableTop + BAR_TABLE_TOTAL_ROWS * BAR_TABLE_ROW_HEIGHT + 16;

  const svg = svgEl('svg', {
    xmlns: SVG_NS,
    viewBox: `0 0 ${totalWidth} ${totalHeight}`,
    width: totalWidth,
    height: totalHeight,
    'font-family': FONT,
  });
  addRect(svg, 0, 0, totalWidth, totalHeight, { fill: '#ffffff' });

  drawSupports(svg, {
    supports: visibleSupports,
    mmToX,
    beamTop,
    beamBottom,
    depthPx,
    columnOverhang,
    scale,
    axisMarkY,
  });

  // 隣接スパンが同じ柱で定着ラベルを二重に描かないよう、描画済み位置を共有する
  const anchorLabelDrawn = new Set();
  spans.forEach((span) => {
    drawSpan(svg, {
      span,
      layout: layouts[span.index] || null,
      isSelected: span.index === data.selectedSpanIndex,
      supports,
      mmToX,
      scale,
      depthScale,
      levelToY,
      beamTop,
      beamBottom,
      depthPx,
      dimBaseY,
      anchorLabelDrawn,
      lastSupportIndex: supports.length - 1,
      showSpanLabel: spans.length > 1,
    });
  });

  drawSpanDimensions(svg, { spans, supports: visibleSupports, mmToX, scale, dimBaseY });
  drawBarTable(svg, { spans, mmToX, tableTop: barTableTop });

  // 梁せい寸法（右端）
  const lastSupport = visibleSupports[visibleSupports.length - 1];
  const lastColumnCenterMm = lastSupport.columnCenterMm ?? lastSupport.positionMm;
  drawDepthDimension(svg, {
    x: mmToX(lastColumnCenterMm) + (lastSupport.depthAlongBeam / 2) * scale + 20,
    beamTop,
    beamBottom,
    depth: viewMaxDepth,
  });

  // --- 情報ブロック ---
  const title = [
    data.axisLine ? `${data.axisLine}通り` : null,
    beam.name || beam.sectionName || `${beam.elementType} ${beam.id}`,
    focusSpan
      ? `${focusSpan.name || `スパン${focusSpan.index + 1}`}（${focusSpan.index + 1}/${data.spans.length}スパン）`
      : data.isContinuous
        ? `連続梁 ${data.spans.length}スパン`
        : null,
    '貫通孔配置可能範囲図',
  ]
    .filter(Boolean)
    .join(' ');
  addText(svg, marginL, TITLE_Y, title, { size: FONT_SIZES.title, weight: 'bold' });
  infoLines.forEach((line, index) => {
    addText(svg, marginL, TITLE_Y + FONT_SIZES.body + (index + 1) * INFO_LINE_HEIGHT - 6, line, {
      size: FONT_SIZES.body,
    });
  });

  // 凡例（右上）
  const legendX = totalWidth - marginR - 210;
  LEGEND_ITEMS.forEach((item, index) => {
    const y = LEGEND_TOP + index * LEGEND_LINE_HEIGHT;
    addLine(svg, legendX, y - 4, legendX + 24, y - 4, { stroke: COLORS[item.colorKey], width: 2 });
    addText(svg, legendX + 32, y, item.label, { size: FONT_SIZES.small });
  });

  return { svg, width: totalWidth, height: totalHeight };
}

/**
 * 支点（柱）と通り芯記号を描く
 * @param {SVGElement} svg - SVGルート
 * @param {Object} ctx - 描画コンテキスト
 */
function drawSupports(svg, ctx) {
  const { supports, mmToX, beamTop, beamBottom, depthPx, columnOverhang, scale, axisMarkY } = ctx;

  for (const support of supports) {
    const axisX = mmToX(support.positionMm);
    const columnCenterX = mmToX(support.columnCenterMm ?? support.positionMm);
    const colW = support.depthAlongBeam * scale;

    if (colW > 0) {
      addRect(
        svg,
        columnCenterX - colW / 2,
        beamTop - columnOverhang,
        colW,
        depthPx + columnOverhang * 2,
        {
          fill: COLORS.column,
          stroke: COLORS.columnStroke,
          width: 1,
        },
      );
    }

    // 通り芯線（StbNode位置）。柱矩形は部材オフセット後の実柱芯位置に描く。
    addLine(svg, axisX, axisMarkY + AXIS_MARK_RADIUS, axisX, beamBottom + columnOverhang, {
      stroke: COLORS.axis,
      width: 0.8,
      dash: '12 3 3 3',
    });

    // 通り芯記号（丸＋名前）
    if (support.axisName) {
      svg.appendChild(
        svgEl('circle', {
          cx: axisX,
          cy: axisMarkY,
          r: AXIS_MARK_RADIUS,
          fill: '#ffffff',
          stroke: COLORS.axis,
          'stroke-width': 1.2,
        }),
      );
      addText(svg, axisX, axisMarkY + 5, support.axisName, {
        size: FONT_SIZES.small,
        anchor: 'middle',
        fill: COLORS.axis,
        weight: 'bold',
      });
    }

    // 柱符号・寸法
    const label = [
      support.column?.name,
      support.column?.widthX ? `${fmt(support.column.widthX)}×${fmt(support.column.widthY)}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    if (label) {
      addText(svg, columnCenterX, beamBottom + columnOverhang + 16, label, {
        size: FONT_SIZES.small,
        anchor: 'middle',
      });
    }
  }
}

/**
 * 1スパン分（梁外形・主筋・カットオフ・定着・貫通孔範囲）を描く
 * @param {SVGElement} svg - SVGルート
 * @param {Object} ctx - 描画コンテキスト
 */
function drawSpan(svg, ctx) {
  const { span, layout, isSelected, mmToX, scale, depthScale, levelToY } = ctx;
  const xFaceStart = mmToX(span.faceStartMm);
  const xFaceEnd = mmToX(span.faceEndMm);
  // 梁天端レベル（段差梁・レベル差を反映）とスパンごとの実せいで外形を描く
  const depthPx = span.section.depth * depthScale;
  const yTopStart = levelToY(span.topLevelStart);
  const yTopEnd = levelToY(span.topLevelEnd);
  const beamTop = Math.min(yTopStart, yTopEnd);
  const beamBottom = Math.max(yTopStart, yTopEnd) + depthPx;

  // 梁外形（レベル差がある場合は平行四辺形。選択スパンは太線）
  addPolyline(
    svg,
    [
      [xFaceStart, yTopStart],
      [xFaceEnd, yTopEnd],
      [xFaceEnd, yTopEnd + depthPx],
      [xFaceStart, yTopStart + depthPx],
      [xFaceStart, yTopStart],
    ],
    { stroke: COLORS.beamStroke, width: isSelected ? 2 : 1.2 },
  );

  // --- スラブ（天端＝梁天端。貫通孔を通せない範囲） ---
  const slabDepthMm = layout?.slabDepth ?? span.slab?.depth ?? 0;
  if (slabDepthMm > 0) {
    const slabPx = slabDepthMm * depthScale;
    addPolyline(
      svg,
      [
        [xFaceStart, yTopStart + slabPx],
        [xFaceEnd, yTopEnd + slabPx],
      ],
      { stroke: COLORS.columnStroke, width: 0.8 },
    );
    svg.appendChild(
      svgEl('polygon', {
        points: [
          [xFaceStart, yTopStart],
          [xFaceEnd, yTopEnd],
          [xFaceEnd, yTopEnd + slabPx],
          [xFaceStart, yTopStart + slabPx],
        ]
          .map(([x, y]) => `${x},${y}`)
          .join(' '),
        fill: COLORS.slab,
      }),
    );
    addText(svg, xFaceStart + 6, yTopStart + slabPx - 4, `スラブ t=${fmt(slabDepthMm)}`, {
      size: FONT_SIZES.small,
      fill: COLORS.columnStroke,
    });
  }

  if (ctx.showSpanLabel) {
    // 主筋の線と重ならないよう梁の中ほどに置く
    addText(
      svg,
      (xFaceStart + xFaceEnd) / 2,
      (yTopStart + yTopEnd) / 2 + depthPx * 0.36,
      span.name || `S${span.index + 1}`,
      {
        size: FONT_SIZES.small,
        anchor: 'middle',
        fill: isSelected ? COLORS.text : '#868e96',
        weight: isSelected ? 'bold' : 'normal',
      },
    );
  }

  // --- 主筋（配筋レイアウトがあれば算定位置、無ければかぶり既定値） ---
  // 梁天端からの距離で位置を決め、始端・終端のレベル差に沿わせる
  const topLayers = layout ? layout.layers.filter((l) => l.side === 'top') : [];
  const bottomLayers = layout ? layout.layers.filter((l) => l.side === 'bottom') : [];
  const fallbackCover = 60;
  const offsetTop1 = topLayers[0]
    ? topLayers[0].centerFromTop * depthScale
    : Math.min(fallbackCover * depthScale, depthPx * 0.2);
  const offsetBottom1 = bottomLayers[0]
    ? bottomLayers[0].centerFromTop * depthScale
    : depthPx - Math.min(fallbackCover * depthScale, depthPx * 0.2);
  const yTop1 = yTopStart + offsetTop1;
  const yTop1End = yTopEnd + offsetTop1;
  const yBottom1 = yTopStart + offsetBottom1;
  const yBottom1End = yTopEnd + offsetBottom1;

  // 主筋の水平範囲。
  // 中間支点（連続梁の内側の柱）は主筋を通し筋として左右へつなぐため折り曲げず、
  // 柱を貫通させる。外端（連続梁の両端）のみ柱内で折り曲げ定着とする。
  const startAnchor = span.anchorage.start;
  const endAnchor = span.anchorage.end;
  const isStartExterior = span.startSupportIndex === 0;
  const isEndExterior = span.endSupportIndex === ctx.lastSupportIndex;
  const startColumnHalf = ((startAnchor?.columnDepth || 0) / 2) * scale;
  const endColumnHalf = ((endAnchor?.columnDepth || 0) / 2) * scale;

  const xBarStart = isStartExterior
    ? xFaceStart - (startAnchor ? startAnchor.projectionLa * scale : 0)
    : xFaceStart - startColumnHalf * 2;
  const xBarEnd = isEndExterior
    ? xFaceEnd + (endAnchor ? endAnchor.projectionLa * scale : 0)
    : xFaceEnd + endColumnHalf * 2;

  // 端部の延長分も同じ勾配で伸ばす
  const slopeTop = (yTop1End - yTop1) / Math.max(xFaceEnd - xFaceStart, 1e-6);
  const slopeBottom = (yBottom1End - yBottom1) / Math.max(xFaceEnd - xFaceStart, 1e-6);
  const yAt = (y0, slope, x) => y0 + slope * (x - xFaceStart);
  addLine(svg, xBarStart, yAt(yTop1, slopeTop, xBarStart), xBarEnd, yAt(yTop1, slopeTop, xBarEnd), {
    stroke: COLORS.topBar,
    width: 1.8,
  });
  addLine(
    svg,
    xBarStart,
    yAt(yBottom1, slopeBottom, xBarStart),
    xBarEnd,
    yAt(yBottom1, slopeBottom, xBarEnd),
    { stroke: COLORS.bottomBar, width: 1.8 },
  );

  // 柱内定着のフック（90°折曲げ）は外端のみ
  if (isStartExterior) {
    drawAnchorage(svg, {
      anchorage: startAnchor,
      xFace: xFaceStart,
      direction: -1,
      yTop: yTop1,
      yBottom: yBottom1,
      scale,
      depthScale,
      beamTop,
      beamBottom,
      labelDrawn: ctx.anchorLabelDrawn,
    });
  }
  if (isEndExterior) {
    drawAnchorage(svg, {
      anchorage: endAnchor,
      xFace: xFaceEnd,
      direction: 1,
      yTop: yTop1End,
      yBottom: yBottom1End,
      scale,
      depthScale,
      beamTop,
      beamBottom,
      labelDrawn: ctx.anchorLabelDrawn,
    });
  }

  // --- 腹筋（梁せいに応じた段数。通し筋として描く） ---
  for (const webBar of layout?.webBars || []) {
    const offset = webBar.centerFromTop * depthScale;
    addLine(svg, xFaceStart, yTopStart + offset, xFaceEnd, yTopEnd + offset, {
      stroke: COLORS.webBar,
      width: 1.2,
    });
  }

  // --- 2段筋（カットオフ位置 L0/4 + 15d） ---
  const dimYCutoff = beamTop - 34;
  const yTop2 = topLayers[1]
    ? yTopStart + topLayers[1].centerFromTop * depthScale
    : yTop1 + Math.max(depthPx * 0.06, 7);
  const yBottom2 = bottomLayers[1]
    ? yTopStart + bottomLayers[1].centerFromTop * depthScale
    : yBottom1 - Math.max(depthPx * 0.06, 7);
  const secondLayers = [
    {
      y: yTop2,
      lengthMm: span.cutoff.topCutoffFromFace,
      atStart: span.cutoff.topSecondLayerStart,
      atEnd: span.cutoff.topSecondLayerEnd,
    },
    {
      y: yBottom2,
      lengthMm: span.cutoff.bottomCutoffFromFace,
      atStart: span.cutoff.bottomSecondLayerStart,
      atEnd: span.cutoff.bottomSecondLayerEnd,
    },
  ];
  let dimensioned = false;
  for (const layer of secondLayers) {
    const lengthPx = layer.lengthMm * scale;
    const label = `L0/4+15d=${fmt(layer.lengthMm)}`;
    if (layer.atStart) {
      addLine(svg, xFaceStart, layer.y, xFaceStart + lengthPx, layer.y, {
        stroke: COLORS.secondLayer,
        width: 1.5,
      });
      if (!dimensioned) {
        addDimension(svg, xFaceStart, xFaceStart + lengthPx, dimYCutoff, label, { above: true });
        dimensioned = true;
      }
    }
    if (layer.atEnd) {
      addLine(svg, xFaceEnd - lengthPx, layer.y, xFaceEnd, layer.y, {
        stroke: COLORS.secondLayer,
        width: 1.5,
      });
      if (!dimensioned) {
        addDimension(svg, xFaceEnd - lengthPx, xFaceEnd, dimYCutoff, label, { above: true });
        dimensioned = true;
      }
    }
  }

  // --- 第1あばら筋（柱面から50mm） ---
  for (const [anchor, xFace, sign] of [
    [startAnchor, xFaceStart, 1],
    [endAnchor, xFaceEnd, -1],
  ]) {
    if (!anchor) continue;
    const x = xFace + sign * anchor.firstStirrupFromFace * scale;
    addLine(svg, x, beamTop + 4, x, beamBottom - 4, { stroke: COLORS.stirrup, width: 1 });
  }

  // --- 貫通孔配置可能範囲 ---
  drawOpeningZone(svg, {
    span,
    layout,
    mmToX,
    depthScale,
    // 孔の位置は梁天端からの距離で決まるため、スパンの天端レベルを基準にする
    spanTopY: (yTopStart + yTopEnd) / 2,
    depthPx,
    dimBaseY: ctx.dimBaseY,
  });
}

/**
 * 柱内定着（90°折曲げフック）を描く
 * @param {SVGElement} svg - SVGルート
 * @param {Object} ctx - 描画コンテキスト
 */
function drawAnchorage(svg, ctx) {
  const { anchorage, xFace, direction, yTop, yBottom, scale, depthScale, beamTop, beamBottom } =
    ctx;
  if (!anchorage) return;

  const laPx = anchorage.projectionLa * scale;
  const xBend = xFace + direction * laPx;

  // 上端筋: 下向きに折り曲げ、余長8d
  const tailTopPx = Math.min(anchorage.tailTop * depthScale, beamBottom - yTop - 6);
  addPolyline(
    svg,
    [
      [xBend, yTop],
      [xBend, yTop + tailTopPx],
    ],
    { stroke: COLORS.topBar, width: 1.8 },
  );
  // 下端筋: 上向きに折り曲げ、余長8d
  const tailBottomPx = Math.min(anchorage.tailBottom * depthScale, yBottom - beamTop - 6);
  addPolyline(
    svg,
    [
      [xBend, yBottom],
      [xBend, yBottom - tailBottomPx],
    ],
    { stroke: COLORS.bottomBar, width: 1.8 },
  );

  // 投影定着長さ La と余長の寸法（隣接スパンで同じ柱に二重表示しない）。
  // 柱の中心位置をキーにすると、左右どちらのスパンから描いても同じ値になる。
  const labelKey = Math.round(xFace + direction * (anchorage.columnDepth / 2) * scale);
  if (ctx.labelDrawn?.has(labelKey)) return;
  ctx.labelDrawn?.add(labelKey);

  addDimension(svg, Math.min(xFace, xBend), Math.max(xFace, xBend), beamTop - 14, null);
  addText(
    svg,
    (xFace + xBend) / 2,
    beamTop - 18,
    `La=${fmt(anchorage.projectionLa)} 余長${fmt(anchorage.tailTop)}`,
    { size: FONT_SIZES.small, anchor: 'middle', fill: COLORS.dimension },
  );
}

/**
 * 貫通孔の配置可能範囲・例示孔を描く
 * @param {SVGElement} svg - SVGルート
 * @param {Object} ctx - 描画コンテキスト
 */
function drawOpeningZone(svg, ctx) {
  const { span, layout, mmToX, depthScale, spanTopY: beamTop, depthPx } = ctx;
  const { opening } = span;
  const xFaceStart = mmToX(span.faceStartMm);
  const xFaceEnd = mmToX(span.faceEndMm);

  const holeDiameter = layout?.hole?.diameter ?? opening.maxDiameter;
  const holeCenterFromTop =
    layout?.hole?.centerFromTop ?? span.section.depth * opening.centerDepthRatio;
  const yCenter = beamTop + holeCenterFromTop * depthScale;
  const holeRadiusPx = (holeDiameter / 2) * depthScale;

  if (!opening.valid) {
    addText(svg, (xFaceStart + xFaceEnd) / 2, beamTop + depthPx * 0.62, '孔配置不可', {
      size: FONT_SIZES.small,
      anchor: 'middle',
      fill: COLORS.ng,
      weight: 'bold',
    });
    return;
  }

  const xZoneStart = mmToX(opening.zoneStart);
  const xZoneEnd = mmToX(opening.zoneEnd);

  // 配置不可範囲（柱面〜可能範囲の間）
  addRect(svg, xFaceStart, beamTop, xZoneStart - xFaceStart, depthPx, {
    fill: COLORS.forbiddenZone,
  });
  addRect(svg, xZoneEnd, beamTop, xFaceEnd - xZoneEnd, depthPx, { fill: COLORS.forbiddenZone });

  // 孔中心の配置可能帯
  addRect(
    svg,
    xZoneStart - holeRadiusPx,
    yCenter - holeRadiusPx,
    xZoneEnd - xZoneStart + holeRadiusPx * 2,
    holeRadiusPx * 2,
    { fill: COLORS.openingZone, stroke: COLORS.openingZoneStroke, width: 1, dash: '6 3' },
  );
  addLine(svg, xZoneStart, yCenter, xZoneEnd, yCenter, {
    stroke: COLORS.openingZoneStroke,
    width: 1,
    dash: '10 4',
  });

  // 例示孔（可能範囲中央。間隔3Hが取れれば2つ）
  const zoneCenterMm = (opening.zoneStart + opening.zoneEnd) / 2;
  const exampleCenters = [zoneCenterMm];
  if (opening.zoneLength >= opening.minCenterSpacing) {
    exampleCenters[0] = zoneCenterMm - opening.minCenterSpacing / 2;
    exampleCenters.push(zoneCenterMm + opening.minCenterSpacing / 2);
  }
  // 主筋と干渉する場合は赤で描く
  const hasInterference = (layout?.checks || []).some(
    (check) => !check.ok && check.label.includes('貫通孔'),
  );
  const holeColor = hasInterference ? COLORS.ng : COLORS.openingZoneStroke;
  for (const centerMm of exampleCenters) {
    svg.appendChild(
      svgEl('circle', {
        cx: mmToX(centerMm),
        cy: yCenter,
        r: holeRadiusPx,
        fill: 'none',
        stroke: holeColor,
        'stroke-width': 1.6,
      }),
    );
  }

  // 孔径は梁内の孔のすぐ下に短く添える（梁上部の定着寸法と重ならないように）。
  // 判定式は情報ブロックに記載する。
  addText(svg, (xZoneStart + xZoneEnd) / 2, yCenter + holeRadiusPx + 14, `φ${fmt(holeDiameter)}`, {
    size: FONT_SIZES.small,
    anchor: 'middle',
    fill: holeColor,
    weight: 'bold',
  });

  // 柱面からの離隔・配置可能範囲（梁下 1段目）
  const dimYClearance = ctx.dimBaseY;
  addDimension(svg, xFaceStart, xZoneStart, dimYClearance, `≥D=${fmt(opening.endClearance)}`);
  addDimension(svg, xZoneEnd, xFaceEnd, dimYClearance, `≥D=${fmt(opening.endClearance)}`);
  addDimension(svg, xZoneStart, xZoneEnd, dimYClearance, `配置可能 ${fmt(opening.zoneLength)}`);

  // 例示孔の中心間隔（梁下 2段目）
  if (exampleCenters.length === 2) {
    addDimension(
      svg,
      mmToX(exampleCenters[0]),
      mmToX(exampleCenters[1]),
      ctx.dimBaseY + DIM_ROW_HEIGHT,
      `中心間隔≥3H=${fmt(opening.minCenterSpacing)}`,
      { fill: COLORS.openingZoneStroke },
    );
  }
}

/**
 * スパン寸法（L0/4 区分・L0・柱芯間）を描く
 * @param {SVGElement} svg - SVGルート
 * @param {Object} ctx - 描画コンテキスト
 */
function drawSpanDimensions(svg, ctx) {
  const { spans, supports, mmToX, scale, dimBaseY } = ctx;
  const dimYQuarter = dimBaseY + DIM_ROW_HEIGHT * 2;
  const dimYClearSpan = dimBaseY + DIM_ROW_HEIGHT * 3;
  const dimYTotal = dimBaseY + DIM_ROW_HEIGHT * 4;

  for (const span of spans) {
    const xFaceStart = mmToX(span.faceStartMm);
    const xFaceEnd = mmToX(span.faceEndMm);
    const quarterPx = (span.clearSpan / 4) * scale;
    addDimension(svg, xFaceStart, xFaceStart + quarterPx, dimYQuarter, 'L0/4');
    addDimension(svg, xFaceStart + quarterPx, xFaceEnd - quarterPx, dimYQuarter, 'L0/2');
    addDimension(svg, xFaceEnd - quarterPx, xFaceEnd, dimYQuarter, 'L0/4');
    addDimension(svg, xFaceStart, xFaceEnd, dimYClearSpan, `L0=${fmt(span.clearSpan)}`);
  }

  // 柱芯間（支点ごと）
  for (let i = 0; i < supports.length - 1; i++) {
    addDimension(
      svg,
      mmToX(supports[i].positionMm),
      mmToX(supports[i + 1].positionMm),
      dimYTotal,
      `L=${fmt(supports[i + 1].positionMm - supports[i].positionMm)}`,
    );
  }
}

/**
 * 梁せい寸法（縦）を描く
 * @param {SVGElement} svg - SVGルート
 * @param {Object} ctx - 描画コンテキスト
 */
function drawDepthDimension(svg, ctx) {
  const { x, beamTop, beamBottom, depth } = ctx;
  addLine(svg, x, beamTop, x, beamBottom, { stroke: COLORS.dimension, width: 0.8 });
  addLine(svg, x - 4, beamTop, x + 4, beamTop, { stroke: COLORS.dimension, width: 0.8 });
  addLine(svg, x - 4, beamBottom, x + 4, beamBottom, { stroke: COLORS.dimension, width: 0.8 });
  const label = addText(svg, x + 10, (beamTop + beamBottom) / 2 + 4, `D=${fmt(depth)}`, {
    size: FONT_SIZES.small,
  });
  label.setAttribute('transform', `rotate(90 ${x + 10} ${(beamTop + beamBottom) / 2 + 4})`);
}

/**
 * 情報ブロックの行テキストを組み立てる
 * @param {Object} data - 立面図データ
 * @param {Object} [scaleInfo] - {isDepthExaggerated}
 * @returns {Array<string>}
 */
function buildInfoLines(data, scaleInfo = {}) {
  const lines = [];
  const span = scaleInfo.focusSpan || data.spans[data.selectedSpanIndex] || data.spans[0];

  lines.push(
    `断面: ${span.sectionName || '-'}  B×D=${fmt(span.section.width)}×${fmt(span.section.depth)}` +
      (span.concreteStrength ? `  Fc=${span.concreteStrength}` : ''),
  );
  lines.push(
    `孔径 H ≤ min(D/3, 750) = φ${fmt(span.opening.maxDiameter)}　` +
      `孔中心は柱面から ≥D=${fmt(span.opening.endClearance)}、中心間隔 ≥3H=${fmt(span.opening.minCenterSpacing)}`,
  );
  if (scaleInfo.isDepthExaggerated) {
    lines.push('※ 縦方向は見やすさのため拡大表示（横方向とは縮尺が異なります）');
  }
  return lines;
}

/**
 * 単一スパンにフォーカスした表示範囲を作る。
 * 前後の柱が収まるよう、支点の柱せい分だけ範囲を広げる。
 * @param {Object} data - 立面図データ
 * @param {Object} focusSpan - 対象スパン
 * @returns {{startMm:number, endMm:number, spans:Array, supports:Array}}
 */
function buildFocusView(data, focusSpan) {
  const startSupport = data.supports[focusSpan.startSupportIndex];
  const endSupport = data.supports[focusSpan.endSupportIndex];
  return {
    startMm: startSupport.positionMm - startSupport.depthAlongBeam / 2 - 100,
    endMm: endSupport.positionMm + endSupport.depthAlongBeam / 2 + 100,
    spans: [focusSpan],
    supports: [startSupport, endSupport],
  };
}

/**
 * 配筋表（スパンごとの始端・中央・終端の主筋／あばら筋）を描く
 * @param {SVGElement} svg - SVGルート
 * @param {Object} ctx - 描画コンテキスト
 */
function drawBarTable(svg, ctx) {
  const { spans, mmToX, tableTop } = ctx;
  if (spans.length === 0) return;

  const labelWidth = 74;
  // 表の左右はスパンの柱面に合わせる（右端に空列を作らない）
  const tableLeft = mmToX(spans[0].faceStartMm);
  const tableRight = mmToX(spans[spans.length - 1].faceEndMm);
  const tableBottom = tableTop + BAR_TABLE_TOTAL_ROWS * BAR_TABLE_ROW_HEIGHT;
  const rowY = (rowIndex) => tableTop + rowIndex * BAR_TABLE_ROW_HEIGHT + BAR_TABLE_ROW_HEIGHT - 5;

  // 外枠と行罫線
  addRect(
    svg,
    tableLeft - labelWidth,
    tableTop,
    tableRight - tableLeft + labelWidth,
    tableBottom - tableTop,
    { stroke: COLORS.dimension, width: 0.8 },
  );
  for (let i = 1; i < BAR_TABLE_TOTAL_ROWS; i++) {
    const y = tableTop + i * BAR_TABLE_ROW_HEIGHT;
    addLine(svg, tableLeft - labelWidth, y, tableRight, y, {
      stroke: i === 1 ? COLORS.dimension : '#dee2e6',
      width: i === 1 ? 0.8 : 0.6,
    });
  }
  // 行見出し列の区切り
  addLine(svg, tableLeft, tableTop, tableLeft, tableBottom, {
    stroke: COLORS.dimension,
    width: 0.8,
  });

  // 行見出し（上端筋 / 下端筋 / あばら筋）
  BAR_TABLE_ROWS.forEach((row, index) => {
    addText(svg, tableLeft - labelWidth + 4, rowY(index + 1), row.label, {
      size: FONT_SIZES.small,
    });
  });

  spans.forEach((span, spanIndex) => {
    const xStart = mmToX(span.faceStartMm);
    const xEnd = mmToX(span.faceEndMm);
    const cellWidth = (xEnd - xStart) / BAR_TABLE_POSITIONS.length;

    // スパンの区切り（1本目の左端は見出し列の罫線と重なるため省略）
    if (spanIndex > 0) {
      addLine(svg, xStart, tableTop, xStart, tableBottom, {
        stroke: COLORS.dimension,
        width: 0.8,
      });
    }

    BAR_TABLE_POSITIONS.forEach((position, columnIndex) => {
      const cellCenter = xStart + cellWidth * (columnIndex + 0.5);

      // 始端 / 中央 / 終端 の見出しと列区切り
      addText(svg, cellCenter, rowY(0), position.label, {
        size: FONT_SIZES.small,
        anchor: 'middle',
        fill: COLORS.dimension,
      });
      if (columnIndex > 0) {
        addLine(
          svg,
          xStart + cellWidth * columnIndex,
          tableTop,
          xStart + cellWidth * columnIndex,
          tableBottom,
          {
            stroke: '#dee2e6',
            width: 0.6,
          },
        );
      }

      BAR_TABLE_ROWS.forEach((row, rowIndex) => {
        // あばら筋はスパンで1つのためセルを結合して中央に出す
        if (row.merged) {
          if (columnIndex !== 0) return;
          addFittedCellText(
            svg,
            (xStart + xEnd) / 2,
            rowY(rowIndex + 1),
            barTableCellText(span, row, 'center'),
            xEnd - xStart,
          );
          return;
        }
        addFittedCellText(
          svg,
          cellCenter,
          rowY(rowIndex + 1),
          barTableCellText(span, row, position.key),
          cellWidth,
        );
      });
    });
  });
}

/**
 * セル幅に収まるよう文字サイズを調整してテキストを置く
 * @param {SVGElement} svg - SVGルート
 * @param {number} centerX - セル中心X
 * @param {number} y - ベースラインY
 * @param {string} text - 文字列
 * @param {number} cellWidth - セル幅 [px]
 */
function addFittedCellText(svg, centerX, y, text, cellWidth) {
  // 日本語・英数混在の概算幅（1文字あたり約0.62em）
  const estimatedWidth = text.length * FONT_SIZES.small * 0.62;
  const available = Math.max(cellWidth - 6, 12);
  const size =
    estimatedWidth <= available
      ? FONT_SIZES.small
      : Math.max((FONT_SIZES.small * available) / estimatedWidth, 7);
  addText(svg, centerX, y, text, { size, anchor: 'middle' });
}

/**
 * 配筋表のセル文字列を取り出す
 * @param {Object} span - スパンデータ
 * @param {{side:string}} row - 行定義
 * @param {string} positionKey - 断面位置（'start' | 'center' | 'end'）
 * @returns {string}
 */
function barTableCellText(span, row, positionKey) {
  const position = span.section[positionKey] || span.section.center || span.section.start;
  if (!position) return '-';
  if (row.side === 'stirrup') return position.stirrupText || '-';
  return (row.side === 'top' ? position.topBarText : position.bottomBarText) || '-';
}

/**
 * SVG要素を文字列へシリアライズ（XML宣言付き・単体ファイル保存用）
 * @param {SVGSVGElement} svg - SVG要素
 * @returns {string}
 */
export function serializeBeamElevationSvg(svg) {
  const source = new XMLSerializer().serializeToString(svg);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${source}`;
}
