/** @fileoverview STB属性値の意味を変更しないタグ書式。丸め・単位換算は行わない。 */
import { normalizeTagValue } from './tagValue.js';

export const TAG_TEXT_FORMATS = Object.freeze(['text', 'dimension', 'level']);
export const TAG_FIGURE_FORMATS = Object.freeze(['section-figure']);

// STB XML Schemaのxs:double字句のうち、図面表記へ使う10進表記だけを数値として受理する。
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function itemsOf(value) {
  return value.shape === 'list' ? value.value : [value.value];
}

function numberOf(text) {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function numberText(n, format) {
  const zero = n === 0 || Object.is(n, -0);
  if (format === 'level') return zero ? '±0' : n > 0 ? `+${n}` : String(n);
  return String(zero ? 0 : n);
}

/** 既知の文字値がすべて数値0か。dimension/levelのomitKnownZero判定に使う。 */
export function isKnownZeroTagValue(input) {
  const value = normalizeTagValue(input);
  if (value.status !== 'known' || value.valueType !== 'text') return false;
  return itemsOf(value).every((item) => numberOf(item) === 0);
}

/**
 * 既知値を表示文字にする。数値書式で数値化できない値はnull（呼出し側でinvalid表示）。
 * listはXPathの文書順を変えず delimiter で結ぶ。
 */
export function formatTagValue(input, format = 'text', { delimiter = '〜' } = {}) {
  const value = normalizeTagValue(input);
  if (value.valueType !== 'text' || !TAG_TEXT_FORMATS.includes(format))
    throw new TypeError('タグ書式と値の型が一致しません。');
  if (value.status === 'missing') return '?';
  if (value.status === 'invalid') return '!';
  if (value.status === 'not-applicable') return '—';
  const items = itemsOf(value);
  if (format === 'text') return items.join(delimiter);
  const numbers = items.map(numberOf);
  if (numbers.some((number) => number === null)) return null;
  return numbers.map((number) => numberText(number, format)).join(delimiter);
}
