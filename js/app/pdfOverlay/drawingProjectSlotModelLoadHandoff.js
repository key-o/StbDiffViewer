/**
 * #650: one-shot bridge from a reviewed multi-view DrawingProject stage to
 * the formal STB-A model loader. No UI or model mutation is performed here.
 *
 * A normal Compare click never creates this handoff; its drawing guard remains
 * in force. Only the registered CAD session can pin its own staged File and
 * Document Control descriptor before the first asynchronous loader operation.
 */
export function createDrawingProjectSlotModelLoadHandoff({ session, readSelectedFiles } = {}) {
  if (typeof readSelectedFiles !== 'function')
    throw new TypeError('正式STB読込のファイル選択確認サービスがありません。');
  const staged = session?.rebindStaged;
  if (
    !staged?.slotMode ||
    staged.phase !== 'slot' ||
    staged.plan?.status !== 'ready' ||
    typeof staged.file?.arrayBuffer !== 'function' ||
    typeof session?.prepareDrawingProjectSlotReplacement !== 'function' ||
    typeof session?.prepareDrawingProjectSlotCandidateProof !== 'function' ||
    typeof session?.createDrawingProjectSlotModelPublicationParticipant !== 'function' ||
    typeof session?.createDrawingProjectSlotStageLease !== 'function' ||
    typeof session?.synchronizeDrawingProjectSlotAfterModelPublication !== 'function'
  )
    throw new Error('全登録ビュー検証済みのSTB-A改訂stageがありません。');

  // Preflight all views before assigning a candidate to the real loader.
  const prepared = session.prepareDrawingProjectSlotReplacement();
  if (prepared.staged !== staged || prepared.selected?.modelSlotId !== staged.modelSlotId)
    throw new Error('複数ビューの改訂対象が一致していません。');

  const descriptor = session.drawingLifecycle?.getOpenDrawingProjectDescriptor?.() ?? null;
  if (
    !descriptor ||
    descriptor.projectId !== prepared.project.projectId ||
    descriptor.modelSlotId !== prepared.selected.modelSlotId ||
    descriptor.drawingDocumentId !== prepared.selected.id ||
    descriptor.sourceRevisionId !== prepared.selected.sourceRevisionId
  )
    throw new Error('STB改訂の旧Document Control登録が一致していません。');

  const selected = readSelectedFiles();
  if (!selected || !Object.hasOwn(selected, 'fileA') || !Object.hasOwn(selected, 'fileB'))
    throw new Error('正式STB-A/Bの選択状態を取得できません。');
  const oldSelectedA = selected.fileA;
  const oldSelectedB = selected.fileB;
  const preflightLease = session.createDrawingProjectSlotStageLease();
  const publicationLease = session.createDrawingProjectSlotStageLease({
    allowProvisionalModelDocument: true,
  });
  const fileA = staged.file;
  let phase = 'created';

  function assertCurrent(lease) {
    const current = readSelectedFiles();
    if (
      current?.fileA !== oldSelectedA ||
      current?.fileB !== oldSelectedB ||
      session.rebindStaged !== staged ||
      session.drawingLifecycle?.getOpenDrawingProjectDescriptor?.() !== descriptor ||
      lease() !== true
    )
      throw new Error('正式読込中にSTB選択、全ビューstageまたは登録が変更されました。');
  }

  return Object.freeze({
    fileA,
    assertPreflight() {
      assertCurrent(preflightLease);
    },
    assertBeforePublish() {
      if (phase !== 'ready') throw new Error('STB-A原本SHA事前検証が完了していません。');
      assertCurrent(publicationLease);
    },
    async prepare(candidateDocument) {
      if (phase !== 'created') throw new Error('STB-A改訂候補は再利用できません。');
      phase = 'preparing'; // Reject a second attempt, even if this async one fails.
      assertCurrent(preflightLease);
      const proof = await session.prepareDrawingProjectSlotCandidateProof({
        file: fileA,
        candidateDocument,
        getSelectedFile: () => (session.rebindStaged === staged ? staged.file : null),
      });
      assertCurrent(preflightLease);
      if (
        proof?.file !== fileA ||
        proof.modelDocument !== candidateDocument ||
        typeof proof.verifyPublishedModelSource !== 'function'
      )
        throw new Error('正式STB-A候補と改訂原本のSHA証明が一致しません。');
      const participant = session.createDrawingProjectSlotModelPublicationParticipant({
        verifyPublishedModelSource: proof.verifyPublishedModelSource,
        prepared,
      });
      if (
        typeof participant?.publish !== 'function' ||
        typeof participant?.rollback !== 'function' ||
        typeof participant?.finalize !== 'function'
      )
        throw new Error('DrawingProject一体公開参加者を準備できません。');
      phase = 'ready';
      return participant;
    },
    afterCommit(result) {
      if (phase !== 'ready') throw new Error('正式STB改訂はまだ一体公開されていません。');
      phase = 'finalized';
      if (result?.modelStatus !== 'published' || result.drawingStatus !== 'rebound')
        throw new Error('Document Controlの改訂登録が確定していません。');
      try {
        const synchronized = session.synchronizeDrawingProjectSlotAfterModelPublication({
          prepared,
        });
        if (synchronized?.status !== 'synchronized')
          throw new Error('図面・シートの再同期を確認できません。');
        return synchronized;
      } catch (error) {
        // The old 3D scene is already gone. Revoke, rather than silently
        // maintaining an authorized but partially repainted DrawingProject.
        try {
          session.closeOpenDrawingProject?.();
        } finally {
          session.drawingLifecycle?.close?.();
        }
        throw error;
      }
    },
  });
}
