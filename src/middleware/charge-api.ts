import fs from 'node:fs';
import path from 'node:path';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { MiddlewareHandler } from 'hono';
import { OMISE_CONFIG } from '../config/omise';

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

function getAuthHeader(secretKey: string): string {
  return 'Basic ' + Buffer.from(secretKey + ':').toString('base64');
}

/**
 * In-memory map to store 3DS reference mappings (client_ref -> charge_id)
 * Keeps items for 1 hour to handle delayed 3DS returns.
 */
interface PendingChargeEntry {
  chargeId: string;
  createdAt: number;
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

      return c.json({
        publicKey: isPublicReady ? publicKey : '',
        currency: 'sgd',
        isConfigured: isPublicReady && isSecretReady,
        isPublicKeySet: isPublicReady,
        isSecretKeySet: isSecretReady,
        isLive,
        minAmount: OMISE_CONFIG.minAmountSubunits,
        maxAmount: OMISE_CONFIG.maxAmountSubunits,
      });
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
        const { token, amount, currency, return_uri, client_ref } = body;

        // Input validations
        if (!token || typeof token !== 'string') {
          return c.json({ error: 'Missing or invalid card token' }, 400);
        }
        if (!amount || typeof amount !== 'number' || amount < OMISE_CONFIG.minAmountSubunits) {
          return c.json(
            { error: 'Invalid amount: minimum is S$1.00 (100 subunits)' },
            400,
          );
        }
        if (amount > OMISE_CONFIG.maxAmountSubunits) {
          return c.json(
            { error: 'Amount exceeds maximum: S$20,000.00 (2,000,000 subunits)' },
            400,
          );
        }
        if (!return_uri || typeof return_uri !== 'string') {
          return c.json(
            { error: 'Missing return_uri (required for Singapore 3D Secure verification)' },
            400,
          );
        }

        // Singapore Omise transactions strictly require SGD
        const finalCurrency = 'sgd';

        // Build charge parameters
        const chargeParams = new URLSearchParams({
          amount: amount.toString(),
          currency: finalCurrency,
          card: token,
          return_uri: return_uri,
          capture: 'true',
        });

        // Request Omise API
        const chargeResponse = await fetch('https://api.omise.co/charges', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: getAuthHeader(secretKey),
          },
          body: chargeParams,
        });

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
                'Charge creation failed',
              code: chargeData.code || 'charge_failed',
            },
            statusCode,
          );
        }

        // Cache client_ref mapping to charge.id for 3DS return resolution
        if (client_ref && typeof client_ref === 'string') {
          pendingChargesMap.set(client_ref, {
            chargeId: chargeData.id,
            createdAt: Date.now(),
          });
        }
        if (chargeData.id) {
          pendingChargesMap.set(chargeData.id, {
            chargeId: chargeData.id,
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
