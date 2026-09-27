/**
 * @fileoverview 生XMLデータビューアパネル
 *
 * 読み込んだSTBファイルの生XML（整形済み）をフローティングウィンドウで表示します。
 * モデルA/B切り替えタブ、クリップボードコピー、バリデーションエラーハイライト、
 * 要素の折りたたみ機能を提供します。
 *
 * @module ui/panels/xmlViewer
 */

import { floatingWindowManager } from './floatingWindowManager.js';
import { registerXmlValidationMarkIssues } from './xmlViewerIssueDescriptor.js';
import { getState } from '../../data/state/globalState.js';
import { formatXml } from '../../common-stb/export/xmlFormatter.js';
import { showSuccess, showWarning } from '../common/toast.js';
import { createLogger } from '../../utils/logger.js';
import { eventBus, EditEvents } from '../../data/events/index.js';
import {
  getElementDefinitionForVersion,
  isVersionLoaded,
} from '../../common-stb/import/parser/jsonSchemaLoader.js';
import {
  formatAttributeSchemaTitle,
  getAttributeSchemaPresentation,
  getChildElementSchemaRole,
  getMissingRequiredAttributeNames,
} from '../../common-stb/schema/schemaPresentation.js';

const log = createLogger('ui:panels:xmlViewer');

let currentModel = 'A';
/** @type {string} 最後に描画した生XMLテキスト（コピー用） */
let lastRawXml = '';
/** @type {Element[]} バリデーション後のエラー/警告マーク要素リスト（DOM順） */
let errorMarkEls = [];
/** @type {number} 現在フォーカス中のマークインデックス（-1 = 未選択） */
let errorMarkIndex = -1;

const CATEGORY_LABELS = {
  schema: 'XSD',
  mvd: 'MVD',
  structure: '構造',
  reference: '参照',
  data: 'データ',
  geometry: '形状',
  duplicate: '重複',
};

const SEVERITY_RANK = {
  error: 3,
  warning: 2,
  info: 1,
};

const ELEMENT_ROLE_LABELS = {
  root: 'ルート要素',
  required: '必須子要素',
  optional: '任意子要素',
  choice: 'choice候補要素',
  unknown: '親XSD定義外',
};

function normalizeModelSource(modelSource) {
  if (!modelSource) return null;
  if (modelSource === 'A' || modelSource === 'modelA') return 'A';
  if (modelSource === 'B' || modelSource === 'modelB') return 'B';
  return null;
}

/**
 * XMLビューアパネルを初期化します
 */
export function initializeXmlViewer() {
  floatingWindowManager.registerWindow({
    windowId: 'xml-viewer-float',
    toggleButtonId: 'toggle-xml-viewer-btn',
    closeButtonId: 'close-xml-viewer-btn',
    headerId: 'xml-viewer-header',
    draggable: true,
    resizable: true,
    autoShow: false,
    onShow: () => renderXml(),
  });
  // floatingWindow.js が先に xml-viewer-float を登録済みの場合、上記 registerWindow はスキップされる。
  // setOnShowCallback で確実にコールバックをセットする。
  floatingWindowManager.setOnShowCallback('xml-viewer-float', () => renderXml());

  // タブ切り替え
  document.querySelectorAll('.xml-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.xml-tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentModel = btn.dataset.model;
      clearValidationStatus();
      renderXml();
    });
  });

  // コピーボタン（生テキストをコピー）
  document.getElementById('xml-viewer-copy-btn')?.addEventListener('click', () => {
    if (!lastRawXml) return;
    navigator.clipboard
      .writeText(lastRawXml)
      .then(() => showSuccess('XMLをクリップボードにコピーしました'))
      .catch(() => showWarning('コピーに失敗しました'));
  });

  // バリデーション実行ボタン
  document.getElementById('xml-run-validation-btn')?.addEventListener('click', () => {
    runValidationAndMark();
  });

  // エラーナビゲーションボタン
  document.getElementById('xml-prev-error-btn')?.addEventListener('click', () => {
    navigateError(-1);
  });
  document.getElementById('xml-next-error-btn')?.addEventListener('click', () => {
    navigateError(+1);
  });

  // 折りたたみボタン（イベント委譲）
  const pre = document.getElementById('xml-viewer-pre');
  pre?.addEventListener('click', (e) => {
    const btn = e.target.closest('.xml-fold-btn');
    if (!btn) return;
    const node = btn.closest('.xml-node');
    if (!node) return;
    const isCollapsed = node.classList.toggle('collapsed');
    btn.textContent = isCollapsed ? '▶' : '▼';
    btn.title = isCollapsed ? '展開する' : '折りたたむ';
  });

  ensureSchemaRoleLegend();

  // 編集イベントリスナー: 表示中のモデルが編集された場合にXMLを再表示
  eventBus.on(EditEvents.ATTRIBUTE_CHANGED, ({ modelSource }) => {
    const isViewerVisible = floatingWindowManager.isWindowVisible('xml-viewer-float');
    const editedModel = normalizeModelSource(modelSource);
    if (!editedModel) return;
    if (isViewerVisible && currentModel === editedModel) {
      renderXml();
    }
  });

  log.info('XMLビューアパネルを初期化しました');
}

function ensureSchemaRoleLegend() {
  const legend = document.querySelector('.xml-viewer-legend');
  if (!legend || legend.querySelector('[data-xml-schema-role-legend]')) return;

  const definitions = [
    ['required', 'XSD必須属性'],
    ['optional', 'XSD任意属性'],
    ['choice', 'XSD choice要素'],
  ];

  for (const [role, label] of definitions) {
    const item = document.createElement('span');
    item.className = 'xml-legend-item';
    item.dataset.xmlSchemaRoleLegend = role;

    const swatch = document.createElement('span');
    swatch.className = `xml-legend-swatch xml-legend-role-${role}`;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  }
}

/**
 * バリデーションステータス表示をクリア
 */
function clearValidationStatus() {
  const status = document.getElementById('xml-validation-status');
  if (status) {
    status.textContent = '';
    status.className = 'xml-validation-status';
    status.title = '';
  }
  resetErrorNavigation();
}

function getCurrentModelVersion() {
  return getState(`models.stbVersion${currentModel}`) || '2.0.2';
}

function getSchemaContext() {
  const version = getCurrentModelVersion();
  return {
    version,
    loaded: isVersionLoaded(version),
  };
}

function updateSchemaStatus(schemaContext) {
  const schemaStatus = document.getElementById('xml-schema-status');
  if (!schemaStatus) return;

  if (!schemaContext.loaded) {
    schemaStatus.textContent = 'XSD役割色分け: スキーマ未ロード';
    schemaStatus.className = 'xml-validation-status xml-schema-status has-warning';
    schemaStatus.title = `バージョン ${schemaContext.version} のスキーマが未ロードのため、要素・属性のXSD定義判定は未表示です`;
    return;
  }

  schemaStatus.textContent = `XSD役割色分け: ${schemaContext.version}`;
  schemaStatus.className = 'xml-validation-status xml-schema-status ok';
  schemaStatus.title = `要素・属性を XSD の必須/任意/choice/未定義 で色分け表示中（version: ${schemaContext.version}）`;
}

function getCategoryLabel(category) {
  return CATEGORY_LABELS[String(category || '').toLowerCase()] || String(category || 'other');
}

function getIssueCategoryClass(category) {
  const normalized = String(category || 'other')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return `xml-mark-cat-${normalized || 'other'}`;
}

function pickPrimaryIssue(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  return [...issues].sort((a, b) => {
    const bySeverity = (SEVERITY_RANK[b?.severity] || 0) - (SEVERITY_RANK[a?.severity] || 0);
    if (bySeverity !== 0) return bySeverity;
    const aCategory = String(a?.category || '');
    const bCategory = String(b?.category || '');
    return aCategory.localeCompare(bCategory);
  })[0];
}

function formatIssueTitle(issues, schemaStateText = '') {
  if (!Array.isArray(issues) || issues.length === 0) {
    return schemaStateText;
  }

  const maxLines = 8;
  const lines = issues.slice(0, maxLines).map((issue) => {
    const severity = String(issue?.severity || 'info').toUpperCase();
    const category = getCategoryLabel(issue?.category);
    const message = issue?.message || '(詳細なし)';
    return `[${severity}/${category}] ${message}`;
  });

  if (issues.length > maxLines) {
    lines.push(`... 他 ${issues.length - maxLines} 件`);
  }

  return schemaStateText ? `${schemaStateText}\n${lines.join('\n')}` : lines.join('\n');
}

function summarizeIssues(issues) {
  const total = issues.length;
  const errorCount = issues.filter((i) => i?.severity === 'error').length;
  const warningCount = issues.filter((i) => i?.severity === 'warning').length;
  const infoCount = issues.filter((i) => i?.severity === 'info').length;
  const schemaCount = issues.filter(
    (i) => String(i?.category || '').toLowerCase() === 'schema',
  ).length;
  const mvdCount = issues.filter((i) => String(i?.category || '').toLowerCase() === 'mvd').length;

  if (total === 0) {
    return {
      text: '問題は検出されませんでした',
      className: 'xml-validation-status ok',
      title: 'バリデーション結果: 問題なし',
    };
  }

  const className =
    errorCount > 0 ? 'xml-validation-status has-error' : 'xml-validation-status has-warning';
  const text = `問題 ${total}件 (Error:${errorCount} Warning:${warningCount} Info:${infoCount}) / XSD:${schemaCount} MVD:${mvdCount}`;
  return {
    text,
    className,
    title: text,
  };
}

function getElementSchemaState(el, schemaContext) {
  const version = schemaContext?.version || getCurrentModelVersion();
  if (!schemaContext?.loaded) {
    return {
      known: null,
      role: 'unknown',
      definition: null,
      title: `XSD定義判定: スキーマ未ロード (version: ${version})`,
    };
  }

  const elementName = el.localName || el.tagName;
  const definition = getElementDefinitionForVersion(version, elementName);
  const known = Boolean(definition);
  let role = 'root';

  if (known && el.parentElement) {
    const parentName = el.parentElement.localName || el.parentElement.tagName;
    const parentDef = getElementDefinitionForVersion(version, parentName);
    role = getChildElementSchemaRole(parentDef, elementName);
  }

  const roleText = ELEMENT_ROLE_LABELS[role] || role;
  return {
    known,
    role,
    definition,
    title: known
      ? `XSD定義済み: <${elementName}> / ${roleText} (version: ${version})`
      : `XSD未定義: <${elementName}> (version: ${version})`,
  };
}

function appendTagName(container, el, schemaContext) {
  const state = getElementSchemaState(el, schemaContext);
  const tagName = document.createElement('span');
  tagName.className = 'xml-tag-name';
  if (state.known === true) {
    tagName.classList.add('xml-tag-xsd-known', `xml-tag-role-${state.role}`);
  }
  if (state.known === false) tagName.classList.add('xml-tag-xsd-unknown');
  tagName.title = state.title;
  tagName.textContent = el.tagName;
  container.appendChild(tagName);
  return state;
}

function appendTagClose(container, el, schemaContext) {
  container.appendChild(document.createTextNode('</'));
  appendTagName(container, el, schemaContext);
  container.appendChild(document.createTextNode('>'));
}

/**
 * エラーナビゲーション状態をリセット
 */
function resetErrorNavigation() {
  errorMarkEls = [];
  errorMarkIndex = -1;
  updateNavButtons();
}

/**
 * エラーナビゲーションボタンの有効/無効とラベルを更新
 */
function updateNavButtons() {
  const prevBtn = document.getElementById('xml-prev-error-btn');
  const nextBtn = document.getElementById('xml-next-error-btn');
  const label = document.getElementById('xml-error-nav-label');
  const total = errorMarkEls.length;

  if (prevBtn) prevBtn.disabled = total === 0 || errorMarkIndex <= 0;
  if (nextBtn) nextBtn.disabled = total === 0 || errorMarkIndex >= total - 1;
  if (label) {
    if (total === 0) {
      label.textContent = '';
      label.title = '';
    } else {
      const pos = errorMarkIndex >= 0 ? errorMarkIndex + 1 : '-';
      label.textContent = `${pos}/${total} 箇所`;
      label.title = `エラーのある箇所 ${pos} / ${total}（同一箇所に複数エラーがある場合は集約）`;
    }
  }
}

/**
 * エラーマークへのナビゲーションを実行
 * @param {number} direction +1で次、-1で前
 */
function navigateError(direction) {
  if (errorMarkEls.length === 0) return;
  const next = errorMarkIndex + direction;
  if (next < 0 || next >= errorMarkEls.length) return;
  jumpToMark(next);
}

/**
 * 指定インデックスのマーク要素へジャンプ
 * @param {number} index
 */
function jumpToMark(index) {
  // 前のフォーカスを解除
  if (errorMarkIndex >= 0 && errorMarkEls[errorMarkIndex]) {
    errorMarkEls[errorMarkIndex].classList.remove('xml-mark-focused');
  }

  errorMarkIndex = index;
  const mark = errorMarkEls[index];
  if (!mark) return;

  // 折りたたまれた祖先ノードを展開
  let node = mark.closest('.xml-node');
  while (node) {
    if (node.classList.contains('collapsed')) {
      node.classList.remove('collapsed');
      const btn = node.querySelector(':scope > span.xml-line > button.xml-fold-btn');
      if (btn) {
        btn.textContent = '▼';
        btn.title = '折りたたむ';
      }
    }
    node = node.parentElement?.closest('.xml-node');
  }

  mark.classList.add('xml-mark-focused');
  mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  updateNavButtons();
}

/**
 * バリデーション後にエラーマーク一覧を収集し、最初のマークへ自動ジャンプ
 */
function collectAndInitNavigation() {
  const pre = document.getElementById('xml-viewer-pre');
  if (!pre) return;
  errorMarkEls = Array.from(pre.querySelectorAll('mark.xml-mark-error, mark.xml-mark-warning'));
  errorMarkIndex = -1;
  if (errorMarkEls.length > 0) {
    jumpToMark(0);
  } else {
    updateNavButtons();
  }
}

/**
 * 現在選択中のモデルのXMLをDOMツリーとして表示します
 */
function renderXml() {
  const pre = document.getElementById('xml-viewer-pre');
  if (!pre) return;

  const schemaContext = getSchemaContext();
  updateSchemaStatus(schemaContext);

  const doc = getState(currentModel === 'A' ? 'models.documentA' : 'models.documentB');
  if (!doc) {
    pre.textContent = `(モデル${currentModel}は読み込まれていません)`;
    lastRawXml = '';
    return;
  }

  const raw = new XMLSerializer().serializeToString(doc);
  lastRawXml = formatXml(raw);
  pre.replaceChildren(renderDomTree(doc, new Map(), schemaContext));
}

/**
 * バリデーションを実行してエラーをXML上にマークします
 */
async function runValidationAndMark() {
  const pre = document.getElementById('xml-viewer-pre');
  const statusEl = document.getElementById('xml-validation-status');
  const btn = document.getElementById('xml-run-validation-btn');
  const typeSelect = document.getElementById('xml-validation-type');

  if (!pre) return;
  // XML未表示（初回表示前など）の場合は自動でレンダリングしてから続行する
  if (!lastRawXml) renderXml();
  if (!lastRawXml) {
    showWarning('モデルが読み込まれていません');
    return;
  }

  const validationType = typeSelect?.value || 'all';

  if (btn) {
    btn.disabled = true;
    btn.textContent = '実行中...';
  }
  if (statusEl) statusEl.textContent = '';

  try {
    const doc = getState(currentModel === 'A' ? 'models.documentA' : 'models.documentB');
    if (!doc) {
      showWarning(`モデル${currentModel}が読み込まれていません`);
      return;
    }

    const issues = await collectIssues(doc, validationType);
    const errorMap = buildErrorMap(issues);
    const schemaContext = getSchemaContext();
    updateSchemaStatus(schemaContext);

    pre.replaceChildren(renderDomTree(doc, errorMap, schemaContext));
    collectAndInitNavigation();

    if (statusEl) {
      const summary = summarizeIssues(issues);
      statusEl.textContent = summary.text;
      statusEl.className = summary.className;
      statusEl.title = summary.title;
    }

    log.info(`バリデーション完了: ${issues.length}件の問題を検出`);
  } catch (err) {
    log.error('バリデーション実行エラー:', err);
    showWarning(`バリデーションに失敗しました: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'バリデーション実行';
    }
  }
}

/**
 * 指定タイプのバリデーションを実行して全issueを返します
 * @param {Document} doc
 * @param {'xsd'|'mvd-s2'|'mvd-s4'|'all'} validationType
 * @returns {Promise<Array>}
 */
async function collectIssues(doc, validationType) {
  const { validateJsonSchema } = await import('../../common-stb/validation/jsonSchemaValidator.js');
  const { validateMvdRequirements } = await import('../../common-stb/validation/mvdValidator.js');

  const version = getState(`models.stbVersion${currentModel}`) || '2.0.2';
  const issues = [];

  if (validationType === 'xsd' || validationType === 'all') {
    try {
      const schemaIssues = validateJsonSchema(doc, { version });
      issues.push(...schemaIssues);
    } catch (e) {
      log.warn('XSDバリデーションエラー:', e.message);
    }
  }

  if (validationType === 'mvd-s2' || validationType === 'all') {
    try {
      const mvdIssues = validateMvdRequirements(doc, 's2');
      issues.push(...mvdIssues);
    } catch (e) {
      log.warn('MVD S2バリデーションエラー:', e.message);
    }
  }

  if (validationType === 'mvd-s4' || validationType === 'all') {
    try {
      const mvdIssues = validateMvdRequirements(doc, 's4');
      issues.push(...mvdIssues);
    } catch (e) {
      log.warn('MVD S4バリデーションエラー:', e.message);
    }
  }

  return issues;
}

/**
 * issueリストから要素ごとのエラーマップを構築します
 * @param {Array} issues
 * @returns {Map<Element|string, Array>} key: DOM Element ref（優先）または "elementType|elementId"（フォールバック）
 */
function buildErrorMap(issues) {
  const map = new Map();
  for (const issue of issues) {
    if (!issue.elementType) continue;
    // DOM element ref をキーにすることで、ID なし同型要素の誤マージを防ぐ
    const key = issue.element ?? `${issue.elementType}|${issue.elementId ?? ''}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(issue);
  }
  return map;
}

// ─── DOM ベースのツリーレンダリング ──────────────────────────────────────────

/**
 * XML Document をインタラクティブなツリーの DocumentFragment に変換します
 * @param {Document} doc
 * @param {Map<string, Array>} [errorMap]
 * @returns {DocumentFragment}
 */
function renderDomTree(doc, errorMap = new Map(), schemaContext = getSchemaContext()) {
  const fragment = document.createDocumentFragment();
  const headerLine = document.createElement('span');
  headerLine.className = 'xml-line';
  headerLine.textContent = '<?xml version="1.0" encoding="utf-8"?>';
  fragment.appendChild(headerLine);
  renderDomNode(doc.documentElement, 0, errorMap, fragment, schemaContext);
  return fragment;
}

/**
 * 単一の DOM 要素ノードを子ノードとして親に追加します（再帰）
 * @param {Element} el
 * @param {number} depth
 * @param {Map<string, Array>} errorMap
 * @param {Node} parent
 */
function renderDomNode(el, depth, errorMap, parent, schemaContext) {
  const indent = '  '.repeat(depth);
  const elementChildren = Array.from(el.childNodes).filter((n) => n.nodeType === 1);

  if (elementChildren.length === 0) {
    const text = el.textContent.trim();
    const line = document.createElement('span');
    line.className = 'xml-line';
    line.appendChild(document.createTextNode(indent));

    if (text) {
      appendTagOpen(line, el, errorMap, false, schemaContext);
      line.appendChild(document.createTextNode(text));
      appendTagClose(line, el, schemaContext);
    } else {
      appendTagOpen(line, el, errorMap, true, schemaContext);
    }
    parent.appendChild(line);
    return;
  }

  // 親ノード: 折りたたみ可能
  const node = document.createElement('span');
  node.className = 'xml-node';

  const headerLine = document.createElement('span');
  headerLine.className = 'xml-line';

  const foldBtn = document.createElement('button');
  foldBtn.className = 'xml-fold-btn';
  foldBtn.title = '折りたたむ';
  foldBtn.textContent = '▼';
  headerLine.appendChild(foldBtn);

  headerLine.appendChild(document.createTextNode(indent));
  appendTagOpen(headerLine, el, errorMap, false, schemaContext);

  const ellipsis = document.createElement('span');
  ellipsis.className = 'xml-ellipsis';
  ellipsis.textContent = ` …${elementChildren.length}要素…`;
  headerLine.appendChild(ellipsis);

  node.appendChild(headerLine);

  const childrenContainer = document.createElement('span');
  childrenContainer.className = 'xml-children';
  for (const child of elementChildren) {
    renderDomNode(child, depth + 1, errorMap, childrenContainer, schemaContext);
  }
  node.appendChild(childrenContainer);

  const closeLine = document.createElement('span');
  closeLine.className = 'xml-line';
  closeLine.appendChild(document.createTextNode(indent));
  appendTagClose(closeLine, el, schemaContext);
  node.appendChild(closeLine);

  parent.appendChild(node);
}

function appendAttribute(container, el, attr, attrIssueMap, schemaState, schemaContext) {
  const attrName = attr.name;
  const attrLookupName = attr.localName || attrName;
  const attrInfo =
    schemaState.definition?.attributes?.get(attrName) ??
    schemaState.definition?.attributes?.get(attrLookupName) ??
    null;
  const presentation = getAttributeSchemaPresentation(attrInfo, attrName);
  const schemaTitle = formatAttributeSchemaTitle({
    elementName: el.localName || el.tagName,
    attributeName: attrName,
    attrInfo,
    version: schemaContext.version,
  });

  container.appendChild(document.createTextNode(' '));
  const nameSpan = document.createElement('span');
  nameSpan.className = `xml-attr-name xml-attr-role-${presentation.role}`;
  for (const modifier of presentation.modifiers) {
    nameSpan.classList.add(`xml-attr-${modifier}`);
  }
  nameSpan.title = schemaTitle;
  nameSpan.textContent = attrName;
  container.appendChild(nameSpan);
  container.appendChild(document.createTextNode('="'));

  const attrIssues = attrIssueMap.get(attrName) || attrIssueMap.get(attrLookupName) || [];
  const attrIssue = pickPrimaryIssue(attrIssues);
  if (attrIssue && attrIssues.length > 0) {
    const mark = document.createElement('mark');
    mark.className = `xml-mark-${attrIssue.severity} ${getIssueCategoryClass(attrIssue.category)}`;
    mark.title = formatIssueTitle(attrIssues, schemaTitle);
    registerXmlValidationMarkIssues(mark, attrIssues);
    mark.textContent = attr.value;
    container.appendChild(mark);
  } else {
    const valueSpan = document.createElement('span');
    valueSpan.className = 'xml-attr-value';
    for (const modifier of presentation.modifiers) {
      valueSpan.classList.add(`xml-attr-value-${modifier}`);
    }
    valueSpan.title = schemaTitle;
    valueSpan.textContent = attr.value;
    container.appendChild(valueSpan);
  }
  container.appendChild(document.createTextNode('"'));
}

function appendMissingAttributeHint(
  container,
  el,
  attributeName,
  attrIssues,
  schemaState,
  schemaContext,
) {
  const attrInfo = schemaState.definition?.attributes?.get(attributeName) ?? null;
  const schemaTitle = formatAttributeSchemaTitle({
    elementName: el.localName || el.tagName,
    attributeName,
    attrInfo,
    version: schemaContext.version,
  });

  container.appendChild(document.createTextNode(' '));
  if (attrIssues.length > 0) {
    const primary = pickPrimaryIssue(attrIssues);
    const mark = document.createElement('mark');
    mark.className = `xml-mark-${primary?.severity || 'error'} ${getIssueCategoryClass(primary?.category)} xml-missing-attr`;
    mark.title = formatIssueTitle(attrIssues, schemaTitle);
    registerXmlValidationMarkIssues(mark, attrIssues);
    mark.textContent = `⟪@${attributeName} 欠落⟫`;
    container.appendChild(mark);
    return;
  }

  const hint = document.createElement('span');
  hint.className = 'xml-missing-required-hint';
  hint.title = `${schemaTitle}\nXML上に属性が存在しません。バリデーション実行前のXSD案内です。`;
  hint.textContent = `⟪@${attributeName} 必須⟫`;
  container.appendChild(hint);
}

/**
 * 要素の開始タグを DOM ノードとして親に追加します（属性のバリデーションマーク付き）
 * @param {Node} container
 * @param {Element} el
 * @param {Map<string, Array>} errorMap
 * @param {boolean} selfClosing
 */
function appendTagOpen(container, el, errorMap, selfClosing, schemaContext) {
  const idAttr = el.getAttribute('id');
  const issues =
    errorMap.get(el) ?? errorMap.get(`${el.localName || el.tagName}|${idAttr ?? ''}`) ?? [];

  const attrIssueMap = new Map();
  for (const issue of issues) {
    if (!issue?.attribute) continue;
    const key = issue.attribute;
    if (!attrIssueMap.has(key)) {
      attrIssueMap.set(key, []);
    }
    attrIssueMap.get(key).push(issue);
  }
  const elemIssues = issues.filter((i) => !i.attribute);
  const schemaState = getElementSchemaState(el, schemaContext);

  // 開始タグの中身を構築（<tag attr="val" ...>）
  const tagFragment = document.createDocumentFragment();
  tagFragment.appendChild(document.createTextNode('<'));
  appendTagName(tagFragment, el, schemaContext);

  const presentAttributeNames = new Set();
  for (const attr of Array.from(el.attributes)) {
    presentAttributeNames.add(attr.name);
    presentAttributeNames.add(attr.localName || attr.name);
    appendAttribute(tagFragment, el, attr, attrIssueMap, schemaState, schemaContext);
  }

  // XSD上の必須属性が欠落している場合は、検証前から薄いヒントを表示する。
  // 検証後は ValidationIssue を同じ位置に mark として描画し、前後移動の対象にする。
  const missingRequiredAttributes = getMissingRequiredAttributeNames(
    schemaState.definition,
    presentAttributeNames,
  );
  const renderedMissing = new Set();
  for (const attributeName of missingRequiredAttributes) {
    appendMissingAttributeHint(
      tagFragment,
      el,
      attributeName,
      attrIssueMap.get(attributeName) || [],
      schemaState,
      schemaContext,
    );
    renderedMissing.add(attributeName);
  }

  // MVD等、XSD必須ではないが「欠落属性」としてissue化されたケースも開始タグ上に可視化する。
  // これにより「実体が無い属性なのでmarkを置けない」問題を解消する。
  for (const [attributeName, attrIssues] of attrIssueMap) {
    if (presentAttributeNames.has(attributeName) || renderedMissing.has(attributeName)) continue;
    appendMissingAttributeHint(
      tagFragment,
      el,
      attributeName,
      attrIssues,
      schemaState,
      schemaContext,
    );
  }

  tagFragment.appendChild(document.createTextNode(selfClosing ? '/>' : '>'));

  if (elemIssues.length > 0) {
    const primaryIssue = pickPrimaryIssue(elemIssues);
    const severity = primaryIssue?.severity || 'info';
    const mark = document.createElement('mark');
    mark.className = `xml-mark-${severity} ${getIssueCategoryClass(primaryIssue?.category)}`;
    mark.title = formatIssueTitle(elemIssues, schemaState.title);
    registerXmlValidationMarkIssues(mark, elemIssues);
    mark.appendChild(tagFragment);
    container.appendChild(mark);
  } else {
    container.appendChild(tagFragment);
  }
}
