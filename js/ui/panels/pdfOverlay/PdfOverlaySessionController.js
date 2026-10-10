/** @fileoverview PDF照合セッションのJSON入出力、部材メモ、図面上の自由メモ。 */
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
  commitDrawingProjectDrawingRevisionRebind,
  planDrawingProjectDrawingRevisionRebind,
  planDrawingProjectStoryRevisionRebind,
} from '../../../data/drawing/drawingProjectRevisionRebind.js';
import { getState } from '../../../data/state/globalState.js';
import { invertAffine, transformPoint } from '../../../data/drawing/affine2d.js';
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
    this.rebindStaged = null;
    this.rebindApprovals = new Map();
    this.rebindAbortController = null;
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

  bindEvents() {
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
      .addEventListener('change', (event) =>
        this.importDrawingProject(event.target.files?.[0])
          .catch((error) => {
            this.setDrawingProjectStatus(
              error?.message || 'Drawing Workspace JSONを読み込めませんでした。',
            );
            showWarning(error?.message || 'Drawing Workspace JSONを読み込めませんでした。');
          })
          .finally(() => {
            event.target.value = '';
          }),
      );
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
    this.root.querySelector('#pdf-overlay-rebind-reevaluate').addEventListener('click', () => {
      try {
        Promise.resolve(this.reevaluateDrawingProjectReplacement()).catch((error) => {
          this.setDrawingProjectRebindStatus(error?.message || '対応を再評価できませんでした。');
          showWarning(error?.message || '対応を再評価できませんでした。');
        });
      } catch (error) {
        this.setDrawingProjectRebindStatus(error?.message || '対応を再評価できませんでした。');
        showWarning(error?.message || '対応を再評価できませんでした。');
      }
    });
    this.root.querySelector('#pdf-overlay-rebind-commit').addEventListener('click', () => {
      try {
        this.commitDrawingProjectReplacement();
      } catch (error) {
        this.setDrawingProjectRebindStatus(error?.message || 'STB改訂を確定できませんでした。');
        showWarning(error?.message || 'STB改訂を確定できませんでした。');
      }
    });
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
    this.root.querySelector('#pdf-overlay-tag-edit-mode').addEventListener('change', () => {
      this.cancelTagDrag();
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

  setDrawingProjectStatus(message) {
    const status = this.root.querySelector('#pdf-overlay-drawing-project-status');
    if (status) status.textContent = message;
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
    const clear = this.root.querySelector('#pdf-overlay-rebind-clear');
    if (trigger) trigger.disabled = !this.loadedDrawingProject;
    if (reevaluate) reevaluate.disabled = true;
    if (commit) commit.disabled = true;
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

  approvedMappingsForRebind() {
    return [...this.rebindApprovals.entries()].map(([entityId, sourceRef]) => ({
      entityId,
      sourceRef: { ...sourceRef },
    }));
  }

  renderDrawingProjectRebindPlan() {
    const staged = this.rebindStaged;
    const list = this.root.querySelector('#pdf-overlay-rebind-mapping-list');
    const reevaluate = this.root.querySelector('#pdf-overlay-rebind-reevaluate');
    const commit = this.root.querySelector('#pdf-overlay-rebind-commit');
    const clear = this.root.querySelector('#pdf-overlay-rebind-clear');
    if (list) list.replaceChildren();
    if (!staged) {
      if (reevaluate) reevaluate.disabled = true;
      if (commit) commit.disabled = true;
      if (clear) clear.disabled = !this.rebindAbortController;
      return;
    }

    if (clear) clear.disabled = false;
    const plan = staged.plan;
    for (const mapping of plan.mappings) {
      const item = this.root.ownerDocument.createElement('li');
      const from = mapping.fromSourceRef;
      if (mapping.status === 'resolved') {
        const to = mapping.toSourceRef;
        item.textContent = `${mapping.entityId}: ${from.elementType} #${from.elementId} → #${to.elementId} / ${mapping.method}`;
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
        if (approved) select.value = JSON.stringify(approved);
        select.addEventListener('change', () => {
          this.rebindAbortController?.abort();
          this.rebindAbortController = null;
          if (!select.value) this.rebindApprovals.delete(mapping.entityId);
          else this.rebindApprovals.set(mapping.entityId, JSON.parse(select.value));
          if (reevaluate) reevaluate.disabled = this.rebindApprovals.size === 0;
        });
        item.append(label, select);
      }
      list?.append(item);
    }

    const resolved = plan.mappings.length - plan.unresolved.length;
    this.setDrawingProjectRebindStatus(
      `${staged.imported.filename || 'STB'} / ${plan.status === 'ready' ? '確定可能' : '要対応'} / 自動・承認済み ${resolved}件 / 未解決 ${plan.unresolved.length}件`,
    );
    if (reevaluate)
      reevaluate.disabled = plan.status === 'ready' || this.rebindApprovals.size === 0;
    if (commit) commit.disabled = plan.status !== 'ready';
  }

  async stageDrawingProjectReplacement(file) {
    if (!file) return;
    if (!isStbRevisionFile(file)) throw new TypeError('STB/XMLファイルを選択してください。');
    if (!this.loadedDrawingProject)
      throw new Error('先にDrawing Workspace JSONを読み込んでください。');
    const currentDrawing = this.panel.drawing;
    if (!currentDrawing)
      throw new Error('現在のSVG図面を生成してからSTB改訂差替えを開始してください。');

    // 別STBのstagingを開始した時点で旧ready planを破棄する。
    // 以後のsnapshot/parseが失敗しても旧revisionのplanを再利用できる状態へ戻さない。
    this.clearDrawingProjectReplacement({
      status: '新STBを解析して改訂対応を確認しています…',
    });

    // runtimeで編集したタグ配置・レビュー・注記等を、差替え元の作図意図として先にsnapshotする。
    // 単一 slot・図面の履歴を保持して現在改訂の runtime 編集を統合する。
    const sourceProject = this.createDrawingProjectSnapshot();
    const document = this.drawingProjectDocumentForCurrent(sourceProject);
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
    });
    this.rebindStaged = { ...staged, imported, plan };
    this.renderDrawingProjectRebindPlan();
    return plan;
  }

  commitDrawingProjectReplacement({ download = true } = {}) {
    const staged = this.rebindStaged;
    if (!staged || !this.loadedDrawingProject)
      throw new Error('確定できるSTB改訂差替えがありません。');
    if (staged.plan.status !== 'ready')
      throw new Error('未解決の対応が残っているためSTB改訂を確定できません。');

    // staging後にruntime作図意図が変わっていても古いproject snapshotへ巻き戻さない。
    // current workspaceからplanを再評価し、未解決が生じた場合はcommitせずreview UIへ戻す。
    const sourceProject = this.createDrawingProjectSnapshot();
    const sourceDocument = this.drawingProjectDocumentForCurrent(sourceProject);
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
    const inactiveTags = restored.tagStatuses.filter((item) => !item.active);
    if (inactiveTags.length) {
      const detail = inactiveTags
        .slice(0, 5)
        .map((item) => `${item.id}:${item.invalidationCode}`)
        .join(', ');
      throw new Error(
        `新STBへタグ配置を復元できない項目があります: ${detail}${inactiveTags.length > 5 ? ' …' : ''}`,
      );
    }

    this.panel.measurementUi?.invalidateDrawing();
    this.panel.drawing = staged.imported.drawing;
    this.panel.tagFactsResolver = staged.imported.tagFactsResolver || null;
    this.panel.sheetLayout = null;
    this.panel.sheetRenderPlan = null;
    this.loadedDrawingProject = committed;
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
    if (!drawing) throw new Error('SVG図面を先に生成してください。');
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
        if (!revision) continue;
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

  exportDrawingProject() {
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
    if (!drawing) throw new Error('SVG図面を先に生成してください。');
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
      ...restored.tagStatuses,
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

  async importDrawingProject(file) {
    if (!file) return;
    const project = parseDrawingProject(await readFileAsText(file));
    const staged = this.stageDrawingProject(project);

    this.drawingProjectId = project.projectId;
    this.loadedDrawingProject = project;
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
    showSuccess('Drawing Workspace JSONを復元しました。');
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

  isTagEditMode() {
    return Boolean(
      this.root.querySelector('#pdf-overlay-tag-edit-mode')?.checked &&
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
        mode === 'pdf'
          ? 'PDF上のSVG配置を先に確定してください。'
          : 'SVG図面を先に生成してください。',
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
      return showWarning('SVG図面を先に生成してください。');
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
