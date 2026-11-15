/** @fileoverview A3 SVG sheet => genuine PDF geometry. Issue #493. */
import { svg2pdf } from '../../../../vendor/svg2pdf-v2.7.0.mjs';
import { verifyPdfPrintFont } from './PdfOverlayPrintFont.js';

const FONT_FAMILY = 'SDVPrintFont';
const FONT_NAME = 'sdv-user-print-font.ttf';
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const BAD_SVG_CONTENT =
  'script, foreignObject, iframe, object, embed, animate, animateTransform, set';

/** Standard PDF fonts do not contain Japanese or most Unicode glyphs. */
export function svgNeedsEmbeddedFont(svg) {
  return Array.from(svg.querySelectorAll('text')).some((node) =>
    /[^\x00-\x7f]/.test(node.textContent || ''),
  );
}

/**
 * svg2pdf resolves CSS paint URLs and may request remote resources.  The
 * exported SVG must be entirely self-contained; local fragment IDs are OK.
 */
function validateSvgResourceValue(value) {
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!match[2].trim().startsWith('#'))
      throw new Error('外部参照のある図面データはベクターPDFとして保存できません。');
  }
}

export function validatePdfVectorSvg(svg) {
  if (svg.querySelector(BAD_SVG_CONTENT))
    throw new Error(
      '安全上、スクリプトや外部コンテンツを含む図面データはベクターPDFに変換できません。',
    );
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of element.attributes) {
      if (/^on[a-z]+$/i.test(attr.name))
        throw new Error('スクリプト属性を含む図面データはベクターPDFに変換できません。');
      if (attr.localName === 'href' && attr.value && !attr.value.trim().startsWith('#'))
        throw new Error('外部参照のある図面データはベクターPDFとして保存できません。');
      validateSvgResourceValue(attr.value);
    }
    if (element.localName === 'style') {
      if (/@import\b/i.test(element.textContent || ''))
        throw new Error('外部CSSを参照する図面データはベクターPDFとして保存できません。');
      validateSvgResourceValue(element.textContent || '');
    }
  }
}

/**
 * svg2pdf.js paints the stroke over a text glyph's fill (PDF text mode 2).
 * SDV uses a white SVG text halo; at print sizes that stroke masks the letters.
 * Preserve text fill, but suppress the halo only on the detached print SVG.
 * Pure outline-only labels (explicit fill:none) retain their intended stroke.
 */
export function preparePdfVectorTextPaint(svg) {
  for (const node of svg.querySelectorAll('text, tspan')) {
    // A stylesheet can declare fill:none without any SVG presentation
    // attribute. Resolve CSS before changing an outline-only text node.
    const computedFill = node.ownerDocument?.defaultView?.getComputedStyle?.(node)?.fill;
    let outlineOnly = computedFill?.trim().toLowerCase() === 'none';
    for (let ancestor = node; ancestor && ancestor !== svg; ancestor = ancestor.parentElement) {
      const fill = ancestor.style?.fill || ancestor.getAttribute?.('fill');
      if (fill?.trim().toLowerCase() === 'none') {
        outlineOnly = true;
        break;
      }
      if (fill) break;
    }
    if (outlineOnly) continue;
    node.setAttribute('stroke', 'none');
    node.setAttribute('stroke-width', '0');
    node.style.setProperty('stroke', 'none', 'important');
    node.style.setProperty('stroke-width', '0', 'important');
  }
}

/**
 * svg2pdf.js may center custom-font text with a width unrelated to the glyph
 * advance actually written to PDF. On the detached A3 SVG, both user units
 * and jsPDF units are millimeters (the SVG viewBox is 420 x 297).
 * Resolve middle/end anchoring with the registered PDF font metrics, then
 * send svg2pdf start-aligned text. This also works for rotated text because
 * the x shift occurs in the text's local coordinate system.
 */
export function preparePdfVectorTextAlignment(svg, pdf) {
  if (typeof pdf.getTextWidth !== 'function' || typeof pdf.setFontSize !== 'function') return;
  const originalFontSize = typeof pdf.getFontSize === 'function' ? pdf.getFontSize() : null;
  const resolveAttribute = (node, attr, styleProperty) => {
    // CSS declarations override SVG presentation attributes and may override
    // inherited values. Read the effective style first; JSDOM may return an
    // empty value for SVG presentation attributes, so retain the fallback.
    // The A3 print SVG uses a 1:1 CSS-px-to-viewBox-unit scale.
    const computed = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    const effective = computed?.[styleProperty] || computed?.getPropertyValue?.(attr);
    if (effective && effective !== 'inherit') return effective;
    for (
      let current = node;
      current && current !== svg.parentElement;
      current = current.parentElement
    ) {
      const inline = current.style?.[styleProperty];
      const value = inline || current.getAttribute?.(attr);
      if (value) return value;
      if (current === svg) break;
    }
    return null;
  };
  const alignOne = (node) => {
    const anchor = String(resolveAttribute(node, 'text-anchor', 'textAnchor') || 'start').trim();
    if (anchor !== 'middle' && anchor !== 'end') return;
    const position = node.getAttribute('x');
    const size = resolveAttribute(node, 'font-size', 'fontSize');
    if (position == null || size == null) return;
    // Do not silently rewrite unsupported coordinate lists or CSS units.
    const isPlainLength = (value) =>
      /^-?(?:[0-9]+[.]?[0-9]*|[.][0-9]+)(?:px)?$/.test(String(value).trim());
    if (!isPlainLength(position) || !isPlainLength(size)) return;
    const x = Number.parseFloat(position);
    const fontMm = Number.parseFloat(size);
    if (!Number.isFinite(x) || !Number.isFinite(fontMm) || fontMm <= 0) return;
    const content = node.textContent || '';
    if (!content.trim()) return;
    pdf.setFontSize((fontMm * 72) / 25.4);
    const widthMm = pdf.getTextWidth(content);
    if (!Number.isFinite(widthMm) || widthMm < 0)
      throw new Error('PDF文字幅の計算に失敗しました。');
    node.setAttribute('x', String(x - widthMm * (anchor === 'middle' ? 0.5 : 1)));
    node.setAttribute('text-anchor', 'start');
    node.style.setProperty('text-anchor', 'start', 'important');
  };
  try {
    for (const text of svg.querySelectorAll('text')) {
      const explicitSpans = [...text.querySelectorAll('tspan[x]')];
      if (explicitSpans.length) {
        for (const span of explicitSpans) alignOne(span);
      } else {
        alignOne(text);
      }
    }
  } finally {
    if (originalFontSize != null) pdf.setFontSize(originalFontSize);
  }
}

/** Do not embed a Windows system font automatically: the user supplies a legally embeddable TTF. */
export async function embedPdfPrintFont(pdf, svg, file) {
  if (!file?.name?.toLowerCase().endsWith('.ttf') || typeof file.arrayBuffer !== 'function')
    throw new Error('日本語には埋め込み許可のあるTrueType（.ttf）フォントを選択してください。');
  if (Number(file.size) > MAX_FONT_BYTES)
    throw new Error('PDF用フォントは32MB以下のTrueTypeファイルを指定してください。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (
    bytes.length < 12 ||
    bytes.length > MAX_FONT_BYTES ||
    !(bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
  )
    throw new Error(
      '指定フォントは対応するTrueType形式ではありません。OTF/TTC/WOFFは利用できません。',
    );
  if (typeof globalThis.btoa !== 'function')
    throw new Error('この環境ではフォント埋め込みに必要なBase64変換を利用できません。');

  // Check the font's OS/2 embedding flags and all drawing glyphs before registering it.
  // Copyright/license terms must still be checked separately by the user.
  verifyPdfPrintFont(
    bytes,
    Array.from(svg.querySelectorAll('text'))
      .map((element) => element.textContent || '')
      .join(''),
  );

  const chunks = [];
  for (let i = 0; i < bytes.length; i += 16384)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  pdf.addFileToVFS(FONT_NAME, globalThis.btoa(chunks.join('')));
  // jsPDF's TrueType plugin reports some parse failures only through PubSub
  // (console.error) and may otherwise emit a PDF without an embedded font.
  // Check each registered style before rendering or saving a document.
  for (const style of ['normal', 'bold', 'italic', 'bolditalic']) {
    pdf.addFont(FONT_NAME, FONT_FAMILY, style, 'Identity-H');
    pdf.setFont(FONT_FAMILY, style);
    const registered = pdf.getFont();
    if (
      registered?.encoding !== 'Identity-H' ||
      !registered.metadata?.Unicode?.widths ||
      !registered.metadata?.cmap
    )
      throw new Error(
        '指定TTFをPDFに登録できませんでした。文字が欠けたPDFは保存しません。別のTrueTypeフォントを選択してください。',
      );
  }
  pdf.setFont(FONT_FAMILY, 'normal');

  // Only the detached print SVG is updated. The live drawing is not touched.
  for (const text of svg.querySelectorAll('text, tspan')) {
    text.setAttribute('font-family', FONT_FAMILY);
    text.style.fontFamily = FONT_FAMILY;
  }
}

/**
 * Render the already-prepared/cloned A3 SVG in mm. No JPEG rasterization.
 * A checked, user-supplied font is required for Japanese text. Fail loudly
 * instead of silently producing a PDF with missing glyphs.
 */
export async function renderSvgToVectorPdf(
  svg,
  layout,
  { JsPdf, fontFile = null, render = svg2pdf } = {},
) {
  validatePdfVectorSvg(svg);
  if (svgNeedsEmbeddedFont(svg) && !fontFile)
    throw new Error(
      '日本語を含むベクターPDFには埋め込み可能な日本語TTFフォントが必要です。出力タブでフォントを選択するか「ラスタ（互換）」を選択してください。',
    );
  // eslint-disable-next-line new-cap
  const pdf = new JsPdf({
    orientation: layout.widthMm >= layout.heightMm ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [layout.widthMm, layout.heightMm],
    compress: true,
    precision: 8,
    putOnlyUsedFonts: true,
  });
  if (fontFile) await embedPdfPrintFont(pdf, svg, fontFile);
  preparePdfVectorTextPaint(svg);
  preparePdfVectorTextAlignment(svg, pdf);
  await render(svg, pdf, { x: 0, y: 0, width: layout.widthMm, height: layout.heightMm });
  return pdf;
}
