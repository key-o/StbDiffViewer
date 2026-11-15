/**
 * #565: Paper sizes of a CAD sheet (ISO A series, portrait dimensions in mm).
 * A sheet's `paper` + `orientation` is the only source of its width and height;
 * placements, composition, SVG, PDF and DXF all resolve the size through here.
 */

/** Portrait width x height in mm. */
const PORTRAIT_MM = Object.freeze({
  A4: Object.freeze([210, 297]),
  A3: Object.freeze([297, 420]),
  A2: Object.freeze([420, 594]),
  A1: Object.freeze([594, 841]),
  A0: Object.freeze([841, 1189]),
});

export const SHEET_PAPER_NAMES = Object.freeze(Object.keys(PORTRAIT_MM));
export const DEFAULT_SHEET_PAPER = 'A3';

export function isSheetPaperName(paper) {
  return Object.hasOwn(PORTRAIT_MM, paper);
}

/** Paper size in sheet mm. Throws for an unknown paper or orientation. */
export function getSheetPaperSize(paper = DEFAULT_SHEET_PAPER, orientation = 'landscape') {
  if (!isSheetPaperName(paper)) throw new RangeError('未対応の用紙サイズです: ' + paper);
  if (orientation !== 'landscape' && orientation !== 'portrait')
    throw new RangeError('用紙方向が不正です: ' + orientation);
  const [short, long] = PORTRAIT_MM[paper];
  return orientation === 'portrait'
    ? Object.freeze({ widthMm: short, heightMm: long })
    : Object.freeze({ widthMm: long, heightMm: short });
}

/** "A3 横" style label for lists and status text. */
export function describeSheetPaper(paper, orientation) {
  return `${paper}${orientation === 'portrait' ? '縦' : '横'}`;
}
