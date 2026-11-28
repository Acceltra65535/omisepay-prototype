'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  CountryConfig,
  POPULAR_COUNTRIES,
  SORTED_ALL_COUNTRIES,
  getCountryByCode,
  formatPostalCode,
} from '../config/countries';
import {
  validateAvsAddress,
  normalizeAvsForToken,
} from '../utils/avs';
import {
  SUPPORTED_CURRENCIES,
  isCardBrandSupportedForCurrency,
  isSupportedCurrency,
  type SupportedCurrency,
} from '../config/omise';
import type { ExchangeRatesData } from '../utils/fx-rates';

type PaymentStatus =
  | 'idle'
  | 'tokenizing'
  | 'charging'
  | 'awaiting_3ds'
  | 'verifying'
  | 'pending'
  | 'success'
  | 'failed';

interface ChargeResult {
  id: string;
  amount: number;
  currency: string;
  status: string;
  authorized: boolean;
  paid: boolean;
  authorize_uri: string | null;
  authenticated_by?: string | null;
  three_ds_verified?: boolean;
  payment_method?: string;
  reversed?: boolean;
  failure_code: string | null;
  failure_message: string | null;
  customer_id?: string | null;
  invoice_number?: string | null;
  invoice_description?: string | null;
  customer?: {
    email?: string | null;
    name?: string | null;
    phone?: string | null;
  } | null;
  payer?: {
    cardholder_name?: string | null;
    cardholder_email?: string | null;
    is_third_party_card?: boolean;
  } | null;
  card?: {
    last_digits: string;
    brand: string;
    name: string;
  };
  created_at?: string;
}

declare global {
  interface Window {
    Omise: {
      setPublicKey: (key: string) => void;
      createToken: (
        type: string,
        cardData: {
          name: string;
          number: string;
          expiration_month: number;
          expiration_year: number;
          security_code: string;
          street1?: string;
          street2?: string;
          city?: string;
          state?: string;
          postal_code?: string;
          country?: string;
          email?: string;
          phone_number?: string;
        },
        callback: (statusCode: number, response: any) => void,
      ) => void;
    };
    OmiseCard: any;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 19);
  if (/^3[47]/.test(digits)) {
    return digits
      .replace(/^(\d{4})(\d{0,6})(\d{0,5})/, (_, p1, p2, p3) =>
        [p1, p2, p3].filter(Boolean).join(' '),
      )
      .trim();
  }
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  if (digits.length >= 3) {
    return digits.slice(0, 2) + '/' + digits.slice(2);
  }
  return digits;
}

function getCardBrand(number: string): string {
  const n = number.replace(/\D/g, '');
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(n)) return 'discover';
  if (/^35(2[89]|[3-8])/.test(n)) return 'jcb';
  return '';
}

/**
 * Standard Luhn mod-10 checksum validation for 13-19 digit PANs.
 */
export function isValidLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Restrict amount input to digits with at most a single decimal point and 2 fractional digits.
 */
export function sanitizeAmountInput(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return '';
  const dotIdx = cleaned.indexOf('.');
  if (dotIdx === -1) {
    return cleaned.replace(/^0+(?=\d)/, '');
  }
  const intRaw = cleaned.slice(0, dotIdx);
  const intNormalized = intRaw === '' ? '0' : intRaw.replace(/^0+(?=\d)/, '');
  const fracRaw = cleaned.slice(dotIdx + 1).replace(/\./g, '').slice(0, 2);
  return `${intNormalized}.${fracRaw}`;
}

/**
 * Parse a decimal currency string (up to 2 decimal places) into exact integer subunits without float drift.
 */
export function parseAmountToSubunits(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const parts = trimmed.split('.');
  const intStr = parts[0] ?? '0';
  const fracStr = (parts[1] ?? '').padEnd(2, '0');
  const subunits = Number(intStr) * 100 + Number(fracStr);
  return Number.isSafeInteger(subunits) ? subunits : null;
}

// Card brands accepted by the Omise Singapore account (verified against Omise Vault:
// Visa / Mastercard / JCB are tokenized; Amex, Discover, Diners and UnionPay are rejected
// with "brand not supported"). Contact Omise support to enable more brands, then extend this list.
const ACCEPTED_CARD_BRANDS = ['visa', 'mastercard', 'jcb'] as const;
const ACCEPTED_BRANDS_LABEL = 'Visa, Mastercard, JCB';

// Turn Omise's raw "brand not supported (xxx)" error into an actionable message.
function friendlyBrandError(message: string, curr: SupportedCurrency): string {
  const allowedLabel = SUPPORTED_CURRENCIES[curr]?.supportedBrandsLabel || ACCEPTED_BRANDS_LABEL;
  if (/brand not supported/i.test(message)) {
    return `This card type is not supported for ${curr.toUpperCase()}. Please use a ${allowedLabel} card. (${message})`;
  }
  return message;
}

const CardBrandIcon = ({ brand }: { brand: string }) => {
  const icons: Record<string, string> = {
    visa: '💳 Visa',
    mastercard: '💳 Mastercard',
    amex: '💳 Amex',
    discover: '💳 Discover',
    jcb: '💳 JCB',
  };
  if (!brand) return null;
  return (
    <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
      {icons[brand] || brand.toUpperCase()}
    </span>
  );
};

// Dialing code helper for country
function getCountryDialCode(countryCode: string): string {
  const code = countryCode.toUpperCase();
  const dialCodes: Record<string, string> = {
    US: '+1',
    CA: '+1',
    SG: '+65',
    GB: '+44',
    AU: '+61',
    NZ: '+64',
    HK: '+852',
    CN: '+86',
    JP: '+81',
    TW: '+886',
    MY: '+60',
    TH: '+66',
    ID: '+62',
    PH: '+63',
    VN: '+84',
    KR: '+82',
    DE: '+49',
    FR: '+33',
    AE: '+971',
  };
  return dialCodes[code] || '+1';
}

export interface CurrencyReference {
  primary: string;
  secondary: string;
  text: string;
}

export function buildCurrencyReference(
  amountMajor: number,
  curr: SupportedCurrency,
  exchangeRates: ExchangeRatesData | null,
): CurrencyReference | null {
  if (!Number.isFinite(amountMajor) || amountMajor <= 0) return null;

  const rates = exchangeRates?.rates || { SGD: 1, USD: 0.745, CAD: 1.035 };
  const rateSourceNote = exchangeRates?.source === 'live' ? 'Live FX' : 'Indicative FX';
  const fromCode = curr.toUpperCase() as 'SGD' | 'USD' | 'CAD';
  const fromRate = rates[fromCode] || 1;
  const convertTo = (target: 'SGD' | 'USD' | 'CAD') =>
    ((amountMajor / fromRate) * (rates[target] || 1)).toFixed(2);

  const sgdAmt = convertTo('SGD');
  const usdAmt = convertTo('USD');
  const cadAmt = convertTo('CAD');

  if (curr === 'sgd') {
    return {
      primary: `≈ $${usdAmt} USD`,
      secondary: `≈ CA$${cadAmt} CAD`,
      text: `${rateSourceNote}: ~$${usdAmt} USD settled via Singapore Dollar`,
    };
  }
  if (curr === 'usd') {
    return {
      primary: `≈ S$${sgdAmt} SGD`,
      secondary: `≈ CA$${cadAmt} CAD`,
      text: `≈ S$${sgdAmt} SGD · Billed directly in USD via Omise Singapore Multi-Currency (${rateSourceNote})`,
    };
  }
  return {
    primary: `≈ $${usdAmt} USD`,
    secondary: `≈ S$${sgdAmt} SGD`,
    text: `≈ S$${sgdAmt} SGD · Billed directly in CAD via Omise Singapore Multi-Currency (${rateSourceNote})`,
  };
}

export function getAuthenticationBadge(
  result: Pick<ChargeResult, 'authenticated_by' | 'payment_method'>,
): { label: string; tone: 'emerald' | 'amber' } {
  const authUpper = (result.authenticated_by || '').toUpperCase();
  if (authUpper === '3DS') {
    return { label: '✓ 3D Secure 2.0 (3DS)', tone: 'emerald' };
  }
  if (authUpper === 'PASSKEY') {
    return { label: '✓ Passkey (3DS2)', tone: 'emerald' };
  }
  if (result.authenticated_by) {
    return { label: `✓ ${result.authenticated_by}`, tone: 'emerald' };
  }
  if (result.payment_method === 'apple_pay') {
    return { label: '✓ Apple Pay (Device Biometric)', tone: 'emerald' };
  }
  return { label: '⚠ Not 3DS Authenticated', tone: 'amber' };
}

export const LAST_CHARGE_STORAGE_KEY = 'omise_last_charge_id';

function getStoredLastChargeId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(LAST_CHARGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveStoredLastChargeId(chargeId: string): void {
  if (typeof window === 'undefined' || !chargeId) return;
  try {
    window.sessionStorage.setItem(LAST_CHARGE_STORAGE_KEY, chargeId);
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

function clearStoredLastChargeId(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(LAST_CHARGE_STORAGE_KEY);
  } catch {
    // Ignore storage access errors
  }
}

function normalizeInternationalPhone(raw: string): string {
  const cleaned = raw.trim().replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('00')) {
    return '+' + cleaned.slice(2);
  }
  return cleaned;
}

function randomInt(max: number): number {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    const arr = new Uint32Array(1);
    globalThis.crypto.getRandomValues(arr);
    const val = arr[0];
    if (val !== undefined) {
      return val % max;
    }
  }
  return Math.floor(Math.random() * max);
}

/**
 * Generate an order/invoice number formatted as:
 * CBJ + Unix ms timestamp + 5 mixed-case alphanumeric characters (no hyphens).
 */
export function generateOrderNumber(): string {
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const DIGITS = '0123456789';
  const ALL = UPPER + LOWER + DIGITS;

  const chars: string[] = [
    UPPER.charAt(randomInt(UPPER.length)),
    LOWER.charAt(randomInt(LOWER.length)),
    DIGITS.charAt(randomInt(DIGITS.length)),
    ALL.charAt(randomInt(ALL.length)),
    ALL.charAt(randomInt(ALL.length)),
  ];

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const a = chars[i];
    const b = chars[j];
    if (a !== undefined && b !== undefined) {
      chars[i] = b;
      chars[j] = a;
    }
  }

  return `CBJ${Date.now()}${chars.join('')}`;
}

type AddressField = 'country' | 'street1' | 'street2' | 'city' | 'state' | 'postalCode';

function AddressFields({
  idPrefix,
  title,
  value,
  config,
  errors,
  disabled,
  onChange,
}: {
  idPrefix: string;
  title: string;
  value: {
    country: string;
    street1: string;
    street2: string;
    city: string;
    state: string;
    postalCode: string;
  };
  config: CountryConfig;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (field: AddressField, value: string) => void;
}) {
  const inputClass = (field: AddressField) =>
    `w-full rounded-lg border px-3 py-2.5 text-sm outline-none ${errors[field] ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'} focus:border-indigo-400`;

  const selectCountry = (newCountry: string) => {
    onChange('country', newCountry);
    onChange('state', '');
    onChange('postalCode', '');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</span>
        <div className="h-px flex-1 bg-slate-100" />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-country`} className="mb-1.5 block text-sm font-medium text-slate-700">
          Country / Region <span className="text-red-500">*</span>
        </label>
        <select id={`${idPrefix}-country`} value={value.country} onChange={(e) => selectCountry(e.target.value)} className={inputClass('country')} disabled={disabled} autoComplete="country">
          <optgroup label="Popular Countries & Regions">
            {POPULAR_COUNTRIES.map((c) => <option key={`payer-pop-${c.code}`} value={c.code}>{c.name} ({c.code})</option>)}
          </optgroup>
          <optgroup label="All Countries & Regions (A-Z)">
            {SORTED_ALL_COUNTRIES.map((c) => <option key={`payer-all-${c.code}`} value={c.code}>{c.name} ({c.code})</option>)}
          </optgroup>
        </select>
        {errors.country && <p className="mt-1 text-xs text-red-500">{errors.country}</p>}
      </div>
      <div>
        <label htmlFor={`${idPrefix}-street1`} className="mb-1.5 block text-sm font-medium text-slate-700">Street Address (Line 1) <span className="text-red-500">*</span></label>
        <input id={`${idPrefix}-street1`} value={value.street1} onChange={(e) => onChange('street1', e.target.value)} className={inputClass('street1')} placeholder="Building / house number and street" autoComplete="address-line1" maxLength={50} disabled={disabled} />
        {errors.street1 && <p className="mt-1 text-xs text-red-500">{errors.street1}</p>}
      </div>
      <div>
        <label htmlFor={`${idPrefix}-street2`} className="mb-1.5 block text-sm font-medium text-slate-700">Address Line 2 <span className="text-xs font-normal text-slate-400">Optional</span></label>
        <input id={`${idPrefix}-street2`} value={value.street2} onChange={(e) => onChange('street2', e.target.value)} className={inputClass('street2')} placeholder="Apt, suite, unit or floor" autoComplete="address-line2" maxLength={50} disabled={disabled} />
        {errors.street2 && <p className="mt-1 text-xs text-red-500">{errors.street2}</p>}
      </div>
      <div>
        <label htmlFor={`${idPrefix}-city`} className="mb-1.5 block text-sm font-medium text-slate-700">City / Town <span className="text-red-500">*</span></label>
        <input id={`${idPrefix}-city`} value={value.city} onChange={(e) => onChange('city', e.target.value)} className={inputClass('city')} placeholder="City name" autoComplete="address-level2" maxLength={50} disabled={disabled} />
        {errors.city && <p className="mt-1 text-xs text-red-500">{errors.city}</p>}
      </div>
      <div className={`grid gap-4 ${config.hasStates ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
        {config.hasStates && <div>
          <label htmlFor={`${idPrefix}-state`} className="mb-1.5 block text-sm font-medium text-slate-700">{config.stateLabel} <span className="text-red-500">*</span></label>
          {config.states?.length ? <select id={`${idPrefix}-state`} value={value.state} onChange={(e) => onChange('state', e.target.value)} className={inputClass('state')} disabled={disabled} autoComplete="address-level1">
            <option value="">Select {config.stateLabel}…</option>
            {config.states.map((item) => <option key={item.code} value={item.code}>{item.code} – {item.name}</option>)}
          </select> : <input id={`${idPrefix}-state`} value={value.state} onChange={(e) => onChange('state', e.target.value)} className={inputClass('state')} placeholder={config.stateLabel} autoComplete="address-level1" maxLength={50} disabled={disabled} />}
          {errors.state && <p className="mt-1 text-xs text-red-500">{errors.state}</p>}
        </div>}
        <div>
          <label htmlFor={`${idPrefix}-postal`} className="mb-1.5 block text-sm font-medium text-slate-700">{config.postalLabel} {config.postalRequired && <span className="text-red-500">*</span>}</label>
          <input id={`${idPrefix}-postal`} value={value.postalCode} onChange={(e) => onChange('postalCode', e.target.value)} onBlur={() => value.postalCode && onChange('postalCode', formatPostalCode(value.country, value.postalCode))} className={inputClass('postalCode')} placeholder={config.postalPlaceholder} autoComplete="postal-code" maxLength={16} disabled={disabled} />
          {errors.postalCode && <p className="mt-1 text-xs text-red-500">{errors.postalCode}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Main Payment Form Component ─────────────────────────────

export const PaymentForm = () => {
  // Customer & Order Identity Fields (separated from Cardholder / Payment Info)
  const [invoiceNumber, setInvoiceNumber] = useState(() => generateOrderNumber());
  const [invoiceDescription, setInvoiceDescription] = useState('Professional Consulting Services');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');

  // Payment Currency & Amount (SGD default, plus USD and CAD)
  const [currency, setCurrency] = useState<SupportedCurrency>('sgd');
  const currencyConfig = SUPPORTED_CURRENCIES[currency] || SUPPORTED_CURRENCIES.sgd;
  const [amount, setAmount] = useState('1500.00');
  const [exchangeRates, setExchangeRates] = useState<ExchangeRatesData | null>(null);

  // Cardholder & Card Payment Details (can belong to a third-party cardholder)
  const [isThirdPartyCard, setIsThirdPartyCard] = useState(false);
  const [cardholderName, setCardholderName] = useState('');
  const [cardholderEmail, setCardholderEmail] = useState('');
  const [cardholderPhone, setCardholderPhone] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');

  // AVS International Billing Address Fields
  const [country, setCountry] = useState('US'); // Default to US to highlight US high-value compliance
  const [street1, setStreet1] = useState('');
  const [street2, setStreet2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [customerAddress, setCustomerAddress] = useState({
    country: 'US', street1: '', street2: '', city: '', state: '', postalCode: '',
  });

  // UI state & validation
  const [status, setStatus] = useState<PaymentStatus>('idle');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [chargeResult, setChargeResult] = useState<ChargeResult | null>(null);
  const [omiseLoaded, setOmiseLoaded] = useState(false);
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [isApplePayAvailable, setIsApplePayAvailable] = useState(false);
  const scriptLoaded = useRef(false);
  const publicKeyRef = useRef('');
  const applePayMerchantIdRef = useRef('');
  const verifyRunIdRef = useRef(0);
  const verifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVerifyEndpointRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && (window as any).ApplePaySession) {
      const isAvailable = (window as any).ApplePaySession.canMakePayments();
      setIsApplePayAvailable(isAvailable);
    }
    return () => {
      verifyRunIdRef.current += 1;
      if (verifyTimerRef.current) {
        clearTimeout(verifyTimerRef.current);
        verifyTimerRef.current = null;
      }
    };
  }, []);

  // Active country config
  const countryConfig: CountryConfig = useMemo(() => {
    return getCountryByCode(country);
  }, [country]);
  const customerAddressCountryConfig = useMemo(
    () => getCountryByCode(customerAddress.country),
    [customerAddress.country],
  );

  // Detected card brand
  const cardBrand = useMemo(() => getCardBrand(cardNumber), [cardNumber]);
  const maxCvcLength = cardBrand === 'amex' ? 4 : 3;

  // High-value calculation (>= 1,000 in currency, or US/CA card)
  const isHighValue = useMemo(() => {
    const amt = parseFloat(amount || '0');
    return country === 'US' || country === 'CA' || amt >= 1000;
  }, [amount, country]);

  const nameDiffersFromCustomer = Boolean(
    customerName.trim() &&
    cardholderName.trim() &&
    customerName.trim().toLowerCase() !== cardholderName.trim().toLowerCase(),
  );
  const showCardholderEmailField = isThirdPartyCard || nameDiffersFromCustomer;

  // Dynamic cross-currency reference for form input (uses live FX rates from /api/config with safe fallback)
  const currencyReference = useMemo(
    () => buildCurrencyReference(parseFloat(amount || '0'), currency, exchangeRates),
    [amount, currency, exchangeRates],
  );

  // Separate receipt FX reference anchored to actual charged amount & currency (prevents post-3DS default-state mismatch)
  const receiptCurrencyReference = useMemo(() => {
    if (!chargeResult || typeof chargeResult.amount !== 'number') return null;
    const rawCurr = (chargeResult.currency || currency).toLowerCase();
    const resCurr: SupportedCurrency = isSupportedCurrency(rawCurr) ? rawCurr : 'sgd';
    return buildCurrencyReference(chargeResult.amount / 100, resCurr, exchangeRates);
  }, [chargeResult, currency, exchangeRates]);

  // ── Load Configuration & Omise.js ─────────────────────────

  useEffect(() => {
    if (scriptLoaded.current) return;
    scriptLoaded.current = true;

    async function initOmise() {
      try {
        const res = await fetch('/api/config');
        const config = await res.json();
        setIsConfigured(config.isConfigured);
        setIsLive(config.isLive);
        if (config.applePayMerchantId) {
          applePayMerchantIdRef.current = config.applePayMerchantId;
        }
        if (config.exchangeRates) {
          setExchangeRates(config.exchangeRates);
        }

        if (config.defaultCurrency && ['sgd', 'usd', 'cad'].includes(config.defaultCurrency.toLowerCase())) {
          setCurrency(config.defaultCurrency.toLowerCase() as SupportedCurrency);
        }

        if (!config.isConfigured) {
          return;
        }

        const setupOmise = () => {
          if (config.publicKey) {
            publicKeyRef.current = config.publicKey;
          }
          if (window.Omise && config.publicKey) {
            window.Omise.setPublicKey(config.publicKey);
            setOmiseLoaded(true);
          }
        };

        if (window.Omise) {
          setupOmise();
          return;
        }

        const script = document.createElement('script');
        script.src = 'https://cdn.omise.co/omise.js';
        script.async = true;
        script.onload = setupOmise;
        script.onerror = () => {
          setError('Failed to load Omise.js payment library. Please refresh the page.');
        };
        document.head.appendChild(script);
      } catch (err) {
        console.error('Failed to load Omise configuration', err);
        setIsConfigured(false);
      }
    }

    initOmise();
  }, []);

  // ── On Mount: Check if returning from 3DS verification ────

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const chargeId = params.get('charge_id');
    const ref = params.get('ref');
    const sessionChargeId = getStoredLastChargeId();

    if (chargeId && chargeId.startsWith('chrg_')) {
      setStatus('verifying');
      verifyCharge(`/api/charge/${chargeId}`);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (ref && ref.startsWith('om_ref_')) {
      setStatus('verifying');
      verifyCharge(`/api/charge/ref/${ref}`);
      window.history.replaceState({}, '', window.location.pathname);
    } else if (sessionChargeId && sessionChargeId.startsWith('chrg_')) {
      setStatus('verifying');
      verifyCharge(`/api/charge/${sessionChargeId}`);
    }
  }, []);

  async function verifyCharge(endpoint: string, attempt = 1, runId?: number) {
    lastVerifyEndpointRef.current = endpoint;
    let activeRunId = runId;
    if (activeRunId === undefined) {
      verifyRunIdRef.current += 1;
      activeRunId = verifyRunIdRef.current;
      if (verifyTimerRef.current) {
        clearTimeout(verifyTimerRef.current);
        verifyTimerRef.current = null;
      }
    }

    if (activeRunId !== verifyRunIdRef.current) {
      return;
    }

    try {
      const response = await fetch(endpoint);
      const data = await response.json();

      if (activeRunId !== verifyRunIdRef.current) {
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to verify charge status');
      }

      setChargeResult(data);

      if (data.status === 'successful' && data.paid) {
        setStatus('success');
        clearStoredLastChargeId();
      } else if (data.status === 'failed' || data.status === 'reversed') {
        setError(
          data.failure_message ||
          `Payment declined (${data.failure_code || (data.status === 'reversed' ? 'three_ds_authentication_required' : 'transaction_declined')})`,
        );
        setStatus('failed');
        clearStoredLastChargeId();
      } else if (data.status === 'pending') {
        if (attempt <= 5) {
          verifyTimerRef.current = setTimeout(
            () => verifyCharge(endpoint, attempt + 1, activeRunId),
            2000,
          );
        } else {
          setError('');
          setStatus('pending');
          clearStoredLastChargeId();
        }
      } else {
        setError(`Unexpected charge status: ${data.status}`);
        setStatus('failed');
        clearStoredLastChargeId();
      }
    } catch (err: any) {
      if (activeRunId !== verifyRunIdRef.current) {
        return;
      }
      if (attempt <= 3) {
        verifyTimerRef.current = setTimeout(
          () => verifyCharge(endpoint, attempt + 1, activeRunId),
          2000,
        );
      } else {
        setError(err.message || 'Failed to verify payment');
        setStatus('failed');
        clearStoredLastChargeId();
      }
    }
  }

  // ── Country Switch Handler ─────────────────────────────────

  const handleCountryChange = (newCountryCode: string) => {
    setCountry(newCountryCode);
    setState('');
    setPostalCode('');
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next.country;
      delete next.state;
      delete next.postalCode;
      return next;
    });
  };

  const handlePostalChange = (raw: string) => {
    setPostalCode(raw);
    if (fieldErrors.postalCode) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next.postalCode;
        return next;
      });
    }
  };

  const handlePostalBlur = () => {
    if (postalCode) {
      const formatted = formatPostalCode(country, postalCode);
      setPostalCode(formatted);
    }
  };

  const handleCustomerAddressChange = (field: AddressField, value: string) => {
    setCustomerAddress((current) => ({ ...current, [field]: value }));
    const errorKey = `customerAddress.${field}`;
    if (fieldErrors[errorKey]) {
      setFieldErrors((current) => {
        const next = { ...current };
        delete next[errorKey];
        return next;
      });
    }
  };

  // ── Comprehensive Form, Invoicing & AVS Validation ────────

  const validateForm = useCallback((): {
    valid: boolean;
    mainError?: string | undefined;
    errors: Record<string, string>;
  } => {
    const errors: Record<string, string> = {};

    // 1. Amount validation (1.00 to 20,000.00 in selected currency, max 2 decimal places)
    const amountSubunits = parseAmountToSubunits(amount);
    const symbol = currencyConfig.symbol;
    if (amountSubunits === null) {
      errors.amount = 'Enter a valid amount with up to 2 decimal places (e.g. 150.00)';
    } else if (amountSubunits < 100) {
      errors.amount = `Minimum amount is ${symbol}1.00`;
    } else if (amountSubunits > 2000000) {
      errors.amount = `Maximum amount is ${symbol}20,000.00`;
    }

    // 2. Customer Information Validation (Order / Receipt Owner)
    if (!customerName.trim()) {
      errors.customerName = 'Customer full name is required';
    } else if (customerName.trim().length < 2) {
      errors.customerName = 'Customer name is too short';
    }

    if (!customerEmail.trim()) {
      errors.customerEmail = 'Customer email is required for payment receipt & order confirmation';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())) {
      errors.customerEmail = 'Please enter a valid customer email address';
    }

    if (!invoiceNumber.trim()) {
      errors.invoiceNumber = 'Invoice reference number is required';
    }

    // 3. Cardholder Information Validation (Payment Owner)
    if (!cardholderName.trim()) {
      errors.cardholderName = 'Cardholder name is required (as printed on the card)';
    } else if (cardholderName.trim().length < 2) {
      errors.cardholderName = 'Cardholder name is too short';
    }

      if (showCardholderEmailField && cardholderEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cardholderEmail.trim())) {
        errors.cardholderEmail = 'Please enter a valid cardholder email address';
      }

      if (cardholderPhone.trim()) {
        const normalizedPhone = normalizeInternationalPhone(cardholderPhone);
        if (!/^\+[1-9]\d{6,14}$/.test(normalizedPhone)) {
          errors.cardholderPhone = `Please enter an international phone number starting with + (e.g. ${getCountryDialCode(country)} 8123 4567)`;
        }
      }

      // 4. Card Number
      const rawCard = cardNumber.replace(/\D/g, '');
      if (!rawCard) {
        errors.cardNumber = 'Card number is required';
      } else if (rawCard.length < 13 || rawCard.length > 19) {
        errors.cardNumber = 'Invalid card number (13-19 digits required)';
      } else if (!isValidLuhn(rawCard)) {
        errors.cardNumber = 'Invalid card number — please check for typos (Luhn check failed)';
      } else if (!(ACCEPTED_CARD_BRANDS as readonly string[]).includes(cardBrand)) {
        errors.cardNumber = `This card type is not supported. Please use a ${ACCEPTED_BRANDS_LABEL} card.`;
      } else if (!isCardBrandSupportedForCurrency(cardBrand, currency)) {
        // Omise Multi-currency (non-SGD charges) only supports Visa / Mastercard.
        errors.cardNumber = `JCB cards are only supported for SGD payments. For ${currency.toUpperCase()}, please use a Visa or Mastercard (or switch currency to SGD).`;
      }

      // 5. Expiration Date
      const expiryParts = expiry.split('/');
      if (expiryParts.length !== 2) {
        errors.expiry = 'Invalid expiry format (MM/YY)';
      } else {
        const month = parseInt(expiryParts[0]!, 10);
        const year = parseInt(expiryParts[1]!, 10);
        if (isNaN(month) || month < 1 || month > 12) {
          errors.expiry = 'Invalid expiry month (01-12)';
        } else {
          const now = new Date();
          const currentYear = now.getFullYear() % 100;
          const currentMonth = now.getMonth() + 1;
          if (year < currentYear || (year === currentYear && month < currentMonth)) {
            errors.expiry = 'Card has expired';
          } else if (year > currentYear + 25) {
            errors.expiry = 'Invalid expiry year';
          }
        }
      }

      // 6. CVC / CVV
      const rawCvc = cvc.replace(/\D/g, '');
      const requiredCvcLen = cardBrand === 'amex' ? 4 : 3;
      if (!rawCvc) {
        errors.cvc = 'CVC code is required';
      } else if (rawCvc.length < requiredCvcLen) {
        errors.cvc = `${cardBrand === 'amex' ? '4' : '3'}-digit CVC required`;
      }

      // 7. Strict International AVS Address Validation
      const avsResult = validateAvsAddress(
        {
          country,
          street1,
          street2,
          city,
          state,
          postalCode,
        },
        countryConfig,
      );

      if (!avsResult.isValid) {
        Object.assign(errors, avsResult.errors);
      }

      const customerAddressResult = validateAvsAddress(
        {
          country: customerAddress.country,
          street1: customerAddress.street1,
          street2: customerAddress.street2,
          city: customerAddress.city,
          state: customerAddress.state,
          postalCode: customerAddress.postalCode,
        },
        customerAddressCountryConfig,
      );
      if (!customerAddressResult.isValid) {
        for (const [field, message] of Object.entries(customerAddressResult.errors)) {
          errors[`customerAddress.${field}`] = message;
        }
      }

      const errorKeys = Object.keys(errors);
      const valid = errorKeys.length === 0;
      const mainError = valid ? undefined : errors[errorKeys[0]!];

      return { valid, mainError, errors };
    }, [
      amount,
      customerName,
      customerEmail,
      country,
      isHighValue,
      invoiceNumber,
      cardholderName,
      cardholderEmail,
      cardholderPhone,
      showCardholderEmailField,
      cardNumber,
      expiry,
      cvc,
      cardBrand,
      street1,
      street2,
      city,
      state,
      postalCode,
      countryConfig,
      currency,
      currencyConfig,
      customerAddress,
      customerAddressCountryConfig,
    ]);

  // ── Apple Pay Flow ─────────────────────────────────────────

  const handleApplePay = async () => {
    setError('');
    const amountInCents = parseAmountToSubunits(amount);
    if (amountInCents === null) {
      setError('Please enter a valid amount with up to 2 decimal places before using Apple Pay.');
      return;
    }
    if (amountInCents < 100) {
      setError(`Please enter a valid amount (Minimum ${currencyConfig.symbol}1.00) before using Apple Pay.`);
      return;
    }
    if (amountInCents > 2000000) {
      setError(`Amount exceeds maximum (${currencyConfig.symbol}20,000.00) for Apple Pay.`);
      return;
    }
    if (customerEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())) {
      setError('Please enter a valid customer email address before using Apple Pay.');
      return;
    }
    if (showCardholderEmailField && cardholderEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cardholderEmail.trim())) {
      setError('Please enter a valid cardholder email address before using Apple Pay.');
      return;
    }
      const normalizedApplePayPhone = cardholderPhone.trim()
        ? normalizeInternationalPhone(cardholderPhone)
        : '';
    const hasCustomerAddress = [
      customerAddress.street1,
      customerAddress.street2,
      customerAddress.city,
      customerAddress.state,
      customerAddress.postalCode,
    ].some((value) => value.trim());
      if (normalizedApplePayPhone && !/^\+[1-9]\d{6,14}$/.test(normalizedApplePayPhone)) {
        setError(`Please enter a valid international cardholder phone number starting with + (e.g. ${getCountryDialCode(country)} 8123 4567).`);
        return;
      }

      const request = {
        countryCode: 'SG',
        currencyCode: currency.toUpperCase(),
        // Omise Multi-currency only accepts Visa / Mastercard, so JCB is offered for SGD only.
        supportedNetworks: [...currencyConfig.applePayNetworks],
        merchantCapabilities: ['supports3DS', 'supportsCredit', 'supportsDebit'],
        total: { label: 'Omise Pay', amount: (amountInCents / 100).toFixed(2) },
      };

      try {
        const session = new (window as any).ApplePaySession(3, request);

        session.onvalidatemerchant = async (event: any) => {
          try {
            const res = await fetch('/api/applepay/validate-merchant', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ validationUrl: event.validationURL }),
            });
            const merchantSession = await res.json();
            if (!res.ok) throw new Error(merchantSession.error || 'Merchant validation failed');
            session.completeMerchantValidation(merchantSession);
          } catch (err: any) {
            console.error('Apple Pay Merchant Validation Error:', err);
            session.abort();
            setError(err.message || 'Apple Pay Merchant Validation Failed. 请在 .env 中配置 APPLE_MERCHANT_ID、APPLE_MERCHANT_CERT_PATH、APPLE_MERCHANT_KEY_PATH。');
            setStatus('idle');
          }
        };

        session.onpaymentauthorized = async (event: any) => {
          try {
            setStatus('tokenizing');

            // Tokenize Apple Pay with Omise Vault.
            // Omise requires tokenization[method], tokenization[data], tokenization[merchant_id]
            // (the Apple Pay Merchant ID registered with Omise, e.g. merchant.omise.sg.prod) and
            // tokenization[brand] (the network the customer picked in the sheet, e.g. "Visa").
            // Without brand, the resulting card has no brand and Omise rejects it as "brand not supported".
            const token = await new Promise<string>(async (resolve, reject) => {
              try {
                const pk = publicKeyRef.current;
                if (!pk) {
                  return reject(new Error('Omise Public Key not loaded for Apple Pay'));
                }
                const merchantId = applePayMerchantIdRef.current;
                if (!merchantId) {
                  return reject(
                    new Error('Apple Pay Merchant ID is not configured. 请在 .env 中设置 APPLE_MERCHANT_ID 并重启服务。'),
                  );
                }
                const paymentData = event.payment.token.paymentData;
                const formData = new URLSearchParams();
                formData.append('tokenization[method]', 'applepay');
                formData.append('tokenization[merchant_id]', merchantId);
                // Apple Pay reports "Visa" / "MasterCard" / "JCB", which match Omise's brand names.
                formData.append('tokenization[brand]', event.payment.token.paymentMethod?.network || '');
                formData.append(
                  'tokenization[data]',
                  typeof paymentData === 'string' ? paymentData : JSON.stringify(paymentData),
                );
                const vaultRes = await fetch('https://vault.omise.co/tokens', {
                  method: 'POST',
                  headers: {
                    Authorization: 'Basic ' + btoa(pk + ':'),
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: formData.toString(),
                });
                const vaultData = await vaultRes.json();
                if (vaultRes.ok && vaultData.id) {
                  resolve(vaultData.id);
                } else {
                  reject(new Error(vaultData.message || 'Apple Pay tokenization failed'));
                }
              } catch (vaultErr: any) {
                reject(new Error(vaultErr.message || 'Apple Pay tokenization network error'));
              }
            });

            setStatus('charging');
            const clientRef = 'om_ref_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
            const returnUri = window.location.origin + window.location.pathname + '?ref=' + clientRef;
            const applePayNetwork = String(event.payment.token.paymentMethod?.network || '').toLowerCase();

            const chargeResponse = await fetch('/api/charge', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                token,
                amount: amountInCents,
                currency: currency,
                return_uri: returnUri,
                client_ref: clientRef,
                is_apple_pay: true,
                card_brand: applePayNetwork || undefined,
                customer:
                  customerName.trim() || customerEmail.trim() || hasCustomerAddress
                    ? {
                      name: customerName.trim() || undefined,
                      email: customerEmail.trim() || undefined,
                      address: hasCustomerAddress
                        ? {
                          country: customerAddress.country,
                          street1: customerAddress.street1.trim(),
                          street2: customerAddress.street2.trim() || undefined,
                          city: customerAddress.city.trim(),
                          state: customerAddress.state.trim() || undefined,
                          postal_code: customerAddress.postalCode.trim() || undefined,
                        }
                        : undefined,
                    }
                    : undefined,
                payer: {
                  is_third_party_card: isThirdPartyCard,
                  cardholder_email:
                    showCardholderEmailField && cardholderEmail.trim()
                      ? cardholderEmail.trim()
                      : undefined,
                  cardholder_phone: normalizedApplePayPhone || undefined,
                },
                invoice: {
                  invoice_number: invoiceNumber.trim() || undefined,
                  description: invoiceDescription.trim() || undefined,
                },
              }),
          });

          const chargeData = await chargeResponse.json();
          if (!chargeResponse.ok) {
            throw new Error((chargeData as any).error || 'Payment processing failed');
          }

          if (chargeData.authorize_uri && (!chargeData.paid || chargeData.status === 'pending')) {
            session.completePayment({ status: (window as any).ApplePaySession.STATUS_SUCCESS });
            setStatus('awaiting_3ds');
            saveStoredLastChargeId(chargeData.id);
            window.location.href = chargeData.authorize_uri;
            return;
          }

          session.completePayment({ status: (window as any).ApplePaySession.STATUS_SUCCESS });
          setChargeResult(chargeData);
          if (chargeData.status === 'successful' && chargeData.paid) {
            clearStoredLastChargeId();
            setStatus('success');
          } else if (chargeData.status === 'failed' || chargeData.status === 'reversed') {
            clearStoredLastChargeId();
            setStatus('failed');
            setError(chargeData.failure_message || 'Payment failed');
          } else {
            saveStoredLastChargeId(chargeData.id);
            setStatus('verifying');
            verifyCharge(`/api/charge/${chargeData.id}`);
          }
        } catch (err: any) {
          console.error('Apple Pay Error:', err);
          clearStoredLastChargeId();
          session.completePayment({ status: (window as any).ApplePaySession.STATUS_FAILURE });
          setError(friendlyBrandError(err.message || 'Apple Pay transaction failed', currency));
          setStatus('idle');
        }
      };

      session.oncancel = () => {
        clearStoredLastChargeId();
        setStatus('idle');
      };

      session.begin();
    } catch (err: any) {
      console.error('Failed to start Apple Pay:', err);
      setError('Apple Pay is not available on this device or browser.');
      setStatus('idle');
    }
  };

  // ── Submit Payment ─────────────────────────────────────────

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');
      setFieldErrors({});

      if (!omiseLoaded) {
        setError('Payment security library is still initializing. Please wait a moment.');
        return;
      }

      const validation = validateForm();
      if (!validation.valid) {
        setFieldErrors(validation.errors);
        setError(validation.mainError || 'Please correct the highlighted fields.');
        return;
      }

      setStatus('tokenizing');

      const digits = cardNumber.replace(/\D/g, '');
      const expiryParts = expiry.split('/');
      const expirationMonth = parseInt(expiryParts[0]!, 10);
      const expirationYear = 2000 + parseInt(expiryParts[1]!, 10);

      try {
        // Step 1: Normalize AVS address and create secure token with Omise.js
        const normalizedAddress = normalizeAvsForToken(
          {
            country,
            street1,
            street2,
            city,
            state,
            postalCode,
          },
          countryConfig,
        );

        const effectiveThirdParty = isThirdPartyCard || nameDiffersFromCustomer;
        const tokenCardholderEmail = effectiveThirdParty
          ? cardholderEmail.trim() || undefined
          : customerEmail.trim() || undefined;
        const normalizedPhone = cardholderPhone.trim()
          ? normalizeInternationalPhone(cardholderPhone)
          : '';

        const tokenCardData: Record<string, string | number> = {
          name: cardholderName.trim(),
          number: digits,
          expiration_month: expirationMonth,
          expiration_year: expirationYear,
          security_code: cvc.replace(/\D/g, ''),
          country: normalizedAddress.country,
          street1: normalizedAddress.street1,
          city: normalizedAddress.city,
        };

        if (tokenCardholderEmail) {
          tokenCardData.email = tokenCardholderEmail;
        }
        if (normalizedPhone) {
          tokenCardData.phone_number = normalizedPhone;
        }
        if (normalizedAddress.street2) {
          tokenCardData.street2 = normalizedAddress.street2;
        }
        if (normalizedAddress.state) {
          tokenCardData.state = normalizedAddress.state;
        }
        if (normalizedAddress.postal_code) {
          tokenCardData.postal_code = normalizedAddress.postal_code;
        }

        const token = await new Promise<string>((resolve, reject) => {
          window.Omise.createToken(
            'card',
            tokenCardData as any,
            (statusCode: number, response: any) => {
              if (statusCode === 200) {
                resolve(response.id);
              } else {
                reject(
                  new Error(
                    response.message ||
                    response.location ||
                    'Card tokenization failed. Please verify your card details.',
                  ),
                );
              }
            },
          );
        });

        // Step 2: Create Customer Entity (when own card) and Charge with separated Customer & Payer info
        setStatus('charging');
        const amountInCents = parseAmountToSubunits(amount);
        if (amountInCents === null) {
          throw new Error('Enter a valid payment amount with up to 2 decimal places.');
        }

        const clientRef =
          'om_ref_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        const returnUri =
          window.location.origin + window.location.pathname + '?ref=' + clientRef;

        const chargeResponse = await fetch('/api/charge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            amount: amountInCents,
            currency: currency,
            return_uri: returnUri,
            client_ref: clientRef,
            card_brand: cardBrand || undefined,
            customer: {
              name: customerName.trim(),
              email: customerEmail.trim(),
              address: {
                country: customerAddress.country,
                street1: customerAddress.street1.trim(),
                street2: customerAddress.street2.trim() || undefined,
                city: customerAddress.city.trim(),
                state: customerAddress.state.trim() || undefined,
                postal_code: customerAddress.postalCode.trim() || undefined,
              },
            },
            payer: {
              cardholder_name: cardholderName.trim(),
              cardholder_email:
                effectiveThirdParty && cardholderEmail.trim()
                  ? cardholderEmail.trim()
                  : undefined,
              cardholder_phone: normalizedPhone || undefined,
              is_third_party_card: effectiveThirdParty,
            },
            invoice: {
              invoice_number: invoiceNumber.trim(),
              description: invoiceDescription.trim() || undefined,
            },
            billing: normalizedAddress,
          }),
        });

        const chargeData: ChargeResult = await chargeResponse.json();

        if (!chargeResponse.ok) {
          throw new Error(
            (chargeData as any).error || 'Payment processing failed',
          );
        }

        // Step 3: Handle result / mandatory 3D Secure redirection
        if (chargeData.authorize_uri && (!chargeData.paid || chargeData.status === 'pending')) {
          setStatus('awaiting_3ds');
          saveStoredLastChargeId(chargeData.id);
          const redirectUri = chargeData.authorize_uri;
          setTimeout(() => {
            window.location.href = redirectUri;
          }, 800);
        } else if (chargeData.status === 'successful' && chargeData.paid) {
          clearStoredLastChargeId();
          setChargeResult(chargeData);
          setStatus('success');
        } else if (chargeData.status === 'pending') {
          saveStoredLastChargeId(chargeData.id);
          setChargeResult(chargeData);
          setStatus('verifying');
          verifyCharge(`/api/charge/${chargeData.id}`);
        } else if (chargeData.status === 'failed' || chargeData.status === 'reversed') {
          clearStoredLastChargeId();
          throw new Error(
            chargeData.failure_message ||
            `Payment declined (${chargeData.failure_code || (chargeData.status === 'reversed' ? 'three_ds_authentication_required' : 'declined')})`,
          );
        } else {
          clearStoredLastChargeId();
          throw new Error(`Unexpected charge status: ${chargeData.status}`);
        }
      } catch (err: any) {
        setError(friendlyBrandError(err.message || 'An unexpected error occurred during payment.', currency));
        setStatus('idle');
      }
    },
    [
      customerName,
      customerEmail,
      cardholderName,
      cardholderEmail,
      cardholderPhone,
      isThirdPartyCard,
      nameDiffersFromCustomer,
      cardNumber,
      cardBrand,
      expiry,
      cvc,
      amount,
      invoiceNumber,
      invoiceDescription,
      country,
      street1,
      street2,
      city,
      state,
      postalCode,
      countryConfig,
      omiseLoaded,
      currency,
      validateForm,
    ],
  );

  const handleReset = () => {
    verifyRunIdRef.current += 1;
    if (verifyTimerRef.current) {
      clearTimeout(verifyTimerRef.current);
      verifyTimerRef.current = null;
    }
    lastVerifyEndpointRef.current = null;
    clearStoredLastChargeId();
    if (typeof window !== 'undefined' && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      if (params.has('ref') || params.has('charge_id')) {
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
    setInvoiceNumber(generateOrderNumber());
    setCustomerName('');
    setCustomerEmail('');
    setIsThirdPartyCard(false);
    setCardholderName('');
    setCardholderEmail('');
    setCardholderPhone('');
    setCardNumber('');
    setExpiry('');
    setCvc('');
    setAmount('1500.00');
    setCountry('US');
    setStreet1('');
    setStreet2('');
    setCity('');
    setState('');
    setPostalCode('');
    setStatus('idle');
    setError('');
    setFieldErrors({});
    setChargeResult(null);
  };

  const handleRefreshPendingStatus = () => {
    const endpoint =
      lastVerifyEndpointRef.current ||
      (chargeResult?.id ? `/api/charge/${chargeResult.id}` : null);
    if (!endpoint) return;
    setError('');
    setStatus('verifying');
    verifyCharge(endpoint);
  };

const isProcessing = status === 'tokenizing' || status === 'charging';

// Base styling for form inputs
const getInputClass = (fieldName: string) => {
  const hasError = Boolean(fieldErrors[fieldName]);
  return `w-full rounded-xl border ${hasError
    ? 'border-red-400 bg-red-50/20 text-red-900 focus:border-red-500 focus:ring-red-100'
    : 'border-slate-200 bg-slate-50/50 text-slate-800 focus:border-indigo-400 focus:bg-white focus:ring-indigo-100'
    } px-4 py-3 text-sm transition-all placeholder:text-slate-400 focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60`;
};

// ── Render: Verifying (after 3DS callback) ─────────────────

if (status === 'verifying') {
  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-50">
          <svg className="h-8 w-8 animate-spin text-indigo-600" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
        <h3 className="mb-2 text-xl font-bold text-slate-800">Verifying Bank Authorization</h3>
        <p className="text-sm text-slate-500">
          Confirming 3D Secure 2.0 authorization with your card issuer…
        </p>
      </div>
    </div>
  );
}

// ── Render: Awaiting 3DS Redirect ──────────────────────────

if (status === 'awaiting_3ds') {
  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-blue-50 p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-100">
          <svg className="h-8 w-8 animate-spin text-indigo-600" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
        <h3 className="mb-2 text-xl font-bold text-indigo-800">
          3D Secure 2.0 Identity Verification
        </h3>
        <p className="text-sm text-indigo-600">
          Connecting to your card issuer bank for authentication…
        </p>
        <p className="mt-3 text-xs text-slate-500">
          Please do not close or refresh this window.
        </p>
      </div>
    </div>
  );
}

// ── Render: Pending Bank Confirmation (after polling timeout) ─

if (status === 'pending') {
  const pendingCurrRaw = (chargeResult?.currency || currency).toLowerCase();
  const pendingCurr: SupportedCurrency = isSupportedCurrency(pendingCurrRaw) ? pendingCurrRaw : 'sgd';
  const pendingCfg = SUPPORTED_CURRENCIES[pendingCurr] || SUPPORTED_CURRENCIES.sgd;
  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-white to-indigo-50/40 p-6 sm:p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-amber-700">
          <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h3 className="mb-2 text-xl font-bold text-slate-900">
          Payment Processing — Do Not Pay Again
        </h3>
        <p className="mb-5 text-sm text-slate-600 leading-relaxed">
          Your card issuer bank is still finalizing 3D Secure 2.0 confirmation. Please wait a moment and click below to refresh status rather than submitting a second payment.
        </p>
        {chargeResult && (
          <div className="mb-6 space-y-2 rounded-xl border border-amber-200/80 bg-white/80 p-4 text-left text-xs sm:text-sm">
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Invoice Reference</span>
              <span className="font-mono font-medium text-slate-800">
                {chargeResult.invoice_number || invoiceNumber}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Transaction ID</span>
              <span className="font-mono text-xs text-slate-700">
                {chargeResult.id}
              </span>
            </div>
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Amount</span>
              <span className="font-semibold text-slate-900">
                {pendingCfg.symbol}{(chargeResult.amount / 100).toFixed(2)} {pendingCfg.code.toUpperCase()}
              </span>
            </div>
            <div className="flex justify-between items-center py-1">
              <span className="text-slate-500">Status</span>
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                Pending Bank Confirmation
              </span>
            </div>
          </div>
        )}
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={handleRefreshPendingStatus}
            className="flex-1 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-indigo-700 active:scale-[0.98]"
          >
            Refresh Payment Status
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="flex-1 rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-medium text-slate-700 transition-all hover:bg-slate-50 active:scale-[0.98]"
          >
            Start a New Payment
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Only start a new payment if you have confirmed with your bank that this charge was cancelled.
        </p>
      </div>
    </div>
  );
}

// ── Render: Success (Stripe Invoicing Style Receipt) ───────

if (status === 'success' && chargeResult) {
  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="rounded-2xl border border-emerald-200 bg-white p-6 sm:p-8 text-left shadow-2xl">
        {/* Header & Paid Stamp */}
        <div className="mb-6 flex items-start justify-between border-b border-slate-100 pb-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              <h3 className="text-xl font-bold text-slate-800">Payment Receipt</h3>
            </div>
            <p className="mt-1 text-xs text-slate-500 font-mono">
              {chargeResult.invoice_number || invoiceNumber} · {(() => {
                const parsed = chargeResult.created_at ? new Date(chargeResult.created_at) : null;
                const displayDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
                return displayDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
              })()}
            </p>
          </div>
          <div className="rounded-lg border-2 border-emerald-600 bg-emerald-50 px-3 py-1 text-center font-bold uppercase tracking-wider text-emerald-700 text-sm">
            PAID ✓
          </div>
        </div>

        {/* Amount Summary */}
        {(() => {
          const rawCurr = (chargeResult.currency || currency).toLowerCase();
          const resCurr: SupportedCurrency = isSupportedCurrency(rawCurr) ? rawCurr : 'sgd';
          const resCfg = SUPPORTED_CURRENCIES[resCurr] || SUPPORTED_CURRENCIES.sgd;
          return (
            <div className="mb-6 rounded-xl bg-slate-50 p-4 border border-slate-100">
              <span className="text-xs uppercase font-semibold text-slate-400">Total Amount Paid</span>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-slate-900">
                  {resCfg.symbol}{(chargeResult.amount / 100).toFixed(2)}
                </span>
                <span className="text-sm font-semibold text-slate-500">{resCfg.code.toUpperCase()}</span>
              </div>
              {receiptCurrencyReference && (
                <p className="mt-1 text-xs text-slate-500">
                  {receiptCurrencyReference.text}
                </p>
              )}
            </div>
          );
        })()}

        {/* Invoice & Customer Details Table */}
        <div className="mb-6 space-y-3 rounded-xl border border-slate-100 bg-slate-50/50 p-4 text-xs sm:text-sm">
          <div className="flex justify-between py-1 border-b border-slate-100">
            <span className="text-slate-500">Invoice Reference</span>
            <span className="font-mono font-medium text-slate-800">
              {chargeResult.invoice_number || invoiceNumber}
            </span>
          </div>
          <div className="flex justify-between py-1 border-b border-slate-100">
            <span className="text-slate-500">Description</span>
            <span className="text-slate-800 font-medium">
              {chargeResult.invoice_description || invoiceDescription}
            </span>
          </div>
          {chargeResult.customer_id && (
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Omise Customer Entity</span>
              <span className="font-mono text-xs text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded">
                {chargeResult.customer_id}
              </span>
            </div>
          )}
          <div className="flex justify-between py-1 border-b border-slate-100">
            <span className="text-slate-500">Customer Name</span>
            <span className="text-slate-800 font-medium">
              {chargeResult.customer?.name || customerName || '—'}
            </span>
          </div>
          <div className="flex justify-between py-1 border-b border-slate-100">
            <span className="text-slate-500">Customer Email</span>
            <span className="text-slate-800">
              {chargeResult.customer?.email || customerEmail || '—'}
            </span>
          </div>
          {(chargeResult.payer?.cardholder_name || chargeResult.card?.name || cardholderName) && (
            <div className="flex justify-between items-center py-1 border-b border-slate-100">
              <span className="text-slate-500">Cardholder Name</span>
              <span className="flex items-center gap-2 text-slate-800 font-medium">
                <span>{chargeResult.payer?.cardholder_name || chargeResult.card?.name || cardholderName}</span>
                {chargeResult.payer?.is_third_party_card && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                    Third-Party Card
                  </span>
                )}
              </span>
            </div>
          )}
          {chargeResult.payer?.cardholder_email && (
            <div className="flex justify-between py-1 border-b border-slate-100">
              <span className="text-slate-500">Cardholder Email</span>
              <span className="text-slate-800">
                {chargeResult.payer.cardholder_email}
              </span>
            </div>
          )}
          <div className="flex justify-between py-1 border-b border-slate-100">
            <span className="text-slate-500">Transaction ID</span>
            <span className="font-mono text-xs text-slate-700">
              {chargeResult.id}
            </span>
          </div>
          <div className="flex justify-between py-1 border-b border-slate-100">
            <span className="text-slate-500">Authentication</span>
            {(() => {
              const badge = getAuthenticationBadge(chargeResult);
              return (
                <span
                  className={
                    badge.tone === 'emerald'
                      ? 'inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700'
                      : 'inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800'
                  }
                >
                  {badge.label}
                </span>
              );
            })()}
          </div>
          {chargeResult.card && (
            <div className="flex justify-between py-1">
              <span className="text-slate-500">Payment Card</span>
              <span className="text-slate-800 font-medium">
                {chargeResult.card.brand.toUpperCase()} •••• {chargeResult.card.last_digits}
              </span>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => window.print()}
            className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-all hover:bg-slate-50 hover:shadow active:scale-[0.98] text-center"
          >
            🖨️ Print Invoice Receipt
          </button>
          <button
            onClick={handleReset}
            className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-indigo-700 hover:shadow-lg active:scale-[0.98] text-center"
          >
            Pay Another Invoice
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Render: Failed ─────────────────────────────────────────

if (status === 'failed') {
  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="rounded-2xl border border-red-200 bg-gradient-to-br from-red-50 to-orange-50 p-8 text-center shadow-xl">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
          <svg className="h-8 w-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
        <h3 className="mb-2 text-2xl font-bold text-red-800">
          Payment Declined by Card Issuer
        </h3>
        <p className="mb-4 text-sm text-red-600">{error}</p>
        {chargeResult && (
          <div className="mb-6 space-y-2 rounded-xl bg-white/70 p-4 text-left text-sm backdrop-blur-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Transaction ID</span>
              <span className="font-mono text-xs text-slate-700">
                {chargeResult.id}
              </span>
            </div>
            {chargeResult.failure_code && (
              <div className="flex justify-between">
                <span className="text-slate-500">Decline Code</span>
                <span className="font-mono text-xs text-red-600">
                  {chargeResult.failure_code}
                </span>
              </div>
            )}
          </div>
        )}
        <button
          onClick={handleReset}
          className="w-full rounded-xl bg-red-600 px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-red-700 hover:shadow-lg active:scale-[0.98]"
        >
          Review Details & Try Again
        </button>
      </div>
    </div>
  );
}

// ── Render: Interactive Payment Form ───────────────────────

return (
  <div className="mx-auto w-full max-w-xl">
    <div className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-xl shadow-slate-200/50">
      {/* Configuration Notice */}
      {isConfigured === false && (
        <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-bold">⚠️ Omise Configuration Required</p>
          <p className="mt-1">
            Please configure your Omise Live Public & Secret Keys in <code className="rounded bg-amber-100 px-1 font-mono text-xs">.env</code> to activate live processing.
          </p>
        </div>
      )}

      {/* Invoice Header Badge (Stripe Invoicing Style) */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <span
              suppressHydrationWarning
              className="rounded-md bg-indigo-100 px-2.5 py-1 text-xs font-bold text-indigo-700 font-mono"
            >
              {invoiceNumber}
            </span>
            <span className="text-xs text-slate-400">Invoice Checkout</span>
          </div>
          <h2 className="mt-1 text-xl font-extrabold text-slate-800">
            International Payment Portal
          </h2>
        </div>
        <div className="text-right">
          <span className="text-xs text-slate-400">Amount Due</span>
          <div className="text-lg font-black text-slate-900">
            {currencyConfig.symbol}{parseFloat(amount || '0').toFixed(2)}{' '}
            <span className="text-xs font-semibold text-slate-500">{currencyConfig.code.toUpperCase()}</span>
          </div>
          {currencyReference && (
            <span className="text-xs font-medium text-indigo-600 block">
              {currencyReference.primary}
            </span>
          )}
        </div>
      </div>

      {/* Currency Selector Pill Control */}
      <div className="mb-6 rounded-2xl bg-gradient-to-r from-slate-50 via-indigo-50/40 to-slate-50 p-4 border border-slate-200/80 shadow-sm">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
            <span>💳</span> Payment Currency
          </span>
          <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">
            Multi-Currency (SGD · USD · CAD)
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {(['sgd', 'usd', 'cad'] as const).map((curr) => {
            const cfg = SUPPORTED_CURRENCIES[curr];
            const isSelected = currency === curr;
            return (
              <button
                key={curr}
                type="button"
                onClick={() => {
                  setCurrency(curr);
                  setFieldErrors((prev) => {
                    const next = { ...prev };
                    delete next.amount;
                    delete next.cardNumber;
                    return next;
                  });
                }}
                className={`flex flex-col sm:flex-row items-center justify-center gap-1.5 sm:gap-2 rounded-xl py-2.5 px-3 transition-all ${isSelected
                  ? 'bg-white text-indigo-700 shadow-md ring-2 ring-indigo-500 font-bold'
                  : 'bg-white/70 text-slate-600 hover:bg-white hover:text-slate-900 border border-slate-200/80 font-medium'
                  }`}
              >
                <span className="text-lg sm:text-base leading-none">{cfg.flag}</span>
                <div className="text-center sm:text-left">
                  <span className="block text-xs sm:text-sm leading-tight">{cfg.code.toUpperCase()}</span>
                  <span className="text-[10px] text-slate-400 block leading-tight">{cfg.symbol}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* High-Value Anti-Fraud Compliance Shield */}
      {isHighValue && (
        <div className="mb-6 rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50/90 via-blue-50/70 to-slate-50 p-4 text-xs text-indigo-950 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="text-xl">🏛️</span>
            <div className="space-y-1">
              <span className="font-bold text-indigo-900">
                High-Value Transaction Anti-Fraud Shield
              </span>
              <p className="text-slate-600 leading-relaxed">
                In compliance with international card network (Visa / Mastercard / JCB) standards, Customer order identity and Cardholder AVS billing verification are kept strictly separated with Level 2 Invoice metadata and mandatory 3D Secure 2.0. This maximizes approval rates even when paying with a third-party card.
              </p>
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ═══════════════════════════════════════════════ */}
        {/* Step 1: Customer & Order Information            */}
        {/* ═══════════════════════════════════════════════ */}
        <div aria-labelledby="customer-order-heading" className="rounded-2xl border border-indigo-100 bg-indigo-50/20 p-4 sm:p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 pb-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                1
              </span>
              <div>
                <h3 id="customer-order-heading" className="text-sm font-bold text-slate-800">
                  Customer & Order
                </h3>
                <p className="text-xs text-slate-500">
                  The invoice recipient. Payment receipts and order confirmations go to this customer.
                </p>
              </div>
            </div>
          </div>

          {/* Amount Field */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="amount" className="block text-sm font-medium text-slate-700">
                Payment Amount ({currencyConfig.code.toUpperCase()})
              </label>
              {currencyReference && (
                <span className="text-xs font-medium text-slate-400">
                  {currencyReference.primary}
                </span>
              )}
            </div>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-500">
                {currencyConfig.symbol}
              </span>
              <input
                id="amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(sanitizeAmountInput(e.target.value));
                  if (fieldErrors.amount) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.amount;
                      return next;
                    });
                  }
                }}
                className={getInputClass('amount') + (currencyConfig.symbol.length > 2 ? ' pl-14' : ' pl-11') + ' font-medium text-base bg-white'}
                placeholder="0.00"
                disabled={isProcessing}
              />
            </div>
            {fieldErrors.amount ? (
              <p className="mt-1 text-xs text-red-500">{fieldErrors.amount}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-400">
                Minimum {currencyConfig.symbol}1.00 · Maximum {currencyConfig.symbol}20,000.00 {currencyConfig.code.toUpperCase()}
              </p>
            )}
          </div>

          {/* Customer Name & Customer Email Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="customer_name" className="mb-1.5 block text-sm font-medium text-slate-700">
                Customer Full Name <span className="text-red-500">*</span>
              </label>
              <input
                id="customer_name"
                type="text"
                value={customerName}
                onChange={(e) => {
                  setCustomerName(e.target.value);
                  if (fieldErrors.customerName) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.customerName;
                      return next;
                    });
                  }
                }}
                className={getInputClass('customerName') + ' bg-white'}
                placeholder="e.g. Alex Chen"
                autoComplete="name"
                maxLength={70}
                disabled={isProcessing}
              />
              {fieldErrors.customerName ? (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.customerName}</p>
              ) : (
                <p className="mt-1 text-xs text-slate-400">Order / invoice recipient name</p>
              )}
            </div>

            <div>
              <label htmlFor="customer_email" className="mb-1.5 block text-sm font-medium text-slate-700">
                Customer Email <span className="text-red-500">*</span>
              </label>
              <input
                id="customer_email"
                type="email"
                value={customerEmail}
                onChange={(e) => {
                  setCustomerEmail(e.target.value);
                  if (fieldErrors.customerEmail) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.customerEmail;
                      return next;
                    });
                  }
                }}
                className={getInputClass('customerEmail') + ' bg-white'}
                placeholder="billing@company.com"
                autoComplete="email"
                disabled={isProcessing}
              />
              {fieldErrors.customerEmail ? (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.customerEmail}</p>
              ) : (
                <p className="mt-1 text-xs text-slate-400">For invoice receipt & confirmation</p>
              )}
            </div>
          </div>

          <div className="border-t border-indigo-100 pt-4">
            <AddressFields
              idPrefix="customer-address"
              title="Customer Address"
              value={customerAddress}
              config={customerAddressCountryConfig}
              errors={Object.fromEntries(
                Object.entries(fieldErrors)
                  .filter(([key]) => key.startsWith('customerAddress.'))
                  .map(([key, message]) => [key.slice('customerAddress.'.length), message]),
              )}
              disabled={isProcessing}
              onChange={handleCustomerAddressChange}
            />
          </div>

          {/* Order details */}
          <div>
            <label htmlFor="invoice_desc" className="mb-1.5 block text-sm font-medium text-slate-700">
              Invoice Memo / Descriptor
            </label>
            <input
              id="invoice_desc"
              type="text"
              value={invoiceDescription}
              onChange={(e) => setInvoiceDescription(e.target.value)}
              className={getInputClass('invoiceDescription') + ' bg-white'}
              placeholder="Service description"
              maxLength={60}
              disabled={isProcessing}
            />
          </div>
        </div>

        {/* ═══════════════════════════════════════════════ */}
        {/* Step 2: Payment Method & Cardholder Details     */}
        {/* ═══════════════════════════════════════════════ */}
        <div aria-labelledby="payment-cardholder-heading" className="rounded-2xl border border-slate-300 bg-white p-4 sm:p-5 space-y-5 shadow-sm">
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                2
              </span>
              <div>
                <h3 id="payment-cardholder-heading" className="text-sm font-bold text-slate-800">
                  Cardholder & Payment
                </h3>
                <p className="text-xs text-slate-500">
                  Enter the person paying and the card details used to authorize this payment.
                </p>
              </div>
            </div>
          </div>

          {isApplePayAvailable && (
            <div>
              <button
                type="button"
                onClick={handleApplePay}
                disabled={isProcessing}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-black px-4 py-3.5 font-bold text-white shadow-md transition-all hover:bg-slate-900 focus:outline-none focus:ring-4 focus:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg viewBox="0 0 40 16" width="40" height="16" fill="currentColor">
                  <path d="M14.93,7.21c0-1.63,1.33-2.61,2.58-3.23c-0.8-1.17-2.06-1.57-2.91-1.6c-1.24-0.12-2.43,0.73-3.06,0.73c-0.64,0-1.62-0.71-2.65-0.69C7.45,2.44,6.13,3.25,5.34,4.61c-1.6,2.78-0.41,6.89,1.15,9.15c0.76,1.11,1.67,2.33,2.87,2.29c1.17-0.04,1.61-0.75,3.02-0.75c1.4,0,1.81,0.75,3.04,0.73c1.24-0.02,2.02-1.11,2.78-2.22c0.88-1.29,1.24-2.54,1.26-2.61C19.41,11.18,14.93,9.45,14.93,7.21 M11.83,1.6C12.48,0.81,12.91,0,12.8-1.02C11.9,1.06,10.66,1.52,9.97,2.32c-0.6,0.7-1.12,1.59-0.97,2.58C10.02,4.98,11.23,4.41,11.83,1.6 M27.86,4.67v8.9h2.3v-8.9H27.86 M24.3,9.12c0-2.31-1.87-4.18-4.18-4.18c-2.31,0-4.18,1.87-4.18,4.18c0,2.31,1.87,4.18,4.18,4.18C22.43,13.3,24.3,11.43,24.3,9.12 M22.25,9.12c0,1.18-0.95,2.13-2.13,2.13c-1.18,0-2.13-0.95-2.13-2.13c0-1.18,0.95-2.13,2.13-2.13C21.3,6.99,22.25,7.94,22.25,9.12 M39.06,8.74c0-0.79-0.64-1.43-1.43-1.43h-2.92v4.86c0,0.79,0.64,1.43,1.43,1.43c0.79,0,1.43-0.64,1.43-1.43V8.74z M36.14,9.37V6.01h1.49v3.36H36.14z M32.65,11.05V2.32h2.05v8.73H32.65" />
                </svg>
                Pay with Apple Pay
              </button>
              <div className="relative mt-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-200"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="bg-white px-3 text-slate-500 font-medium">Or pay with credit / debit card</span>
                </div>
              </div>
            </div>
          )}

          <section aria-labelledby="cardholder-details-heading" className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 space-y-4">
            <div>
              <h4 id="cardholder-details-heading" className="text-sm font-semibold text-slate-800">Cardholder details</h4>
              <p className="mt-0.5 text-xs text-slate-500">Enter the name and contact details associated with the payment card.</p>
            </div>

            {/* Third-Party Cardholder Toggle */}
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3.5">
              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isThirdPartyCard}
                  onChange={(e) => {
                    setIsThirdPartyCard(e.target.checked);
                    if (fieldErrors.cardholderEmail) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.cardholderEmail;
                        return next;
                      });
                    }
                  }}
                  disabled={isProcessing}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <div className="text-xs sm:text-sm">
                  <span className="font-semibold text-slate-800">
                    Paying with someone else&apos;s credit card
                  </span>
                  <span className="block text-xs text-slate-500 mt-0.5">
                    Check this if the cardholder is different from the customer above.
                  </span>
                </div>
              </label>

              {isThirdPartyCard ? (
                <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <strong>Third-party card mode:</strong> This card will be processed as a one-time payment and will not be bound to the customer&apos;s profile. Enter the cardholder&apos;s own name and card billing address below.
                </div>
              ) : customerName.trim() &&
                cardholderName.trim() &&
                customerName.trim().toLowerCase() !== cardholderName.trim().toLowerCase() ? (
                <div className="mt-2.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
                  Cardholder name differs from customer name — this transaction will automatically be processed as a one-time third-party card payment.
                </div>
              ) : null}
            </div>

            {/* Cardholder Name */}
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor="cardholder_name" className="block text-sm font-medium text-slate-700">
                  Cardholder Name <span className="text-red-500">*</span>
                </label>
                {!isThirdPartyCard &&
                  customerName.trim().length >= 2 &&
                  cardholderName.trim() !== customerName.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        setCardholderName(customerName.trim());
                        if (fieldErrors.cardholderName) {
                          setFieldErrors((prev) => {
                            const next = { ...prev };
                            delete next.cardholderName;
                            return next;
                          });
                        }
                      }}
                      disabled={isProcessing}
                      className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors"
                    >
                      Same as customer
                    </button>
                  )}
              </div>
              <input
                id="cardholder_name"
                type="text"
                value={cardholderName}
                onChange={(e) => {
                  setCardholderName(e.target.value);
                  if (fieldErrors.cardholderName) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.cardholderName;
                      return next;
                    });
                  }
                }}
                className={getInputClass('cardholderName')}
                placeholder="Full name as printed on card"
                autoComplete="cc-name"
                maxLength={70}
                disabled={isProcessing}
              />
              {fieldErrors.cardholderName && (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.cardholderName}</p>
              )}
            </div>

              {/* Cardholder Email (shown when paying with third-party card or cardholder name differs) */}
              {showCardholderEmailField && (
                <div>
                  <label htmlFor="cardholder_email" className="mb-1.5 flex items-center justify-between text-sm font-medium text-slate-700">
                    <span>Cardholder Email</span>
                    <span className="text-xs font-normal text-slate-400">Optional · 3DS 2.0</span>
                  </label>
                  <input
                    id="cardholder_email"
                    type="email"
                    value={cardholderEmail}
                    onChange={(e) => {
                      setCardholderEmail(e.target.value);
                      if (fieldErrors.cardholderEmail) {
                        setFieldErrors((prev) => {
                          const next = { ...prev };
                          delete next.cardholderEmail;
                          return next;
                        });
                      }
                    }}
                    className={getInputClass('cardholderEmail')}
                    placeholder="cardholder@example.com"
                    disabled={isProcessing}
                  />
                  {fieldErrors.cardholderEmail ? (
                    <p className="mt-1 text-xs text-red-500">{fieldErrors.cardholderEmail}</p>
                  ) : (
                    <p className="mt-1 text-xs text-slate-400">
                      Used for 3DS 2.0 cardholder verification (invoice receipt still goes to customer email)
                    </p>
                  )}
                </div>
              )}

            {/* Cardholder Mobile Phone (Optional · EMV 3DS 2.0 Risk Scoring / SMS OTP) */}
            <div>
              <label htmlFor="cardholder_phone" className="mb-1.5 flex items-center justify-between text-sm font-medium text-slate-700">
                <span>Cardholder Mobile Phone</span>
                <span className="text-xs font-normal text-slate-400">Optional · 3DS 2.0</span>
              </label>
              <input
                id="cardholder_phone"
                type="tel"
                value={cardholderPhone}
                onChange={(e) => {
                  setCardholderPhone(e.target.value);
                  if (fieldErrors.cardholderPhone) {
                    setFieldErrors((prev) => {
                      const next = { ...prev };
                      delete next.cardholderPhone;
                      return next;
                    });
                  }
                }}
                className={getInputClass('cardholderPhone')}
                placeholder={`${getCountryDialCode(country)} 8123 4567`}
                autoComplete="tel"
                maxLength={24}
                disabled={isProcessing}
              />
              {fieldErrors.cardholderPhone ? (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.cardholderPhone}</p>
              ) : (
                <p className="mt-1 text-xs text-slate-400">
                  Optional · International format with country code (recommended for EMV 3DS 2.0 risk scoring &amp; bank OTP)
                </p>
              )}
            </div>

          </section>

          <section aria-labelledby="card-details-heading" className="rounded-xl border border-slate-200 bg-slate-50/40 p-4 space-y-5">
            <div>
              <h4 id="card-details-heading" className="text-sm font-semibold text-slate-800">Card details & AVS verification</h4>
              <p className="mt-0.5 text-xs text-slate-500">Billing address must match the address registered with this card.</p>
            </div>
            {/* Card Number */}
            <div>
              <label htmlFor="card" className="mb-1.5 block text-sm font-medium text-slate-700">
                Card Number <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  id="card"
                  type="text"
                  inputMode="numeric"
                  value={cardNumber}
                  onChange={(e) => {
                    setCardNumber(formatCardNumber(e.target.value));
                    if (fieldErrors.cardNumber) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.cardNumber;
                        return next;
                      });
                    }
                  }}
                  className={getInputClass('cardNumber') + ' tracking-wider pr-24'}
                  placeholder="•••• •••• •••• ••••"
                  autoComplete="cc-number"
                  maxLength={23}
                  disabled={isProcessing}
                />
                <CardBrandIcon brand={cardBrand} />
              </div>
              {fieldErrors.cardNumber ? (
                <p className="mt-1 text-xs text-red-500">{fieldErrors.cardNumber}</p>
              ) : (
                <p className="mt-1 text-xs text-slate-400">
                  Accepted for {currencyConfig.code.toUpperCase()}: {currencyConfig.supportedBrandsLabel}
                </p>
              )}
            </div>

            {/* Expiry & CVC */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="expiry" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Expiration <span className="text-red-500">*</span>
                </label>
                <input
                  id="expiry"
                  type="text"
                  inputMode="numeric"
                  value={expiry}
                  onChange={(e) => {
                    setExpiry(formatExpiry(e.target.value));
                    if (fieldErrors.expiry) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.expiry;
                        return next;
                      });
                    }
                  }}
                  className={getInputClass('expiry')}
                  placeholder="MM/YY"
                  autoComplete="cc-exp"
                  maxLength={5}
                  disabled={isProcessing}
                />
                {fieldErrors.expiry && (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.expiry}</p>
                )}
              </div>

              <div>
                <label htmlFor="cvc" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Security Code ({cardBrand === 'amex' ? '4 Digits' : 'CVC / CVV'}) <span className="text-red-500">*</span>
                </label>
                <input
                  id="cvc"
                  type="password"
                  inputMode="numeric"
                  value={cvc}
                  onChange={(e) => {
                    setCvc(e.target.value.replace(/\D/g, '').slice(0, maxCvcLength));
                    if (fieldErrors.cvc) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.cvc;
                        return next;
                      });
                    }
                  }}
                  className={getInputClass('cvc')}
                  placeholder={cardBrand === 'amex' ? '••••' : '•••'}
                  autoComplete="cc-csc"
                  maxLength={maxCvcLength}
                  disabled={isProcessing}
                />
                {fieldErrors.cvc && (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.cvc}</p>
                )}
              </div>
            </div>

            {/* Cardholder Billing Address (AVS Standard) */}
            <div className="space-y-4 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Cardholder Billing Address (AVS)
                </span>
                <div className="h-px flex-1 bg-slate-100" />
              </div>

              {/* AVS Notification Banner */}
              {countryConfig.isAvsStrict ? (
                <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 p-3 text-xs text-indigo-900">
                  <div className="flex items-start gap-2">
                    <span className="text-sm">🛡️</span>
                    <div>
                      <span className="font-semibold">Cardholder AVS Verification Required:</span>
                      <p className="mt-0.5 text-indigo-700">
                        Enter the billing address registered on the <strong>cardholder&apos;s</strong> {countryConfig.name} credit card statement (not the customer&apos;s address if paying with someone else&apos;s card).
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-2.5 text-xs text-slate-600">
                  <span>
                    🌍 Cardholder Billing Address: Enter the billing address registered with this credit card.
                  </span>
                </div>
              )}

              {/* Country Selection */}
              <div>
                <label htmlFor="country" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Country / Region of Card Issuance <span className="text-red-500">*</span>
                </label>
                <select
                  id="country"
                  value={country}
                  onChange={(e) => handleCountryChange(e.target.value)}
                  className={
                    getInputClass('country') +
                    ' appearance-none bg-[url(\'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%236b7280%22%20d%3D%22M2%204l4%204%204-4%22%2F%3E%3C%2Fsvg%3E\')] bg-[length:12px] bg-[right_12px_center] bg-no-repeat pr-8'
                  }
                  disabled={isProcessing}
                  autoComplete="country"
                >
                  <optgroup label="Popular Countries & Regions">
                    {POPULAR_COUNTRIES.map((c) => (
                      <option key={`pop_${c.code}`} value={c.code}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="All Countries & Regions (A-Z)">
                    {SORTED_ALL_COUNTRIES.map((c) => (
                      <option key={`all_${c.code}`} value={c.code}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </optgroup>
                </select>
                {fieldErrors.country && (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.country}</p>
                )}
              </div>

              {/* Street Address Line 1 */}
              <div>
                <label htmlFor="street1" className="mb-1.5 block text-sm font-medium text-slate-700">
                  Street Address (Line 1) <span className="text-red-500">*</span>
                </label>
                <input
                  id="street1"
                  type="text"
                  value={street1}
                  onChange={(e) => {
                    setStreet1(e.target.value);
                    if (fieldErrors.street1) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.street1;
                        return next;
                      });
                    }
                  }}
                  className={getInputClass('street1')}
                  placeholder={
                    countryConfig.isAvsStrict
                      ? 'Building / House number and street name (e.g. 123 Main St)'
                      : 'Street name and building number'
                  }
                  autoComplete="address-line1"
                  maxLength={50}
                  disabled={isProcessing}
                />
                {fieldErrors.street1 ? (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.street1}</p>
                ) : countryConfig.isAvsStrict ? (
                  <p className="mt-1 text-xs text-indigo-500">
                    Tip: AVS specifically verifies the house/building number in this line.
                  </p>
                ) : null}
              </div>

              {/* Street Address Line 2 (Optional) */}
              <div>
                <label htmlFor="street2" className="mb-1.5 flex items-center justify-between text-sm font-medium text-slate-700">
                  <span>Address Line 2</span>
                  <span className="text-xs font-normal text-slate-400">Optional</span>
                </label>
                <input
                  id="street2"
                  type="text"
                  value={street2}
                  onChange={(e) => {
                    setStreet2(e.target.value);
                    if (fieldErrors.street2) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.street2;
                        return next;
                      });
                    }
                  }}
                  className={getInputClass('street2')}
                  placeholder="Apt, Suite, Unit, Floor, Building name"
                  autoComplete="address-line2"
                  maxLength={50}
                  disabled={isProcessing}
                />
                {fieldErrors.street2 && (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.street2}</p>
                )}
              </div>

              {/* City */}
              <div>
                <label htmlFor="city" className="mb-1.5 block text-sm font-medium text-slate-700">
                  City / Town <span className="text-red-500">*</span>
                </label>
                <input
                  id="city"
                  type="text"
                  value={city}
                  onChange={(e) => {
                    setCity(e.target.value);
                    if (fieldErrors.city) {
                      setFieldErrors((prev) => {
                        const next = { ...prev };
                        delete next.city;
                        return next;
                      });
                    }
                  }}
                  className={getInputClass('city')}
                  placeholder="City name"
                  autoComplete="address-level2"
                  maxLength={50}
                  disabled={isProcessing}
                />
                {fieldErrors.city && (
                  <p className="mt-1 text-xs text-red-500">{fieldErrors.city}</p>
                )}
              </div>

              {/* State/Province & Postal Code Grid */}
              <div className={`grid gap-4 ${countryConfig.hasStates ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
                {/* State / Province (shown when country has states/subdivisions) */}
                {countryConfig.hasStates && (
                  <div>
                    <label htmlFor="state" className="mb-1.5 block text-sm font-medium text-slate-700">
                      {countryConfig.stateLabel} <span className="text-red-500">*</span>
                    </label>
                    {countryConfig.states && countryConfig.states.length > 0 ? (
                      <select
                        id="state"
                        value={state}
                        onChange={(e) => {
                          setState(e.target.value);
                          if (fieldErrors.state) {
                            setFieldErrors((prev) => {
                              const next = { ...prev };
                              delete next.state;
                              return next;
                            });
                          }
                        }}
                        className={
                          getInputClass('state') +
                          ' appearance-none bg-[url(\'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%236b7280%22%20d%3D%22M2%204l4%204%204-4%22%2F%3E%3C%2Fsvg%3E\')] bg-[length:12px] bg-[right_12px_center] bg-no-repeat pr-8'
                        }
                        disabled={isProcessing}
                        autoComplete="address-level1"
                      >
                        <option value="">Select {countryConfig.stateLabel}…</option>
                        {countryConfig.states.map((s) => (
                          <option key={s.code} value={s.code}>
                            {s.code} – {s.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id="state"
                        type="text"
                        value={state}
                        onChange={(e) => {
                          setState(e.target.value);
                          if (fieldErrors.state) {
                            setFieldErrors((prev) => {
                              const next = { ...prev };
                              delete next.state;
                              return next;
                            });
                          }
                        }}
                        className={getInputClass('state')}
                        placeholder={countryConfig.stateLabel}
                        autoComplete="address-level1"
                        maxLength={50}
                        disabled={isProcessing}
                      />
                    )}
                    {fieldErrors.state && (
                      <p className="mt-1 text-xs text-red-500">{fieldErrors.state}</p>
                    )}
                  </div>
                )}

                {/* Postal / ZIP Code */}
                <div>
                  <label htmlFor="postal_code" className="mb-1.5 flex items-center justify-between text-sm font-medium text-slate-700">
                    <span>
                      {countryConfig.postalLabel} {countryConfig.postalRequired && <span className="text-red-500">*</span>}
                    </span>
                    {!countryConfig.postalRequired && (
                      <span className="text-xs font-normal text-slate-400">Optional</span>
                    )}
                  </label>
                  <input
                    id="postal_code"
                    type="text"
                    value={postalCode}
                    onChange={(e) => handlePostalChange(e.target.value)}
                    onBlur={handlePostalBlur}
                    className={getInputClass('postalCode')}
                    placeholder={countryConfig.postalPlaceholder}
                    autoComplete="postal-code"
                    maxLength={16}
                    disabled={isProcessing}
                  />
                  {fieldErrors.postalCode && (
                    <p className="mt-1 text-xs text-red-500">{fieldErrors.postalCode}</p>
                  )}
                </div>
              </div>
            </div>

          </section>
        </div>

        {/* Top Error Message Banner */}
        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-700">
            <svg className="mt-0.5 h-4 w-4 shrink-0 text-red-500" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                clipRule="evenodd"
              />
            </svg>
            <span className="font-medium">{error}</span>
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isProcessing || !omiseLoaded}
          className="relative w-full overflow-hidden rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition-all hover:from-indigo-700 hover:to-purple-700 hover:shadow-xl active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isProcessing ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              {status === 'tokenizing'
                ? 'Verifying Customer & Securing Card…'
                : 'Authorizing Transaction with Bank…'}
            </span>
          ) : (
            `Authorize Payment of ${currencyConfig.symbol}${parseFloat(amount || '0').toFixed(2)} ${currencyConfig.code.toUpperCase()}`
          )}
        </button>

        {/* Compliance & Security Badges */}
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs text-slate-400">
          <span className="inline-flex items-center gap-1 font-medium text-slate-600">
            <svg className="h-3.5 w-3.5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Separated Customer & Cardholder
          </span>
          <span>·</span>
          <span className="inline-flex items-center gap-1">
            <svg className="h-3.5 w-3.5 text-indigo-500" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Strict AVS Verification
          </span>
          <span>·</span>
          <span>3D Secure 2.0</span>
          <span>·</span>
          <span>Level 2 Invoicing Data</span>
        </div>
      </form>
    </div>
  </div>
);
};
