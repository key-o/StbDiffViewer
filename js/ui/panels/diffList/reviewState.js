/**
 * @fileoverview 差分レビュー状態を比較結果とは別に保存する。
 * モデル組と差分内容のfingerprintが一致する確認状態だけを有効にする。
 */

import { getState } from '../../../data/state/globalState.js';
import { storageHelper } from '../../../utils/storageHelper.js';

const REVIEW_STORAGE_PREFIX = 'diff-review:v1:';
const REVIEW_STATUSES = new Set(['unreviewed', 'confirmed', 'needsDiscussion']);
const MAX_COMMENT_LENGTH = 4_000;

function hashText(value) {
  // 53-bit deterministic hash. This is an identity fingerprint, not a security primitive.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h2 >>> 15), 2246822507);
  h2 = Math.imul(h2 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function canonicalizeNode(node) {
  if (!node) return null;
  if (node.nodeType === 1) {
    const attributes = Array.from(node.attributes || [])
      .map((attribute) => [
        attribute.namespaceURI || '',
        attribute.localName || attribute.name,
        attribute.value,
      ])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const children = Array.from(node.childNodes || [])
      .map(canonicalizeNode)
      .filter((child) => child !== null);
    return [node.namespaceURI || '', node.localName || node.nodeName, attributes, children];
  }
  if (node.nodeType === 3 || node.nodeType === 4) {
    const text = String(node.nodeValue || '')
      .replace(/\r\n?/g, '\n')
      .trim();
    return text ? ['text', text] : null;
  }
  return null;
}

function stableValue(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value !== 'object') return value;
  if (typeof value.nodeType === 'number') return canonicalizeNode(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => stableValue(item, seen));
  } else if (value instanceof Map) {
    result = [...value.entries()]
      .map(([key, entry]) => [stableValue(key, seen), stableValue(entry, seen)])
      .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
  } else if (value instanceof Set) {
    result = [...value]
      .map((item) => stableValue(item, seen))
      .sort((a, b) => String(JSON.stringify(a)).localeCompare(String(JSON.stringify(b))));
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (typeof value[key] === 'function') continue;
      result[key] = stableValue(value[key], seen);
    }
  }
  // Track only the current recursion chain so shared-but-acyclic objects serialize by value.
  seen.delete(value);
  return result;
}

function serializeDocument(document) {
  if (!document) return null;
  const target = document.documentElement || document;
  if (typeof XMLSerializer !== 'undefined') {
    try {
      return new XMLSerializer().serializeToString(target);
    } catch {
      // Fall through to the namespace/attribute sorted DOM representation.
    }
  }
  return JSON.stringify(canonicalizeNode(target));
}

export function getDiffReviewModelFingerprint(
  documentA = getState('models.documentA'),
  documentB = getState('models.documentB'),
) {
  if (!documentA && !documentB) return null;
  const sourceA = serializeDocument(documentA) || '';
  const sourceB = serializeDocument(documentB) || '';
  return hashText(`A:${sourceA.length}:${sourceA}\nB:${sourceB.length}:${sourceB}`);
}

export function createDiffReviewKey(item) {
  if (!item?.elementType || item.id === null || item.id === undefined) return null;
  return JSON.stringify([String(item.elementType), String(item.category), String(item.id)]);
}

export function getDiffReviewItemFingerprint(item) {
  const data = item?.data || {};
  const sourceA =
    data.dataA?.rawElement || (item?.category === 'onlyA' ? data.rawElement || data : data.dataA);
  const sourceB =
    data.dataB?.rawElement || (item?.category === 'onlyB' ? data.rawElement || data : data.dataB);
  const payload = {
    elementType: item?.elementType || null,
    id: item?.id === null || item?.id === undefined ? null : String(item.id),
    category: item?.category || null,
    diffStatus: item?.diffStatus || data.diffStatus || null,
    attributeMismatchKind: item?.attributeMismatchKind || data.attributeMismatchKind || null,
    attributeDiffDetails: data.attributeDiffDetails || null,
    versionDifferences: item?.versionDifferences || data.versionDifferences || [],
    sourceA,
    sourceB,
  };
  return hashText(JSON.stringify(stableValue(payload)));
}

function validReviewRecord(record) {
  return (
    record &&
    typeof record === 'object' &&
    REVIEW_STATUSES.has(record.status) &&
    typeof record.diffFingerprint === 'string'
  );
}

export class DiffReviewStateStore {
  constructor({ storage = storageHelper } = {}) {
    this.storage = storage;
    this.modelFingerprint = null;
    this.storageKey = null;
    this.records = {};
  }

  setModelFingerprint(fingerprint) {
    const normalized = typeof fingerprint === 'string' && fingerprint ? fingerprint : null;
    if (normalized === this.modelFingerprint) return;

    this.modelFingerprint = normalized;
    this.storageKey = normalized ? `${REVIEW_STORAGE_PREFIX}${normalized}` : null;
    const stored = this.storageKey ? this.storage.get(this.storageKey, {}) : {};
    this.records = {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
    for (const [key, record] of Object.entries(stored)) {
      if (!validReviewRecord(record)) continue;
      this.records[key] = {
        status: record.status,
        diffFingerprint: record.diffFingerprint,
        comment:
          typeof record.comment === 'string' ? record.comment.slice(0, MAX_COMMENT_LENGTH) : '',
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
      };
    }
  }

  get(key, diffFingerprint) {
    const record = key ? this.records[key] : null;
    const matches = !!record && record.diffFingerprint === diffFingerprint;
    return {
      status: matches ? record.status : 'unreviewed',
      // コメントも差分内容に結び付ける。古い差分の注記を新しい内容へ誤適用しない。
      comment: matches ? record.comment || '' : '',
      invalidated: !!record && !matches,
      updatedAt: matches ? record.updatedAt : null,
    };
  }

  set(key, diffFingerprint, { status, comment } = {}) {
    if (!key || typeof diffFingerprint !== 'string') return false;
    const existing = this.get(key, diffFingerprint);
    const nextStatus = REVIEW_STATUSES.has(status) ? status : existing.status;
    const nextComment =
      comment === undefined ? existing.comment : String(comment).slice(0, MAX_COMMENT_LENGTH);
    this.records[key] = {
      status: nextStatus,
      diffFingerprint,
      comment: nextComment,
      updatedAt: new Date().toISOString(),
    };
    if (this.storageKey) this.storage.set(this.storageKey, this.records);
    return true;
  }
}

export const diffListReviewMethods = {
  prepareDiffReviewItems() {
    this.reviewStateStore.setModelFingerprint(getDiffReviewModelFingerprint());
    for (const item of Object.values(this.diffData || {}).flat()) {
      item.reviewKey = createDiffReviewKey(item);
      item.reviewFingerprint = getDiffReviewItemFingerprint(item);
    }
  },

  getDiffReviewState(item) {
    if (!item?.reviewKey) {
      item.reviewKey = createDiffReviewKey(item);
      item.reviewFingerprint = getDiffReviewItemFingerprint(item);
    }
    return this.reviewStateStore.get(item?.reviewKey, item?.reviewFingerprint);
  },

  renderDiffReviewControls(item) {
    const review = this.getDiffReviewState(item);
    const statusOptions = [
      ['unreviewed', '未確認'],
      ['confirmed', '確認済み'],
      ['needsDiscussion', '要協議'],
    ];
    const options = statusOptions
      .map(
        ([value, label]) =>
          `<option value="${value}"${review.status === value ? ' selected' : ''}>${label}</option>`,
      )
      .join('');
    const commentOpen = review.comment ? ' open' : '';
    return `
      <span class="diff-review-controls" data-review-key="${escapeAttribute(item.reviewKey)}">
        <select class="diff-review-status" aria-label="レビュー状態" title="レビュー状態">${options}</select>
        <details class="diff-review-comment"${commentOpen}>
          <summary title="コメント">✎</summary>
          <textarea class="diff-review-note" maxlength="${MAX_COMMENT_LENGTH}" aria-label="レビューコメント" placeholder="コメントを記録">${escapeHtml(review.comment)}</textarea>
        </details>
        ${
          review.invalidated
            ? '<span class="diff-review-invalidated" title="差分内容が変わったため再確認が必要です">再確認</span>'
            : ''
        }
      </span>
    `;
  },

  findDiffItemForReviewKey(reviewKey) {
    for (const item of Object.values(this.diffData || {}).flat()) {
      if (item.reviewKey === reviewKey) return item;
    }
    return null;
  },

  handleDiffReviewChange(event) {
    const target = event.target;
    if (!target?.matches?.('.diff-review-status, .diff-review-note')) return;
    const controls = target.closest('.diff-review-controls');
    const item = this.findDiffItemForReviewKey(controls?.dataset.reviewKey);
    if (!item) return;

    const patch = target.matches('.diff-review-status')
      ? { status: target.value }
      : { comment: target.value };
    this.reviewStateStore.set(item.reviewKey, item.reviewFingerprint, patch);
    if (target.matches('.diff-review-status')) this.renderList();
  },
};

function escapeAttribute(value) {
  return String(value || '').replace(/[&"'<>]/g, (character) => {
    const entities = { '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' };
    return entities[character];
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&"'<>]/g, (character) => {
    const entities = { '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' };
    return entities[character];
  });
}
