import fs from 'node:fs';
import path from 'node:path';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { MiddlewareHandler } from 'hono';
import {
  OMISE_CONFIG,
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  type SupportedCurrency,
} from '../config/omise';

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

function getPublicKey(): string {
  if (process.env.OMISE_PUBLIC_KEY && process.env.OMISE_PUBLIC_KEY !== 'OMISE_PUBLIC_KEY_PLACEHOLDER') {
    return process.env.OMISE_PUBLIC_KEY.trim();
  }
  const fileEnv = readEnvFile();
  if (fileEnv.OMISE_PUBLIC_KEY && fileEnv.OMISE_PUBLIC_KEY !== 'OMISE_PUBLIC_KEY_PLACEHOLDER') {
    return fileEnv.OMISE_PUBLIC_KEY.trim();
  }
  return OMISE_CONFIG.publicKey;
}

function getSecretKey(): string {
  if (process.env.OMISE_SECRET_KEY && process.env.OMISE_SECRET_KEY !== 'OMISE_SECRET_KEY_PLACEHOLDER') {
    return process.env.OMISE_SECRET_KEY.trim();
  }
  const fileEnv = readEnvFile();
  if (fileEnv.OMISE_SECRET_KEY && fileEnv.OMISE_SECRET_KEY !== 'OMISE_SECRET_KEY_PLACEHOLDER') {
    return fileEnv.OMISE_SECRET_KEY.trim();
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
  const envCurrency = (process.env.OMISE_CURRENCY || readEnvFile().OMISE_CURRENCY || '').toLowerCase().trim();
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
 * In-memory map to store 3DS reference mappings (client_ref -> charge_id)
 * Keeps items for 1 hour to handle delayed 3DS returns.
 */
interface PendingChargeEntry {
  chargeId: string;
  createdAt: number;
  customerId?: string | undefined;
  invoiceNumber?: string | undefined;
  customerEmail?: string | undefined;
  customerName?: string | undefined;
  customerCompany?: string | undefined;
  invoiceDescription?: string | undefined;
}
const pendingChargesMap = new Map<string, PendingChargeEntry>();

// Clean up expired items (> 1 hour old) every 15 minutes
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, value] of pendingChargesMap.entries()) {
    if (value.createdAt < oneHourAgo) {
      pendingChargesMap.delete(key);
    }
  }
}, 15 * 60 * 1000);

const chargeApi = (): MiddlewareHandler => {
  return async (c, next) => {
    // ──────────────────────────────────────────
    // GET /api/config — Provide public key & status to frontend
    // Note: NEVER exposes the secret key!
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
      // Apple Pay Merchant ID is not a secret (it is shown in the Apple Pay sheet and
      // must be sent by the browser to Omise Vault as tokenization[merchant_id]).
      const applePayMerchantId =
        process.env.APPLE_MERCHANT_ID || readEnvFile().APPLE_MERCHANT_ID || '';

      return c.json({
        publicKey: isPublicReady ? publicKey : '',
        applePayMerchantId,
        currency: defaultCurrency,
        defaultCurrency,
        supportedCurrencies: OMISE_CONFIG.supportedCurrencies,
        currencyConfigs: SUPPORTED_CURRENCIES,
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
    // POST /api/applepay/validate-merchant
    // Apple Pay on the Web requires server-to-server
    // mutual TLS with Apple using Merchant Identity
    // Certificate + Private Key.
    //
    // Required env vars (or files):
    //   APPLE_MERCHANT_ID          — e.g. "merchant.co.omise.xxx"
    //   APPLE_MERCHANT_CERT_PATH   — path to .pem cert file
    //   APPLE_MERCHANT_KEY_PATH    — path to .key private key file
    //   APPLE_DISPLAY_NAME         — display name shown on Apple Pay sheet
    //   APPLE_DOMAIN_NAME          — your verified domain (no https://)
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

        const fileEnv = readEnvFile();
        const merchantId = process.env.APPLE_MERCHANT_ID || fileEnv.APPLE_MERCHANT_ID || '';
        const rawCertPath = process.env.APPLE_MERCHANT_CERT_PATH || fileEnv.APPLE_MERCHANT_CERT_PATH || './certs/certificate.pem';
        const rawKeyPath = process.env.APPLE_MERCHANT_KEY_PATH || fileEnv.APPLE_MERCHANT_KEY_PATH || './certs/private_key.pem';
        const displayName = process.env.APPLE_DISPLAY_NAME || fileEnv.APPLE_DISPLAY_NAME || 'Omise Pay';
        const domainName = process.env.APPLE_DOMAIN_NAME || fileEnv.APPLE_DOMAIN_NAME || c.req.header('host')?.split(':')[0] || '';

        if (!merchantId) {
          console.error(
            'Apple Pay Merchant Validation: Missing merchantId in environment.'
          );
          return c.json(
            {
              error:
                'Apple Pay 尚未配置 Merchant ID。请在 .env 中设置 APPLE_MERCHANT_ID。',
              code: 'applepay_not_configured',
            },
            503,
          );
        }

        // Read cert and key files with multi-path resolution
        const fsMod = await import('fs');
        const pathMod = await import('path');

        function loadPemFile(configuredPath: string, fallbacks: string[]): string {
          const candidates = [configuredPath, ...fallbacks];
          for (const cand of candidates) {
            if (!cand) continue;
            const resolved = pathMod.isAbsolute(cand) ? cand : pathMod.resolve(process.cwd(), cand);
            if (fsMod.existsSync(resolved)) {
              return fsMod.readFileSync(resolved, 'utf-8');
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
    // POST /api/charge — Create charge with 3DS
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
        } = body;

        // Input validations
        if (!token || typeof token !== 'string') {
          return c.json({ error: 'Missing or invalid card token' }, 400);
        }
        const defaultCurr = getDefaultCurrency();
        const normalizedCurrency = typeof currency === 'string' ? currency.toLowerCase().trim() : defaultCurr;
        const finalCurrency: SupportedCurrency = isSupportedCurrency(normalizedCurrency) ? normalizedCurrency : defaultCurr;
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
        if (!return_uri || typeof return_uri !== 'string') {
          return c.json(
            { error: 'Missing return_uri (required for 3D Secure verification)' },
            400,
          );
        }

        let finalReturnUri = return_uri.trim();
        if (finalReturnUri.startsWith('/')) {
          const host = c.req.header('x-forwarded-host') || c.req.header('host') || 'pay.cyberjar.io';
          const proto = c.req.header('x-forwarded-proto') || 'https';
          finalReturnUri = `${proto}://${host}${finalReturnUri}`;
        }

        // ──────────────────────────────────────────────────────────
        // Extract Cardholder IP & Browser Context (3DS 2.0 browserIP)
        // Passing the real client IP is paramount for lowering fraud
        // risk scores in Visa Advanced Authorization & Mastercard Decision
        // Intelligence, matching IP geolocation with issuing bank country.
        // ──────────────────────────────────────────────────────────
        const clientIp = getClientIp(c) || (body.client_ip ? String(body.client_ip).trim() : '');
        const userAgent = getClientUserAgent(c) || (body.user_agent ? String(body.user_agent).trim() : '');
        const acceptLanguage = getClientAcceptLanguage(c);

        // ──────────────────────────────────────────────────────────
        // Step 1: Create / Register Customer Entity in Omise
        // (Similar to Stripe Invoicing: binds card token to customer,
        // establishes customer identity & contact details to pass
        // US bank anti-fraud and 3DS risk evaluation)
        // ──────────────────────────────────────────────────────────
        let customerId: string | null = null;
        let cardId: string | null = null;

        const customerEmail = customer?.email ? String(customer.email).trim() : '';
        const customerName = customer?.name ? String(customer.name).trim() : '';
        const customerCompany = customer?.company ? String(customer.company).trim() : '';
        const invoiceNumber = invoice?.invoice_number ? String(invoice.invoice_number).trim() : '';
        const invoiceDesc = invoice?.description ? String(invoice.description).trim() : (invoiceNumber ? `Invoice #${invoiceNumber}` : 'Credit Card Payment');

        if (customerEmail && !is_apple_pay) {
          try {
            const customerDescParts = [
              customerName,
              customerCompany ? `(${customerCompany})` : '',
              invoiceNumber ? `[${invoiceNumber}]` : '',
            ].filter(Boolean);
            const customerDesc = customerDescParts.length > 0 ? customerDescParts.join(' ') : `Customer ${customerEmail}`;

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
                metadata: {
                  name: customerName,
                  company: customerCompany,
                  invoice_number: invoiceNumber,
                  registration_ip: clientIp,
                  user_agent: userAgent,
                  billing_country: billing?.country || '',
                  billing_state: billing?.state || '',
                  billing_city: billing?.city || '',
                  billing_postal_code: billing?.postal_code || '',
                  billing_street1: billing?.street1 || '',
                },
              }),
            });

            const customerData = await customerResponse.json();
            if (customerResponse.ok && customerData.id) {
              customerId = customerData.id;
              if (customerData.default_card) {
                cardId = customerData.default_card;
              }
            } else {
              console.warn('Customer entity registration warning:', customerData.message || 'proceeding with direct token charge');
            }
          } catch (custErr) {
            console.warn('Customer entity registration network warning:', custErr);
          }
        }

        // ──────────────────────────────────────────────────────────
        // Step 2: Create Charge with Customer & Invoice Context
        // ──────────────────────────────────────────────────────────
        const isUsOrHighValue = (billing?.country === 'US' || billing?.country === 'CA') || (amount >= 100000);

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
            customer_company: customerCompany,
            charge_currency: finalCurrency.toUpperCase(),
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

        // Pass cardholder IP directly to Omise API for bank fraud scoring
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

        // Request Omise Charges API
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

          return c.json(
            {
              error: rawErrorMessage,
              code: chargeData.code || 'charge_failed',
            },
            statusCode,
          );
        }

        // Cache client_ref mapping to charge.id for 3DS return resolution
        if (client_ref && typeof client_ref === 'string') {
          pendingChargesMap.set(client_ref, {
            chargeId: chargeData.id,
            customerId: customerId || undefined,
            invoiceNumber: invoiceNumber || undefined,
            customerEmail: customerEmail || undefined,
            customerName: customerName || undefined,
            customerCompany: customerCompany || undefined,
            invoiceDescription: invoiceDesc || undefined,
            createdAt: Date.now(),
          });
        }
        if (chargeData.id) {
          pendingChargesMap.set(chargeData.id, {
            chargeId: chargeData.id,
            customerId: customerId || undefined,
            invoiceNumber: invoiceNumber || undefined,
            customerEmail: customerEmail || undefined,
            customerName: customerName || undefined,
            customerCompany: customerCompany || undefined,
            invoiceDescription: invoiceDesc || undefined,
            createdAt: Date.now(),
          });
        }

        return c.json({
          id: chargeData.id,
          amount: chargeData.amount,
          currency: chargeData.currency,
          status: chargeData.status,
          authorized: chargeData.authorized,
          paid: chargeData.paid,
          authorize_uri: chargeData.authorize_uri || null,
          return_uri: chargeData.return_uri || null,
          failure_code: chargeData.failure_code || null,
          failure_message: chargeData.failure_message || null,
          client_ref: client_ref || null,
          customer_id: customerId || chargeData.customer || null,
          invoice_number: invoiceNumber || (chargeData.metadata && chargeData.metadata.invoice_number) || null,
          invoice_description: invoiceDesc,
          customer: customerEmail ? {
            email: customerEmail,
            name: customerName || null,
            company: customerCompany || null,
          } : null,
          card: chargeData.card
            ? {
              last_digits: chargeData.card.last_digits,
              brand: chargeData.card.brand,
              name: chargeData.card.name,
            }
            : null,
          created_at: chargeData.created_at,
        });
      } catch (err: any) {
        console.error('Charge API error:', err);
        return c.json(
          { error: err.message || 'Internal server error' },
          500,
        );
      }
    }

    // ──────────────────────────────────────────────────
    // GET /api/charge/ref/:ref — Retrieve charge via client_ref
    // ──────────────────────────────────────────────────
    const refMatch = c.req.path.match(/^\/api\/charge\/ref\/([a-zA-Z0-9_\-]+)$/);
    if (refMatch && c.req.method === 'GET') {
      const ref = refMatch[1];
      if (!ref) {
        return c.json({ error: 'Invalid reference' }, 400);
      }
      const entry = pendingChargesMap.get(ref);
      if (!entry) {
        return c.json({ error: 'No charge found for this reference' }, 404);
      }
      const chargeId = entry.chargeId;
      const secretKey = getSecretKey();
      if (!isSecretKeyReady(secretKey)) {
        return c.json({ error: 'Omise Secret Key is not configured' }, 503);
      }

      try {
        const chargeResponse = await fetch(
          `https://api.omise.co/charges/${chargeId}`,
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
        return c.json({
          id: chargeData.id,
          amount: chargeData.amount,
          currency: chargeData.currency,
          status: chargeData.status,
          authorized: chargeData.authorized,
          paid: chargeData.paid,
          failure_code: chargeData.failure_code || null,
          failure_message: chargeData.failure_message || null,
          customer_id: entry.customerId || chargeData.customer || null,
          invoice_number: entry.invoiceNumber || (chargeData.metadata && chargeData.metadata.invoice_number) || null,
          invoice_description: entry.invoiceDescription || chargeData.description || null,
          customer: entry.customerEmail || (chargeData.metadata && chargeData.metadata.customer_email) ? {
            email: entry.customerEmail || chargeData.metadata?.customer_email,
            name: entry.customerName || chargeData.metadata?.customer_name || null,
            company: entry.customerCompany || chargeData.metadata?.customer_company || null,
          } : null,
          card: chargeData.card
            ? {
              last_digits: chargeData.card.last_digits,
              brand: chargeData.card.brand,
              name: chargeData.card.name,
            }
            : null,
          created_at: chargeData.created_at,
        });
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
        const chargeId = chargeIdMatch[1];
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

        return c.json({
          id: chargeData.id,
          amount: chargeData.amount,
          currency: chargeData.currency,
          status: chargeData.status,
          authorized: chargeData.authorized,
          paid: chargeData.paid,
          failure_code: chargeData.failure_code || null,
          failure_message: chargeData.failure_message || null,
          customer_id: chargeData.customer || (chargeData.metadata && chargeData.metadata.customer_id) || null,
          invoice_number: (chargeData.metadata && chargeData.metadata.invoice_number) || null,
          invoice_description: chargeData.description || null,
          customer: (chargeData.metadata && chargeData.metadata.customer_email) ? {
            email: chargeData.metadata.customer_email,
            name: chargeData.metadata.customer_name || null,
            phone: chargeData.metadata.customer_phone || null,
            company: chargeData.metadata.customer_company || null,
          } : null,
          card: chargeData.card
            ? {
              last_digits: chargeData.card.last_digits,
              brand: chargeData.card.brand,
              name: chargeData.card.name,
            }
            : null,
          created_at: chargeData.created_at,
        });
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
