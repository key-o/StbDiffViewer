/**
 * @fileoverview 鉄筋記号定義（JIS準拠）
 *
 * RC断面図用の鉄筋シンボルをSVG defsとして定義します。
 * JIS鉄筋凡例に準拠した記号を提供し、後から差し替え・編集可能な構造です。
 *
 * JIS鉄筋凡例:
 * - D10: ● 塗りつぶし円（小）
 * - D13: × X印
 * - D16: ⊘ 斜線入り円
 * - D19: ● 塗りつぶし円（大）
 * - D22: ○ 中空円
 * - D25: ⊙ 中心点付き円
 * - D29: ⊗ ×印入り円
 * - D32: ◎ 二重円
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const GENERIC_SYMBOL = { type: 'filled', radius: 5 };

/**
 * 鉄筋記号の定義
 * type: 記号タイプ
 * - 'filled': 塗りつぶし円
 * - 'cross': X印
 * - 'circle-slash': 斜線入り円
 * - 'hollow': 中空円
 * - 'center-dot': 中心点付き円
 * - 'circle-cross': ×印入り円
 * - 'double-circle': 二重円
 */
export const REBAR_SYMBOLS = {
  D10: { type: 'filled', radius: 4 },
  D13: { type: 'cross', size: 5 },
  D16: { type: 'circle-slash', radius: 6 },
  D19: { type: 'filled', radius: 6 },
  D22: { type: 'hollow', radius: 6 },
  D25: { type: 'center-dot', radius: 6, dotRadius: 1.5 },
  D29: { type: 'circle-cross', radius: 6 },
  D32: { type: 'double-circle', outerRadius: 7, innerRadius: 5 },
  D35: { type: 'double-circle', outerRadius: 7, innerRadius: 5 },
  D38: { type: 'double-circle', outerRadius: 7, innerRadius: 5 },
  D41: { type: 'double-circle', outerRadius: 7, innerRadius: 5 },
  // SPR(高強度せん断補強筋)対応 - T系はD系と同じ記号を使用
  T10: { type: 'filled', radius: 4 },
  T13: { type: 'cross', size: 5 },
  T16: { type: 'circle-slash', radius: 6 },
};

/**
 * SVG要素を作成するヘルパー
 * @param {string} name - 要素名
 * @param {Object} attrs - 属性
 * @returns {SVGElement}
 */
export function createSvgElement(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

/**
 * 記号タイプに応じたSVG要素を生成
 * @param {string} type - 記号タイプ
 * @param {Object} config - 設定
 * @returns {SVGElement}
 */
function createSymbolElement(type, config) {
  const g = createSvgElement('g');

  switch (type) {
    case 'filled': {
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: config.radius,
          fill: 'black',
          stroke: 'black',
          'stroke-width': 1,
        }),
      );
      break;
    }

    case 'cross': {
      const size = config.size || 5;
      const inner = createSvgElement('g', {
        stroke: 'black',
        'stroke-width': 1.5,
        fill: 'none',
        'stroke-linecap': 'round',
      });
      inner.appendChild(createSvgElement('line', { x1: -size, y1: -size, x2: size, y2: size }));
      inner.appendChild(createSvgElement('line', { x1: -size, y1: size, x2: size, y2: -size }));
      g.appendChild(inner);
      break;
    }

    case 'circle-slash': {
      const r = config.radius || 6;
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: r,
          fill: 'white',
          stroke: 'black',
          'stroke-width': 1.5,
        }),
      );
      const d = r * 0.707;
      g.appendChild(
        createSvgElement('line', {
          x1: -d,
          y1: -d,
          x2: d,
          y2: d,
          stroke: 'black',
          'stroke-width': 1.5,
        }),
      );
      break;
    }

    case 'hollow': {
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: config.radius || 6,
          fill: 'white',
          stroke: 'black',
          'stroke-width': 1.5,
        }),
      );
      break;
    }

    case 'center-dot': {
      const r = config.radius || 6;
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: r,
          fill: 'white',
          stroke: 'black',
          'stroke-width': 1.5,
        }),
      );
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: config.dotRadius || 1.5,
          fill: 'black',
        }),
      );
      break;
    }

    case 'circle-cross': {
      const r = config.radius || 6;
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: r,
          fill: 'white',
          stroke: 'black',
          'stroke-width': 1.5,
        }),
      );
      const d = r * 0.6;
      const crossGroup = createSvgElement('g', {
        stroke: 'black',
        'stroke-width': 1.2,
      });
      crossGroup.appendChild(createSvgElement('line', { x1: -d, y1: -d, x2: d, y2: d }));
      crossGroup.appendChild(createSvgElement('line', { x1: -d, y1: d, x2: d, y2: -d }));
      g.appendChild(crossGroup);
      break;
    }

    case 'double-circle': {
      const outerR = config.outerRadius || 7;
      const innerR = config.innerRadius || 5;
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: outerR,
          fill: 'white',
          stroke: 'black',
          'stroke-width': 1.5,
        }),
      );
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: innerR,
          fill: 'white',
          stroke: 'black',
          'stroke-width': 1.2,
        }),
      );
      break;
    }

    default:
      g.appendChild(
        createSvgElement('circle', {
          cx: 0,
          cy: 0,
          r: 6,
          fill: 'white',
          stroke: 'black',
          'stroke-width': 1.5,
        }),
      );
  }

  return g;
}

/**
 * 鉄筋記号のdefs定義を追加
 * @param {SVGElement} svg - SVG要素
 * @param {string} prefix - ID接頭辞（省略時は 'bar'）
 */
export function addBarSymbolDefs(svg, prefix = 'bar') {
  const defs = createSvgElement('defs');

  for (const [dia, config] of Object.entries(REBAR_SYMBOLS)) {
    const g = createSvgElement('g', { id: `${prefix}-${dia}` });
    const symbolEl = createSymbolElement(config.type, config);
    g.appendChild(symbolEl);
    defs.appendChild(g);
  }

  const generic = createSvgElement('g', { id: `${prefix}-GENERIC` });
  generic.appendChild(createSymbolElement(GENERIC_SYMBOL.type, GENERIC_SYMBOL));
  defs.appendChild(generic);

  svg.appendChild(defs);
}

/**
 * 鉄筋シンボルを配置
 * @param {SVGElement} svg - SVG要素
 * @param {string} dia - 鉄筋径 (例: D25)
 * @param {number} cx - X座標
 * @param {number} cy - Y座標
 * @param {number} scale - スケール
 * @param {string} prefix - ID接頭辞（省略時は 'bar'）
 */
export function placeBarSymbol(svg, dia, cx, cy, scale = 1, prefix = 'bar') {
  // T系の鉄筋はREBAR_SYMBOLSに定義がない場合、対応するD系を使用
  let symbolDia = dia;
  if (!REBAR_SYMBOLS[dia] && dia.startsWith('T')) {
    symbolDia = 'D' + dia.substring(1);
  }
  // U系高強度筋や将来径など、記号定義外でも鉄筋自体を消さない。
  if (!REBAR_SYMBOLS[symbolDia]) {
    symbolDia = 'GENERIC';
  }
  const use = createSvgElement('use', { href: `#${prefix}-${symbolDia}` });
  use.setAttribute('transform', `translate(${cx}, ${cy}) scale(${scale})`);
  svg.appendChild(use);
  return use;
}

/**
 * 利用可能な鉄筋径リストを取得
 * @returns {string[]}
 */
export function getAvailableDiameters() {
  return Object.keys(REBAR_SYMBOLS);
}
