/**
 * #423 P2 (core only): self-contained STB + DrawingProject archive.
 * The caller supplies ORIGINAL STB bytes; neither SVG nor DXF is authoritative.
 * No browser storage, DOM, file URLs, or process APIs are used here.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { verifySlabListXmlSources } from '../extractors/slabList/slabListSourceArchive.js';
import {
  normalizeDrawingProject,
  parseDrawingProject,
  serializeDrawingProject,
} from './drawingProjectSchema.js';

export const DRAWING_PROJECT_ARCHIVE_KIND = 'stb-diff-viewer.drawing-project-archive';
export const DRAWING_PROJECT_ARCHIVE_VERSION = 1;
const PROJECT_PATH = 'drawings/project.json';
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const FONT_PATH = 'assets/fonts/print.ttf';

function validFontName(name) {
  if (
    typeof name !== 'string' ||
    !name.toLowerCase().endsWith('.ttf') ||
    name.length > 120 ||
    name.length <= 4
  )
    return false;
  return !Array.from(name).some((character) => {
    const code = character.charCodeAt(0);
    return character === '/' || character === '\\' || code < 32 || code === 127;
  });
}

function validTrueTypeBytes(bytes) {
  return (
    bytes.length >= 12 &&
    bytes.length <= MAX_FONT_BYTES &&
    bytes[0] === 0 &&
    bytes[1] === 1 &&
    bytes[2] === 0 &&
    bytes[3] === 0
  );
}

export class DrawingProjectArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrawingProjectArchiveError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new DrawingProjectArchiveError(code, message);
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  reject('INVALID_BYTES', 'Expected STB or archive bytes (Uint8Array/ArrayBuffer).');
}

async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) reject('CRYPTO_UNAVAILABLE', 'SHA-256 is required.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
}

function safePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 200 &&
    /^[a-z0-9_.\-/]+$/.test(path) &&
    !path.startsWith('/') &&
    !path.endsWith('/') &&
    path.split('/').every((segment) => segment !== '.' && segment !== '..' && segment.length)
  );
}

function objectWithKeys(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(code, 'Invalid object.');
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject(code, 'Unknown field.');
  return value;
}

function revisionKey(modelSlotId, sourceRevisionId) {
  // A delimiter is ambiguous if persisted IDs contain that delimiter.
  return JSON.stringify([modelSlotId, sourceRevisionId]);
}

function archivePaths(project) {
  const paths = new Map();
  project.modelSlots.forEach((slot, slotIndex) => {
    slot.revisions.forEach((revision, revisionIndex) => {
      const path = `sources/slot-${slotIndex}/revision-${revisionIndex}.stb`;
      paths.set(revisionKey(slot.id, revision.id), { slot, revision, path });
    });
  });
  return paths;
}

/** Create a ZIP, requiring *all* STB revisions declared by DrawingProject. */
async function checkSlabListXmlIntegrity(project) {
  if (!project.slabListState) return;
  try {
    await verifySlabListXmlSources(project.slabListState);
  } catch {
    reject('SLAB_XML_INTEGRITY_FAILED', 'Embedded auxiliary XML bytes/hash mismatch.');
  }
}

export async function createDrawingProjectArchive({
  project,
  sourceRevisions,
  referenceAssets = [],
  fontAsset = null,
} = {}) {
  const normalized = normalizeDrawingProject(project);
  await checkSlabListXmlIntegrity(normalized);
  if (!Array.isArray(sourceRevisions))
    reject('MISSING_SOURCES', 'Original STB bytes are required.');
  const expected = archivePaths(normalized);
  const provided = new Map();
  for (const source of sourceRevisions) {
    if (!source || typeof source !== 'object')
      reject('INVALID_SOURCE_DESCRIPTOR', 'Source revision descriptor must be an object.');
    const key = revisionKey(source.modelSlotId, source.sourceRevisionId);
    if (provided.has(key)) reject('DUPLICATE_SOURCE', 'Duplicated source revision.');
    if (!expected.has(key)) reject('UNKNOWN_SOURCE', 'Undeclared source revision.');
    provided.set(key, bytesOf(source.bytes));
  }
  if (provided.size !== expected.size)
    reject('MISSING_SOURCES', 'All declared STB revisions are required.');

  const files = [{ path: PROJECT_PATH, bytes: strToU8(serializeDrawingProject(normalized)) }];
  const sources = [];
  for (const [key, { slot, revision, path }] of expected) {
    const bytes = provided.get(key);
    if (bytes.length > MAX_FILE_BYTES) reject('SIZE_LIMIT', `Source exceeds size limit: ${path}`);
    if ((await sha256(bytes)) !== (revision.originalSha256 || revision.sha256))
      reject(
        'SOURCE_HASH_MISMATCH',
        `STB bytes do not match declared revision: ${slot.id}/${revision.id}`,
      );
    files.push({ path, bytes });
    sources.push({ modelSlotId: slot.id, sourceRevisionId: revision.id, path });
  }
  // Reference DXF originals are immutable ZIP assets, not DrawingModel geometry.
  // Their descriptors retain import units, placement and decoding profile.
  if (!Array.isArray(referenceAssets)) reject('INVALID_ASSETS', 'DXF assets must be an array.');
  const listedReferenceAssets = [];
  const seenReferenceIds = new Set();
  for (const [index, asset] of referenceAssets.entries()) {
    const bytes = bytesOf(asset?.bytes);
    const descriptor = asset?.descriptor;
    const documentId = asset?.documentId;
    if (
      typeof documentId !== 'string' ||
      !documentId ||
      ['__proto__', 'prototype', 'constructor'].includes(documentId) ||
      seenReferenceIds.has(documentId) ||
      descriptor?.kind !== 'DxfReferenceAssetDescriptor' ||
      descriptor.source?.documentId !== documentId ||
      descriptor.source?.byteLength !== bytes.length ||
      descriptor.source?.revision !== (await sha256(bytes))
    )
      reject('INVALID_REFERENCE_ASSET', 'DXF原本と保存descriptorが一致しません。');
    if (bytes.length > MAX_FILE_BYTES) reject('SIZE_LIMIT', 'DXF原本がサイズ制限を超えています。');
    if (
      asset.display != null &&
      (typeof asset.display !== 'object' || Array.isArray(asset.display))
    )
      reject('INVALID_REFERENCE_ASSET', 'DXF表示状態が不正です。');
    seenReferenceIds.add(documentId);
    const path = `assets/dxf/${index}.dxf`;
    listedReferenceAssets.push({
      documentId,
      path,
      descriptor: JSON.parse(JSON.stringify(descriptor)),
      display: asset.display == null ? null : JSON.parse(JSON.stringify(asset.display)),
    });
    files.push({ path, bytes });
  }
  // Explicitly supplied TTF only. The calling UI must confirm redistribution
  // permission; reading a system font automatically is never allowed.
  let listedFontAsset = null;
  if (fontAsset != null) {
    if (!fontAsset || typeof fontAsset !== 'object' || Array.isArray(fontAsset))
      reject('INVALID_FONT_ASSET', 'PDFフォント原本の指定が不正です。');
    const fontBytes = bytesOf(fontAsset.bytes);
    if (!validFontName(fontAsset.name) || !validTrueTypeBytes(fontBytes))
      reject('INVALID_FONT_ASSET', '32MiB以下のTrueType（.ttf）原本だけをZIPに保存できます。');
    listedFontAsset = {
      path: FONT_PATH,
      name: fontAsset.name,
      byteLength: fontBytes.length,
      sha256: await sha256(fontBytes),
    };
    files.push({ path: FONT_PATH, bytes: fontBytes });
  }
  if (files.some(({ bytes }) => bytes.length > MAX_FILE_BYTES))
    reject('SIZE_LIMIT', 'Archive entry exceeds size limit.');
  if (
    files.length + 1 > MAX_ENTRIES ||
    files.reduce((sum, f) => sum + f.bytes.length, 0) > MAX_TOTAL_BYTES
  )
    reject('SIZE_LIMIT', 'Archive payload exceeds size limit.');
  const entries = [];
  for (const file of files) {
    entries.push({
      path: file.path,
      sha256: await sha256(file.bytes),
      byteLength: file.bytes.length,
    });
  }
  const manifest = {
    kind: DRAWING_PROJECT_ARCHIVE_KIND,
    archiveSchemaVersion: DRAWING_PROJECT_ARCHIVE_VERSION,
    projectId: normalized.projectId,
    files: entries,
    sources,
    ...(listedReferenceAssets.length ? { referenceAssets: listedReferenceAssets } : {}),
    ...(listedFontAsset ? { fontAsset: listedFontAsset } : {}),
  };
  const zipEntries = Object.fromEntries([
    ['manifest.json', strToU8(JSON.stringify(manifest, null, 2))],
    ...files.map(({ path, bytes }) => [path, bytes]),
  ]);
  const archive = zipSync(zipEntries, { level: 6 });
  if (archive.length > MAX_ARCHIVE_BYTES)
    reject('SIZE_LIMIT', 'Compressed archive exceeds size limit.');
  return archive;
}

/** Validate central directory metadata before asking fflate to allocate inflated entries. */
function preflightArchive(bytes) {
  if (bytes.length > MAX_ARCHIVE_BYTES || bytes.length < 22)
    reject('INVALID_ARCHIVE_SIZE', 'Invalid or oversized ZIP.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (i) => view.getUint16(i, true);
  const u32 = (i) => view.getUint32(i, true);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end === -1 || u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== u16(end + 10))
    reject('INVALID_ZIP_DIRECTORY', 'Missing, multi-disk, or invalid ZIP directory.');
  const count = u16(end + 10);
  const directoryLength = u32(end + 12);
  const directoryOffset = u32(end + 16);
  if (
    count === 0 ||
    count > MAX_ENTRIES ||
    directoryLength === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directoryLength !== end
  )
    reject('INVALID_ZIP_DIRECTORY', 'Unsupported ZIP directory.');
  let position = directoryOffset;
  let totalSize = 0;
  const seen = new Set();
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || u32(position) !== 0x02014b50)
      reject('INVALID_ZIP_DIRECTORY', 'Corrupted central entry.');
    const flags = u16(position + 8);
    const method = u16(position + 10);
    const compressed = u32(position + 20);
    const inflated = u32(position + 24);
    const nameLength = u16(position + 28);
    const extraLength = u16(position + 30);
    const commentLength = u16(position + 32);
    const localOffset = u32(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      (flags & ~0x0800) !== 0 ||
      ![0, 8].includes(method) ||
      compressed === 0xffffffff ||
      inflated === 0xffffffff
    )
      reject('INVALID_ZIP_ENTRY', 'Unsupported or unsafe ZIP entry.');
    const path = strFromU8(bytes.subarray(position + 46, position + 46 + nameLength));
    if (!safePath(path) || seen.has(path))
      reject('UNSAFE_ZIP_PATH', 'Unsafe or duplicate ZIP entry.');
    seen.add(path);
    totalSize += inflated;
    if (inflated > MAX_FILE_BYTES || totalSize > MAX_TOTAL_BYTES)
      reject('SIZE_LIMIT', 'Decompressed content exceeds size limit.');
    if (
      localOffset + 30 > directoryOffset ||
      u32(localOffset) !== 0x04034b50 ||
      u16(localOffset + 6) !== flags ||
      u16(localOffset + 8) !== method ||
      u32(localOffset + 14) !== u32(position + 16) ||
      u32(localOffset + 18) !== compressed ||
      u32(localOffset + 22) !== inflated
    )
      reject('INVALID_ZIP_ENTRY', 'Invalid ZIP local file header.');
    const localNameLength = u16(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength + u16(localOffset + 28);
    if (
      dataStart + compressed > directoryOffset ||
      strFromU8(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)) !== path
    )
      reject('INVALID_ZIP_ENTRY', 'ZIP entry bounds or local name mismatch.');
    position = next;
  }
  if (position !== end) reject('INVALID_ZIP_DIRECTORY', 'Unexpected central directory bytes.');
  return seen;
}

/** Fail closed: do not mutate runtime/project until all entries and hashes validate. */
export async function readDrawingProjectArchive(input) {
  const bytes = bytesOf(input);
  const paths = preflightArchive(bytes);
  let archive;
  try {
    archive = unzipSync(bytes);
  } catch {
    reject('INVALID_ZIP_DATA', 'ZIP decompression failed.');
  }
  if (!paths.has('manifest.json')) reject('MISSING_MANIFEST', 'manifest.json is required.');
  let manifest;
  try {
    manifest = JSON.parse(strFromU8(archive['manifest.json']));
  } catch {
    reject('INVALID_MANIFEST', 'Manifest JSON is invalid.');
  }
  objectWithKeys(
    manifest,
    [
      'kind',
      'archiveSchemaVersion',
      'projectId',
      'files',
      'sources',
      'referenceAssets',
      'fontAsset',
    ],
    'INVALID_MANIFEST',
  );
  if (
    manifest.kind !== DRAWING_PROJECT_ARCHIVE_KIND ||
    manifest.archiveSchemaVersion !== DRAWING_PROJECT_ARCHIVE_VERSION
  )
    reject('UNSUPPORTED_ARCHIVE_VERSION', 'Unknown archive kind or version.');
  if (
    typeof manifest.projectId !== 'string' ||
    !manifest.projectId ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.sources)
  )
    reject('INVALID_MANIFEST', 'Manifest fields are missing.');
  if (manifest.files.length + 1 !== paths.size || manifest.files.length > MAX_ENTRIES)
    reject('UNEXPECTED_ZIP_ENTRY', 'Manifest file list and ZIP entries disagree.');
  const listed = new Set(['manifest.json']);
  for (const file of manifest.files) {
    objectWithKeys(file, ['path', 'sha256', 'byteLength'], 'INVALID_MANIFEST');
    if (
      !safePath(file.path) ||
      listed.has(file.path) ||
      !paths.has(file.path) ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 0 ||
      file.byteLength > MAX_FILE_BYTES ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      reject('INVALID_MANIFEST', 'Invalid file descriptor.');
    listed.add(file.path);
    const content = archive[file.path];
    if (!content || content.length !== file.byteLength || (await sha256(content)) !== file.sha256)
      reject('FILE_INTEGRITY_FAILED', `Archive integrity check failed: ${file.path}`);
  }
  if (!listed.has(PROJECT_PATH)) reject('MISSING_PROJECT', 'DrawingProject is missing.');
  const project = parseDrawingProject(strFromU8(archive[PROJECT_PATH]));
  await checkSlabListXmlIntegrity(project);
  if (project.projectId !== manifest.projectId)
    reject('PROJECT_ID_MISMATCH', 'Project identity mismatch.');
  const expected = archivePaths(project);
  const assetEntries = manifest.referenceAssets ?? [];
  if (!Array.isArray(assetEntries)) reject('INVALID_REFERENCE_ASSET', 'Invalid DXF asset list.');
  if (
    manifest.sources.length !== expected.size ||
    manifest.files.length !==
      expected.size + 1 + assetEntries.length + (manifest.fontAsset == null ? 0 : 1)
  )
    reject('SOURCE_LIST_MISMATCH', 'All source revisions and DXF assets must be in the ZIP.');
  const result = [];
  const found = new Set();
  for (const source of manifest.sources) {
    objectWithKeys(source, ['modelSlotId', 'sourceRevisionId', 'path'], 'INVALID_MANIFEST');
    const key = revisionKey(source.modelSlotId, source.sourceRevisionId);
    const item = expected.get(key);
    if (!item || found.has(key) || item.path !== source.path || !listed.has(item.path))
      reject('SOURCE_LIST_MISMATCH', 'Unknown, duplicate, or misplaced STB revision.');
    found.add(key);
    const stb = archive[item.path];
    if ((await sha256(stb)) !== (item.revision.originalSha256 || item.revision.sha256))
      reject('SOURCE_HASH_MISMATCH', 'STB does not match DrawingProject revision hash.');
    result.push({
      modelSlotId: source.modelSlotId,
      sourceRevisionId: source.sourceRevisionId,
      bytes: stb,
    });
  }
  const referenceAssets = [];
  const seenIds = new Set();
  for (const [index, asset] of assetEntries.entries()) {
    objectWithKeys(
      asset,
      ['documentId', 'path', 'descriptor', 'display'],
      'INVALID_REFERENCE_ASSET',
    );
    const expectedPath = `assets/dxf/${index}.dxf`;
    const bytes = archive[expectedPath];
    const descriptor = asset.descriptor;
    if (
      asset.path !== expectedPath ||
      !listed.has(expectedPath) ||
      typeof asset.documentId !== 'string' ||
      !asset.documentId ||
      ['__proto__', 'prototype', 'constructor'].includes(asset.documentId) ||
      seenIds.has(asset.documentId) ||
      !bytes ||
      descriptor?.kind !== 'DxfReferenceAssetDescriptor' ||
      descriptor.source?.documentId !== asset.documentId ||
      descriptor.source?.byteLength !== bytes.length ||
      descriptor.source?.revision !== (await sha256(bytes)) ||
      (asset.display != null && (typeof asset.display !== 'object' || Array.isArray(asset.display)))
    )
      reject('INVALID_REFERENCE_ASSET', 'DXF原本またはdescriptorが不正です。');
    seenIds.add(asset.documentId);
    referenceAssets.push({
      documentId: asset.documentId,
      descriptor,
      display: asset.display ?? null,
      bytes: new Uint8Array(bytes),
    });
  }
  let fontAsset = null;
  if (manifest.fontAsset != null) {
    const font = objectWithKeys(
      manifest.fontAsset,
      ['path', 'name', 'byteLength', 'sha256'],
      'INVALID_FONT_ASSET',
    );
    const bytes = archive[FONT_PATH];
    if (
      font.path !== FONT_PATH ||
      !listed.has(FONT_PATH) ||
      !validFontName(font.name) ||
      !bytes ||
      !validTrueTypeBytes(bytes) ||
      font.byteLength !== bytes.length ||
      font.sha256 !== (await sha256(bytes))
    )
      reject('INVALID_FONT_ASSET', 'ZIP内のPDFフォント原本が不正です。');
    fontAsset = { name: font.name, bytes: new Uint8Array(bytes) };
  }
  return { project, sourceRevisions: result, referenceAssets, fontAsset };
}
