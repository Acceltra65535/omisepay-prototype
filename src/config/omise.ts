export const SUPPORTED_CURRENCY_CODES = ['sgd', 'cad'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCY_CODES[number];
export type CardBrand = 'visa' | 'mastercard' | 'jcb';

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
  supportedBrands: readonly CardBrand[];
  applePayNetworks: readonly ('visa' | 'masterCard' | 'jcb')[];
  supportedBrandsLabel: string;
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
    supportedBrands: ['visa', 'mastercard', 'jcb'],
    applePayNetworks: ['visa', 'masterCard', 'jcb'],
    supportedBrandsLabel: 'Visa, Mastercard, JCB',
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
    supportedBrands: ['visa', 'mastercard'],
    applePayNetworks: ['visa', 'masterCard'],
    supportedBrandsLabel: 'Visa, Mastercard',
  },
};

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  const normalized = value.toLowerCase().trim();
  return SUPPORTED_CURRENCY_CODES.some((currency) => currency === normalized);
}

export function isCardBrandSupportedForCurrency(
  brand: string,
  currency: SupportedCurrency,
): boolean {
  const normalizedBrand = brand.toLowerCase().trim();
  const cfg = SUPPORTED_CURRENCIES[currency];
  return (cfg.supportedBrands as readonly string[]).includes(normalizedBrand);
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

  // 默认货币：优先读取 .env 中的 OMISE_CURRENCY，默认为 sgd，支持 sgd、cad
  currency: resolveDefaultCurrency(),
  defaultCurrency: resolveDefaultCurrency(),
  supportedCurrencies: SUPPORTED_CURRENCY_CODES,

  // 交易限额设置（单位：subunit / 分，1 单位 = 100 subunits）
  minAmountSubunits: 100,      // 最低 1.00
  maxAmountSubunits: 2000000,  // 最高 20,000.00

  // 3D Secure 2.0 配置
  threeDS: {
    required: true,            // 生产环境强制要求 3DS
    // Apple Pay 在 Omise SG 按原生设备生物识别 + Cryptogram 走非 3DS 通道，不能按 authenticated_by === '3DS' 拦截撤单
    enforceForApplePay: false,
    // 对普通银行卡启用预授权守卫（capture: false -> 校验 authenticated_by === '3DS'/'PASSKEY' -> 捕获或撤单）
    enforceManualCaptureGuard: true,
    defaultReturnPath: '/payment',
  },
} as const;

/**
 * 判断 Public Key 是否已由用户正确配置
 */
export function isPublicKeyConfigured(key: string = OMISE_CONFIG.publicKey): boolean {
  const trimmed = key.trim();
  return Boolean(
    trimmed &&
    trimmed !== 'OMISE_PUBLIC_KEY_PLACEHOLDER' &&
    !trimmed.includes('your_actual_') &&
    trimmed.length > 10
  );
}

/**
 * 判断 Secret Key 是否已由用户正确配置
 */
export function isSecretKeyConfigured(key: string = OMISE_CONFIG.secretKey): boolean {
  const trimmed = key.trim();
  return Boolean(
    trimmed &&
    trimmed !== 'OMISE_SECRET_KEY_PLACEHOLDER' &&
    !trimmed.includes('your_actual_') &&
    trimmed.length > 10
  );
}

/**
 * 判断是否为 Live 生产环境密钥
 * Omise 新版生产环境密钥为 `pkey_xxx` / `skey_xxx`（或旧版 `pkey_live_` / `skey_live_`），
 * 仅测试环境密钥带有 `pkey_test_` / `skey_test_` 前缀。
 */
export function isLiveEnvironment(
  publicKey: string = OMISE_CONFIG.publicKey,
  secretKey: string = OMISE_CONFIG.secretKey,
): boolean {
  const pk = publicKey.trim();
  const sk = secretKey.trim();
  const isLivePublic =
    isPublicKeyConfigured(pk) &&
    pk.startsWith('pkey_') &&
    !pk.startsWith('pkey_test_');
  const isLiveSecret =
    isSecretKeyConfigured(sk) &&
    sk.startsWith('skey_') &&
    !sk.startsWith('skey_test_');
  return isLivePublic || isLiveSecret;
}
