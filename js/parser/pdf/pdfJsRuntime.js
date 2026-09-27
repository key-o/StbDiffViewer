/** @fileoverview 固定版PDF.js runtime。実行時はローカル同梱資産だけを参照する。 */
const PDFJS_VERSION = '5.4.624';

function applicationBaseUrl() {
  const documentBase = globalThis.document?.baseURI;
  return documentBase ? new URL('./', documentBase) : new URL('../../../', import.meta.url);
}

const PDFJS_BASE_URL = new URL(`vendor/pdfjs/${PDFJS_VERSION}/`, applicationBaseUrl());
const PDFJS_MODULE_URL = new URL('build/pdf.mjs', PDFJS_BASE_URL).href;
const PDFJS_WORKER_URL = new URL('build/pdf.worker.mjs', PDFJS_BASE_URL).href;
const PDFJS_ASSET_URLS = Object.freeze({
  cMapUrl: new URL('cmaps/', PDFJS_BASE_URL).href,
  standardFontDataUrl: new URL('standard_fonts/', PDFJS_BASE_URL).href,
  wasmUrl: new URL('wasm/', PDFJS_BASE_URL).href,
  iccUrl: new URL('iccs/', PDFJS_BASE_URL).href,
});

let runtimePromise = null;

export function getPdfJsRuntimeInfo() {
  return Object.freeze({
    version: PDFJS_VERSION,
    moduleUrl: PDFJS_MODULE_URL,
    workerUrl: PDFJS_WORKER_URL,
    assetUrls: PDFJS_ASSET_URLS,
    distribution: 'local-release',
  });
}

export async function loadPdfJsRuntime() {
  if (!runtimePromise) {
    runtimePromise = import(/* @vite-ignore */ PDFJS_MODULE_URL)
      .then((pdfjs) => {
        if (typeof pdfjs?.getDocument !== 'function')
          throw new Error('PDF.js runtimeの読込に失敗しました。');
        if (pdfjs.version && pdfjs.version !== PDFJS_VERSION) {
          throw new Error(
            `PDF.js API/Worker版が一致しません: ${pdfjs.version} != ${PDFJS_VERSION}`,
          );
        }
        if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return pdfjs;
      })
      .catch((error) => {
        runtimePromise = null;
        const wrapped = new Error(
          `PDF.js ${PDFJS_VERSION} のローカル資産を読み込めません。npm run setup:pdfjs を実行してください。`,
        );
        wrapped.cause = error;
        throw wrapped;
      });
  }
  return runtimePromise;
}
