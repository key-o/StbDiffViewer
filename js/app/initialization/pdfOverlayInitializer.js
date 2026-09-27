/** @fileoverview PDF照合のSDV接続境界。元Documentの選択・改訂確認を一元化。 */
import { getState, registerGlobalFunction } from '../../data/state/globalState.js';
import { renderDrawingSvg } from '../../viewer/drawing/svgDrawingRenderer.js';
import { buildStbPlanDrawing } from '../../viewer/drawing/stbPlanDrawing.js';
import { PdfDocumentAdapter } from '../../parser/pdf/PdfDocumentAdapter.js';
import {
  createDrawingSheetLayout,
  createSheetToViewportTransform,
  renderDrawingSheetSvg,
} from '../../viewer/drawing/drawingSheetLayout.js';
import { sha256 } from '../../utils/sha256.js';
import {
  solveSimilarity,
  multiplyAffine,
  invertAffine,
  transformPoint,
} from '../../data/drawing/affine2d.js';
import { createRegistrationInput, evaluateRegistration } from '../pdfOverlay/registration.js';
import { collectAlignmentCandidates } from '../pdfOverlay/alignmentCandidates.js';

/** テストではgetState等を注入。実運用では登録済みSDV状態を読む。 */
export function createPdfOverlayServices({
  readState = getState,
  buildDrawing = buildStbPlanDrawing,
  digest = sha256,
  serialize = (doc) => new XMLSerializer().serializeToString(doc),
} = {}) {
  const sourceDocument = (modelKey) => {
    if (modelKey !== 'A' && modelKey !== 'B')
      throw new RangeError('モデルAまたはBを選択してください。');
    if (readState('models.editing.active'))
      throw new Error('編集セッション中の照合は未対応です。編集を確定・終了してください。');
    const doc = readState(`models.document${modelKey}`);
    if (doc?.nodeType !== 9) throw new Error(`モデル${modelKey}が未読込です。`);
    return doc;
  };
  return Object.freeze({
    createPdfDocument: (options) => new PdfDocumentAdapter(options),
    solveSimilarity,
    createRegistrationInput,
    evaluateRegistration,
    multiplyAffine,
    invertAffine,
    transformPoint,
    renderDrawingSvg,
    createSheetLayout: createDrawingSheetLayout,
    createSheetToViewportTransform,
    renderDrawingSheetSvg,
    collectAlignmentCandidates: ({ modelKey, drawing }) =>
      collectAlignmentCandidates({
        document: sourceDocument(modelKey),
        drawing,
      }),
    async createDrawing({ modelKey, view, signal } = {}) {
      const original = sourceDocument(modelKey);
      // 改訂判定の正本は「clone後のserialization」ではなく読込済みsource Documentそのもの。
      // cloneNode(true)後はブラウザDOM実装によりnamespace宣言等のserializationが変化し得るため、
      // sourceとsnapshotの文字列表現を相互比較してはならない。
      const sourceXml = serialize(original);
      const snapshot = original.cloneNode(true);
      const modelRevision = await digest(new TextEncoder().encode(sourceXml));
      if (typeof modelRevision !== 'string' || !/^[0-9a-f]{64}$/.test(modelRevision))
        throw new Error('モデル改訂SHA-256が不正です。');
      const assertUnchanged = () => {
        // SDVの既存読込・検証経路では、内容が同一のDocumentへ参照だけ差し替わることがある。
        // PDF照合で固定すべきなのはDOMオブジェクト同一性ではなく、抽出元XMLの内容。
        const current = sourceDocument(modelKey);
        if (serialize(current) !== sourceXml)
          throw new Error('照合抽出中にモデルが変更されました。再実行してください。');
      };
      assertUnchanged();
      const drawing = await buildDrawing({
        document: snapshot,
        source: { modelKey, modelRevision },
        view,
        signal,
      });
      assertUnchanged();
      return drawing;
    },
  });
}

/** UI接続前でもSDV実行状態から検証可能な明示入口を登録する。 */
export function initializePdfOverlayServices() {
  const services = createPdfOverlayServices();
  registerGlobalFunction('getPdfOverlayServices', () => services);
  return services;
}
