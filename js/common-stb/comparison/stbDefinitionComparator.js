/**
 * @fileoverview STB定義・付帯要素の比較
 *
 * 節点ベースの幾何比較（配置要素比較）の対象外となる要素の差分を検出する:
 * StbCommon・断面定義・継手定義・ロール定義、および開口配置など。
 *
 * 継手（StbJointBeam* / StbJointColumn*）は位置を持たない定義要素であり、
 * 配置要素比較（StbJoint タグは STB に存在しない）では扱えないため、
 * 断面定義と同じ定義差分としてここで比較する。
 *
 * 開口配置（StbOpen 2.0.2 / StbOpenArrangement 2.1.0）は位置を持つが、
 * 節点ではなく親部材相対の座標のため配置要素比較に載らず、従来まったく
 * 差分報告されなかった。位置・サイズ・追加/削除を属性差としてここで比較する。
 * （サイズ定義 StbSecOpen_RC は StbSec 接頭辞で既に定義差分に含まれる）
 * ただし開口はソフト間で共通の識別子を持たないため、異ソフト間比較モード
 * （canonicalizeFloors）では対応付け不能。同モードでは比較対象から除外する
 * （CROSS_SOFTWARE_UNSTABLE_TAGS 参照）。
 *
 * 定義の子要素は親定義に紐づく属性として扱い、独立した比較対象にはしない。
 */

import { normalizeComparisonResult } from '../../data/normalizeComparisonResult.js';
import { createFloorCanonicalizer } from './storyFloorCanonicalizer.js';
import { normalizeSectionName } from './sectionNameNormalizer.js';

export const STB_DEFINITION_ELEMENT_TYPE = 'StbDefinition';

/**
 * STB定義タグを大分類グループに振り分ける。
 * 断面（StbSec*）・接合（StbJoint*）・開口（StbOpen*）は性質が異なるため区別し、
 * StbCommon 等の断面以外の定義（材料・強度指定など）は 'other' にまとめる。
 * 差分サマリーのタブ分けと生XMLビューの絞り込みで共有する単一の分類規則。
 * @param {string|undefined} tag - 定義要素のタグ名
 * @returns {'section'|'joint'|'open'|'other'}
 */
export function classifyDefinitionGroup(tag) {
  if (typeof tag !== 'string') return 'other';
  if (tag.startsWith('StbJoint')) return 'joint';
  if (tag.startsWith('StbOpen')) return 'open';
  if (tag.startsWith('StbSec')) return 'section';
  return 'other';
}

// 定義ルートとみなすタグの接頭辞。
// StbJointBeam / StbJointColumn は継手定義（StbJointBeamShapeH 等）のみに一致し、
// 配置要素の StbJointArrangement やコンテナの StbJoints には一致しない。
const DEFINITION_TAG_PREFIXES = ['StbSec', 'StbJointBeam', 'StbJointColumn'];
// 完全一致で定義比較に含めるタグ。
// StbOpen(2.0.2) / StbOpenArrangement(2.1.0) は開口配置。接頭辞ではなく完全一致に
// するのは、参照要素 StbOpenId やコンテナ StbOpens/StbOpenArrangements を誤って
// 定義として拾わないため。
const DEFINITION_TAGS = new Set(['StbCommon', 'StbOpen', 'StbOpenArrangement']);
const DEFINITION_IDENTITY_ATTRIBUTES = new Set(['id', 'guid']);

// 異ソフト間比較モードでは対応付け不能なため除外するタグ。
// 開口はソフト間で共通の識別子を持たない（例: NBUS は name 無しで id 採番、
// SEIN は "OP1@1" 等の独自命名）。継手の joint_name のような共通キーが無く、
// 異ソフト間では全数が onlyA/onlyB の誤差分として出てしまう。
// 同一ソフト内の前後比較（既定モード）では id が安定するため通常どおり比較する。
const CROSS_SOFTWARE_UNSTABLE_TAGS = new Set(['StbOpen', 'StbOpenArrangement']);

function isElementNode(node) {
  return node?.nodeType === 1;
}

function getAttributes(element) {
  const attrs = {};
  if (!element?.attributes) return attrs;
  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes[i];
    if (!DEFINITION_IDENTITY_ATTRIBUTES.has(attr.name)) {
      attrs[attr.name] = attr.value;
    }
  }
  return attrs;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function getDefinitionElements(document, { excludeCrossSoftwareUnstable = false } = {}) {
  if (!document?.getElementsByTagName) return [];
  const allElements = Array.from(document.getElementsByTagName('*'));
  const roots = [];

  for (const element of allElements) {
    if (!isDefinitionElement(element) || !hasDefinitionIdentity(element)) continue;
    if (excludeCrossSoftwareUnstable && CROSS_SOFTWARE_UNSTABLE_TAGS.has(element.tagName)) continue;
    if (hasDefinitionRootAncestor(element)) continue;
    roots.push(element);
  }

  return roots;
}

function isDefinitionElement(element) {
  const tag = element?.tagName;
  if (typeof tag !== 'string') return false;
  return (
    DEFINITION_TAGS.has(tag) || DEFINITION_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix))
  );
}

function hasDefinitionIdentity(element) {
  if (DEFINITION_TAGS.has(element.tagName)) return true;
  return ['id', 'name', 'project_name'].some((attr) => {
    const value = element.getAttribute(attr);
    return value !== null && value !== '';
  });
}

function hasDefinitionRootAncestor(element) {
  let parent = element.parentNode;
  while (parent) {
    if (isDefinitionElement(parent) && hasDefinitionIdentity(parent)) {
      return true;
    }
    parent = parent.parentNode;
  }
  return false;
}

function getStableKeyBase(element, floorCanonicalizer) {
  const tag = element.tagName;
  if (tag === 'StbCommon') return tag;

  // 異ソフト間比較モード: キーを「正規化name＋正準化floor」に限定する。
  // kind_* / isFoundation 等はツールにより出力有無・値が異なり（NBUSはkind_beam無し、
  // SEINは基礎梁も isFoundation="false" 等）、キーに含めると対応自体が割れるため
  // シグネチャ差（属性差）として提示する側に回す。
  // 既知の制約: 同タグ・同名・同階で kind のみ異なる断面が両モデルにある場合は
  // 対応付けされ属性差として表示される（隠れず可視化されるが onlyA/onlyB にはならない）。
  // 検証根拠: docs/reports/cross-software-match-benchmark.md（Stage B2 / A4）
  if (floorCanonicalizer) {
    const name = normalizeSectionName(element.getAttribute('name'));
    if (name) {
      const floor = floorCanonicalizer(element.getAttribute('floor'));
      return `${tag}|name:${name}|floor:${floor}`;
    }
    // 継手定義は name/floor を持たないため joint_name を意味的キーにする。
    // id はソフトごとに独立採番されるため、異ソフト間では id フォールバックだと
    // 対応付けが機能せず（偶然の id 一致で誤ペアリングする）矛盾する。
    const jointName = normalizeSectionName(element.getAttribute('joint_name'));
    if (jointName) {
      return `${tag}|joint_name:${jointName}`;
    }
    const id = element.getAttribute('id');
    return id ? `${tag}|id:${id}` : tag;
  }

  const keyAttrs = [
    'name',
    // 継手定義は name を持たず joint_name が意味的な識別子。
    // id は再出力で採番が変わりうるため joint_name をキーに含めて対応付けを安定させる。
    // joint_mark は識別子ではなく注記的属性のため、キーに含めず署名差（属性差）側で扱う。
    'joint_name',
    'floor',
    'kind_column',
    'kind_beam',
    'kind_brace',
    'kind_slab',
    'kind_wall',
    'kind_pile',
    'kind_structure',
    'isFoundation',
    'type',
  ];
  const attrs = keyAttrs
    .map((attr) => [attr, element.getAttribute(attr)])
    .filter(([, value]) => value !== null && value !== '');

  if (attrs.length > 0) {
    return `${tag}|${attrs.map(([attr, value]) => `${attr}:${value}`).join('|')}`;
  }

  const id = element.getAttribute('id');
  return id ? `${tag}|id:${id}` : tag;
}

function buildComparableSignature(element) {
  const children = Array.from(element.childNodes || []).filter(isElementNode);
  const text = children.length === 0 ? (element.textContent || '').trim().replace(/\s+/g, ' ') : '';
  return {
    tag: element.tagName,
    attrs: getAttributes(element),
    text,
    children: children
      .map(buildComparableSignature)
      .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
  };
}

function toComparableItem(element, key) {
  const name = element.getAttribute('name') || element.getAttribute('project_name') || key;
  return {
    id: key,
    key,
    name,
    tag: element.tagName,
    rawElement: element,
    signature: stableStringify(buildComparableSignature(element)),
  };
}

function indexDefinitions(elements, floorCanonicalizer) {
  const baseCounts = new Map();
  return elements.map((element) => {
    const baseKey = getStableKeyBase(element, floorCanonicalizer);
    const occurrence = baseCounts.get(baseKey) || 0;
    baseCounts.set(baseKey, occurrence + 1);
    const key = occurrence === 0 ? baseKey : `${baseKey}#${occurrence + 1}`;
    return toComparableItem(element, key);
  });
}

/**
 * 対応済み定義要素ペアの属性差分を列挙する（差分一覧のドリルダウン表示用）。
 * トップレベル属性の値差を {attribute, valueA, valueB} で返し、
 * 子要素ツリー（寸法・配筋等）に差があるかを childrenDiffer で示す。
 * guid / id は署名比較と同様に無視する。
 *
 * @param {Element} elementA - モデルA側の定義要素
 * @param {Element} elementB - モデルB側の定義要素
 * @returns {{attributes: Array<{attribute: string, valueA: *, valueB: *}>, childrenDiffer: boolean}}
 */
export function diffDefinitionElements(elementA, elementB) {
  const attrsA = getAttributes(elementA);
  const attrsB = getAttributes(elementB);
  const names = new Set([...Object.keys(attrsA), ...Object.keys(attrsB)]);
  const attributes = [];
  for (const name of [...names].sort()) {
    const valueA = attrsA[name];
    const valueB = attrsB[name];
    if (valueA !== valueB) {
      attributes.push({ attribute: name, valueA, valueB });
    }
  }

  const childSignature = (element) => {
    const signature = buildComparableSignature(element);
    return stableStringify({ text: signature.text, children: signature.children });
  };
  const childrenDiffer = childSignature(elementA) !== childSignature(elementB);

  return { attributes, childrenDiffer };
}

/**
 * STB定義要素を比較する。
 *
 * @param {Document} documentA
 * @param {Document} documentB
 * @param {Object} [options]
 * @param {boolean} [options.canonicalizeFloors=false] - 対応キーの floor を
 *   StbStory の標高/順序で正準化する（異ソフト間比較モード）。
 *   各モデル自身の StbStory で正準化するため、同一モデル比較の結果は変わらない。
 * @returns {Object} 正規化済み比較結果
 */
export function compareStbDefinitions(documentA, documentB, options = {}) {
  const canonicalizerA = options.canonicalizeFloors ? createFloorCanonicalizer(documentA) : null;
  const canonicalizerB = options.canonicalizeFloors ? createFloorCanonicalizer(documentB) : null;
  // 異ソフト間モード（canonicalizeFloors）では対応付け不能な開口を除外し、
  // 全数 onlyA/onlyB のノイズを避ける（CROSS_SOFTWARE_UNSTABLE_TAGS 参照）。
  const excludeCrossSoftwareUnstable = options.canonicalizeFloors === true;
  const itemsA = indexDefinitions(
    getDefinitionElements(documentA, { excludeCrossSoftwareUnstable }),
    canonicalizerA,
  );
  const itemsB = indexDefinitions(
    getDefinitionElements(documentB, { excludeCrossSoftwareUnstable }),
    canonicalizerB,
  );
  const mapA = new Map(itemsA.map((item) => [item.key, item]));
  const mapB = new Map(itemsB.map((item) => [item.key, item]));

  const exact = [];
  const mismatch = [];
  const onlyA = [];
  const onlyB = [];

  for (const [key, itemA] of mapA) {
    const itemB = mapB.get(key);
    if (!itemB) {
      onlyA.push(itemA);
      continue;
    }

    const matchedItem = { dataA: itemA, dataB: itemB };
    if (itemA.signature === itemB.signature) {
      exact.push(matchedItem);
    } else {
      mismatch.push({
        ...matchedItem,
        attributeMismatchKind: 'type',
        attributeDiffScope: {
          instance: false,
          type: true,
        },
        attributeDiffDetails: diffDefinitionElements(itemA.rawElement, itemB.rawElement),
      });
    }
  }

  for (const [key, itemB] of mapB) {
    if (!mapA.has(key)) {
      onlyB.push(itemB);
    }
  }

  const result = normalizeComparisonResult({
    exact,
    mismatch,
    onlyA,
    onlyB,
  });

  result.elementType = STB_DEFINITION_ELEMENT_TYPE;
  result.isSelected = true;
  result.isRenderable = false;

  return result;
}
