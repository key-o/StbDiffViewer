/**
 * @fileoverview MVD S2/S4 必須属性バリデーションモジュール
 *
 * mvd-s2.json / mvd-s4.json に定義された required 属性リストをもとに、
 * STB XML ドキュメント内の各要素が MVD レベルで必須とされる属性を
 * 持っているかどうかを検証する。
 *
 * jsonSchemaLoader.js と同じ「fetch キャッシュ + ロード済みチェック」パターンを採用。
 * validateStbDocument() は引き続き同期関数のまま使用できる。
 */

import { createLogger } from '../../utils/logger.js';
import { resolveRuntimeAssetUrl } from '../../config/runtimeAssetUrl.js';
import { SEVERITY, CATEGORY } from './validationConstants.js';
import { buildIssueLocation } from './issueLocation.js';

const logger = createLogger('validation:mvdValidator');

/**
 * MVD データキャッシュ
 * 's2' / 's4' → { elementName: { required: string[] } }
 */
const mvdData = new Map();

/** ロード中かどうかのフラグ（二重fetchを防ぐ） */
let loadingPromise = null;

/** ロード失敗フラグ */
let loadFailed = false;

/**
 * MVD データを非同期でロードしてキャッシュする
 * 既にロード済みの場合は何もしない（idempotent）
 *
 * @returns {Promise<void>}
 */
export async function initializeMvdData() {
  if (mvdData.size > 0) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const s2Url = resolveRuntimeAssetUrl(
        'config/mvd-s2.json',
        '../../../config/mvd-s2.json',
        import.meta.url,
      );
      const s4Url = resolveRuntimeAssetUrl(
        'config/mvd-s4.json',
        '../../../config/mvd-s4.json',
        import.meta.url,
      );
      const [s2Res, s4Res] = await Promise.all([fetch(s2Url), fetch(s4Url)]);

      if (!s2Res.ok) throw new Error(`mvd-s2.json のロードに失敗: ${s2Res.status}`);
      if (!s4Res.ok) throw new Error(`mvd-s4.json のロードに失敗: ${s4Res.status}`);

      const [s2Json, s4Json] = await Promise.all([s2Res.json(), s4Res.json()]);

      mvdData.set('s2', s2Json.elements || {});
      mvdData.set('s4', s4Json.elements || {});

      loadFailed = false;
      logger.info('MVD データのロードが完了しました (s2, s4)');
    } catch (e) {
      loadFailed = true;
      logger.warn(`MVD データのロードに失敗しました: ${e.message}`);
      loadingPromise = null; // リトライ可能にするためリセット
    }
  })();

  return loadingPromise;
}

/**
 * 指定レベルの MVD データがロード済みかどうか
 *
 * @param {string} level - 's2' | 's4'
 * @returns {boolean}
 */
export function isMvdDataLoaded(level) {
  return mvdData.has(level);
}

/**
 * MVD 必須属性バリデーションを実行する
 *
 * @param {Document} xmlDoc - パース済み XML ドキュメント
 * @param {'s2'|'s4'} mvdLevel - チェックする MVD レベル
 * @returns {Array<Object>} ValidationIssue 配列
 */
export function validateMvdRequirements(xmlDoc, mvdLevel) {
  if (!xmlDoc || !xmlDoc.documentElement) return [];
  if (!mvdLevel) return [];

  const elements = mvdData.get(mvdLevel);
  if (!elements) {
    const reason = loadFailed
      ? 'MVD 設定ファイルのロードに失敗しました'
      : 'initializeMvdData() が完了する前に呼び出されました';
    logger.warn(`MVD データが未ロードです (level: ${mvdLevel}): ${reason}`);
    return [
      {
        severity: SEVERITY.ERROR,
        category: CATEGORY.MVD,
        elementType: 'Document',
        elementId: '',
        message: `[MVD ${mvdLevel.toUpperCase()}] ${reason}。MVD 検証を実行できませんでした。`,
        repairable: false,
      },
    ];
  }

  const elementNames = new Set(Object.keys(elements));
  const issues = [];

  walkElement(xmlDoc.documentElement, elementNames, elements, mvdLevel, issues);

  return issues;
}

// ============================================================
// 内部: DOM 走査
// ============================================================

/**
 * 要素を再帰的に走査して MVD 必須属性チェックを行う
 */
function walkElement(element, elementNames, elements, mvdLevel, issues) {
  const elementName = element.localName || element.nodeName.replace(/^.*:/, '');

  if (elementNames.has(elementName)) {
    const requiredAttrs = elements[elementName].required || [];
    const elementId = element.getAttribute ? element.getAttribute('id') || '' : '';

    for (const attr of requiredAttrs) {
      if (!hasAttributeLoose(element, attr)) {
        issues.push(buildMvdIssue(element, elementName, elementId, attr, mvdLevel));
      }
    }
  }

  for (let i = 0; i < element.childNodes.length; i++) {
    const child = element.childNodes[i];
    if (child.nodeType === 1) {
      walkElement(child, elementNames, elements, mvdLevel, issues);
    }
  }
}

function hasAttributeLoose(element, attributeName) {
  if (!element?.hasAttribute) return false;
  if (element.hasAttribute(attributeName)) return true;

  const expected = String(attributeName).toLowerCase();
  const attrs = element.attributes ? Array.from(element.attributes) : [];
  return attrs.some((attr) => String(attr.name).toLowerCase() === expected);
}

/**
 * MVD ValidationIssue オブジェクトを生成する
 */
function buildMvdIssue(element, elementName, elementId, missingAttr, mvdLevel) {
  return {
    severity: SEVERITY.ERROR,
    category: CATEGORY.MVD,
    elementType: elementName,
    elementId,
    element,
    message: `[MVD ${mvdLevel.toUpperCase()}] 要素 '${elementName}' に必須属性 '${missingAttr}' がありません`,
    attribute: missingAttr,
    ...buildIssueLocation(element, missingAttr),
    repairable: false,
  };
}
