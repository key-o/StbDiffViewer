/** @fileoverview PDF照合のSDV接続境界。元Documentの選択・改訂確認を一元化。 */
import { getState, registerGlobalFunction } from '../../data/state/globalState.js';
import { parseElements, parseStories } from '../../common-stb/import/parser/stbParserCore.js';
import { renderDrawingSvg } from '../../viewer/drawing/svgDrawingRenderer.js';
import { compileDrawingRenderDimensions } from '../../data/drawing/drawingRenderPlanDimensions.js';
import { elementRefKey } from '../../data/drawing/drawingModel.js';
import { createStbMemberTagFactsFromDocument } from '../../viewer/drawing/stbTagFactsAdapter.js';
import { buildStbPlanDrawing } from '../../viewer/drawing/stbPlanDrawing.js';
import { createStoryPlanView } from '../../data/drawing/storyPlanView.js';
import { PdfDocumentAdapter } from '../../parser/pdf/PdfDocumentAdapter.js';
import { decodeDxfArrayBuffer } from '../../parser/drawing/dxfTextDecoder.js';
import {
  assertDxfReferenceAssetDescriptor,
  createDxfReferenceAssetDescriptor,
  parseDxfReferenceDrawing,
  parseDxfReferenceDrawingFromAsset,
} from '../../parser/drawing/dxfReferenceDrawingAdapter.js';
import {
  createDrawingSheetLayout,
  createDrawingSheetRenderPlan,
  createSheetToViewportTransform,
  renderDrawingSheetSvg,
} from '../../viewer/drawing/drawingSheetLayout.js';
import { downloadDrawingRenderPlanDxf } from '../../export/dxf/DrawingRenderPlanDxfWriter.js';
import { sha256 } from '../../utils/sha256.js';
import {
  solveSimilarity,
  multiplyAffine,
  invertAffine,
  transformPoint,
} from '../../data/drawing/affine2d.js';
import { createRegistrationInput, evaluateRegistration } from '../pdfOverlay/registration.js';
import { collectAlignmentCandidates } from '../pdfOverlay/alignmentCandidates.js';

function collectStoryCandidates(document) {
  const storyElements = new Map(
    parseElements(document, 'StbStory').map((element) => [
      String(element.getAttribute('id')),
      element,
    ]),
  );
  return Object.freeze(
    parseStories(document).map((story, index) => {
      const element = storyElements.get(String(story.id));
      return Object.freeze({
        sourceRef: Object.freeze({
          elementType: 'Story',
          elementId: String(story.id),
          guid: element?.getAttribute('guid') || null,
        }),
        name: story.name == null ? null : String(story.name),
        height: Number(story.height),
        order: index,
      });
    }),
  );
}

/**
 * 部材×XPathキー単位でfactsをcacheするresolver。documentは呼出し元が固定したsnapshot。
 * @returns {(ref:object, keys:string[]) => object}
 */
function createCachedTagFactsResolver(document, source) {
  const cache = new Map();
  return (ref, keys) => {
    if (!Array.isArray(keys)) throw new TypeError('取得するXPathキー配列が必要です。');
    const memberKey = elementRefKey(ref);
    let entry = cache.get(memberKey);
    const pending = [...new Set(keys)].filter((key) => !entry?.fields.has(key));
    if (!entry || pending.length > 0) {
      const facts = createStbMemberTagFactsFromDocument({ document, source, ref, keys: pending });
      if (!entry) {
        entry = { facts, fields: new Map() };
        cache.set(memberKey, entry);
      }
      for (const key of pending) entry.fields.set(key, facts.fields[key]);
    }
    return {
      ...entry.facts,
      fields: Object.fromEntries(keys.map((key) => [key, entry.fields.get(key)])),
    };
  };
}

function storyViewWithSourceRef(stories, storyCandidates, storyId) {
  const view = createStoryPlanView(stories, String(storyId));
  const candidate = storyCandidates.find(
    (item) => String(item.sourceRef.elementId) === String(view.storyId),
  );
  if (!candidate) throw new Error('対象階のStory sourceRefを構築できません。');
  return Object.freeze({ ...view, storySourceRef: candidate.sourceRef });
}

async function readStbRevisionText(file) {
  if (typeof file?.arrayBuffer === 'function') {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 256));
    const declared = /<\?xml\s+[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1]?.toLowerCase();
    let encoding = declared || 'utf-8';
    if (encoding === 'utf8') encoding = 'utf-8';
    if (encoding === 'shift-jis' || encoding === 'sjis') encoding = 'shift_jis';
    return new TextDecoder(encoding).decode(bytes);
  }
  if (typeof file?.text === 'function') return file.text();
  throw new TypeError('STB Fileが必要です。');
}

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
    async createDxfReferenceDrawing({
      file,
      documentId,
      unitOverride = null,
      placement = {},
    } = {}) {
      if (!file || typeof file.arrayBuffer !== 'function')
        throw new TypeError('DXF Fileが必要です。');
      if (typeof documentId !== 'string' || !documentId.trim())
        throw new TypeError('DXF参照documentIdが必要です。');
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const revision = await digest(bytes);
      if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision))
        throw new Error('DXF改訂SHA-256が不正です。');
      const decoded = decodeDxfArrayBuffer(bytes);
      const referenceDrawing = parseDxfReferenceDrawing(decoded.text, {
        documentId,
        revision,
        filename: file.name || null,
        unitOverride,
        placement,
      });
      const assetDescriptor = createDxfReferenceAssetDescriptor({
        referenceDrawing,
        byteLength: bytes.byteLength,
        encoding: decoded.encoding,
        fallbackFrom: decoded.fallbackFrom || null,
        unitOverride,
      });
      return Object.freeze({
        referenceDrawing,
        assetDescriptor,
        encoding: decoded.encoding,
        fallbackFrom: decoded.fallbackFrom || null,
        revision,
        byteLength: bytes.byteLength,
      });
    },
    async restoreDxfReferenceDrawing({ file, assetDescriptor } = {}) {
      if (!file || typeof file.arrayBuffer !== 'function')
        throw new TypeError('DXF原本Fileが必要です。');
      const descriptor = assertDxfReferenceAssetDescriptor(assetDescriptor);
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.byteLength !== descriptor.source.byteLength)
        throw new Error(
          `DXF原本byteLengthが保存値と一致しません: ${bytes.byteLength} != ${descriptor.source.byteLength}`,
        );
      const revision = await digest(bytes);
      if (revision !== descriptor.source.revision)
        throw new Error('DXF原本SHA-256が保存済みrevisionと一致しません。');
      const decoded = decodeDxfArrayBuffer(bytes);
      if (decoded.encoding !== descriptor.decoding.encoding)
        throw new Error(
          `DXF文字encodingが保存値と一致しません: ${decoded.encoding} != ${descriptor.decoding.encoding}`,
        );
      const decodedFallback = decoded.fallbackFrom || null;
      const savedFallback = descriptor.decoding.fallbackFrom || null;
      if (decodedFallback !== savedFallback)
        throw new Error(
          `DXF文字decode fallbackが保存値と一致しません: ${decodedFallback} != ${savedFallback}`,
        );
      const referenceDrawing = parseDxfReferenceDrawingFromAsset(decoded.text, descriptor);
      return Object.freeze({
        referenceDrawing,
        assetDescriptor: descriptor,
        encoding: decoded.encoding,
        fallbackFrom: decoded.fallbackFrom || null,
        revision,
        byteLength: bytes.byteLength,
      });
    },
    solveSimilarity,
    createRegistrationInput,
    evaluateRegistration,
    multiplyAffine,
    invertAffine,
    transformPoint,
    renderDrawingSvg,
    compileDimensions: compileDrawingRenderDimensions,
    createSheetLayout: createDrawingSheetLayout,
    createSheetRenderPlan: createDrawingSheetRenderPlan,
    createSheetToViewportTransform,
    renderDrawingSheetSvg,
    downloadDrawingRenderPlanDxf,
    collectAlignmentCandidates: ({ modelKey, drawing }) =>
      collectAlignmentCandidates({
        document: sourceDocument(modelKey),
        drawing,
      }),
    async createTagFactsResolver({ modelKey, drawing } = {}) {
      if (
        drawing?.source?.modelKey !== modelKey ||
        typeof drawing?.source?.modelRevision !== 'string'
      )
        throw new TypeError('STB図面のsourceが不正です。');

      const original = sourceDocument(modelKey);
      const sourceXml = serialize(original);
      const currentRevision = await digest(new TextEncoder().encode(sourceXml));
      if (currentRevision !== drawing.source.modelRevision)
        throw new Error('STB図面のモデル改訂が現行モデルと一致しません。再生成してください。');
      if (serialize(sourceDocument(modelKey)) !== sourceXml)
        throw new Error('タグfacts準備中にモデルが変更されました。再生成してください。');

      return createCachedTagFactsResolver(original.cloneNode(true), drawing.source);
    },
    async inspectStbRevisionFile({ file, signal } = {}) {
      if (!file || (typeof file.text !== 'function' && typeof file.arrayBuffer !== 'function'))
        throw new TypeError('STB Fileが必要です。');
      if (signal?.aborted)
        throw new globalThis.DOMException('STB改訂差替えを中止しました。', 'AbortError');
      const sourceText = await readStbRevisionText(file);
      if (typeof globalThis.DOMParser !== 'function')
        throw new Error('STB XML読込にはDOMParserが必要です。');
      const document = new globalThis.DOMParser().parseFromString(sourceText, 'application/xml');
      if (
        document.querySelector?.('parsererror') ||
        document.documentElement?.localName !== 'ST_BRIDGE'
      )
        throw new Error('ST_BRIDGE XMLとして読み込めません。');
      const storyCandidates = collectStoryCandidates(document);
      const sourceXml = serialize(document);
      const modelRevision = await digest(new TextEncoder().encode(sourceXml));
      if (typeof modelRevision !== 'string' || !/^[0-9a-f]{64}$/.test(modelRevision))
        throw new Error('STB改訂SHA-256が不正です。');
      if (signal?.aborted)
        throw new globalThis.DOMException('STB改訂差替えを中止しました。', 'AbortError');
      return Object.freeze({
        revision: Object.freeze({ id: modelRevision, sha256: modelRevision }),
        storyCandidates,
        filename: file.name || null,
      });
    },
    async createDrawingFromStbFile({
      file,
      modelKey,
      storyId,
      signal,
      expectedRevisionSha256 = null,
    } = {}) {
      if (!file || (typeof file.text !== 'function' && typeof file.arrayBuffer !== 'function'))
        throw new TypeError('STB Fileが必要です。');
      if (modelKey !== 'A' && modelKey !== 'B')
        throw new RangeError('モデルAまたはBを選択してください。');
      if (storyId == null || !String(storyId).trim())
        throw new TypeError('対象階を指定してください。');

      const sourceText = await readStbRevisionText(file);
      if (typeof globalThis.DOMParser !== 'function')
        throw new Error('STB XML読込にはDOMParserが必要です。');
      const document = new globalThis.DOMParser().parseFromString(sourceText, 'application/xml');
      if (
        document.querySelector?.('parsererror') ||
        document.documentElement?.localName !== 'ST_BRIDGE'
      )
        throw new Error('ST_BRIDGE XMLとして読み込めません。');
      const stories = parseStories(document);
      const storyCandidates = collectStoryCandidates(document);
      const view = storyViewWithSourceRef(stories, storyCandidates, String(storyId));
      const sourceXml = serialize(document);
      const modelRevision = await digest(new TextEncoder().encode(sourceXml));
      if (typeof modelRevision !== 'string' || !/^[0-9a-f]{64}$/.test(modelRevision))
        throw new Error('STB改訂SHA-256が不正です。');
      if (
        expectedRevisionSha256 != null &&
        String(expectedRevisionSha256).toLowerCase() !== modelRevision
      )
        throw new Error('STB改訂ファイルがstaging確認時から変更されています。');

      const snapshot = document.cloneNode(true);
      const drawing = await buildDrawing({
        document: snapshot,
        source: { modelKey, modelRevision },
        view,
        signal,
      });
      const tagFactsResolver = createCachedTagFactsResolver(
        document.cloneNode(true),
        drawing.source,
      );
      return Object.freeze({
        drawing,
        revision: Object.freeze({ id: modelRevision, sha256: modelRevision }),
        tagFactsResolver,
        storyCandidates,
        filename: file.name || null,
      });
    },
    async createDrawing({ modelKey, view, signal } = {}) {
      const original = sourceDocument(modelKey);
      // 改訂判定の正本は「clone後のserialization」ではなく読込済みsource Documentそのもの。
      // cloneNode(true)後はブラウザDOM実装によりnamespace宣言等のserializationが変化し得るため、
      // sourceとsnapshotの文字列表現を相互比較してはならない。
      const sourceXml = serialize(original);
      const snapshot = original.cloneNode(true);
      const storyCandidates = collectStoryCandidates(snapshot);
      const storyCandidate = storyCandidates.find(
        (item) => String(item.sourceRef.elementId) === String(view?.storyId),
      );
      if (!storyCandidate) throw new Error('対象階が読込済みSTBにありません。');
      const drawingView = Object.freeze({
        ...view,
        storySourceRef: storyCandidate.sourceRef,
      });
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
        view: drawingView,
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
