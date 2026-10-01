/**
 * Omise Singapore (SG) Production Configuration
 * 
 * ⚠️  配置说明：
 * 用户需要填写的生产环境 Key（Live Keys）：
 * 1. OMISE_PUBLIC_KEY: 公钥，格式为 pkey_live_xxxxxxxxxxxxxxxxxxxxx
 * 2. OMISE_SECRET_KEY: 私钥，格式为 skey_live_xxxxxxxxxxxxxxxxxxxxx
 * 
 * 支持两种配置方式：
 * 方式一（推荐）：在项目根目录创建 `.env` 文件，填入：
 *    OMISE_PUBLIC_KEY=pkey_live_your_actual_public_key
 *    OMISE_SECRET_KEY=skey_live_your_actual_secret_key
 * 
 * 方式二：直接在此文件中修改下方对应常量的默认值。
 */

export const OMISE_CONFIG = {
  // Omise Live Public Key (用于前端 Omise.js 信用卡 Token 化)
  publicKey: process.env.OMISE_PUBLIC_KEY || 'OMISE_PUBLIC_KEY_PLACEHOLDER',

  // Omise Live Secret Key (仅用于后端 Hono 中间件发起扣款与查询，绝不暴露至前端)
  secretKey: process.env.OMISE_SECRET_KEY || 'OMISE_SECRET_KEY_PLACEHOLDER',

  // 货币：新加坡元 SGD
  currency: 'sgd',

  // 交易限额设置（单位：subunit / 分，1 SGD = 100 subunits）
  minAmountSubunits: 100,      // 最低 S$1.00
  maxAmountSubunits: 2000000,  // 最高 S$20,000.00

  // 3D Secure 2.0 配置
  threeDS: {
    required: true,            // 新加坡生产环境强制要求 3DS
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
