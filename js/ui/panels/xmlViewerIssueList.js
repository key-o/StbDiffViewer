/**
 * @fileoverview 生XMLビューの検証結果一覧とジャンプ操作。
 *
 * xmlViewer.js が描画した mark 要素を監視して、検証結果を
 * 「種別 → 要素/属性」の2段階に集約する。検証ロジック自体は持たず、
 * issue分類は common-stb/validation/issuePresentation.js を再利用する。
 */

import { groupValidationIssueDescriptors } from '../../common-stb/validation/issuePresentation.js';
import { describeXmlValidationMarks } from './xmlViewerIssueDescriptor.js';

const MARK_SELECTOR = 'mark.xml-mark-error, mark.xml-mark-warning';
const STYLE_ID = 'xml-viewer-issue-list-style';
const HOST_ID = 'xml-viewer-issue-list';
const ROW_BATCH_SIZE = 100;

let marks = [];
let descriptors = [];
let currentIndex = -1;
let observer = null;
let refreshQueued = false;

function ensureStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = './style/components/xml-viewer-issues.css';
  document.head.appendChild(link);
}

function createHost(pre) {
  let host = document.getElementById(HOST_ID);
  if (host) return host;

  host = document.createElement('section');
  host.id = HOST_ID;
  host.className = 'xml-issue-list hidden';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'xml-issue-list-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML =
    '<span class="xml-issue-list-chevron">▶</span>' +
    '<span class="xml-issue-list-title">検証結果一覧</span>' +
    '<span class="xml-issue-list-count"></span>';

  const body = document.createElement('div');
  body.className = 'xml-issue-list-body hidden';

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    body.classList.toggle('hidden', expanded);
    const chevron = toggle.querySelector('.xml-issue-list-chevron');
    if (chevron) chevron.textContent = expanded ? '▶' : '▼';
  });

  host.append(toggle, body);
  pre.before(host);
  return host;
}

function expandCollapsedAncestors(mark) {
  let node = mark.closest('.xml-node');
  while (node) {
    if (node.classList.contains('collapsed')) {
      node.classList.remove('collapsed');
      const button = node.querySelector(':scope > span.xml-line > button.xml-fold-btn');
      if (button) {
        button.textContent = '▼';
        button.title = '折りたたむ';
      }
    }
    node = node.parentElement?.closest('.xml-node');
  }
}

function updateNavigationControls() {
  const prev = document.getElementById('xml-prev-error-btn');
  const next = document.getElementById('xml-next-error-btn');
  const label = document.getElementById('xml-error-nav-label');
  const total = marks.length;

  if (prev) prev.disabled = total === 0 || currentIndex <= 0;
  if (next) next.disabled = total === 0 || currentIndex < 0 || currentIndex >= total - 1;
  if (label) {
    label.textContent =
      total === 0 ? '' : `${currentIndex >= 0 ? currentIndex + 1 : '-'} / ${total} 箇所`;
    label.title =
      total === 0 ? '' : `検証箇所 ${currentIndex >= 0 ? currentIndex + 1 : '-'} / ${total}`;
  }
}

/**
 * 一覧・前後ボタンのどちらからでも同じジャンプ処理を使う。
 * @param {number} index
 */
function jumpToXmlValidationMark(index) {
  if (index < 0 || index >= marks.length) return;

  document
    .querySelectorAll('#xml-viewer-pre mark.xml-mark-focused')
    .forEach((mark) => mark.classList.remove('xml-mark-focused'));

  currentIndex = index;
  const mark = marks[index];
  expandCollapsedAncestors(mark);
  mark.classList.add('xml-mark-focused');
  mark.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  updateNavigationControls();
}

function bindNavigationButton(buttonId, direction) {
  const button = document.getElementById(buttonId);
  if (!button || button.dataset.xmlIssueListBound === 'true') return;
  button.dataset.xmlIssueListBound = 'true';
  button.addEventListener(
    'click',
    (event) => {
      if (marks.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const base = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : marks.length;
      const nextIndex = base + direction;
      if (nextIndex >= 0 && nextIndex < marks.length) jumpToXmlValidationMark(nextIndex);
    },
    true,
  );
}

function createJumpButton(item, label = '移動') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'xml-issue-jump-btn';
  button.textContent = label;
  button.title = item.message || 'XML上の該当箇所へ移動';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    jumpToXmlValidationMark(item.index);
  });
  return button;
}

function createItemRow(item) {
  const row = document.createElement('div');
  row.className = `xml-issue-row xml-issue-row-${item.severity}`;

  const location = document.createElement('span');
  location.className = 'xml-issue-location';
  location.textContent = item.identity || `<${item.elementType}>`;

  const message = document.createElement('span');
  message.className = 'xml-issue-message';
  message.textContent = item.message || '(詳細なし)';
  message.title = item.mark.title || item.message || '';

  row.append(location, message, createJumpButton(item));
  return row;
}

function appendRowsInBatches(container, items) {
  let renderedCount = 0;
  let moreButton = null;

  const appendNextBatch = () => {
    const end = Math.min(renderedCount + ROW_BATCH_SIZE, items.length);
    const fragment = document.createDocumentFragment();
    for (let i = renderedCount; i < end; i += 1) {
      fragment.appendChild(createItemRow(items[i]));
    }
    container.insertBefore(fragment, moreButton);
    renderedCount = end;

    if (renderedCount >= items.length) {
      moreButton?.remove();
      moreButton = null;
      return;
    }

    if (!moreButton) {
      moreButton = document.createElement('button');
      moreButton.type = 'button';
      moreButton.className = 'xml-issue-more-btn';
      moreButton.addEventListener('click', appendNextBatch);
      container.appendChild(moreButton);
    }
    moreButton.textContent = `さらに表示 (${items.length - renderedCount}件)`;
  };

  appendNextBatch();
}

function renderSubgroup(subgroup) {
  const details = document.createElement('details');
  details.className = 'xml-issue-subgroup';

  const summary = document.createElement('summary');
  const label = document.createElement('span');
  label.className = 'xml-issue-subgroup-label';
  label.textContent = `<${subgroup.elementType}>${subgroup.attribute ? ` @${subgroup.attribute}` : ''}`;
  const count = document.createElement('span');
  count.className = 'xml-issue-count-badge';
  count.textContent = String(subgroup.count);
  summary.append(label, count, createJumpButton(subgroup.items[0], '先頭'));
  details.appendChild(summary);

  let rendered = false;
  details.addEventListener('toggle', () => {
    if (!details.open || rendered) return;
    rendered = true;
    const rows = document.createElement('div');
    rows.className = 'xml-issue-subgroup-rows';
    details.appendChild(rows);
    appendRowsInBatches(rows, subgroup.items);
  });
  return details;
}

function renderIssueList() {
  const pre = document.getElementById('xml-viewer-pre');
  if (!pre) return;
  const host = createHost(pre);
  const body = host.querySelector('.xml-issue-list-body');
  const count = host.querySelector('.xml-issue-list-count');
  if (!body || !count) return;

  if (descriptors.length === 0) {
    host.classList.add('hidden');
    body.replaceChildren();
    count.textContent = '';
    return;
  }

  host.classList.remove('hidden');
  count.textContent = `${descriptors.length}件 / ${marks.length}箇所`;
  const groups = groupValidationIssueDescriptors(descriptors);
  const fragment = document.createDocumentFragment();

  for (const group of groups) {
    const details = document.createElement('details');
    details.className = 'xml-issue-kind-group';
    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = group.label;
    const badge = document.createElement('span');
    badge.className = 'xml-issue-count-badge';
    badge.textContent = String(group.count);
    summary.append(label, badge);
    details.appendChild(summary);

    let rendered = false;
    details.addEventListener('toggle', () => {
      if (!details.open || rendered) return;
      rendered = true;
      const content = document.createElement('div');
      content.className = 'xml-issue-kind-content';
      for (const subgroup of group.subgroups) content.appendChild(renderSubgroup(subgroup));
      details.appendChild(content);
    });
    fragment.appendChild(details);
  }

  body.replaceChildren(fragment);
}

function refreshFromXmlMarks() {
  const pre = document.getElementById('xml-viewer-pre');
  if (!pre) return;
  marks = Array.from(pre.querySelectorAll(MARK_SELECTOR));
  descriptors = marks.flatMap((mark, index) => describeXmlValidationMarks(mark, index));

  const focused = marks.findIndex((mark) => mark.classList.contains('xml-mark-focused'));
  currentIndex = focused >= 0 ? focused : marks.length > 0 ? 0 : -1;
  renderIssueList();
  updateNavigationControls();
}

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  globalThis.queueMicrotask(() => {
    refreshQueued = false;
    refreshFromXmlMarks();
  });
}

/**
 * 生XMLビューの検証結果一覧を初期化する。
 */
export function initializeXmlViewerIssueList() {
  const pre = document.getElementById('xml-viewer-pre');
  if (!pre || observer) return;

  ensureStylesheet();
  createHost(pre);
  bindNavigationButton('xml-prev-error-btn', -1);
  bindNavigationButton('xml-next-error-btn', +1);

  observer = new MutationObserver(scheduleRefresh);
  observer.observe(pre, { childList: true, subtree: true });
  refreshFromXmlMarks();
}
