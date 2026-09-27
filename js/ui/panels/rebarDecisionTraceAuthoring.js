/**
 * @fileoverview Decision Traceの配筋干渉pair-local override authoring UI。
 *
 * パネル本体はtraceの収集・表示を担当し、このモジュールは編集候補の選択、
 * overrideの保存/解除、production状態の表示だけを担当する。
 */

export function createRebarDecisionTraceAuthoringController({
  windowId,
  getRows,
  isEnabled,
  getSelectedKey,
  setSelectedKey,
  getMessage,
  setMessage,
  refreshRows,
  refreshTable,
  createAssignment,
  captureOverrideSnapshot,
  upsertAssignment,
  removeAssignment,
  restoreOverrideSnapshot,
  refreshVisibleRebarGroups,
  log,
}) {
  const placementHistoryByPair = new Map();

  const isPlacementAuthoringRow = (row) => row?.authoring?.kind === 'REBAR_PLACEMENT_CONFLICT_PAIR';

  const selectionKey = (row) => {
    const modelSource = String(row?.modelSource ?? '').trim();
    const decisionId = String(row?.decisionId ?? '').trim();
    return decisionId ? `${modelSource}\u0000${decisionId}` : null;
  };

  const selectedAuthoringRow = () => {
    const selectedKey = getSelectedKey();
    if (!selectedKey) return null;
    const row = getRows().find((item) => selectionKey(item) === selectedKey);
    return isPlacementAuthoringRow(row) ? row : null;
  };

  function productionMemberKeyForAuthoring(row) {
    const beam = row?.authoring?.beam;
    const memberId = String(beam?.sourceMemberId ?? '').trim();
    const memberType = String(beam?.memberType ?? '')
      .trim()
      .toUpperCase();
    if (!memberId) return null;
    if (memberType === 'GIRDER' || memberType === 'STBGIRDER') return `StbGirder:${memberId}`;
    if (memberType === 'BEAM' || memberType === 'STBBEAM') return `StbBeam:${memberId}`;
    return null;
  }

  function placementProductionRow(row) {
    const memberKey = productionMemberKeyForAuthoring(row);
    if (!memberKey) return null;
    return (
      getRows().find(
        (item) =>
          item?.subjectType === 'REBAR_PLACEMENT_PRODUCTION' &&
          item?.subjectKey === memberKey &&
          item?.modelSource === row?.modelSource,
      ) || null
    );
  }

  function formatPlacementProductionStatus(row) {
    const production = placementProductionRow(row);
    if (!production) return '未評価（override保存後にproduction gateを評価）';
    return `${production.status || '-'} / ${production.disposition || '-'}${
      production.unresolvedReason ? ` / ${production.unresolvedReason}` : ''
    }`;
  }

  function authoringBarLabel(bar) {
    if (!bar) return '-';
    const parts = [
      bar.memberType,
      bar.sourceMemberId ? `#${bar.sourceMemberId}` : null,
      bar.sourceEndpoint,
      bar.role,
      Number.isInteger(bar.layer) ? `L${bar.layer}` : null,
      bar.topologyPosition,
      bar.diaName,
    ].filter(Boolean);
    return parts.join(' / ') || bar.semanticIdentity || '-';
  }

  function appendAuthoringLine(container, label, value) {
    const line = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    line.append(strong, document.createTextNode(String(value ?? '-')));
    container.appendChild(line);
  }

  function authoringButton(label, handler, { disabled = false } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', handler);
    return button;
  }

  function withRebarRefreshStatus(message, rebarRefreshSucceeded) {
    return rebarRefreshSucceeded
      ? message
      : `${message}\n3D表示再生成: FAILED（表示は更新されていない可能性があります）`;
  }

  function refreshAfterAuthoringChange() {
    let rebarRefreshSucceeded = true;
    try {
      refreshVisibleRebarGroups();
    } catch (error) {
      rebarRefreshSucceeded = false;
      log.warn('配筋表示の再生成に失敗しました。Decision Traceは再評価します。', error);
    }
    refreshRows();
    return rebarRefreshSucceeded;
  }

  function historyFor(row) {
    const key = selectionKey(row);
    if (!key) return { undo: [], redo: [] };
    if (!placementHistoryByPair.has(key)) {
      placementHistoryByPair.set(key, { undo: [], redo: [] });
    }
    return placementHistoryByPair.get(key);
  }

  function recordPlacementChange(row, before, after) {
    const history = historyFor(row);
    history.undo.push({
      scope: { ...row.authoring.scope },
      before,
      after,
    });
    if (history.undo.length > 50) history.undo.shift();
    history.redo = [];
  }

  function capturePairSnapshot(row) {
    return captureOverrideSnapshot(row?.authoring?.scope || {});
  }

  function rollbackUnrecordedChange(row, before, error) {
    const rollback = restoreOverrideSnapshot(row?.authoring?.scope || {}, before);
    if (!rollback.ok) {
      log.warn('配筋overrideの履歴snapshotに失敗し、変更も復元できませんでした。', {
        error,
        rollbackError: rollback.error,
      });
      return `履歴snapshot失敗: ${error} / 復元失敗: ${rollback.error || 'unknown'}`;
    }
    return `履歴snapshot失敗のため変更を取り消しました: ${error}`;
  }

  function placementHistoryMessage(direction, rebarRefreshSucceeded) {
    const updated = selectedAuthoringRow();
    const pairStatus = updated
      ? `Pair ${updated.status} / ${updated.disposition}${updated.unresolvedReason ? ` / ${updated.unresolvedReason}` : ''}`
      : '対象pairは再評価後のtraceから消えました';
    const prefix = direction === 'undo' ? '元に戻し' : 'やり直し';
    const production = updated
      ? `\n3D production: ${formatPlacementProductionStatus(updated)}`
      : '';
    return withRebarRefreshStatus(
      `${prefix}・再評価済み: ${pairStatus}${production}`,
      rebarRefreshSucceeded,
    );
  }

  function applyPlacementHistory(row, direction) {
    const history = historyFor(row);
    const source = direction === 'undo' ? history.undo : history.redo;
    if (source.length === 0) return;
    const record = source[source.length - 1];
    const target = direction === 'undo' ? record.before : record.after;
    const expected = direction === 'undo' ? record.after : record.before;
    const restored = restoreOverrideSnapshot(record.scope, target, expected);
    if (!restored.ok) {
      setMessage(
        `${direction === 'undo' ? '元に戻せません' : 'やり直せません'}: ${restored.error || 'project-detailing-write-failed'}`,
      );
      render();
      return;
    }

    source.pop();
    (direction === 'undo' ? history.redo : history.undo).push(record);
    setSelectedKey(selectionKey(row));
    const rebarRefreshSucceeded = refreshAfterAuthoringChange();
    setMessage(placementHistoryMessage(direction, rebarRefreshSucceeded));
    render();
  }

  function savePlacementOverride(row, action) {
    const context = row?.authoring;
    const built = createAssignment({
      modelSource: context?.modelSource,
      nodeId: context?.nodeId,
      column: context?.column,
      beam: context?.beam,
      action,
      note: 'Decision Trace explicit placement override',
    });
    if (!built.ok) {
      setMessage(`保存できません: ${built.error || 'assignment-build-failed'}`);
      render();
      return;
    }

    const before = capturePairSnapshot(row);
    if (!before.ok) {
      setMessage(`保存できません: override snapshot failed: ${before.error || 'unknown'}`);
      render();
      return;
    }

    const saved = upsertAssignment(built.assignment);
    if (!saved.ok) {
      setMessage(`保存できません: ${saved.error || 'project-detailing-write-failed'}`);
      render();
      return;
    }

    const after = capturePairSnapshot(row);
    if (!after.ok) {
      setMessage(rollbackUnrecordedChange(row, before, after.error || 'unknown'));
      refreshAfterAuthoringChange();
      render();
      return;
    }
    recordPlacementChange(row, before, after);

    setSelectedKey(selectionKey(row));
    setMessage(`保存済み: ${action}。resolverを再評価します。`);
    const rebarRefreshSucceeded = refreshAfterAuthoringChange();
    const updated = selectedAuthoringRow();
    setMessage(
      withRebarRefreshStatus(
        updated
          ? `保存・再評価済み: Pair ${updated.status} / ${updated.disposition}${updated.unresolvedReason ? ` / ${updated.unresolvedReason}` : ''}\n3D production: ${formatPlacementProductionStatus(updated)}`
          : '保存済み。対象pairは再評価後のtraceから消えました。',
        rebarRefreshSucceeded,
      ),
    );
    render();
  }

  function removePlacementOverride(row) {
    const before = capturePairSnapshot(row);
    if (!before.ok) {
      setMessage(`解除できません: override snapshot failed: ${before.error || 'unknown'}`);
      render();
      return;
    }
    const removed = removeAssignment(row?.authoring?.scope || {});
    if (!removed.ok) {
      setMessage(`解除できません: ${removed.error || 'project-detailing-write-failed'}`);
      render();
      return;
    }
    if (removed.changed) {
      const after = capturePairSnapshot(row);
      if (!after.ok) {
        setMessage(rollbackUnrecordedChange(row, before, after.error || 'unknown'));
        refreshAfterAuthoringChange();
        render();
        return;
      }
      recordPlacementChange(row, before, after);
    }
    setSelectedKey(selectionKey(row));
    setMessage(
      removed.changed
        ? '明示指定を解除しました。resolverを再評価します。'
        : 'このpairには保存済み明示指定がありません。',
    );
    const rebarRefreshSucceeded = removed.changed ? refreshAfterAuthoringChange() : true;
    if (!removed.changed) render();
    if (removed.changed) {
      const updated = selectedAuthoringRow();
      setMessage(
        withRebarRefreshStatus(
          updated
            ? `解除・再評価済み: ${updated.status} / ${updated.disposition}${updated.unresolvedReason ? ` / ${updated.unresolvedReason}` : ''}`
            : '解除済み。対象pairは再評価後のtraceから消えました。',
          rebarRefreshSucceeded,
        ),
      );
      render();
    }
  }

  function createEditCell(row) {
    const editCell = document.createElement('td');
    if (!isEnabled() || !isPlacementAuthoringRow(row)) {
      editCell.textContent = '-';
      return editCell;
    }

    const key = selectionKey(row);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'trace-edit-btn';
    button.textContent = key && key === getSelectedKey() ? '選択中' : '選択';
    button.addEventListener('click', () => {
      setSelectedKey(key);
      setMessage('');
      render();
      refreshTable();
    });
    editCell.appendChild(button);
    return editCell;
  }

  function render() {
    const container = document.getElementById(`${windowId}-authoring`);
    if (!container) return;
    container.replaceChildren();

    const title = document.createElement('div');
    title.className = 'trace-authoring-title';
    title.textContent = '配筋干渉 explicit override';
    container.appendChild(title);

    if (!isEnabled()) {
      const note = document.createElement('div');
      note.textContent =
        '「干渉編集候補」を有効にするとactual collision pairを追加収集し、pair-local overrideを編集できます。';
      container.appendChild(note);
      return;
    }

    const row = selectedAuthoringRow();
    if (!row) {
      const note = document.createElement('div');
      note.textContent = '編集するREBAR_PAIR_CONFLICT行の「選択」を押してください。';
      container.appendChild(note);
      if (getMessage()) {
        const message = document.createElement('div');
        message.className = 'trace-authoring-message';
        message.textContent = getMessage();
        container.appendChild(message);
      }
      return;
    }

    const context = row.authoring;
    appendAuthoringLine(
      container,
      'Pair',
      `${context.modelSource || '-'} / Node ${context.nodeId || '-'}`,
    );
    appendAuthoringLine(container, '柱筋', authoringBarLabel(context.column));
    appendAuthoringLine(container, '梁筋', authoringBarLabel(context.beam));
    appendAuthoringLine(
      container,
      '現在の判定',
      `${row.status || '-'} / ${row.disposition || '-'}${row.unresolvedReason ? ` / ${row.unresolvedReason}` : ''}`,
    );
    appendAuthoringLine(container, '3D production', formatPlacementProductionStatus(row));
    appendAuthoringLine(
      container,
      '保存済みoverride',
      context.override?.action || context.override?.status || 'NOT_CONFIGURED',
    );
    if (context.override?.reason) {
      appendAuthoringLine(container, 'override未解決理由', context.override.reason);
    }

    const actions = document.createElement('div');
    actions.className = 'trace-authoring-actions';
    const history = historyFor(row);
    actions.append(
      authoringButton('柱筋を維持・梁筋を移動', () =>
        savePlacementOverride(row, 'KEEP_COLUMN_MOVE_BEAM'),
      ),
      authoringButton('梁筋を維持・柱筋を移動', () =>
        savePlacementOverride(row, 'KEEP_BEAM_MOVE_COLUMN'),
      ),
      authoringButton('明示指定を解除', () => removePlacementOverride(row), {
        disabled: context.override?.active !== true,
      }),
      authoringButton('元に戻す', () => applyPlacementHistory(row, 'undo'), {
        disabled: history.undo.length === 0,
      }),
      authoringButton('やり直す', () => applyPlacementHistory(row, 'redo'), {
        disabled: history.redo.length === 0,
      }),
    );
    container.appendChild(actions);

    const safety = document.createElement('div');
    safety.textContent =
      '明示指定はHard Constraintやgeometry gateを上書きしません。Pair判定がRESOLVEDでも3D productionがUNRESOLVEDなら配置は適用されません。production側の理由を優先してください。';
    container.appendChild(safety);

    if (getMessage()) {
      const message = document.createElement('div');
      message.className = 'trace-authoring-message';
      message.textContent = getMessage();
      container.appendChild(message);
    }
  }

  return {
    createEditCell,
    isPlacementAuthoringRow,
    selectionKey,
    isSelected: (row) => {
      const key = selectionKey(row);
      return Boolean(key) && key === getSelectedKey();
    },
    render,
  };
}
