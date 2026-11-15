/**
 * @fileoverview 選択要素情報ユーティリティ
 *
 * 選択オブジェクトの userData から要素ID・要素タイプ・モデルソースを
 * 解決する純粋関数群。モジュール状態を持ちません。
 */

/**
 * サブメッシュ命中時でも部材本体を見つける（Axis/Storyは除外）
 * @param {THREE.Object3D} obj
 * @returns {THREE.Object3D|null}
 */
export function findSelectableAncestor(obj) {
  let cur = obj;
  while (cur) {
    if (cur.userData && (cur.userData.elementType || cur.userData.isGlbElement)) {
      const et = cur.userData.elementType || cur.userData.stbNodeType;
      if ((cur.userData.isGlbElement || et) && et !== 'Axis' && et !== 'Story') {
        return cur;
      }
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * 要素のIDを取得するヘルパー関数
 * @param {Object} userData
 * @returns {{idA: string|null, idB: string|null}}
 */
export function getElementIds(userData) {
  const modelSource = userData.modelSource;
  let idA = null;
  let idB = null;

  if (modelSource === 'matched') {
    idA = userData.elementIdA || userData.elementId;
    idB = userData.elementIdB;
  } else if (modelSource === 'A' || modelSource === 'onlyA') {
    idA = userData.elementIdA || userData.elementId;
  } else if (modelSource === 'B' || modelSource === 'onlyB') {
    idB = userData.elementIdB || userData.elementId;
  } else {
    // フォールバック
    idA = userData.elementId;
  }

  return { idA, idB };
}

/**
 * 選択要素タイプを表示用に正規化
 * @param {Object} userData
 * @returns {string|null}
 */
export function normalizeSelectedElementType(userData) {
  if (userData?.isGlbElement) return 'GLB';
  const elementType = userData?.elementType || userData?.stbNodeType || null;
  return elementType === 'Column (fallback line)' ? 'Column' : elementType;
}

/**
 * モデルソースを A/B に正規化
 * @param {string|null|undefined} modelSource
 * @returns {'A'|'B'|null}
 */
export function normalizeSelectionModelSide(modelSource) {
  if (modelSource === 'A' || modelSource === 'onlyA') {
    return 'A';
  }
  if (modelSource === 'B' || modelSource === 'onlyB') {
    return 'B';
  }
  return null;
}

/**
 * 2要素選択から比較対象を解決する
 * @param {THREE.Object3D[]} objects
 * @returns {{idA: string, idB: string, elementType: string, modelSource: 'matched'}|null}
 */
export function resolveTwoObjectComparisonTarget(objects) {
  if (!Array.isArray(objects) || objects.length !== 2) {
    return null;
  }

  const selectionInfo = objects.map((obj) => {
    const userData = obj?.userData;
    if (!userData || userData.modelSource === 'matched') {
      return null;
    }

    const elementType = normalizeSelectedElementType(userData);
    const side = normalizeSelectionModelSide(userData.modelSource);
    if (!elementType || !side) {
      return null;
    }

    const { idA, idB } = getElementIds(userData);
    return { elementType, side, idA, idB };
  });

  if (selectionInfo.some((info) => !info)) {
    return null;
  }

  if (selectionInfo[0].elementType !== selectionInfo[1].elementType) {
    return null;
  }

  const infoA = selectionInfo.find((info) => info.side === 'A');
  const infoB = selectionInfo.find((info) => info.side === 'B');
  if (!infoA || !infoB || !infoA.idA || !infoB.idB) {
    return null;
  }

  return {
    idA: String(infoA.idA),
    idB: String(infoB.idB),
    elementType: infoA.elementType,
    modelSource: 'matched',
  };
}

/**
 * 複数選択サマリー情報を生成
 * @param {THREE.Object3D[]} objects
 * @returns {{
 *   count: number,
 *   typeCounts: Array<{elementType: string, count: number}>,
 *   modelSourceCounts: {A: number, B: number, matched: number, unknown: number}
 * }}
 */
export function buildMultiSelectionSummaryData(objects) {
  const safeObjects = Array.isArray(objects) ? objects : [];

  // 要素タイプ別にカウント
  const typeCounts = new Map();
  const modelSourceCounts = { A: 0, B: 0, matched: 0, unknown: 0 };

  for (const obj of safeObjects) {
    const userData = obj?.userData || {};
    const elementType = normalizeSelectedElementType(userData) || 'Unknown';
    typeCounts.set(elementType, (typeCounts.get(elementType) || 0) + 1);

    const normalizedSource = normalizeSelectionModelSide(userData.modelSource);
    if (normalizedSource) {
      modelSourceCounts[normalizedSource]++;
    } else if (userData.modelSource === 'matched') {
      modelSourceCounts.matched++;
    } else {
      modelSourceCounts.unknown++;
    }
  }

  return {
    count: safeObjects.length,
    typeCounts: Array.from(typeCounts.entries())
      .map(([elementType, count]) => ({ elementType, count }))
      .sort((left, right) => left.elementType.localeCompare(right.elementType, 'ja')),
    modelSourceCounts,
  };
}
