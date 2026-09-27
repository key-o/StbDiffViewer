/**
 * @fileoverview JSON Schema + XSD parity 検証の公開エントリーポイント。
 *
 * バージョン別属性検証本体は jsonSchemaValidatorCore.js に保持し、
 * XSD 1.0 との差分（namespace / sequence / choice / simple content）を
 * jsonSchemaParityValidator.js で補完する。
 */

export { validateJsonSchema } from './jsonSchemaParityValidator.js';
