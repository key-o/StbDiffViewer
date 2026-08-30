/**
 * @fileoverview 要素情報パネルの表示モデル判定ヘルパー
 *
 * 単一モデル表示時に、どちらのモデルを表示しているかを一貫して判定します。
 * タイトルとテーブルヘッダーの両方で同じ判定を再利用します。
 */

import { getState } from '../../../data/state/globalState.js';
import { escapeHtml } from '../../../utils/htmlUtils.js';

/**
 * modelSource を要素情報パネル用のモデル側識別子に正規化
 * @param {string|null|undefined} modelSource
 * @returns {'A'|'B'|null}
 */
export function normalizeElementInfoModelSide(modelSource) {
  if (modelSource === 'A' || modelSource === 'onlyA') {
    return 'A';
  }
  if (modelSource === 'B' || modelSource === 'onlyB') {
    return 'B';
  }
  return null;
}

/**
 * 単一カラム表示かどうかを判定
 * @param {Object} options
 * @param {boolean} [options.hasPrimaryA=false] - 実際に表示する A 側ノード/メッシュがあるか
 * @param {boolean} [options.hasPrimaryB=false] - 実際に表示する B 側ノード/メッシュがあるか
 * @param {boolean} [options.hasModelA=false] - モデル A ドキュメントが読み込まれているか
 * @param {boolean} [options.hasModelB=false] - モデル B ドキュメントが読み込まれているか
 * @returns {boolean}
 */
export function shouldUseSingleColumnElementInfo({
  hasPrimaryA = false,
  hasPrimaryB = false,
  hasModelA = false,
  hasModelB = false,
} = {}) {
  const isSingleModel = (hasModelA && !hasModelB) || (!hasModelA && hasModelB);
  const hasOnlyA = hasPrimaryA && !hasPrimaryB;
  const hasOnlyB = !hasPrimaryA && hasPrimaryB;
  return isSingleModel || hasOnlyA || hasOnlyB;
}

/**
 * 単一表示時にどちらのモデルを表示しているかを解決
 *
 * 優先順:
 * 1. 実際に表示しているノード/メッシュ側
 * 2. 明示的な modelSource
 * 3. 単一ドキュメント読込時のフォールバック
 *
 * @param {Object} options
 * @param {boolean} [options.hasPrimaryA=false]
 * @param {boolean} [options.hasPrimaryB=false]
 * @param {string|null|undefined} [options.modelSource=null]
 * @param {boolean} [options.hasModelA=false]
 * @param {boolean} [options.hasModelB=false]
 * @returns {'A'|'B'|null}
 */
export function resolveElementInfoModelSide({
  hasPrimaryA = false,
  hasPrimaryB = false,
  modelSource = null,
  hasModelA = false,
  hasModelB = false,
} = {}) {
  if (hasPrimaryA && !hasPrimaryB) {
    return 'A';
  }
  if (!hasPrimaryA && hasPrimaryB) {
    return 'B';
  }

  const normalizedSource = normalizeElementInfoModelSide(modelSource);
  if (normalizedSource) {
    return normalizedSource;
  }

  if (hasModelA && !hasModelB) {
    return 'A';
  }
  if (!hasModelA && hasModelB) {
    return 'B';
  }

  return null;
}

/**
 * ファイル名から最初と最後を抽出して表示用のファイル名を生成
 * 例: "structure_building_2024.stb" -> "structure_...2024.stb"
 * @param {string} fileName - 元のファイル名
 * @returns {string} - 表示用のファイル名
 */
export function formatFileNameForDisplay(fileName) {
  if (!fileName || fileName.length <= 30) {
    return fileName;
  }

  // 拡張子を取得
  const lastDotIndex = fileName.lastIndexOf('.');
  let name = fileName;
  let ext = '';
  if (lastDotIndex > 0) {
    name = fileName.substring(0, lastDotIndex);
    ext = fileName.substring(lastDotIndex);
  }

  // 名前の最初と最後を抽出
  const maxNameLength = 30 - ext.length - 3; // "..." の 3 文字分
  const firstPart = name.substring(0, Math.ceil(maxNameLength / 2));
  const lastPart = name.substring(Math.max(name.length - Math.floor(maxNameLength / 2)));

  return `${firstPart}...${lastPart}${ext}`;
}

/**
 * モデル側のファイル名を取得
 * @param {'A'|'B'|null|undefined} modelSide
 * @returns {string} - ファイル名またはモデルラベル
 */
function getModelFileName(modelSide) {
  if (!modelSide) {
    return null;
  }

  const fileKey = modelSide === 'B' ? 'files.originalFileB' : 'files.originalFileA';
  const fileObject = getState(fileKey);

  if (fileObject && fileObject.name) {
    return formatFileNameForDisplay(fileObject.name);
  }

  return null;
}

/**
 * モデル側識別子を UI 表示ラベルへ変換
 * @param {'A'|'B'|null|undefined} modelSide
 * @returns {string}
 */
export function getElementInfoModelLabel(modelSide) {
  const fileName = getModelFileName(modelSide);
  if (fileName) {
    return fileName;
  }
  return modelSide === 'B' ? 'モデル B' : 'モデル A';
}

/**
 * 単一モデル表示用タイトルを生成
 *
 * body は呼び出し側で組み立て済みの安全な HTML 断片（動的値はエスケープ済み）。
 * モデルラベルはファイル名（ユーザー入力由来）を含むためここでエスケープする。
 * @param {'A'|'B'|null|undefined} modelSide
 * @param {string} body - エスケープ済みの HTML 断片
 * @returns {string}
 */
export function buildSingleModelTitle(modelSide, body) {
  return `${escapeHtml(getElementInfoModelLabel(modelSide))}: ${body}`;
}

/**
 * 単一カラム表示用のヘッダー HTML を生成
 * @param {string} labelColumnText
 * @param {'A'|'B'|null|undefined} modelSide
 * @returns {string}
 */
export function buildSingleColumnHeaderHtml(labelColumnText, modelSide) {
  return `<thead><tr><th style="width: 50%;">${labelColumnText}</th><th style="width: 50%;">${escapeHtml(getElementInfoModelLabel(modelSide))}</th></tr></thead>`;
}

/**
 * 比較表示用のヘッダー HTML を生成
 * @param {string} labelColumnText
 * @returns {string}
 */
export function buildComparisonHeaderHtml(labelColumnText) {
  const labelA = escapeHtml(getElementInfoModelLabel('A'));
  const labelB = escapeHtml(getElementInfoModelLabel('B'));
  return `<thead><tr><th style="width: 40%;">${labelColumnText}</th><th style="width: 30%;">${labelA}</th><th style="width: 30%;">${labelB}</th></tr></thead>`;
}
