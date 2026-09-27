/**
 * @fileoverview ST-Bridge のコンクリート強度指定を部材単位で解決する。
 *
 * ST-Bridge 2.0.2 の優先順位:
 * 1. 部材 strength_concrete
 * 2. 参照断面 strength_concrete
 * 3. 指定節点が所属する StbStory strength_concrete
 * 4. StbCommon strength_concrete
 */

function readStrength(element) {
  const value = element?.getAttribute?.('strength_concrete');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function storyContainsNode(story, nodeId) {
  if (!story || !nodeId) return false;
  const nodeIds = story.getElementsByTagName?.('StbNodeId') || [];
  for (let i = 0; i < nodeIds.length; i++) {
    if (nodeIds[i].getAttribute?.('id') === nodeId) return true;
  }
  return false;
}

/**
 * ST-Bridge の規定順で部材に適用するコンクリート強度を解決する。
 *
 * 柱・間柱は storyNodeId に id_node_top、大梁・小梁は id_node_start を渡す。
 * @param {Object} params
 * @param {function(string): Element[]} params.scanTag - タグ走査関数
 * @param {Element} params.memberEl - 対象部材
 * @param {string|null} [params.sectionStrength] - 参照断面の strength_concrete
 * @param {string|null} [params.storyNodeId] - 所属階判定に使う節点ID
 * @returns {{value:string|null,source:'member'|'section'|'story'|'common'|null,storyId:string|null,storyName:string|null}}
 */
export function resolveMemberConcreteStrength({
  scanTag,
  memberEl,
  sectionStrength = null,
  storyNodeId = null,
}) {
  const memberStrength = readStrength(memberEl);
  if (memberStrength) {
    return { value: memberStrength, source: 'member', storyId: null, storyName: null };
  }

  if (typeof sectionStrength === 'string' && sectionStrength.trim()) {
    return {
      value: sectionStrength.trim(),
      source: 'section',
      storyId: null,
      storyName: null,
    };
  }

  if (typeof scanTag === 'function' && storyNodeId) {
    const story = scanTag('StbStory').find((candidate) =>
      storyContainsNode(candidate, storyNodeId),
    );
    const storyStrength = readStrength(story);
    if (storyStrength) {
      return {
        value: storyStrength,
        source: 'story',
        storyId: story.getAttribute('id') || null,
        storyName: story.getAttribute('name') || null,
      };
    }
  }

  const common = typeof scanTag === 'function' ? scanTag('StbCommon')[0] : null;
  const commonStrength = readStrength(common);
  if (commonStrength) {
    return { value: commonStrength, source: 'common', storyId: null, storyName: null };
  }

  return { value: null, source: null, storyId: null, storyName: null };
}
