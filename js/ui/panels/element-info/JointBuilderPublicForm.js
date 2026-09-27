/**
 * @fileoverview JointBuilder public safety gate。
 *
 * ST-Bridge 2.1.x JointArrangement は typed Working Command のみを public route とし、
 * Working Session 外で旧 member.id_section 流用 route へ落ちることを防ぐ。
 */

import { getState } from '../../../data/state/globalState.js';
import editingSession from '../../../app/editing/editingSession.js';
import { detectStbVersion } from '../../../common-stb/import/parser/utils/stbVersionDetection.js';
import { showError } from '../../common/toast.js';
import { openJointBuilder as openTypedJointBuilder } from './JointBuilderTypedForm.js';

function activeDocument() {
  if (editingSession.getState()?.active === true) {
    return editingSession.getWorkingDocument() || null;
  }
  return getState('models.documentA');
}

export function openJointBuilder() {
  const document = activeDocument();
  const version = document ? detectStbVersion(document) : 'unknown';
  if (String(version || '').startsWith('2.1') && editingSession.getState()?.active !== true) {
    showError('ST-Bridge 2.1.x の継手配置編集は Working Session を開始してから実行してください。');
    return Promise.resolve(null);
  }
  return openTypedJointBuilder();
}

export function initJointBuilderForm() {
  if (document.getElementById('add-joint-button')) return;
  const memberButton = document.getElementById('add-member-button');
  if (!memberButton?.parentElement) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'add-joint-button';
  button.className = memberButton.className || 'btn btn-secondary';
  button.title = 'ST-Bridgeバージョンに応じた継手定義または継手配置を作成します';
  button.textContent = '＋ 継手';
  button.addEventListener('click', () => openJointBuilder());
  memberButton.insertAdjacentElement('afterend', button);
}
