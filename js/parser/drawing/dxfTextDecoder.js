/** @fileoverview DXF参照取込用の副作用を持たない文字コード判定・デコード。 */

const CODEPAGE_MAP = Object.freeze({
  ANSI_932: 'shift_jis',
  ANSI_936: 'gb2312',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  'UTF-8': 'utf-8',
  UTF8: 'utf-8',
});

function asBytes(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer))
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new TypeError('DXFのArrayBufferまたはUint8Arrayが必要です。');
}

export function detectDxfTextEncoding(buffer) {
  const bytes = asBytes(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';

  const headerLength = Math.min(8192, bytes.length);
  let header = '';
  for (let index = 0; index < headerLength; index++) header += String.fromCharCode(bytes[index]);
  const codepageMatch = header.match(/\$DWGCODEPAGE[\s\S]*?\n\s*3\s*\n([^\r\n]+)/i);
  if (codepageMatch) {
    const codepage = codepageMatch[1].trim().toUpperCase();
    if (CODEPAGE_MAP[codepage]) return CODEPAGE_MAP[codepage];
    const ansi = codepage.match(/^ANSI_(\d+)$/);
    if (ansi?.[1] === '932') return 'shift_jis';
  }

  // UTF-8 Japanese bytes can also look like Shift-JIS lead/trail pairs.
  // Validate the complete stream before using the legacy byte heuristic.
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    // An explicitly declared codepage above remains authoritative.
  }

  let shiftJisScore = 0;
  let utf8Score = 0;
  for (let index = 0; index < Math.min(bytes.length, 16384); index++) {
    const value = bytes[index];
    if ((value >= 0x81 && value <= 0x9f) || (value >= 0xe0 && value <= 0xfc)) {
      const next = bytes[index + 1];
      if (next && ((next >= 0x40 && next <= 0x7e) || (next >= 0x80 && next <= 0xfc))) {
        shiftJisScore += 2;
        index += 1;
        continue;
      }
    }
    if ((value & 0xe0) === 0xc0) {
      const next = bytes[index + 1];
      if (next && (next & 0xc0) === 0x80) {
        utf8Score += 2;
        index += 1;
      }
    } else if ((value & 0xf0) === 0xe0) {
      const next1 = bytes[index + 1];
      const next2 = bytes[index + 2];
      if (next1 && next2 && (next1 & 0xc0) === 0x80 && (next2 & 0xc0) === 0x80) {
        utf8Score += 3;
        index += 2;
      }
    }
  }
  if (shiftJisScore > utf8Score && shiftJisScore > 5) return 'shift_jis';
  return 'utf-8';
}

export function decodeDxfArrayBuffer(buffer, encoding = null) {
  const bytes = asBytes(buffer);
  const selected = encoding || detectDxfTextEncoding(bytes);
  try {
    return Object.freeze({
      encoding: selected,
      text: new TextDecoder(selected).decode(bytes),
    });
  } catch (error) {
    const fallback = selected === 'shift_jis' ? 'utf-8' : 'shift_jis';
    try {
      return Object.freeze({
        encoding: fallback,
        text: new TextDecoder(fallback).decode(bytes),
        fallbackFrom: selected,
      });
    } catch {
      throw new Error(`DXF文字コード ${selected} をデコードできません: ${error.message}`);
    }
  }
}
