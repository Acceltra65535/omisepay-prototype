import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { MiddlewareHandler } from 'hono';
import {
  OMISE_CONFIG,
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  isCardBrandSupportedForCurrency,
  type SupportedCurrency,
} from '../config/omise';
import {
  savePendingCharge,
  getPendingCharge,
  updateChargeFromWebhook,
  isWebhookEventProcessed,
  getRecentWebhookEvents,
  getCachedCustomerIdByEmail,
  setCachedCustomerIdForEmail,
  type StoredChargeEntry,
} from '../utils/charge-store';
import { getExchangeRates } from '../utils/fx-rates';

/**
 * Helper to dynamically load keys from .env if process.env hasn't loaded them
 */
function readEnvFile(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const k = trimmed.substring(0, eqIdx).trim();
          const v = trimmed.substring(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
          env[k] = v;
        }
      }
    }
  } catch {
    // Ignore read error
  }
  return env;
}

function getEnvValue(key: string): string {
  const procVal = process.env[key];
  if (procVal && procVal.trim()) {
    return procVal.trim();
  }
  const fileVal = readEnvFile()[key];
  return fileVal ? fileVal.trim() : '';
}

function getPublicKey(): string {
  const val = getEnvValue('OMISE_PUBLIC_KEY');
  if (val && val !== 'OMISE_PUBLIC_KEY_PLACEHOLDER') {
    return val;
  }
  return OMISE_CONFIG.publicKey;
}

function getSecretKey(): string {
  const val = getEnvValue('OMISE_SECRET_KEY');
  if (val && val !== 'OMISE_SECRET_KEY_PLACEHOLDER') {
    return val;
  }
  return OMISE_CONFIG.secretKey;
}

function isSecretKeyReady(key: string): boolean {
  return Boolean(
    key &&
    key !== 'OMISE_SECRET_KEY_PLACEHOLDER' &&
    key.trim().length > 10
  );
}

function getDefaultCurrency(): SupportedCurrency {
  const envCurrency = getEnvValue('OMISE_CURRENCY').toLowerCase();
  return isSupportedCurrency(envCurrency) ? envCurrency : OMISE_CONFIG.defaultCurrency;
}

function getAuthHeader(secretKey: string): string {
  return 'Basic ' + Buffer.from(secretKey + ':').toString('base64');
}

/**
 * Extract real client IP address from proxy headers (Cloudflare, Nginx, ALB)
 * Essential for 3D Secure 2.0 ACS and Visa/Mastercard fraud risk scoring.
 */
function getClientIp(c: any): string {
  const cfIp = c.req.header('cf-connecting-ip');
  if (cfIp) return cfIp.trim();

  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp.trim();

  const forwardedFor = c.req.header('x-forwarded-for');
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }

  const trueClientIp = c.req.header('true-client-ip');
  if (trueClientIp) return trueClientIp.trim();

  return '';
}

function getClientUserAgent(c: any): string {
  return c.req.header('user-agent')?.trim() || '';
}

function getClientAcceptLanguage(c: any): string {
  return c.req.header('accept-language')?.trim() || '';
}

/**
 * Verify Omise HMAC-SHA256 webhook signature against timestamp + raw body.
 */
function verifyOmiseSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !timestampHeader) {
    return false;
  }
  const signedPayload = `${timestampHeader.trim()}.${rawBody}`;
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');

  const candidateSignatures = signatureHeader
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sig of candidateSignatures) {
    try {
      const candidateBuf = Buffer.from(sig, 'hex');
      if (
        candidateBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(expectedBuf, candidateBuf)
      ) {
        return true;
      }
    } catch {
      // Ignore malformed signature fragment
    }
  }
  return false;
}

/**
 * Build a uniform client-facing charge response object.
 */
function formatChargeResponse(
  chargeData: any,
  opts?: {
    clientRef?: string | undefined;
    customerId?: string | undefined;
    invoiceNumber?: string | undefined;
    invoiceDescription?: string | undefined;
    customerEmail?: string | undefined;
    customerName?: string | undefined;
    includeAuthRedirect?: boolean | undefined;
  },
) {
  const email =
    opts?.customerEmail ||
    (chargeData.metadata && chargeData.metadata.customer_email) ||
    '';
  const name =
    opts?.customerName ||
    (chargeData.metadata && chargeData.metadata.customer_name) ||
    null;

  const base: Record<string, any> = {
    id: chargeData.id,
    amount: chargeData.amount,
    currency: chargeData.currency,
    status: chargeData.status,
    authorized: chargeData.authorized,
    paid: chargeData.paid,
    authenticated_by: chargeData.authenticated_by || chargeData.authorization_type || null,
    failure_code: chargeData.failure_code || null,
    failure_message: chargeData.failure_message || null,
    customer_id:
      opts?.customerId ||
      chargeData.customer ||
      (chargeData.metadata && chargeData.metadata.customer_id) ||
      null,
    invoice_number:
      opts?.invoiceNumber ||
      (chargeData.metadata && chargeData.metadata.invoice_number) ||
      null,
    invoice_description: opts?.invoiceDescription || chargeData.description || null,
    customer: email
      ? {
          email,
          name,
        }
      : null,
    card: chargeData.card
      ? {
          last_digits: chargeData.card.last_digits,
          brand: chargeData.card.brand,
          name: chargeData.card.name,
        }
      : null,
    created_at: chargeData.created_at,
  };

  if (opts?.includeAuthRedirect) {
    base.authorize_uri = chargeData.authorize_uri || null;
    base.return_uri = chargeData.return_uri || null;
    base.client_ref = opts.clientRef || null;
  }

  return base;
}

/**
 * Build a friendly brand rejection message for a given currency.
 */
function buildUnsupportedBrandMessage(brand: string, currency: SupportedCurrency): string {
  const upperCurr = currency.toUpperCase();
  if (currency === 'sgd') {
    return `Card brand ${brand.toUpperCase()} is not supported. Please use a Visa, Mastercard, or JCB card.`;
  }
  return `Card brand ${brand.toUpperCase()} is not supported for ${upperCurr} payments. Omise Multi-Currency (${upperCurr}) only supports Visa and Mastercard.`;
}

/**
 * Resolve an existing Omise Customer by email (cache -> Omise Search API) and attach the new card,
 * or create a new Customer entity when no existing record exists.
 */
async function resolveOrCreateCustomer(params: {
  secretKey: string;
  token: string;
  currency: SupportedCurrency;
  customerEmail: string;
  customerName: string;
  invoiceNumber: string;
  clientIp: string;
  userAgent: string;
  billing: Record<string, any> | undefined;
}): Promise<
  | { ok: true; customerId: string | null; cardId: string | null }
  | { ok: false; status: ContentfulStatusCode; error: string; code: string }
> {
  const {
    secretKey,
    token,
    currency,
    customerEmail,
    customerName,
    invoiceNumber,
    clientIp,
    userAgent,
    billing,
  } = params;

  const normalizedEmail = customerEmail.trim().toLowerCase();
  const customerDescParts = [
    customerName,
    invoiceNumber ? `[${invoiceNumber}]` : '',
  ].filter(Boolean);
  const customerDesc =
    customerDescParts.length > 0 ? customerDescParts.join(' ') : `Customer ${customerEmail}`;

  const metadataPayload = {
    name: customerName,
    invoice_number: invoiceNumber,
    last_invoice_number: invoiceNumber,
    registration_ip: clientIp,
    last_ip: clientIp,
    user_agent: userAgent,
    billing_country: billing?.country || '',
    billing_state: billing?.state || '',
    billing_city: billing?.city || '',
    billing_postal_code: billing?.postal_code || '',
    billing_street1: billing?.street1 || '',
  };

  let existingCustId = getCachedCustomerIdByEmail(normalizedEmail);

  // If not in local cache, query Omise Search API to avoid creating duplicate customers
  if (!existingCustId) {
    try {
      const searchRes = await fetch(
        `https://api.omise.co/search?scope=customer&query=${encodeURIComponent(normalizedEmail)}`,
        {
          method: 'GET',
          headers: { Authorization: getAuthHeader(secretKey) },
          signal: AbortSignal.timeout(4000),
        },
      );
      if (searchRes.ok) {
        const searchData = (await searchRes.json()) as { data?: any[] };
        if (Array.isArray(searchData?.data)) {
          const matched = searchData.data.find(
            (item) =>
              item &&
              !item.deleted &&
              typeof item.email === 'string' &&
              item.email.trim().toLowerCase() === normalizedEmail,
          );
          if (matched?.id) {
            existingCustId = String(matched.id);
          }
        }
      }
    } catch (searchErr) {
      console.warn('Customer search lookup warning:', searchErr);
    }
  }

  // Try attaching the card token to the existing customer via PATCH
  if (existingCustId) {
    try {
      const patchRes = await fetch(`https://api.omise.co/customers/${existingCustId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: getAuthHeader(secretKey),
        },
        body: JSON.stringify({
          card: token,
          description: customerDesc,
          metadata: metadataPayload,
        }),
      });
      const patchData = await patchRes.json();

      if (patchRes.ok && patchData.id) {
        const cardsList = patchData.cards?.data;
        const latestCard =
          Array.isArray(cardsList) && cardsList.length > 0
            ? cardsList[cardsList.length - 1]
            : null;
        const resolvedCardId = latestCard?.id || patchData.default_card || null;

        if (latestCard?.brand && !isCardBrandSupportedForCurrency(latestCard.brand, currency)) {
          return {
            ok: false,
            status: 400,
            error: buildUnsupportedBrandMessage(latestCard.brand, currency),
            code: 'brand_not_supported_for_currency',
          };
        }

        setCachedCustomerIdForEmail(normalizedEmail, patchData.id);
        return { ok: true, customerId: patchData.id, cardId: resolvedCardId };
      }

      if (
        patchData?.code === 'invalid_card' ||
        /brand not supported/i.test(String(patchData?.message || ''))
      ) {
        return {
          ok: false,
          status: 400,
          error: patchData.message || 'Invalid or unsupported card',
          code: patchData.code || 'invalid_card',
        };
      }

      console.warn(
        'Existing customer PATCH failed, creating new customer entity:',
        patchData?.message || patchRes.status,
      );
    } catch (patchErr) {
      console.warn('Customer PATCH network warning:', patchErr);
    }
  }

  // Create a new Omise Customer entity
  try {
    const customerResponse = await fetch('https://api.omise.co/customers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getAuthHeader(secretKey),
      },
      body: JSON.stringify({
        email: customerEmail,
        description: customerDesc,
        card: token,
        metadata: metadataPayload,
      }),
    });

    const customerData = await customerResponse.json();
    if (customerResponse.ok && customerData.id) {
      const cardsList = customerData.cards?.data;
      const defaultCardObj = Array.isArray(cardsList) && cardsList.length > 0 ? cardsList[0] : null;
      if (
        defaultCardObj?.brand &&
        !isCardBrandSupportedForCurrency(defaultCardObj.brand, currency)
      ) {
        return {
          ok: false,
          status: 400,
          error: buildUnsupportedBrandMessage(defaultCardObj.brand, currency),
          code: 'brand_not_supported_for_currency',
        };
      }

      setCachedCustomerIdForEmail(normalizedEmail, customerData.id);
      return {
        ok: true,
        customerId: customerData.id,
        cardId: customerData.default_card || null,
      };
    }

    if (
      customerData?.code === 'invalid_card' ||
      /brand not supported/i.test(String(customerData?.message || ''))
    ) {
      return {
        ok: false,
        status: 400,
        error: customerData.message || 'Invalid or unsupported card',
        code: customerData.code || 'invalid_card',
      };
    }

    console.warn(
      'Customer entity registration warning:',
      customerData?.message || 'proceeding with direct token charge',
    );
  } catch (custErr) {
    console.warn('Customer entity registration network warning:', custErr);
  }

  return { ok: true, customerId: null, cardId: null };
}

/**
 * Sync charge status into persistent store.
 */
function persistChargeState(
  chargeData: any,
  opts?: {
    clientRef?: string | undefined;
    customerId?: string | undefined;
    invoiceNumber?: string | undefined;
    customerEmail?: string | undefined;
    customerName?: string | undefined;
    invoiceDescription?: string | undefined;
  },
): void {
  if (!chargeData?.id) return;
  const clientRef =
    opts?.clientRef ||
    (typeof chargeData?.metadata?.client_ref === 'string' && chargeData.metadata.client_ref
      ? chargeData.metadata.client_ref
      : undefined);

  savePendingCharge({
    chargeId: String(chargeData.id),
    clientRef,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    customerId: opts?.customerId || (typeof chargeData.customer === 'string' ? chargeData.customer : undefined),
    invoiceNumber:
      opts?.invoiceNumber ||
      (typeof chargeData?.metadata?.invoice_number === 'string' ? chargeData.metadata.invoice_number : undefined),
    customerEmail:
      opts?.customerEmail ||
      (typeof chargeData?.metadata?.customer_email === 'string' ? chargeData.metadata.customer_email : undefined),
    customerName:
      opts?.customerName ||
      (typeof chargeData?.metadata?.customer_name === 'string' ? chargeData.metadata.customer_name : undefined),
    invoiceDescription:
      opts?.invoiceDescription ||
      (typeof chargeData.description === 'string' ? chargeData.description : undefined),
    amount: typeof chargeData.amount === 'number' ? chargeData.amount : undefined,
    currency: typeof chargeData.currency === 'string' ? chargeData.currency : undefined,
    status: typeof chargeData.status === 'string' ? chargeData.status : undefined,
    paid: typeof chargeData.paid === 'boolean' ? chargeData.paid : undefined,
    authorized: typeof chargeData.authorized === 'boolean' ? chargeData.authorized : undefined,
    failureCode: chargeData.failure_code ?? null,
    failureMessage: chargeData.failure_message ?? null,
  });
}

const chargeApi = (): MiddlewareHandler => {
  return async (c, next) => {
    // ──────────────────────────────────────────
    // GET /api/config — Provide public key, FX rates & currency/brand rules
    // Note: NEVER exposes the secret key or webhook secret!
    // ──────────────────────────────────────────
    if (c.req.path === '/api/config' && c.req.method === 'GET') {
      const publicKey = getPublicKey();
      const secretKey = getSecretKey();
      const isPublicReady = Boolean(
        publicKey &&
        publicKey !== 'OMISE_PUBLIC_KEY_PLACEHOLDER' &&
        publicKey.trim().length > 10
      );
      const isSecretReady = isSecretKeyReady(secretKey);
      const isLive = publicKey.startsWith('pkey_live_') || secretKey.startsWith('skey_live_');

      const detectedIp = getClientIp(c);
      const defaultCurrency = getDefaultCurrency();
      const applePayMerchantId = getEnvValue('APPLE_MERCHANT_ID');
      const exchangeRates = await getExchangeRates();

      return c.json({
        publicKey: isPublicReady ? publicKey : '',
        applePayMerchantId,
        currency: defaultCurrency,
        defaultCurrency,
        supportedCurrencies: OMISE_CONFIG.supportedCurrencies,
        currencyConfigs: SUPPORTED_CURRENCIES,
        exchangeRates,
        threeDSRequired: OMISE_CONFIG.threeDS.required,
        isConfigured: isPublicReady && isSecretReady,
        isPublicKeySet: isPublicReady,
        isSecretKeySet: isSecretReady,
        isLive,
        minAmount: OMISE_CONFIG.minAmountSubunits,
        maxAmount: OMISE_CONFIG.maxAmountSubunits,
        clientIp: detectedIp || null,
      });
    }

    // ──────────────────────────────────────────────────
    // GET & POST /api/webhooks/omise — Omise asynchronous webhook handler
    // ──────────────────────────────────────────────────
    if (c.req.path === '/api/webhooks/omise') {
      const webhookSecret = getEnvValue('OMISE_WEBHOOK_SECRET');

      if (c.req.method === 'GET') {
        const recentEvents = getRecentWebhookEvents(10);
        return c.json({
          status: 'active',
          endpoint: '/api/webhooks/omise',
          signatureVerificationConfigured: Boolean(webhookSecret),
          recentEventsCount: recentEvents.length,
          recentEvents,
        });
      }

      if (c.req.method === 'POST') {
        try {
          const rawBody = await c.req.text();

          if (webhookSecret) {
            const sigHeader = c.req.header('omise-signature');
            const tsHeader = c.req.header('omise-signature-timestamp');
            if (!verifyOmiseSignature(rawBody, sigHeader, tsHeader, webhookSecret)) {
              return c.json({ error: 'Invalid Omise webhook signature' }, 401);
            }
          }

          let event: any;
          try {
            event = JSON.parse(rawBody);
          } catch {
            return c.json({ error: 'Invalid JSON payload' }, 400);
          }

          if (
            !event ||
            event.object !== 'event' ||
            typeof event.id !== 'string' ||
            typeof event.key !== 'string' ||
            !event.data ||
            event.data.object !== 'charge' ||
            typeof event.data.id !== 'string'
          ) {
            return c.json({ error: 'Invalid Omise webhook event payload' }, 400);
          }

          if (isWebhookEventProcessed(event.id)) {
            return c.json({
              received: true,
              duplicate: true,
              event_id: event.id,
            });
          }

          let chargeData = event.data;
          const secretKey = getSecretKey();
          if (isSecretKeyReady(secretKey)) {
            try {
              const verifyRes = await fetch(
                `https://api.omise.co/charges/${event.data.id}`,
                {
                  method: 'GET',
                  headers: { Authorization: getAuthHeader(secretKey) },
                  signal: AbortSignal.timeout(4000),
                },
              );
              if (verifyRes.ok) {
                const verifiedJson = await verifyRes.json();
                if (verifiedJson && verifiedJson.object === 'charge' && verifiedJson.id) {
                  chargeData = verifiedJson;
                }
              }
            } catch (verifyErr) {
              console.warn('Webhook API double-check fallback to event payload:', verifyErr);
            }
          }

          const updated = updateChargeFromWebhook(chargeData, event.id, event.key);
          console.info('Omise webhook processed:', {
            eventId: event.id,
            key: event.key,
            chargeId: updated.chargeId,
            status: updated.status,
            paid: updated.paid,
          });

          return c.json({
            received: true,
            event_id: event.id,
            key: event.key,
            charge_id: updated.chargeId,
            status: updated.status,
            paid: updated.paid,
          });
        } catch (err: any) {
          console.error('Omise webhook error:', err);
          return c.json({ error: err.message || 'Webhook processing error' }, 500);
        }
      }
    }

    // ──────────────────────────────────────────────────
    // POST /api/applepay/validate-merchant
    // Apple Pay on the Web requires server-to-server
    // mutual TLS with Apple using Merchant Identity
    // Certificate + Private Key.
    // ──────────────────────────────────────────────────
    if (c.req.path === '/api/applepay/validate-merchant' && c.req.method === 'POST') {
      try {
        const body = await c.req.json();
        const { validationUrl } = body;
        if (!validationUrl || typeof validationUrl !== 'string') {
          return c.json({ error: 'Missing validationUrl' }, 400);
        }

        // Validate the URL is actually from Apple
        const parsedUrl = new URL(validationUrl);
        if (!parsedUrl.hostname.endsWith('.apple.com')) {
          return c.json({ error: 'Invalid Apple validation URL' }, 400);
        }

        const merchantId = getEnvValue('APPLE_MERCHANT_ID');
        const rawCertPath = getEnvValue('APPLE_MERCHANT_CERT_PATH') || './certs/certificate.pem';
        const rawKeyPath = getEnvValue('APPLE_MERCHANT_KEY_PATH') || './certs/private_key.pem';
        const displayName = getEnvValue('APPLE_DISPLAY_NAME') || 'Omise Pay';
        const domainName =
          getEnvValue('APPLE_DOMAIN_NAME') || c.req.header('host')?.split(':')[0] || '';

        if (!merchantId) {
          console.error('Apple Pay Merchant Validation: Missing merchantId in environment.');
          return c.json(
            {
              error: 'Apple Pay 尚未配置 Merchant ID。请在 .env 中设置 APPLE_MERCHANT_ID。',
              code: 'applepay_not_configured',
            },
            503,
          );
        }

        function loadPemFile(configuredPath: string, fallbacks: string[]): string {
          const candidates = [configuredPath, ...fallbacks];
          for (const cand of candidates) {
            if (!cand) continue;
            const resolved = path.isAbsolute(cand) ? cand : path.resolve(process.cwd(), cand);
            if (fs.existsSync(resolved)) {
              return fs.readFileSync(resolved, 'utf-8');
            }
          }
          throw new Error(`无法找到文件: ${configuredPath}`);
        }

        let cert: string;
        let key: string;
        try {
          cert = loadPemFile(rawCertPath, ['./certs/apcert.pem', './certs/certificate.pem', './certificate.pem']);
          key = loadPemFile(rawKeyPath, ['./certs/apkey.pem', './certs/private_key.pem', './private_key.pem']);
        } catch (fileErr: any) {
          console.error('Apple Pay cert/key file read error:', fileErr.message);
          return c.json(
            {
              error: `无法读取 Apple Pay 证书文件: ${fileErr.message}。请检查 certs 目录中是否存在证书文件。`,
              code: 'applepay_cert_read_error',
            },
            500,
          );
        }

        // Call Apple's validation URL with mutual TLS (client cert)
        const https = await import('https');
        const merchantSession = await new Promise<any>((resolve, reject) => {
          const postData = JSON.stringify({
            merchantIdentifier: merchantId,
            displayName: displayName,
            initiative: 'web',
            initiativeContext: domainName,
          });

          const urlObj = new URL(validationUrl);
          const options: Record<string, any> = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname,
            method: 'POST',
            cert: cert,
            key: key,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
          };

          const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk: string) => { data += chunk; });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                  resolve(parsed);
                } else {
                  reject(new Error(`Apple validation failed (HTTP ${res.statusCode}): ${data}`));
                }
              } catch {
                reject(new Error(`Apple validation returned invalid JSON: ${data}`));
              }
            });
          });

          req.on('error', (err: Error) => {
            reject(new Error(`Apple Pay validation network error: ${err.message}`));
          });

          req.write(postData);
          req.end();
        });

        return c.json(merchantSession);
      } catch (err: any) {
        console.error('Apple Pay Merchant Validation Error:', err);
        return c.json({ error: err.message || 'Merchant validation failed' }, 500);
      }
    }

    // ──────────────────────────────────────────
    // POST /api/charge — Create charge with mandatory 3DS
    // ──────────────────────────────────────────
    if (c.req.path === '/api/charge' && c.req.method === 'POST') {
      const secretKey = getSecretKey();
      if (!isSecretKeyReady(secretKey)) {
        return c.json(
          {
            error:
              'Omise Secret Key is not configured. Please set OMISE_SECRET_KEY in your .env file or in src/config/omise.ts with your Live Secret Key (skey_live_...).',
            code: 'secret_key_not_configured',
          },
          503,
        );
      }

      try {
        const body = await c.req.json();
        const {
          token,
          amount,
          currency,
          return_uri,
          client_ref,
          customer,
          invoice,
          billing,
          is_apple_pay,
          card_brand,
        } = body;

        // Input validations
        if (!token || typeof token !== 'string') {
          return c.json({ error: 'Missing or invalid card token' }, 400);
        }
        const defaultCurr = getDefaultCurrency();
        const normalizedCurrency = typeof currency === 'string' ? currency.toLowerCase().trim() : defaultCurr;
        const finalCurrency: SupportedCurrency = isSupportedCurrency(normalizedCurrency)
          ? normalizedCurrency
          : defaultCurr;
        const currencyConfig = SUPPORTED_CURRENCIES[finalCurrency] || SUPPORTED_CURRENCIES.sgd;
        const currencySymbol = currencyConfig.symbol;

        if (!amount || typeof amount !== 'number' || amount < OMISE_CONFIG.minAmountSubunits) {
          return c.json(
            { error: `Invalid amount: minimum is ${currencySymbol}1.00 (100 subunits)` },
            400,
          );
        }
        if (amount > OMISE_CONFIG.maxAmountSubunits) {
          return c.json(
            { error: `Amount exceeds maximum: ${currencySymbol}20,000.00 (2,000,000 subunits)` },
            400,
          );
        }

        // Cross-currency card brand guard (USD/CAD Multi-Currency supports Visa & Mastercard only)
        if (typeof card_brand === 'string' && card_brand.trim()) {
          const cleanBrand = card_brand.trim().toLowerCase();
          if (!isCardBrandSupportedForCurrency(cleanBrand, finalCurrency)) {
            return c.json(
              {
                error: buildUnsupportedBrandMessage(cleanBrand, finalCurrency),
                code: 'brand_not_supported_for_currency',
              },
              400,
            );
          }
        }

        if (!return_uri || typeof return_uri !== 'string') {
          return c.json(
            { error: 'Missing return_uri (required for mandatory 3D Secure verification)' },
            400,
          );
        }

        let finalReturnUri = return_uri.trim();
        if (finalReturnUri.startsWith('/')) {
          const host = c.req.header('x-forwarded-host') || c.req.header('host') || 'pay.cyberjar.io';
          const proto = c.req.header('x-forwarded-proto') || 'https';
          finalReturnUri = `${proto}://${host}${finalReturnUri}`;
        }

        try {
          const parsedReturnUrl = new URL(finalReturnUri);
          if (parsedReturnUrl.protocol !== 'http:' && parsedReturnUrl.protocol !== 'https:') {
            return c.json(
              { error: 'Invalid return_uri: must be a valid HTTP/HTTPS URL for mandatory 3D Secure verification' },
              400,
            );
          }
        } catch {
          return c.json(
            { error: 'Invalid return_uri: must be a valid HTTP/HTTPS URL for mandatory 3D Secure verification' },
            400,
          );
        }

        // Extract Cardholder IP & Browser Context (3DS 2.0 browserIP)
        const clientIp = getClientIp(c) || (body.client_ip ? String(body.client_ip).trim() : '');
        const userAgent = getClientUserAgent(c) || (body.user_agent ? String(body.user_agent).trim() : '');
        const acceptLanguage = getClientAcceptLanguage(c);

        // Step 1: Resolve or Create Customer Entity (deduplicated by email)
        let customerId: string | null = null;
        let cardId: string | null = null;

        const customerEmail = customer?.email ? String(customer.email).trim() : '';
        const customerName = customer?.name ? String(customer.name).trim() : '';
        const invoiceNumber = invoice?.invoice_number ? String(invoice.invoice_number).trim() : '';
        const invoiceDesc = invoice?.description
          ? String(invoice.description).trim()
          : invoiceNumber
            ? `Invoice #${invoiceNumber}`
            : 'Credit Card Payment';

        if (customerEmail && !is_apple_pay) {
          const custResult = await resolveOrCreateCustomer({
            secretKey,
            token,
            currency: finalCurrency,
            customerEmail,
            customerName,
            invoiceNumber,
            clientIp,
            userAgent,
            billing,
          });
          if (!custResult.ok) {
            return c.json({ error: custResult.error, code: custResult.code }, custResult.status);
          }
          customerId = custResult.customerId;
          cardId = custResult.cardId;
        }

        // Step 2: Create Charge with mandatory return_uri & full 3DS context
        const isUsOrHighValue =
          billing?.country === 'US' || billing?.country === 'CA' || amount >= 100000;

        const chargePayload: Record<string, any> = {
          amount: amount,
          currency: finalCurrency,
          return_uri: finalReturnUri,
          capture: true,
          description: invoiceDesc,
          metadata: {
            invoice_number: invoiceNumber,
            invoice_memo: invoice?.memo || '',
            customer_id: customerId || '',
            customer_email: customerEmail,
            customer_name: customerName,
            charge_currency: finalCurrency.toUpperCase(),
            payment_method: is_apple_pay ? 'apple_pay' : 'card',
            three_ds_required: OMISE_CONFIG.threeDS.required,
            billing_country: billing?.country || '',
            billing_state: billing?.state || '',
            billing_city: billing?.city || '',
            billing_postal_code: billing?.postal_code || '',
            billing_street: billing?.street1 || '',
            client_ref: client_ref || '',
            client_ip: clientIp,
            user_agent: userAgent,
            accept_language: acceptLanguage,
            high_value_us_compliance: isUsOrHighValue,
          },
        };

        if (clientIp) {
          chargePayload.ip = clientIp;
        }

        if (customerId) {
          chargePayload.customer = customerId;
          if (cardId) {
            chargePayload.card = cardId;
          }
        } else {
          chargePayload.card = token;
        }

        const chargeResponse = await fetch('https://api.omise.co/charges', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: getAuthHeader(secretKey),
          },
          body: JSON.stringify(chargePayload),
        });

        const chargeData = await chargeResponse.json();

        if (!chargeResponse.ok || chargeData.object === 'error') {
          const statusCode = (
            chargeResponse.status === 200 ? 400 : chargeResponse.status
          ) as ContentfulStatusCode;

          let rawErrorMessage =
            chargeData.message ||
            chargeData.location ||
            'Charge creation failed';

          if (
            typeof rawErrorMessage === 'string' &&
            /amount must be less than or equal to/i.test(rawErrorMessage)
          ) {
            rawErrorMessage = `${rawErrorMessage} (这是 Omise 对新开通 Live 账户默认的风控限额。如需提升至单笔最高限额，请联系 Omise 客服 support@omise.co 申请提高单笔支付上限)`;
          }

          if (chargeData.code === 'failed_multi_currency') {
            rawErrorMessage = `${rawErrorMessage} (Omise 账户未开通 Multi-currency，${finalCurrency.toUpperCase()} 无法换汇结算为 SGD。请联系 support@omise.co 申请开通；开通后也仅支持 Visa / Mastercard)`;
          }

          console.error('Omise charge creation failed:', chargeData.code, chargeData.message, {
            currency: finalCurrency,
            amount,
          });

          return c.json(
            {
              error: rawErrorMessage,
              code: chargeData.code || 'charge_failed',
            },
            statusCode,
          );
        }

        // Persist charge & client_ref mapping to disk store
        persistChargeState(chargeData, {
          clientRef: typeof client_ref === 'string' ? client_ref : undefined,
          customerId: customerId || undefined,
          invoiceNumber: invoiceNumber || undefined,
          customerEmail: customerEmail || undefined,
          customerName: customerName || undefined,
          invoiceDescription: invoiceDesc || undefined,
        });

        return c.json(
          formatChargeResponse(chargeData, {
            clientRef: typeof client_ref === 'string' ? client_ref : undefined,
            customerId: customerId || undefined,
            invoiceNumber: invoiceNumber || undefined,
            invoiceDescription: invoiceDesc,
            customerEmail: customerEmail || undefined,
            customerName: customerName || undefined,
            includeAuthRedirect: true,
          }),
        );
      } catch (err: any) {
        console.error('Charge API error:', err);
        return c.json(
          { error: err.message || 'Internal server error' },
          500,
        );
      }
    }

    // ──────────────────────────────────────────────────
    // GET /api/charge/ref/:ref — Retrieve charge via client_ref (Disk Store + Omise Search fallback)
    // ──────────────────────────────────────────────────
    const refMatch = c.req.path.match(/^\/api\/charge\/ref\/([a-zA-Z0-9_\-]+)$/);
    if (refMatch && c.req.method === 'GET') {
      const ref = refMatch[1];
      if (!ref) {
        return c.json({ error: 'Invalid reference' }, 400);
      }
      const secretKey = getSecretKey();
      if (!isSecretKeyReady(secretKey)) {
        return c.json({ error: 'Omise Secret Key is not configured' }, 503);
      }

      let entry: StoredChargeEntry | undefined = getPendingCharge(ref);

      // Fallback to Omise Search API if store does not have this client_ref yet
      if (!entry) {
        try {
          const searchRes = await fetch(
            `https://api.omise.co/search?scope=charge&query=${encodeURIComponent(ref)}`,
            {
              method: 'GET',
              headers: { Authorization: getAuthHeader(secretKey) },
              signal: AbortSignal.timeout(4000),
            },
          );
          if (searchRes.ok) {
            const searchData = (await searchRes.json()) as { data?: any[] };
            if (Array.isArray(searchData?.data) && searchData.data.length > 0) {
              const matched =
                searchData.data.find((ch) => ch?.metadata?.client_ref === ref) ||
                searchData.data[0];
              if (matched?.id) {
                persistChargeState(matched, { clientRef: ref });
                entry = getPendingCharge(ref);
              }
            }
          }
        } catch (searchErr) {
          console.warn('Charge search lookup warning:', searchErr);
        }
      }

      if (!entry) {
        return c.json({ error: 'No charge found for this reference' }, 404);
      }

      try {
        const chargeResponse = await fetch(
          `https://api.omise.co/charges/${entry.chargeId}`,
          {
            method: 'GET',
            headers: { Authorization: getAuthHeader(secretKey) },
          },
        );
        const chargeData = await chargeResponse.json();
        if (!chargeResponse.ok || chargeData.object === 'error') {
          return c.json(
            { error: chargeData.message || 'Failed to retrieve charge' },
            400,
          );
        }

        persistChargeState(chargeData, {
          clientRef: ref,
          customerId: entry.customerId,
          invoiceNumber: entry.invoiceNumber,
          customerEmail: entry.customerEmail,
          customerName: entry.customerName,
          invoiceDescription: entry.invoiceDescription,
        });

        return c.json(
          formatChargeResponse(chargeData, {
            customerId: entry.customerId,
            invoiceNumber: entry.invoiceNumber,
            invoiceDescription: entry.invoiceDescription,
            customerEmail: entry.customerEmail,
            customerName: entry.customerName,
          }),
        );
      } catch (err: any) {
        return c.json({ error: err.message || 'Failed to retrieve charge' }, 500);
      }
    }

    // ──────────────────────────────────────────────────
    // GET /api/charge/:id — Retrieve charge status by charge ID
    // ──────────────────────────────────────────────────
    const chargeIdMatch = c.req.path.match(
      /^\/api\/charge\/(chrg_[a-zA-Z0-9]+)$/,
    );
    if (chargeIdMatch && c.req.method === 'GET') {
      const secretKey = getSecretKey();
      if (!isSecretKeyReady(secretKey)) {
        return c.json(
          {
            error:
              'Omise Secret Key is not configured. Please set OMISE_SECRET_KEY in your .env file or in src/config/omise.ts.',
            code: 'secret_key_not_configured',
          },
          503,
        );
      }

      try {
        const chargeId = chargeIdMatch[1]!;
        const chargeResponse = await fetch(
          `https://api.omise.co/charges/${chargeId}`,
          {
            method: 'GET',
            headers: {
              Authorization: getAuthHeader(secretKey),
            },
          },
        );

        const chargeData = await chargeResponse.json();

        if (!chargeResponse.ok || chargeData.object === 'error') {
          const statusCode = (
            chargeResponse.status === 200 ? 400 : chargeResponse.status
          ) as ContentfulStatusCode;
          return c.json(
            {
              error:
                chargeData.message ||
                chargeData.location ||
                'Failed to retrieve charge',
              code: chargeData.code,
            },
            statusCode,
          );
        }

        const cached = getPendingCharge(chargeId);
        persistChargeState(chargeData, {
          clientRef: cached?.clientRef,
          customerId: cached?.customerId,
          invoiceNumber: cached?.invoiceNumber,
          customerEmail: cached?.customerEmail,
          customerName: cached?.customerName,
          invoiceDescription: cached?.invoiceDescription,
        });

        return c.json(
          formatChargeResponse(chargeData, {
            customerId: cached?.customerId,
            invoiceNumber: cached?.invoiceNumber,
            invoiceDescription: cached?.invoiceDescription,
            customerEmail: cached?.customerEmail,
            customerName: cached?.customerName,
          }),
        );
      } catch (err: any) {
        console.error('Charge retrieve error:', err);
        return c.json(
          { error: err.message || 'Internal server error' },
          500,
        );
      }
    }

    await next();
  };
};

export default chargeApi;
