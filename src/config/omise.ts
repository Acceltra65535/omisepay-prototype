export type SupportedCurrency = 'sgd' | 'usd' | 'cad';

export interface CurrencyConfig {
  code: SupportedCurrency;
  symbol: string;
  label: string;
  name: string;
  flag: string;
  countryCode: string;
  minSubunits: number;
  maxSubunits: number;
  defaultAmount: string;
}

export const SUPPORTED_CURRENCIES: Record<SupportedCurrency, CurrencyConfig> = {
  sgd: {
    code: 'sgd',
    symbol: 'S$',
    label: 'SGD (S$)',
    name: 'Singapore Dollar',
    flag: '🇸🇬',
    countryCode: 'SG',
    minSubunits: 100,      // 最低 S$1.00
    maxSubunits: 2000000,  // 最高 S$20,000.00
    defaultAmount: '1500.00',
  },
  usd: {
    code: 'usd',
    symbol: '$',
    label: 'USD ($)',
    name: 'US Dollar',
    flag: '🇺🇸',
    countryCode: 'SG',     // Processed via Omise SG account
    minSubunits: 100,      // 最低 $1.00
    maxSubunits: 2000000,  // 最高 $20,000.00
    defaultAmount: '1000.00',
  },
  cad: {
    code: 'cad',
    symbol: 'CA$',
    label: 'CAD (CA$)',
    name: 'Canadian Dollar',
    flag: '🇨🇦',
    countryCode: 'SG',     // Processed via Omise SG account
    minSubunits: 100,      // 最低 CA$1.00
    maxSubunits: 2000000,  // 最高 CA$20,000.00
    defaultAmount: '1350.00',
  },
};

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return ['sgd', 'usd', 'cad'].includes(value.toLowerCase().trim());
}

function resolveDefaultCurrency(): SupportedCurrency {
  const envCurrency = (process.env.OMISE_CURRENCY || '').toLowerCase().trim();
  return isSupportedCurrency(envCurrency) ? envCurrency : 'sgd';
}

export const OMISE_CONFIG = {
  // Omise Live Public Key (用于前端 Omise.js 信用卡 Token 化)
  publicKey: process.env.OMISE_PUBLIC_KEY || 'OMISE_PUBLIC_KEY_PLACEHOLDER',

  // Omise Live Secret Key (仅用于后端 Hono 中间件发起扣款与查询，绝不暴露至前端)
  secretKey: process.env.OMISE_SECRET_KEY || 'OMISE_SECRET_KEY_PLACEHOLDER',

  // 默认货币：优先读取 .env 中的 OMISE_CURRENCY，默认为 sgd，支持 sgd, usd, cad
  currency: resolveDefaultCurrency(),
  defaultCurrency: resolveDefaultCurrency(),
  supportedCurrencies: ['sgd', 'usd', 'cad'] as const,

  // 交易限额设置（单位：subunit / 分，1 单位 = 100 subunits）
  minAmountSubunits: 100,      // 最低 1.00
  maxAmountSubunits: 2000000,  // 最高 20,000.00

  // 3D Secure 2.0 配置
  threeDS: {
    required: true,            // 生产环境强制要求 3DS
    defaultReturnPath: '/payment',
  },
} as const;

/**
 * 判断 Public Key 是否已由用户正确配置
 */
export function isPublicKeyConfigured(): boolean {
  const key = OMISE_CONFIG.publicKey;
  return Boolean(
    key &&
    key !== 'OMISE_PUBLIC_KEY_PLACEHOLDER' &&
    key.trim().length > 10
  );
}

/**
 * 判断 Secret Key 是否已由用户正确配置
 */
export function isSecretKeyConfigured(): boolean {
  const key = OMISE_CONFIG.secretKey;
  return Boolean(
    key &&
    key !== 'OMISE_SECRET_KEY_PLACEHOLDER' &&
    key.trim().length > 10
  );
}

/**
 * 判断是否为 Live 生产环境密钥
 */
export function isLiveEnvironment(): boolean {
  return (
    OMISE_CONFIG.publicKey.startsWith('pkey_live_') ||
    OMISE_CONFIG.secretKey.startsWith('skey_live_')
  );
}
