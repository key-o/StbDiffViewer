/** #650: no model-slot revision may publish against a stale STB-A runtime. */
export async function assertDrawingProjectSlotRuntimeCurrent({
  source,
  getCurrentDocument,
  getCurrentOriginalFile,
  expectedOriginalSha256,
  assertDrawingSourceCurrent,
  isStageCurrent,
} = {}) {
  if (source?.modelKey !== 'A' || !/^[a-f0-9]{64}$/i.test(source.modelRevision || ''))
    throw new Error('一括改訂のSTB-A sourceが不正です。');
  if (
    typeof getCurrentDocument !== 'function' ||
    typeof assertDrawingSourceCurrent !== 'function' ||
    typeof isStageCurrent !== 'function'
  )
    throw new TypeError('STB-A原本確認サービスがありません。');

  // An active model must be backed by exactly the same original STB bytes as
  // the staged revision. A semantic XML hash alone permits a different source
  // file to be installed while retaining the same DrawingModel SHA.
  const checkRawOriginal = expectedOriginalSha256 != null;
  if (
    checkRawOriginal &&
    (!/^[a-f0-9]{64}$/i.test(expectedOriginalSha256) ||
      typeof getCurrentOriginalFile !== 'function')
  )
    throw new TypeError('STB-A原本SHA-256または原本File確認サービスがありません。');

  const before = getCurrentDocument();
  if (!before) throw new Error('STB-Aランタイム原本が未読込です。改訂を確定できません。');
  const originalFile = checkRawOriginal ? getCurrentOriginalFile() : null;
  if (checkRawOriginal && (!originalFile || typeof originalFile.arrayBuffer !== 'function'))
    throw new Error('STB-Aの読込済み原本Fileがありません。改訂を確定できません。');
  try {
    await assertDrawingSourceCurrent({ source });
  } catch (cause) {
    throw new Error(
      'STB-Aランタイム原本が新改訂と一致しません。正式モデル読込との同期前に確定できません: ' +
        cause.message,
      { cause },
    );
  }
  // Semantic validation may await XML parsing. A newer revision selection or
  // replacement must revoke this stage before the potentially large byte read.
  if (
    getCurrentDocument() !== before ||
    (checkRawOriginal && getCurrentOriginalFile() !== originalFile) ||
    !isStageCurrent()
  )
    throw new Error('原本確認中にSTB-AまたはDrawingProjectが変更されました。再検証してください。');
  if (checkRawOriginal) {
    // Do not allocate unbounded binary buffers from untrusted file inputs.
    if (typeof originalFile.size === 'number' && originalFile.size > 128 * 1024 * 1024)
      throw new Error('STB-Aの読込済み原本が128MiBを超えています。');
    const bytes = await originalFile.arrayBuffer();
    if (!globalThis.crypto?.subtle) throw new Error('STB-A原本SHA-256を検証できません。');
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
    if (actual !== expectedOriginalSha256.toLowerCase())
      throw new Error('STB-Aランタイム原本のバイトSHA-256が新改訂と一致しません。');
  }
  if (
    getCurrentDocument() !== before ||
    (checkRawOriginal && getCurrentOriginalFile() !== originalFile) ||
    !isStageCurrent()
  )
    throw new Error('原本確認中にSTB-AまたはDrawingProjectが変更されました。再検証してください。');
}
