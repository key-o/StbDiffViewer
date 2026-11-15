/**
 * #510: CAD browser entries are user-facing projections, not a 3D camera or saved SVG.
 * This list is regenerated from the active STB. Persistence uses DrawingProject ViewSpec.
 */
import { parseAxes, parseStories } from '../../../common-stb/import/parser/stbParserCore.js';

export function listCadDrawingViews({ document, modelKey } = {}) {
  if (document?.nodeType !== 9 || document.documentElement?.localName !== 'ST_BRIDGE')
    return Object.freeze([]);
  if (!['A', 'B'].includes(modelKey)) throw new TypeError('図面元モデルはAまたはBです。');
  const views = [];
  for (const story of parseStories(document)) {
    const storyId = String(story.id);
    views.push(
      Object.freeze({
        key: JSON.stringify(['plan', storyId]),
        label: `${story.name || storyId} 伏図`,
        type: 'plan',
        storyId,
      }),
    );
  }
  // STB-B is a comparison reference and must not become an elevation drawing source.
  if (modelKey === 'A') {
    const axes = parseAxes(document);
    for (const [direction, items] of [
      ['X', axes.xAxes],
      ['Y', axes.yAxes],
    ]) {
      const seen = new Set();
      for (const axis of items || []) {
        const axisId = String(axis?.id ?? '').trim();
        if (!axisId || seen.has(axisId))
          throw new Error(`${direction}通り芯IDが欠落または重複しています。`);
        seen.add(axisId);
        views.push(
          Object.freeze({
            key: JSON.stringify(['elevation', direction, axisId]),
            label: `${axis.name || axisId} 軸組図（${direction}通り）`,
            type: 'elevation',
            axisDirection: direction,
            axisId,
          }),
        );
      }
    }
  }
  return Object.freeze(views);
}

export function selectCadDrawingView(views, key) {
  const found = views.find((view) => view.key === key);
  if (!found) throw new Error('選択したビューが現行STBにはありません。再選択してください。');
  return found;
}
