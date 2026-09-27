/** @fileoverview PDF照合セッションのJSON入出力、部材メモ、図面上の自由メモ。 */
import {
  createPdfOverlaySession,
  parsePdfOverlaySession,
  reconcilePdfOverlaySession,
  serializePdfOverlaySession,
} from '../../../app/pdfOverlay/pdfOverlaySession.js';
import { inspectPdfRegionMapping } from '../../../app/pdfOverlay/pdfOverlayRegion.js';
import { getState } from '../../../data/state/globalState.js';
import { transformPoint } from '../../../data/drawing/affine2d.js';
import { downloadBlob } from '../../../utils/downloadHelper.js';
import { showInfo, showSuccess, showWarning } from '../../common/toast.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const REVIEW_STATES = new Set(['unreviewed', 'confirmed', 'mismatch']);

function refIdentity(ref) {
  return [String(ref.modelKey), String(ref.elementType), String(ref.elementId)];
}

function identityKey(identity) {
  return JSON.stringify(identity);
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

export class PdfOverlaySessionController {
  constructor(panel) {
    this.panel = panel;
    this.root = panel.root;
    this.memberReviews = [];
    this.drawingMemos = [];
    this.drawingMemoIdentity = null;
    this.selectedIdentity = null;
    this.pendingDocument = null;
    this.pickDrawingMemo = false;
    this.lastPlacementSignature = null;
    this.applyingRestore = false;
    this.preparingRestore = false;
    this.bindEvents();
  }

  bindEvents() {
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
      .querySelector('#pdf-overlay-cancel-drawing-memo')
      .addEventListener('click', () => this.cancelDrawingMemo());

    for (const input of this.root.querySelectorAll(
      '[id^="pdf-overlay-"][id$="-mx"], [id^="pdf-overlay-"][id$="-my"], [id^="pdf-overlay-"][id$="-px"], [id^="pdf-overlay-"][id$="-py"]',
    )) {
      input.addEventListener('input', () => this.onAnchorInputChanged());
    }
  }

  setSessionStatus(message) {
    this.root.querySelector('#pdf-overlay-session-status').textContent = message;
  }

  selectedRecord() {
    if (!this.selectedIdentity) return null;
    const key = identityKey(this.selectedIdentity);
    return this.memberReviews.find((record) => identityKey(record.identity) === key) || null;
  }

  selectMember(ref) {
    this.selectedIdentity = refIdentity(ref);
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
  }

  saveMemberReview() {
    if (!this.selectedIdentity) return showWarning('先にSTB部材を選択してください。');
    const status = this.root.querySelector('#pdf-overlay-review-state').value;
    if (!REVIEW_STATES.has(status)) return showWarning('確認状態が不正です。');
    if (status !== 'unreviewed' && !this.hasReviewContext()) {
      this.root.querySelector('#pdf-overlay-review-state').value = 'unreviewed';
      return showWarning('確認状態の保存には、有効なPDF領域とSTB配置が必要です。');
    }

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
    showSuccess('部材の照合状態とメモを保存しました。');
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

  currentInput() {
    const regionUi = this.panel.regionUi;
    const registration = this.currentRegistration();
    const current = {
      pdfInfo: this.panel.pdfAdapter?.info || null,
      pageRender: this.panel.pageRender || null,
      drawing: this.panel.drawing || null,
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
    if (this.drawingMemos.length && !samePdfIdentity(this.drawingMemoIdentity, input.pdfInfo))
      throw new Error(
        '図面メモは別のPDFに作成されています。JSONに保存する前に古い図面メモを削除してください。',
      );
    const document = createPdfOverlaySession({
      ...input,
      memberReviews: cloneRecords(this.memberReviews),
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
      `書き出し済み / PDF ${input.pdfInfo.sha256.slice(0, 12)}… / ${this.memberReviews.length}部材 / ${this.drawingMemos.length}図面メモ`,
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
    if (this.drawingMemos.length && this.drawingMemoIdentity && pdfInfo) {
      const sameIdentity = samePdfIdentity(this.drawingMemoIdentity, pdfInfo);
      this.drawingMemos = this.drawingMemos.map((memo) => ({
        ...memo,
        active: sameIdentity,
        invalidationCode: sameIdentity ? null : 'PDF_CHANGED',
      }));
      this.renderDrawingMemoList();
    }
    if (!this.pendingDocument) return;
    if (this.preparingRestore) return;
    this.preparingRestore = true;
    try {
      const saved = this.pendingDocument;
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

      const input = this.currentInput();
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
    const current = this.currentInput();
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
    this.applyRestoredDocument(result.document, current);
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

  applyRestoredDocument(document, current) {
    const pdfMatches =
      document.pdfIdentity?.sha256 === current.pdfInfo?.sha256 &&
      document.pdfIdentity?.byteLength === current.pdfInfo?.byteLength &&
      document.pdfIdentity?.numPages === current.pdfInfo?.numPages;
    const drawingMatches =
      document.drawing?.source?.modelKey === current.drawing?.source?.modelKey &&
      document.drawing?.source?.modelRevision === current.drawing?.source?.modelRevision &&
      sameValue(document.drawing?.view, current.drawing?.view);

    this.memberReviews = document.memberReviews.map((record) => ({ ...record }));
    this.drawingMemoIdentity = document.pdfIdentity ? { ...document.pdfIdentity } : null;
    this.drawingMemos = document.drawingMemos.map((memo) => {
      const status = (document.drawingMemoStatuses || []).find((item) => item.id === memo.id);
      return {
        ...memo,
        active: pdfMatches,
        invalidationCode: pdfMatches ? null : status?.invalidationCode || 'PDF_CHANGED',
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
      const checked = this.registrationFromAnchors(
        document.registration.anchors,
        document.registration.matrix,
        document.registration.policy,
      );
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
  }

  onPlacementChanged(code = 'PLACEMENT_CHANGED') {
    const signature = this.placementSignature();
    if (this.lastPlacementSignature && signature !== this.lastPlacementSignature)
      this.invalidateReviews(code);
    this.lastPlacementSignature = signature;
  }

  invalidateReviews(code) {
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

  armDrawingMemo() {
    const text = this.root.querySelector('#pdf-overlay-drawing-memo').value.trim();
    if (!text) return showWarning('図面メモを入力してください。');
    if (!this.panel.pdfAdapter?.info || !this.panel.pageRender)
      return showWarning('PDFを読み込んでください。');
    if (
      this.drawingMemos.length &&
      this.drawingMemoIdentity &&
      !samePdfIdentity(this.drawingMemoIdentity, this.panel.pdfAdapter.info)
    ) {
      return showWarning(
        '以前のPDFのメモを一覧から削除してから、新しいPDFにメモを追加してください。',
      );
    }
    if (this.panel.e['pdf-overlay-display-mode'].value !== 'pdf') {
      this.panel.e['pdf-overlay-display-mode'].value = 'pdf';
      this.panel.renderPdf().catch((error) => this.panel.fail(error));
      return showInfo('PDF表示に切り替わりました。もう一度「PDF上に配置」を押してください。');
    }
    this.panel.resetMeasurementSequence?.('drawing-memo');
    this.pickDrawingMemo = true;
    this.root.querySelector('#pdf-overlay-cancel-drawing-memo').disabled = false;
    this.panel.anchorPickTarget = null;
    this.panel.gizmoPickOrigin = false;
    this.panel.regionUi.cancelSelection();
    showInfo('PDF上の配置位置をクリックしてください。');
  }

  cancelDrawingMemo() {
    this.pickDrawingMemo = false;
    this.root.querySelector('#pdf-overlay-cancel-drawing-memo').disabled = true;
  }

  handleStageClick(event) {
    if (!this.pickDrawingMemo) return false;
    const page = this.panel.pageRender;
    if (!page || this.panel.e['pdf-overlay-display-mode'].value !== 'pdf') {
      this.cancelDrawingMemo();
      return true;
    }
    const rect = this.panel.e['pdf-overlay-stage'].getBoundingClientRect();
    const cssPoint = [event.clientX - rect.left, event.clientY - rect.top];
    const pdfPoint = transformPoint(page.cssToPdf, cssPoint);
    const [xMin, yMin, xMax, yMax] = page.viewBox;
    if (pdfPoint[0] < xMin || pdfPoint[0] > xMax || pdfPoint[1] < yMin || pdfPoint[1] > yMax) {
      showWarning('PDFページ内をクリックしてください。');
      return true;
    }
    const id =
      globalThis.crypto?.randomUUID?.() || `drawing-${Date.now()}-${this.drawingMemos.length}`;
    this.drawingMemos.push({
      id,
      pageNumber: page.pageNumber,
      pdfPoint: pdfPoint.map((value) => Number(value.toFixed(3))),
      text: this.root.querySelector('#pdf-overlay-drawing-memo').value.trim(),
      active: true,
      invalidationCode: null,
    });
    this.drawingMemoIdentity = pdfIdentityFromInfo(this.panel.pdfAdapter.info);
    this.root.querySelector('#pdf-overlay-drawing-memo').value = '';
    this.cancelDrawingMemo();
    this.renderDrawingMemoList();
    this.panel.renderOverlay();
    showSuccess('図面上に自由メモを追加しました。');
    return true;
  }

  appendDrawingMemos(svg) {
    const page = this.panel.pageRender;
    if (!page || !samePdfIdentity(this.drawingMemoIdentity, this.panel.pdfAdapter?.info)) return;
    const active = this.drawingMemos.filter(
      (memo) => memo.active !== false && memo.pageNumber === page.pageNumber && memo.pdfPoint,
    );
    for (const [index, memo] of active.entries()) {
      const [x, y] = transformPoint(page.pdfToCss, memo.pdfPoint);
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
      const page = memo.pageNumber ? `PDF ${memo.pageNumber}頁` : 'PDF未特定';
      const text = document.createElement('span');
      text.textContent = `${page}: ${memo.text}${memo.active === false ? ` (${memo.invalidationCode || 'ページ不一致'} / 非表示)` : ''}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '削除';
      remove.addEventListener('click', () => {
        this.drawingMemos.splice(index, 1);
        if (!this.drawingMemos.length) this.drawingMemoIdentity = null;
        this.renderDrawingMemoList();
        this.panel.renderOverlay();
      });
      item.append(text, remove);
      list.append(item);
    }
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

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
