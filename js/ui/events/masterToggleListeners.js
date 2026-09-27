/**
 * @fileoverview マスターチェックボックスによる一括切り替え処理
 *
 * 表示要素設定テーブルのヘッダーにあるマスターチェックボックスで、
 * 「表示」「立体」「鉄筋」「ラベル」列のチェックボックスを一括でオン/オフできる機能を提供します。
 *
 * @module ui/events/masterToggleListeners
 */

// セレクタ定義
const SELECTORS = {
  masterDisplay: '#masterToggleDisplay',
  masterSolid: '#masterToggleSolid',
  masterRebar: '#masterToggleRebar',
  masterLabel: '#masterToggleLabel',
  // 表示列: name="elements" の全チェックボックス
  displayCheckboxes: '.element-settings-table input[name="elements"]',
  // 立体列: ID末尾が「3DView」「ColumnView」「GirderView」のチェックボックス（立体表示用）
  solidCheckboxes:
    '.element-settings-table input[id="toggleColumnView"], ' +
    '.element-settings-table input[id="toggleGirderView"], ' +
    '.element-settings-table input[id$="3DView"]',
  // 鉄筋列: name="rebarToggle" の全チェックボックス
  rebarCheckboxes: '.element-settings-table input[name="rebarToggle"]',
  // ラベル列: name="labelToggle" の全チェックボックス
  labelCheckboxes: '.element-settings-table input[name="labelToggle"]',
};

// マスター操作中フラグ（子の変更イベントでマスター状態の再計算をスキップするため）
let isMasterUpdating = false;

/**
 * 鉄筋列は elementSettingsTable.js で動的追加されるため、
 * 他列と同じ位置に全体ON/OFF用チェックボックスを補う。
 * @returns {HTMLInputElement|null}
 */
function ensureMasterRebarToggle() {
  const existing = document.querySelector(SELECTORS.masterRebar);
  if (existing) return existing;

  const header = document.querySelector(
    '.element-settings-table th[data-element-settings-column="rebar"]',
  );
  if (!header) return null;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = 'masterToggleRebar';
  input.title = '全ての鉄筋表示を切替';
  input.setAttribute('aria-label', '全ての鉄筋表示を切替');
  header.appendChild(document.createTextNode(' '));
  header.appendChild(input);
  return input;
}

/**
 * マスターチェックボックスのイベントリスナーを設定
 */
export function setupMasterToggleListeners() {
  ensureMasterRebarToggle();
  setupMasterCheckbox(SELECTORS.masterDisplay, SELECTORS.displayCheckboxes);
  setupMasterCheckbox(SELECTORS.masterSolid, SELECTORS.solidCheckboxes);
  setupMasterCheckbox(SELECTORS.masterRebar, SELECTORS.rebarCheckboxes);
  setupMasterCheckbox(SELECTORS.masterLabel, SELECTORS.labelCheckboxes);
}

/**
 * 単一のマスターチェックボックスと対応する子チェックボックスを設定
 * @param {string} masterSelector - マスターチェックボックスのセレクタ
 * @param {string} childSelector - 子チェックボックスのセレクタ
 */
function setupMasterCheckbox(masterSelector, childSelector) {
  const master = document.querySelector(masterSelector);
  if (!master) return;

  // マスターをクリック時: 全子チェックボックスを同じ状態に
  master.addEventListener('change', () => {
    isMasterUpdating = true;
    const targetState = master.checked;
    const checkboxes = document.querySelectorAll(childSelector);
    checkboxes.forEach((cb) => {
      if (!cb.disabled) {
        cb.checked = targetState;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    // indeterminate状態をクリア
    master.indeterminate = false;
    isMasterUpdating = false;
  });

  // 子チェックボックス変更時: マスターの状態を更新
  document.querySelectorAll(childSelector).forEach((cb) => {
    cb.addEventListener('change', () => {
      if (!isMasterUpdating) {
        updateMasterState(masterSelector, childSelector);
      }
    });
  });

  // 初期状態を同期
  updateMasterState(masterSelector, childSelector);
}

/**
 * マスターチェックボックスの状態を子チェックボックスの状態に基づいて更新
 * @param {string} masterSelector - マスターチェックボックスのセレクタ
 * @param {string} childSelector - 子チェックボックスのセレクタ
 */
function updateMasterState(masterSelector, childSelector) {
  const master = document.querySelector(masterSelector);
  if (!master) return;

  const checkboxes = [...document.querySelectorAll(childSelector)].filter((cb) => !cb.disabled);

  if (checkboxes.length === 0) return;

  const checkedCount = checkboxes.filter((cb) => cb.checked).length;
  master.checked = checkedCount === checkboxes.length;
  master.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}
