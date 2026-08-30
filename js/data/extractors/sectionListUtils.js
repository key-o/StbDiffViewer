/**
 * @fileoverview 断面リスト抽出用の共通ユーティリティ
 *
 * beamSectionList と columnSectionListExtractor で共通する
 * XML検索、階データ抽出、ソートのロジックを集約します。
 *
 * @module data/extractors/sectionListUtils
 */

const STB_NAMESPACES = [
  'https://www.building-smart.or.jp/dl',
  'https://www.building-smart.or.jp/dl/stbridge',
];

/**
 * 要素を取得するヘルパー（名前空間対応）
 * @param {Element} parent - 親要素
 * @param {string} selector - セレクタ
 * @returns {Element|null}
 */
export function querySelector(parent, selector) {
  if (!parent) return null;
  try {
    const result = parent.querySelector(selector);
    if (result) return result;
  } catch (_) {
    // querySelector失敗時は名前空間フォールバック
  }
  if (typeof parent.getElementsByTagNameNS === 'function') {
    for (const namespace of STB_NAMESPACES) {
      const nsList = parent.getElementsByTagNameNS(namespace, selector);
      if (nsList && nsList.length > 0) return nsList[0];
    }
  }
  // 直接子要素検索
  const children = parent.children || [];
  for (let i = 0; i < children.length; i++) {
    if (children[i].tagName === selector || children[i].localName === selector) {
      return children[i];
    }
  }
  return null;
}

/**
 * 複数要素を取得するヘルパー
 * @param {Element} parent - 親要素
 * @param {string} selector - セレクタ
 * @returns {Element[]}
 */
export function querySelectorAll(parent, selector) {
  if (!parent) return [];
  const results = [];
  try {
    const nodeList = parent.querySelectorAll(selector);
    if (nodeList && nodeList.length > 0) {
      nodeList.forEach((el) => results.push(el));
      return results;
    }
  } catch (_) {
    // querySelector失敗時は名前空間フォールバック
  }
  if (typeof parent.getElementsByTagNameNS === 'function') {
    for (const namespace of STB_NAMESPACES) {
      const nsList = parent.getElementsByTagNameNS(namespace, selector);
      for (let i = 0; i < nsList.length; i++) {
        results.push(nsList[i]);
      }
      if (results.length > 0) return results;
    }
  }
  // 再帰的に子要素を検索
  function findAll(el) {
    const children = el.children || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.tagName === selector || child.localName === selector) {
        results.push(child);
      }
      findAll(child);
    }
  }
  findAll(parent);
  return results;
}

/**
 * StbStory一覧を抽出（階データ）
 * @param {Document} xmlDoc - XMLドキュメント
 * @returns {Map<string, Object>} id → {id, name, height, level, nodeIds}
 */
export function extractStories(xmlDoc) {
  const stories = new Map();
  const storyElements = querySelectorAll(xmlDoc, 'StbStory');

  storyElements.forEach((el) => {
    const id = el.getAttribute('id');
    const name = el.getAttribute('name') || `階${id}`;
    const height = parseFloat(el.getAttribute('height')) || 0;
    const levelAttr = el.getAttribute('level');
    const parsedLevel =
      levelAttr !== null && levelAttr !== '' ? Number.parseFloat(levelAttr) : Number.NaN;
    const level = Number.isFinite(parsedLevel) ? parsedLevel : null;

    // このStoryに属するノードIDを抽出
    const nodeIds = new Set();
    const nodeIdElements = querySelectorAll(el, 'StbNodeId');
    nodeIdElements.forEach((nodeEl) => {
      const nodeId = nodeEl.getAttribute('id');
      if (nodeId) {
        nodeIds.add(nodeId);
      }
    });

    if (id) {
      stories.set(id, { id, name, height, level, nodeIds });
    }
  });

  return stories;
}

/**
 * 階名の順序値を取得（降順ソート用）
 * @param {string} name - 階名（例: "1FL", "RFL", "PH1", "B1"）
 * @returns {number} 大きいほど上階
 */
export function getFloorSortOrder(name) {
  if (!name) return 0;

  const upper = String(name).toUpperCase().trim();

  if (upper === 'PH' || upper.startsWith('PH')) {
    const phNum = Number.parseInt((upper.match(/^PH(\d*)$/) || [])[1] || '0', 10);
    return 20000 + (Number.isFinite(phNum) ? phNum : 0);
  }

  if (upper === 'R' || upper === 'RF' || upper === 'RFL' || upper.startsWith('RF')) {
    const rfNum = Number.parseInt((upper.match(/^RF(\d*)$/) || [])[1] || '0', 10);
    return 10000 + (Number.isFinite(rfNum) ? rfNum : 0);
  }

  const basementMatch = upper.match(/^B(\d+)/);
  if (basementMatch) {
    return -Number.parseInt(basementMatch[1], 10);
  }

  const numMatch = upper.match(/(\d+)/);
  if (numMatch) {
    return Number.parseInt(numMatch[1], 10);
  }

  return 0;
}

/**
 * 階を上階から下階へソート
 * @param {{ level?: number|null, name?: string }} a
 * @param {{ level?: number|null, name?: string }} b
 * @returns {number}
 */
export function compareStoriesDescending(a, b) {
  const levelA = typeof a?.level === 'number' ? a.level : null;
  const levelB = typeof b?.level === 'number' ? b.level : null;

  if (levelA !== null && levelB !== null && levelA !== levelB) {
    return levelB - levelA;
  }

  const orderA = getFloorSortOrder(a?.name);
  const orderB = getFloorSortOrder(b?.name);
  if (orderA !== orderB) {
    return orderB - orderA;
  }

  return String(a?.name || '').localeCompare(String(b?.name || ''));
}

/**
 * 断面符号の基本部分を抽出する統合関数
 *
 * 2種類の抽出モードを options で切り替えられます:
 *
 * - デフォルト（column モード）:
 *     正規表現 /([A-Za-z]+\d+[a-zA-Z]*)/ でマッチし、プレフィックスを大文字、
 *     サフィックスを小文字に正規化します。
 *     例: "1C1a" → "C1a", "2SC2b" → "SC2b"
 *     null/空文字の場合は fallbackSymbol（デフォルト "C"）を返します。
 *
 * - beam モード（options.mode === 'beam'）:
 *     先頭の階プレフィックス（数字＋任意の F）を除去した後、
 *     残りの英字トークンの末尾を採用し、全て大文字化します。
 *     例: "3G1" → "G1", "10B1G1" → "G1", "3F-G1" → "G1"
 *     null/空文字の場合は "" を返します。
 *
 * @param {string} name - 断面名
 * @param {{ mode?: 'beam' | 'column', fallbackSymbol?: string }} [options]
 * @returns {string} 基本符号
 */
export function extractBaseSymbol(name, options = {}) {
  const { mode = 'column', fallbackSymbol = 'C' } = options;

  if (mode === 'beam') {
    if (!name) return '';
    const normalized = name.trim();
    const withoutFloorPrefix = normalized.replace(/^\d+F?/i, '');
    const tokens = withoutFloorPrefix.match(/[A-Za-z][A-Za-z0-9]*/g);
    if (tokens && tokens.length > 0) {
      return tokens[tokens.length - 1].toUpperCase();
    }
    return (withoutFloorPrefix || normalized).toUpperCase();
  }

  // column モード（デフォルト）
  if (!name) return fallbackSymbol;

  // 先頭の階プレフィックス（例: "B1", "1", "14"）を除去
  // 「B1C1」→「C1」、「14C1」→「C1」、「C1」→そのまま
  const stripped = name.replace(/^B?\d+/, '');
  const nameToProcess = stripped.length > 0 ? stripped : name;

  const match = nameToProcess.match(/([A-Za-z]+\d+[a-zA-Z]*)/);
  if (match) {
    const symbol = match[1];
    const parts = symbol.match(/^([A-Za-z]+)(\d+)([a-zA-Z]*)$/);
    if (parts) {
      const [, prefix, number, suffix] = parts;
      return prefix.toUpperCase() + number + suffix.toLowerCase();
    }
    return symbol.replace(/^[A-Za-z]+\d+/i, (m) => m.toUpperCase());
  }

  return nameToProcess.replace(/^\d+/, '').toUpperCase() || fallbackSymbol;
}

/**
 * 断面符号の自然順ソート用比較関数
 *
 * 符号を プレフィックス（英字）・数値・サフィックス（英字）の3要素に分解し、
 * 順に比較します。これにより C1, C1a, C1b, C2, SC1, G1, G2 などを
 * 期待通りの順序でソートできます。
 *
 * beam 向けの単純な数値比較もこの関数で代替可能です。
 * （beam では通常サフィックスを持たないため、プレフィックス→数値の2段階になります）
 *
 * @param {string} a - 符号A
 * @param {string} b - 符号B
 * @returns {number} 比較結果
 */
export function compareSymbols(a, b) {
  const parse = (s) => {
    const m = String(s || '').match(/^([A-Z]*)(\d+)([a-z]*)$/i);
    return m
      ? {
          prefix: m[1].toUpperCase(),
          number: parseInt(m[2], 10),
          suffix: m[3].toLowerCase(),
        }
      : { prefix: String(s || ''), number: 0, suffix: '' };
  };

  const ap = parse(a);
  const bp = parse(b);

  if (ap.prefix !== bp.prefix) {
    return ap.prefix.localeCompare(bp.prefix);
  }
  if (ap.number !== bp.number) {
    return ap.number - bp.number;
  }
  return ap.suffix.localeCompare(bp.suffix);
}
