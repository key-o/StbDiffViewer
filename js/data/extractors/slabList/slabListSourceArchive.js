/**
 * #528: lossless auxiliary XML bytes carried inside DrawingProject.slabListState.
 * ZIP serialization stores the base64 payload in project.json; the original UTF-8
 * or other byte stream can be reconstructed without reparsing or rewriting XML.
 * Bound to A/B and a SHA-256 checksum. No external URI fetching is performed.
 */
import { normalizeSlabListState } from './slabListResolver.js';

export const SLAB_LIST_XML_MAX_BYTES = 2 * 1024 * 1024;

function inputBytes(input) {
  if (input instanceof Uint8Array) return new Uint8Array(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  throw new TypeError('Auxiliary XML must be original bytes');
}
function encodeBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768)
    text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return globalThis.btoa(text);
}
function decodeBase64(text) {
  if (
    typeof text !== 'string' ||
    text.length > Math.ceil(SLAB_LIST_XML_MAX_BYTES / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)
  )
    throw new TypeError('Invalid auxiliary XML base64');
  const binary = globalThis.atob(text);
  const bytes = Uint8Array.from(binary, (letter) => letter.charCodeAt(0));
  if (bytes.length > SLAB_LIST_XML_MAX_BYTES || encodeBase64(bytes) !== text)
    throw new TypeError('Invalid or oversized auxiliary XML');
  return bytes;
}
async function hash(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 crypto.subtle is required');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Persist complete immutable XML byte contents with an explicit model slot side. */
export async function attachSlabListXmlSource(state, { modelSide, bytes } = {}) {
  const next = normalizeSlabListState(state);
  if (modelSide !== 'A' && modelSide !== 'B') throw new TypeError('A/B required');
  const original = inputBytes(bytes);
  if (original.length > SLAB_LIST_XML_MAX_BYTES) throw new RangeError('Auxiliary XML too large');
  const sha256 = await hash(original);
  const bytesBase64 = encodeBase64(original);
  next.xmlSources = next.xmlSources.filter((s) => s.modelSide !== modelSide || s.sha256 !== sha256);
  next.xmlSources.push({ modelSide, sha256, bytesBase64 });
  return { state: normalizeSlabListState(next), sha256 };
}

/** Revalidate content hash before giving bytes to a parser, with no source rewrite. */
export async function readSlabListXmlSource(state, { modelSide, sha256 } = {}) {
  const normalized = normalizeSlabListState(state);
  const source = normalized.xmlSources.find(
    (s) => s.modelSide === modelSide && s.sha256 === sha256,
  );
  if (!source || typeof source.bytesBase64 !== 'string')
    throw new Error('Auxiliary XML source is unavailable');
  const bytes = decodeBase64(source.bytesBase64);
  if ((await hash(bytes)) !== sha256) throw new Error('Auxiliary XML SHA-256 mismatch');
  return bytes;
}

/**
 * Validate ALL persisted auxiliary XML bytes before accepting an archive.
 * A valid ZIP manifest by itself cannot attest to the nested XML source hashes.
 */
export async function verifySlabListXmlSources(state) {
  const normalized = normalizeSlabListState(state);
  for (const source of normalized.xmlSources) {
    const bytes = decodeBase64(source.bytesBase64);
    if ((await hash(bytes)) !== source.sha256) throw new Error('Auxiliary XML SHA-256 mismatch');
  }
}
