/**
 * @fileoverview UI文字列の最小i18nレイヤー
 *
 * 既存UIは日本語をデフォルトとして段階移行する。
 */

const DEFAULT_LOCALE = 'ja';

const messages = {
  ja: {
    'app.compare.execute': '🔍 比較実行',
    'app.compare.loadModel': '🔍 モデル読込',
    'app.compare.loadOrCompare': '🔍 読込 / 比較実行',
    'file.unselected': '未選択',
    'file.clear': '解除',
    'file.clearModel': 'モデル{slot}を解除',
    'errors.unexpected': '予期しないエラーが発生しました。操作をやり直してください。',
  },
  en: {
    'app.compare.execute': '🔍 Compare',
    'app.compare.loadModel': '🔍 Load Model',
    'app.compare.loadOrCompare': '🔍 Load / Compare',
    'file.unselected': 'Not selected',
    'file.clear': 'Clear',
    'file.clearModel': 'Clear model {slot}',
    'errors.unexpected': 'An unexpected error occurred. Please try again.',
  },
};

let currentLocale = DEFAULT_LOCALE;

export function getLocale() {
  return currentLocale;
}

export function setLocale(locale) {
  currentLocale = messages[locale] ? locale : DEFAULT_LOCALE;
}

export function registerMessages(locale, localeMessages) {
  messages[locale] = {
    ...(messages[locale] || {}),
    ...localeMessages,
  };
}

export function t(key, params = {}) {
  const template = messages[currentLocale]?.[key] ?? messages[DEFAULT_LOCALE]?.[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`,
  );
}

export const i18n = {
  getLocale,
  setLocale,
  registerMessages,
  t,
};
