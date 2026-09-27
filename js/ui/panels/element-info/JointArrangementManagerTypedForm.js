/**
 * @fileoverview ST-Bridge 2.1.x の typed StbJointArrangement 管理UI。
 *
 * host 部材と StbJoints の継手定義を別々の参照として扱い、再割当時に
 * kind_member / id_member / id_section を Working Command の1 transactionへ載せる。
 */

import { showError } from '../../common/toast.js';
import { detectStbVersion } from '../../../common-stb/import/parser/utils/stbVersionDetection.js';
import {
  deleteJointArrangement,
  editingSession,
  getCompatibleJointDefinitions21,
  reassignJointArrangement,
} from './editMode/index.js';

const MEMBER_TAGS = ['StbColumn', 'StbPost', 'StbGirder', 'StbBeam', 'StbBrace'];
const TAG_BY_KIND = Object.freeze({
  COLUMN: 'StbColumn',
  POST: 'StbPost',
  GIRDER: 'StbGirder',
  BEAM: 'StbBeam',
  BRACE: 'StbBrace',
});

function createSelectRow(labelText) {
  const row = document.createElement('div');
  row.className = 'add-member-row';
  const label = document.createElement('label');
  label.className = 'add-member-label';
  label.textContent = labelText;
  const select = document.createElement('select');
  select.className = 'parameter-dropdown';
  row.append(label, select);
  return { row, select };
}

function getWorking21Document() {
  if (editingSession.getState()?.active !== true) {
    return { document: null, error: '継手配置管理は Working Session 中のみ利用できます。' };
  }
  const workingDocument = editingSession.getWorkingDocument();
  if (!workingDocument) return { document: null, error: 'Working Document がありません。' };
  const version = detectStbVersion(workingDocument);
  if (!String(version || '').startsWith('2.1')) {
    return {
      document: null,
      error: `継手配置管理は ST-Bridge 2.1.x の StbJointArrangement のみ対象です: ${version || '(unknown)'}`,
    };
  }
  return { document: workingDocument, error: null };
}

function getArrangements(document) {
  return Array.from(
    document.querySelectorAll('StbMembers > StbJointArrangements > StbJointArrangement'),
  ).filter((element) => element.getAttribute('id'));
}

function getMembers(document) {
  return MEMBER_TAGS.flatMap((tagName) => {
    if (getCompatibleJointDefinitions21(document, tagName).length === 0) return [];
    return Array.from(document.querySelectorAll(tagName))
      .filter((element) => element.getAttribute('id'))
      .map((element) => ({ tagName, element }));
  });
}

function arrangementLabel(arrangement) {
  const id = arrangement.getAttribute('id');
  const name = arrangement.getAttribute('name');
  const kind = arrangement.getAttribute('kind_member');
  const memberId = arrangement.getAttribute('id_member');
  const jointId = arrangement.getAttribute('id_section');
  const point = arrangement.getAttribute('starting_point');
  return `${name ? `${name} / ` : ''}#${id} → ${kind || '?'} #${memberId || '?'} / 継手 #${jointId || '?'}${point ? ` / ${point}` : ''}`;
}

function memberLabel({ tagName, element }) {
  const id = element.getAttribute('id');
  const name = element.getAttribute('name');
  return name ? `${tagName} ${name} (#${id})` : `${tagName} #${id}`;
}

function jointLabel(definition) {
  return definition.name
    ? `${definition.tagName} ${definition.name} (#${definition.id})`
    : `${definition.tagName} #${definition.id}`;
}

function findCurrentMemberIndex(arrangement, members) {
  const tagName = TAG_BY_KIND[String(arrangement?.getAttribute('kind_member') || '')];
  const memberId = String(arrangement?.getAttribute('id_member') || '');
  return members.findIndex(
    (member) =>
      member.tagName === tagName && String(member.element.getAttribute('id')) === memberId,
  );
}

function populateJointSelect(select, sourceDocument, memberTag, preferredId = '') {
  const definitions = getCompatibleJointDefinitions21(sourceDocument, memberTag);
  const uiDocument = select.ownerDocument;
  select.innerHTML = '';
  for (const definition of definitions) {
    const option = uiDocument.createElement('option');
    option.value = definition.id;
    option.textContent = jointLabel(definition);
    select.appendChild(option);
  }
  if (preferredId && definitions.some((definition) => definition.id === String(preferredId))) {
    select.value = String(preferredId);
  } else if (definitions.length > 0) {
    select.selectedIndex = 0;
  }
  return definitions;
}

/** 既存 StbJointArrangement の再割当・削除フォームを開く。 */
export function openJointArrangementManager() {
  return new Promise((resolve) => {
    const resolved = getWorking21Document();
    if (!resolved.document) {
      showError(resolved.error);
      resolve(null);
      return;
    }
    const doc = resolved.document;
    const arrangements = getArrangements(doc);
    const members = getMembers(doc);
    if (arrangements.length === 0) {
      showError('Working Document に StbJointArrangement がありません。');
      resolve(null);
      return;
    }
    if (members.length === 0) {
      showError('StbJoints に対応継手定義を持つ再割当可能部材がありません。');
      resolve(null);
      return;
    }

    let settled = false;
    let onKeydown = null;
    const overlay = document.createElement('div');
    overlay.className = 'parameter-editor-overlay add-member-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const close = (value) => {
      if (settled) return;
      settled = true;
      if (onKeydown) document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    };

    const container = document.createElement('div');
    container.className = 'parameter-editor-container';
    const header = document.createElement('div');
    header.className = 'parameter-editor-header';
    const title = document.createElement('h3');
    title.className = 'parameter-editor-title';
    title.textContent = '既存継手配置の管理（ST-Bridge 2.1.x）';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'parameter-editor-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '閉じる');
    header.append(title, closeBtn);

    const content = document.createElement('div');
    content.className = 'parameter-editor-content';
    const arrangementRow = createSelectRow('継手配置');
    arrangements.forEach((arrangement, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = arrangementLabel(arrangement);
      arrangementRow.select.appendChild(option);
    });
    content.appendChild(arrangementRow.row);

    const memberRow = createSelectRow('新しい対象部材');
    members.forEach((member, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = memberLabel(member);
      memberRow.select.appendChild(option);
    });
    content.appendChild(memberRow.row);

    const jointRow = createSelectRow('継手定義（StbJoints）');
    content.appendChild(jointRow.row);

    const summary = document.createElement('div');
    summary.className = 'add-member-summary';
    content.appendChild(summary);

    const currentArrangement = () => arrangements[Number(arrangementRow.select.value)] || null;
    const currentMember = () => members[Number(memberRow.select.value)] || null;

    const refreshJointDefinitions = (preferredId = '') => {
      const member = currentMember();
      return member ? populateJointSelect(jointRow.select, doc, member.tagName, preferredId) : [];
    };

    const syncSelection = () => {
      const arrangement = currentArrangement();
      if (!arrangement) return;
      const currentIndex = findCurrentMemberIndex(arrangement, members);
      if (currentIndex >= 0) memberRow.select.value = String(currentIndex);
      refreshJointDefinitions(arrangement.getAttribute('id_section') || '');
      summary.textContent =
        `現在: ${arrangement.getAttribute('kind_member') || '?'} #${arrangement.getAttribute('id_member') || '?'} / ` +
        `継手 #${arrangement.getAttribute('id_section') || '?'} / ` +
        `${arrangement.getAttribute('starting_point') || '?'} / distance=${arrangement.getAttribute('distance') || '?'}`;
    };
    arrangementRow.select.addEventListener('change', syncSelection);
    memberRow.select.addEventListener('change', () => {
      const arrangement = currentArrangement();
      refreshJointDefinitions(arrangement?.getAttribute('id_section') || '');
    });
    syncSelection();

    const note = document.createElement('div');
    note.className = 'add-member-summary';
    note.textContent =
      'id_section は部材断面IDではなく StbJoints の継手IDです。部材種別を変更する場合は、新しい部材種別に対応する継手定義も選択してください。';
    content.appendChild(note);

    const buttonArea = document.createElement('div');
    buttonArea.className = 'parameter-editor-buttons';
    buttonArea.innerHTML = `
      <button type="button" class="parameter-editor-cancel arrangement-delete">削除</button>
      <button type="button" class="parameter-editor-cancel arrangement-close">閉じる</button>
      <button type="button" class="parameter-editor-ok arrangement-reassign">再割当</button>
    `;
    container.append(header, content, buttonArea);
    overlay.appendChild(container);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));

    buttonArea.querySelector('.arrangement-reassign')?.addEventListener('click', () => {
      const arrangement = currentArrangement();
      const member = currentMember();
      const jointId = String(jointRow.select.value || '').trim();
      if (!arrangement || !member || !jointId) {
        showError('継手配置・再割当先部材・継手定義を選択してください。');
        return;
      }
      const result = reassignJointArrangement({
        arrangementId: arrangement.getAttribute('id'),
        memberTag: member.tagName,
        memberId: member.element.getAttribute('id'),
        jointId,
      });
      if (result.success) close({ ...result, action: 'reassign' });
      else showError(result.error || '継手配置の再割当に失敗しました。');
    });

    buttonArea.querySelector('.arrangement-delete')?.addEventListener('click', () => {
      const arrangement = currentArrangement();
      if (!arrangement) {
        showError('削除する継手配置を選択してください。');
        return;
      }
      const id = arrangement.getAttribute('id');
      if (
        typeof window.confirm === 'function' &&
        !window.confirm(`StbJointArrangement #${id} を削除しますか？`)
      ) {
        return;
      }
      const result = deleteJointArrangement({ arrangementId: id });
      if (result.success) close({ ...result, action: 'delete' });
      else showError(result.error || '継手配置の削除に失敗しました。');
    });

    closeBtn.addEventListener('click', () => close(null));
    buttonArea.querySelector('.arrangement-close')?.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null);
    });
    onKeydown = (event) => {
      if (event.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKeydown);
  });
}

/** 編集操作列へ既存継手配置管理ボタンを追加する。 */
export function initJointArrangementManagerForm() {
  if (document.getElementById('manage-joint-arrangement-button')) return;
  const jointButton = document.getElementById('add-joint-button');
  if (!jointButton?.parentElement) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'manage-joint-arrangement-button';
  button.className = jointButton.className || 'btn btn-secondary';
  button.title = 'Working Session 中の ST-Bridge 2.1.x 継手配置を再割当・削除します';
  button.textContent = '継手配置管理';
  button.addEventListener('click', () => openJointArrangementManager());
  jointButton.insertAdjacentElement('afterend', button);
}
