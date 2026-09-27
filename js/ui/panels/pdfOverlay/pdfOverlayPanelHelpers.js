/** @fileoverview PDF照合パネルの数値・DOM・階ビューの小さな変換関数。 */

export function num(input, label) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) throw new TypeError(`${label}を数値で入力してください。`);
  return value;
}

export function resolveScaleDenominator(presetValue, customValue) {
  const raw = presetValue === 'custom' ? customValue : presetValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1)
    throw new RangeError('縮尺分母は1以上の数値で入力してください。');
  return value;
}

export function make(tag, attrs = {}, text = '') {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else if (key === 'for') element.htmlFor = value;
    else element.setAttribute(key, value);
  }
  if (text) element.textContent = text;
  return element;
}

export function storyView(stories, storyId) {
  const index = stories.findIndex((story) => story.id === storyId);
  if (index < 0) throw new Error('対象階が見つかりません。');
  const current = stories[index];
  const below = stories[index - 1]?.height;
  const above = stories[index + 1]?.height;
  const halfBelow = below == null ? 1500 : Math.max(1, (current.height - below) / 2);
  const halfAbove = above == null ? 1500 : Math.max(1, (above - current.height) / 2);
  return {
    type: 'plan',
    storyId: current.id,
    baseZ: current.height,
    lowerZ: current.height - halfBelow,
    upperZ: current.height + halfAbove,
    verticalCutOffset: Math.min(1500, halfAbove),
  };
}
