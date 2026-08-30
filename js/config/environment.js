/**
 * @fileoverview 環境設定管理モジュール
 *
 * 開発環境・本番環境・ステージング環境での設定を統一管理
 */

// 設定（直接定義）
// R3: config/ は最下層のため utils/logger を import せず console を直接使用する

const globalConfig = {
  environments: {
    development: {
      debug: true,
    },
    production: {
      debug: false,
    },
    staging: {
      debug: true,
    },
  },
  fallback: {
    timeout: 30000,
  },
  features: {
    schema_validation: true,
    importance_rating: true,
  },
};

// 環境検出
function detectEnvironment() {
  const hostname = window.location.hostname;
  const protocol = window.location.protocol;
  const search = window.location.search;

  if (
    protocol === 'file:' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    /^192\.168\.\d+\.\d+$/.test(hostname) ||
    /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)
  ) {
    return 'development';
  } else if (search.includes('env=staging')) {
    return 'staging';
  } else {
    return 'production';
  }
}

// 統合設定をブラウザ用に変換
function transformConfigForBrowser(config, environment) {
  const envConfig = config.environments[environment];
  if (!envConfig) {
    throw new Error(`環境設定が見つかりません: ${environment}`);
  }

  return {
    features: {
      schemaValidation: config.features.schema_validation,
      importanceRating: config.features.importance_rating,
      devTools: environment === 'development',
    },
    logging: {
      level: envConfig.debug ? 'debug' : 'warn',
      console: envConfig.debug,
    },
  };
}

// 現在の環境設定を取得
export function getEnvironmentConfig() {
  const env = detectEnvironment();

  return {
    environment: env,
    ...transformConfigForBrowser(globalConfig, env),
  };
}

/**
 * 指定された機能が有効かどうかを確認
 * @param {string} featureName - 機能名（例: 'ifcConversion', 'devTools'）
 * @returns {boolean} 機能が有効な場合true
 */
export function isFeatureEnabled(featureName) {
  const config = getEnvironmentConfig();
  return config.features?.[featureName] ?? false;
}

/**
 * 環境情報をコンソールに表示（開発用）
 */
export function displayEnvironmentInfo() {
  const config = getEnvironmentConfig();
  console.group('🌍 環境設定情報');
  console.info('環境:', config.environment);
  console.info('有効な機能:', config.features);
  console.groupEnd();
}
