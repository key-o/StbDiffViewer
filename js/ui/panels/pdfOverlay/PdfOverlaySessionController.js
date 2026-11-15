/** @fileoverview PDF照合セッションのJSON入出力、部材メモ、図面上の自由メモ。 */
import { createDrawingProjectLifecycle } from '../../../app/documentControl/drawingProjectLifecycle.js';
import { registerDrawingProjectOwner } from '../../../app/documentControl/drawingProjectBridge.js';
import {
  createPdfOverlaySession,
  parsePdfOverlaySession,
  PDF_OVERLAY_TAG_PLACEMENT_SCHEMA_VERSION,
  reconcilePdfOverlaySession,
  serializePdfOverlaySession,
} from '../../../app/pdfOverlay/pdfOverlaySession.js';
import {
  createDrawingProjectFromWorkspaceState,
  restoreDrawingWorkspaceReviewState,
} from '../../../app/pdfOverlay/pdfOverlayDrawingProjectMigration.js';
import {
  assertDrawingProjectWorkspaceEditSafe,
  mergeDrawingProjectWorkspaceSnapshot,
} from '../../../app/pdfOverlay/drawingProjectWorkspaceEdit.js';
import { planLegacyPdfDrawingMemoMigration } from '../../../app/pdfOverlay/legacyPdfDrawingMemoMigration.js';
import { inspectPdfRegionMapping } from '../../../app/pdfOverlay/pdfOverlayRegion.js';
import {
  parseDrawingProject,
  serializeDrawingProject,
} from '../../../data/drawing/drawingProjectSchema.js';
import {
  resolveCurrentSheetDrawingDocument,
  stageDrawingSheetProjectImport,
} from '../../../data/drawing/drawingSheetProjectEdit.js';
import {
  commitDrawingProjectDrawingRevisionRebind,
  planDrawingProjectDrawingRevisionRebind,
  planDrawingProjectStoryRevisionRebind,
} from '../../../data/drawing/drawingProjectRevisionRebind.js';
import {
  createDrawingProjectArchive,
  readDrawingProjectArchive,
} from '../../../data/drawing/drawingProjectArchive.js';
import {
  planDrawingProjectSlotRevisionRebind,
  commitDrawingProjectSlotRevisionRebind,
} from '../../../data/drawing/drawingProjectSlotRevisionRebind.js';
import { stageDrawingProjectSlotRevisionFromStb } from '../../../app/pdfOverlay/drawingProjectSlotRevisionStage.js';
import { assertDrawingProjectSlotRuntimeCurrent } from '../../../app/pdfOverlay/drawingProjectSlotRuntimeGuard.js';
import { prepareDrawingProjectSlotModelSourceProof } from '../../../app/pdfOverlay/drawingProjectSlotModelSourceProof.js';
import { createDrawingProjectSlotPublicationParticipant } from '../../../app/pdfOverlay/drawingProjectSlotPublicationParticipant.js';
import { createDrawingProjectSlotModelLoadHandoff } from '../../../app/pdfOverlay/drawingProjectSlotModelLoadHandoff.js';
import { synchronizeDrawingProjectSlotAfterModelLoad } from '../../../app/pdfOverlay/drawingProjectSlotPostCommitSync.js';
import {
  captureDrawingProjectSlotStageLease,
  drawingProjectSlotApprovalsFingerprint,
  drawingProjectSlotWorkspaceFingerprint,
} from '../../../app/pdfOverlay/drawingProjectSlotStageLease.js';
import { collectDrawingProjectArchiveSources } from '../../../data/drawing/drawingProjectArchiveSources.js';
import { cutDrawingModelToBounds } from '../../../data/drawing/drawingSheetCutRegion.js';
import { ownsZipColdStartRollback } from '../../../app/pdfOverlay/drawingProjectZipRollbackGuard.js';
import {
  stageDrawingProjectArchiveWithIntents,
  stageDrawingProjectArchiveWorkspace,
} from '../../../app/pdfOverlay/drawingProjectArchiveWorkspaceStage.js';
import { getState } from '../../../data/state/globalState.js';
import { invertAffine, transformPoint } from '../../../data/drawing/affine2d.js';
import {
  discardOrphanedDrawingIntents,
  listOrphanedDrawingIntents,
} from '../../../data/drawing/drawingProjectOrphanDiscard.js';
import { planViewContextSnapshot } from '../../../data/drawing/drawingModel.js';
import {
  BUILTIN_TAG_FAMILIES,
  familyIdFromSelection,
} from '../../../data/drawing/tags/tagFamilyRegistry.js';
import {
  createEmptyTagFamilyState,
  normalizeTagFamilyState,
  selectTagFamily,
} from '../../../data/drawing/tags/tagFamilyStore.js';
import { downloadBlob } from '../../../utils/downloadHelper.js';
import { showInfo, showSuccess, showWarning } from '../../common/toast.js';
import {
  canonicalPdfDrawingTagCategory,
  refreshPdfDrawingTagFamilyOptions,
} from '../pdfDrawingDisplaySettings.js';
import { TagFamilyManagerController } from './TagFamilyManagerController.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ORPHAN_OPTION_VALUE = '__orphan__';
const REVIEW_STATES = new Set(['unreviewed', 'confirmed', 'mismatch']);
const REVIEW_CONTEXT_ONLY_INVALIDATION_CODES = new Set([
  'PDF_CHANGED',
  'PDF_BYTES_CHANGED',
  'PDF_PAGE_COUNT_CHANGED',
  'PDF_IDENTITY_MISSING',
  'PAGE_CHANGED',
  'PAGE_CONTEXT_MISSING',
  'PAGE_VIEW_CHANGED',
  'USER_UNIT_CHANGED',
  'PDF_ROTATION_CHANGED',
  'REGION_CHANGED',
  'REGION_MAPPING_MISSING',
  'ALIGNMENT_CHANGED',
  'ALIGNMENT_MISSING',
  'ALIGNMENT_INVALID',
  'PLACEMENT_CHANGED',
  'DRAWING_ROTATION_CHANGED',
]);

function refIdentity(ref) {
  return [String(ref.modelKey), String(ref.elementType), String(ref.elementId)];
}

function identityKey(identity) {
  return JSON.stringify(identity);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function placementKey(record) {
  return JSON.stringify(
    canonicalJson([
      record.drawing?.source || null,
      record.drawing?.view || null,
      ...(record.identity || []),
      record.template?.id || null,
      Number(record.template?.version),
    ]),
  );
}

function rounded(value) {
  return Number(Number(value).toFixed(3));
}

function drawingPlacementSnapshot(drawing) {
  if (!drawing?.source?.modelKey || !drawing?.source?.modelRevision || !drawing?.view) return null;
  // タグ・自由メモの保存contextは平面図(階)専用。立面(軸組図)は保存contextを持たないため配置なし扱い。
  if (drawing.view.type !== 'plan') return null;
  return {
    source: {
      modelKey: String(drawing.source.modelKey),
      modelRevision: String(drawing.source.modelRevision),
    },
    view: JSON.parse(JSON.stringify(planViewContextSnapshot(drawing.view))),
  };
}

function placementSnapshot(record) {
  return {
    schemaVersion: PDF_OVERLAY_TAG_PLACEMENT_SCHEMA_VERSION,
    identity: [...record.identity],
    drawing: JSON.parse(JSON.stringify(record.drawing)),
    template: { ...record.template },
    anchorModel: [...record.anchorModel],
    offsetModel: [...record.offsetModel],
    rotationDeg: record.rotationDeg,
    leader: record.leader,
  };
}

function isStbRevisionFile(file) {
  if (!file || typeof file.name !== 'string') return false;
  return /\.(stb|xml)$/i.test(file.name) || /xml/i.test(file.type || '');
}

function readFileAsText(file) {
  if (typeof file?.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('JSONファイルを読み込めません。'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file, 'UTF-8');
  });
}

function cloneRecords(records) {
  return records.map((record) => ({ ...record }));
}

function runtimeProjectId() {
  return globalThis.crypto?.randomUUID?.() || `drawing-project-${Date.now()}`;
}

function stripDrawingMemoRuntimeState(memo) {
  const saved = { ...memo };
  delete saved.active;
  delete saved.invalidationCode;
  return saved;
}

function samePlanView(left, right) {
  return Boolean(
    left?.type === 'plan' &&
    right?.type === 'plan' &&
    String(left.storyId) === String(right.storyId),
  );
}

export class PdfOverlaySessionController {
  constructor(panel) {
    this.panel = panel;
    this.root = panel.root;
    this.memberReviews = [];
    this.drawingMemos = [];
    this.drawingMemoIdentity = null;
    this.tagPlacements = [];
    this.tagFamilyState = createEmptyTagFamilyState();
    this.tagContexts = new Map();
    this.tagDragCleanup = null;
    this.selectedIdentity = null;
    this.pendingDocument = null;
    this.drawingProjectId = null;
    this.loadedDrawingProject = null;
    this.activeDrawingDocumentId = null;
    this.archiveSourceRevisions = [];
    this.archivedPdfFontFile = null;
    this.archiveExportSequence = 0;
    this.drawingLifecycle = createDrawingProjectLifecycle();
    this.detachDrawingProvider = registerDrawingProjectOwner(this);
    this.openDrawingIdentity = null;
    this.openModelDocument = null;
    this.drawingImportSequence = 0;
    this.zipColdStartEpoch = 0;
    this.rebindStaged = null;
    this.rebindApprovals = new Map();
    this.rebindAbortController = null;
    this.slotModelLoadInProgress = false;
    this.pickDrawingMemo = false;
    this.lastPlacementSignature = null;
    this.applyingRestore = false;
    this.preparingRestore = false;
    this.tagFamilyUi = new TagFamilyManagerController(this);
    this.bindEvents();
    this.tagFamilyUi.bindEvents();
    refreshPdfDrawingTagFamilyOptions(this.tagFamilyState, globalThis.document);
    this.clearDrawingProjectReplacement();
  }

  hasLoadedDrawingProject() {
    return this.loadedDrawingProject != null;
  }

  getOpenDrawingProjectDescriptor() {
    const active = this.drawingLifecycle?.getOpenDrawingProjectDescriptor?.() ?? null;
    if (
      active &&
      (this.panel.drawing !== this.openDrawingIdentity ||
        this.currentModelDocument() !== this.openModelDocument)
    ) {
      this.closeOpenDrawingProject();
      return null;
    }
    return active;
  }

  subscribeDrawingProjectLifecycle(listener) {
    return this.drawingLifecycle.subscribeDrawingProjectLifecycle(listener);
  }

  currentModelDocument() {
    const key = this.panel.drawing?.source?.modelKey;
    return ['A', 'B'].includes(key) ? getState(`models.document${key}`) : null;
  }

  drawingDescriptorInput(project = this.loadedDrawingProject) {
    const document =
      project &&
      (project.drawingDocuments.length > 1
        ? resolveCurrentSheetDrawingDocument(
            project,
            this.panel.drawing,
            this.panel.selectedCadDrawingView?.(),
            this.activeDrawingDocumentId,
          )
        : this.drawingProjectDocumentForCurrent(project));
    return {
      project,
      document,
      runtime: {
        memberReviews: this.memberReviews,
        drawingMemos: this.drawingMemos,
        tagPlacements: this.tagPlacements,
        scaleDenominator: this.panel.scaleDenominator(),
        rotationDeg: this.panel.drawingRotationDeg,
        tagOrientationMode: this.panel.tagOrientationMode,
      },
    };
  }

  openDrawingProject(project) {
    // Isolated legacy controller fixtures do not instantiate the lifecycle owner.
    if (!this.drawingLifecycle) return null;
    if (!this.panel.drawing || !this.currentModelDocument())
      throw new Error('モデルと作図対象が開かれていません。');
    const descriptor = this.drawingDescriptorInput(project);
    this.openDrawingIdentity = this.panel.drawing;
    this.openModelDocument = this.currentModelDocument();
    return this.drawingLifecycle.open(descriptor);
  }

  reviseOpenDrawingProject() {
    if (!this.getOpenDrawingProjectDescriptor()) return;
    try {
      this.drawingLifecycle.revise(this.drawingDescriptorInput());
    } catch {
      this.closeOpenDrawingProject();
    }
  }

  closeOpenDrawingProject() {
    // Cancel in-flight import first, including the case where no project is open.
    ++this.drawingImportSequence;
    this.drawingLifecycle?.close?.();
    this.openDrawingIdentity = null;
    this.openModelDocument = null;
  }

  disposeDrawingProjectProvider() {
    this.closeOpenDrawingProject();
    this.archivedPdfFontFile = null;
    this.detachDrawingProvider?.();
  }

  /**
   * #650: explicit user-controlled release of the registered DrawingProject.
   * Closing the CAD window revokes only the active descriptor and deliberately
   * leaves loadedDrawingProject available for ZIP export. Model reload stays
   * blocked until the project itself is explicitly released.
   */
  unloadLoadedDrawingProjectFromUser(event) {
    if (!event?.isTrusted || !this.loadedDrawingProject) return false;
    if (this.applyingRestore || this.preparingRestore) {
      this.setDrawingProjectStatus('ZIP/JSON復元中は図面プロジェクトを解除できません。');
      return false;
    }
    const confirmDiscard =
      globalThis.window?.confirm?.bind(globalThis.window) || globalThis.confirm;
    if (
      typeof confirmDiscard !== 'function' ||
      !confirmDiscard(
        '登録図面・シート・タグ・レビューの未保存変更を破棄します。プロジェクトZIPまたはJSONを保存済みですか？解除してモデルの差替えを許可しますか？',
      )
    )
      return false;

    // Invalidate in-flight archive/rebind operations before revoking the owner.
    ++this.zipColdStartEpoch;
    ++this.archiveExportSequence;
    this.rebindAbortController?.abort();
    this.closeOpenDrawingProject();
    this.clearDrawingProjectReplacement();
    this.loadedDrawingProject = null;
    this.drawingProjectId = null;
    this.activeDrawingDocumentId = null;
    this.archiveSourceRevisions = [];
    this.archivedPdfFontFile = null;
    this.memberReviews = [];
    this.drawingMemos = [];
    this.drawingMemoIdentity = null;
    this.tagPlacements = [];
    // Project-owned custom templates must not leak into the next model session.
    this.setTagFamilyState(createEmptyTagFamilyState(), { render: false });
    this.selectedIdentity = null;
    this.pendingDocument = null;
    this.tagContexts?.clear?.();
    this.panel.invalidateDrawing?.('図面プロジェクトを解除しました。モデルを再読込できます。');
    this.panel.sheetBrowser?.invalidatePreviewSources?.();
    this.panel.sheetBrowser?.render?.();
    this.panel.updatePdfFeatureAvailability?.();
    this.setDrawingProjectStatus('図面プロジェクトを解除しました。モデルを再読込できます。');
    return true;
  }

  createNewDrawingProjectFromUser(event) {
    if (!event?.isTrusted) return;
    this.openNewDrawingProject();
  }

  /** 現在の図面から新規DrawingProjectを開く。ユーザー操作の検証は呼び出し側が行う。 */
  openNewDrawingProject() {
    this.closeOpenDrawingProject();
    const previous = this.loadedDrawingProject;
    const previousId = this.drawingProjectId;
    this.loadedDrawingProject = null;
    this.drawingProjectId = null;
    let project;
    try {
      project = this.createDrawingProjectSnapshot();
    } catch (error) {
      this.loadedDrawingProject = previous;
      this.drawingProjectId = previousId;
      throw error;
    }
    this.drawingProjectId = project.projectId;
    this.loadedDrawingProject = project;
    this.activeDrawingDocumentId = null;
    this.archiveSourceRevisions = [];
    this.archivedPdfFontFile = null;
    this.archiveExportSequence++;
    this.clearDrawingProjectReplacement();
    this.openDrawingProject(project);
    this.setDrawingProjectStatus('新規DrawingProjectを開きました。');
    this.panel.sheetBrowser?.render();
  }

  bindEvents() {
    this.root
      .querySelector('#pdf-overlay-unload-drawing-project')
      ?.addEventListener('click', (event) => this.unloadLoadedDrawingProjectFromUser(event));
    this.root
      .querySelector('#pdf-overlay-new-drawing-project')
      ?.addEventListener('click', (event) => {
        try {
          this.createNewDrawingProjectFromUser(event);
        } catch (error) {
          showWarning(error?.message || '新規DrawingProjectを開けませんでした。');
        }
      });

    this.root
      .querySelector('#pdf-overlay-export-drawing-project-zip')
      ?.addEventListener('click', () => {
        this.exportDrawingProjectZip().catch((error) => {
          this.setDrawingProjectStatus(error?.message || 'プロジェクトZIPを書き出せませんでした。');
          showWarning(error?.message || 'プロジェクトZIPを書き出せませんでした。');
        });
      });
    this.root
      .querySelector('#pdf-overlay-import-drawing-project-zip-trigger')
      ?.addEventListener('click', () =>
        this.root.querySelector('#pdf-overlay-import-drawing-project-zip')?.click(),
      );
    this.root
      .querySelector('#pdf-overlay-import-drawing-project-zip')
      ?.addEventListener('change', (event) => {
        const importing = this.importDrawingProjectZip(event.target.files?.[0]);
        const ownEpoch = this.zipColdStartEpoch;
        return importing
          .catch((error) => {
            // The stale request must not replace a newer import's success status.
            if (ownEpoch !== this.zipColdStartEpoch) return;
            this.setDrawingProjectStatus(
              error?.message || 'プロジェクトZIPを読み込めませんでした。',
            );
            showWarning(error?.message || 'プロジェクトZIPを読み込めませんでした。');
          })
          .finally(() => {
            // The user may already have selected a different file in this input.
            if (ownEpoch === this.zipColdStartEpoch) event.target.value = '';
          });
      });
    this.root.querySelector('#pdf-overlay-export-drawing-project').addEventListener('click', () => {
      try {
        this.exportDrawingProject();
      } catch (error) {
        this.setDrawingProjectStatus(
          error?.message || 'Drawing Workspace JSONを書き出せませんでした。',
        );
        showWarning(error?.message || 'Drawing Workspace JSONを書き出せませんでした。');
      }
    });
    this.root
      .querySelector('#pdf-overlay-import-drawing-project-trigger')
      .addEventListener('click', () =>
        this.root.querySelector('#pdf-overlay-import-drawing-project').click(),
      );
    this.root
      .querySelector('#pdf-overlay-import-drawing-project')
      .addEventListener('change', (event) => {
        const importing = this.importDrawingProject(event.target.files?.[0]);
        const ownEpoch = this.zipColdStartEpoch;
        return importing
          .catch((error) => {
            if (ownEpoch !== this.zipColdStartEpoch) return;
            this.setDrawingProjectStatus(
              error?.message || 'Drawing Workspace JSONを読み込めませんでした。',
            );
            showWarning(error?.message || 'Drawing Workspace JSONを読み込めませんでした。');
          })
          .finally(() => {
            if (ownEpoch === this.zipColdStartEpoch) event.target.value = '';
          });
      });
    this.root
      .querySelector('#pdf-overlay-rebind-stb-trigger')
      .addEventListener('click', () => this.root.querySelector('#pdf-overlay-rebind-stb').click());
    this.root.querySelector('#pdf-overlay-rebind-stb').addEventListener('change', (event) =>
      this.stageDrawingProjectReplacement(event.target.files?.[0])
        .catch((error) => {
          this.setDrawingProjectRebindStatus(
            error?.message || 'STB改訂差替えを準備できませんでした。',
          );
          showWarning(error?.message || 'STB改訂差替えを準備できませんでした。');
        })
        .finally(() => {
          event.target.value = '';
        }),
    );
    this.root
      .querySelector('#pdf-overlay-rebind-reevaluate')
      .addEventListener('click', () => this.runDrawingProjectReplacementReevaluation());
    this.root.querySelector('#pdf-overlay-rebind-commit').addEventListener('click', (event) =>
      Promise.resolve()
        .then(() =>
          this.rebindStaged?.slotMode
            ? this.commitDrawingProjectSlotFromUser(event)
            : this.commitDrawingProjectReplacement(),
        )
        .catch((error) => {
          this.setDrawingProjectRebindStatus(error?.message || 'STB改訂を確定できませんでした。');
          showWarning(error?.message || 'STB改訂を確定できませんでした。');
        }),
    );
    this.root
      .querySelector('#pdf-overlay-rebind-export-prepared-zip')
      .addEventListener('click', () =>
        Promise.resolve()
          .then(() => this.exportPreparedDrawingProjectSlotZip())
          .catch((error) => {
            this.setDrawingProjectRebindStatus(error?.message || '改訂ZIPを準備できませんでした。');
            showWarning(error?.message || '改訂ZIPを準備できませんでした。');
          }),
      );
    this.root
      .querySelector('#pdf-overlay-rebind-clear')
      .addEventListener('click', () => this.clearDrawingProjectReplacement());

    this.root.querySelector('#pdf-overlay-export-session').addEventListener('click', () => {
      try {
        this.exportSession();
      } catch (error) {
        showWarning(error?.message || 'セッションJSONを書き出せませんでした。');
      }
    });
    this.root
      .querySelector('#pdf-overlay-import-session-trigger')
      .addEventListener('click', () =>
        this.root.querySelector('#pdf-overlay-import-session').click(),
      );
    this.root.querySelector('#pdf-overlay-import-session').addEventListener('change', (event) =>
      this.importSession(event.target.files?.[0]).catch((error) => {
        this.setSessionStatus(error?.message || 'JSONを読み込めませんでした。');
        showWarning(error?.message || 'JSONを読み込めませんでした。');
      }),
    );
    this.root
      .querySelector('#pdf-overlay-restore-session')
      .addEventListener('click', () => this.restorePending());
    this.root
      .querySelector('#pdf-overlay-save-member-review')
      .addEventListener('click', () => this.saveMemberReview());
    this.root
      .querySelector('#pdf-overlay-add-drawing-memo')
      .addEventListener('click', () => this.armDrawingMemo());
    this.root
      .querySelector('#pdf-overlay-migrate-legacy-drawing-memos')
      .addEventListener('click', () => this.migrateLegacyPdfDrawingMemos());
    this.root.querySelector('#pdf-overlay-cancel-drawing-memo').addEventListener('click', () => {
      this.cancelDrawingMemo();
      this.panel.renderOverlay();
    });
    this.root.querySelector('#pdf-overlay-tag-rotation').addEventListener('change', () => {
      this.updateSelectedTagAppearance();
    });
    this.root.querySelector('#pdf-overlay-tag-leader').addEventListener('change', () => {
      this.updateSelectedTagAppearance();
    });
    this.root
      .querySelector('#pdf-overlay-reset-tag-placement')
      .addEventListener('click', () => this.resetSelectedTagPlacement());

    for (const input of this.root.querySelectorAll(
      '[id^="pdf-overlay-"][id$="-mx"], [id^="pdf-overlay-"][id$="-my"], [id^="pdf-overlay-"][id$="-px"], [id^="pdf-overlay-"][id$="-py"]',
    )) {
      input.addEventListener('input', () => this.onAnchorInputChanged());
    }
  }

  setSessionStatus(message) {
    this.root.querySelector('#pdf-overlay-session-status').textContent = message;
  }

  syncDrawingProjectUnloadControl() {
    const unload = this.root.querySelector('#pdf-overlay-unload-drawing-project');
    if (unload) unload.disabled = !this.loadedDrawingProject;
  }

  setDrawingProjectStatus(message) {
    const status = this.root.querySelector('#pdf-overlay-drawing-project-status');
    if (status) status.textContent = message;
    this.syncDrawingProjectUnloadControl();
  }

  setDrawingProjectRebindStatus(message) {
    const status = this.root.querySelector('#pdf-overlay-rebind-status');
    if (status) status.textContent = message;
  }

  clearDrawingProjectReplacement({ status = null } = {}) {
    this.rebindAbortController?.abort();
    this.rebindAbortController = null;
    this.rebindStaged = null;
    this.rebindApprovals = new Map();
    const list = this.root.querySelector('#pdf-overlay-rebind-mapping-list');
    if (list) list.replaceChildren();
    const trigger = this.root.querySelector('#pdf-overlay-rebind-stb-trigger');
    const reevaluate = this.root.querySelector('#pdf-overlay-rebind-reevaluate');
    const commit = this.root.querySelector('#pdf-overlay-rebind-commit');
    const preparedZip = this.root.querySelector('#pdf-overlay-rebind-export-prepared-zip');
    const clear = this.root.querySelector('#pdf-overlay-rebind-clear');
    if (trigger) trigger.disabled = !this.loadedDrawingProject;
    if (preparedZip) preparedZip.disabled = true;
    if (reevaluate) reevaluate.disabled = true;
    if (commit) {
      commit.disabled = true;
      commit.textContent = '改訂を確定してJSON保存';
      commit.title = '';
    }
    if (clear) clear.disabled = true;
    this.setDrawingProjectRebindStatus(
      status ||
        (this.loadedDrawingProject
          ? '新STBを選択すると改訂対応をstagingします。'
          : 'Drawing Workspace JSONを読み込むとSTB改訂差替えを開始できます。'),
    );
  }

  rebindCandidateRecords(drawing, elementType, storyCandidates = []) {
    const records = [];
    const seen = new Set();
    const push = (sourceRef, label) => {
      if (!sourceRef || String(sourceRef.elementType) !== String(elementType)) return;
      const normalized = {
        elementType: String(sourceRef.elementType),
        elementId: String(sourceRef.elementId),
        guid: sourceRef.guid == null ? null : String(sourceRef.guid),
      };
      const key = JSON.stringify([normalized.elementType, normalized.elementId]);
      if (seen.has(key)) return;
      seen.add(key);
      records.push({ sourceRef: normalized, label });
    };
    for (const story of storyCandidates || []) {
      push(
        story.sourceRef,
        `Story #${story.sourceRef?.elementId}${story.name ? ` / ${story.name}` : ''}${Number.isFinite(story.height) ? ` / Z=${story.height}mm` : ''}${story.sourceRef?.guid ? ` / GUID ${story.sourceRef.guid}` : ''}`,
      );
    }
    for (const record of drawing?.elements || []) {
      push(
        record.ref,
        `${record.ref?.elementType} #${record.ref?.elementId}${record.mark ? ` / ${record.mark}` : ''}${record.ref?.guid ? ` / GUID ${record.ref.guid}` : ''}`,
      );
    }
    for (const reference of drawing?.dimensionReferences || []) {
      push(
        reference.sourceRef,
        `${reference.sourceRef?.elementType} #${reference.sourceRef?.elementId}${reference.name ? ` / ${reference.name}` : ''}${reference.sourceRef?.guid ? ` / GUID ${reference.sourceRef.guid}` : ''}`,
      );
    }
    return records;
  }

  runDrawingProjectReplacementReevaluation() {
    const report = (error) => {
      this.setDrawingProjectRebindStatus(error?.message || '対応を再評価できませんでした。');
      showWarning(error?.message || '対応を再評価できませんでした。');
    };
    try {
      Promise.resolve(this.reevaluateDrawingProjectReplacement()).catch(report);
    } catch (error) {
      report(error);
    }
  }

  createRebindOrphanButton(entityId) {
    const button = this.root.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = '対応先なしとして保持';
    button.addEventListener('click', () => {
      this.rebindApprovals.set(entityId, { orphan: true });
      this.runDrawingProjectReplacementReevaluation();
    });
    return button;
  }

  createRebindOrphanUndoButton(entityId) {
    const button = this.root.ownerDocument.createElement('button');
    button.type = 'button';
    button.textContent = '取消';
    button.addEventListener('click', () => {
      this.rebindApprovals.delete(entityId);
      this.runDrawingProjectReplacementReevaluation();
    });
    return button;
  }

  approvedMappingsForRebind() {
    return [...this.rebindApprovals.entries()]
      .filter(([, sourceRef]) => !sourceRef.orphan)
      .map(([entityId, sourceRef]) => ({ entityId, sourceRef: { ...sourceRef } }));
  }

  /** 対応先なしとして明示承認された(作図意図は孤児として保持する)entityId。 */
  orphanedEntityIdsForRebind() {
    return [...this.rebindApprovals.entries()]
      .filter(([, sourceRef]) => sourceRef.orphan)
      .map(([entityId]) => entityId);
  }

  renderDrawingProjectRebindPlan() {
    const staged = this.rebindStaged;
    const list = this.root.querySelector('#pdf-overlay-rebind-mapping-list');
    const reevaluate = this.root.querySelector('#pdf-overlay-rebind-reevaluate');
    const commit = this.root.querySelector('#pdf-overlay-rebind-commit');
    const clear = this.root.querySelector('#pdf-overlay-rebind-clear');
    const preparedZip = this.root.querySelector('#pdf-overlay-rebind-export-prepared-zip');
    if (preparedZip) preparedZip.disabled = true;
    if (list) list.replaceChildren();
    if (!staged) {
      if (reevaluate) reevaluate.disabled = true;
      if (commit) commit.disabled = true;
      if (clear) clear.disabled = !this.rebindAbortController;
      return;
    }

    if (clear) clear.disabled = false;
    if (staged.slotMode) return this.renderDrawingProjectSlotRebindPlan();
    const plan = staged.plan;
    for (const mapping of plan.mappings) {
      const item = this.root.ownerDocument.createElement('li');
      const from = mapping.fromSourceRef;
      if (mapping.status === 'resolved') {
        const to = mapping.toSourceRef;
        item.textContent = to
          ? `${mapping.entityId}: ${from.elementType} #${from.elementId} → #${to.elementId} / ${mapping.method}`
          : `${mapping.entityId}: ${from.elementType} #${from.elementId} → 対応先なし（作図意図を孤児として保持）`;
        if (!to) item.append(this.createRebindOrphanUndoButton(mapping.entityId));
      } else {
        const label = this.root.ownerDocument.createElement('span');
        label.textContent = `${mapping.entityId}: ${from.elementType} #${from.elementId} / ${mapping.reason} `;
        const select = this.root.ownerDocument.createElement('select');
        select.className = 'form-control';
        select.dataset.rebindEntityId = mapping.entityId;
        const blank = this.root.ownerDocument.createElement('option');
        blank.value = '';
        blank.textContent = '対応先を選択…';
        select.append(blank);
        if (from.elementType !== 'Story') {
          const orphan = this.root.ownerDocument.createElement('option');
          orphan.value = ORPHAN_OPTION_VALUE;
          orphan.textContent = '対応先なし（作図意図を孤児として保持）';
          select.append(orphan);
        }
        const candidates = this.rebindCandidateRecords(
          staged.imported.drawing,
          from.elementType,
          staged.imported.storyCandidates || [],
        );
        for (const candidate of candidates) {
          const option = this.root.ownerDocument.createElement('option');
          option.value = JSON.stringify(candidate.sourceRef);
          option.textContent = candidate.label;
          select.append(option);
        }
        const approved = this.rebindApprovals.get(mapping.entityId);
        if (approved)
          select.value = approved.orphan ? ORPHAN_OPTION_VALUE : JSON.stringify(approved);
        select.addEventListener('change', () => {
          this.rebindAbortController?.abort();
          this.rebindAbortController = null;
          if (!select.value) this.rebindApprovals.delete(mapping.entityId);
          else if (select.value === ORPHAN_OPTION_VALUE)
            this.rebindApprovals.set(mapping.entityId, { orphan: true });
          else this.rebindApprovals.set(mapping.entityId, JSON.parse(select.value));
          if (reevaluate) reevaluate.disabled = this.rebindApprovals.size === 0;
        });
        item.append(label, select);
      }
      list?.append(item);
    }
    for (const diagnostic of plan.diagnostics || []) {
      const item = this.root.ownerDocument.createElement('li');
      item.textContent = `⚠ ${diagnostic.entityId}: ${diagnostic.code}（${diagnostic.toSourceRef.elementType} #${diagnostic.toSourceRef.elementId}）。このままでは確定時にタグ配置を復元できません。 `;
      // 対応先は解決済みでも描画されない場合、確定を進める手段として孤児化を選べるようにする。
      if (diagnostic.toSourceRef.elementType !== 'Story')
        item.append(this.createRebindOrphanButton(diagnostic.entityId));
      list?.append(item);
    }

    const resolved = plan.mappings.length - plan.unresolved.length;
    this.setDrawingProjectRebindStatus(
      `${staged.imported.filename || 'STB'} / ${plan.status === 'ready' ? '確定可能' : '要対応'} / 自動・承認済み ${resolved}件 / 未解決 ${plan.unresolved.length}件`,
    );
    if (reevaluate)
      reevaluate.disabled = plan.status === 'ready' || this.rebindApprovals.size === 0;
    if (commit) {
      commit.disabled = plan.status !== 'ready';
      commit.textContent = '改訂を確定してJSON保存';
      commit.title = '';
    }
  }

  /**
   * Stage all registered plan views of a modelSlot from a single new STB.
   * For multi-view projects, persisted metadata is authoritative: legacy
   * workspace snapshotting would silently discard the other documents.
   */
  async stageDrawingProjectSlotReplacement(file, { selected = null, selectedId = null } = {}) {
    const sourceProject = this.loadedDrawingProject;
    if (!sourceProject) throw new Error('DrawingProjectが開かれていません。');
    const active =
      selected ||
      resolveCurrentSheetDrawingDocument(
        sourceProject,
        this.panel.drawing,
        this.panel.selectedCadDrawingView?.(),
        selectedId || this.activeDrawingDocumentId,
      );
    if (this.panel.drawing?.source?.modelKey !== 'A')
      throw new Error('複数ビュー改訂の準備は現在STB-Aの図面からのみ行えます。');
    const prior = this.rebindStaged;
    if (prior?.slotMode && prior.sourceProjectSnapshot !== serializeDrawingProject(sourceProject))
      throw new Error(
        '対応選択中にDrawingProjectが変更されました。改訂を最初から再検証してください。',
      );
    // An STB import yields several times. Pin the input project, model, selected
    // view and manual approvals *before* the first await, not after the import.
    const sourceProjectSnapshot = serializeDrawingProject(sourceProject);
    const sourceStillCurrent = captureDrawingProjectSlotStageLease(() => ({
      staged: sourceProject,
      stagePlan: null,
      stagePlanStatus: null,
      sourceFile: file,
      project: this.loadedDrawingProject,
      serializedProject: this.loadedDrawingProject
        ? serializeDrawingProject(this.loadedDrawingProject)
        : null,
      drawing: this.panel?.drawing,
      modelDocument: getState('models.documentA'),
      activeDrawingDocumentId: this.activeDrawingDocumentId,
      selectedViewKey: this.panel?.selectedCadDrawingView?.()?.key ?? null,
      workspaceSignature: this.drawingProjectSlotWorkspaceSignature(),
      approvals: this.rebindApprovals,
    }));
    this.rebindAbortController?.abort();
    const controller = new globalThis.AbortController();
    this.rebindAbortController = controller;
    this.panel.services = this.panel.services || this.panel.getServices?.();
    const services = this.panel.services;
    this.rebindStaged = null;
    this.renderDrawingProjectRebindPlan();
    try {
      const stage = await stageDrawingProjectSlotRevisionFromStb({
        project: sourceProject,
        modelSlotId: active.modelSlotId,
        file,
        modelKey: 'A',
        services,
        signal: controller.signal,
        approvedMappings: this.approvedMappingsForRebind(),
        orphanedEntityIds: this.orphanedEntityIdsForRebind(),
        planSlotRebind: planDrawingProjectSlotRevisionRebind,
      });
      if (controller.signal.aborted || this.rebindAbortController !== controller) return;
      if (!sourceStillCurrent())
        throw new Error(
          'STB解析中に原本、登録ビューまたは承認内容が変更されました。再検証してください。',
        );
      this.rebindAbortController = null;
      this.rebindStaged = {
        ...stage,
        slotMode: true,
        file,
        modelSlotId: active.modelSlotId,
        selectedDrawingId: active.id,
        sourceProjectSnapshot,
        approvalSignature: drawingProjectSlotApprovalsFingerprint(this.rebindApprovals),
        imported: {
          ...stage.inspection,
          filename: file.name || null,
          drawing: stage.importedById[active.id]?.drawing ?? null,
        },
      };
      this.renderDrawingProjectRebindPlan();
      showInfo(
        stage.plan.status === 'ready'
          ? '全登録伏図のSTB改訂対応を検証しました。ZIP保存できます。直接確定には新STB-A原本の読み込みが必要です。'
          : '複数ビューで未解決の対応があります。対応先を選択して再評価してください。',
      );
      return stage.plan;
    } catch (error) {
      if (controller.signal.aborted || this.rebindAbortController !== controller) return;
      this.rebindAbortController = null;
      this.renderDrawingProjectRebindPlan();
      throw error;
    }
  }

  renderDrawingProjectSlotRebindPlan() {
    const staged = this.rebindStaged;
    const list = this.root.querySelector('#pdf-overlay-rebind-mapping-list');
    const reevaluate = this.root.querySelector('#pdf-overlay-rebind-reevaluate');
    const commit = this.root.querySelector('#pdf-overlay-rebind-commit');
    const entries =
      staged.phase === 'story'
        ? staged.plan.mappings
        : staged.plan.viewPlans.flatMap((viewPlan) =>
            viewPlan.mappings.map((mapping) => ({ ...mapping, drawingId: viewPlan.drawingId })),
          );
    const byEntity = new Map();
    for (const entry of entries) {
      const prior = byEntity.get(entry.entityId);
      if (!prior || (prior.status === 'resolved' && entry.status !== 'resolved'))
        byEntity.set(entry.entityId, entry);
    }
    for (const mapping of byEntity.values()) {
      const item = this.root.ownerDocument.createElement('li');
      const from = mapping.fromSourceRef;
      const prefix = `[${mapping.drawingId}] ${mapping.entityId}: ${from.elementType} #${from.elementId}`;
      if (mapping.status === 'resolved') {
        item.textContent = mapping.toSourceRef
          ? `${prefix} → #${mapping.toSourceRef.elementId} / ${mapping.method}`
          : `${prefix} → 孤児化（作図意図保持）`;
        if (!mapping.toSourceRef) item.append(this.createRebindOrphanUndoButton(mapping.entityId));
      } else {
        const label = this.root.ownerDocument.createElement('span');
        label.textContent = `${prefix} / ${mapping.reason} `;
        const select = this.root.ownerDocument.createElement('select');
        select.className = 'form-control';
        select.dataset.rebindEntityId = mapping.entityId;
        const blank = this.root.ownerDocument.createElement('option');
        blank.value = '';
        blank.textContent = '対応先を選択…';
        select.append(blank);
        if (from.elementType !== 'Story') {
          const orphan = this.root.ownerDocument.createElement('option');
          orphan.value = ORPHAN_OPTION_VALUE;
          orphan.textContent = '対応先なし（孤児として保持）';
          select.append(orphan);
        }
        const records = new Map();
        for (const result of Object.values(staged.importedById)) {
          for (const candidate of this.rebindCandidateRecords(
            result.drawing,
            from.elementType,
            staged.inspection.storyCandidates,
          ))
            records.set(JSON.stringify(candidate.sourceRef), candidate);
        }
        for (const candidate of this.rebindCandidateRecords(
          null,
          from.elementType,
          staged.inspection.storyCandidates,
        ))
          records.set(JSON.stringify(candidate.sourceRef), candidate);
        for (const candidate of records.values()) {
          const option = this.root.ownerDocument.createElement('option');
          option.value = JSON.stringify(candidate.sourceRef);
          option.textContent = candidate.label;
          select.append(option);
        }
        const approved = this.rebindApprovals.get(mapping.entityId);
        if (approved)
          select.value = approved.orphan ? ORPHAN_OPTION_VALUE : JSON.stringify(approved);
        select.addEventListener('change', () => {
          this.rebindAbortController?.abort();
          this.rebindAbortController = null;
          if (!select.value) this.rebindApprovals.delete(mapping.entityId);
          else if (select.value === ORPHAN_OPTION_VALUE)
            this.rebindApprovals.set(mapping.entityId, { orphan: true });
          else this.rebindApprovals.set(mapping.entityId, JSON.parse(select.value));
          if (reevaluate) reevaluate.disabled = this.rebindApprovals.size === 0;
          if (commit) commit.disabled = true;
          const preparedZip = this.root.querySelector('#pdf-overlay-rebind-export-prepared-zip');
          if (preparedZip) preparedZip.disabled = true;
          this.setDrawingProjectRebindStatus(
            '対応先を変更しました。新改訂ZIPの保存前に「選択対応で再評価」を実行してください。',
          );
        });
        item.append(label, select);
      }
      list?.append(item);
    }
    for (const entry of staged.plan.unresolved || []) {
      if (!entry.code) continue;
      const item = this.root.ownerDocument.createElement('li');
      item.textContent = `⚠ ${entry.drawingId || entry.drawingIds?.join('/') || '共有'}: ${entry.entityId} / ${entry.code}`;
      if (entry.toSourceRef?.elementType && entry.toSourceRef.elementType !== 'Story')
        item.append(this.createRebindOrphanButton(entry.entityId));
      list?.append(item);
    }
    this.setDrawingProjectRebindStatus(
      `${staged.imported.filename || 'STB'} / ${staged.plan.status === 'ready' ? '対応確認済（未適用ZIP保存可能）' : '要対応'} / ${Object.keys(staged.importedById).length}ビュー読込 / 未解決 ${staged.plan.unresolved.length}件。保存済みビュー定義を使用（未保存の画面編集は含めません）。`,
    );
    if (reevaluate)
      reevaluate.disabled = staged.plan.status === 'ready' || this.rebindApprovals.size === 0;
    // A ready stage alone is insufficient: only a user-confirmed, live
    // Document Control registration may invoke the SHA-verified model loader.
    const canCommit =
      staged.phase === 'slot' &&
      staged.plan.status === 'ready' &&
      !this.slotModelLoadInProgress &&
      !this.rebindAbortController &&
      Boolean(this.getOpenDrawingProjectDescriptor?.()) &&
      typeof globalThis.window?.handleCompareModelsClick === 'function';
    if (commit) {
      commit.disabled = !canCommit;
      commit.textContent = '新STB-Aを読込・全ビュー改訂確定';
      commit.title = canCommit
        ? '検証済みのSTB-A原本を正式モデル読込経路で読み込み、全登録ビューを一括確定します。保存は別操作です。'
        : '全登録ビューの対応確認、開いているDrawingProject、正式3Dローダーが必要です。';
    }
    const preparedZip = this.root.querySelector('#pdf-overlay-rebind-export-prepared-zip');
    if (preparedZip)
      preparedZip.disabled = staged.phase !== 'slot' || staged.plan.status !== 'ready';
  }

  async stageDrawingProjectReplacement(file) {
    if (!file) return;
    if (!isStbRevisionFile(file)) throw new TypeError('STB/XMLファイルを選択してください。');
    if (!this.loadedDrawingProject)
      throw new Error('先にDrawing Workspace JSONを読み込んでください。');
    const currentDrawing = this.panel.drawing;
    if (!currentDrawing)
      throw new Error('現在の図面を生成してからSTB改訂差替えを開始してください。');

    // 別STBのstagingを開始した時点で旧ready planを破棄する。
    // 以後のsnapshot/parseが失敗しても旧revisionのplanを再利用できる状態へ戻さない。
    this.clearDrawingProjectReplacement({
      status: '新STBを解析して改訂対応を確認しています…',
    });

    // Multiple registered views own their persisted metadata; do not flatten them
    // through the legacy single-plan workspace snapshot editor.
    const persisted = this.loadedDrawingProject;
    if (persisted.drawingDocuments.length > 1) {
      const selected = resolveCurrentSheetDrawingDocument(
        persisted,
        currentDrawing,
        this.panel.selectedCadDrawingView?.(),
        this.activeDrawingDocumentId,
      );
      if (
        persisted.drawingDocuments.filter((item) => item.modelSlotId === selected.modelSlotId)
          .length > 1
      )
        return this.stageDrawingProjectSlotReplacement(file, { selected });
    }

    // runtimeで編集したタグ配置・レビュー・注記等を、差替え元の作図意図として先にsnapshotする。
    // 単一 slot・図面の履歴を保持して現在改訂の runtime 編集を統合する。
    const sourceProject = this.createDrawingProjectSnapshot();
    const document = this.drawingProjectDocumentForCurrent(sourceProject);
    // A one-view commit would advance the shared modelSlot and strand sibling
    // DrawingDocuments on an older revision. Keep the legacy UI fail-closed until
    // the slot-wide staging/review UI is wired to the atomic #650 API.
    if (
      sourceProject.drawingDocuments.some(
        (item) => item.modelSlotId === document.modelSlotId && item.id !== document.id,
      )
    )
      throw new Error(
        '複数登録ビューのSTB改訂は一括確定が必要です。複数ビュー対応UIは準備中です。',
      );
    this.panel.services = this.panel.services || this.panel.getServices?.();
    const services = this.panel.services;
    if (typeof services?.createDrawingFromStbFile !== 'function')
      throw new Error('STB改訂差替えサービスが初期化されていません。');
    const abortController = new globalThis.AbortController();
    this.rebindAbortController = abortController;
    this.renderDrawingProjectRebindPlan();
    let imported;
    try {
      if (document.view.storyBinding) {
        if (typeof services.inspectStbRevisionFile !== 'function')
          throw new Error(
            'Story semantic bindingを持つDrawingProjectの改訂差替えには、STB階候補の事前検査が必要です。',
          );
        const inspection = await services.inspectStbRevisionFile({
          file,
          signal: abortController.signal,
        });
        if (abortController.signal.aborted || this.rebindAbortController !== abortController)
          return;
        const storyPlan = planDrawingProjectStoryRevisionRebind({
          project: sourceProject,
          drawingId: document.id,
          storyCandidates: inspection.storyCandidates,
          approvedMappings: [],
        });
        if (storyPlan.status !== 'ready') {
          imported = {
            ...inspection,
            drawing: null,
            tagFactsResolver: null,
          };
          this.rebindApprovals = new Map();
          this.rebindStaged = { file, imported, plan: storyPlan };
          this.rebindAbortController = null;
          this.renderDrawingProjectRebindPlan();
          showInfo('対象階の対応を確認してください。');
          return;
        }
        const storyTarget = storyPlan.mappings[0].toSourceRef;
        imported = await services.createDrawingFromStbFile({
          file,
          modelKey: currentDrawing.source.modelKey,
          storyId: storyTarget.elementId,
          signal: abortController.signal,
          expectedRevisionSha256: inspection.revision.sha256,
        });
      } else {
        imported = await services.createDrawingFromStbFile({
          file,
          modelKey: currentDrawing.source.modelKey,
          storyId: document.view.storyId,
          signal: abortController.signal,
        });
      }
    } catch (error) {
      if (abortController.signal.aborted || this.rebindAbortController !== abortController) return;
      this.rebindAbortController = null;
      this.renderDrawingProjectRebindPlan();
      throw error;
    }
    if (abortController.signal.aborted || this.rebindAbortController !== abortController) return;
    this.rebindAbortController = null;
    const plan = planDrawingProjectDrawingRevisionRebind({
      project: sourceProject,
      drawingId: document.id,
      newRevision: imported.revision,
      drawingModel: imported.drawing,
      approvedMappings: [],
    });
    this.rebindApprovals = new Map();
    this.rebindStaged = { file, imported, plan };
    this.renderDrawingProjectRebindPlan();
    showInfo(
      plan.status === 'ready'
        ? '新STBの対応を確認しました。改訂を確定できます。'
        : `未解決の対応が${plan.unresolved.length}件あります。対応先を選択して再評価してください。`,
    );
  }

  reevaluateDrawingProjectReplacement() {
    if (!this.rebindStaged || !this.loadedDrawingProject)
      throw new Error('先に新STBをstagingしてください。');
    if (this.rebindStaged.slotMode)
      return this.stageDrawingProjectSlotReplacement(this.rebindStaged.file, {
        selectedId: this.rebindStaged.selectedDrawingId,
      });
    if (!this.rebindStaged.imported?.drawing)
      return this.materializeDrawingProjectReplacementStory();
    const sourceProject = this.createDrawingProjectSnapshot();
    const document = this.drawingProjectDocumentForCurrent(sourceProject);
    const storyPlan = this.currentReplacementStoryPlan(sourceProject, document);
    if (storyPlan && storyPlan.status !== 'ready') {
      this.rebindStaged = {
        ...this.rebindStaged,
        imported: { ...this.rebindStaged.imported, drawing: null },
        plan: storyPlan,
      };
      this.renderDrawingProjectRebindPlan();
      return storyPlan;
    }
    const plan = planDrawingProjectDrawingRevisionRebind({
      project: sourceProject,
      drawingId: document.id,
      newRevision: this.rebindStaged.imported.revision,
      drawingModel: this.rebindStaged.imported.drawing,
      approvedMappings: this.approvedMappingsForRebind(),
      orphanedEntityIds: this.orphanedEntityIdsForRebind(),
    });
    this.rebindStaged = { ...this.rebindStaged, plan };
    this.renderDrawingProjectRebindPlan();
  }

  currentReplacementStoryPlan(project, document, staged = this.rebindStaged) {
    if (!document.view.storyBinding) return null;
    return planDrawingProjectStoryRevisionRebind({
      project,
      drawingId: document.id,
      storyCandidates: staged.imported.storyCandidates || [],
      approvedMappings: this.approvedMappingsForRebind().filter(
        (mapping) => mapping.entityId === document.view.storyBinding.entityId,
      ),
    });
  }

  async materializeDrawingProjectReplacementStory() {
    const staged = this.rebindStaged;
    if (!staged || !this.loadedDrawingProject || staged.imported?.drawing)
      throw new Error('対象階の再評価対象がありません。');
    const sourceProject = this.createDrawingProjectSnapshot();
    const document = this.drawingProjectDocumentForCurrent(sourceProject);
    const storyPlan = this.currentReplacementStoryPlan(sourceProject, document, staged);
    if (storyPlan.status !== 'ready') {
      this.rebindStaged = { ...staged, plan: storyPlan };
      this.renderDrawingProjectRebindPlan();
      return storyPlan;
    }

    this.panel.services = this.panel.services || this.panel.getServices?.();
    const services = this.panel.services;
    if (typeof services?.createDrawingFromStbFile !== 'function')
      throw new Error('STB改訂差替えサービスが初期化されていません。');
    const abortController = new globalThis.AbortController();
    this.rebindAbortController = abortController;
    const storyTarget = storyPlan.mappings[0].toSourceRef;
    let importedDrawing;
    try {
      importedDrawing = await services.createDrawingFromStbFile({
        file: staged.file,
        modelKey: this.panel.drawing.source.modelKey,
        storyId: storyTarget.elementId,
        signal: abortController.signal,
        expectedRevisionSha256: staged.imported.revision.sha256,
      });
    } catch (error) {
      if (abortController.signal.aborted || this.rebindAbortController !== abortController) return;
      this.rebindAbortController = null;
      throw error;
    }
    if (abortController.signal.aborted || this.rebindAbortController !== abortController) return;
    this.rebindAbortController = null;
    const currentStoryPlan = this.currentReplacementStoryPlan(sourceProject, document, staged);
    if (
      currentStoryPlan.status !== 'ready' ||
      currentStoryPlan.mappings[0].toSourceRef.elementId !== storyTarget.elementId
    ) {
      this.rebindStaged = {
        ...staged,
        plan: currentStoryPlan.status === 'ready' ? staged.plan : currentStoryPlan,
      };
      this.renderDrawingProjectRebindPlan();
      return this.rebindStaged.plan;
    }
    const imported = {
      ...staged.imported,
      ...importedDrawing,
      storyCandidates: importedDrawing.storyCandidates || staged.imported.storyCandidates || [],
    };
    const plan = planDrawingProjectDrawingRevisionRebind({
      project: sourceProject,
      drawingId: document.id,
      newRevision: imported.revision,
      drawingModel: imported.drawing,
      approvedMappings: this.approvedMappingsForRebind(),
      orphanedEntityIds: this.orphanedEntityIdsForRebind(),
    });
    this.rebindStaged = { ...staged, imported, plan };
    this.renderDrawingProjectRebindPlan();
    return plan;
  }

  commitDrawingProjectReplacement({ download = true } = {}) {
    const staged = this.rebindStaged;
    if (!staged || !this.loadedDrawingProject)
      throw new Error('確定できるSTB改訂差替えがありません。');
    if (staged.slotMode) return this.commitDrawingProjectSlotReplacement({ download });
    if (staged.plan.status !== 'ready')
      throw new Error('未解決の対応が残っているためSTB改訂を確定できません。');

    // staging後にruntime作図意図が変わっていても古いproject snapshotへ巻き戻さない。
    // current workspaceからplanを再評価し、未解決が生じた場合はcommitせずreview UIへ戻す。
    const sourceProject = this.createDrawingProjectSnapshot();
    const sourceDocument = this.drawingProjectDocumentForCurrent(sourceProject);
    // Guard commit independently of staging, since an existing plan can outlive
    // a DrawingProject/view edit. Never publish a partially upgraded modelSlot.
    if (
      sourceProject.drawingDocuments.some(
        (item) => item.modelSlotId === sourceDocument.modelSlotId && item.id !== sourceDocument.id,
      )
    )
      throw new Error(
        '複数登録ビューのSTB改訂は一括確定が必要です。複数ビュー対応UIは準備中です。',
      );
    const storyPlan = this.currentReplacementStoryPlan(sourceProject, sourceDocument, staged);
    if (storyPlan && storyPlan.status !== 'ready') {
      this.rebindStaged = {
        ...staged,
        imported: { ...staged.imported, drawing: null },
        plan: storyPlan,
      };
      this.renderDrawingProjectRebindPlan();
      throw new Error('対象階の対応が未解決です。対応先を再確認してください。');
    }
    const currentPlan = planDrawingProjectDrawingRevisionRebind({
      project: sourceProject,
      drawingId: sourceDocument.id,
      newRevision: staged.imported.revision,
      drawingModel: staged.imported.drawing,
      approvedMappings: this.approvedMappingsForRebind(),
      orphanedEntityIds: this.orphanedEntityIdsForRebind(),
    });
    if (currentPlan.status !== 'ready') {
      this.rebindStaged = { ...staged, plan: currentPlan };
      this.renderDrawingProjectRebindPlan();
      throw new Error(
        'staging後の作図意図変更により未解決の対応が発生しました。対応先を再確認してください。',
      );
    }

    const committed = commitDrawingProjectDrawingRevisionRebind({
      project: sourceProject,
      plan: currentPlan,
    });
    const document = committed.drawingDocuments.find((item) => item.id === currentPlan.drawingId);
    if (!document) throw new Error('確定後のDrawingDocumentがありません。');
    const restored = restoreDrawingWorkspaceReviewState({
      project: committed,
      drawingId: document.id,
      drawingModel: staged.imported.drawing,
    });
    // 孤児として保持を承認したtagは、新改訂では描画せず作図意図だけ残す。
    const inactiveTags = restored.tagStatuses.filter(
      (item) => !item.active && item.invalidationCode !== 'BINDING_ORPHANED',
    );
    if (inactiveTags.length) {
      const detail = inactiveTags
        .slice(0, 5)
        .map((item) => `${item.id}:${item.invalidationCode}`)
        .join(', ');
      throw new Error(
        `新STBへタグ配置を復元できない項目があります: ${detail}${inactiveTags.length > 5 ? ' …' : ''}`,
      );
    }

    return this.publishDrawingProjectCommittedRevision({
      staged,
      sourceDocument,
      document,
      restored,
      committed,
      download,
    });
  }

  /**
   * Publish no state until every saved view has passed the project-native
   * tag/dimension/annotation preflight. The final runtime view is the originally
   * selected one; other registered views remain in persisted metadata.
   */
  prepareDrawingProjectSlotReplacement() {
    const staged = this.rebindStaged;
    if (!staged?.slotMode || staged.phase !== 'slot' || staged.plan.status !== 'ready')
      throw new Error('一括確定できる複数ビューSTB改訂がありません。');
    if (staged.approvalSignature !== drawingProjectSlotApprovalsFingerprint(this.rebindApprovals))
      throw new Error('対応先の承認内容がstaging後に変更されました。再評価してください。');
    const project = this.loadedDrawingProject;
    if (serializeDrawingProject(project) !== staged.sourceProjectSnapshot)
      throw new Error('staging後に登録ビューや図面が変更されました。STB改訂を再検証してください。');
    const selected = resolveCurrentSheetDrawingDocument(
      project,
      this.panel.drawing,
      this.panel.selectedCadDrawingView?.(),
      staged.selectedDrawingId,
    );
    if (selected.id !== staged.selectedDrawingId || selected.modelSlotId !== staged.modelSlotId)
      throw new Error('STB差替え対象の現在ビューが変更されています。');
    const drawings = Object.fromEntries(
      Object.entries(staged.importedById).map(([id, result]) => [id, result.drawing]),
    );
    const plan = planDrawingProjectSlotRevisionRebind({
      project,
      modelSlotId: selected.modelSlotId,
      newRevision: staged.inspection.revision,
      drawingModelsById: drawings,
      approvedMappings: this.approvedMappingsForRebind(),
      orphanedEntityIds: this.orphanedEntityIdsForRebind(),
    });
    if (plan.status !== 'ready') {
      this.rebindStaged = { ...staged, plan };
      this.renderDrawingProjectRebindPlan();
      throw new Error('再評価で未解決の対応が見つかりました。全ビューの対応を確認してください。');
    }
    const committed = commitDrawingProjectSlotRevisionRebind({ project, plan });
    let active = null;
    for (const viewPlan of plan.viewPlans) {
      const drawingId = viewPlan.drawingId;
      const imported = staged.importedById[drawingId];
      if (!imported?.drawing) throw new Error('staging済みDrawingModelがありません: ' + drawingId);
      const preflight = stageDrawingProjectArchiveWorkspace({
        plan: { project: committed, drawingId },
        drawing: imported.drawing,
        tagFactsResolver: imported.tagFactsResolver,
      });
      if (preflight.restored) {
        const inactive = preflight.restored.tagStatuses.filter(
          (item) => !item.active && item.invalidationCode !== 'BINDING_ORPHANED',
        );
        if (inactive.length) throw new Error('新STBでタグ配置を復元できません: ' + drawingId);
      }
      if (drawingId === staged.selectedDrawingId)
        active = { document: preflight.document, restored: preflight.restored, imported };
    }
    if (!active?.restored) throw new Error('改訂後の現在ビューの復元情報がありません。');
    return { staged, project, selected, committed, active };
  }

  /**
   * A semantic rebind mapping may be edited while an async SHA-256 check or ZIP
   * export is running. Snapshot approvals, selected view and model source as
   * well as the DrawingProject: never publish a superseded approval.
   */
  drawingProjectSlotWorkspaceSignature() {
    return drawingProjectSlotWorkspaceFingerprint({
      memberReviews: this.memberReviews,
      drawingMemos: this.drawingMemos,
      tagPlacements: this.tagPlacements,
      tagFamilyState: this.tagFamilyState,
      drawingMemoIdentity: this.drawingMemoIdentity,
    });
  }

  createDrawingProjectSlotStageLease({ allowProvisionalModelDocument = false } = {}) {
    return captureDrawingProjectSlotStageLease(
      () => ({
        staged: this.rebindStaged,
        stagePlan: this.rebindStaged?.plan,
        stagePlanStatus: this.rebindStaged?.plan?.status,
        sourceFile: this.rebindStaged?.file,
        project: this.loadedDrawingProject,
        serializedProject: serializeDrawingProject(this.loadedDrawingProject),
        drawing: this.panel?.drawing,
        modelDocument: getState('models.documentA'),
        activeDrawingDocumentId: this.activeDrawingDocumentId,
        selectedViewKey: this.panel?.selectedCadDrawingView?.()?.key ?? null,
        workspaceSignature: this.drawingProjectSlotWorkspaceSignature(),
        approvals: this.rebindApprovals,
      }),
      { allowProvisionalModelDocument },
    );
  }

  /**
   * Construct an explicit, one-shot model-load handoff for a reviewed slot.
   * The normal compare button still uses the fail-closed drawing guard.
   */
  createDrawingProjectSlotModelLoadHandoff() {
    return createDrawingProjectSlotModelLoadHandoff({
      session: this,
      readSelectedFiles: () => ({
        fileA: globalThis.document?.getElementById?.('fileA')?.files?.[0] ?? null,
        fileB: globalThis.document?.getElementById?.('fileB')?.files?.[0] ?? null,
      }),
    });
  }

  /**
   * Prepare a cryptographic proof for the formal model loader's candidate
   * document, before any provisional reset of models.documentA or the 3D scene.
   * This does not authorize the ordinary compareModels() UI path to bypass its
   * registered DrawingProject guard.
   */
  async prepareDrawingProjectSlotCandidateProof({ file, candidateDocument, getSelectedFile } = {}) {
    const staged = this.rebindStaged;
    const isStageCurrent = this.createDrawingProjectSlotStageLease();
    return prepareDrawingProjectSlotModelSourceProof({
      staged,
      file,
      candidateDocument,
      getCurrentStage: () => this.rebindStaged,
      getSelectedFile,
      getCurrentOriginalFile: () => getState('files.originalFileA'),
      isStageCurrent,
    });
  }

  /**
   * Metadata-only, reversible participant for a coordinated STB model load.
   * The caller must finish raw-source verification before the loader transaction
   * and separately resynchronize Document Control and CAD rendering after commit.
   * This does not authorize bypassing the normal model reload guard.
   */
  createDrawingProjectSlotModelPublicationParticipant({
    verifyPublishedModelSource,
    prepared = null,
  } = {}) {
    // The ordinary archive/export lease intentionally includes the old DOM.
    // For a coordinated model load, models.documentA is already provisional
    // when the drawingParticipant.publish() runs. Only this verified path may
    // omit that single field; every other staged input is still protected.
    if (typeof verifyPublishedModelSource !== 'function')
      throw new TypeError('正式STB-A原本SHA証明がないため一体公開できません。');
    if (
      prepared &&
      (prepared.staged !== this.rebindStaged ||
        prepared.project !== this.loadedDrawingProject ||
        prepared.selected?.modelSlotId !== this.rebindStaged?.modelSlotId)
    )
      throw new Error('改訂候補とDrawingProjectの事前検証状態が一致しません。');
    const publicationPrepared = prepared || this.prepareDrawingProjectSlotReplacement();
    const assertCurrent = this.createDrawingProjectSlotStageLease({
      allowProvisionalModelDocument: true,
    });
    return createDrawingProjectSlotPublicationParticipant({
      session: this,
      prepared: publicationPrepared,
      assertCurrent,
      verifyPublishedModelSource,
      // Capture BEFORE clearLoadedModels replaces files.originalFileA. An
      // unarchived source revision must remain recoverable after 3D commit.
      previousOriginalFileA: getState('files.originalFileA'),
    });
  }

  /**
   * Called once after the formal model commit reports a verified Document
   * Control rebind. All UI restoration happens beyond the rollback boundary.
   */
  /** Refresh tag-family controls without mutating DrawingProject registration. */
  refreshPublishedTagFamilyUi() {
    refreshPdfDrawingTagFamilyOptions(this.tagFamilyState, globalThis.document);
    this.tagFamilyUi?.refresh();
  }

  synchronizeDrawingProjectSlotAfterModelPublication({ prepared } = {}) {
    return synchronizeDrawingProjectSlotAfterModelLoad({ session: this, prepared });
  }

  /**
   * #650: explicit and non-reentrant user action for the formal STB-A loader.
   * A canceled preflight leaves the old model, DrawingProject and review intact.
   * After irreversible model publication, failure must not be reported as a
   * successful rollback of the 3D scene.
   */
  async commitDrawingProjectSlotFromUser(event) {
    if (!event?.isTrusted || this.slotModelLoadInProgress) return false;
    if (
      !this.rebindStaged?.slotMode ||
      this.rebindStaged.phase !== 'slot' ||
      this.rebindStaged.plan?.status !== 'ready' ||
      this.rebindAbortController
    )
      throw new Error('全登録ビューの改訂対応を再評価してください。');
    const loadModel = globalThis.window?.handleCompareModelsClick;
    if (typeof loadModel !== 'function')
      throw new Error('正式STB-Aモデル読込サービスが初期化されていません。');
    const confirm = globalThis.window?.confirm;
    if (typeof confirm !== 'function')
      throw new Error('STB-A一括改訂の実行確認サービスがありません。');
    const viewCount = Object.keys(this.rebindStaged.importedById || {}).length;
    if (
      !confirm.call(
        globalThis.window,
        `検証済みの新STB-Aへ切り替え、同じモデル枠の${viewCount}ビューを一括改訂します。3Dモデルは変更され、旧改訂に戻せない場合があります。開始前に現在のプロジェクトZIP/JSONを保存しましたか？改訂後のZIP/JSONも別途保存してください。続行しますか？`,
      )
    )
      return false;

    // Pin the exact file, reviewed mappings and source descriptor before any
    // asynchronous model work; never bypass the ordinary Compare button guard.
    const handoff = this.createDrawingProjectSlotModelLoadHandoff();
    const oldModelDocument = getState('models.documentA');
    this.slotModelLoadInProgress = true;
    const button = this.root.querySelector('#pdf-overlay-rebind-commit');
    if (button) button.disabled = true;
    this.setDrawingProjectRebindStatus(
      '正式STB-Aローダーでモデルと全登録ビューを一体確定しています…',
    );
    try {
      const success = await loadModel.call(globalThis.window, {
        requireCompleteRendering: true,
        drawingProjectLoadHandoff: handoff,
      });
      if (success !== true) {
        const modelPublished = getState('models.documentA') !== oldModelDocument;
        this.setDrawingProjectRebindStatus(
          modelPublished
            ? '新STB-Aは公開済みですが図面の一括確定に失敗しました。登録状態を確認し、ZIP/JSONから再検証してください。'
            : '一括改訂は中止されました。旧モデルと図面を維持しています。対応とSTB原本を確認してください。',
        );
        return false;
      }
      showSuccess(
        'STB-Aと全登録ビューを一括改訂しました。新しいプロジェクトZIP/JSONを保存してください。',
      );
      return true;
    } catch (error) {
      const modelPublished = getState('models.documentA') !== oldModelDocument;
      this.setDrawingProjectRebindStatus(
        modelPublished
          ? '新STB-Aは公開済みですが図面の一括確定後に問題が発生しました。登録状態を確認し、ZIP/JSONから再検証してください。'
          : `旧STB-Aと図面は維持されています。一括改訂を再検証してください: ${error.message}`,
      );
      throw error;
    } finally {
      this.slotModelLoadInProgress = false;
      if (button) {
        // A rollback may retain a valid reviewed stage. An irreversible
        // failure has no valid old descriptor and must not enable a retry.
        button.disabled =
          !this.rebindStaged?.slotMode ||
          this.rebindStaged.phase !== 'slot' ||
          this.rebindStaged.plan?.status !== 'ready' ||
          !this.getOpenDrawingProjectDescriptor?.();
      }
    }
  }

  async commitDrawingProjectSlotReplacement({ download = true } = {}) {
    const { staged, selected, committed, active } = this.prepareDrawingProjectSlotReplacement();
    // The isolated STB importer does not install models.documentA. Never publish
    // the new DrawingModel while runtime documentA still contains the old STB.
    const services = this.panel.services || this.panel.getServices?.();
    if (typeof services?.assertDrawingSourceCurrent !== 'function')
      throw new Error('新改訂のSTB-A原本確認サービスがありません。');
    const stageStillCurrent = this.createDrawingProjectSlotStageLease();
    const originalSha256 = staged.inspection?.revision?.originalSha256;
    if (!originalSha256)
      throw new Error('新STB改訂の原本SHA-256がありません。直接確定できません。');
    await assertDrawingProjectSlotRuntimeCurrent({
      source: active.imported.drawing.source,
      getCurrentDocument: () => getState('models.documentA'),
      getCurrentOriginalFile: () => getState('files.originalFileA'),
      expectedOriginalSha256: originalSha256,
      assertDrawingSourceCurrent: (args) => services.assertDrawingSourceCurrent(args),
      isStageCurrent: stageStillCurrent,
    });
    const imported = { ...active.imported, filename: staged.imported.filename };
    return this.publishDrawingProjectCommittedRevision({
      staged: { ...staged, imported },
      sourceDocument: selected,
      document: active.document,
      restored: active.restored,
      committed,
      download,
    });
  }

  publishDrawingProjectCommittedRevision({
    staged,
    sourceDocument,
    document,
    restored,
    committed,
    download,
  }) {
    // Revoke before the first mutable UI state change or synchronous event callback.
    // The replacement is fully validated above; no old revision may remain authorized.
    this.closeOpenDrawingProject();
    this.panel.measurementUi?.invalidateDrawing();
    this.panel.drawing = staged.imported.drawing;
    if (staged.slotMode) this.activeDrawingDocumentId = document.id;
    this.panel.tagFactsResolver = staged.imported.tagFactsResolver || null;
    this.panel.sheetLayout = null;
    this.panel.sheetRenderPlan = null;
    this.loadedDrawingProject = committed;
    this.archiveSourceRevisions = this.archiveSourceRevisions.filter(
      (item) =>
        !(
          item.modelSlotId === sourceDocument.modelSlotId &&
          item.sourceRevisionId === staged.imported.revision.id
        ),
    );
    this.archiveSourceRevisions.push({
      modelSlotId: sourceDocument.modelSlotId,
      sourceRevisionId: staged.imported.revision.id,
      bytes: staged.file,
    });
    this.archiveExportSequence++;

    this.drawingProjectId = committed.projectId;
    this.setTagFamilyState(restored.tagFamilyState, { render: false });
    this.memberReviews = restored.memberReviews;
    this.drawingMemos = restored.drawingMemos;
    this.drawingMemoIdentity = null;
    this.tagPlacements = restored.tagPlacements;
    this.applyDrawingProjectDisplaySettings(restored.display);
    this.panel.setScaleDenominator(restored.sheet.scaleDenominator);
    this.panel.setDrawingRotationDeg(restored.sheet.rotationDeg, {
      invalidatePlacement: false,
      render: false,
      notify: false,
    });
    this.panel.setTagOrientationMode(restored.sheet.tagOrientationMode, { render: false });
    this.panel.clearSelection?.();
    this.panel.resetPlacementState?.('STB改訂差替え: PDF配置未設定', 'STB_CHANGED');
    this.panel.clearAnchorInputs?.('model');
    this.panel.regionUi?.invalidateDrawing?.();
    this.panel.alignmentCandidates = [];
    this.panel.gizmoOrigin = null;
    this.renderDrawingMemoList();
    this.refreshSelectedTagControls();
    this.panel.renderOverlay();
    this.panel.updatePdfFeatureAvailability();
    this.panel.renderDiagnostics?.();

    const shortRevision = staged.imported.revision.sha256.slice(0, 12);
    if (download) {
      const json = serializeDrawingProject(committed);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const date = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `drawing-workspace-${date}-${shortRevision}.json`);
    }

    this.clearDrawingProjectReplacement({
      status: `STB改訂を確定しました / ${document.view.storyId} / revision ${shortRevision}… / ${download ? '更新DrawingProject JSONを保存しました。' : ''}旧レビュー状態は履歴として保持し、新改訂へ自動継承していません。`,
    });
    this.renderOrphanedIntentList();
    this.openDrawingProject(committed);
    this.setDrawingProjectStatus(
      `改訂済み / ${document.view.storyId} / revision ${shortRevision}… / 履歴を保持`,
    );
    showSuccess(
      download
        ? 'STB改訂を確定し、更新DrawingProject JSONを保存しました。'
        : 'STB改訂を確定しました。',
    );
    return committed;
  }

  assertLoadedDrawingProjectRewriteSafe() {
    if (!this.loadedDrawingProject) return;
    assertDrawingProjectWorkspaceEditSafe(this.loadedDrawingProject);
    this.drawingProjectDocumentForCurrent(this.loadedDrawingProject);
  }

  createDrawingProjectSnapshot() {
    const drawing = this.panel.drawing;
    if (!drawing) throw new Error('図面を先に生成してください。');
    this.assertLoadedDrawingProjectRewriteSafe();
    this.drawingProjectId ||= runtimeProjectId();

    let modelSlotId = 'structure';
    let drawingId = null;
    let sourceRevisionId = null;
    let sourceSha256 = null;
    let entityIdForIdentity = undefined;
    if (this.loadedDrawingProject) {
      const loadedDocument = this.drawingProjectDocumentForCurrent(this.loadedDrawingProject);
      const loadedSlot = this.loadedDrawingProject.modelSlots.find(
        (item) => item.id === loadedDocument.modelSlotId,
      );
      const loadedRevision = loadedSlot?.revisions.find(
        (item) => item.id === loadedDocument.sourceRevisionId,
      );
      const entityIdsByIdentity = new Map();
      for (const binding of this.loadedDrawingProject.bindings) {
        if (binding.modelSlotId !== loadedDocument.modelSlotId) continue;
        const revision = binding.revisions.find(
          (item) => item.sourceRevisionId === loadedDocument.sourceRevisionId,
        );
        // 孤児化済みentityは現行改訂に対応部材がないため、identityからは引かない。
        if (!revision?.sourceRef) continue;
        entityIdsByIdentity.set(
          identityKey([
            drawing.source.modelKey,
            revision.sourceRef.elementType,
            revision.sourceRef.elementId,
          ]),
          binding.entityId,
        );
      }
      modelSlotId = loadedDocument.modelSlotId;
      drawingId = loadedDocument.id;
      sourceRevisionId = loadedDocument.sourceRevisionId;
      sourceSha256 = loadedRevision?.sha256 || drawing.source.modelRevision;
      // Entities mapped to the current revision keep their ID. Others get a fresh ID
      // that cannot collide with any historical entity (e.g. review-only history).
      const reservedEntityIds = new Set(this.loadedDrawingProject.bindings.map((b) => b.entityId));
      const fallbackIds = new Map();
      entityIdForIdentity = (identity) => {
        const key = identityKey(identity);
        const mapped = entityIdsByIdentity.get(key);
        if (mapped) return mapped;
        if (!fallbackIds.has(key)) {
          const base = [
            'legacy',
            ...identity.map((value) => encodeURIComponent(String(value))),
          ].join(':');
          let id = base;
          for (let n = 1; reservedEntityIds.has(id); n++) id = `${base}:workspace:${n}`;
          reservedEntityIds.add(id);
          fallbackIds.set(key, id);
        }
        return fallbackIds.get(key);
      };
    }

    const result = createDrawingProjectFromWorkspaceState({
      drawing,
      projectId: this.drawingProjectId,
      modelSlotId,
      drawingId,
      sourceRevisionId,
      sourceSha256,
      scaleDenominator: this.panel.scaleDenominator(),
      drawingRotationDeg: this.panel.drawingRotationDeg,
      tagOrientationMode: this.panel.tagOrientationMode,
      displaySettings: this.panel.drawingDisplaySettings?.() || {},
      tagFamilyState: this.tagFamilyState,
      memberReviews: cloneRecords(this.memberReviews),
      drawingMemos: this.drawingMemos.map(stripDrawingMemoRuntimeState),
      tagPlacements: (this.tagPlacements || []).map(placementSnapshot),
      ...(entityIdForIdentity ? { entityIdForIdentity } : {}),
    });
    if (result.diagnostics.length) {
      const detail = result.diagnostics
        .map((item) => `${item.code}${item.count ? `(${item.count})` : ''}`)
        .join(', ');
      throw new Error(
        `DrawingProjectへ安全に保存できない項目があります: ${detail}。旧PDF座標メモはPDF照合セッションJSONで保持してください。`,
      );
    }
    return this.loadedDrawingProject
      ? mergeDrawingProjectWorkspaceSnapshot({
          project: this.loadedDrawingProject,
          snapshot: result.project,
        })
      : result.project;
  }

  /**
   * Export an already-normalized multi-view project without projecting it through
   * the single-plan workspace snapshot editor. Only persisted project metadata
   * is exported; runtime plan edits must be saved through a supported owner.
   */
  exportDrawingSheetProject() {
    const project = this.loadedDrawingProject;
    if (!project) throw new Error('DrawingProjectが開かれていません。');
    // Sheet JSON is a persisted layout artifact. It must not require an
    // active viewport DrawingModel or silently flatten multiple views.
    const json = serializeDrawingProject(project);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `drawing-sheets-${date}.json`);
    this.setDrawingProjectStatus(
      `シートメタデータを保存しました（ビュー ${project.drawingDocuments.length}件／シート ${project.drawingSheets?.length ?? 0}件）。未保存のworkspace編集は含みません。`,
    );
  }

  /** #565: sheets exist but no model slot or view has been registered yet. */
  hasPaperOnlyDrawingProject() {
    const project = this.loadedDrawingProject;
    return Boolean(project && !project.modelSlots?.length && !project.drawingDocuments?.length);
  }

  /**
   * A multi-view sheet project is the persisted metadata authority. Re-projecting
   * it through createDrawingProjectSnapshot() would flatten its documents and
   * discard the other saved views/sheets. Verify the explicitly selected current
   * document, then archive the existing project unchanged. As with sheet JSON
   * export, unsaved runtime workspace edits are deliberately not included.
   */
  createDrawingProjectArchiveSnapshot() {
    const project = this.loadedDrawingProject;
    // With no open drawing there is no unsaved workspace state to merge; the saved
    // project is the authority, so a sheet/view project is archived unchanged.
    if (project && (!this.panel.drawing || this.hasPaperOnlyDrawingProject())) return project;
    if (
      !project ||
      (project.drawingDocuments?.length === 1 &&
        project.drawingDocuments[0].view?.type === 'plan' &&
        !project.drawingDocuments[0].view.cutBoundsMm)
    )
      return this.createDrawingProjectSnapshot();
    resolveCurrentSheetDrawingDocument(
      project,
      this.panel.drawing,
      this.panel.selectedCadDrawingView?.(),
      this.activeDrawingDocumentId,
    );
    return project;
  }

  /** P2: refuse export when historical source revisions are missing or modified. */
  async exportDrawingProjectZip({
    projectOverride = null,
    extraSourceRevision = null,
    assertExportStageCurrent = null,
  } = {}) {
    const project = projectOverride || this.createDrawingProjectArchiveSnapshot();
    const serializedProject = serializeDrawingProject(project);
    const drawing = this.panel.drawing;
    const model = this.currentModelDocument();
    const sequence = ++this.archiveExportSequence;
    this.panel.services = this.panel.services || this.panel.getServices?.();
    const services = this.panel.services;
    if (typeof services?.inspectStbRevisionFile !== 'function')
      throw new Error('ZIP保存にはSTB原本の改訂検査サービスが必要です。');
    const sourceRevisions = await collectDrawingProjectArchiveSources({
      project,
      retainedSourceRevisions: [
        ...this.archiveSourceRevisions.filter(
          (item) =>
            !extraSourceRevision ||
            item.modelSlotId !== extraSourceRevision.modelSlotId ||
            item.sourceRevisionId !== extraSourceRevision.sourceRevisionId,
        ),
        ...(extraSourceRevision ? [extraSourceRevision] : []),
      ],
      originalFiles: [getState('files.originalFileA'), getState('files.originalFileB')],
      inspectOriginalStb: async ({ bytes }) => {
        const inspected = await services.inspectStbRevisionFile({
          file: new Blob([bytes], { type: 'application/xml' }),
        });
        return inspected.revision.sha256;
      },
    });
    const hashes = new Map(
      sourceRevisions.map((source) => [
        JSON.stringify([source.modelSlotId, source.sourceRevisionId]),
        source.originalSha256,
      ]),
    );
    const archiveProject = {
      ...project,
      modelSlots: project.modelSlots.map((slot) => ({
        ...slot,
        revisions: slot.revisions.map((revision) => {
          const originalSha256 = hashes.get(JSON.stringify([slot.id, revision.id]));
          if (!originalSha256) throw new Error('ZIP書出しに必要な原本ハッシュが不足しています。');
          return { ...revision, originalSha256 };
        }),
      })),
    };
    const persistedReferences = this.panel.referencePersistenceSnapshot?.() || [];
    if ((this.panel.referenceDrawings?.length || 0) !== persistedReferences.length)
      throw new Error('DXF参照原本が未保持の図形を含むためZIP保存できません。');
    const referenceAssets = await Promise.all(
      persistedReferences.map(async (record) => {
        const documentId = record.asset.source.documentId;
        const retained = this.panel.referenceAssets?.get(documentId);
        if (!retained?.file || typeof retained.file.arrayBuffer !== 'function')
          throw new Error('ZIP保存に必要なDXF参照原本がありません: ' + documentId);
        return {
          documentId,
          descriptor: record.asset,
          display: record.display,
          bytes: new Uint8Array(await retained.file.arrayBuffer()),
        };
      }),
    );
    // A chosen print font is not automatically redistributable. Require an
    // explicit confirmation before bundling the original TTF in a shared ZIP.
    const selectedFont =
      this.panel.e?.['pdf-overlay-vector-font']?.files?.[0] || this.archivedPdfFontFile || null;
    if (
      selectedFont &&
      globalThis.confirm?.(
        '指定したTTFフォント原本をZIPに同梱します。再配布のライセンスを確認し、同梱を許可しますか？',
      ) !== true
    )
      throw new Error('TTF原本の再配布確認が得られないためZIP保存を中止しました。');
    const fontAsset = selectedFont
      ? { name: selectedFont.name, bytes: new Uint8Array(await selectedFont.arrayBuffer()) }
      : null;
    const referenceSignature = JSON.stringify(persistedReferences);
    const zip = await createDrawingProjectArchive({
      project: archiveProject,
      sourceRevisions,
      referenceAssets,
      fontAsset,
    });
    if (
      sequence !== this.archiveExportSequence ||
      drawing !== this.panel.drawing ||
      model !== this.currentModelDocument() ||
      (projectOverride
        ? typeof assertExportStageCurrent !== 'function' || !assertExportStageCurrent()
        : serializedProject !==
          serializeDrawingProject(this.createDrawingProjectArchiveSnapshot())) ||
      referenceSignature !== JSON.stringify(this.panel.referencePersistenceSnapshot?.() || []) ||
      selectedFont !==
        (this.panel.e?.['pdf-overlay-vector-font']?.files?.[0] || this.archivedPdfFontFile || null)
    ) {
      throw new Error('ZIP作成中に図面またはプロジェクトが変更されました。再度保存してください。');
    }
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(
      new Blob([zip], { type: 'application/zip' }),
      (projectOverride ? 'drawing-revision-prepared-' : 'drawing-workspace-') + date + '.sdv.zip',
    );
    this.setDrawingProjectStatus(
      (projectOverride
        ? '未適用の改訂ZIP保存済み（現在のSTB-Aは変更していません） / '
        : 'ZIP保存済み / ') +
        'STB原本 ' +
        sourceRevisions.length +
        '改訂 / DXF参照 ' +
        referenceAssets.length +
        '件 / TTF ' +
        (fontAsset ? '同梱' : 'なし') +
        ' / SHA-256検証済み' +
        (project.drawingDocuments.length > 1
          ? ' / 複数シート保存済み（未保存のworkspace編集を除く）'
          : ''),
    );
    showSuccess(
      projectOverride
        ? '未適用の改訂済みDrawingProjectとSTB原本をZIPへ保存しました。現在のモデルは変更していません。'
        : 'STB原本とDrawingProjectをZIPへ保存しました。',
    );
  }

  /**
   * Export a fully validated slot rebind as a portable ZIP without touching the
   * global STB-A loader, selected drawing, runtime reviews or persisted project.
   */
  async exportPreparedDrawingProjectSlotZip() {
    const { staged, project, committed } = this.prepareDrawingProjectSlotReplacement();
    if (!staged.file || staged.modelSlotId == null || staged.inspection?.revision?.id == null)
      throw new Error('改訂ZIPに同梱する新STB原本がありません。');
    const serialized = serializeDrawingProject(project);
    const stageStillCurrent = this.createDrawingProjectSlotStageLease();
    return this.exportDrawingProjectZip({
      projectOverride: committed,
      extraSourceRevision: {
        modelSlotId: staged.modelSlotId,
        sourceRevisionId: staged.inspection.revision.id,
        bytes: staged.file,
      },
      assertExportStageCurrent: () =>
        stageStillCurrent() && serializeDrawingProject(project) === serialized,
    });
  }

  /** ZIP import: existing-model validation or verified empty-session STB cold-start. */
  async importDrawingProjectZip(file) {
    if (!file) return;
    // Every new selection, including a rejected oversized ZIP, must revoke
    // the previous import before asynchronous validation or decompression.
    const request = ++this.drawingImportSequence;
    // Separate from drawingImportSequence: normal model/drawing lifecycle events
    // legitimately increment that sequence during a successful cold-start.
    const coldStartEpoch = (this.zipColdStartEpoch || 0) + 1;
    this.zipColdStartEpoch = coldStartEpoch;
    if (typeof file.size === 'number' && file.size > 160 * 1024 * 1024)
      throw new Error('ZIPファイルが160MiBの制限を超えています。');
    const drawing = this.panel.drawing;
    const model = this.currentModelDocument();
    const sourceA = getState('models.documentA');
    const sourceB = getState('models.documentB');
    const editing = getState('models.editing');
    const editingSnapshot = {
      active: editing?.active,
      sessionId: editing?.sessionId,
      workingRevision: editing?.workingRevision,
      workingDocument: editing?.workingDocument,
    };
    const archiveSequence = this.archiveExportSequence;
    const coldStart =
      !drawing && !model && !getState('models.documentA') && !getState('models.documentB');
    // A paper-only archive (#565) needs no open model, but that is known only after reading it.
    const needsOpenModel = Boolean(this.drawingLifecycle && (!drawing || !model) && !coldStart);
    const openModelMessage = 'ZIP読込前にモデルと図面を開くか、モデルを全て解除してください。';
    const assertCurrentImport = () => {
      const currentEditing = getState('models.editing');
      if (
        request !== this.drawingImportSequence ||
        coldStartEpoch !== this.zipColdStartEpoch ||
        archiveSequence !== this.archiveExportSequence ||
        drawing !== this.panel.drawing ||
        model !== this.currentModelDocument() ||
        sourceA !== getState('models.documentA') ||
        sourceB !== getState('models.documentB') ||
        editing !== currentEditing ||
        editingSnapshot.active !== currentEditing?.active ||
        editingSnapshot.sessionId !== currentEditing?.sessionId ||
        editingSnapshot.workingRevision !== currentEditing?.workingRevision ||
        editingSnapshot.workingDocument !== currentEditing?.workingDocument
      ) {
        throw new Error(
          'ZIP読込中にモデル、図面または編集状態が変更されました。再度読み込んでください。',
        );
      }
    };
    const zipBytes = new Uint8Array(await file.arrayBuffer());
    assertCurrentImport(); // Avoid decompressing a ZIP selected for a previous model.
    const {
      project,
      sourceRevisions,
      referenceAssets = [],
      fontAsset = null,
    } = await readDrawingProjectArchive(zipBytes);
    assertCurrentImport(); // Also cover a switch during asynchronous digest verification.
    const paperOnlyArchive = !project.modelSlots.length && !project.drawingDocuments.length;
    if (needsOpenModel && !paperOnlyArchive) throw new Error(openModelMessage);
    // Hand a verified immutable font file interface to the existing PDF
    // renderer. Never install fonts globally or change the user's file input.
    const restoredFontFile = fontAsset
      ? Object.freeze({
          name: fontAsset.name,
          size: fontAsset.bytes.length,
          arrayBuffer: async () => new Uint8Array(fontAsset.bytes).buffer,
        })
      : null;
    // Parse and verify every packaged DXF *before* the model/workspace is mutated.
    const preparedReferences = [];
    if (referenceAssets.length) {
      const services = this.panel.services || this.panel.getServices?.();
      if (typeof services?.restoreDxfReferenceDrawing !== 'function')
        throw new Error('ZIP内DXF参照原本の復元サービスがありません。');
      for (const asset of referenceAssets) {
        const file = new Blob([asset.bytes], { type: 'application/dxf' });
        const imported = await services.restoreDxfReferenceDrawing({
          file,
          assetDescriptor: asset.descriptor,
        });
        if (imported.referenceDrawing?.source?.documentId !== asset.documentId)
          throw new Error('ZIP内DXF原本の参照IDが一致しません。');
        preparedReferences.push({ asset, file, imported });
        assertCurrentImport();
      }
    }
    // A paper-only archive holds no STB original, so it never needs the STB cold start.
    if (coldStart && this.drawingLifecycle && !paperOnlyArchive) {
      await this.importDrawingProjectZipColdStart({
        project,
        sourceRevisions,
        assertCurrentImport,
        coldStartEpoch,
        preparedReferences,
        restoredFontFile,
      });
    } else {
      // Existing-model imports retain the JSON stage and its source/binding validation.
      // Keep the import lease across the JSON await. Without it, an earlier ZIP
      // can publish its DXF, font or STB originals after a newer ZIP/JSON import.
      await this.importDrawingProject(
        { text: async () => serializeDrawingProject(project) },
        { zipColdStartEpoch: coldStartEpoch },
      );
      if (coldStartEpoch !== this.zipColdStartEpoch)
        throw new Error('ZIP読込中に別の読込操作が開始されました。');
      this.applyZipReferenceAssets(preparedReferences);
      if (coldStartEpoch !== this.zipColdStartEpoch)
        throw new Error('ZIP読込中に別の読込操作が開始されました。');
      this.archivedPdfFontFile = restoredFontFile;
    }
    // Cold-start legitimately advances drawingImportSequence and archiveExportSequence
    // inside modelLoader/JSON restoration. The independent epoch is the only
    // operation token that survives both lifecycles.
    if (coldStartEpoch !== this.zipColdStartEpoch)
      throw new Error('ZIP読込中に別の読込操作が開始されました。');
    this.archiveSourceRevisions = sourceRevisions;
    this.archiveExportSequence++;
    this.setDrawingProjectStatus(
      'ZIP読込済み / STB原本 ' +
        sourceRevisions.length +
        '改訂 / DXF参照 ' +
        preparedReferences.length +
        '件 / TTF ' +
        (restoredFontFile ? '復元済み' : 'なし') +
        ' / 図面復元済み',
    );
  }

  /**
   * Restore a ZIP into an *empty* SDV session. Never set models.documentA directly:
   * the ordinary loader owns XML parsing, node maps, events and 3D lifecycle.
   * All ZIP integrity, source revision and active drawing intent checks precede
   * the first mutable operation. On subsequent failure, roll back to empty state.
   */
  async importDrawingProjectZipColdStart({
    project,
    sourceRevisions,
    assertCurrentImport,
    coldStartEpoch,
    preparedReferences = [],
    restoredFontFile = null,
  }) {
    assertCurrentImport();
    const services = this.panel.services || this.panel.getServices?.();
    if (
      typeof services?.createDrawingFromStbFile !== 'function' ||
      typeof services?.assertDrawingSourceCurrent !== 'function'
    )
      throw new Error('STB図面の正式な検証・生成サービスが初期化されていません。');

    // Prefer plans by default, but permit explicit elevation selection even
    // when the archive contains a current plan. A mixed plan/elevation project
    // must not make its saved axis views inaccessible at cold start.
    const currentDocuments = (project.drawingDocuments || []).filter((document) => {
      const slot = project.modelSlots.find((item) => item.id === document.modelSlotId);
      return (
        slot?.currentRevisionId === document.sourceRevisionId &&
        ['plan', 'elevation'].includes(document.view?.type)
      );
    });
    const plans = currentDocuments.filter((document) => document.view.type === 'plan');
    const elevations = currentDocuments.filter((document) => document.view.type === 'elevation');
    const candidates = [...plans, ...elevations];
    if (!candidates.length) throw new Error('ZIP初期復元に対応する現行STB図面がありません。');
    let selectedDocument = candidates[0];
    if (candidates.length > 1) {
      const options = candidates
        .map((document, index) => {
          const label =
            document.view.type === 'plan'
              ? document.view.storyId
              : `${document.view.axisDirection}/${document.view.axisId}`;
          return `${index + 1}: ${document.id} / ${label}`;
        })
        .join('\n');
      const answer = globalThis.prompt?.(
        'ZIPから最初に復元する図面の番号を入力してください。\n' + options,
        '1',
      );
      const index = Number(answer);
      if (
        answer == null ||
        !/^\d+$/.test(String(answer)) ||
        !Number.isSafeInteger(index) ||
        index < 1 ||
        index > candidates.length
      )
        throw new Error('ZIPの初期復元対象が選択されませんでした。');
      selectedDocument = candidates[index - 1];
    }
    if (
      selectedDocument.view.type === 'elevation' &&
      typeof services.createElevationFromStbFile !== 'function'
    )
      throw new Error('軸組図の独立復元サービスがありません。');
    const staged = await stageDrawingProjectArchiveWithIntents({
      project,
      sourceRevisions,
      drawingId: selectedDocument.id,
      createDrawingFromStbFile: (args) => services.createDrawingFromStbFile(args),
      createElevationFromStbFile: (args) => services.createElevationFromStbFile(args),
    });
    assertCurrentImport();
    // A multi-view ZIP publishes the complete DrawingProject, not just the
    // first selected view. Reject unresolved tags, dimensions and reviews in
    // other current views before the regular model loader mutates the session.
    for (const document of currentDocuments) {
      if (document.id === selectedDocument.id) continue;
      // Even an intent-free view must have a valid story/axis in the packaged STB.
      // Otherwise a missing view is silently accepted and fails only when opened later.
      await stageDrawingProjectArchiveWithIntents({
        project,
        sourceRevisions,
        drawingId: document.id,
        createDrawingFromStbFile: (args) => services.createDrawingFromStbFile(args),
        createElevationFromStbFile: (args) => services.createElevationFromStbFile(args),
      });
      assertCurrentImport();
    }

    const inputA = globalThis.document?.getElementById?.('fileA');
    const inputB = globalThis.document?.getElementById?.('fileB');
    if (
      !inputA ||
      !inputB ||
      inputA.files?.length ||
      inputB.files?.length ||
      getState('models.documentA') ||
      getState('models.documentB') ||
      getState('models.editing')?.active
    )
      throw new Error('ZIP単独復元はSTB-A/Bが未選択・未読込の状態で実行してください。');
    if (
      typeof globalThis.File !== 'function' ||
      typeof globalThis.DataTransfer !== 'function' ||
      typeof globalThis.window?.handleCompareModelsClick !== 'function'
    )
      throw new Error('ZIPからモデルを初期化するためのブラウザ読込経路が利用できません。');

    const importArchiveSequence = this.archiveExportSequence;
    const assertNotSuperseded = () => {
      if (
        coldStartEpoch !== this.zipColdStartEpoch ||
        importArchiveSequence !== this.archiveExportSequence
      )
        throw new Error('ZIP初期復元中に別の読込・保存操作が開始されました。');
      // A user can select another STB while the regular model loader is still
      // awaiting XML processing. A new selection may not yet have committed a
      // model or advanced a drawing sequence, so also fence both file inputs.
      if (installedFile && (inputA.files?.[0] !== installedFile || inputB.files?.length))
        throw new Error('ZIP初期復元中にSTBの入力ファイル選択が変更されました。');
    };
    const modelFile = new File([staged.plan.sourceBytes], 'drawing-project.stb', {
      type: 'application/xml',
    });
    const transfer = new DataTransfer();
    transfer.items.add(modelFile);
    // Immediately before invoking the normal loader, recheck the import token.
    assertCurrentImport();
    let committedModel = null;
    let installedFile = null;
    try {
      inputA.files = transfer.files;
      installedFile = inputA.files?.[0] || null;
      if (!installedFile) throw new Error('ZIP内STB原本をモデルAの入力へ設定できませんでした。');
      inputA.dispatchEvent(new Event('change', { bubbles: true }));
      assertNotSuperseded();
      await globalThis.window.handleCompareModelsClick();
      assertNotSuperseded();
      committedModel = getState('models.documentA');
      if (!committedModel || getState('models.documentB'))
        throw new Error('ZIPのSTB-Aを正式なmodelLoaderで読み込めませんでした。');
      await services.assertDrawingSourceCurrent({ source: staged.drawing.source });
      this.panel.e['pdf-overlay-model'].value = 'A';
      this.panel.refreshModelAndStories();
      if (staged.plan.view.type === 'plan') {
        this.panel.e['pdf-overlay-story'].value = String(staged.plan.storyId);
        if (this.panel.e['pdf-overlay-story'].value !== String(staged.plan.storyId))
          throw new Error('ZIPに記録された対象階がSTB-Aにありません。');
      }
      if (Array.isArray(this.panel.cadDrawingViews)) {
        const matchingView = this.panel.cadDrawingViews.find((view) =>
          staged.plan.view.type === 'plan'
            ? view.type === 'plan' && String(view.storyId) === String(staged.plan.storyId)
            : view.type === 'elevation' &&
              view.axisDirection === staged.plan.view.axisDirection &&
              String(view.axisId) === String(staged.plan.view.axisId),
        );
        if (!matchingView || !this.panel.e['pdf-overlay-view-list'])
          throw new Error('ZIPの保存図面に対応するビュー候補がありません。');
        this.panel.e['pdf-overlay-view-list'].value = matchingView.key;
      }
      if (staged.plan.view.type === 'elevation') {
        if (!this.panel.e['pdf-overlay-elevation-depth'])
          throw new Error('軸組図の奥行指定欄がありません。');
        this.panel.e['pdf-overlay-elevation-depth'].value = String(staged.plan.view.depth);
      }
      if (this.panel.e['pdf-overlay-display-mode'])
        this.panel.e['pdf-overlay-display-mode'].value = 'stb';
      await this.panel.buildDrawing();
      assertNotSuperseded();
      const actualView = this.panel.drawing?.view;
      const expectedView = staged.plan.view;
      const matchingView =
        expectedView.type === 'plan'
          ? actualView?.type === 'plan' &&
            String(actualView.storyId) === String(staged.plan.storyId)
          : actualView?.type === 'elevation' &&
            actualView.axisDirection === expectedView.axisDirection &&
            String(actualView.axisId) === String(expectedView.axisId) &&
            Number.isFinite(actualView.lowerBound) &&
            Number.isFinite(actualView.upperBound) &&
            Number.isFinite(actualView.position) &&
            Math.abs((actualView.lowerBound + actualView.upperBound) / 2 - actualView.position) <
              1e-6 &&
            Math.abs((actualView.upperBound - actualView.lowerBound) / 2 - expectedView.depth) <
              1e-6;
      if (
        !this.panel.drawing ||
        this.panel.drawing.source?.modelKey !== 'A' ||
        this.panel.drawing.source?.modelRevision !== staged.plan.sourceSha256 ||
        !matchingView
      )
        throw new Error('正式ロード後のDrawingModelがZIPの改訂・ビューと一致しません。');
      // Reuse the regular JSON import's binding/view validation and workspace
      // ownership path; do not duplicate its tag or lifecycle mutations.
      await this.importDrawingProject(
        {
          text: async () => serializeDrawingProject(staged.plan.project),
        },
        { zipColdStartEpoch: coldStartEpoch, drawingId: staged.document.id },
      );
      // DXF activation is part of the same empty-session transaction. A
      // rendering failure must roll back STB-A and the DrawingProject too;
      // doing this after returning from cold-start left a half-open session.
      if (coldStartEpoch !== this.zipColdStartEpoch)
        throw new Error('ZIP初期復元中に別の読込操作が開始されました。');
      if (staged.document.view.cutBoundsMm) {
        this.panel.drawing = cutDrawingModelToBounds(
          this.panel.drawing,
          staged.document.view.cutBoundsMm,
        );
        this.panel.renderOverlay();
      }
      this.applyZipReferenceAssets(preparedReferences);
      // importDrawingProject() intentionally increments archiveExportSequence
      // when it commits the restored workspace. Its own source/view gate has
      // completed; only a genuinely newer ZIP/JSON import can supersede us now.
      if (coldStartEpoch !== this.zipColdStartEpoch)
        throw new Error('ZIP初期復元中に別の読込操作が開始されました。');
      this.archivedPdfFontFile = restoredFontFile;
    } catch (error) {
      // This entry is allowed only from an empty model session. Do not clear
      // a newer external load if the user replaced the file during our await.
      // A newly selected or loaded STB-B is never owned by this ZIP. Never
      // clear it even if it was installed before the failure was observed.
      // Dynamic import is asynchronous. Capture both loaded model identities
      // now: committedModel may still be null if the ordinary loader failed
      // before our first assignment. A newer model installed during the await
      // must never be removed by an obsolete rollback.
      const modelAAtFailure = getState('models.documentA');
      const modelBAtFailure = getState('models.documentB');
      const ownsFailedLoad = () =>
        ownsZipColdStartRollback({
          expectedEpoch: coldStartEpoch,
          currentEpoch: this.zipColdStartEpoch,
          installedFile,
          currentInputFile: inputA.files?.[0],
          otherInputFile: inputB.files?.[0] || null,
          modelAAtFailure,
          currentModelA: getState('models.documentA'),
          modelBAtFailure,
          currentModelB: getState('models.documentB'),
          committedModel,
        });
      if (ownsFailedLoad()) {
        let cleared = false;
        try {
          const { clearLoadedModels } =
            await import('../../../app/controllers/modelLoaderController.js');
          if (!ownsFailedLoad()) throw new Error('ZIPの復旧中に別のモデルが読み込まれました。');
          clearLoadedModels();
          cleared = true;
          this.panel.invalidateDrawing?.('ZIP初期復元に失敗しました。');
          this.closeOpenDrawingProject();
          this.loadedDrawingProject = null;
          this.drawingProjectId = null;
          this.activeDrawingDocumentId = null;
          this.archiveSourceRevisions = [];
          this.archivedPdfFontFile = null;
          this.memberReviews = [];
          this.drawingMemos = [];
          this.tagPlacements = [];
        } catch (rollbackError) {
          // Preserve the original import failure, not a secondary cleanup error.
          globalThis.console?.error?.('ZIP初期復元のロールバックに失敗', rollbackError);
        } finally {
          // Do not erase an input supplied by a newer request. Clearing the
          // global model also resets the ordinary loader's file/source state.
          if (
            cleared &&
            coldStartEpoch === this.zipColdStartEpoch &&
            inputA.files?.[0] === installedFile
          ) {
            inputA.value = '';
            inputA.dispatchEvent(new Event('change', { bubbles: true }));
            // A failed cold-start must not leave the old floor/view options active.
            this.panel.refreshModelAndStories?.();
          }
        }
      }
      throw error;
    }
  }

  /** Commit verified reference DXF drawings as one UI update after project restore. */
  applyZipReferenceAssets(prepared) {
    if (!(this.panel.referenceAssets instanceof Map)) return; // controller-only fixtures
    const previous = {
      drawings: this.panel.referenceDrawings,
      assets: this.panel.referenceAssets,
      display: this.panel.referenceDisplaySettings,
      sequence: this.panel.referenceDocumentSequence,
      sheetLayout: this.panel.sheetLayout,
      sheetRenderPlan: this.panel.sheetRenderPlan,
    };
    try {
      this.panel.referenceDrawings = prepared.map(({ imported }) => imported.referenceDrawing);
      this.panel.referenceAssets = new Map(
        prepared.map(({ asset, file }) => [
          asset.documentId,
          Object.freeze({ file, descriptor: asset.descriptor }),
        ]),
      );
      this.panel.referenceDisplaySettings = Object.fromEntries(
        prepared.map(({ asset, imported }) => [
          asset.documentId,
          asset.display || {
            visible: true,
            opacity: 0.65,
            color: null,
            layers: Object.fromEntries(
              imported.referenceDrawing.layers.map((layer) => [layer.id, true]),
            ),
          },
        ]),
      );
      this.panel.referenceDocumentSequence = Math.max(
        previous.sequence || 0,
        ...prepared.map(({ asset }) => {
          const match = /^dxf-reference-(\d+)$/.exec(asset.documentId);
          return match ? Number(match[1]) : 0;
        }),
      );
      this.panel.sheetLayout = null;
      this.panel.sheetRenderPlan = null;
      this.panel.renderReferenceDrawingList?.();
      this.panel.updatePdfFeatureAvailability?.();
      if (this.panel.e?.['pdf-overlay-display-mode']?.value === 'stb') this.panel.renderOverlay?.();
    } catch (error) {
      this.panel.referenceDrawings = previous.drawings;
      this.panel.referenceAssets = previous.assets;
      this.panel.referenceDisplaySettings = previous.display;
      this.panel.referenceDocumentSequence = previous.sequence;
      this.panel.sheetLayout = previous.sheetLayout;
      this.panel.sheetRenderPlan = previous.sheetRenderPlan;
      // The list renderer may already have replaced DOM nodes before a later
      // SVG overlay render fails. Restore the visible UI from the old state,
      // without allowing a secondary cleanup error to mask the primary one.
      try {
        this.panel.renderReferenceDrawingList?.();
        this.panel.updatePdfFeatureAvailability?.();
        if (this.panel.e?.['pdf-overlay-display-mode']?.value === 'stb')
          this.panel.renderOverlay?.();
      } catch (restoreError) {
        globalThis.console?.error?.('ZIP DXF表示の復旧に失敗', restoreError);
      }
      throw error;
    }
  }

  exportDrawingProject() {
    // Issue #612: persisted multi-view / sheet projects must never be flattened
    // through the single-plan workspace snapshot exporter. Route the single
    // project-export command to the owner of the saved project instead.
    const savedProject = this.loadedDrawingProject;
    if (
      savedProject &&
      (!this.panel.drawing ||
        (savedProject.drawingSheets?.length ?? 0) > 0 ||
        (savedProject.drawingDocuments?.length ?? 0) > 1)
    ) {
      this.exportDrawingSheetProject();
      return;
    }
    const project = this.createDrawingProjectSnapshot();
    const json = serializeDrawingProject(project);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `drawing-workspace-${date}.json`);
    const document = project.drawingDocuments[0];
    this.setDrawingProjectStatus(
      `書き出し済み / ${document.view.storyId} / ${document.memberReviews.length}部材レビュー / ${document.annotations.length}自由メモ / ${document.tagIntents.length}タグ配置`,
    );
  }

  drawingProjectDocumentForCurrent(project) {
    const drawing = this.panel.drawing;
    if (!drawing) throw new Error('図面を先に生成してください。');
    const revisionKey = String(drawing.source.modelRevision || '').toLowerCase();
    const matches = project.drawingDocuments.filter((document) => {
      if (!samePlanView(document.view, drawing.view)) return false;
      const slot = project.modelSlots.find((item) => item.id === document.modelSlotId);
      const revision = slot?.revisions.find((item) => item.id === document.sourceRevisionId);
      return Boolean(
        revision &&
        (revision.id === drawing.source.modelRevision || revision.sha256 === revisionKey),
      );
    });
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? '現在のSTB改訂・階に一致するDrawingDocumentが複数あります。'
          : '現在のSTB改訂・階に一致するDrawingDocumentがありません。',
      );
    return matches[0];
  }

  applyDrawingProjectDisplaySettings(display) {
    const root = globalThis.document;
    if (!root?.querySelectorAll || !display) return;
    for (const input of root.querySelectorAll('.element-settings-table input[name="elements"]')) {
      if (Object.hasOwn(display.visibility || {}, input.value))
        input.checked = Boolean(display.visibility[input.value]);
    }
    for (const input of root.querySelectorAll(
      '.element-settings-table input.element-color-input[data-element-type]',
    )) {
      const color = display.colors?.[input.dataset.elementType];
      if (typeof color === 'string') input.value = color;
    }
    for (const select of root.querySelectorAll(
      '.element-settings-table select[name="pdfDrawingTagMode"]',
    )) {
      const value = display.tagModes?.[select.dataset.elementType];
      if (typeof value === 'string' && [...select.options].some((option) => option.value === value))
        select.value = value;
    }
    if (this.panel.e?.['pdf-overlay-cut-fill'])
      this.panel.e['pdf-overlay-cut-fill'].checked = display.cutSurfaceFill !== false;
    if (
      this.panel.e?.['pdf-overlay-cut-fill-opacity'] &&
      Number.isFinite(display.cutSurfaceFillOpacity)
    )
      this.panel.e['pdf-overlay-cut-fill-opacity'].value = String(display.cutSurfaceFillOpacity);
  }

  stageDrawingProject(project) {
    assertDrawingProjectWorkspaceEditSafe(project);
    const document = this.drawingProjectDocumentForCurrent(project);
    if (document.sheet.paper !== 'A3' || document.sheet.orientation !== 'landscape')
      throw new Error('現在のDrawing WorkspaceはA3横以外のDrawingDocument読込に未対応です。');
    const restored = restoreDrawingWorkspaceReviewState({
      project,
      drawingId: document.id,
      drawingModel: this.panel.drawing,
    });
    const inactive = [
      ...restored.reviewStatuses.filter(
        (status) =>
          document.memberReviews.find((item) => item.id === status.id)?.context.sourceRevisionId ===
          document.sourceRevisionId,
      ),
      ...restored.annotationStatuses.filter(
        (status) =>
          document.annotations.find((item) => item.id === status.id)?.context.sourceRevisionId ===
          document.sourceRevisionId,
      ),
      // 孤児として保持したtagは現行改訂で描画しないだけで、復元失敗ではない。
      ...restored.tagStatuses.filter((item) => item.invalidationCode !== 'BINDING_ORPHANED'),
    ].filter((item) => !item.active);
    if (inactive.length) {
      const detail = inactive
        .slice(0, 5)
        .map((item) => `${item.id}:${item.invalidationCode}`)
        .join(', ');
      throw new Error(
        `DrawingProjectを現在のSTBへ完全には復元できません: ${detail}${inactive.length > 5 ? ' …' : ''}`,
      );
    }
    return { document, restored };
  }

  async importDrawingProject(file, { zipColdStartEpoch = null, drawingId = null } = {}) {
    if (!file) return;
    if (zipColdStartEpoch == null) {
      this.zipColdStartEpoch = (this.zipColdStartEpoch || 0) + 1;
    } else if (zipColdStartEpoch !== this.zipColdStartEpoch) {
      throw new Error('ZIP初期復元中に別の読込操作が開始されました。');
    }
    const sequence = this.drawingLifecycle ? ++this.drawingImportSequence : null;
    const drawing = this.panel.drawing;
    const model = this.currentModelDocument();
    const sourceA = getState('models.documentA');
    const sourceB = getState('models.documentB');
    const editing = getState('models.editing');
    const editingSnapshot = {
      active: editing?.active,
      sessionId: editing?.sessionId,
      workingRevision: editing?.workingRevision,
      workingDocument: editing?.workingDocument,
    };
    const sourceUnchanged = () => {
      const currentEditing = getState('models.editing');
      return (
        sourceA === getState('models.documentA') &&
        sourceB === getState('models.documentB') &&
        editing === currentEditing &&
        editingSnapshot.active === currentEditing?.active &&
        editingSnapshot.sessionId === currentEditing?.sessionId &&
        editingSnapshot.workingRevision === currentEditing?.workingRevision &&
        editingSnapshot.workingDocument === currentEditing?.workingDocument
      );
    };
    const project = parseDrawingProject(await readFileAsText(file));
    // #565: a paper-only project (sheets, no model slot or view) needs no open model.
    const paperOnlyProject = !project.modelSlots.length && !project.drawingDocuments.length;
    if (this.drawingLifecycle && !paperOnlyProject && (!drawing || !model))
      throw new Error('モデルと図面を先に開いてください。');
    if (
      this.drawingLifecycle &&
      (sequence !== this.drawingImportSequence ||
        drawing !== this.panel.drawing ||
        model !== this.currentModelDocument() ||
        !sourceUnchanged())
    ) {
      throw new Error('読込中にモデルまたは図面が変更されました。再度読み込んでください。');
    }
    if (paperOnlyProject) {
      this.closeOpenDrawingProject();
      this.archivedPdfFontFile = null;
      this.drawingProjectId = project.projectId;
      this.loadedDrawingProject = project;
      this.activeDrawingDocumentId = null;
      this.clearDrawingProjectReplacement();
      this.panel.sheetBrowser?.invalidatePreviewSources?.();
      this.panel.sheetBrowser?.render();
      this.panel.updatePdfFeatureAvailability?.();
      this.setDrawingProjectStatus(
        `シートJSON読込済み / ビュー 0件 / シート ${project.drawingSheets.length}件。`,
      );
      showSuccess('空シートのDrawingProjectを復元しました。');
      return;
    }
    // A multi-view DrawingProject is an independent sheet metadata owner.
    // Never feed it through the legacy single-plan workspace restoration.
    const multiViewSheetProject =
      project.drawingDocuments.length > 1 ||
      project.drawingDocuments[0]?.view?.type === 'elevation' ||
      Boolean(project.drawingDocuments[0]?.view?.cutBoundsMm);
    const staged = multiViewSheetProject
      ? stageDrawingSheetProjectImport({
          project,
          drawing,
          selectedView: this.panel.selectedCadDrawingView?.(),
          drawingId,
        })
      : this.stageDrawingProject(project);
    if (multiViewSheetProject) {
      const services = this.panel.services || this.panel.getServices?.();
      if (typeof services?.assertDrawingSourceCurrent !== 'function')
        throw new Error('シートJSON再読込にはSTB-Aの現行改訂照合サービスが必要です。');
      await services.assertDrawingSourceCurrent({ source: drawing.source });
    }
    if (
      this.drawingLifecycle &&
      (sequence !== this.drawingImportSequence ||
        drawing !== this.panel.drawing ||
        model !== this.currentModelDocument() ||
        !sourceUnchanged())
    ) {
      throw new Error('読込中にモデルまたは図面が変更されました。');
    }
    if (multiViewSheetProject) {
      // No active workspace state is silently restored from inactive views.
      // Revoke the previous single-plan lifecycle before changing the owner.
      this.closeOpenDrawingProject();
      this.archivedPdfFontFile = null;
      this.drawingProjectId = project.projectId;
      this.loadedDrawingProject = project;
      this.activeDrawingDocumentId = staged.currentDrawingDocumentId;
      this.clearDrawingProjectReplacement();
      this.panel.sheetBrowser?.invalidatePreviewSources?.();
      this.panel.sheetBrowser?.render();
      this.setDrawingProjectStatus(
        `シートJSON読込済み / ビュー ${staged.drawingDocumentCount}件 / シート ${staged.drawingSheetCount}件。` +
          '保存済み注記はJSON内に保持されますが、現在のworkspaceへ自動適用しません。',
      );
      showSuccess('複数ビューDrawingProjectのシート情報を復元しました。');
      return;
    }
    this.closeOpenDrawingProject();
    this.archivedPdfFontFile = null;
    this.drawingProjectId = project.projectId;
    this.loadedDrawingProject = project;
    this.activeDrawingDocumentId = null;
    this.archiveSourceRevisions = [];
    this.archiveExportSequence++;
    this.clearDrawingProjectReplacement();
    this.setTagFamilyState(staged.restored.tagFamilyState, { render: false });
    this.memberReviews = staged.restored.memberReviews;
    this.drawingMemos = staged.restored.drawingMemos;
    this.drawingMemoIdentity = null;
    this.tagPlacements = staged.restored.tagPlacements;
    this.applyDrawingProjectDisplaySettings(staged.restored.display);
    this.panel.setScaleDenominator(staged.restored.sheet.scaleDenominator);
    this.panel.setDrawingRotationDeg(staged.restored.sheet.rotationDeg, {
      invalidatePlacement: false,
      render: false,
      notify: false,
    });
    this.panel.setTagOrientationMode(staged.restored.sheet.tagOrientationMode, {
      render: false,
    });

    if (this.selectedIdentity) this.refreshSelectedMember();
    this.renderDrawingMemoList();
    this.refreshSelectedTagControls();
    this.panel.renderOverlay();
    this.panel.updatePdfFeatureAvailability();
    this.setDrawingProjectStatus(
      `読込済み / ${staged.document.view.storyId} / ${this.memberReviews.length}部材レビュー / ${this.drawingMemos.length}自由メモ / ${this.tagPlacements.length}タグ配置`,
    );
    this.renderOrphanedIntentList();
    this.openDrawingProject(project);
    this.panel.sheetBrowser?.render();
    showSuccess('Drawing Workspace JSONを復元しました。');
  }

  /** 現在改訂で孤児化したtag/寸法意図を一覧し、明示操作で削除できるようにする。 */
  renderOrphanedIntentList() {
    const list = this.root.querySelector('#pdf-overlay-orphan-list');
    if (!list) return;
    list.replaceChildren();
    const project = this.loadedDrawingProject;
    const drawingId = project?.drawingDocuments?.[0]?.id;
    if (!project || !drawingId) return;
    const doc = this.root.ownerDocument;
    for (const orphan of listOrphanedDrawingIntents({ project, drawingId })) {
      const item = doc.createElement('li');
      const ref = orphan.lastSourceRef;
      const label = doc.createElement('span');
      label.textContent = `${orphan.entityId}${ref ? ` (最後の対応: ${ref.elementType} #${ref.elementId})` : ''} / タグ ${orphan.tagIds.length}件・寸法 ${orphan.dimensionIds.length}件 `;
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = '作図意図を削除';
      button.addEventListener('click', () => {
        try {
          this.discardOrphanedIntents(orphan.entityId);
        } catch (error) {
          showWarning(error?.message || '孤児の作図意図を削除できませんでした。');
        }
      });
      item.append(label, button);
      list.append(item);
    }
  }

  discardOrphanedIntents(entityId) {
    const project = this.loadedDrawingProject;
    const drawingId = project?.drawingDocuments?.[0]?.id;
    if (!project || !drawingId) throw new Error('Drawing Workspace JSONが読み込まれていません。');
    const result = discardOrphanedDrawingIntents({ project, drawingId, entityIds: [entityId] });
    this.loadedDrawingProject = result.project;
    this.reviseOpenDrawingProject();
    this.renderOrphanedIntentList();
    this.setDrawingProjectStatus(
      `孤児の作図意図を削除しました（タグ ${result.removedTagIds.length}件・寸法 ${result.removedDimensionIds.length}件）。プロジェクトJSONを書き出し直してください。`,
    );
  }

  setTagFamilyState(input, { render = false } = {}) {
    const normalized = normalizeTagFamilyState(input, { builtIns: BUILTIN_TAG_FAMILIES });
    this.tagFamilyState = normalized;

    const validFamilies = new Map(
      [...BUILTIN_TAG_FAMILIES, ...normalized.families].map((family) => [
        family.id,
        family.version,
      ]),
    );
    this.tagPlacements = (this.tagPlacements || []).filter((placement) => {
      const templateId = placement.template?.id;
      if (typeof templateId !== 'string' || !templateId.startsWith('user:')) return true;
      return validFamilies.get(templateId) === placement.template?.version;
    });
    refreshPdfDrawingTagFamilyOptions(normalized, globalThis.document);
    this.tagFamilyUi?.refresh();
    this.reviseOpenDrawingProject();
    if (render && this.panel.drawing) this.panel.renderOverlay();
    return normalized;
  }

  syncTagFamilySelection(elementType, selectionValue) {
    const category = canonicalPdfDrawingTagCategory(elementType);
    if (!Object.hasOwn(this.tagFamilyState.selections, category)) return false;
    const familyId = familyIdFromSelection(selectionValue);
    this.tagFamilyState = selectTagFamily(this.tagFamilyState, category, familyId, {
      builtIns: BUILTIN_TAG_FAMILIES,
    });
    this.tagFamilyUi?.refresh();
    this.reviseOpenDrawingProject();
    return true;
  }

  selectedRecord() {
    if (!this.selectedIdentity) return null;
    const key = identityKey(this.selectedIdentity);
    return this.memberReviews.find((record) => identityKey(record.identity) === key) || null;
  }

  clearSelection() {
    this.cancelTagDrag();
    this.selectedIdentity = null;
    this.root.querySelector('#pdf-overlay-review-state').value = 'unreviewed';
    this.root.querySelector('#pdf-overlay-member-memo').value = '';
    this.root.querySelector('#pdf-overlay-save-member-review').disabled = true;
    this.root.querySelector('#pdf-overlay-member-review-status').textContent =
      '部材を選択してください。';
    this.refreshSelectedTagControls();
    // 保存済みmemberReviews/tagPlacementsは削除しない。
  }

  selectMember(ref) {
    this.selectedIdentity = refIdentity(ref);
    // 通常選択だけでなく、伝播を止めるタグ編集pointerdownからの選択も同期する。
    this.panel.selectedElementKey =
      this.panel.drawing?.elements?.find((item) =>
        refIdentity(item.ref).every((value, index) => value === this.selectedIdentity[index]),
      )?.key ?? null;
    this.panel.wheelZoomAnchor = null;
    this.panel.applySelectionHighlight?.();
    const record = this.selectedRecord();
    this.root.querySelector('#pdf-overlay-review-state').value =
      record?.reviewState || 'unreviewed';
    this.root.querySelector('#pdf-overlay-member-memo').value = record?.memo || '';
    this.root.querySelector('#pdf-overlay-save-member-review').disabled = false;
    const [modelKey, elementType, elementId] = this.selectedIdentity;
    const state = record?.reviewState || 'unreviewed';
    const reason = record?.invalidationCode ? ` / 無効化理由: ${record.invalidationCode}` : '';
    this.root.querySelector('#pdf-overlay-member-review-status').textContent =
      `${modelKey} / ${elementType} #${elementId} / ${stateLabel(state)}${reason}`;
    this.refreshSelectedTagControls();
  }

  onTagPlacementWindowVisibilityChanged() {
    this.cancelTagDrag();
    if (this.panel.drawing) this.panel.renderOverlay();
  }

  isTagEditMode() {
    return Boolean(
      this.root.querySelector('#pdf-overlay-win-tagPlacement')?.classList.contains('visible') &&
      !this.panel.measurementUi?.isActive() &&
      !this.panel.regionUi?.isSelecting({ includeSuppressedClick: false }) &&
      !this.panel.anchorPickTarget &&
      !this.panel.gizmoPickOrigin &&
      !this.pickDrawingMemo,
    );
  }

  beginTagRender() {
    this.tagContexts = this.tagContexts || new Map();
    this.tagContexts.clear();
  }

  selectedTagContext() {
    if (!this.selectedIdentity) return null;
    return this.tagContexts?.get(identityKey(this.selectedIdentity)) || null;
  }

  placementProbe(context) {
    if (!context) return null;
    const drawing = drawingPlacementSnapshot(this.panel.drawing);
    if (!drawing) return null;
    return {
      schemaVersion: PDF_OVERLAY_TAG_PLACEMENT_SCHEMA_VERSION,
      identity: refIdentity(context.ref),
      drawing,
      template: { ...context.template },
    };
  }

  placementForContext(context) {
    const probe = this.placementProbe(context);
    if (!probe) return null;
    const key = placementKey(probe);
    return (this.tagPlacements || []).find((placement) => placementKey(placement) === key) || null;
  }

  tagPlacementMode() {
    if (typeof this.panel.viewportMode === 'function') return this.panel.viewportMode();
    if (this.panel.e?.['pdf-overlay-display-mode']?.value === 'pdf' && this.panel.pageRender)
      return 'pdf';
    return this.panel.drawing ? 'sheet' : 'none';
  }

  resolveTagPlacement(context) {
    if (!context?.ref || !context?.template || !Array.isArray(context.defaultAnchorModel))
      return null;
    const identity = refIdentity(context.ref);
    this.tagContexts = this.tagContexts || new Map();
    this.tagContexts.set(identityKey(identity), {
      ref: { ...context.ref },
      template: { ...context.template },
      defaultAnchorModel: [...context.defaultAnchorModel],
    });
    return this.placementForContext(context);
  }

  ensureTagPlacement(context) {
    let placement = this.placementForContext(context);
    if (!placement) {
      const probe = this.placementProbe(context);
      if (!probe) throw new Error('タグ配置のSTBコンテキストを取得できません。');
      placement = {
        ...probe,
        anchorModel: [...context.defaultAnchorModel],
        offsetModel: [0, 0],
        rotationDeg: Number(this.root.querySelector('#pdf-overlay-tag-rotation')?.value || 0),
        leader: this.root.querySelector('#pdf-overlay-tag-leader')?.checked === true,
        invalidationCode: null,
      };
      this.tagPlacements = this.tagPlacements || [];
      this.tagPlacements.push(placement);
    } else {
      placement.invalidationCode = null;
    }
    return placement;
  }

  handleTagPointerDown(event, context) {
    if (!this.isTagEditMode()) return false;
    if (event?.button != null && event.button !== 0) return false;
    const mode = this.tagPlacementMode();
    if (mode === 'none') return false;

    if (!this.panel.currentModelToCss) {
      showWarning(
        mode === 'pdf' ? 'PDF上の図面配置を先に確定してください。' : '図面を先に生成してください。',
      );
      return false;
    }

    event?.preventDefault?.();
    event?.stopPropagation?.();
    this.cancelTagDrag();
    this.panel.resetMeasurementSequence?.('tag-edit');
    this.cancelDrawingMemo();
    this.panel.regionUi.cancelSelection();
    this.panel.anchorPickTarget = null;
    this.panel.gizmoPickOrigin = false;
    this.selectMember(context.ref);

    const placement = this.ensureTagPlacement(context);
    const startCss = this.panel.stagePoint(event);
    const initialOffset = [...placement.offsetModel];
    // PDF重ね・SVG単独のどちらも、現在の model→display の逆変換を正本にする。
    // これによりSVG回転(0/90/180/270)後もドラッグ量を同じSTB model-mmへ戻せる。
    const cssToModel = invertAffine(this.panel.currentModelToCss);
    const startModel = transformPoint(cssToModel, startCss);
    const pointerId = event.pointerId;
    const target = this.root.ownerDocument?.defaultView || globalThis;

    const move = (moveEvent) => {
      if (!this.isTagEditMode()) {
        this.cancelTagDrag();
        return;
      }
      if (pointerId != null && moveEvent.pointerId != null && moveEvent.pointerId !== pointerId)
        return;
      const css = this.panel.stagePoint(moveEvent);
      const model = transformPoint(cssToModel, css);
      placement.offsetModel = [
        rounded(initialOffset[0] + model[0] - startModel[0]),
        rounded(initialOffset[1] + model[1] - startModel[1]),
      ];
      placement.invalidationCode = null;
      // The persisted drawing intent changes during the drag, not only on pointerup.
      // Revoke an approved revision before any further read can observe moved content.
      this.reviseOpenDrawingProject();
      this.refreshSelectedTagControls();
      this.panel.renderOverlay();
    };
    const finish = (upEvent) => {
      if (pointerId != null && upEvent?.pointerId != null && upEvent.pointerId !== pointerId)
        return;
      this.cancelTagDrag();
      this.refreshSelectedTagControls();
    };
    target.addEventListener?.('pointermove', move);
    target.addEventListener?.('pointerup', finish);
    target.addEventListener?.('pointercancel', finish);
    this.tagDragCleanup = () => {
      target.removeEventListener?.('pointermove', move);
      target.removeEventListener?.('pointerup', finish);
      target.removeEventListener?.('pointercancel', finish);
      this.tagDragCleanup = null;
    };
    return true;
  }

  cancelTagDrag() {
    this.tagDragCleanup?.();
  }

  updateSelectedTagAppearance() {
    const context = this.selectedTagContext();
    if (!context) return;
    const mode = this.tagPlacementMode();
    if (mode !== 'pdf' && mode !== 'sheet') return;
    const placement = this.ensureTagPlacement(context);
    placement.rotationDeg = Number(this.root.querySelector('#pdf-overlay-tag-rotation').value || 0);
    placement.leader = this.root.querySelector('#pdf-overlay-tag-leader').checked;
    this.reviseOpenDrawingProject();
    this.refreshSelectedTagControls();
    this.panel.renderOverlay();
  }

  resetSelectedTagPlacement() {
    const context = this.selectedTagContext();
    if (!context) return;
    const probe = this.placementProbe(context);
    if (!probe) return;
    const key = placementKey(probe);
    this.tagPlacements = (this.tagPlacements || []).filter(
      (placement) => placementKey(placement) !== key,
    );
    this.refreshSelectedTagControls();
    this.reviseOpenDrawingProject();
    this.panel.renderOverlay();
  }

  refreshSelectedTagControls() {
    const status = this.root.querySelector('#pdf-overlay-tag-placement-status');
    const rotation = this.root.querySelector('#pdf-overlay-tag-rotation');
    const leader = this.root.querySelector('#pdf-overlay-tag-leader');
    const reset = this.root.querySelector('#pdf-overlay-reset-tag-placement');
    const context = this.selectedTagContext();
    const mode = this.tagPlacementMode();
    const placement = context ? this.placementForContext(context) : null;
    if (!status || !rotation || !leader || !reset) return;
    const available = Boolean(context && (mode === 'pdf' || mode === 'sheet'));
    rotation.disabled = !available;
    leader.disabled = !available;
    reset.disabled = !placement;
    rotation.value = String(placement?.rotationDeg ?? 0);
    leader.checked = placement?.leader ?? false;
    if (!context) {
      status.textContent = this.selectedIdentity
        ? '現在の表示モードではタグがありません。'
        : '部材タグを選択してください。';
      return;
    }
    const [modelKey, elementType, elementId] = refIdentity(context.ref);
    if (!available) {
      status.textContent = `${modelKey} / ${elementType} #${elementId} / 配置編集できる図面がありません。`;
      return;
    }
    status.textContent = placement
      ? `${modelKey} / ${elementType} #${elementId} / ${context.template.id} / offset=(${placement.offsetModel[0]}, ${placement.offsetModel[1]}) STB model-mm`
      : `${modelKey} / ${elementType} #${elementId} / ${context.template.id} / 既定位置`;
  }

  invalidateTagPlacements(code) {
    this.cancelTagDrag();
    if (code === 'STB_VIEW_CHANGED' || code === 'STB_CHANGED' || code === 'MODEL_CHANGED') {
      this.tagPlacements = (this.tagPlacements || []).map((placement) => ({
        ...placement,
        invalidationCode: code,
      }));
    }
    this.reviseOpenDrawingProject();
    this.refreshSelectedTagControls();
  }

  saveMemberReview() {
    if (!this.selectedIdentity) return showWarning('先にSTB部材を選択してください。');
    const status = this.root.querySelector('#pdf-overlay-review-state').value;
    if (!REVIEW_STATES.has(status)) return showWarning('確認状態が不正です。');
    const identity = [...this.selectedIdentity];
    const key = identityKey(identity);
    const record = {
      identity,
      reviewState: status,
      memo: this.root.querySelector('#pdf-overlay-member-memo').value,
      invalidationCode: null,
    };
    const index = this.memberReviews.findIndex((item) => identityKey(item.identity) === key);
    if (index < 0) this.memberReviews.push(record);
    else this.memberReviews[index] = record;
    this.lastPlacementSignature = this.placementSignature();
    this.reviseOpenDrawingProject();
    this.selectMember({ modelKey: identity[0], elementType: identity[1], elementId: identity[2] });
    this.root.querySelector('#pdf-overlay-member-review-status').textContent =
      `${identity[0]} / ${identity[1]} #${identity[2]} / ${stateLabel(status)} / 保存済み`;
    showSuccess('部材の確認状態とメモを保存しました。');
  }

  hasReviewContext() {
    return Boolean(
      this.panel.pdfAdapter?.info &&
      this.panel.pageRender &&
      this.panel.drawing &&
      this.panel.regionUi.mappingState()?.current &&
      (this.currentRegistration() || this.panel.manualPlacement),
    );
  }

  readAnchors(source = this.panel) {
    const read = (key, space, axis) => {
      const suffix = space === 'model' ? 'm' : 'p';
      const value = Number(source.e[`pdf-overlay-${key}-${suffix}${axis}`].value);
      if (!Number.isFinite(value))
        throw new TypeError(`${key.toUpperCase()}点の${axis.toUpperCase()}座標が不正です。`);
      return value;
    };
    return Object.fromEntries(
      ['a', 'b', 'c'].map((key) => [
        key,
        {
          model: [read(key, 'model', 'x'), read(key, 'model', 'y')],
          pdf: [read(key, 'pdf', 'x'), read(key, 'pdf', 'y')],
        },
      ]),
    );
  }

  registrationFromAnchors(anchors, matrix = null, savedPolicy = {}) {
    if (!this.panel.services && typeof this.panel.getServices === 'function')
      this.panel.services = this.panel.getServices();
    const services = this.panel.services;
    if (!services || !anchors) return { registration: null, check: null };
    try {
      const fitted = services.solveSimilarity(
        anchors.a.model,
        anchors.b.model,
        anchors.a.pdf,
        anchors.b.pdf,
      );
      const userUnit = this.panel.pageRender?.userUnit || savedPolicy.userUnit || 1;
      const policy = { ...savedPolicy, userUnit };
      const input = services.createRegistrationInput(anchors);
      const check = services.evaluateRegistration(input, fitted, policy);
      if (check.code !== 'CHECK_WITHIN_GUIDE' && check.code !== 'CHECK_EXCEEDS_GUIDE')
        return { registration: null, check };
      return {
        registration: { anchors, matrix: fitted, policy },
        check,
        savedMatrixMatches: !matrix || matricesMatch(fitted, matrix),
      };
    } catch {
      return { registration: null, check: null };
    }
  }

  currentRegistration() {
    if (!this.panel.registration) return null;
    const result = this.registrationFromAnchors(this.readAnchors(), this.panel.registration);
    if (!result.registration || !result.savedMatrixMatches) return null;
    return result.registration;
  }

  currentInput({ drawingRotationDeg = this.panel.drawingRotationDeg } = {}) {
    const regionUi = this.panel.regionUi;
    const registration = this.currentRegistration();
    const current = {
      pdfInfo: this.panel.pdfAdapter?.info || null,
      pageRender: this.panel.pageRender || null,
      drawing: this.panel.drawing || null,
      drawingRotationDeg: Number(drawingRotationDeg ?? 0),
      tagOrientationMode: this.panel.tagOrientationMode,
      tagFamilyState: this.tagFamilyState,
      pageNumber: this.panel.pageRender?.pageNumber || null,
      registration,
      placement:
        registration || !this.panel.manualPlacement
          ? null
          : {
              mode: 'manual',
              scaleDenominator: this.panel.manualPlacement.scaleDenominator,
              matrix: [...this.panel.manualPlacement.matrix],
            },
    };
    if (regionUi.regionMapping) current.regionMapping = regionUi.regionMapping;
    if (regionUi.selectedRegion) current.selectedRegion = regionUi.selectedRegion;
    return current;
  }

  exportSession() {
    const input = this.currentInput();
    if (!input.pdfInfo || !input.pageRender)
      throw new Error('PDFページを読み込み、表示してから保存してください。');
    const hasLegacyPdfMemos = this.drawingMemos.some((memo) => Array.isArray(memo.pdfPoint));
    if (hasLegacyPdfMemos && !samePdfIdentity(this.drawingMemoIdentity, input.pdfInfo))
      throw new Error(
        '旧PDF座標の図面メモは別のPDFに作成されています。JSONに保存する前に古いPDFメモを削除してください。',
      );
    const document = createPdfOverlaySession({
      ...input,
      memberReviews: cloneRecords(this.memberReviews),
      tagPlacements: (this.tagPlacements || []).map(placementSnapshot),
      drawingMemos: this.drawingMemos.map((memo) => {
        const saved = { ...memo };
        delete saved.active;
        delete saved.invalidationCode;
        return saved;
      }),
    });
    const json = serializePdfOverlaySession(document);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const date = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `pdf-overlay-session-${date}.json`);
    this.setSessionStatus(
      `書き出し済み / PDF ${input.pdfInfo.sha256.slice(0, 12)}… / ${this.memberReviews.length}部材 / ${(this.tagPlacements || []).length}タグ配置 / ${this.drawingMemos.length}図面メモ`,
    );
  }

  async importSession(file) {
    if (!file) return;
    try {
      const parsed = parsePdfOverlaySession(await readFileAsText(file));
      if (!parsed.valid) {
        const detail = parsed.issues?.join('、') || parsed.code || 'SESSION_INVALID';
        throw new Error(`セッションJSONを適用できません: ${detail}`);
      }
      this.pendingDocument = parsed.document;
      this.root.querySelector('#pdf-overlay-restore-session').disabled = false;
      this.setSessionStatus(
        'JSONを検証しました。現在のPDF・モデル・階で復元条件を確認しています。',
      );
      await this.onAssetsChanged();
    } finally {
      this.root.querySelector('#pdf-overlay-import-session').value = '';
    }
  }

  async onAssetsChanged() {
    const pdfInfo = this.panel.pdfAdapter?.info;
    const currentDrawing = drawingPlacementSnapshot(this.panel.drawing);
    if (this.drawingMemos.length) {
      const sameIdentity = samePdfIdentity(this.drawingMemoIdentity, pdfInfo);
      this.drawingMemos = this.drawingMemos.map((memo) => {
        if (Array.isArray(memo.modelPoint)) {
          const invalidationCode = drawingContextInvalidationCode(memo.drawing, currentDrawing);
          return { ...memo, active: invalidationCode == null, invalidationCode };
        }
        if (Array.isArray(memo.pdfPoint) && this.drawingMemoIdentity && pdfInfo) {
          return {
            ...memo,
            active: sameIdentity,
            invalidationCode: sameIdentity ? null : 'PDF_CHANGED',
          };
        }
        return memo;
      });
      this.renderDrawingMemoList();
    }
    if (!this.pendingDocument) return;
    if (this.preparingRestore) return;
    this.preparingRestore = true;
    try {
      const saved = this.pendingDocument;
      const savedDrawingRotation = Number(saved.drawingRotationDeg ?? 0);
      const pdfMatches = samePdfIdentity(saved.pdfIdentity, this.panel.pdfAdapter?.info);
      if (
        pdfMatches &&
        Number.isSafeInteger(saved.pageNumber) &&
        saved.pageNumber !== this.panel.pageRender?.pageNumber &&
        saved.pageNumber <= this.panel.pdfAdapter.info.numPages
      ) {
        this.panel.e['pdf-overlay-page'].value = String(saved.pageNumber);
        await this.panel.renderPdf();
      }

      const modelKey = saved.drawing?.source?.modelKey;
      const storyId = saved.drawing?.view?.storyId;
      const targetDocument = modelKey ? getState(`models.document${modelKey}`) : null;
      if (targetDocument?.nodeType === 9 && modelKey && storyId) {
        if (this.panel.e['pdf-overlay-model'].value !== modelKey) {
          this.panel.invalidateDrawing('セッションのモデルを選択しました。STB図面を再生成します。');
          this.panel.e['pdf-overlay-model'].value = modelKey;
          this.panel.refreshModelAndStories();
        }
        const storyOption = [...this.panel.e['pdf-overlay-story'].options].find(
          (option) => option.value === storyId,
        );
        if (storyOption) {
          const needsBuild =
            this.panel.e['pdf-overlay-story'].value !== storyId ||
            this.panel.drawing?.source?.modelKey !== modelKey ||
            this.panel.drawing?.view?.storyId !== storyId;
          if (needsBuild) {
            this.panel.invalidateDrawing(
              'セッションの対象階を選択しました。STB図面を再生成します。',
            );
            this.panel.e['pdf-overlay-story'].value = storyId;
            await this.panel.buildDrawing();
          }
        }
      }

      const input = this.currentInput({ drawingRotationDeg: savedDrawingRotation });
      if (!input.pdfInfo || !input.pageRender || (this.pendingDocument.drawing && !input.drawing)) {
        this.setSessionStatus(
          !input.pdfInfo || !input.pageRender
            ? 'JSONは準備済みです。保存対象のPDFページを読み込んでください。'
            : 'JSONは準備済みです。保存時のSTBモデルと階を読み込み、図面を生成してください。',
        );
        return;
      }
      this.restorePending();
    } finally {
      this.preparingRestore = false;
    }
  }

  restorePending() {
    if (!this.pendingDocument) return showWarning('先にセッションJSONを読み込んでください。');
    const savedDrawingRotation = Number(this.pendingDocument.drawingRotationDeg ?? 0);
    const current = this.currentInput({ drawingRotationDeg: savedDrawingRotation });
    if (
      !current.pdfInfo ||
      !current.pageRender ||
      (this.pendingDocument.drawing && !current.drawing)
    ) {
      this.setSessionStatus(
        !current.pdfInfo || !current.pageRender
          ? 'PDFページを読み込み、表示してから再評価してください。'
          : '保存時のSTBモデルと階を読み込み、図面を生成してから再評価してください。',
      );
      return;
    }
    const savedRegistration = this.pendingDocument.registration;
    if (savedRegistration) {
      current.registration = this.registrationFromAnchors(
        savedRegistration.anchors,
        savedRegistration.matrix,
        savedRegistration.policy,
      ).registration;
      current.placement = null;
    } else if (this.pendingDocument.placement) {
      current.registration = null;
      current.placement = {
        mode: 'manual',
        scaleDenominator: this.pendingDocument.placement.scaleDenominator,
        matrix: [...this.pendingDocument.placement.matrix],
      };
    }
    const result = reconcilePdfOverlaySession(this.pendingDocument, current);
    if (!result.valid || !result.document) {
      const detail = result.issues?.join('、') || result.code || 'SESSION_INVALID';
      this.setSessionStatus(`復元を中止しました: ${detail}`);
      showWarning(`セッションを復元できません: ${detail}`);
      return;
    }
    this.applyRestoredDocument(result.document, current, result);
    const invalidated = result.invalidatedCount || 0;
    const code = result.code === 'CURRENT' ? '' : ` / 判定: ${result.code}`;
    this.setSessionStatus(`復元しました / ${invalidated}件の確認状態を未確認に戻しました${code}`);
    this.pendingDocument = null;
    this.root.querySelector('#pdf-overlay-restore-session').disabled = true;
    this.panel.renderOverlay();
    this.panel.regionUi.renderStatus();
    showInfo(
      invalidated
        ? `${invalidated}件はPDF/STB/階/領域/配置条件を確認できないため、未確認に戻しました。`
        : result.code === 'CURRENT'
          ? '同じ条件のセッションを復元しました。'
          : `保存時の条件と一致しません (${result.code})。確認状態は未確認として復元しました。`,
    );
  }

  applyRestoredDocument(document, current, reconcileResult = {}) {
    const pdfMatches =
      document.pdfIdentity?.sha256 === current.pdfInfo?.sha256 &&
      document.pdfIdentity?.byteLength === current.pdfInfo?.byteLength &&
      document.pdfIdentity?.numPages === current.pdfInfo?.numPages;
    const drawingMatches =
      document.drawing?.source?.modelKey === current.drawing?.source?.modelKey &&
      document.drawing?.source?.modelRevision === current.drawing?.source?.modelRevision &&
      sameValue(document.drawing?.view, current.drawing?.view);

    const restoredDrawingRotation = Number(document.drawingRotationDeg ?? 0);
    const restoredRegistrationState =
      pdfMatches && drawingMatches && document.registration
        ? this.registrationFromAnchors(
            document.registration.anchors,
            document.registration.matrix,
            document.registration.policy,
          )
        : null;
    const restoredManualPlacement =
      pdfMatches && drawingMatches && document.placement ? document.placement : null;
    const livePlacementMatrix =
      this.panel.registration || this.panel.manualPlacement?.matrix || null;
    const restoredPlacementMatrix =
      restoredRegistrationState?.registration?.matrix || restoredManualPlacement?.matrix || null;
    const placementChanges = !optionalMatricesMatch(livePlacementMatrix, restoredPlacementMatrix);
    // PDF依存寸法が保持する正本は model→PDF 行列。SVG回転値や配置モードが変わっても、
    // 復元前後の実効行列が同一なら保存済み modelToPdf は引き続き有効。
    if (placementChanges) this.panel.measurementUi?.invalidatePdfMeasurements?.();

    if (typeof this.panel.setDrawingRotationDeg === 'function') {
      this.panel.setDrawingRotationDeg(restoredDrawingRotation, {
        invalidatePlacement: false,
        render: false,
        notify: false,
      });
    } else {
      this.panel.drawingRotationDeg = restoredDrawingRotation;
      if (this.panel.e?.['pdf-overlay-drawing-rotation'])
        this.panel.e['pdf-overlay-drawing-rotation'].value = String(restoredDrawingRotation);
    }
    if (typeof this.panel.setTagOrientationMode === 'function') {
      this.panel.setTagOrientationMode(document.tagOrientationMode, { render: false });
    } else {
      this.panel.tagOrientationMode = document.tagOrientationMode;
      if (this.panel.e?.['pdf-overlay-tag-orientation'])
        this.panel.e['pdf-overlay-tag-orientation'].value = document.tagOrientationMode;
    }

    this.reviseOpenDrawingProject();
    this.memberReviews = document.memberReviews.map((record) => ({ ...record }));
    this.setTagFamilyState(document.tagFamilyState ?? createEmptyTagFamilyState(), {
      render: false,
    });
    this.tagPlacements = (document.tagPlacements || []).map((placement) => {
      const status = (reconcileResult.tagPlacementStatuses || []).find(
        (item) => placementKey(item) === placementKey(placement),
      );
      return {
        ...placementSnapshot(placement),
        // currentでなくても保持する。表示時にSTB drawing/member/templateのplacementKeyで再照合する。
        invalidationCode: status?.invalidationCode || null,
      };
    });
    this.tagContexts = this.tagContexts || new Map();
    this.tagContexts.clear();
    const hasLegacyPdfMemos = document.drawingMemos.some((memo) => Array.isArray(memo.pdfPoint));
    this.drawingMemoIdentity =
      hasLegacyPdfMemos && document.pdfIdentity ? { ...document.pdfIdentity } : null;
    this.drawingMemos = document.drawingMemos.map((memo) => {
      const status = (reconcileResult.drawingMemoStatuses || []).find(
        (item) => item.id === memo.id,
      );
      const fallbackActive = Array.isArray(memo.modelPoint) ? drawingMatches : pdfMatches;
      return {
        ...memo,
        active: status?.active ?? fallbackActive,
        invalidationCode: status?.invalidationCode || null,
      };
    });

    if (pdfMatches) {
      this.panel.regionUi.selectedRegion = document.selectedRegion || null;
      this.panel.regionUi.selectedRegionPageNumber = document.pageNumber || null;
      const mappingState = document.regionMapping
        ? inspectPdfRegionMapping(document.regionMapping, {
            pdfInfo: current.pdfInfo,
            pageRender: current.pageRender,
            drawing: current.drawing,
          })
        : null;
      this.panel.regionUi.regionMapping = mappingState?.current ? document.regionMapping : null;
    } else {
      this.panel.regionUi.selectedRegion = null;
      this.panel.regionUi.selectedRegionPageNumber = null;
      this.panel.regionUi.regionMapping = null;
    }

    if (pdfMatches && drawingMatches && document.registration) {
      this.applyingRestore = true;
      try {
        for (const key of ['a', 'b', 'c']) {
          for (const [suffix, point] of [
            ['m', document.registration.anchors[key].model],
            ['p', document.registration.anchors[key].pdf],
          ]) {
            this.panel.e[`pdf-overlay-${key}-${suffix}x`].value = String(point[0]);
            this.panel.e[`pdf-overlay-${key}-${suffix}y`].value = String(point[1]);
          }
        }
      } finally {
        this.applyingRestore = false;
      }
      const checked = restoredRegistrationState;
      this.panel.registration = checked.registration?.matrix || null;
      this.panel.manualPlacement = null;
      this.panel.e['pdf-overlay-registration-result'].textContent = checked.registration
        ? `${checked.check.code}${checked.check.errorMm == null ? '' : ` / C残差 ${checked.check.errorMm.toFixed(1)} mm`} / JSONから再計算`
        : '保存した基準点を復元しましたが、詳細位置合わせは無効です。';
    } else if (pdfMatches && drawingMatches && document.placement) {
      this.panel.registration = null;
      this.panel.manualPlacement = {
        mode: 'manual',
        scaleDenominator: document.placement.scaleDenominator,
        matrix: [...document.placement.matrix],
      };
      this.panel.setScaleDenominator(document.placement.scaleDenominator);
      this.panel.e['pdf-overlay-registration-result'].textContent =
        `手動配置 1:${document.placement.scaleDenominator} / JSONから復元`;
    } else {
      this.panel.registration = null;
      this.panel.manualPlacement = null;
      this.panel.clearAnchorInputs('all');
      this.panel.e['pdf-overlay-registration-result'].textContent =
        'セッションに有効な配置がありません。縮尺と移動ギズモで配置してください。';
    }

    if (this.selectedIdentity) this.refreshSelectedMember();
    this.refreshSelectedTagControls();
    this.renderDrawingMemoList();
    this.lastPlacementSignature = this.placementSignature();
    // Restore completion must publish counts/settings from the final runtime state,
    // not the pre-restore snapshot.
    this.reviseOpenDrawingProject();
  }

  refreshSelectedMember() {
    if (!this.selectedIdentity) return;
    const record = this.selectedRecord();
    this.root.querySelector('#pdf-overlay-review-state').value =
      record?.reviewState || 'unreviewed';
    this.root.querySelector('#pdf-overlay-member-memo').value = record?.memo || '';
    this.selectMember({
      modelKey: this.selectedIdentity[0],
      elementType: this.selectedIdentity[1],
      elementId: this.selectedIdentity[2],
    });
    if (!record) {
      this.root.querySelector('#pdf-overlay-member-review-status').textContent =
        `${this.selectedIdentity[0]} / ${this.selectedIdentity[1]} #${this.selectedIdentity[2]} / 未確認 / セッションに記録なし`;
    }
  }

  placementSignature() {
    const registration = this.currentRegistration();
    if (registration)
      return JSON.stringify({
        mode: 'registration',
        anchors: registration.anchors,
        matrix: registration.matrix,
        policy: registration.policy,
      });
    if (!this.panel.manualPlacement) return null;
    return JSON.stringify({
      mode: 'manual',
      scaleDenominator: this.panel.manualPlacement.scaleDenominator,
      matrix: [...this.panel.manualPlacement.matrix],
    });
  }

  onAnchorInputChanged() {
    if (this.applyingRestore) return;
    const hadRegistration = Boolean(this.panel.registration);
    this.panel.registration = null;
    this.refreshLegacyPdfDrawingMemoMigrationStatus();
    if (!hadRegistration) return;
    this.panel.e['pdf-overlay-registration-result'].textContent =
      '詳細位置合わせの基準点を変更しました。手動配置へ戻します。';
    this.invalidateReviews('ALIGNMENT_CHANGED');
    this.panel.renderOverlay();
    this.panel.renderDiagnostics();
  }

  onRegistrationChanged() {
    const signature = this.placementSignature();
    if (this.lastPlacementSignature && signature !== this.lastPlacementSignature)
      this.invalidateReviews('ALIGNMENT_CHANGED');
    this.lastPlacementSignature = signature;
    this.refreshLegacyPdfDrawingMemoMigrationStatus();
  }

  onPlacementChanged(code = 'PLACEMENT_CHANGED') {
    const signature = this.placementSignature();
    if (this.lastPlacementSignature && signature !== this.lastPlacementSignature)
      this.invalidateReviews(code);
    this.lastPlacementSignature = signature;
    this.refreshLegacyPdfDrawingMemoMigrationStatus();
  }

  invalidateReviews(code) {
    // PDF overlay / sheet presentation changes are presentation context only.
    // Model/source revision/drawing view changes remain invalidating until DrawingProject rebinding is implemented.
    if (REVIEW_CONTEXT_ONLY_INVALIDATION_CODES.has(code)) {
      this.lastPlacementSignature = null;
      return;
    }
    let changed = false;
    this.memberReviews = this.memberReviews.map((record) => {
      if (record.reviewState === 'unreviewed') return record;
      changed = true;
      return { ...record, reviewState: 'unreviewed', invalidationCode: code };
    });
    if (this.selectedIdentity) this.refreshSelectedMember();
    if (changed) {
      this.reviseOpenDrawingProject();
      this.root.querySelector('#pdf-overlay-member-review-status').textContent =
        `条件が変わったため確認状態を未確認に戻しました: ${code}`;
    }
    this.lastPlacementSignature = null;
  }

  legacyPdfDrawingMemoMigrationPlan() {
    let registration = null;
    try {
      registration = this.currentRegistration();
    } catch {
      registration = null;
    }
    return planLegacyPdfDrawingMemoMigration({
      drawingMemos: this.drawingMemos,
      drawing: this.panel.drawing,
      legacyPdfIdentity: this.drawingMemoIdentity,
      currentPdfInfo: this.panel.pdfAdapter?.info || null,
      currentPageNumber: this.panel.pageRender?.pageNumber || null,
      registration,
    });
  }

  refreshLegacyPdfDrawingMemoMigrationStatus() {
    const button = this.root?.querySelector?.('#pdf-overlay-migrate-legacy-drawing-memos') || null;
    const status = this.root?.querySelector?.('#pdf-overlay-legacy-memo-migration-status') || null;
    if (!button && !status) return null;
    let plan;
    try {
      plan = this.legacyPdfDrawingMemoMigrationPlan();
    } catch (error) {
      plan = {
        ready: false,
        code: 'MIGRATION_INPUT_INVALID',
        count: 0,
        message: error?.message || '旧PDFメモの移行条件を確認できません。',
      };
    }
    if (button) button.disabled = !plan.ready;
    if (status) status.textContent = plan.message;
    return plan;
  }

  migrateLegacyPdfDrawingMemos() {
    const plan = this.legacyPdfDrawingMemoMigrationPlan();
    if (!plan.ready) {
      this.refreshLegacyPdfDrawingMemoMigrationStatus();
      showWarning(plan.message);
      return false;
    }

    // 全件を変換できた後にだけruntime stateへ反映し、部分移行を残さない。
    this.drawingMemos = plan.drawingMemos;
    this.drawingMemoIdentity = null;
    this.reviseOpenDrawingProject();
    this.renderDrawingMemoList();
    this.panel.renderOverlay();
    this.panel.updatePdfFeatureAvailability?.();
    this.setDrawingProjectStatus(
      `旧PDFメモ${plan.count}件を図面model-mmへ移行しました。Drawing Workspace JSONへ保存できます。`,
    );
    showSuccess(`旧PDFメモ${plan.count}件を図面座標へ移行しました。`);
    return true;
  }

  armDrawingMemo() {
    const text = this.root.querySelector('#pdf-overlay-drawing-memo').value.trim();
    if (!text) return showWarning('図面メモを入力してください。');
    if (!this.panel.drawing || !this.panel.currentModelToCss)
      return showWarning('図面を先に生成してください。');
    this.panel.resetMeasurementSequence?.('drawing-memo');
    this.pickDrawingMemo = true;
    this.root.querySelector('#pdf-overlay-cancel-drawing-memo').disabled = false;
    this.panel.anchorPickTarget = null;
    this.panel.gizmoPickOrigin = false;
    this.panel.regionUi.cancelSelection();
    this.panel.renderOverlay();
    showInfo('図面上の配置位置をクリックしてください。');
  }

  cancelDrawingMemo() {
    this.pickDrawingMemo = false;
    this.root.querySelector('#pdf-overlay-cancel-drawing-memo').disabled = true;
  }

  handleStageClick(event) {
    if (!this.pickDrawingMemo) return false;
    if (!this.panel.drawing || !this.panel.currentModelToCss) {
      this.cancelDrawingMemo();
      return true;
    }
    const drawing = drawingPlacementSnapshot(this.panel.drawing);
    if (!drawing) {
      this.cancelDrawingMemo();
      showWarning('図面の保存コンテキストを取得できません。');
      return true;
    }
    const cssPoint =
      typeof this.panel.stagePoint === 'function'
        ? this.panel.stagePoint(event)
        : (() => {
            const rect = this.panel.e['pdf-overlay-stage'].getBoundingClientRect();
            return [event.clientX - rect.left, event.clientY - rect.top];
          })();
    const modelPoint = transformPoint(invertAffine(this.panel.currentModelToCss), cssPoint);
    const id =
      globalThis.crypto?.randomUUID?.() || `drawing-${Date.now()}-${this.drawingMemos.length}`;
    this.drawingMemos.push({
      id,
      drawing,
      modelPoint: modelPoint.map((value) => Number(value.toFixed(3))),
      text: this.root.querySelector('#pdf-overlay-drawing-memo').value.trim(),
      active: true,
      invalidationCode: null,
    });
    this.root.querySelector('#pdf-overlay-drawing-memo').value = '';
    this.cancelDrawingMemo();
    this.reviseOpenDrawingProject();
    this.renderDrawingMemoList();
    this.panel.renderOverlay();
    showSuccess('図面上に自由メモを追加しました。');
    return true;
  }

  appendDrawingMemos(svg) {
    const page = this.panel.pageRender;
    const currentDrawing = drawingPlacementSnapshot(this.panel.drawing);
    const currentModelToCss = this.panel.currentModelToCss;
    const samePdf = samePdfIdentity(this.drawingMemoIdentity, this.panel.pdfAdapter?.info);
    const active = this.drawingMemos
      .map((memo, index) => ({ memo, index }))
      .filter(({ memo }) => memo.active !== false);
    for (const { memo, index } of active) {
      let point = null;
      if (
        currentModelToCss &&
        Array.isArray(memo.modelPoint) &&
        sameDrawingContext(memo.drawing, currentDrawing)
      ) {
        point = transformPoint(currentModelToCss, memo.modelPoint);
      } else if (
        page &&
        samePdf &&
        memo.pageNumber === page.pageNumber &&
        Array.isArray(memo.pdfPoint)
      ) {
        // Legacy v1 memo: keep PDF-space placement readable until explicit migration.
        point = transformPoint(page.pdfToCss, memo.pdfPoint);
      }
      if (!point) continue;
      const [x, y] = point;
      const group = document.createElementNS(SVG_NS, 'g');
      group.setAttribute('class', 'pdf-overlay-drawing-memo');
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('class', 'pdf-overlay-drawing-memo-marker');
      circle.setAttribute('cx', String(x));
      circle.setAttribute('cy', String(y));
      circle.setAttribute('r', '8');
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'pdf-overlay-drawing-memo-label');
      text.setAttribute('x', String(x + 11));
      text.setAttribute('y', String(y - 9));
      text.textContent = `${index + 1}. ${memo.text}`;
      group.append(circle, text);
      svg.append(group);
    }
  }

  renderDrawingMemoList() {
    const list = this.root.querySelector('#pdf-overlay-drawing-memo-list');
    list.replaceChildren();
    for (const [index, memo] of this.drawingMemos.entries()) {
      const item = document.createElement('li');
      const context = memo.modelPoint
        ? `図面${memo.drawing?.view?.storyId ? ` ${memo.drawing.view.storyId}` : ''}`
        : memo.pageNumber
          ? `PDF ${memo.pageNumber}頁`
          : 'PDF未特定';
      const text = document.createElement('span');
      text.textContent = `${context}: ${memo.text}${memo.active === false ? ` (${memo.invalidationCode || '参照不一致'} / 非表示)` : ''}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '削除';
      remove.addEventListener('click', () => {
        this.drawingMemos.splice(index, 1);
        this.reviseOpenDrawingProject();
        if (!this.drawingMemos.some((item) => Array.isArray(item.pdfPoint)))
          this.drawingMemoIdentity = null;
        this.renderDrawingMemoList();
        this.panel.renderOverlay();
      });
      item.append(text, remove);
      list.append(item);
    }
    this.refreshLegacyPdfDrawingMemoMigrationStatus();
  }
}

function matricesMatch(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === 6 &&
    right.length === 6 &&
    left.every((value, index) => Number.isFinite(value) && Math.abs(value - right[index]) <= 1e-8)
  );
}

function optionalMatricesMatch(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return matricesMatch(left, right);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function drawingContextInvalidationCode(left, right) {
  if (!left || !right) return 'STB_IDENTITY_MISSING';
  if (left.source?.modelKey !== right.source?.modelKey) return 'MODEL_CHANGED';
  if (left.source?.modelRevision !== right.source?.modelRevision) return 'STB_CHANGED';
  if (!sameValue(left.view, right.view)) return 'STB_VIEW_CHANGED';
  return null;
}

function sameDrawingContext(left, right) {
  return drawingContextInvalidationCode(left, right) == null;
}

function pdfIdentityFromInfo(info) {
  return info
    ? { sha256: info.sha256, byteLength: info.byteLength, numPages: info.numPages }
    : null;
}

function samePdfIdentity(left, right) {
  const normalizedRight = pdfIdentityFromInfo(right);
  return Boolean(
    left &&
    normalizedRight &&
    left.sha256 === normalizedRight.sha256 &&
    left.byteLength === normalizedRight.byteLength &&
    left.numPages === normalizedRight.numPages,
  );
}

function stateLabel(state) {
  return state === 'confirmed' ? '確認済み' : state === 'mismatch' ? '不一致' : '未確認';
}
