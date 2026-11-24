import fs from 'node:fs';
import path from 'node:path';

export interface StoredChargeEntry {
  chargeId: string;
  clientRef?: string | undefined;
  createdAt: number;
  updatedAt: number;
  customerId?: string | undefined;
  invoiceNumber?: string | undefined;
  customerEmail?: string | undefined;
  customerName?: string | undefined;
  cardholderName?: string | undefined;
  cardholderEmail?: string | undefined;
  isThirdPartyCard?: boolean | undefined;
  invoiceDescription?: string | undefined;
  amount?: number | undefined;
  currency?: string | undefined;
  status?: string | undefined;
  paid?: boolean | undefined;
  authorized?: boolean | undefined;
  failureCode?: string | null | undefined;
  failureMessage?: string | null | undefined;
  lastWebhookEventId?: string | undefined;
}

export interface WebhookEventRecord {
  eventId: string;
  key: string;
  chargeId: string;
  status: string;
  paid: boolean;
  authorized: boolean;
  receivedAt: string;
}

interface PersistedStorePayload {
  chargesById: Record<string, StoredChargeEntry>;
  refToChargeId: Record<string, string>;
  customersByEmail: Record<string, string>;
  webhookEvents: WebhookEventRecord[];
}

const DEFAULT_STORE_PATH = path.resolve(process.cwd(), 'data', 'charge-store.json');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WEBHOOK_EVENTS = 200;

let storeFilePath = DEFAULT_STORE_PATH;
let loadedFromDisk = false;

const chargesByIdMap = new Map<string, StoredChargeEntry>();
const refToChargeIdMap = new Map<string, string>();
const customersByEmailMap = new Map<string, string>();
let webhookEventsList: WebhookEventRecord[] = [];
const processedEventIdsSet = new Set<string>();

/**
 * Configure store file path (useful for isolated tests).
 */
export function setChargeStorePath(customPath: string): void {
  storeFilePath = customPath;
  loadedFromDisk = false;
  chargesByIdMap.clear();
  refToChargeIdMap.clear();
  customersByEmailMap.clear();
  webhookEventsList = [];
  processedEventIdsSet.clear();
}

function ensureLoaded(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    if (!fs.existsSync(storeFilePath)) return;
    const raw = fs.readFileSync(storeFilePath, 'utf-8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as Partial<PersistedStorePayload>;

    if (parsed.chargesById && typeof parsed.chargesById === 'object') {
      for (const [id, entry] of Object.entries(parsed.chargesById)) {
        if (entry && entry.chargeId) {
          chargesByIdMap.set(id, entry);
        }
      }
    }
    if (parsed.refToChargeId && typeof parsed.refToChargeId === 'object') {
      for (const [ref, chgId] of Object.entries(parsed.refToChargeId)) {
        if (typeof chgId === 'string') {
          refToChargeIdMap.set(ref, chgId);
        }
      }
    }
    if (parsed.customersByEmail && typeof parsed.customersByEmail === 'object') {
      for (const [email, custId] of Object.entries(parsed.customersByEmail)) {
        if (typeof custId === 'string') {
          customersByEmailMap.set(email.toLowerCase(), custId);
        }
      }
    }
    if (Array.isArray(parsed.webhookEvents)) {
      webhookEventsList = parsed.webhookEvents.slice(-MAX_WEBHOOK_EVENTS);
      for (const evt of webhookEventsList) {
        if (evt?.eventId) {
          processedEventIdsSet.add(evt.eventId);
        }
      }
    }
  } catch (err) {
    console.warn('ChargeStore load warning:', err);
  }
}

function pruneExpiredEntries(): void {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  for (const [id, entry] of chargesByIdMap.entries()) {
    const timestamp = entry.updatedAt || entry.createdAt;
    if (timestamp < cutoff) {
      chargesByIdMap.delete(id);
      if (entry.clientRef) {
        refToChargeIdMap.delete(entry.clientRef);
      }
    }
  }
  for (const [ref, chgId] of refToChargeIdMap.entries()) {
    if (!chargesByIdMap.has(chgId)) {
      refToChargeIdMap.delete(ref);
    }
  }
}

function persistToDisk(): void {
  try {
    pruneExpiredEntries();
    const dir = path.dirname(storeFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload: PersistedStorePayload = {
      chargesById: Object.fromEntries(chargesByIdMap.entries()),
      refToChargeId: Object.fromEntries(refToChargeIdMap.entries()),
      customersByEmail: Object.fromEntries(customersByEmailMap.entries()),
      webhookEvents: webhookEventsList.slice(-MAX_WEBHOOK_EVENTS),
    };
    const tmpPath = `${storeFilePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, storeFilePath);
  } catch (err) {
    console.warn('ChargeStore persist warning:', err);
  }
}

/**
 * Save or merge a charge record indexed by both chargeId and optional clientRef.
 */
export function savePendingCharge(entry: StoredChargeEntry): void {
  ensureLoaded();
  const existing = chargesByIdMap.get(entry.chargeId);
  const merged: StoredChargeEntry = {
    ...existing,
    ...entry,
    createdAt: existing?.createdAt ?? entry.createdAt,
    updatedAt: entry.updatedAt || Date.now(),
  };
  chargesByIdMap.set(merged.chargeId, merged);
  if (merged.clientRef) {
    refToChargeIdMap.set(merged.clientRef, merged.chargeId);
  }
  persistToDisk();
}

/**
 * Retrieve a charge entry by either client_ref or charge_id.
 */
export function getPendingCharge(key: string): StoredChargeEntry | undefined {
  ensureLoaded();
  const trimmed = key.trim();
  if (!trimmed) return undefined;

  const direct = chargesByIdMap.get(trimmed);
  if (direct) return direct;

  const mappedId = refToChargeIdMap.get(trimmed);
  if (mappedId) {
    return chargesByIdMap.get(mappedId);
  }

  return undefined;
}

/**
 * Check if a webhook event ID has already been processed (idempotency guard).
 */
export function isWebhookEventProcessed(eventId: string): boolean {
  ensureLoaded();
  return processedEventIdsSet.has(eventId);
}

/**
 * Update charge status from a verified Omise webhook event and record event history.
 */
export function updateChargeFromWebhook(
  chargeData: any,
  eventId: string,
  eventKey: string,
): StoredChargeEntry {
  ensureLoaded();
  const chargeId = String(chargeData.id);
  const existing = chargesByIdMap.get(chargeId);
  const now = Date.now();

  const metaClientRef =
    typeof chargeData?.metadata?.client_ref === 'string' && chargeData.metadata.client_ref
      ? chargeData.metadata.client_ref
      : undefined;

  const metaThirdParty = chargeData?.metadata?.is_third_party_card;
  const parsedThirdParty =
    typeof metaThirdParty === 'boolean'
      ? metaThirdParty
      : metaThirdParty === 'true'
        ? true
        : undefined;

  const updated: StoredChargeEntry = {
    chargeId,
    clientRef: existing?.clientRef || metaClientRef,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    customerId: existing?.customerId || (typeof chargeData.customer === 'string' ? chargeData.customer : undefined),
    invoiceNumber: existing?.invoiceNumber || (typeof chargeData?.metadata?.invoice_number === 'string' ? chargeData.metadata.invoice_number : undefined),
    customerEmail: existing?.customerEmail || (typeof chargeData?.metadata?.customer_email === 'string' ? chargeData.metadata.customer_email : undefined),
    customerName: existing?.customerName || (typeof chargeData?.metadata?.customer_name === 'string' ? chargeData.metadata.customer_name : undefined),
    cardholderName:
      existing?.cardholderName ||
      (typeof chargeData?.metadata?.cardholder_name === 'string' && chargeData.metadata.cardholder_name
        ? chargeData.metadata.cardholder_name
        : typeof chargeData?.card?.name === 'string'
          ? chargeData.card.name
          : undefined),
    cardholderEmail:
      existing?.cardholderEmail ||
      (typeof chargeData?.metadata?.cardholder_email === 'string' && chargeData.metadata.cardholder_email
        ? chargeData.metadata.cardholder_email
        : undefined),
    isThirdPartyCard: existing?.isThirdPartyCard ?? parsedThirdParty,
    invoiceDescription: existing?.invoiceDescription || (typeof chargeData.description === 'string' ? chargeData.description : undefined),
    amount: typeof chargeData.amount === 'number' ? chargeData.amount : existing?.amount,
    currency: typeof chargeData.currency === 'string' ? chargeData.currency : existing?.currency,
    status: typeof chargeData.status === 'string' ? chargeData.status : existing?.status,
    paid: typeof chargeData.paid === 'boolean' ? chargeData.paid : existing?.paid,
    authorized: typeof chargeData.authorized === 'boolean' ? chargeData.authorized : existing?.authorized,
    failureCode: chargeData.failure_code ?? existing?.failureCode ?? null,
    failureMessage: chargeData.failure_message ?? existing?.failureMessage ?? null,
    lastWebhookEventId: eventId,
  };

  chargesByIdMap.set(chargeId, updated);
  if (updated.clientRef) {
    refToChargeIdMap.set(updated.clientRef, chargeId);
  }

  if (!processedEventIdsSet.has(eventId)) {
    processedEventIdsSet.add(eventId);
    webhookEventsList.push({
      eventId,
      key: eventKey,
      chargeId,
      status: updated.status || 'unknown',
      paid: Boolean(updated.paid),
      authorized: Boolean(updated.authorized),
      receivedAt: new Date().toISOString(),
    });
    if (webhookEventsList.length > MAX_WEBHOOK_EVENTS) {
      webhookEventsList = webhookEventsList.slice(-MAX_WEBHOOK_EVENTS);
    }
  }

  persistToDisk();
  return updated;
}

/**
 * Return recent recorded webhook events (newest first).
 */
export function getRecentWebhookEvents(limit = 10): WebhookEventRecord[] {
  ensureLoaded();
  return webhookEventsList.slice(-limit).reverse();
}

/**
 * Look up cached Omise Customer ID by normalized lowercase email.
 */
export function getCachedCustomerIdByEmail(email: string): string | undefined {
  ensureLoaded();
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  return customersByEmailMap.get(normalized);
}

/**
 * Cache an email -> Omise Customer ID mapping and persist to disk.
 */
export function setCachedCustomerIdForEmail(email: string, customerId: string): void {
  ensureLoaded();
  const normalized = email.trim().toLowerCase();
  if (!normalized || !customerId) return;
  customersByEmailMap.set(normalized, customerId);
  persistToDisk();
}
