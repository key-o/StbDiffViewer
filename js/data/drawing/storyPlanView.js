/** @fileoverview 階一覧から構造平面図用の明示的なplan view範囲を作るpure helper。 */

export function createStoryPlanView(stories, storyId) {
  if (!Array.isArray(stories) || stories.length === 0) {
    throw new TypeError('階一覧が必要です。');
  }
  const index = stories.findIndex((story) => String(story?.id) === String(storyId));
  if (index < 0) throw new Error('対象階が見つかりません。');

  const current = stories[index];
  const baseZ = Number(current?.height);
  if (!Number.isFinite(baseZ)) throw new TypeError('対象階高さが不正です。');

  const belowValue = stories[index - 1]?.height;
  const aboveValue = stories[index + 1]?.height;
  const below = belowValue == null ? null : Number(belowValue);
  const above = aboveValue == null ? null : Number(aboveValue);
  const halfBelow = Number.isFinite(below) ? Math.max(1, (baseZ - below) / 2) : 1500;
  const halfAbove = Number.isFinite(above) ? Math.max(1, (above - baseZ) / 2) : 1500;

  return Object.freeze({
    type: 'plan',
    storyId: String(current.id),
    baseZ,
    lowerZ: baseZ - halfBelow,
    upperZ: baseZ + halfAbove,
    verticalCutOffset: Math.min(1500, halfAbove),
  });
}
