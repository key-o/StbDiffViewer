/**
 * @fileoverview Explicit, read-only modal for the certified Working box subset.
 * Never writes STB, QuantityService, or the published quantity summary.
 */
import editingSession from '../../app/editing/editingSession.js';
import {
  CERTIFIED_DIAGNOSTIC_TYPES,
  runWorkingCertifiedBoxDiagnostic,
  isCurrentWorkingDiagnosticSnapshot,
} from '../../app/editing/workingCertifiedBoxDiagnostic.js';
import { eventBus, EditEvents } from '../../data/events/index.js';
import { showError } from '../common/toast.js';

const LABELS = Object.freeze({
  Column: '柱',
  Girder: '大梁',
  Beam: '小梁',
  Wall: '壁',
  Slab: '床',
});
const MATERIAL_LABELS = Object.freeze({ CONCRETE: 'コンクリート', STEEL: '鋼材' });
let openedDialog = null;

function textCell(row, value) {
  const cell = document.createElement('td');
  cell.textContent = String(value);
  row.appendChild(cell);
}

function volumeM3(mm3) {
  return Number.isFinite(mm3) ? (mm3 / 1e9).toFixed(6) : '—';
}

function renderDiagnosticResult(dialog, result) {
  const summary = dialog.querySelector('[data-box-summary]');
  const body = dialog.querySelector('[data-box-materials]');
  const unresolved = dialog.querySelector('[data-box-unresolved]');
  const coverage = dialog.querySelector('[data-box-coverage]');
  body.replaceChildren();
  unresolved.replaceChildren();
  summary.textContent =
    'Working rev.' +
    result.workingRevision +
    ' / 対象 ' +
    result.considered +
    '部材 / 認証 ' +
    result.certifiedMemberCount +
    '部材 / 未判定 ' +
    result.unresolved.length +
    '件' +
    (result.excludedMemberCount ? ' / 上限対象外 ' + result.excludedMemberCount + '部材' : '');
  for (const material of ['CONCRETE', 'STEEL']) {
    const row = document.createElement('tr');
    const values = result.byMaterial[material];
    for (const value of [
      MATERIAL_LABELS[material],
      values.certifiedMemberCount,
      volumeM3(values.memberSumMm3),
      volumeM3(values.unionMm3),
      volumeM3(values.overlappingMm3),
    ]) {
      textCell(row, value);
    }
    body.appendChild(row);
  }
  const reasons = result.unresolved;
  for (const item of reasons.slice(0, 100)) {
    const row = document.createElement('li');
    row.textContent =
      String(item.elementType) +
      ' / ' +
      String(item.elementId ?? '—') +
      ' : ' +
      String(item.reason);
    unresolved.appendChild(row);
  }
  if (reasons.length > 100) {
    const rest = document.createElement('li');
    rest.textContent = 'ほか ' + (reasons.length - 100) + '件（一覧は最大100件表示）';
    unresolved.appendChild(rest);
  }
  if (!reasons.length) {
    const empty = document.createElement('li');
    empty.textContent = '選択範囲内で保留はありません。';
    unresolved.appendChild(empty);
  }
  coverage.textContent =
    result.considered === 0
      ? '対象部材がありません。重複ゼロとは判定できません。'
      : result.truncated
        ? '最大64部材のサブセットです。残りは未処理です（全体数量ではありません）。'
        : !result.subsetCoverageComplete
          ? '選択範囲内でも未判定要素があります。上記数値は認証済み部材のみです。'
          : '選択した部材種別・ID内のみ検証済み。建物全体の数量ではありません。';
  dialog.querySelector('[data-box-result]').hidden = false;
}

function selectedIds(dialog) {
  const raw = dialog.querySelector('[data-box-ids]').value.trim();
  if (!raw) return [];
  const ids = [...new Set(raw.split(/[\s,、;；]+/).filter(Boolean))];
  if (ids.length > 64) throw new Error('指定できる部材IDは64件までです');
  return ids;
}

export function openWorkingCertifiedBoxDiagnostic({
  runDiagnostic = runWorkingCertifiedBoxDiagnostic,
} = {}) {
  if (!editingSession.getState()?.active) {
    showError('編集モードを開始してから診断してください。');
    return null;
  }
  if (openedDialog?.isConnected) {
    openedDialog.focus();
    return openedDialog;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'working-box-diagnostic';
  dialog.setAttribute('aria-labelledby', 'working-box-diagnostic-title');
  dialog.innerHTML = [
    '<header class="working-box-header">',
    '<h2 id="working-box-diagnostic-title">実ソリッド重複診断（限定）</h2>',
    '<button type="button" data-box-close aria-label="閉じる">×</button>',
    '</header>',
    '<p>WorkingのRC部材を明示的に診断します。結果は認証された直方体だけの材種別Unionであり、確定正味数量には反映しません。</p>',
    '<fieldset class="working-box-types"><legend>対象種別</legend>',
    ...CERTIFIED_DIAGNOSTIC_TYPES.map(
      (type) =>
        '<label><input type="checkbox" data-box-type value="' +
        type +
        '" checked> ' +
        LABELS[type] +
        '</label>',
    ),
    '</fieldset>',
    '<label class="working-box-ids">部材ID（任意、空欄なら選択種別を先頭から最大64部材）',
    '<textarea data-box-ids rows="2" maxlength="2048" placeholder="例: C1, G1"></textarea></label>',
    '<p class="working-box-note">最大64部材。RC以外、開口・非直方体・複合材料は未判定。Working XMLの文字列化のみmainスレッドで行います。XML解析・メッシュ生成・認証・UnionはWorkerで処理し、中止でWorkerを終了します。</p>',
    '<p data-box-status role="status" aria-live="polite">未実行</p>',
    '<section data-box-result hidden>',
    '<h3>診断結果（m³）</h3>',
    '<p data-box-summary></p>',
    '<table><thead><tr><th>材種</th><th>認証数</th><th>部材合計</th><th>Union</th><th>重複相当</th></tr></thead>',
    '<tbody data-box-materials></tbody></table>',
    '<p data-box-coverage></p>',
    '<details><summary>未判定の部材と理由</summary><ul data-box-unresolved></ul></details>',
    '<p class="working-box-note">重複相当＝認証部材合計−認証部材Union。これはQuantityServiceの控除量ではなく、未認証形状・未選択部材を含みません。</p>',
    '</section>',
    '<footer class="working-box-actions">',
    '<button type="button" data-box-run>診断実行</button>',
    '<button type="button" data-box-cancel disabled>中止</button>',
    '</footer>',
  ].join('');
  document.body.appendChild(dialog);
  openedDialog = dialog;

  const status = dialog.querySelector('[data-box-status]');
  const runButton = dialog.querySelector('[data-box-run]');
  const cancelButton = dialog.querySelector('[data-box-cancel]');
  const result = dialog.querySelector('[data-box-result]');
  let controller = null;
  let generation = 0;
  let lastSnapshot = null;
  const setBusy = (busy) => {
    runButton.disabled = busy;
    cancelButton.disabled = !busy;
    for (const input of dialog.querySelectorAll('[data-box-type], [data-box-ids]')) {
      input.disabled = busy;
    }
  };
  const cancel = (message) => {
    controller?.abort();
    controller = null;
    generation += 1;
    setBusy(false);
    if (message) status.textContent = message;
  };
  const onEditChange = () => {
    if (!dialog.isConnected) return;
    if (
      controller ||
      (lastSnapshot &&
        !isCurrentWorkingDiagnosticSnapshot(() => editingSession.getState(), lastSnapshot))
    ) {
      cancel('編集内容が更新されたため診断結果を破棄しました。再実行してください。');
      result.hidden = true;
      lastSnapshot = null;
    }
  };
  const unsubscribe = [
    eventBus.on(EditEvents.WORKING_DOCUMENT_CHANGED, onEditChange),
    eventBus.on(EditEvents.MODE_TOGGLED, onEditChange),
  ];

  dialog.querySelector('[data-box-close]').addEventListener('click', () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.dispatchEvent(new Event('close'));
  });
  dialog.addEventListener('close', () => {
    cancel();
    unsubscribe.forEach((off) => off());
    dialog.remove();
    if (openedDialog === dialog) openedDialog = null;
    document.getElementById('model-edit-certified-box-diagnostic')?.focus();
  });
  cancelButton.addEventListener('click', () => {
    cancel('診断を中止しました。Workerを終了します（XMLの文字列化中は即時中止できません）。');
    result.hidden = true;
    lastSnapshot = null;
  });
  runButton.addEventListener('click', async () => {
    if (controller) return;
    const elementTypes = [...dialog.querySelectorAll('[data-box-type]:checked')].map(
      (input) => input.value,
    );
    if (!elementTypes.length) {
      status.textContent = '部材種別を1つ以上選択してください。';
      return;
    }
    let elementIds;
    try {
      elementIds = selectedIds(dialog);
    } catch (error) {
      status.textContent = error.message;
      return;
    }
    controller = new globalThis.AbortController();
    const currentController = controller;
    const sequence = ++generation;
    lastSnapshot = null;
    result.hidden = true;
    setBusy(true);
    status.textContent = 'Working XMLを準備しています…';
    try {
      const output = await runDiagnostic({
        getEditingState: () => editingSession.getState(),
        elementTypes,
        elementIds,
        signal: currentController.signal,
        onProgress: (progress) => {
          if (!dialog.isConnected || sequence !== generation || currentController.signal.aborted)
            return;
          if (progress?.phase === 'serialize') {
            status.textContent = 'Working XMLを文字列化しています…';
          } else if (progress?.phase === 'parse') {
            status.textContent = 'WorkerでWorking XMLを解析中…';
          } else if (progress?.phase === 'selection') {
            status.textContent = 'Workerで診断対象を抽出中…';
          } else if (progress?.phase === 'geometry') {
            status.textContent =
              'Workerで実メッシュを認証中：' + progress.processed + '部材処理済み';
          } else if (progress?.phase === 'union') {
            status.textContent = 'Workerで認証済み直方体のUnion計算中…';
          }
        },
      });
      if (!dialog.isConnected || generation !== sequence || currentController.signal.aborted)
        return;
      lastSnapshot = {
        sessionId: output.sessionId,
        workingRevision: output.workingRevision,
        workingDocument: editingSession.getState().workingDocument,
        workingNodeMap: editingSession.getState().workingNodeMap,
      };
      if (!isCurrentWorkingDiagnosticSnapshot(() => editingSession.getState(), lastSnapshot)) {
        throw new Error('working-revision-changed');
      }
      renderDiagnosticResult(dialog, output);
      status.textContent = '選択範囲の診断が完了しました（建物全体の正味数量ではありません）。';
    } catch (error) {
      if (generation === sequence && dialog.isConnected) {
        status.textContent =
          error?.message === 'working-revision-changed'
            ? 'Working revisionが変更されました。再実行してください。'
            : ['diagnostic-worker-unavailable', 'diagnostic-worker-failed'].includes(error?.message)
              ? '診断Workerを利用できません。開発中はnpm run dev:workerを使用してください。同期計算には切り替えません。'
              : '診断できませんでした: ' + String(error?.message || error);
        result.hidden = true;
      }
    } finally {
      if (generation === sequence) {
        controller = null;
        setBusy(false);
      }
    }
  });

  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  dialog.querySelector('[data-box-run]').focus();
  return dialog;
}
