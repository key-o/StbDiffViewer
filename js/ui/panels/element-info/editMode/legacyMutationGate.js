/**
 * @fileoverview Working Session 中の旧 documentA 直接 mutation を遮断する共通ゲート。
 *
 * Add/Delete/Renumber 等が Working Command へ移行する途中で source / working が分岐しないよう、
 * 未移行の legacy mutation entry point は fail-closed とする。読み取り API は遮断しない。
 */

import editingSession from '../../../../app/editing/editingSession.js';

/**
 * @param {string} operationLabel
 * @returns {string|null} blocked reason。未開始なら null。
 */
export function getLegacyMutationBlockedReason(operationLabel = 'この編集操作') {
  if (editingSession.getState()?.active !== true) return null;
  return `Working Session 中の${operationLabel}は Working Command へ未移行のため実行できません。`;
}

/**
 * success/id 形式の既存 mutation API 用 fail-closed result。
 * @param {string} operationLabel
 * @param {Object} [extra]
 * @returns {Object|null}
 */
export function getLegacyMutationFailure(operationLabel, extra = {}) {
  const error = getLegacyMutationBlockedReason(operationLabel);
  return error ? { success: false, error, ...extra } : null;
}

/**
 * 例外契約の mutation API 用。
 * @param {string} operationLabel
 */
export function assertLegacyMutationAllowed(operationLabel) {
  const error = getLegacyMutationBlockedReason(operationLabel);
  if (error) throw new Error(error);
}
