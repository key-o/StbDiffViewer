/**
 * #650: prepare replacement model documents before clearing the live 3D scene.
 * This is a parse/input-identity gate, NOT a rollback transaction for rendering.
 * The imported parser may populate caches/schema selection while preparing.
 */
export async function prepareModelLoad({ fileA, fileB, processDocuments, readSelectedFiles }) {
  if (typeof processDocuments !== 'function' || typeof readSelectedFiles !== 'function')
    throw new TypeError('STB事前解析・選択状態確認サービスが必要です。');

  const result = await processDocuments(fileA, fileB);
  if (!result || (!result.modelADocument && !result.modelBDocument))
    throw new Error('STB事前解析でモデル文書を取得できませんでした。');
  if (
    Boolean(fileA) !== Boolean(result.modelADocument) ||
    Boolean(fileB) !== Boolean(result.modelBDocument)
  ) {
    throw new Error('選択された各モデルファイルの文書を事前解析で取得できませんでした。');
  }

  // File input changes can occur programmatically even while buttons are disabled.
  // Do not authorize a destructive scene reset from a superseded async parse.
  const current = readSelectedFiles();
  if (!current || current.fileA !== fileA || current.fileB !== fileB)
    throw new Error('STB解析中にモデル選択が変更されました。再度読み込んでください。');
  return result;
}
