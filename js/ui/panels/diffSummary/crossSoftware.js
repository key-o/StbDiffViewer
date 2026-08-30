/**
 * @fileoverview 異ソフト間比較モードの付加情報生成（C2 プリコンディション / A5 スコープ調停）
 *
 * 異ソフト間比較モード時に、比較結果へ付加情報（同一建物プリコンディション判定・
 * 片側欠落カテゴリのスコープ調停）を組み立て、サマリー表示用の注記HTMLを生成します。
 */

import { getElementTypeDisplayName, formatPct } from './format.js';
import { isCrossSoftwareModeEnabled } from '../../../config/crossSoftwareConfig.js';
import { checkBuildingPrecondition } from '../../../common-stb/comparison/buildingPreconditionChecker.js';
import {
  findOneSidedCategories,
  computeScopeAdjustedRate,
} from '../../../common-stb/comparison/scopeReconciliation.js';
import { getState } from '../../../data/state/globalState.js';

// ---------------------------------------------------------------------------
// 異ソフト間比較モードの付加情報（C2 プリコンディション / A5 スコープ調停）
// ---------------------------------------------------------------------------

/**
 * 異ソフト間比較モード時の付加情報を構築する。
 * モードOFF、またはモデルA/Bが揃っていない場合は null（既存表示は不変）。
 *
 * @param {Object} comparisonResults - 比較結果
 * @param {Object} stats - calculateDiffStatistics の集計値
 * @returns {{
 *   precondition: Object|null,
 *   oneSidedCategories: Array<Object>,
 *   oneSidedTypes: Set<string>,
 *   scopeAdjusted: Object|null,
 * }|null}
 */
export function buildCrossSoftwareInfo(comparisonResults, stats) {
  if (!isCrossSoftwareModeEnabled()) return null;
  const documentA = getState('models.documentA');
  const documentB = getState('models.documentB');
  if (!documentA || !documentB) return null;

  const precondition = checkBuildingPrecondition(documentA, documentB);
  const oneSidedCategories = findOneSidedCategories(comparisonResults);
  return {
    precondition,
    oneSidedCategories,
    oneSidedTypes: new Set(oneSidedCategories.map((note) => note.elementType)),
    scopeAdjusted: computeScopeAdjustedRate(stats, oneSidedCategories),
  };
}

/**
 * C2 プリコンディション警告のメッセージを生成する。
 * @param {Object} precondition - checkBuildingPrecondition の結果
 * @returns {string} 警告メッセージ
 */
export function buildPreconditionWarningMessage(precondition) {
  const { story, axis } = precondition.details;
  const parts = [];
  if (story) {
    parts.push(`階標高一致 ${story.matchedCount}/${Math.max(story.countA, story.countB)}`);
  }
  if (axis) {
    parts.push(`通り芯一致 ${axis.matchedCount}/${Math.max(axis.countA, axis.countB)}`);
  }
  const scorePct = `${(precondition.score * 100).toFixed(1)}%`;
  return (
    `別建物の可能性: 階・通り芯の構成が大きく異なります（類似度 ${scorePct}、${parts.join('・')}）。` +
    '異ソフト間比較モードは同一建物の比較を想定しています。'
  );
}

/**
 * 異ソフト間比較モードの注記ブロック（C2 警告 / A5 カテゴリ注記）を生成する。
 * @param {Object} stats - 統計データ（crossSoftware を含みうる）
 * @returns {string} HTML文字列（モードOFF時は空文字）
 */
export function generateCrossSoftwareNotices(stats) {
  const info = stats.crossSoftware;
  if (!info) return '';

  let html = '';

  // C2: 同一建物プリコンディション警告
  const precondition = info.precondition;
  if (precondition && precondition.judgeable && !precondition.similar) {
    const { story, axis } = precondition.details;
    const detailParts = [];
    if (story) {
      detailParts.push(
        `階数 A:${story.countA} / B:${story.countB}（標高一致 ${story.matchedCount}件）`,
      );
    }
    if (axis) {
      detailParts.push(
        `通り芯 A:${axis.countA} / B:${axis.countB}（距離一致 ${axis.matchedCount}件）`,
      );
    }
    html += `
      <div class="diff-cross-precondition">
        <span class="diff-cross-precondition-icon">⚠️</span>
        <span class="diff-cross-precondition-text">
          <strong>別建物の可能性</strong>（類似度 ${(precondition.score * 100).toFixed(1)}%）:
          ${detailParts.join('・')}。
          異ソフト間比較モードは同一建物の比較を想定しています。
        </span>
      </div>
    `;
  }

  // A5: 片側欠落カテゴリの注記（onlyA/onlyB の羅列ではなくスコープ差として提示）
  if (info.oneSidedCategories.length > 0) {
    const items = info.oneSidedCategories
      .map((note) => {
        const label = getElementTypeDisplayName(note.elementType);
        const presentModel = note.presentIn === 'A' ? 'モデルA' : 'モデルB';
        const missingModel = note.presentIn === 'A' ? 'モデルB' : 'モデルA';
        return `<li>${label}: ${presentModel}のみ ${note.count}件（${missingModel}は本カテゴリを出力していません）</li>`;
      })
      .join('');
    const adjusted = info.scopeAdjusted;
    const adjustedLine = adjusted
      ? `<div class="diff-cross-scope-adjusted">スコープ調停後の対応率:
          <strong>${formatPct(stats.totalCorresponding, adjusted.adjustedTotal)}</strong>
          （片側のみのカテゴリ ${adjusted.excludedCount}件 を分母から除外、${stats.totalCorresponding} / ${adjusted.adjustedTotal}）</div>`
      : '';
    html += `
      <div class="diff-cross-scope-note">
        <div class="diff-cross-scope-title">📌 カテゴリ注記（片側のみ出力）</div>
        <ul class="diff-cross-scope-list">${items}</ul>
        ${adjustedLine}
        <div class="diff-cross-scope-hint">ソフトの出力範囲（スコープ）の違いによる差の可能性があります</div>
      </div>
    `;
  }

  return html;
}
