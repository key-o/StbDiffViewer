/**
 * @fileoverview モデル編集リボン「修正」タブ。
 *
 * リボンには選択に依存しないコマンドと移動設定だけを置く。選択要素ごとの数値入力
 * （MOVE / COPY / ALIGN）は要素情報パネルの CAD 操作欄（cadOperationPanel.js）が持ち、
 * リボンのコマンドはその欄を開いて対応する入力へフォーカスする。
 */

import editingSession from '../../app/editing/editingSession.js';
import { planMemberJoinOffsets } from '../../app/editing/memberJoinOffsetPlanner.js';
import { captureJoinBeforeOffsets } from '../../app/editing/joinOffsetAuditSnapshots.js';
import { captureJoinQuantityBaselines } from '../../app/editing/joinQuantityReconciliation.js';
import { createSetMemberOffsetCommand } from '../../app/editing/setMemberOffsetCommand.js';
import { createSetWallNodeOffsetsCommand } from '../../app/editing/setWallNodeOffsetsCommand.js';
import { createSetSlabNodeOffsetsCommand } from '../../app/editing/setSlabNodeOffsetsCommand.js';
import { eventBus, EditEvents, InteractionEvents } from '../../data/events/index.js';
import { getState, setState } from '../../data/state/globalState.js';
import { ribbonCommandHtml, ribbonGroupHtml, ribbonStackHtml } from '../common/ribbon.js';
import { showError, showSuccess } from '../common/toast.js';

const FOLLOW_BUTTON_ID = 'model-edit-move-follow-related-nodes';
const GIZMO_SELECT_ID = 'model-edit-gizmo-anchor-mode';
const JOIN_BUTTON_ID = 'model-edit-auto-join-offsets';
const BOX_DIAGNOSTIC_BUTTON_ID = 'model-edit-certified-box-diagnostic';

/** [data-cad-operation, icon, label, title]。data-cad-operation は要素情報パネル側の欄と対応する。 */
const CAD_OPERATION_COMMANDS = [
  ['move', 'move', '移動', '選択要素を ΔX / ΔY / ΔZ だけ移動します（要素情報パネルで数値入力）'],
  [
    'copy',
    'copy',
    '複写',
    '選択要素を ΔX / ΔY / ΔZ だけずらして複写します（要素情報パネルで数値入力）',
  ],
  ['align-axis', 'alignAxis', '軸揃え', '選択要素の節点を X / Y / Z の指定座標へ揃えます'],
  ['align-points', 'alignPoints', '2点揃え', '始点から終点への移動量で選択要素の節点を揃えます'],
];

export function modifyTabBody() {
  return (
    ribbonGroupHtml(
      '移動・複写',
      CAD_OPERATION_COMMANDS.map(([kind, icon, label, title]) =>
        ribbonCommandHtml({
          id: `model-edit-cad-${kind}`,
          icon,
          label,
          title,
          attributes: `data-cad-operation="${kind}"`,
        }),
      ).join(''),
    ) +
    ribbonGroupHtml(
      '移動設定',
      ribbonCommandHtml({
        id: FOLLOW_BUTTON_ID,
        icon: 'followNodes',
        label: '節点追従',
        title:
          'ON: 選択要素の節点を移動し、共有節点を参照する部材も追従します。OFF: 節点を固定し、選択部材の offset だけを更新します。',
        attributes: 'aria-pressed="true"',
      }) +
        ribbonStackHtml(
          `<label>ギズモ位置 <select id="${GIZMO_SELECT_ID}" class="form-control" aria-label="MOVE ギズモの基準位置">
            <option value="node">節点中心</option><option value="geometry">ジオメトリ中心</option>
          </select></label>`,
        ),
    ) +
    ribbonGroupHtml(
      '取り合い調整',
      ribbonCommandHtml({
        id: JOIN_BUTTON_ID,
        icon: 'joinOffset',
        label: 'RC取り合い',
        title:
          'RC柱梁・大梁小梁・柱壁・壁梁、および矩形床外周と全長支持梁の限定オフセット候補を確認します',
      }) +
        ribbonCommandHtml({
          id: BOX_DIAGNOSTIC_BUTTON_ID,
          icon: 'diag',
          label: '重複診断',
          title: 'Working実ソリッドの認証済み直方体だけを材料別Union診断（数量には未反映）',
        }),
    )
  );
}

/** 要素情報パネルを開き、CAD 操作欄の該当入力へフォーカスする。入力済みの値は保つ。 */
async function openCadOperation(kind) {
  eventBus.emit(InteractionEvents.OPEN_WINDOW, { windowId: 'component-info' });
  try {
    const { mountCadOperationPanel } = await import('./element-info/editMode/cadOperationPanel.js');
    const content = document.getElementById('element-info-content');
    if (!content?.querySelector('[data-cad-operation]')) mountCadOperationPanel();
    const section = content?.querySelector(`[data-cad-operation="${kind}"]`);
    if (!section) {
      const reason = content?.querySelector(
        '.cad-operation-editor .add-member-summary',
      )?.textContent;
      showError(reason || 'Model A の要素を選択してから実行してください。');
      return;
    }
    section.scrollIntoView?.({ block: 'nearest' });
    section.querySelector('input, select')?.focus();
  } catch (error) {
    showError(
      `CAD操作欄を開けませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 診断を実行したWorking revisionにのみ紐付ける。元STBへは書き込まない。 */
function compactJoinProposal(proposal) {
  return {
    kind: proposal.kind,
    elementType: proposal.elementType,
    elementId: proposal.elementId,
    estimatedReductionMm3: proposal.estimatedReductionMm3,
    beforeConcreteVolumeMm3: proposal.beforeConcreteVolumeMm3 ?? null,
    offsets: JSON.parse(JSON.stringify(proposal.offsets ?? {})),
    // STBの属性未設定(null)と明示ゼロを区別して記録する。
    ...(proposal.beforeOffsets !== undefined
      ? { beforeOffsets: JSON.parse(JSON.stringify(proposal.beforeOffsets)) }
      : {}),
    connections: (proposal.connections ?? []).map((item) => ({ ...item })),
  };
}

function publishJoinAudit(
  plan,
  { appliedCount = 0, appliedReductionMm3 = 0, appliedProposals = [] } = {},
) {
  const editing = editingSession.getState();
  const audit = {
    sessionId: editing.sessionId,
    workingRevision: editing.workingRevision,
    proposalCount: plan.proposals.length,
    warningCount: plan.warnings.length,
    estimatedReductionMm3: plan.estimatedReductionMm3,
    appliedCount,
    appliedReductionMm3,
    supportedScope: plan.supportedScope,
    proposals: plan.proposals.map(compactJoinProposal),
    appliedProposals: appliedProposals.map(compactJoinProposal),
    warnings: [...plan.warnings],
  };
  setState('models.workingJoinAudit', audit);
  eventBus.emit(EditEvents.JOIN_AUDIT_UPDATED, audit);
}

/** QuantityServiceの現行派生storeを優先し、旧revisionのstoreを誤参照しない。 */
function currentQuantityStore() {
  const editing = editingSession.getState();
  if (
    getState('models.workingQuantitySessionId') === editing.sessionId &&
    getState('models.workingQuantityRevision') === editing.workingRevision
  ) {
    return getState('models.derivedQuantitiesWorkingA');
  }
  // 変更前の初期Working DocumentはModel Aと同じ数量を持つ。
  return editing.workingRevision === 0 ? getState('models.derivedQuantitiesA') : null;
}

function runJoinOffsets() {
  try {
    const document = editingSession.getWorkingDocument();
    if (!editingSession.getState()?.active || !document)
      throw new Error('編集セッションがありません');
    const plan = planMemberJoinOffsets(document);
    // 適用前のUndoスナップショットを流用し、候補および適用済みの元offsetを監査可能にする。
    const commands = plan.proposals.map((item) =>
      item.elementType === 'StbWall'
        ? createSetWallNodeOffsetsCommand(document, item.elementId, item.offsets)
        : item.elementType === 'StbSlab'
          ? createSetSlabNodeOffsetsCommand(document, item.elementId, item.offsets)
          : createSetMemberOffsetCommand(document, item.elementType, item.elementId, item.offsets),
    );
    const proposalsWithBefore = plan.proposals.map((proposal, index) => ({
      ...proposal,
      beforeOffsets: captureJoinBeforeOffsets(commands[index], proposal.offsets),
    }));
    publishJoinAudit({ ...plan, proposals: proposalsWithBefore });
    if (!plan.proposals.length) {
      if (plan.warnings.length > 0) {
        showError(
          `自動調整可能な取り合いはありません。未判定・競合 ${plan.warnings.length}件を保留しました。`,
        );
      } else {
        showSuccess('適用可能なRC柱梁・大梁小梁・柱壁・壁梁・床梁外周の取り合い候補はありません。');
      }
      return;
    }
    const beams = plan.proposals.filter((item) =>
      ['StbBeam', 'StbGirder'].includes(item.elementType),
    );
    const beamConnections = beams.flatMap((item) => item.connections || []);
    const columnEnds = beamConnections.filter((item) => item.columnId).length;
    const girderEnds = beamConnections.filter((item) => item.girderId).length;
    const walls = plan.proposals.filter((item) => item.elementType === 'StbWall');
    const wallColumnCount = walls.filter((item) =>
      item.connections?.some((connection) => connection.columnId),
    ).length;
    const wallBeamCount = walls.filter((item) => item.beamId).length;
    const slabs = plan.proposals.filter((item) => item.elementType === 'StbSlab');
    const estimatedM3 = (plan.estimatedReductionMm3 / 1e9).toFixed(4);
    const warning = plan.warnings.length
      ? `\n未判定・競合: ${plan.warnings.length}件（自動変更しません）`
      : '';
    const approved = window.confirm(
      `RC取り合いoffset候補を適用しますか？\n柱梁端: ${columnEnds}箇所、大梁小梁端: ${girderEnds}箇所、柱壁: ${wallColumnCount}部材、壁梁: ${wallBeamCount}部材、床梁外周: ${slabs.length}枚` +
        `\n単純断面による体積低減目安: ${estimatedM3} m³（確定正味数量ではありません）` +
        `${warning}\n対象外: SRC/S/CFT、床内部を通る梁・部分支持、斜材・複雑な接合。Undo可能です。`,
    );
    if (!approved) return;
    const appliedProposals = captureJoinQuantityBaselines(
      proposalsWithBefore,
      currentQuantityStore(),
    );
    const result = editingSession.runTransaction(commands, {
      label: 'RC部材取り合い自動offset',
      reason: 'autoMemberJoinOffsets',
    });
    if (result.changed) {
      // 追加計算は明示操作時のみ。QuantitySummaryのrefreshからplannerを呼ばない。
      try {
        const afterPlan = planMemberJoinOffsets(document);
        publishJoinAudit(afterPlan, {
          appliedCount: plan.proposals.length,
          appliedReductionMm3: plan.estimatedReductionMm3,
          appliedProposals,
        });
        showSuccess(`RC取り合いoffsetを${plan.proposals.length}部材へ適用しました。`);
      } catch (auditError) {
        // 取り合いCommand自体は適用済み。再診断失敗を編集失敗として報告しない。
        showError(
          `RC取り合いは適用されましたが、適用後の再診断に失敗しました: ${auditError instanceof Error ? auditError.message : String(auditError)}`,
        );
      }
    }
  } catch (error) {
    showError(
      `RC取り合い調整に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 編集セッションの状態をコマンドの有効/無効と移動設定の表示へ反映する。 */
export function syncModifyTab() {
  const active = editingSession.getState()?.active === true;
  for (const button of document.querySelectorAll('#model-edit-ribbon [data-cad-operation]')) {
    button.disabled = !active;
  }
  const follow = document.getElementById(FOLLOW_BUTTON_ID);
  if (follow) {
    follow.disabled = !active;
    follow.setAttribute('aria-pressed', String(editingSession.getMoveFollowRelatedNodes()));
  }
  const gizmo = document.getElementById(GIZMO_SELECT_ID);
  if (gizmo) {
    gizmo.disabled = !active;
    gizmo.value = editingSession.getMoveGizmoAnchorMode();
  }
  const join = document.getElementById(JOIN_BUTTON_ID);
  if (join) join.disabled = !active;
  const box = document.getElementById(BOX_DIAGNOSTIC_BUTTON_ID);
  if (box) box.disabled = !active;
}

export function initializeModifyTab() {
  for (const button of document.querySelectorAll('#model-edit-ribbon [data-cad-operation]')) {
    button.addEventListener('click', () => void openCadOperation(button.dataset.cadOperation));
  }
  document.getElementById(FOLLOW_BUTTON_ID)?.addEventListener('click', (event) => {
    const pressed = event.currentTarget.getAttribute('aria-pressed') === 'true';
    try {
      editingSession.setMoveFollowRelatedNodes(!pressed);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
    syncModifyTab();
  });
  const gizmo = document.getElementById(GIZMO_SELECT_ID);
  gizmo?.addEventListener('change', () => {
    try {
      editingSession.setMoveGizmoAnchorMode(gizmo.value);
      eventBus.emit(EditEvents.GIZMO_ANCHOR_MODE_CHANGED, { mode: gizmo.value });
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
    syncModifyTab();
  });
  document.getElementById(JOIN_BUTTON_ID)?.addEventListener('click', runJoinOffsets);
  document.getElementById(BOX_DIAGNOSTIC_BUTTON_ID)?.addEventListener('click', async () => {
    try {
      const { openWorkingCertifiedBoxDiagnostic } =
        await import('./workingCertifiedBoxDiagnosticDialog.js');
      openWorkingCertifiedBoxDiagnostic();
    } catch (error) {
      showError(
        '重複診断を開けません: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  });
}
