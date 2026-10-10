/**
 * @fileoverview 配筋成立性から生成したふかし候補のpreview-only承認UI。
 *
 * 承認/却下/手動調整はruntime sidecarへ保存し、STB/Working Documentは直接変更しない。
 */

import {
  getConcreteAccommodationDecision,
  getConcreteAccommodationEvaluations,
  setConcreteAccommodationDecision,
} from '../../app/viewModes/concreteAccommodationDecisionStore.js';
import {
  applyAcceptedConcreteAccommodationToWorkingDocument,
  applyAcceptedLocalPrismToWorkingDocument,
} from '../../app/viewModes/concreteAccommodationWorkingApply.js';
import { showError, showSuccess, showWarning } from '../common/toast.js';

const HOST_ID = 'concrete-accommodation-candidate-settings-host';
const SETTINGS_ID = 'concrete-accommodation-candidate-settings';
let initialized = false;

function candidateOf(evaluation) {
  return evaluation?.plannedCandidate || evaluation?.candidate || null;
}

function numberInput(value, min = 0) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'form-control';
  input.min = String(min);
  input.step = '10';
  input.value = Number.isFinite(Number(value)) ? String(Number(value)) : '';
  input.style.width = '88px';
  return input;
}

function button(label, action, disabled = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'btn btn-sm';
  element.textContent = label;
  element.disabled = disabled;
  element.addEventListener('click', action);
  return element;
}

function decisionStatus(entry) {
  const candidate = candidateOf(entry.evaluation);
  const stored = getConcreteAccommodationDecision(entry.modelSource, candidate?.id);
  return stored?.status || entry.evaluation?.decisionStatus || 'CANDIDATE';
}

function blockerReasonCode(evaluation) {
  if (evaluation?.collisionGeometryUnresolved === true) return 'SPECIAL_DETAIL_REQUIRED';
  return (
    evaluation?.recheck?.reason ||
    evaluation?.planningReason ||
    evaluation?.reason ||
    evaluation?.deficiency?.reason ||
    'SPECIAL_DETAIL_REQUIRED'
  );
}

function blockerReasonText(evaluation) {
  const reason = blockerReasonCode(evaluation);
  if (
    evaluation?.collisionGeometryUnresolved === true ||
    evaluation?.existingRebarGeometryResolved === false
  ) {
    return '既存鉄筋の干渉判定形状が未解決のため、自動ふかし候補を生成していません。';
  }
  switch (reason) {
    case 'beam-accommodation-penetration-document-unresolved':
      return '梁貫通孔の判定に必要なSTBドキュメントを解決できません。';
    case 'beam-accommodation-penetration-geometry-unresolved':
      return '梁貫通孔の径または配置寸法が不足しているため、開口干渉を判定できません。';
    case 'beam-accommodation-penetration-station-unresolved':
      return '梁貫通孔の材軸位置を解決できません。';
    case 'REBAR_COLLISION':
      return '既存鉄筋との干渉が支配しているため、ふかしではなく配筋再配置を優先します。';
    case 'OPENING_CONFLICT':
      return '必要コンクリート領域が開口と干渉します。';
    case 'MEMBER_COLLISION':
      return 'ふかし候補が周辺RC部材へ越境します。';
    case 'EXCESSIVE_FUKASHI_REQUIRED':
      return '必要ふかし量がprojectの自動候補上限を超えています。';
    case 'ANCHORAGE_CONCRETE_MISSING':
      return '定着長方向のコンクリート不足は単純な面ふかしへ還元できません。';
    case 'SPECIAL_DETAIL_REQUIRED':
      return '単純なFACE_OFFSET / LOCAL_PRISMへ一意に還元できないため、個別詳細が必要です。';
    default:
      return '自動ふかし候補を生成できません。';
  }
}

function renderBlockedEntry(entry) {
  const evaluation = entry.evaluation || {};
  const wrapper = document.createElement('div');
  wrapper.className = 'rebar-detailing-width-check';
  wrapper.dataset.diagnosticId = entry.evaluationId || evaluation.diagnosticId || '';

  const title = document.createElement('div');
  title.className = 'rebar-detailing-width-summary';
  title.textContent =
    'Model ' +
    (entry.modelSource || '-') +
    ' / ' +
    (evaluation.hostMemberTag || '-') +
    ' ' +
    (evaluation.hostMemberId || '-') +
    ' / 自動候補なし';

  const reason = document.createElement('div');
  reason.className = 'color-setting-help';
  reason.dataset.role = 'blocker-reason';
  reason.textContent =
    '理由: ' + blockerReasonCode(evaluation) + ' / ' + blockerReasonText(evaluation);

  const note = document.createElement('div');
  note.className = 'color-setting-help';
  note.textContent =
    '未解決条件が残る間は承認・手動反映・Working Document適用を行いません。geometryを解決して再評価してください。';

  wrapper.append(title, reason, note);
  return wrapper;
}

function workingApplyMessage(result) {
  switch (result?.reason) {
    case 'fukashi-working-session-required':
      return 'Working Documentへ適用するには編集セッションを開始してください。';
    case 'fukashi-working-stale-evaluation':
      return '対象のthickness_add_*が評価後に変更されています。候補を再評価してください。';
    case 'ALREADY_APPLIED':
      return 'このふかしはWorking Documentへ既に適用済みです。';
    case 'fukashi-working-model-source-unsupported':
      return 'Working Documentへ適用できるのはModel Aの候補だけです。';
    case 'fukashi-working-approval-required':
      return 'Working Documentへ適用する前に候補を承認してください。';
    case 'local-prism-extension-host-not-found':
      return 'LOCAL_PRISMの対象部材がWorking Documentに見つかりません。';
    case 'local-prism-extension-approval-required':
      return 'StbExtensionへ保存する前にLOCAL_PRISM候補を承認してください。';
    case 'local-prism-extension-model-source-unsupported':
      return 'StbExtensionへ保存できるのはModel Aの候補だけです。';
    default:
      return result?.reason || 'Working Documentへのふかし適用に失敗しました。';
  }
}

function renderEntry(entry) {
  const evaluation = entry.evaluation;
  const candidate = candidateOf(evaluation);
  if (!candidate) return renderBlockedEntry(entry);

  const wrapper = document.createElement('div');
  wrapper.className = 'rebar-detailing-width-check';
  wrapper.dataset.candidateId = candidate.id;

  const title = document.createElement('div');
  title.className = 'rebar-detailing-width-summary';
  title.textContent =
    'Model ' +
    (entry.modelSource || '-') +
    ' / ' +
    (candidate.hostMemberTag || '-') +
    ' ' +
    (candidate.hostMemberId || '-') +
    ' / ' +
    (candidate.face || '-') +
    ' +' +
    Math.round(Number(candidate.proposedThicknessMm) || 0) +
    'mm';

  const info = document.createElement('div');
  info.className = 'color-setting-help';
  const start = Number(candidate.stationStartMm);
  const end = Number(candidate.stationEndMm);
  info.textContent =
    '範囲: ' +
    (Number.isFinite(start) ? Math.round(start) : '-') +
    '～' +
    (Number.isFinite(end) ? Math.round(end) : '-') +
    'mm / ' +
    '理由: ' +
    (evaluation.deficiency?.reason || evaluation.reason || '-') +
    ' / ' +
    '再検証: ' +
    (evaluation.recheck?.status || '-') +
    ' / ' +
    '判断: ' +
    decisionStatus(entry);

  const controls = document.createElement('div');
  controls.style.display = 'flex';
  controls.style.flexWrap = 'wrap';
  controls.style.gap = '6px';
  controls.style.alignItems = 'center';

  const acceptBlocked = evaluation.recheck?.acceptable !== true;
  controls.append(
    button(
      '承認',
      () => {
        const stored = getConcreteAccommodationDecision(entry.modelSource, candidate.id);
        return setConcreteAccommodationDecision({
          modelSource: entry.modelSource,
          candidateId: candidate.id,
          status: 'ACCEPTED',
          overrides: stored?.status === 'MANUAL' ? stored.overrides : null,
        });
      },
      acceptBlocked,
    ),
    button('却下', () =>
      setConcreteAccommodationDecision({
        modelSource: entry.modelSource,
        candidateId: candidate.id,
        status: 'REJECTED',
      }),
    ),
    button('候補に戻す', () =>
      setConcreteAccommodationDecision({
        modelSource: entry.modelSource,
        candidateId: candidate.id,
        status: 'CANDIDATE',
      }),
    ),
  );

  const exportPatch = evaluation.stbExportCandidate;
  if (exportPatch?.exportable === true) {
    const currentDecisionStatus = decisionStatus(entry);
    const applyButton = button(
      'Working Documentへ適用',
      () => {
        try {
          const result = applyAcceptedConcreteAccommodationToWorkingDocument({
            evaluation,
            modelSource: entry.modelSource,
          });
          if (result.ok && result.changed) {
            showSuccess(
              `${exportPatch.hostMemberTag} ${exportPatch.hostMemberId} の ${exportPatch.attribute} を ${exportPatch.valueMm}mm に更新しました。`,
            );
            return;
          }
          if (result.ok && result.reason === 'ALREADY_APPLIED') {
            showWarning(workingApplyMessage(result));
            return;
          }
          showWarning(workingApplyMessage(result));
        } catch (error) {
          showError(error?.message || 'Working Documentへのふかし適用に失敗しました。');
        }
      },
      currentDecisionStatus !== 'ACCEPTED' || entry.modelSource !== 'A',
    );
    applyButton.title =
      entry.modelSource !== 'A'
        ? 'Working DocumentはModel Aを正本とするためModel Bへは適用できません'
        : currentDecisionStatus !== 'ACCEPTED'
          ? '候補を承認すると適用できます'
          : '承認済みFACE_OFFSETをthickness_add_*へ適用します（Undo/Redo可能）';
    controls.appendChild(applyButton);
  }

  if (candidate.mode === 'LOCAL_PRISM') {
    const currentDecisionStatus = decisionStatus(entry);
    const persistButton = button(
      'StbExtensionへ保存',
      () => {
        try {
          const result = applyAcceptedLocalPrismToWorkingDocument({
            evaluation,
            modelSource: entry.modelSource,
          });
          if (result.ok && result.changed) {
            showSuccess(
              `LOCAL_PRISM ${candidate.id} をWorking DocumentのStbExtensionへ保存しました。`,
            );
            return;
          }
          if (result.ok && result.reason === 'ALREADY_APPLIED') {
            showWarning('このLOCAL_PRISMはStbExtensionへ既に保存済みです。');
            return;
          }
          showWarning(workingApplyMessage(result));
        } catch (error) {
          showError(error?.message || 'LOCAL_PRISMのStbExtension保存に失敗しました。');
        }
      },
      currentDecisionStatus !== 'ACCEPTED' || entry.modelSource !== 'A',
    );
    persistButton.title =
      entry.modelSource !== 'A'
        ? 'Working DocumentはModel Aを正本とするためModel Bへは保存できません'
        : currentDecisionStatus !== 'ACCEPTED'
          ? '候補を承認するとStbExtensionへ保存できます'
          : '局所ふかしをStbExtObject + StbExtPropertyとして保存します（Undo/Redo可能）';
    controls.appendChild(persistButton);
  }

  const manual = document.createElement('div');
  manual.style.display = 'flex';
  manual.style.flexWrap = 'wrap';
  manual.style.gap = '4px';
  manual.style.alignItems = 'center';
  manual.style.marginTop = '6px';

  const thickness = numberInput(candidate.proposedThicknessMm, 1);
  const stationStart = numberInput(candidate.stationStartMm, 0);
  const stationEnd = numberInput(candidate.stationEndMm, 0);
  const labels = [
    ['厚さ', thickness, 'mm'],
    ['開始', stationStart, 'mm'],
    ['終了', stationEnd, 'mm'],
  ];
  for (const [labelText, input, unit] of labels) {
    const label = document.createElement('label');
    label.style.display = 'inline-flex';
    label.style.alignItems = 'center';
    label.style.gap = '3px';
    label.append(document.createTextNode(labelText), input, document.createTextNode(unit));
    manual.appendChild(label);
  }
  manual.appendChild(
    button('手動反映', () => {
      setConcreteAccommodationDecision({
        modelSource: entry.modelSource,
        candidateId: candidate.id,
        status: 'MANUAL',
        overrides: {
          proposedThicknessMm: Number(thickness.value),
          stationStartMm: Number(stationStart.value),
          stationEndMm: Number(stationEnd.value),
        },
      });
    }),
  );

  const note = document.createElement('div');
  note.className = 'color-setting-help';
  note.textContent =
    'LOCAL_PRISMは標準thickness_add_*へ変換せず、承認後にStbExtensionとして保存できます。' +
    '全長FACE_OFFSETはWorking Documentのthickness_add_*へ可逆適用でき、どちらもUndo/Redo可能です。';

  wrapper.append(title, info, controls, manual, note);
  return wrapper;
}

function refresh() {
  const settings = document.getElementById(SETTINGS_ID);
  if (!settings) return;
  const body = settings.querySelector('[data-role="candidate-body"]');
  if (!body) return;
  body.replaceChildren();

  const entries = getConcreteAccommodationEvaluations();
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'color-setting-help';
    empty.textContent =
      '候補はまだありません。「ふかし候補をプレビュー」をONにし、小梁鉄筋を表示すると評価します。';
    body.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const node = renderEntry(entry);
    if (node) body.appendChild(node);
  }
}

export function renderConcreteAccommodationCandidateSettings() {
  const existing = document.getElementById(SETTINGS_ID);
  if (existing) return existing;
  const host = document.getElementById(HOST_ID);
  if (!host) return null;

  const details = document.createElement('details');
  details.id = SETTINGS_ID;
  details.className = 'rebar-detailing-choice-settings';

  const summary = document.createElement('summary');
  summary.textContent = 'コンクリートふかし候補';
  summary.title = '配筋成立性から生成したpreview-onlyふかし候補を確認';

  const description = document.createElement('p');
  description.className = 'color-setting-help';
  description.textContent =
    '候補生成・手動調整はSTB非破壊です。承認済み全長FACE_OFFSETだけWorking Documentへ明示適用できます。開口・鉄筋・他部材干渉、再検証NGは適用できません。';

  const body = document.createElement('div');
  body.dataset.role = 'candidate-body';

  details.append(summary, description, body);
  host.appendChild(details);
  refresh();

  if (!initialized) {
    initialized = true;
    document.addEventListener('concrete-accommodation-candidates-changed', refresh);
  }
  return details;
}
