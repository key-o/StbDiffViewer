/**
 * @fileoverview RC 3D配筋向けのSTB索引。
 *
 * PERF-2: 節点・柱・梁・断面をDocument単位で一度だけ索引化し、
 * 配筋facts生成中の全文書走査をMap参照へ置き換える。
 *
 * index未指定の既存経路は従来探索を維持するため、このモジュールは
 * 配筋意味を変更せず段階移行するための読み取り専用補助データである。
 */

import { incrementRebarPerformanceCounter } from '../../../utils/rebarPerformanceMetrics.js';
import { querySelectorAll } from '../sectionListUtils.js';

// PERF-2のproduction orchestration専用。永続cacheではなく同期処理中だけ有効にし、
// XML編集後の同一Documentを次の処理へ持ち越さない。PERF-3のgeneration cacheとは分離する。
const scopedIndexByDocument = new WeakMap();

function normalizeId(id) {
  if (id === null || id === undefined || id === '') return null;
  return String(id);
}

function elementTagName(element) {
  const name = element?.localName || element?.nodeName || '';
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function indexById(elements) {
  const result = new Map();
  for (const element of elements) {
    const id = normalizeId(element?.getAttribute?.('id'));
    if (id !== null && !result.has(id)) {
      // 従来の Array.find() と同じく、重複ID時は先に現れた要素を採用する。
      result.set(id, element);
    }
  }
  return result;
}

/**
 * StbColumnViaNode / StbGirderViaNode 配下の StbNodeIdOrder を読み取る。
 * 要素名はnamespace prefixを除去して比較し、DOM実装差に依存しない。
 */
function collectOrderedNodeIds(element) {
  const result = [];
  const visit = (parent) => {
    const children = parent?.childNodes || [];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child?.nodeType !== 1) continue;
      if (elementTagName(child) === 'StbNodeIdOrder') {
        const ids = String(child.textContent || '')
          .trim()
          .split(/\s+/)
          .map(normalizeId)
          .filter(Boolean);
        result.push(...ids);
        continue;
      }
      visit(child);
    }
  };
  visit(element);
  return result;
}

function getOrCreateColumnConnection(map, nodeId) {
  if (!map.has(nodeId)) {
    map.set(nodeId, { above: null, below: null, connected: [] });
  }
  return map.get(nodeId);
}

function appendColumnConnections(columnsByNodeId, elements, tagName) {
  for (const element of elements) {
    const bottomNodeId = normalizeId(element.getAttribute('id_node_bottom'));
    const topNodeId = normalizeId(element.getAttribute('id_node_top'));

    if (topNodeId !== null) {
      const entry = getOrCreateColumnConnection(columnsByNodeId, topNodeId);
      if (!entry.below) entry.below = element;
      entry.connected.push({ element, tagName, endpoint: 'top' });
    }
    if (bottomNodeId !== null) {
      const entry = getOrCreateColumnConnection(columnsByNodeId, bottomNodeId);
      if (!entry.above) entry.above = element;
      entry.connected.push({ element, tagName, endpoint: 'bottom' });
    }

    for (const viaNodeId of collectOrderedNodeIds(element)) {
      if (viaNodeId === topNodeId || viaNodeId === bottomNodeId) continue;
      const entry = getOrCreateColumnConnection(columnsByNodeId, viaNodeId);
      entry.connected.push({ element, tagName, endpoint: 'via' });
    }
  }
}

function appendBeamConnection(beamsByNodeId, nodeId, value) {
  if (nodeId === null) return;
  if (!beamsByNodeId.has(nodeId)) beamsByNodeId.set(nodeId, []);
  beamsByNodeId.get(nodeId).push(value);
}

function appendBeamConnections(beamsByNodeId, elements, tagName) {
  for (const element of elements) {
    const startNodeId = normalizeId(element.getAttribute('id_node_start'));
    const endNodeId = normalizeId(element.getAttribute('id_node_end'));
    appendBeamConnection(beamsByNodeId, startNodeId, {
      element,
      tagName,
      endpoint: 'start',
    });
    appendBeamConnection(beamsByNodeId, endNodeId, {
      element,
      tagName,
      endpoint: 'end',
    });

    for (const viaNodeId of collectOrderedNodeIds(element)) {
      if (viaNodeId === startNodeId || viaNodeId === endNodeId) continue;
      appendBeamConnection(beamsByNodeId, viaNodeId, {
        element,
        tagName,
        endpoint: 'via',
      });
    }
  }
}

function buildSectionIndex(scanTag) {
  const sectionsByTagAndId = new Map();
  const sectionContainers = scanTag('StbSections');

  for (const container of sectionContainers) {
    const children = container?.childNodes || [];
    for (let index = 0; index < children.length; index += 1) {
      const element = children[index];
      if (element?.nodeType !== 1) continue;
      const tagName = elementTagName(element);
      if (!tagName.startsWith('StbSec')) continue;
      const id = normalizeId(element.getAttribute?.('id'));
      if (id === null) continue;

      if (!sectionsByTagAndId.has(tagName)) {
        sectionsByTagAndId.set(tagName, new Map());
      }
      const byId = sectionsByTagAndId.get(tagName);
      if (!byId.has(id)) byId.set(id, element);
    }
  }

  return sectionsByTagAndId;
}

function createIndexTagScanner(xmlDoc) {
  return (tagName) => {
    incrementRebarPerformanceCounter('index.rebarModel.fullCollectionTraversal.count');
    return querySelectorAll(xmlDoc, tagName);
  };
}

/**
 * STB DocumentからRC 3D配筋向け索引を構築する。
 * 同期scope中に同じDocumentのindexが既にある場合は再構築せず共有する。
 *
 * @param {Document} xmlDoc STB XML Document
 * @param {Object} [options]
 * @param {function(string): Element[]} [options.scanTag] 既存の共有タグscanner
 * @returns {Object|null} RebarModelIndex
 */
export function buildRebarModelIndex(xmlDoc, options = {}) {
  if (!xmlDoc) return null;
  const scoped = scopedIndexByDocument.get(xmlDoc);
  if (scoped?.index) return scoped.index;

  incrementRebarPerformanceCounter('index.rebarModel.build.count');

  // production scopeではRebarModelIndex自身が行う全文書collection traversalを明示計測する。
  // 既存scanTagを注入したunit/共有経路では、そのscanner側の計測責務を尊重して二重計上しない。
  const scanTag = options.scanTag || createIndexTagScanner(xmlDoc);
  const nodes = scanTag('StbNode');
  const columns = scanTag('StbColumn');
  const posts = scanTag('StbPost');
  const girders = scanTag('StbGirder');
  const beams = scanTag('StbBeam');

  const nodeById = indexById(nodes);
  const columnById = indexById(columns);
  const postById = indexById(posts);
  const girderById = indexById(girders);
  const beamById = indexById(beams);

  const columnsByNodeId = new Map();
  // 既存探索順 StbColumn -> StbPost を保持する。
  appendColumnConnections(columnsByNodeId, columns, 'StbColumn');
  appendColumnConnections(columnsByNodeId, posts, 'StbPost');

  const beamsByNodeId = new Map();
  // collectBeamLevelsAtNode() / support探索の既存順 StbGirder -> StbBeam を保持する。
  appendBeamConnections(beamsByNodeId, girders, 'StbGirder');
  appendBeamConnections(beamsByNodeId, beams, 'StbBeam');

  return {
    nodeById,
    columnsByNodeId,
    beamsByNodeId,
    columnById,
    postById,
    girderById,
    beamById,
    sectionsByTagAndId: buildSectionIndex(scanTag),
  };
}

/**
 * 同期処理中だけDocument単位indexを共有する。
 * scope終了時に必ず破棄するため、同一DocumentがXML編集で変更されても次回処理へstale indexを残さない。
 * nested scopeは外側indexをそのまま再利用する。
 *
 * @param {Document} xmlDoc STB XML Document
 * @param {function(Object|null): any} callback 同期処理
 * @param {Object} [options]
 * @param {function(string): Element[]} [options.scanTag] index初回構築用scanner
 * @returns {any} callbackの戻り値
 */
export function withRebarModelIndexScope(xmlDoc, callback, options = {}) {
  if (typeof callback !== 'function') {
    throw new TypeError('withRebarModelIndexScope callback must be a function');
  }
  if (!xmlDoc) return callback(null);

  const existing = scopedIndexByDocument.get(xmlDoc);
  if (existing?.index) return callback(existing.index);

  const index = buildRebarModelIndex(xmlDoc, options);
  scopedIndexByDocument.set(xmlDoc, { index });
  try {
    return callback(index);
  } finally {
    scopedIndexByDocument.delete(xmlDoc);
  }
}

/**
 * Model A/Bなど複数Documentを同一同期処理で共有scopeへ入れる。
 * 重複Documentは1回だけ構築する。
 *
 * @param {Array<Document|null|undefined>} documents 対象Document
 * @param {function(): any} callback 同期処理
 * @returns {any} callbackの戻り値
 */
export function withRebarModelIndexScopes(documents, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('withRebarModelIndexScopes callback must be a function');
  }
  const unique = [...new Set((documents || []).filter(Boolean))];
  const run = (index) =>
    index >= unique.length
      ? callback()
      : withRebarModelIndexScope(unique[index], () => run(index + 1));
  return run(0);
}

/**
 * RebarModelIndexからtag/id要素を取得する。
 *
 * 戻り値の意味:
 * - Element: indexで解決済み
 * - null: そのtagはindex対象だが該当idなし
 * - undefined: index対象外なので呼出側で従来探索へfallback可能
 *
 * @param {Object|null} index RebarModelIndex
 * @param {string} tagName STB要素名
 * @param {string|number} id 要素ID
 * @returns {Element|null|undefined}
 */
export function lookupRebarModelIndex(index, tagName, id) {
  const normalizedId = normalizeId(id);
  if (!index || normalizedId === null) return undefined;

  const directMaps = {
    StbNode: index.nodeById,
    StbColumn: index.columnById,
    StbPost: index.postById,
    StbGirder: index.girderById,
    StbBeam: index.beamById,
  };
  if (Object.prototype.hasOwnProperty.call(directMaps, tagName)) {
    return directMaps[tagName]?.get(normalizedId) || null;
  }

  if (String(tagName).startsWith('StbSec')) {
    const byId = index.sectionsByTagAndId?.get(tagName);
    if (!byId) return undefined;
    return byId.get(normalizedId) || null;
  }

  return undefined;
}
