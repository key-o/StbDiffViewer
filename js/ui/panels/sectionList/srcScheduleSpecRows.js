/**
 * SRC柱・梁のRC型断面リストで共有する仕様項目と表示値。
 * HTML/PDFとDXFで行の順序・欠損表記が異ならないよう、一箇所に集約する。
 */
import { srcConcreteLabel } from './srcSectionDiagram.js';

export const SRC_SCHEDULE_SPEC_ROWS = Object.freeze([
  { label: '断面寸法', value: (v) => srcConcreteLabel(v.concrete) },
  { label: 'Fc', value: (v) => v.concreteStrength || '未指定' },
  { label: '鉄骨', value: (v) => v.shape || '未指定' },
  {
    label: '鉄骨材質',
    value: (v) => [
      v.strengthMain,
      v.strengthWeb && v.strengthWeb !== v.strengthMain ? 'web ' + v.strengthWeb : '',
    ].filter(Boolean).join(' / ') || '未指定',
  },
  { label: '主筋', value: (v) => v.rebar?.main || '未指定' },
  { label: '帯筋・あばら筋', value: (v) => v.rebar?.tie || '未指定' },
].map((row) => Object.freeze(row)));

/** 表示文字列を二重化せず各出力先で利用する。 */
export function srcScheduleSpecValues(variant) {
  return SRC_SCHEDULE_SPEC_ROWS.map(({ value }) => String(value(variant) || '未指定'));
}

/**
 * 2行固定の仕様帯に文字列を収めるため、符号全体で必要な最小スロット幅(px)を推定する。
 * text-overflow:ellipsisに依存するとPDFキャプチャ時に配筋データが欠落するため、
 * 文字列の最長幅から枠を先に確保する。全角は半角2文字として保守的に見積もる。
 */
export function estimateSrcSpecSlotWidthPx(variant, { minWidthPx = 190 } = {}) {
  const values = [variant?.pos || '', ...srcScheduleSpecValues(variant)];
  let maxUnits = 0;
  for (const value of values) {
    let units = 0;
    for (const char of Array.from(value)) {
      const code = char.codePointAt(0);
      units += code <= 0x7f || (code >= 0xff61 && code <= 0xff9f) ? 1 : 2;
    }
    maxUnits = Math.max(maxUnits, units);
  }
  // 12pxフォントで半角当たり最大8.2px程度、上下2行で表示する。
  // パディング、罫線とフォント差のため24pxの余裕を設ける。
  return Math.max(minWidthPx, Math.ceil(maxUnits * 8.2 / 2 + 24));
}
